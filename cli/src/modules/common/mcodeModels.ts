import { asString, isObject } from '@hapi/protocol';
import type { McodeModelsResponse, McodeModelSummary } from '@hapi/protocol/apiTypes';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
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

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ListMcodeModelsForCwdResponse>>();

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

/**
 * MiniMax Code publishes its model catalog as the `model` ACP config option
 * (category `model`), not through `availableModels`.
 */
function extractModelConfigOption(response: unknown): {
    currentValue: string | null;
    options: unknown[];
} | null {
    if (!isObject(response)) return null;
    if (!Array.isArray(response.configOptions)) return null;

    for (const entry of response.configOptions) {
        if (!isObject(entry)) continue;
        if (asString(entry.category) !== 'model') continue;
        return {
            currentValue: asString(entry.currentValue),
            options: Array.isArray(entry.options) ? entry.options : []
        };
    }

    return null;
}

export function extractMcodeModelsFromResponse(response: unknown): {
    availableModels: McodeModelSummary[];
    currentModelId: string | null;
} {
    if (!isObject(response)) {
        return { availableModels: [], currentModelId: null };
    }

    const configModelOption = extractModelConfigOption(response);
    const rawModels = Array.isArray(response.availableModels)
        ? response.availableModels
        : configModelOption?.options ?? null;
    const rawCurrent = typeof response.currentModelId === 'string'
        ? response.currentModelId
        : configModelOption?.currentValue ?? null;

    return {
        availableModels: normalizeAvailableModels(rawModels),
        currentModelId: rawCurrent
    };
}

async function runMcodeProbe(cwd: string): Promise<ListMcodeModelsForCwdResponse> {
    const transport = await AcpStdioTransport.create({
        command: getAgentLaunchCommand('mcode'),
        args: ['acp']
    });

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

        const newResponse = await transport.sendRequest('session/new', {
            cwd,
            mcpServers: []
        }, { timeoutMs: PROBE_TIMEOUT_MS });

        const { availableModels, currentModelId } = extractMcodeModelsFromResponse(newResponse);

        return {
            success: true,
            availableModels,
            currentModelId
        };
    } finally {
        await transport.close().catch(() => undefined);
    }
}

/**
 * Discover the MiniMax Code models available for a working directory by
 * spawning a short-lived `mcode acp` subprocess, sending `initialize` +
 * `session/new`, and reading the `model` config option from the response.
 *
 * Results are cached per cwd for 60 seconds; concurrent requests for the same
 * cwd are coalesced through a single-flight promise.
 */
export async function listMcodeModelsForCwd(
    cwd: string
): Promise<ListMcodeModelsForCwdResponse> {
    const trimmed = cwd?.trim();
    if (!trimmed) {
        return { success: false, error: 'cwd is required' };
    }

    const cached = cache.get(trimmed);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
    }

    const existing = inflight.get(trimmed);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        try {
            const response = await runMcodeProbe(trimmed);
            if (response.success) {
                cache.set(trimmed, {
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
            inflight.delete(trimmed);
        }
    })();

    inflight.set(trimmed, promise);
    return promise;
}

/** Clear the in-process cache. Exposed for tests. */
export function _resetMcodeModelsCacheForTests(): void {
    cache.clear();
    inflight.clear();
}
