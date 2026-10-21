import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendRequestMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn(async () => undefined));
const createMock = vi.hoisted(() => vi.fn());

vi.mock('@/agent/backends/acp/AcpStdioTransport', () => ({
    AcpStdioTransport: { create: createMock }
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    _resetMcodeModelsCacheForTests,
    listMcodeModelsForCwd
} from './mcodeModels';

const MODEL_RESPONSE = {
    configOptions: [
        {
            id: 'model',
            category: 'model',
            currentValue: 'm:minimax:MiniMax-M3:u',
            options: [{ value: 'm:minimax:MiniMax-M3:u', name: 'MiniMax M3' }]
        }
    ]
};

let home: string;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hapi-mcode-probe-'));
    process.env.HAPI_HOME = home;
    _resetMcodeModelsCacheForTests();
    sendRequestMock.mockReset();
    closeMock.mockClear();

    sendRequestMock.mockImplementation(async (method: string) => {
        if (method === 'initialize') return { protocolVersion: 1 };
        if (method === 'session/new') return { ...MODEL_RESPONSE, sessionId: 'probe-session-1' };
        if (method === 'session/load') return { ...MODEL_RESPONSE, sessionId: 'probe-session-1' };
        if (method === 'session/close') return {};
        throw new Error(`unexpected method ${method}`);
    });
    createMock.mockReset();
    createMock.mockResolvedValue({ sendRequest: sendRequestMock, close: closeMock });
});

afterEach(async () => {
    delete process.env.HAPI_HOME;
    _resetMcodeModelsCacheForTests();
    await rm(home, { recursive: true, force: true });
});

describe('listMcodeModelsForCwd probe cache', () => {
    it('probes the agent and caches the answer', async () => {
        const response = await listMcodeModelsForCwd('/tmp/project');

        expect(response.success).toBe(true);
        expect(response.availableModels).toEqual([{ modelId: 'm:minimax:MiniMax-M3:u', name: 'MiniMax M3' }]);
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('serves a later request from the cache without another spawn', async () => {
        await listMcodeModelsForCwd('/tmp/project');
        await listMcodeModelsForCwd('/tmp/other-project');

        // The catalog comes from the provider configuration, not the
        // workspace, so a second directory must not cost another spawn.
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('persists the answer so a runner restart does not probe again', async () => {
        await listMcodeModelsForCwd('/tmp/project');

        const cacheFile = join(home, 'mcode-model-probe', 'models.json');
        const persisted = JSON.parse(await readFile(cacheFile, 'utf8')) as { expiresAt: number };
        expect(persisted.expiresAt).toBeGreaterThan(Date.now());

        // Drop the in-memory cache the way a runner restart would.
        _resetMcodeModelsCacheForTests();
        createMock.mockClear();

        const response = await listMcodeModelsForCwd('/tmp/project');

        expect(response.success).toBe(true);
        expect(response.availableModels).toEqual([{ modelId: 'm:minimax:MiniMax-M3:u', name: 'MiniMax M3' }]);
        expect(createMock).not.toHaveBeenCalled();
    });

    it('probes again when the persisted answer has expired', async () => {
        await listMcodeModelsForCwd('/tmp/project');

        const cacheFile = join(home, 'mcode-model-probe', 'models.json');
        const persisted = JSON.parse(await readFile(cacheFile, 'utf8')) as { expiresAt: number };
        await (await import('node:fs/promises')).writeFile(
            cacheFile,
            JSON.stringify({ ...persisted, expiresAt: Date.now() - 1 })
        );

        _resetMcodeModelsCacheForTests();
        createMock.mockClear();

        await listMcodeModelsForCwd('/tmp/project');

        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('ignores a corrupt persisted answer', async () => {
        await listMcodeModelsForCwd('/tmp/project');

        const cacheFile = join(home, 'mcode-model-probe', 'models.json');
        await (await import('node:fs/promises')).writeFile(cacheFile, 'not json at all');

        _resetMcodeModelsCacheForTests();
        createMock.mockClear();

        const response = await listMcodeModelsForCwd('/tmp/project');

        expect(response.success).toBe(true);
        expect(createMock).toHaveBeenCalledTimes(1);
    });
});
