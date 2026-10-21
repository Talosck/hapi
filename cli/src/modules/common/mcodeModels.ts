import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asString, isObject } from '@hapi/protocol';
import type { McodeModelsResponse, McodeModelSummary } from '@hapi/protocol/apiTypes';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
import { extractModelCatalog, findThinkingEffortConfigOption } from '@/agent/backends/acp/acpConfigOptions';
import { resolveHapiHomeDir } from '@/configuration';
import { logger } from '@/ui/logger';
import packageJson from '../../../package.json';
import { getErrorMessage } from './rpcResponses';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

export interface ListMcodeModelsForCwdRequest {
    cwd?: string;
}

export type ListMcodeModelsForCwdResponse = McodeModelsResponse;

interface CacheEntry {
    expiresAt: number;
    response: ListMcodeModelsForCwdResponse;
}

const CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * The catalog comes from the provider configuration, not from the workspace:
 * the probe runs in a fixed directory, so every cwd shares one answer. The
 * cache is therefore keyed by a constant — keying it by cwd spawned a fresh
 * `mcode acp` process for every directory the user typed.
 */
const PROBE_CACHE_KEY = 'mcode-model-probe';
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ListMcodeModelsForCwdResponse>>();

/**
 * MiniMax Code has no ACP delete method, so a probe session cannot be removed
 * once created. Reuse one probe session (stored in HAPI's home) instead of
 * creating one per discovery: the catalog comes from the provider config, not
 * the workspace, so a single stable probe cwd is enough.
 */
const PROBE_DIR_NAME = 'mcode-model-probe';
const PROBE_SESSION_FILE = 'session.json';
let cachedProbeSessionId: string | null | undefined;
let probeSessionRead: Promise<string | null> | null = null;

function normalizeAvailableModels(rawModels: unknown): McodeModelSummary[] {
    if (!Array.isArray(rawModels)) return [];
    const out: McodeModelSummary[] = [];
    for (const entry of rawModels) {
        if (!isObject(entry)) continue;
        const modelId = asString(entry.modelId) ?? asString(entry.value);
        if (!modelId) continue;
        const name = asString(entry.name) ?? undefined;
        out.push(name ? { modelId, name } : { modelId });
    }
    return out;
}

function normalizeEffortOptions(rawOptions: unknown): Array<{ value: string; name?: string }> {
    if (!Array.isArray(rawOptions)) return [];
    const out: Array<{ value: string; name?: string }> = [];
    for (const entry of rawOptions) {
        if (!isObject(entry)) continue;
        const value = asString(entry.value) ?? asString(entry.modelId);
        // `default` is the agent's own default level; HAPI represents that as
        // the absence of an effort so the UI has a single Default entry.
        if (!value || value === 'default') continue;
        const name = asString(entry.name) ?? undefined;
        out.push(name ? { value, name } : { value });
    }
    return out;
}

/**
 * MiniMax Code publishes its reasoning effort levels as the `thinkingEffort`
 * ACP config option (category `thought_level`).
 *
 * The live ACP backend resolves both with the same rules, so the create form
 * and a running session always show the same catalog.
 */
function extractEffortConfigOption(response: unknown): {
    currentValue: string | null;
    options: unknown[];
} | null {
    if (!isObject(response)) return null;
    if (!Array.isArray(response.configOptions)) return null;

    const option = findThinkingEffortConfigOption(
        response.configOptions.filter((entry): entry is Record<string, unknown> => isObject(entry))
    );
    if (!option) return null;

    return {
        currentValue: asString(option.currentValue),
        options: Array.isArray(option.options) ? option.options : []
    };
}

export function extractMcodeModelsFromResponse(response: unknown): {
    availableModels: McodeModelSummary[];
    currentModelId: string | null;
    effortOptions: Array<{ value: string; name?: string }>;
    currentEffort: string | null;
} {
    if (!isObject(response)) {
        return { availableModels: [], currentModelId: null, effortOptions: [], currentEffort: null };
    }

    const configEffortOption = extractEffortConfigOption(response);
    const { availableModels: rawModels, currentModelId: rawCurrent } = extractModelCatalog(response);

    const currentEffort = configEffortOption?.currentValue ?? null;
    return {
        availableModels: normalizeAvailableModels(rawModels),
        currentModelId: rawCurrent,
        effortOptions: normalizeEffortOptions(configEffortOption?.options),
        currentEffort: currentEffort === 'default' ? null : currentEffort
    };
}

function getProbeDir(): string {
    return join(resolveHapiHomeDir(), PROBE_DIR_NAME);
}

function getProbeSessionFile(): string {
    return join(getProbeDir(), PROBE_SESSION_FILE);
}

async function readProbeSessionId(): Promise<string | null> {
    if (cachedProbeSessionId !== undefined) return cachedProbeSessionId;
    if (!probeSessionRead) {
        probeSessionRead = (async () => {
            try {
                const parsed: unknown = JSON.parse(await readFile(getProbeSessionFile(), 'utf8'));
                const id = isObject(parsed) ? asString(parsed.sessionId) : null;
                cachedProbeSessionId = id;
                return id;
            } catch {
                cachedProbeSessionId = null;
                return null;
            } finally {
                probeSessionRead = null;
            }
        })();
    }
    return probeSessionRead;
}

async function writeProbeSessionId(sessionId: string): Promise<void> {
    cachedProbeSessionId = sessionId;
    try {
        await mkdir(getProbeDir(), { recursive: true, mode: 0o700 });
        const file = getProbeSessionFile();
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ sessionId }), { mode: 0o600 });
        await rename(temp, file);
    } catch (error) {
        // In-memory reuse still works for this process.
        logger.debug('Failed to persist the MiniMax Code model probe session:', error);
    }
}

async function clearProbeSessionId(): Promise<void> {
    cachedProbeSessionId = null;
    try {
        await rm(getProbeSessionFile(), { force: true });
    } catch {
        // Best effort.
    }
}

async function runMcodeProbe(_cwd: string): Promise<ListMcodeModelsForCwdResponse> {
    const probeCwd = getProbeDir();
    await mkdir(probeCwd, { recursive: true, mode: 0o700 });

    const transport = await AcpStdioTransport.create({
        command: getAgentLaunchCommand('mcode'),
        args: ['acp']
    });

    let probeSessionId: string | null = null;
    try {
        const initResponse = await transport.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false
            },
            clientInfo: {
                name: 'hapi-mcode-models',
                version: packageJson.version
            }
        }, { timeoutMs: PROBE_TIMEOUT_MS });

        if (!isObject(initResponse) || typeof initResponse.protocolVersion !== 'number') {
            return { success: false, error: 'Invalid initialize response from mcode acp' };
        }

        let response: unknown = null;
        const previousSessionId = await readProbeSessionId();
        if (previousSessionId) {
            try {
                response = await transport.sendRequest('session/load', {
                    sessionId: previousSessionId,
                    cwd: probeCwd,
                    mcpServers: []
                }, { timeoutMs: PROBE_TIMEOUT_MS });
                probeSessionId = previousSessionId;
            } catch (error) {
                logger.debug('MiniMax Code probe session is no longer loadable; creating a new one:', error);
                await clearProbeSessionId();
            }
        }

        if (!response) {
            response = await transport.sendRequest('session/new', {
                cwd: probeCwd,
                mcpServers: []
            }, { timeoutMs: PROBE_TIMEOUT_MS });
            probeSessionId = isObject(response) ? asString(response.sessionId) : null;
            if (probeSessionId) await writeProbeSessionId(probeSessionId);
        }

        const { availableModels, currentModelId, effortOptions, currentEffort } =
            extractMcodeModelsFromResponse(response);

        return {
            success: true,
            availableModels,
            currentModelId,
            effortOptions,
            currentEffort
        };
    } finally {
        // `session/close` releases the ACP attachment/plan state. MiniMax Code
        // keeps the session itself in its data directory (there is no ACP
        // delete), so the probe session is reused via `session/load` above.
        if (probeSessionId) {
            await transport.sendRequest('session/close', { sessionId: probeSessionId }, { timeoutMs: 5_000 })
                .catch((error) => {
                    logger.debug('Failed to close the MiniMax Code model probe session:', error);
                });
        }
        await transport.close().catch(() => undefined);
    }
}

/**
 * Discover the MiniMax Code models available for a working directory by
 * spawning a short-lived `mcode acp` subprocess, sending `initialize` +
 * `session/load` (or `session/new` on the first run), and reading the `model`
 * and `thinkingEffort` config options from the response.
 *
 * The agent's model catalog comes from provider configuration rather than the
 * workspace, so every cwd shares one reusable probe session under HAPI's home
 * directory. Results are cached per cwd for five minutes; concurrent requests
 * for the same cwd are coalesced through a single-flight promise.
 */
export async function listMcodeModelsForCwd(
    cwd: string
): Promise<ListMcodeModelsForCwdResponse> {
    const trimmed = cwd?.trim();
    if (!trimmed) {
        return { success: false, error: 'cwd is required' };
    }

    const cached = cache.get(PROBE_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
    }

    const existing = inflight.get(PROBE_CACHE_KEY);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        try {
            const response = await runMcodeProbe(trimmed);
            if (response.success) {
                cache.set(PROBE_CACHE_KEY, {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    response
                });
            }
            return response;
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover MiniMax Code models')
            } satisfies ListMcodeModelsForCwdResponse;
        } finally {
            inflight.delete(PROBE_CACHE_KEY);
        }
    })();

    inflight.set(PROBE_CACHE_KEY, promise);
    return promise;
}

/** Clear the in-process cache and probe session pointer. Exposed for tests. */
export function _resetMcodeModelsCacheForTests(): void {
    cache.clear();
    inflight.clear();
    cachedProbeSessionId = undefined;
    probeSessionRead = null;
}
