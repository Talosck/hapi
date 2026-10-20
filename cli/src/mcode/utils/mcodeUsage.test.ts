import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildMcodeUsageMessage,
    createMcodeUsageWatcher,
    findMcodeMessagesPath,
    mcodeSessionDirSuffix,
    parseMcodeUsageLine,
    readMcodeUsageSince
} from './mcodeUsage';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-mcode-usage-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function assistantLine(opts: {
    messageId?: string;
    turnId?: string;
    model?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    timestamp?: number;
} = {}): string {
    return JSON.stringify({
        message_id: opts.messageId ?? 'msg-assistant-1',
        turn_id: opts.turnId ?? 'turn-1',
        message: {
            role: 'assistant',
            model: opts.model ?? 'MiniMax-M3.1-Flash',
            timestamp: opts.timestamp ?? Date.now(),
            usage: {
                input: opts.input ?? 100,
                output: opts.output ?? 20,
                cacheRead: opts.cacheRead ?? 300,
                cacheWrite: opts.cacheWrite ?? 0,
                ...(opts.totalTokens === undefined ? {} : { totalTokens: opts.totalTokens })
            }
        }
    });
}

function userLine(): string {
    return JSON.stringify({
        message_id: 'msg-user-1',
        turn_id: 'turn-1',
        message: {
            role: 'user',
            content: [{ type: 'text', text: 'hi' }]
        }
    });
}

function sessionDir(dataDir: string, sessionId: string): string {
    return join(
        dataDir,
        'v2',
        'sessions',
        '2026',
        '10',
        '20',
        `12-34-56-789-${mcodeSessionDirSuffix(sessionId)}`
    );
}

describe('parseMcodeUsageLine', () => {
    it('reads per-call token usage from an assistant transcript entry', () => {
        expect(parseMcodeUsageLine(assistantLine({ timestamp: 1_700_000_000_000 }))).toEqual({
            messageId: 'msg-assistant-1',
            turnId: 'turn-1',
            model: 'MiniMax-M3.1-Flash',
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 300,
            cacheWriteTokens: 0,
            totalTokens: 420,
            timestampMs: 1_700_000_000_000
        });
    });

    it('ignores non-assistant, usage-less, malformed, and zero-usage entries', () => {
        expect(parseMcodeUsageLine(userLine())).toBeNull();
        expect(parseMcodeUsageLine(JSON.stringify({ message: { role: 'assistant' } }))).toBeNull();
        expect(parseMcodeUsageLine('{not json')).toBeNull();
        expect(parseMcodeUsageLine(assistantLine({ input: 0, output: 0, cacheRead: 0 }))).toBeNull();
    });

    it('prefers the recorded total and keeps explicit cache writes', () => {
        expect(parseMcodeUsageLine(assistantLine({
            input: 10,
            output: 2,
            cacheRead: 8,
            cacheWrite: 4,
            totalTokens: 24
        }))).toMatchObject({
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 8,
            cacheWriteTokens: 4,
            totalTokens: 24
        });
    });
});

describe('buildMcodeUsageMessage', () => {
    it('marks input as cache-inclusive and carries the latest context window', () => {
        const record = parseMcodeUsageLine(assistantLine({
            input: 626,
            output: 2,
            cacheRead: 14018,
            cacheWrite: 0,
            totalTokens: 14646
        }));
        expect(record).not.toBeNull();

        expect(buildMcodeUsageMessage(record!, 'm:minimax:MiniMax-M3.1-Flash:v:thinking', {
            contextTokens: 28_119,
            contextWindow: 512_000
        })).toEqual({
            type: 'token_count',
            model: 'm:minimax:MiniMax-M3.1-Flash:v:thinking',
            usageSchema: 'hapi.usage.v1',
            inputTokenSemantics: 'includes-cache',
            info: {
                total: {
                    inputTokens: 14_644,
                    outputTokens: 2,
                    totalTokens: 14_646,
                    cachedInputTokens: 14_018,
                    cacheWriteInputTokens: 0
                },
                contextTokens: 28_119,
                modelContextWindow: 512_000
            }
        });
    });

    it('omits context fields when the backend has not reported them yet', () => {
        const record = parseMcodeUsageLine(assistantLine());
        const message = buildMcodeUsageMessage(record!, 'MiniMax-M3.1-Flash', null);
        expect(message?.type).toBe('token_count');
        expect((message as { info: Record<string, unknown> }).info.contextTokens).toBeUndefined();
        expect((message as { info: Record<string, unknown> }).info.modelContextWindow).toBeUndefined();
    });
});

describe('findMcodeMessagesPath', () => {
    it('locates the journal through the base64url session directory suffix', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_usage_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');
        await writeFile(messagesPath, `${assistantLine()}\n`);

        await expect(findMcodeMessagesPath(sessionId, dataDir)).resolves.toBe(messagesPath);
        await expect(findMcodeMessagesPath('mvs_missing', dataDir)).resolves.toBeNull();
    });
});

describe('readMcodeUsageSince', () => {
    it('returns appended records and leaves a partial trailing line for the next read', async () => {
        const dataDir = await createTempDir();
        const messagesPath = join(dataDir, 'messages.jsonl');
        const first = `${assistantLine({ messageId: 'msg-1' })}\n`;
        const second = `${assistantLine({ messageId: 'msg-2' })}\n`;
        await writeFile(messagesPath, first + second);

        const initial = await readMcodeUsageSince(messagesPath, 0);
        expect(initial.records.map((record) => record.messageId)).toEqual(['msg-1', 'msg-2']);
        expect(initial.nextOffset).toBe(Buffer.byteLength(first + second));

        const third = assistantLine({ messageId: 'msg-3' });
        const fourth = assistantLine({ messageId: 'msg-4' });
        const partial = fourth.slice(0, 20);
        await appendFile(messagesPath, `${third}\n${partial}`);

        const withPartial = await readMcodeUsageSince(messagesPath, initial.nextOffset);
        expect(withPartial.records.map((record) => record.messageId)).toEqual(['msg-3']);
        expect(withPartial.nextOffset).toBe(Buffer.byteLength(first + second + third + '\n'));

        await appendFile(messagesPath, `${fourth.slice(20)}\n`);
        const completed = await readMcodeUsageSince(messagesPath, withPartial.nextOffset);
        expect(completed.records.map((record) => record.messageId)).toEqual(['msg-4']);
    });

    it('treats a missing journal as an empty read', async () => {
        const dataDir = await createTempDir();
        await expect(readMcodeUsageSince(join(dataDir, 'missing.jsonl'), 42))
            .resolves.toEqual({ records: [], nextOffset: 42 });
    });
});

describe('createMcodeUsageWatcher', () => {
    it('primes at EOF and forwards only usage appended after attach', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_watch_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');
        await writeFile(messagesPath, `${assistantLine({ messageId: 'old', timestamp: Date.now() - 60_000 })}\n`);

        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await watcher.flush();
            expect(onUsage).not.toHaveBeenCalled();

            await appendFile(messagesPath, `${assistantLine({ messageId: 'new', input: 7, output: 3 })}\n`);
            await watcher.flush();

            expect(onUsage).toHaveBeenCalledTimes(1);
            expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
                messageId: 'new',
                inputTokens: 7,
                outputTokens: 3
            });

            await watcher.flush();
            expect(onUsage).toHaveBeenCalledTimes(1);
        } finally {
            await watcher.cleanup();
        }
    });

    it('counts the first turn when messages.jsonl appears after attach', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_first_turn_test';
        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);

            const dir = sessionDir(dataDir, sessionId);
            await mkdir(dir, { recursive: true });
            const messagesPath = join(dir, 'messages.jsonl');
            await writeFile(messagesPath, `${assistantLine({ messageId: 'first-turn' })}\n`);

            await watcher.flush();
            expect(onUsage).toHaveBeenCalledTimes(1);
            expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ messageId: 'first-turn' });
        } finally {
            await watcher.cleanup();
        }
    });

    it('discovers a transcript created after attach without replaying pre-attach usage', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_late_test';
        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await watcher.flush();
            expect(onUsage).not.toHaveBeenCalled();

            const dir = sessionDir(dataDir, sessionId);
            await mkdir(dir, { recursive: true });
            const messagesPath = join(dir, 'messages.jsonl');
            await writeFile(messagesPath, `${assistantLine({ messageId: 'pre-attach', timestamp: Date.now() - 60_000 })}\n`);

            await watcher.flush();
            expect(onUsage).not.toHaveBeenCalled();

            await appendFile(messagesPath, `${assistantLine({ messageId: 'post-attach' })}\n`);
            await watcher.flush();
            expect(onUsage).toHaveBeenCalledTimes(1);
            expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ messageId: 'post-attach' });
        } finally {
            await watcher.cleanup();
        }
    });
});
