import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { asString, isObject } from '@hapi/protocol'
import { logger } from '@/ui/logger'

const execFileAsync = promisify(execFile)

/**
 * MiniMax Code's Connector (App) tools.
 *
 * The agent reaches its connected apps through the `mcode-tools` CLI and the
 * `mcode-tools-master` skill - the tools are not exposed over ACP or MCP, so
 * an external client cannot observe them from the protocol side.
 *
 * HAPI therefore asks the `mcode-tools` CLI directly. It ships inside the
 * MiniMax Code package, next to the `mcode` binary, so it is resolved as a
 * sibling of whatever `mcode` this runner launches.
 *
 * The tools sign their requests through the broker of a running MiniMax Code
 * host, so a probe outside the host has to borrow a broker's coordinates -
 * see `discoverMcodeConnectorBrokers()`.
 */

export type McodeConnectorToolSummary = {
    toolName: string
    provider: string
    description: string
}

export type McodeConnectorAppSummary = {
    provider: string
    toolCount: number
    tools: McodeConnectorToolSummary[]
}

export type McodeConnectorAuthSummary = {
    /** `authenticated`, `unauthenticated`, … - the agent's own spelling. */
    status: string
    authMode: string | null
    scope: string | null
    expiresAt: number | null
}

export type McodeConnectorCatalog = {
    auth: McodeConnectorAuthSummary
    apps: McodeConnectorAppSummary[]
}

export type McodeConnectorCatalogResult = McodeConnectorCatalog & { error?: string }

/**
 * The connected apps change when the user connects one, which happens outside
 * HAPI - but reading them costs two subprocess spawns on the machine. The
 * answer is cached for a few minutes so a browser tab that polls does not
 * keep the machine busy.
 */
const CATALOG_TTL_MS = 5 * 60_000

let cachedCatalog: { expiresAt: number; catalog: McodeConnectorCatalogResult } | null = null
let inflightCatalog: Promise<McodeConnectorCatalogResult> | null = null

const TOOLS_TIMEOUT_MS = 20_000
const MAX_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * Resolves the `mcode-tools` command that belongs to the given `mcode`
 * command.
 *
 * A custom `HAPI_MCODE_PATH` points at one specific install, and that
 * install's `mcode-tools` is the one that shares its auth lease - so the
 * sibling wins over whatever else is on PATH.
 */
export function resolveMcodeToolsCommand(mcodeCommand: string, platform: NodeJS.Platform = process.platform): string {
    const trimmed = mcodeCommand.trim()
    if (!trimmed) return 'mcode-tools'
    // The path check has to follow the same platform as the file name: a
    // Windows path is not absolute to a POSIX resolver, and vice versa.
    const isAbsolutePath = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute
    if (!isAbsolutePath(trimmed)) return 'mcode-tools'
    const dir = platform === 'win32' ? win32.dirname : posix.dirname
    const joinPath = platform === 'win32' ? win32.join : posix.join
    return joinPath(dir(trimmed), platform === 'win32' ? 'mcode-tools.cmd' : 'mcode-tools')
}

/**
 * The broker a running MiniMax Code host exposes to its children.
 *
 * The connector tools cannot sign a request on their own: the embedded CLI
 * asks the host's broker over a unix socket for the lease, and only the host
 * knows where that socket lives. The host publishes the coordinates to its
 * children through the environment, so a probe that runs outside the host has
 * to find the socket itself.
 */
export type McodeConnectorBroker = {
    endpoint: string
    capabilityFile: string
}

/** The directory a MiniMax Code host keeps its broker in. */
const BROKER_DIR_PATTERN = /^mcode-tools-tui-(\d+)-/
const BROKER_SOCKET_FILE = 'mcode-auth-lease-v1.sock'
const BROKER_CAPABILITY_FILE = 'mcode-auth-lease-v1.cap'

/** The variables the MiniMax Code host publishes to its children. */
const HOST_ENV_PREFIX = '__MAVIS_MCODE_TOOLS_'

/** The variables that decide how the tools sign their requests. */
const AUTH_ENV_KEYS = [
    'MCODE_AUTH_PROVIDER',
    'MCODE_AUTH_BROKER_ENDPOINT',
    'MCODE_AUTH_BROKER_CAPABILITY_FILE'
] as const

/**
 * Whether a process is still running.
 *
 * `EPERM` means the process is there - it just belongs to another user.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/**
 * The directories a MiniMax Code host may keep its broker in.
 *
 * The host uses the system temp directory on POSIX, not whatever `TMPDIR`
 * happens to point at, so both are worth a look.
 */
function brokerTmpRoots(): string[] {
    const roots = [tmpdir()]
    if (process.platform !== 'win32') roots.push('/tmp')
    return [...new Set(roots)]
}

/**
 * The brokers of the MiniMax Code hosts running on this machine.
 *
 * The broker dies with its host, so a leftover directory from a session that
 * crashed is skipped instead of being reported as a failure: only a live
 * host can answer a probe.
 */
export function discoverMcodeConnectorBrokers(options?: {
    tmpRoot?: string
    isProcessAlive?: (pid: number) => boolean
}): McodeConnectorBroker[] {
    const roots = options?.tmpRoot ? [options.tmpRoot] : brokerTmpRoots()
    const alive = options?.isProcessAlive ?? isProcessAlive

    const found: { broker: McodeConnectorBroker; startedAt: number }[] = []
    const seen = new Set<string>()
    for (const tmpRoot of roots) {
        let entries: string[]
        try {
            entries = readdirSync(tmpRoot)
        } catch {
            continue
        }

        for (const name of entries) {
            const match = BROKER_DIR_PATTERN.exec(name)
            if (!match) continue
            const pid = Number(match[1])
            if (!Number.isSafeInteger(pid) || pid <= 0) continue
            if (!alive(pid)) continue

            const runDir = join(tmpRoot, name, 'run')
            const endpoint = join(runDir, BROKER_SOCKET_FILE)
            const capabilityFile = join(runDir, BROKER_CAPABILITY_FILE)
            if (seen.has(endpoint)) continue
            if (!existsSync(endpoint) || !existsSync(capabilityFile)) continue
            seen.add(endpoint)

            let startedAt = 0
            try {
                startedAt = statSync(join(tmpRoot, name)).mtimeMs
            } catch {
                // The directory went away between the listing and the stat.
            }
            found.push({ broker: { endpoint, capabilityFile }, startedAt })
        }
    }

    // The newest host is the one the user is working in.
    return found
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((entry) => entry.broker)
}

/**
 * The environment a probe of the connector tools has to run with.
 *
 * The embedded tools CLI only signs requests in the shared-broker mode, and
 * the broker lives in the running host - so a probe outside the host has to
 * be handed the host's coordinates.
 *
 * The host publishes them as `__MAVIS_MCODE_TOOLS_*` variables, and the tools
 * turn those into the `MCODE_*` ones they actually read. The launcher the
 * host puts first on PATH needs the runtime executable among them, so the
 * whole set has to be there - a partial set is refused.
 */
export function buildMcodeToolsEnv(options: {
    baseEnv?: NodeJS.ProcessEnv
    broker?: McodeConnectorBroker | null
    /** The runtime the tools run on - the node binary of the host. */
    runtimeExecutable?: string | null
    /** The region the account lives in. */
    region?: string | null
    /** Where the tools keep their configuration. */
    configDir?: string | null
}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) }
    if (!options.broker) return env

    // The host's own variables win over anything set here, and a broker of a
    // host that is gone fails the call for a reason the user cannot act on.
    for (const key of Object.keys(env)) {
        if (key.startsWith(HOST_ENV_PREFIX)) delete env[key]
    }
    for (const key of AUTH_ENV_KEYS) delete env[key]

    env.MCODE_AUTH_PROVIDER = 'shared-broker'
    env.MCODE_AUTH_BROKER_ENDPOINT = options.broker.endpoint
    env.MCODE_AUTH_BROKER_CAPABILITY_FILE = options.broker.capabilityFile

    if (options.runtimeExecutable && options.region && options.configDir) {
        env.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE = options.runtimeExecutable
        env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT = options.broker.endpoint
        env.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE = options.broker.capabilityFile
        env.__MAVIS_MCODE_TOOLS_CONFIG_DIR = options.configDir
        env.__MAVIS_MCODE_TOOLS_REGION = options.region
    }

    return env
}

/**
 * The node binary the MiniMax Code tools run on.
 *
 * The host runs on node, and the package it ships needs node too, so the
 * binary is on PATH wherever the tools are installed.
 */
export function findMcodeRuntimeExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
    const separator = process.platform === 'win32' ? ';' : ':'
    const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']
    for (const dir of (env.PATH ?? '').split(separator)) {
        if (!dir) continue
        for (const name of names) {
            const candidate = join(dir, name)
            if (existsSync(candidate)) return candidate
        }
    }
    return null
}

/**
 * The region the MiniMax Code account lives in.
 *
 * The tools talk to a different backend per region, so borrowing a broker
 * without the region would ask the wrong backend. Two regions mean two
 * accounts, and then the region cannot be told apart - the caller has to
 * fall back to the default of the tools.
 */
export function findMcodeRegion(env: NodeJS.ProcessEnv = process.env): string | null {
    const home = env.HOME ?? env.USERPROFILE
    if (!home) return null
    const roots = [
        join(home, '.minimax', 'integrations', 'mcode-tools'),
        join(home, '.minimax', 'auth', 'prod')
    ]
    for (const root of roots) {
        const regions = ['cn', 'en'].filter((region) => existsSync(join(root, region)))
        if (regions.length === 1) return regions[0]
    }
    return null
}

/** Where the MiniMax Code tools keep their configuration. */
export function findMcodeConfigDir(env: NodeJS.ProcessEnv = process.env): string | null {
    const home = env.HOME ?? env.USERPROFILE
    const region = findMcodeRegion(env)
    if (!home || !region) return null
    const configDir = join(home, '.minimax', 'integrations', 'mcode-tools', region)
    return existsSync(configDir) ? configDir : null
}

/** One way of asking the connector tools for the catalog. */
export type McodeConnectorProbe = {
    command: string
    env: NodeJS.ProcessEnv
}

/** The broker a probe talks to. */
function probeBrokerEndpoint(probe: McodeConnectorProbe): string | undefined {
    return probe.env.MCODE_AUTH_BROKER_ENDPOINT
        ?? probe.env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT
}

/**
 * How many ways to ask at most.
 *
 * Every way that does not answer costs two process spawns, and the hub waits
 * two minutes for the answer. The newest hosts are the ones the user is
 * working in, so the older ones are not worth the wait.
 */
const MAX_PROBES = 3

/**
 * The ways to ask, best first.
 *
 * The environment HAPI itself was started in comes first: when HAPI runs
 * inside a MiniMax Code host, that host's broker is the right one. The hosts
 * running on the machine follow, newest first.
 */
export function mcodeConnectorProbes(options?: {
    command?: string
    env?: NodeJS.ProcessEnv
    brokers?: McodeConnectorBroker[]
}): McodeConnectorProbe[] {
    const command = options?.command ?? resolveMcodeToolsCommand('mcode')
    const env = options?.env ?? process.env
    const probes: McodeConnectorProbe[] = []

    const hostEndpoint = env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT?.trim()
    const hostCapability = env.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE?.trim()
    if (hostEndpoint && hostCapability) {
        probes.push({ command, env: { ...env } })
    }

    const brokers = options?.brokers ?? discoverMcodeConnectorBrokers()
    const runtimeExecutable = findMcodeRuntimeExecutable(env)
    const region = findMcodeRegion(env)
    const configDir = findMcodeConfigDir(env)
    for (const broker of brokers) {
        const endpoint = broker.endpoint
        if (probes.some((probe) => probeBrokerEndpoint(probe) === endpoint)) continue
        probes.push({
            command,
            env: buildMcodeToolsEnv({ baseEnv: env, broker, runtimeExecutable, region, configDir })
        })
    }

    return probes.slice(0, MAX_PROBES)
}

/**
 * The provider a connector tool belongs to.
 *
 * Tool names are `connector__<provider>__<tool>`. A name that does not follow
 * that shape is its own provider, so an unknown naming scheme still groups
 * instead of disappearing.
 */
export function connectorProviderOf(toolName: string): string {
    const parts = toolName.split('__')
    if (parts.length >= 3 && parts[0] === 'connector' && parts[1]) return parts[1]
    return toolName
}

/** Parses the `mcode-tools connector tools` payload. */
export function parseMcodeConnectorTools(payload: unknown): McodeConnectorToolSummary[] {
    if (!isObject(payload) || !Array.isArray(payload.tools)) return []
    const out: McodeConnectorToolSummary[] = []
    for (const entry of payload.tools) {
        if (!isObject(entry)) continue
        const toolName = asString(entry.tool_name) ?? asString(entry.name)
        if (!toolName) continue
        out.push({
            toolName,
            provider: connectorProviderOf(toolName),
            description: asString(entry.description) ?? ''
        })
    }
    return out
}

/** Parses the `mcode-tools auth status` payload. */
export function parseMcodeConnectorAuth(payload: unknown): McodeConnectorAuthSummary {
    if (!isObject(payload)) {
        return { status: 'unknown', authMode: null, scope: null, expiresAt: null }
    }
    const expiresAt = payload.expires_at_ms
    return {
        status: asString(payload.status) ?? 'unknown',
        authMode: asString(payload.auth_mode) ?? null,
        scope: asString(payload.scope) ?? null,
        expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null
    }
}

/** Groups the connector tools by the app they belong to. */
export function groupMcodeConnectorApps(tools: McodeConnectorToolSummary[]): McodeConnectorAppSummary[] {
    const byProvider = new Map<string, McodeConnectorToolSummary[]>()
    for (const tool of tools) {
        const list = byProvider.get(tool.provider)
        if (list) list.push(tool)
        else byProvider.set(tool.provider, [tool])
    }
    return [...byProvider.entries()]
        .map(([provider, providerTools]) => ({
            provider,
            toolCount: providerTools.length,
            tools: providerTools
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider))
}

async function runMcodeTools(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: TOOLS_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env,
        windowsHide: true
    })
    return { stdout: stdout.toString(), stderr: stderr.toString() }
}

function parseJsonPayload(stdout: string): unknown {
    const trimmed = stdout.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed)
    } catch {
        // The CLI prints a JSON object per line; the catalog is the last one.
        const lines = trimmed.split('\n').filter((line) => line.trim().length > 0)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                return JSON.parse(lines[i])
            } catch {
                // Keep looking.
            }
        }
        return null
    }
}

/**
 * Lists the apps connected to this MiniMax Code installation.
 *
 * A failure to reach the CLI or to parse its answer is reported as an empty
 * catalog with an error, never as "no apps connected": the difference
 * matters, because one means the user has nothing and the other means HAPI
 * could not look.
 *
 * The tools sign their requests through the broker of a running MiniMax Code
 * host, so every known broker is tried until one answers.
 *
 * The answer is cached for a few minutes - reading it costs two subprocess
 * spawns on the machine.
 */
export async function listMcodeConnectorApps(options?: {
    mcodeCommand?: string
    runTools?: (
        command: string,
        args: string[],
        env: NodeJS.ProcessEnv
    ) => Promise<{ stdout: string; stderr: string }>
    /** Skip the cache. Exposed for tests. */
    forceRefresh?: boolean
    /** The ways to ask. Exposed for tests. */
    probes?: McodeConnectorProbe[]
}): Promise<McodeConnectorCatalogResult> {
    const command = resolveMcodeToolsCommand(options?.mcodeCommand ?? 'mcode')
    const run = options?.runTools ?? runMcodeTools

    if (!options?.forceRefresh) {
        const cached = cachedCatalog
        if (cached && cached.expiresAt > Date.now() && !authLeaseExpired(cached.catalog.auth)) {
            return cached.catalog
        }
        if (inflightCatalog) {
            return await inflightCatalog
        }
    }

    const probes = options?.probes ?? mcodeConnectorProbes({ command })

    const promise = (async (): Promise<McodeConnectorCatalogResult> => {
        let auth: McodeConnectorAuthSummary = { status: 'unknown', authMode: null, scope: null, expiresAt: null }
        let lastError: string | null = null

        for (const probe of probes) {
            let authRead = true
            try {
                const { stdout } = await run(probe.command, ['auth', 'status'], probe.env)
                auth = parseMcodeConnectorAuth(parseJsonPayload(stdout))
            } catch (error) {
                authRead = false
                logger.debug('Failed to read the MiniMax Code connector auth status:', error)
            }

            try {
                const { stdout } = await run(probe.command, ['connector', 'tools'], probe.env)
                const tools = parseMcodeConnectorTools(parseJsonPayload(stdout))
                const catalog: McodeConnectorCatalogResult = { auth, apps: groupMcodeConnectorApps(tools) }
                // A failed read is not cached: the next request should try again.
                // The same goes for a failed auth read - caching it would show
                // "unknown" for the whole TTL, long after the auth became
                // readable again.
                if (authRead) {
                    cachedCatalog = { expiresAt: Date.now() + CATALOG_TTL_MS, catalog }
                }
                return catalog
            } catch (error) {
                lastError = error instanceof Error ? error.message : 'Failed to list the MiniMax Code apps'
                logger.debug('Failed to list the MiniMax Code connector tools:', error)
            }
        }

        return {
            auth,
            apps: [],
            error: lastError ?? 'No MiniMax Code host is running, so the connected apps cannot be read.'
        }
    })()

    inflightCatalog = promise
    try {
        return await promise
    } finally {
        inflightCatalog = null
    }
}

/**
 * Whether the broker lease the cached answer was read under has expired.
 *
 * An expired lease means the connected apps may have changed, so the cached
 * answer must not be served.
 */
function authLeaseExpired(auth: McodeConnectorAuthSummary): boolean {
    if (auth.expiresAt === null) return false
    return auth.expiresAt <= Date.now()
}

/** Clear the cached catalog. Exposed for tests. */
export function _resetMcodeConnectorCacheForTests(): void {
    cachedCatalog = null
    inflightCatalog = null
}
