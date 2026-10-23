import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildMcodeUsageMessage,
    createMcodeUsageWatcher,
    findMcodeMessagesPath,
    parseMcodeUsageLine,
    readMcodeUsageSince
} from './mcodeUsage';
import { mcodeSessionDirSuffix } from './mcodeSessionDirs';

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
    timestamp?: number | string;
    omitTimestamp?: boolean;
} = {}): string {
    return JSON.stringify({
        message_id: opts.messageId ?? 'msg-assistant-1',
        turn_id: opts.turnId ?? 'turn-1',
        message: {
            role: 'assistant',
            model: opts.model ?? 'MiniMax-M3.1-Flash',
            ...(opts.omitTimestamp ? {} : { timestamp: opts.timestamp ?? Date.now() }),
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

    it('reads the timestamp from epoch milliseconds, epoch seconds and ISO strings', () => {
        expect(parseMcodeUsageLine(assistantLine({ timestamp: 1_700_000_000_000 }))?.timestampMs)
            .toBe(1_700_000_000_000);
        expect(parseMcodeUsageLine(assistantLine({ timestamp: 1_700_000_000 }))?.timestampMs)
            .toBe(1_700_000_000_000);
        expect(parseMcodeUsageLine(assistantLine({ timestamp: '2023-11-14T22:13:20.000Z' }))?.timestampMs)
            .toBe(1_700_000_000_000);
        expect(parseMcodeUsageLine(assistantLine({ timestamp: '1700000000000' }))?.timestampMs)
            .toBe(1_700_000_000_000);
    });

    it('reports an unreadable timestamp as missing', () => {
        expect(parseMcodeUsageLine(assistantLine({ timestamp: 'not-a-date' }))?.timestampMs).toBeNull();
        expect(parseMcodeUsageLine(assistantLine({ omitTimestamp: true }))?.timestampMs).toBeNull();
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
                contextTokens: 14_646,
                modelContextWindow: 512_000
            }
        });
    });

    it('reports the live context instead of the snapshot from the end of a turn', () => {
        // The agent publishes its context size over ACP at the end of a turn,
        // so while it works the snapshot is stale - and after a compaction it
        // is higher than the real context, because the compaction made the
        // context smaller. Taking the larger of the two pinned the context bar
        // to the snapshot: the usage indicator froze at a number that was too
        // high and never moved again.
        const beforeCompaction = parseMcodeUsageLine(assistantLine({
            input: 387,
            output: 101,
            cacheRead: 221_000,
            cacheWrite: 0,
            totalTokens: 221_488
        }));
        const afterCompaction = parseMcodeUsageLine(assistantLine({
            messageId: 'msg-assistant-2',
            input: 120,
            output: 80,
            cacheRead: 19_000,
            cacheWrite: 0,
            totalTokens: 19_200
        }));
        expect(beforeCompaction).not.toBeNull();
        expect(afterCompaction).not.toBeNull();

        const staleSnapshot = { contextTokens: 221_488, contextWindow: 512_000 };
        const model = 'm:minimax:MiniMax-M3:v:thinking';
        const first = buildMcodeUsageMessage(beforeCompaction!, model, staleSnapshot) as {
            info: { contextTokens?: number }
        };
        const second = buildMcodeUsageMessage(afterCompaction!, model, staleSnapshot) as {
            info: { contextTokens?: number }
        };

        expect(first.info.contextTokens).toBe(221_488);
        // The context has to be able to go down: a compaction made it smaller.
        expect(second.info.contextTokens).toBe(19_200);
    });

    it('never reports a context smaller than the cached prefix', () => {
        // The context is the whole of what the model call occupied: the
        // uncached prompt plus the cached prefix plus the response. The cached
        // prefix is part of it, so the status bar can never show more cached
        // tokens than used ones.
        const record = parseMcodeUsageLine(assistantLine({
            input: 387,
            output: 101,
            cacheRead: 221_000,
            cacheWrite: 0,
            totalTokens: 221_488
        }));
        expect(record).not.toBeNull();

        const message = buildMcodeUsageMessage(record!, 'm:minimax:MiniMax-M3:v:thinking', {
            contextTokens: 217_000,
            contextWindow: 512_000
        }) as { info: { contextTokens?: number; total: { cachedInputTokens?: number } } };

        expect(message.info.contextTokens).toBe(221_488);
        expect(message.info.contextTokens!).toBeGreaterThanOrEqual(message.info.total.cachedInputTokens!);
    });

    it('falls back to the transcript total when the agent has not reported a context size', () => {
        const record = parseMcodeUsageLine(assistantLine({
            input: 387,
            output: 101,
            cacheRead: 19_349,
            cacheWrite: 0,
            totalTokens: 19_837
        }));
        expect(record).not.toBeNull();

        const message = buildMcodeUsageMessage(record!, 'm:minimax:MiniMax-M3:v:thinking', null) as {
            info: { contextTokens?: number }
        };
        expect(message.info.contextTokens).toBe(19_837);
    });

    it('omits context fields when the backend has not reported them yet', () => {
        const record = parseMcodeUsageLine(assistantLine());
        const message = buildMcodeUsageMessage(record!, 'MiniMax-M3.1-Flash', null);
        expect(message?.type).toBe('token_count');
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
            .resolves.toEqual({ records: [], nextOffset: 42, reachedEnd: false, replaced: false, anchor: null });
    });

    it('re-reads a journal that was rewritten in place and grew', async () => {
        // MiniMax Code compacts a session by rewriting the transcript, and
        // the rewrite can make the file larger. When the rewrite changed the
        // bytes before the read offset, reading on from there would start in
        // the middle of a record and skip whatever the rewrite moved.
        const dataDir = await createTempDir();
        const messagesPath = join(dataDir, 'messages.jsonl');
        const first = `${assistantLine({ messageId: 'msg-1' })}\n`;
        const second = `${assistantLine({ messageId: 'msg-2' })}\n`;
        await writeFile(messagesPath, first + second);

        const initial = await readMcodeUsageSince(messagesPath, 0);
        expect(initial.records.map((record) => record.messageId)).toEqual(['msg-1', 'msg-2']);

        // The same history, rewritten with a different record in front.
        const rewritten = `${assistantLine({ messageId: 'msg-0' })}\n${first}${second}`;
        await writeFile(messagesPath, rewritten);

        const afterRewrite = await readMcodeUsageSince(messagesPath, initial.nextOffset, initial.anchor);
        expect(afterRewrite.replaced).toBe(true);
        expect(afterRewrite.nextOffset).toBe(Buffer.byteLength(rewritten));
        expect(afterRewrite.records.map((record) => record.messageId)).toEqual(['msg-0', 'msg-1', 'msg-2']);
    });

    it('keeps reading a journal that was appended to', async () => {
        const dataDir = await createTempDir();
        const messagesPath = join(dataDir, 'messages.jsonl');
        const first = `${assistantLine({ messageId: 'msg-1' })}\n`;
        await writeFile(messagesPath, first);

        const initial = await readMcodeUsageSince(messagesPath, 0);
        const second = `${assistantLine({ messageId: 'msg-2' })}\n`;
        await appendFile(messagesPath, second);

        const appended = await readMcodeUsageSince(messagesPath, initial.nextOffset, initial.anchor);
        expect(appended.replaced).toBe(false);
        expect(appended.records.map((record) => record.messageId)).toEqual(['msg-2']);
    });

    it('keeps reading a journal whose rewritten prefix still matches', async () => {
        // A rewrite that left the bytes before the read offset untouched moved
        // nothing: the records already read are the same ones, so reading on
        // from the offset stays correct.
        const dataDir = await createTempDir();
        const messagesPath = join(dataDir, 'messages.jsonl');
        const first = `${assistantLine({ messageId: 'msg-1' })}\n`;
        await writeFile(messagesPath, first);

        const initial = await readMcodeUsageSince(messagesPath, 0);
        const second = `${assistantLine({ messageId: 'msg-2' })}\n`;
        await writeFile(messagesPath, first + second);

        const afterRewrite = await readMcodeUsageSince(messagesPath, initial.nextOffset, initial.anchor);
        expect(afterRewrite.replaced).toBe(false);
        expect(afterRewrite.records.map((record) => record.messageId)).toEqual(['msg-2']);
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

    it('bills the previous session before switching to another native session', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_switch_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');

        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await writeFile(messagesPath, `${assistantLine({ messageId: 'first' })}\n`);
            await watcher.flush();
            expect(onUsage).toHaveBeenCalledTimes(1);

            await appendFile(messagesPath, `${assistantLine({ messageId: 'second' })}\n`);
            // Switching sessions flushes what the previous session wrote.
            await watcher.attach('mvs_other_session');

            expect(onUsage).toHaveBeenCalledTimes(2);
            expect(onUsage.mock.calls[1]?.[0]).toMatchObject({ messageId: 'second' });
        } finally {
            await watcher.cleanup();
        }
    });

    it('watches the new session when a handoff overlaps the discovery of the old one', async () => {
        const dataDir = await createTempDir();
        const first = 'mvs_race_first';
        const second = 'mvs_race_second';
        const firstDir = sessionDir(dataDir, first);
        const secondDir = sessionDir(dataDir, second);
        await mkdir(firstDir, { recursive: true });
        await mkdir(secondDir, { recursive: true });
        const firstPath = join(firstDir, 'messages.jsonl');
        const secondPath = join(secondDir, 'messages.jsonl');
        await writeFile(firstPath, `${assistantLine({ messageId: 'first-old' })}\n`);
        await writeFile(secondPath, `${assistantLine({ messageId: 'second-old' })}\n`);
        // Both journals predate the attach, so the watcher resumes from their
        // tail. Without the backdating the comparison would depend on the
        // millisecond the attach happened to land in.
        const writtenAt = new Date(Date.now() - 60_000);
        await utimes(firstPath, writtenAt, writtenAt);
        await utimes(secondPath, writtenAt, writtenAt);

        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, pollIntervalMs: 10 });
        try {
            // The handoff starts while the discovery of the first session is
            // still running: the watcher has to end up tailing the second
            // session on its own — nothing else would start a new discovery.
            await Promise.all([watcher.attach(first), watcher.attach(second)]);

            await appendFile(secondPath, `${assistantLine({ messageId: 'second-new' })}\n`);
            await vi.waitFor(() => {
                expect(onUsage).toHaveBeenCalledTimes(1);
            }, { timeout: 2_000 });
            expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ messageId: 'second-new' });

            // The journal of the session we left is not watched any more.
            await appendFile(firstPath, `${assistantLine({ messageId: 'first-new' })}\n`);
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(onUsage).toHaveBeenCalledTimes(1);
        } finally {
            await watcher.cleanup();
        }
    });

    it('reports a transcript that cannot be located', async () => {
        const dataDir = await createTempDir();
        const onUsage = vi.fn();
        const onWarning = vi.fn();
        const watcher = createMcodeUsageWatcher({
            dataDir,
            onUsage,
            onWarning,
            pollIntervalMs: 60_000,
            discoveryRetryMs: 0,
            maxSessionDirLookups: 1
        });
        try {
            await watcher.attach('mvs_missing');
            await vi.waitFor(() => {
                expect(onWarning).toHaveBeenCalledTimes(1);
            });
            expect(onWarning.mock.calls[0]?.[0]).toMatch(/could not be located/);
            expect(onUsage).not.toHaveBeenCalled();
        } finally {
            await watcher.cleanup();
        }
    });

    it('reports a transcript that has not appeared yet without giving up', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_idle_test';
        await mkdir(sessionDir(dataDir, sessionId), { recursive: true });

        const onUsage = vi.fn();
        const onWarning = vi.fn();
        const watcher = createMcodeUsageWatcher({
            dataDir,
            onUsage,
            onWarning,
            pollIntervalMs: 60_000,
            discoveryRetryMs: 0,
            maxJournalWaitAttempts: 1
        });
        try {
            await watcher.attach(sessionId);
            await vi.waitFor(() => {
                expect(onWarning).not.toHaveBeenCalled();
            });
            // The transcript shows up with the first prompt.
            const messagesPath = join(sessionDir(dataDir, sessionId), 'messages.jsonl');
            await writeFile(messagesPath, `${assistantLine({ messageId: 'first-prompt' })}\n`);
            await watcher.flush();

            expect(onUsage).toHaveBeenCalledTimes(1);
            expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ messageId: 'first-prompt' });
        } finally {
            await watcher.cleanup();
        }
    });

    it('skips a record without a readable timestamp while pre-attach history is excluded', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_no_timestamp_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');
        await writeFile(
            messagesPath,
            `${assistantLine({ messageId: 'post-attach', timestamp: Date.now() + 30_000 })}\n`
            + `${assistantLine({ messageId: 'no-timestamp', omitTimestamp: true })}\n`
        );
        // The journal was written after the attach, so the pre-attach floor
        // applies and every record has to be checked against it.
        const writtenAt = new Date(Date.now() + 60_000);
        await utimes(messagesPath, writtenAt, writtenAt);

        const onUsage = vi.fn();
        const onWarning = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, onWarning, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await vi.waitFor(() => {
                expect(onWarning).toHaveBeenCalledTimes(1);
            });

            // The record that cannot be proven to be new is skipped.
            expect(onUsage).toHaveBeenCalledTimes(1);
            expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ messageId: 'post-attach' });
            expect(onWarning.mock.calls[0]?.[0]).toMatch(/no readable timestamp/);
        } finally {
            await watcher.cleanup();
        }
    });

    it('does not bill a pre-attach record that completes after a partial read', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_partial_floor_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');

        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({
            dataDir,
            onUsage,
            pollIntervalMs: 60_000,
            discoveryRetryMs: 10
        });
        try {
            await watcher.attach(sessionId);

            // The journal appears after the attach with one complete record
            // that predates the attach plus a second one that is only half
            // written. The first read stops at the last complete line, so the
            // pre-attach floor must survive it.
            const before = Date.now() - 60_000;
            const complete = assistantLine({ messageId: 'old-1', timestamp: before });
            const partial = assistantLine({ messageId: 'old-2', timestamp: before });
            await writeFile(messagesPath, `${complete}\n${partial.slice(0, 40)}`);
            await watcher.flush();
            expect(onUsage).not.toHaveBeenCalled();

            // The rest of the second (pre-attach) record arrives.
            await appendFile(messagesPath, `${partial.slice(40)}\n`);
            await watcher.flush();

            expect(onUsage).not.toHaveBeenCalled();
        } finally {
            await watcher.cleanup();
        }
    });

    it('bills a record written after the attach with a whole-second timestamp', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_second_precision_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');

        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({
            dataDir,
            onUsage,
            pollIntervalMs: 60_000,
            discoveryRetryMs: 10
        });
        try {
            await watcher.attach(sessionId);

            // The transcript stores whole seconds, so a record written right
            // after the attach can carry a timestamp up to a second below it.
            const secondPrecision = Math.floor(Date.now() / 1000) * 1000;
            await writeFile(messagesPath, `${assistantLine({ messageId: 'new-1', timestamp: secondPrecision })}\n`);
            await watcher.flush();

            expect(onUsage).toHaveBeenCalledTimes(1);
        } finally {
            await watcher.cleanup();
        }
    });

    it('reads a rewritten transcript again without billing the same record twice', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_rewritten_recovery_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');
        await writeFile(messagesPath, `${assistantLine({ messageId: 'first' })}\n`);

        const onUsage = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await watcher.flush();

            // The journal is replaced by one that holds the same record plus a
            // new one: the replacement is read again, but a record that was
            // already billed is not billed twice.
            await writeFile(
                messagesPath,
                `${assistantLine({ messageId: 'first' })}\n${assistantLine({ messageId: 'second' })}\n`
            );
            await watcher.flush();

            const billed = onUsage.mock.calls.map((call) => (call[0] as { messageId: string }).messageId);
            expect(billed.filter((id) => id === 'first').length).toBeLessThanOrEqual(1);
            expect(billed.filter((id) => id === 'second').length).toBe(1);
        } finally {
            await watcher.cleanup();
        }
    });

    it('reports a transcript that was rewritten while it was being read', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mvs_rewritten_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');
        await writeFile(messagesPath, `${assistantLine({ messageId: 'long' })}\n`.repeat(20));

        const onUsage = vi.fn();
        const onWarning = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, onWarning, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await watcher.flush();

            // A shorter journal means it was replaced rather than appended to.
            await writeFile(messagesPath, `${assistantLine({ messageId: 'short' })}\n`);
            await watcher.flush();

            await vi.waitFor(() => {
                expect(onWarning).toHaveBeenCalledTimes(1);
            });
            expect(onWarning.mock.calls[0]?.[0]).toMatch(/rewritten/);
        } finally {
            await watcher.cleanup();
        }
    });

    it('reports a transcript that disappeared while it was being read', async () => {
        const dataDir = await createTempDir();
        const sessionId = 'mjs_vanished_test';
        const dir = sessionDir(dataDir, sessionId);
        await mkdir(dir, { recursive: true });
        const messagesPath = join(dir, 'messages.jsonl');
        await writeFile(messagesPath, `${assistantLine({ messageId: 'first' })}\n`);

        const onUsage = vi.fn();
        const onWarning = vi.fn();
        const watcher = createMcodeUsageWatcher({ dataDir, onUsage, onWarning, pollIntervalMs: 60_000 });
        try {
            await watcher.attach(sessionId);
            await watcher.flush();

            await rm(messagesPath);
            await watcher.flush();

            await vi.waitFor(() => {
                expect(onWarning).toHaveBeenCalledTimes(1);
            });
            expect(onWarning.mock.calls[0]?.[0]).toMatch(/disappeared/);
        } finally {
            await watcher.cleanup();
        }
    });
});
