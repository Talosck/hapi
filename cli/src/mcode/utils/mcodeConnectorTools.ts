import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { asString, isObject } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import { getMcodeDataDir } from './mcodeSessionDirs'

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

export type McodeConnectorCatalogResult = McodeConnectorCatalog & {
    error?: string
    /**
     * Whether the answer is not ready yet.
     *
     * The agent of a session publishes its broker a moment after it is
     * spawned, so a read that arrives in that window cannot have an answer.
     * The caller asks again instead of showing a failure.
     */
    pending?: boolean
}

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
/** The subdirectory the broker's socket and capability file live in. */
const BROKER_RUN_DIR = 'run'
const BROKER_SOCKET_FILE = 'mcode-auth-lease-v1.sock'
const BROKER_CAPABILITY_FILE = 'mcode-auth-lease-v1.cap'

/**
 * The directory the current MiniMax Code keeps its broker in.
 *
 * The host no longer keeps it in the temp directory under a name that carries
 * its pid: it keeps it in the data directory, either as one shared instance or
 * as one instance per host under a generated name.
 */
const BROKER_DATA_DIR = 'run'
/** The prefix of the per-host instance directories. */
const BROKER_INSTANCE_PREFIX = 'mt-'

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
 * The pid that owns each unix socket of the machine.
 *
 * The broker of the current MiniMax Code carries no pid in its name, so the
 * kernel is the only one that can say which host a broker belongs to - and a
 * broker whose owner is gone cannot be asked.
 *
 * Linux keeps the unix sockets of the machine in one file, with the inode of
 * each socket, and every process lists its open sockets under `/proc`. The two
 * together answer "who holds this socket".
 */
function unixSocketOwners(): Map<string, number> {
    const owners = new Map<string, number>()
    if (process.platform !== 'linux') return owners

    let inodesByPath = new Map<string, string>()
    try {
        for (const line of readFileSync('/proc/net/unix', 'utf8').split('\n')) {
            const columns = line.trim().split(/\s+/)
            // Num RefCount Protocol Flags Type St Inode Path
            if (columns.length < 8) continue
            const path = columns[7]
            const inode = columns[6]
            if (!path || !inode) continue
            inodesByPath.set(path, inode)
        }
    } catch {
        return owners
    }
    if (inodesByPath.size === 0) return owners

    let entries: string[]
    try {
        entries = readdirSync('/proc')
    } catch {
        return owners
    }

    const pidBySocket = new Map<string, number>()
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue
        let fds: string[]
        try {
            fds = readdirSync(`/proc/${entry}/fd`)
        } catch {
            continue
        }
        for (const fd of fds) {
            let target: string
            try {
                target = readlinkSync(`/proc/${entry}/fd/${fd}`)
            } catch {
                // The descriptor went away while it was read.
                continue
            }
            const match = /^socket:\[(\d+)\]$/.exec(target)
            if (!match) continue
            if (!pidBySocket.has(match[1])) pidBySocket.set(match[1], Number(entry))
        }
    }

    for (const [path, inode] of inodesByPath) {
        const pid = pidBySocket.get(inode)
        if (pid !== undefined) owners.set(path, pid)
    }
    return owners
}

/**
 * How long a broker instance may look ownerless before it is taken for dead.
 *
 * The socket of a broker that was just created can be missing from the table
 * of the kernel for a moment, and a host that is still starting must not be
 * written off because of it.
 */
const BROKER_STARTING_GRACE_MS = 5_000

/**
 * The broker of one instance directory, when it can still be asked.
 *
 * A host that is gone leaves its instance behind, and nobody can ask that
 * one. The owner of the socket says whether it is still there - but only
 * where the kernel can tell: without an owner map the instance is kept and
 * the probe answers for itself.
 */
function readMcodeDataDirBroker(
    instanceDir: string,
    owners: Map<string, number>,
    alive: (pid: number) => boolean
): { broker: McodeConnectorBroker; startedAt: number } | null {
    const endpoint = join(instanceDir, BROKER_SOCKET_FILE)
    const capabilityFile = join(instanceDir, BROKER_CAPABILITY_FILE)
    if (!existsSync(endpoint) || !existsSync(capabilityFile)) return null

    let startedAt = 0
    try {
        startedAt = statSync(endpoint).mtimeMs
    } catch {
        // The socket went away between the listing and the stat.
    }

    const owner = owners.get(endpoint)
    if (owner !== undefined && !alive(owner)) return null
    if (owner === undefined && owners.size > 0) {
        // Nobody holds the socket: the host that made it is gone. A broker
        // that was created a moment ago may not be in the table yet, so a
        // fresh one is kept.
        if (Date.now() - startedAt > BROKER_STARTING_GRACE_MS) return null
    }

    return { broker: { endpoint, capabilityFile }, startedAt }
}

/**
 * The brokers the current MiniMax Code keeps in its data directory.
 *
 * The host keeps one instance per host under a generated name, next to one
 * shared instance. The name carries no pid, so the owner of the socket is
 * what tells a live broker from the one a crashed host left behind.
 */
export function discoverMcodeDataDirBrokers(options?: {
    dataDir?: string
    owners?: Map<string, number>
    isProcessAlive?: (pid: number) => boolean
}): McodeConnectorBroker[] {
    const runDir = join(options?.dataDir ?? getMcodeDataDir(), BROKER_DATA_DIR)
    const owners = options?.owners ?? unixSocketOwners()
    const alive = options?.isProcessAlive ?? isProcessAlive

    let entries: string[]
    try {
        entries = readdirSync(runDir)
    } catch {
        return []
    }

    const found: { broker: McodeConnectorBroker; startedAt: number }[] = []
    const seen = new Set<string>()

    // The shared instance sits in the run directory itself.
    const shared = readMcodeDataDirBroker(runDir, owners, alive)
    if (shared) {
        seen.add(shared.broker.endpoint)
        found.push(shared)
    }

    for (const name of entries) {
        // The per-host instances live in a generated directory below the run
        // directory; anything else in it is not a broker.
        if (!name.startsWith(BROKER_INSTANCE_PREFIX)) continue
        const entry = readMcodeDataDirBroker(join(runDir, name), owners, alive)
        if (!entry) continue
        if (seen.has(entry.broker.endpoint)) continue
        seen.add(entry.broker.endpoint)
        found.push(entry)
    }

    return found
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((entry) => entry.broker)
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
    dataDir?: string
    owners?: Map<string, number>
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

            const runDir = join(tmpRoot, name, BROKER_RUN_DIR)
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

    for (const broker of discoverMcodeDataDirBrokers({
        dataDir: options?.dataDir,
        owners: options?.owners,
        isProcessAlive: options?.isProcessAlive
    })) {
        if (seen.has(broker.endpoint)) continue
        seen.add(broker.endpoint)
        found.push({ broker, startedAt: 0 })
    }

    // The newest host is the one the user is working in.
    return found
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((entry) => entry.broker)
}

/**
 * The broker of one MiniMax Code host, found by its pid.
 *
 * The host names its broker directory after its own pid, so a host HAPI
 * launched is found exactly - no scan of the temp directory, and no guess
 * about which of the running hosts the user meant.
 *
 * The current MiniMax Code names the directory after nothing, so the owner
 * of the socket is what identifies the host.
 */
export function findMcodeConnectorBrokerForPid(
    pid: number,
    options?: {
        tmpRoot?: string
        dataDir?: string
        owners?: Map<string, number>
        isProcessAlive?: (pid: number) => boolean
    }
): McodeConnectorBroker | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    const roots = options?.tmpRoot ? [options.tmpRoot] : brokerTmpRoots()
    const prefix = `mcode-tools-tui-${pid}-`

    for (const tmpRoot of roots) {
        let entries: string[]
        try {
            entries = readdirSync(tmpRoot)
        } catch {
            continue
        }

        for (const name of entries) {
            if (!name.startsWith(prefix)) continue
            const runDir = join(tmpRoot, name, BROKER_RUN_DIR)
            const endpoint = join(runDir, BROKER_SOCKET_FILE)
            const capabilityFile = join(runDir, BROKER_CAPABILITY_FILE)
            // The host is still starting up while the socket is missing, and
            // a host that is gone leaves the directory behind. Neither can be
            // asked, so neither is a broker.
            if (!existsSync(endpoint) || !existsSync(capabilityFile)) continue
            return { endpoint, capabilityFile }
        }
    }

    const owners = options?.owners ?? unixSocketOwners()
    for (const broker of discoverMcodeDataDirBrokers({
        dataDir: options?.dataDir,
        owners,
        isProcessAlive: options?.isProcessAlive
    })) {
        if (owners.get(broker.endpoint) === pid) return broker
    }

    return null
}

/**
 * The MiniMax Code hosts this process knows by pid, newest first.
 *
 * A session that launched an agent knows the agent's pid, and the host names
 * its broker after that pid.
 */
const knownAgentHostPids: number[] = []

/** How many agent hosts a process remembers. */
const MAX_KNOWN_AGENT_HOSTS = 4

/** Remembers an agent host so the connector tools can ask exactly it. */
export function rememberMcodeAgentHostPid(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) return
    const existing = knownAgentHostPids.indexOf(pid)
    if (existing >= 0) knownAgentHostPids.splice(existing, 1)
    knownAgentHostPids.unshift(pid)
    if (knownAgentHostPids.length > MAX_KNOWN_AGENT_HOSTS) {
        knownAgentHostPids.length = MAX_KNOWN_AGENT_HOSTS
    }
}

/** The agent hosts this process knows by pid, newest first. */
export function knownMcodeAgentHostPids(): number[] {
    return [...knownAgentHostPids]
}

/**
 * Whether this process is starting a MiniMax Code agent right now.
 *
 * The agent publishes its broker a moment after it is spawned - the broker
 * belongs to the host, and the host opens it once its runtime is up. A read
 * in that window has no answer to give, and reporting the missing broker as
 * a failure would blame the installation for a session that is still coming
 * up.
 */
let agentStarting = false

/** Marks that this process is starting a MiniMax Code agent. */
export function markMcodeAgentStarting(starting: boolean): void {
    agentStarting = starting
}

/**
 * Whether the agent of this session can be asked yet.
 *
 * The agent is the one whose broker holds the connected apps. While it is
 * starting, it has no broker to sign the request with, so the answer is "not
 * yet" rather than a failure the user cannot act on.
 */
function mcodeAgentBrokerPending(): boolean {
    if (agentStarting) return true
    const pids = knownMcodeAgentHostPids()
    if (pids.length === 0) return false
    // The newest agent is the one this session is about. It is running but
    // has no broker: it is still coming up.
    const newest = pids[0]
    if (!isProcessAlive(newest)) return false
    return findMcodeConnectorBrokerForPid(newest) === null
}

/**
 * The brokers of the agents this process launched, newest first.
 *
 * The session that launched an agent knows the agent's pid, and the host
 * names its broker after that pid - so the session can ask its own agent
 * instead of scanning the temp directory for whichever host happens to be
 * running.
 */
export function knownAgentConnectorBrokers(options?: {
    tmpRoot?: string
    dataDir?: string
}): McodeConnectorBroker[] {
    const brokers: McodeConnectorBroker[] = []
    for (const pid of knownMcodeAgentHostPids()) {
        const broker = findMcodeConnectorBrokerForPid(pid, { tmpRoot: options?.tmpRoot, dataDir: options?.dataDir })
        if (!broker) continue
        if (brokers.some((known) => known.endpoint === broker.endpoint)) continue
        brokers.push(broker)
    }
    return brokers
}

/**
 * The brokers to ask, the agent this process launched first.
 *
 * The agent a session launched is known by its pid, so it is asked before the
 * hosts of the machine: the answer is about the agent the user is looking at,
 * not about whichever host happens to be running.
 */
export function preferredMcodeConnectorBrokers(options?: {
    tmpRoot?: string
    dataDir?: string
}): McodeConnectorBroker[] {
    const brokers = knownAgentConnectorBrokers(options)
    for (const broker of discoverMcodeConnectorBrokers({ tmpRoot: options?.tmpRoot, dataDir: options?.dataDir })) {
        if (brokers.some((known) => known.endpoint === broker.endpoint)) continue
        brokers.push(broker)
    }
    return brokers
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
 * inside a MiniMax Code host, that host's broker is the right one. The agent
 * this process launched is next, because its pid names its broker. The hosts
 * running on the machine follow, newest first.
 */
export function mcodeConnectorProbes(options?: {
    command?: string
    env?: NodeJS.ProcessEnv
    brokers?: McodeConnectorBroker[]
    /** Where the hosts keep their brokers. Exposed for tests. */
    tmpRoot?: string
    /** Where the current MiniMax Code keeps its brokers. Exposed for tests. */
    dataDir?: string
}): McodeConnectorProbe[] {
    const command = options?.command ?? resolveMcodeToolsCommand('mcode')
    const env = options?.env ?? process.env
    const probes: McodeConnectorProbe[] = []

    const hostEndpoint = env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT?.trim()
    const hostCapability = env.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE?.trim()

    const runtimeExecutable = findMcodeRuntimeExecutable(env)
    const region = findMcodeRegion(env)
    const configDir = findMcodeConfigDir(env)

    // The environment HAPI itself was started in comes first: when HAPI runs
    // inside a MiniMax Code host, that host is the one it can talk to.
    if (hostEndpoint && hostCapability) {
        probes.push({ command, env: { ...env } })
    }

    // The agent this process launched is next. It is known by its pid, so
    // the answer is about the agent the user is actually looking at and not
    // about whichever host happens to be running on the machine.
    for (const broker of knownAgentConnectorBrokers({ tmpRoot: options?.tmpRoot, dataDir: options?.dataDir })) {
        if (probes.some((probe) => probeBrokerEndpoint(probe) === broker.endpoint)) continue
        probes.push({
            command,
            env: buildMcodeToolsEnv({ baseEnv: env, broker, runtimeExecutable, region, configDir })
        })
    }

    const brokers = options?.brokers ?? discoverMcodeConnectorBrokers({
        tmpRoot: options?.tmpRoot,
        dataDir: options?.dataDir
    })
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
        let firstError: string | null = null

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
                // The first probe is the one that matters: the host HAPI runs
                // in, then the agent of the session. A later probe is a
                // fallback, so its failure says less about what the user is
                // looking at - and the reason that reaches the user has to be
                // the one of the agent they are waiting for.
                if (firstError === null) {
                    firstError = error instanceof Error ? error.message : 'Failed to list the MiniMax Code apps'
                }
                logger.debug('Failed to list the MiniMax Code connector tools:', error)
            }
        }

        // An agent that is still starting has no broker to sign the request
        // with. That is not a failure of the installation: the read is early,
        // so the caller asks again instead of showing an error.
        if (mcodeAgentBrokerPending()) {
            const reason = 'The MiniMax Code agent is still starting.'
            logger.debug('Could not read the MiniMax Code connected apps:', reason)
            return {
                auth,
                apps: [],
                pending: true,
                error: reason
            }
        }

        // Two failures look the same to the caller but mean different things:
        // the host did not answer, or there was no host to ask. The second one
        // says so instead of claiming the apps are missing.
        const reason = firstError
            ?? 'No MiniMax Code host is running, so the connected apps cannot be read.'
        logger.debug('Could not read the MiniMax Code connected apps:', reason)
        return {
            auth,
            apps: [],
            error: reason
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
    knownAgentHostPids.length = 0
    agentStarting = false
}
