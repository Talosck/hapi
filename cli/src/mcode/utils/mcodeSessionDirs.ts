import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

/**
 * Locating the native MiniMax Code session directory on disk.
 *
 * mcode stores every session in a dated directory
 * `<dataDir>/v2/sessions/<year>/<month>/<day>/<time>-session_<base64url(id)>/`
 * and keeps a runtime index of those directories in SQLite. The index answers
 * a session id with one query, so it is tried first; the dated tree stays the
 * fallback for installs whose index is missing, locked, or shaped differently.
 *
 * The tree fallback is walked newest first and remembers which day directories
 * it already searched, because the session directory of a session HAPI just
 * attached to may only appear later. Re-walking the whole tree on every retry
 * costs one full traversal per second on a machine with a year of sessions.
 */

const SESSION_DIR_PREFIX = 'session_';
const SESSIONS_ROOT_RELATIVE_PATH = ['v2', 'sessions'];
const SESSION_INDEX_RELATIVE_PATH = ['v2', 'sqlite', 'runtime-state.sqlite'];
/**
 * Days re-checked on every discovery retry. A session directory is created
 * together with its session, so a session HAPI just attached to can only turn
 * up in one of these.
 */
const RECENT_DAY_WINDOW = 7;

type SqliteStatement = {
    get(...params: unknown[]): unknown;
};
type SqliteDatabase = {
    query(sql: string): SqliteStatement;
    close(): void;
};

/** A dated session directory together with its parsed calendar day. */
export type McodeSessionDayDir = {
    /** `<year>-<month>-<day>`, independent of zero padding. */
    key: string;
    path: string;
};

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

/** True when the path exists and is a directory. */
async function isExistingDirectory(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/** `<year>-<month>-<day>` of a day directory, independent of zero padding. */
function dayKeyOf(dayDir: string): string {
    const parts = dayDir.split(/[\\/]/);
    return dayKey(
        Number(parts.at(-3)),
        Number(parts.at(-2)),
        Number(parts.at(-1))
    );
}

function dayKey(year: number, month: number, day: number): string {
    return `${Number.isFinite(year) ? year : 0}-${Number.isFinite(month) ? month : 0}-${Number.isFinite(day) ? day : 0}`;
}

/** Orders two day keys chronologically. */
function compareDayKeys(a: string, b: string): number {
    const [aYear, aMonth, aDay] = a.split('-').map(Number);
    const [bYear, bMonth, bDay] = b.split('-').map(Number);
    if (aYear !== bYear) return aYear - bYear;
    if (aMonth !== bMonth) return aMonth - bMonth;
    return aDay - bDay;
}

/** Day keys of the last `window` calendar days, ending today. */
function recentDayKeys(window: number, now: Date = new Date()): Set<string> {
    const keys = new Set<string>();
    for (let offset = 0; offset < window; offset++) {
        const date = new Date(now.getTime());
        date.setDate(date.getDate() - offset);
        keys.add(dayKey(date.getFullYear(), date.getMonth() + 1, date.getDate()));
    }
    return keys;
}

/**
 * The dated directories that can hold a session, newest first. The names are
 * zero padded (`<year>/<month>/<day>`), so the order is computed from the
 * parsed date rather than from the raw strings.
 */
export async function listMcodeSessionDayDirEntries(
    dataDir: string
): Promise<McodeSessionDayDir[]> {
    const root = join(dataDir, ...SESSIONS_ROOT_RELATIVE_PATH);
    const dayDirs: McodeSessionDayDir[] = [];
    for (const year of await listDirectories(root)) {
        const yearPath = join(root, year);
        for (const month of await listDirectories(yearPath)) {
            const monthPath = join(yearPath, month);
            for (const day of await listDirectories(monthPath)) {
                const path = join(monthPath, day);
                dayDirs.push({ key: dayKeyOf(path), path });
            }
        }
    }
    dayDirs.sort((a, b) => compareDayKeys(b.key, a.key));
    return dayDirs;
}

export async function listMcodeSessionDayDirs(dataDir: string): Promise<string[]> {
    return (await listMcodeSessionDayDirEntries(dataDir)).map((entry) => entry.path);
}

/** Finds the session directory inside the given day directories. */
export async function findMcodeSessionDirInDayDirs(
    sessionId: string,
    dayDirs: readonly string[]
): Promise<string | null> {
    const suffix = `-${mcodeSessionDirSuffix(sessionId)}`;
    for (const dayDir of dayDirs) {
        for (const name of await listDirectories(dayDir)) {
            if (name.endsWith(suffix)) return join(dayDir, name);
        }
    }
    return null;
}

/**
 * Open runtime index handles, one per data directory. The handle is kept for
 * the lifetime of the process: the index is read on every discovery attempt
 * and re-opening the database each time costs more than the query itself.
 */
const indexDatabases = new Map<string, SqliteDatabase>();

async function openIndexDatabase(databasePath: string): Promise<SqliteDatabase | null> {
    const cached = indexDatabases.get(databasePath);
    if (cached) return cached;
    try {
        const { Database } = await import('bun:sqlite');
        const database = new Database(databasePath, { readonly: true }) as unknown as SqliteDatabase;
        indexDatabases.set(databasePath, database);
        return database;
    } catch (error) {
        // A missing, locked, or unreadable index is not fatal: the dated tree
        // is the fallback. The failure is not cached so an index that appears
        // later is still picked up.
        logger.debug(`[mcode-session] Runtime index unavailable at ${databasePath}`, error);
        return null;
    }
}

/**
 * Reads the dated directory of a session from mcode's runtime index. Absence,
 * locks and format drift all read as "no entry".
 */
export async function readMcodeSessionIndexRelativeDir(
    sessionId: string,
    dataDir: string = getMcodeDataDir()
): Promise<string | null> {
    const databasePath = join(dataDir, ...SESSION_INDEX_RELATIVE_PATH);
    const database = await openIndexDatabase(databasePath);
    if (!database) return null;

    try {
        const row = database
            .query('SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id = ?')
            .get(sessionId) as { history_relative_dir?: unknown } | null | undefined;
        const relativeDir = typeof row?.history_relative_dir === 'string'
            ? row.history_relative_dir.trim()
            : '';
        return relativeDir || null;
    } catch (error) {
        logger.debug('[mcode-session] Runtime index query failed', error);
        return null;
    }
}

/** Reads the session's dated directory from the runtime index. */
export type McodeSessionIndexReader = (
    sessionId: string,
    dataDir: string
) => Promise<string | null>;

/**
 * Looks the session directory up in mcode's runtime index. The index is the
 * fast path: it answers a session id with one query instead of walking the
 * whole dated directory tree.
 *
 * A row that points at a directory that no longer exists (mcode moved or
 * compacted the session, or the row is stale) is treated as "no entry": the
 * dated tree is the fallback, and a watcher that trusted the stale path would
 * never find the transcript again.
 */
export async function findMcodeSessionDirFromIndex(
    sessionId: string,
    dataDir: string = getMcodeDataDir(),
    readRelativeDir: McodeSessionIndexReader = readMcodeSessionIndexRelativeDir
): Promise<string | null> {
    let relativeDir: string | null;
    try {
        relativeDir = await readRelativeDir(sessionId, dataDir);
    } catch (error) {
        logger.debug('[mcode-session] Runtime index lookup failed', error);
        return null;
    }
    if (!relativeDir) return null;

    const sessionDir = join(dataDir, ...SESSIONS_ROOT_RELATIVE_PATH, relativeDir);
    if (await isExistingDirectory(sessionDir)) {
        return sessionDir;
    }
    logger.debug(`[mcode-session] Runtime index points at a missing directory: ${sessionDir}`);
    return null;
}

/**
 * Locates the native session directory. The runtime index answers first; the
 * dated tree is walked newest first when the index has no entry.
 */
export async function findMcodeSessionDir(
    sessionId: string,
    dataDir: string = getMcodeDataDir(),
    readRelativeDir: McodeSessionIndexReader = readMcodeSessionIndexRelativeDir
): Promise<string | null> {
    const fromIndex = await findMcodeSessionDirFromIndex(sessionId, dataDir, readRelativeDir);
    if (fromIndex) return fromIndex;
    return findMcodeSessionDirInDayDirs(sessionId, await listMcodeSessionDayDirs(dataDir));
}

export type McodeSessionDirResolver = {
    /** Resolves the native session directory, or null while it is not on disk yet. */
    resolve: (sessionId: string) => Promise<string | null>;
};

/**
 * Stateful session directory lookup.
 *
 * The first resolution searches every dated directory. Later resolutions only
 * search the day directories that were not searched yet plus the recent ones,
 * because the directory of a session created moments ago shows up in a day
 * directory that already existed when the first search ran.
 */
export function createMcodeSessionDirResolver(opts: {
    dataDir?: string;
    recentDayWindow?: number;
    readRelativeDir?: McodeSessionIndexReader;
} = {}): McodeSessionDirResolver {
    const dataDir = opts.dataDir ?? getMcodeDataDir();
    const recentDayWindow = opts.recentDayWindow ?? RECENT_DAY_WINDOW;
    const readRelativeDir = opts.readRelativeDir ?? readMcodeSessionIndexRelativeDir;
    const searchedDayDirs = new Set<string>();
    let searchedForSessionId: string | null = null;

    const resolve = async (sessionId: string): Promise<string | null> => {
        if (sessionId !== searchedForSessionId) {
            // Which day directories were searched is specific to one session.
            searchedDayDirs.clear();
            searchedForSessionId = sessionId;
        }

        const fromIndex = await findMcodeSessionDirFromIndex(sessionId, dataDir, readRelativeDir);
        if (fromIndex) return fromIndex;

        const recentKeys = recentDayKeys(recentDayWindow);
        const dayDirs = await listMcodeSessionDayDirEntries(dataDir);
        const pending = dayDirs.filter(
            (dayDir) => !searchedDayDirs.has(dayDir.path) || recentKeys.has(dayDir.key)
        );
        for (const dayDir of pending) searchedDayDirs.add(dayDir.path);

        return findMcodeSessionDirInDayDirs(sessionId, pending.map((entry) => entry.path));
    };

    return { resolve };
}
