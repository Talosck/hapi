import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { convertAgentMessage, type CodexMessage } from '@/agent/messageConverter';
import { logger } from '@/ui/logger';
import {
    createMcodeSessionDirResolver,
    findMcodeSessionDir,
    getMcodeDataDir
} from './mcodeSessionDirs';

/**
 * Usage for one model call, as persisted by MiniMax Code in
 * `~/.minimax/v2/sessions/<date>/<time>-session_<id>/messages.jsonl`.
 *
 * mcode's ACP server reports context usage (`used` / `size`) and cost, but not
 * token counts, so the transcript is the only source for the usage dashboard.
 * The persisted shape mirrors the Anthropic Messages API: `input` is the
 * uncached prompt, with cache reads/writes in sibling fields.
 */
export type McodeUsageRecord = {
    messageId: string;
    turnId: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    /** Message timestamp in milliseconds, or null when it cannot be read. */
    timestampMs: number | null;
};

export type McodeUsageReadResult = {
    records: McodeUsageRecord[];
    nextOffset: number;
    /**
     * True when the read covered the file up to its current end. A read that
     * stops at a half-written trailing line has not seen the tail yet, so the
     * caller must not treat the file as fully consumed.
     */
    reachedEnd: boolean;
    /** True when the journal was replaced and read again from the start. */
    replaced: boolean;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DISCOVERY_RETRY_MS = 1000;
const MAX_SESSION_DIR_LOOKUPS = 120;
/**
 * How long the transcript may stay missing before the wait is reported. The
 * journal normally appears with the first prompt, so the wait continues past
 * this point — the report only says that usage is not being recorded yet.
 */
const MAX_JOURNAL_WAIT_ATTEMPTS = 120;
/**
 * Slack applied when comparing a transcript timestamp against the attach
 * time. The transcript may store whole seconds, so a record written right
 * after the attach can carry a timestamp up to a second below it.
 */
const TIMESTAMP_TOLERANCE_MS = 1000;
/** How many billed message ids are remembered for de-duplication. */
const MAX_BILLED_MESSAGE_IDS = 1024;

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : null;
}

/**
 * The transcript timestamp in milliseconds, or null when it cannot be read.
 *
 * mcode writes epoch milliseconds, but the value is compared against the
 * attach time to keep pre-HAPI history out of the dashboard, so a build that
 * writes ISO strings or epoch seconds still has to yield a usable number.
 */
function parseTimestampMs(value: unknown): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) return null;
        // Epoch seconds are a thousand times smaller than milliseconds.
        return value >= 1e8 && value < 1e11 ? Math.floor(value * 1000) : Math.floor(value);
    }
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;
    // A numeric string is an epoch value, not a date literal.
    if (/^\d+$/.test(trimmed)) {
        const numeric = Number(trimmed);
        return numeric >= 1e8 && numeric < 1e11 ? Math.floor(numeric * 1000) : Math.floor(numeric);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Locates the canonical messages journal for a native mcode session. */
export async function findMcodeMessagesPath(
    sessionId: string,
    dataDir: string = getMcodeDataDir()
): Promise<string | null> {
    const sessionDir = await findMcodeSessionDir(sessionId, dataDir);
    return sessionDir ? join(sessionDir, 'messages.jsonl') : null;
}

/** Parses one messages.jsonl line; non-assistant or usage-less lines yield null. */
export function parseMcodeUsageLine(line: string): McodeUsageRecord | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }

    const entry = asRecord(parsed);
    const message = asRecord(entry?.message);
    if (!entry || message?.role !== 'assistant') return null;

    const usage = asRecord(message.usage);
    if (!usage) return null;

    const inputTokens = asCount(usage.input) ?? 0;
    const outputTokens = asCount(usage.output) ?? 0;
    const cacheReadTokens = asCount(usage.cacheRead) ?? 0;
    const cacheWriteTokens = asCount(usage.cacheWrite) ?? 0;
    const recordedTotal = asCount(usage.totalTokens);
    const totalTokens = recordedTotal
        ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (totalTokens <= 0) return null;

    return {
        messageId: asString(entry.message_id) ?? 'unknown',
        turnId: asString(entry.turn_id),
        model: asString(message.model),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        timestampMs: parseTimestampMs(message.timestamp)
    };
}

/**
 * Reads complete lines appended after `offset`. An incomplete trailing line is
 * left for the next call so a mid-write poll cannot discard a usage record.
 */
export async function readMcodeUsageSince(
    filePath: string,
    offset: number
): Promise<McodeUsageReadResult> {
    let size: number;
    try {
        size = (await stat(filePath)).size;
    } catch {
        return { records: [], nextOffset: offset, reachedEnd: false, replaced: false };
    }

    let replaced = false;
    if (size < offset) {
        // The journal is append-only for a live session, so a smaller file
        // means it was replaced. Read it again from the start: the records it
        // holds are still the session's usage, and the caller de-duplicates
        // the ones it already billed.
        logger.debug(`[mcode-usage] Journal shrank (${size} < ${offset}); re-reading from the start`);
        offset = 0;
        replaced = true;
    }
    if (size === offset) {
        return { records: [], nextOffset: offset, reachedEnd: true, replaced };
    }

    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) {
            // A single half-written line: nothing is complete yet.
            return { records: [], nextOffset: offset, reachedEnd: false, replaced };
        }

        const complete = text.slice(0, lastNewline + 1);
        const records: McodeUsageRecord[] = [];
        for (const line of complete.split('\n')) {
            if (!line.trim()) continue;
            const record = parseMcodeUsageLine(line);
            if (record) records.push(record);
        }
        const nextOffset = offset + Buffer.byteLength(complete, 'utf8');
        return {
            records,
            nextOffset,
            // The file was read to its end only when the complete lines cover
            // it. A trailing partial line means the tail is still unread.
            reachedEnd: nextOffset >= size,
            replaced
        };
    } finally {
        await handle.close();
    }
}

type McodeFileStats = {
    size: number;
    mtimeMs: number;
};

async function fileStats(filePath: string): Promise<McodeFileStats | null> {
    try {
        const stats = await stat(filePath);
        return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
        return null;
    }
}

export type McodeUsageContext = {
    contextTokens?: number;
    contextWindow?: number;
};

/**
 * Converts a transcript usage record into the generic agent envelope.
 *
 * The context size comes from the transcript record itself: the total is the
 * context the model call occupied (the uncached prompt plus the cached prefix
 * plus the response). MiniMax Code publishes its own context size over ACP
 * only at the end of a turn, so that value is stale while the agent is
 * working — and it can be smaller than the cached prefix, which made the
 * status bar report more cached tokens than used ones.
 */
export function buildMcodeUsageMessage(
    record: McodeUsageRecord,
    model: string | null | undefined,
    context: McodeUsageContext | null
): CodexMessage | null {
    const contextTokens = Math.max(record.totalTokens, context?.contextTokens ?? 0);
    return convertAgentMessage({
        type: 'usage',
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheCreationTokens: record.cacheWriteTokens,
        contextTokens,
        ...(context?.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {})
    }, model);
}

export type McodeUsageWatcherOptions = {
    onUsage: (record: McodeUsageRecord) => void;
    /**
     * Reports a problem that stops usage recording. The message is surfaced
     * in the session so a silently missing transcript is not mistaken for an
     * idle agent.
     */
    onWarning?: (message: string) => void;
    dataDir?: string;
    pollIntervalMs?: number;
    /** Delay between discovery attempts. */
    discoveryRetryMs?: number;
    /** How many discovery attempts run before a missing transcript is reported. */
    maxSessionDirLookups?: number;
    /** How many attempts a missing transcript is waited for before it is reported. */
    maxJournalWaitAttempts?: number;
};

export type McodeUsageWatcher = {
    /** Starts tailing the native journal; resolves after the first discovery attempt. */
    attach: (sessionId: string) => Promise<void>;
    /** Reads anything appended since the previous poll. */
    flush: () => Promise<void>;
    cleanup: () => Promise<void>;
};

/**
 * Tails the native mcode transcript and forwards newly appended usage records.
 *
 * A journal that predates the attach is resumed from its tail. A journal that
 * appears afterwards (a new session writes messages.jsonl with its first
 * prompt) is read from the beginning, keeping only records newer than the
 * attach. Either way, pre-HAPI history is not attributed to this session and
 * reopening a session never double-counts usage already stored in the hub.
 */
export function createMcodeUsageWatcher(options: McodeUsageWatcherOptions): McodeUsageWatcher {
    const dataDir = options.dataDir ?? getMcodeDataDir();
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const discoveryRetryMs = options.discoveryRetryMs ?? DISCOVERY_RETRY_MS;
    const maxSessionDirLookups = options.maxSessionDirLookups ?? MAX_SESSION_DIR_LOOKUPS;
    const maxJournalWaitAttempts = options.maxJournalWaitAttempts ?? MAX_JOURNAL_WAIT_ATTEMPTS;
    // The resolver keeps the day directories it already searched, so a
    // discovery retry does not re-walk the whole dated session tree.
    const sessionDirResolver = createMcodeSessionDirResolver({ dataDir });

    let sessionId: string | null = null;
    let sessionDir: string | null = null;
    let messagesPath: string | null = null;
    let offset = 0;
    let attachedAtMs = 0;
    let minTimestampMs: number | null = null;
    let generation = 0;
    let discoveryAttempts = 0;
    let journalWaitAttempts = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollPromise: Promise<void> | null = null;
    let discoveryPromise: Promise<void> | null = null;
    let stopped = false;
    const reportedWarnings = new Set<string>();
    /**
     * Message ids that were already billed. A journal that is rewritten (the
     * agent replaced it) is read again from the start, and the records it
     * still holds must not be billed twice.
     */
    const billedMessageIds = new Set<string>();

    /** Logs a warning once, for problems that do not need the user's attention. */
    const warnOnce = (message: string): void => {
        if (reportedWarnings.has(message)) return;
        reportedWarnings.add(message);
        logger.warn(`[mcode-usage] ${message}`);
    };

    /**
     * Logs a warning once and surfaces it in the session. Used for failures
     * that stop usage recording: without them the dashboard would just show
     * an empty session and nothing would say why.
     */
    const warnUserOnce = (message: string): void => {
        if (reportedWarnings.has(message)) return;
        reportedWarnings.add(message);
        logger.warn(`[mcode-usage] ${message}`);
        try {
            options.onWarning?.(message);
        } catch (error) {
            logger.debug('[mcode-usage] Failed to report a usage warning', error);
        }
    };

    const clearPollTimer = (): void => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    };

    /**
     * Identity of a usage record for de-duplication. The message id is
     * stable for one model call; a record without one falls back to the
     * fields that identify the call.
     */
    const billedKeyOf = (record: McodeUsageRecord): string => (
        record.messageId !== 'unknown'
            ? record.messageId
            : `${record.turnId ?? ''}:${record.timestampMs ?? ''}:${record.totalTokens}`
    );

    const isAlreadyBilled = (record: McodeUsageRecord): boolean => (
        billedMessageIds.has(billedKeyOf(record))
    );

    const rememberBilled = (record: McodeUsageRecord): void => {
        const key = billedKeyOf(record);
        billedMessageIds.add(key);
        while (billedMessageIds.size > MAX_BILLED_MESSAGE_IDS) {
            const oldest = billedMessageIds.values().next().value;
            if (oldest === undefined) break;
            billedMessageIds.delete(oldest);
        }
    };

    const clearDiscoveryTimer = (): void => {
        if (discoveryTimer) {
            clearTimeout(discoveryTimer);
            discoveryTimer = null;
        }
    };

    const poll = (): Promise<void> => {
        if (stopped || !messagesPath) return Promise.resolve();
        if (pollPromise) return pollPromise;

        const targetPath = messagesPath;
        const targetGeneration = generation;
        const startOffset = offset;
        const timestampFloor = minTimestampMs;
        pollPromise = (async () => {
            let result: McodeUsageReadResult;
            try {
                result = await readMcodeUsageSince(targetPath, startOffset);
            } catch (error) {
                logger.debug(`[mcode-usage] Failed to read ${targetPath}`, error);
                return;
            }
            // A mode handoff may attach the watcher to another native session
            // while this read was in flight; never bill the old one.
            if (stopped || targetGeneration !== generation) return;
            if (result.replaced) {
                warnUserOnce(
                    'The MiniMax Code transcript was rewritten while it was being read;'
                    + ' its usage is read again from the start.'
                );
            }
            offset = result.nextOffset;
            if (timestampFloor !== null && result.reachedEnd) {
                // The catch-up read covered the file's current end, so every
                // later append is unambiguously new. A read that stopped at a
                // half-written line has not seen the tail yet: dropping the
                // floor then would bill a record that was written before the
                // attach (the hub already stores it from the previous session).
                minTimestampMs = null;
            }
            for (const record of result.records) {
                if (stopped || targetGeneration !== generation) return;
                if (isAlreadyBilled(record)) continue;
                if (timestampFloor !== null) {
                    if (record.timestampMs === null) {
                        // The floor keeps pre-HAPI history out of the dashboard.
                        // A record without a readable timestamp cannot be
                        // proven to be newer than the attach, so it is skipped
                        // rather than billed to this session.
                        warnUserOnce(
                            'Some MiniMax Code usage records have no readable timestamp and'
                            + ' were skipped, so token usage for this session may be incomplete.'
                        );
                        continue;
                    }
                    // The transcript may store whole seconds, so a record
                    // written right after the attach can carry a timestamp up
                    // to a second below the attach time. One second of
                    // tolerance keeps that first turn from being dropped.
                    if (record.timestampMs < timestampFloor - TIMESTAMP_TOLERANCE_MS) continue;
                }
                rememberBilled(record);
                try {
                    options.onUsage(record);
                } catch (error) {
                    logger.debug('[mcode-usage] Failed to forward a usage record', error);
                }
            }
            if (result.records.length === 0 && result.nextOffset === startOffset) {
                // Nothing was appended. A journal that vanished (rotated away)
                // reads exactly like an idle one, so check for it explicitly.
                const stats = await fileStats(targetPath);
                if (!stats && !stopped && targetGeneration === generation) {
                    warnUserOnce(
                        'The MiniMax Code transcript disappeared while it was being read;'
                        + ' token usage recording for this session has stopped.'
                    );
                }
            }
        })().finally(() => {
            pollPromise = null;
        });
        return pollPromise;
    };

    const startPolling = (): void => {
        if (pollTimer || stopped) return;
        pollTimer = setInterval(() => {
            void poll();
        }, pollIntervalMs);
        pollTimer.unref?.();
    };

    const scheduleDiscovery = (): void => {
        if (stopped || discoveryTimer || messagesPath) return;
        // A missing session directory means this mcode build does not use the
        // expected layout. A missing messages.jsonl is normal for an idle new
        // session, so only the directory lookup is bounded.
        if (!sessionDir && discoveryAttempts >= maxSessionDirLookups) {
            warnUserOnce(
                'MiniMax Code\'s session transcript could not be located, so token usage'
                + ' will not be recorded for this session.'
            );
            return;
        }
        if (sessionDir && journalWaitAttempts >= maxJournalWaitAttempts) {
            // The journal normally appears with the first prompt, so keep
            // waiting for it, but say that usage is not being recorded yet.
            warnOnce(
                'MiniMax Code\'s session transcript has not appeared yet, so token usage'
                + ' for this session is not being recorded.'
            );
        }
        discoveryTimer = setTimeout(() => {
            discoveryTimer = null;
            void discover();
        }, discoveryRetryMs);
        discoveryTimer.unref?.();
    };

    const discover = (): Promise<void> => {
        if (stopped || !sessionId || messagesPath) return Promise.resolve();
        if (discoveryPromise) return discoveryPromise;

        const targetSessionId = sessionId;
        const targetGeneration = generation;
        discoveryPromise = (async () => {
            let dir = sessionDir;
            if (!dir) {
                dir = await sessionDirResolver.resolve(targetSessionId);
                if (stopped || targetGeneration !== generation) return;
                if (!dir) {
                    discoveryAttempts += 1;
                    scheduleDiscovery();
                    return;
                }
                sessionDir = dir;
            }

            const path = join(dir, 'messages.jsonl');
            const stats = await fileStats(path);
            // A mode handoff may attach the watcher to another native session
            // while this read was in flight: the journal of the session we are
            // leaving must not be watched for the new one.
            if (stopped || targetGeneration !== generation) return;
            if (!stats) {
                // The journal appears with the first prompt; keep waiting even
                // if the user leaves the session idle for a long time.
                journalWaitAttempts += 1;
                scheduleDiscovery();
                return;
            }

            messagesPath = path;
            journalWaitAttempts = 0;
            if (stats.mtimeMs < attachedAtMs) {
                // The journal predates this attach: resume from its tail so
                // pre-HAPI history is never attributed to this session.
                offset = stats.size;
                minTimestampMs = null;
            } else {
                // The journal was created or written after attach (for example
                // a new session whose messages.jsonl appears with the first
                // prompt). Read it from the beginning and keep only records
                // newer than attach.
                offset = 0;
                minTimestampMs = attachedAtMs;
            }
            clearDiscoveryTimer();
            logger.debug(`[mcode-usage] Watching ${path} from offset ${offset}`);
            startPolling();
            await poll();
        })().catch((error) => {
            logger.debug('[mcode-usage] Failed to locate the native session transcript', error);
            discoveryAttempts += 1;
            scheduleDiscovery();
        }).finally(() => {
            discoveryPromise = null;
        });
        return discoveryPromise;
    };

    const attach = async (nextSessionId: string): Promise<void> => {
        if (stopped) return;
        if (sessionId === nextSessionId) {
            // The same native session (a local → remote handoff re-attaches
            // the session the TUI already created): bill what it wrote before
            // the handoff instead of dropping the tail.
            if (messagesPath) {
                await flush();
            }
            await discover();
            return;
        }

        // Bill what the previous native session wrote before switching away.
        // A mode handoff would otherwise drop the last poll interval of usage
        // for the session that is being left behind.
        if (messagesPath) {
            await flush();
        }

        // A discovery for the session we are leaving may still be running: it
        // would set the journal path of the OLD session after the state was
        // reset, and the new session would never be watched (its usage would
        // be missing for the rest of the session). Wait for it to settle.
        if (discoveryPromise) {
            await discoveryPromise.catch(() => undefined);
        }

        clearPollTimer();
        clearDiscoveryTimer();
        generation += 1;
        sessionId = nextSessionId;
        sessionDir = null;
        messagesPath = null;
        offset = 0;
        attachedAtMs = Date.now();
        minTimestampMs = null;
        discoveryAttempts = 0;
        journalWaitAttempts = 0;
        await discover();
    };

    const flush = async (): Promise<void> => {
        if (!messagesPath) {
            await discover();
            return;
        }
        await poll();
    };

    const cleanup = async (): Promise<void> => {
        if (stopped) return;
        // Capture usage appended during the final turn before detaching.
        await poll();
        stopped = true;
        generation += 1;
        clearPollTimer();
        clearDiscoveryTimer();
        if (pollPromise) await pollPromise;
        if (discoveryPromise) await discoveryPromise;
        clearPollTimer();
        clearDiscoveryTimer();
    };

    return { attach, flush, cleanup };
}
