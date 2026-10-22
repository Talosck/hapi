import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { posix, win32 } from 'node:path'
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
    args: string[]
): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: TOOLS_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: process.env,
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
 * The answer is cached for a few minutes - reading it costs two subprocess
 * spawns on the machine.
 */
export async function listMcodeConnectorApps(options?: {
    mcodeCommand?: string
    runTools?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
    /** Skip the cache. Exposed for tests. */
    forceRefresh?: boolean
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

    const promise = (async (): Promise<McodeConnectorCatalogResult> => {
        let auth: McodeConnectorAuthSummary = { status: 'unknown', authMode: null, scope: null, expiresAt: null }
        let authRead = true
        try {
            const { stdout } = await run(command, ['auth', 'status'])
            auth = parseMcodeConnectorAuth(parseJsonPayload(stdout))
        } catch (error) {
            authRead = false
            logger.debug('Failed to read the MiniMax Code connector auth status:', error)
        }

        try {
            const { stdout } = await run(command, ['connector', 'tools'])
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
            logger.debug('Failed to list the MiniMax Code connector tools:', error)
            return {
                auth,
                apps: [],
                error: error instanceof Error ? error.message : 'Failed to list the MiniMax Code apps'
            }
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
