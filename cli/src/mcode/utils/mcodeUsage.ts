import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { convertAgentMessage, type CodexMessage } from '@/agent/messageConverter';
import { logger } from '@/ui/logger';

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
    timestampMs: number | null;
};

export type McodeUsageReadResult = {
    records: McodeUsageRecord[];
    nextOffset: number;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DISCOVERY_RETRY_MS = 1000;
const MAX_SESSION_DIR_LOOKUPS = 120;
const SESSION_DIR_PREFIX = 'session_';

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

/** `~/.minimax` by default; both env vars are honored by the mcode CLI. */
export function getMcodeDataDir(): string {
    const configured = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
    return configured || join(homedir(), '.minimax');
}

/** Directory names end in `session_<base64url(sessionId)>` (capped at 180 chars). */
export function mcodeSessionDirSuffix(sessionId: string): string {
    return `${SESSION_DIR_PREFIX}${Buffer.from(sessionId, 'utf8').toString('base64url').slice(0, 180)}`;
}

async function listDirectories(path: string): Promise<string[]> {
    try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

/**
 * Locates the native session directory. The layout is
 * `<dataDir>/v2/sessions/<year>/<month>/<day>/<time>-<suffix>/`.
 */
export async function findMcodeSessionDir(
    sessionId: string,
    dataDir: string = getMcodeDataDir()
): Promise<string | null> {
    const root = join(dataDir, 'v2', 'sessions');
    const suffix = mcodeSessionDirSuffix(sessionId);

    for (const year of await listDirectories(root)) {
        const yearPath = join(root, year);
        for (const month of await listDirectories(yearPath)) {
            const monthPath = join(yearPath, month);
            for (const day of await listDirectories(monthPath)) {
                const dayPath = join(monthPath, day);
                for (const sessionDir of await listDirectories(dayPath)) {
                    if (sessionDir.endsWith(`-${suffix}`)) {
                        return join(dayPath, sessionDir);
                    }
                }
            }
        }
    }
    return null;
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
        timestampMs: asCount(message.timestamp)
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
        return { records: [], nextOffset: offset };
    }

    if (size < offset) {
        // The journal is append-only for a live session; a shrink means it was
        // replaced. Skip to the new end instead of replaying the whole file.
        logger.debug(`[mcode-usage] Journal shrank (${size} < ${offset}); skipping to end`);
        return { records: [], nextOffset: size };
    }
    if (size === offset) return { records: [], nextOffset: offset };

    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) return { records: [], nextOffset: offset };

        const complete = text.slice(0, lastNewline + 1);
        const records: McodeUsageRecord[] = [];
        for (const line of complete.split('\n')) {
            if (!line.trim()) continue;
            const record = parseMcodeUsageLine(line);
            if (record) records.push(record);
        }
        return {
            records,
            nextOffset: offset + Buffer.byteLength(complete, 'utf8')
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
 * Converts a transcript usage record into the generic agent envelope. The
 * context fields come from the latest ACP `usage_update`; without them the
 * web context bar would fall back to this call's prompt size.
 */
export function buildMcodeUsageMessage(
    record: McodeUsageRecord,
    model: string | null | undefined,
    context: McodeUsageContext | null
): CodexMessage | null {
    return convertAgentMessage({
        type: 'usage',
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheCreationTokens: record.cacheWriteTokens,
        ...(context?.contextTokens !== undefined ? { contextTokens: context.contextTokens } : {}),
        ...(context?.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {})
    }, model);
}

export type McodeUsageWatcherOptions = {
    onUsage: (record: McodeUsageRecord) => void;
    dataDir?: string;
    pollIntervalMs?: number;
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

    let sessionId: string | null = null;
    let sessionDir: string | null = null;
    let messagesPath: string | null = null;
    let offset = 0;
    let attachedAtMs = 0;
    let minTimestampMs: number | null = null;
    let generation = 0;
    let discoveryAttempts = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollPromise: Promise<void> | null = null;
    let discoveryPromise: Promise<void> | null = null;
    let stopped = false;

    const clearPollTimer = (): void => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
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
            offset = result.nextOffset;
            if (timestampFloor !== null && result.nextOffset > startOffset) {
                // The catch-up read covered the file's current tail; later
                // appends are unambiguously new.
                minTimestampMs = null;
            }
            for (const record of result.records) {
                if (stopped || targetGeneration !== generation) return;
                if (
                    timestampFloor !== null
                    && record.timestampMs !== null
                    && record.timestampMs < timestampFloor
                ) {
                    continue;
                }
                try {
                    options.onUsage(record);
                } catch (error) {
                    logger.debug('[mcode-usage] Failed to forward a usage record', error);
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
        if (!sessionDir && discoveryAttempts >= MAX_SESSION_DIR_LOOKUPS) {
            logger.debug(
                `[mcode-usage] Native session directory not found after ${discoveryAttempts} attempts;`
                + ' usage for this session will not be recorded'
            );
            return;
        }
        discoveryTimer = setTimeout(() => {
            discoveryTimer = null;
            void discover();
        }, DISCOVERY_RETRY_MS);
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
                dir = await findMcodeSessionDir(targetSessionId, dataDir);
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
            if (!stats) {
                // The journal appears with the first prompt; keep waiting even
                // if the user leaves the session idle for a long time.
                scheduleDiscovery();
                return;
            }

            messagesPath = path;
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
            await discover();
            return;
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
