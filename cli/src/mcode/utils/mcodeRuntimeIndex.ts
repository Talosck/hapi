import { logger } from '@/ui/logger';

/**
 * MiniMax Code's runtime index.
 *
 * The agent keeps its session catalog, its queues and its turn leases in one
 * SQLite file under the agent's data directory. HAPI already reads that file
 * to find a session's directory on disk, so the same handle serves the other
 * readers as well.
 *
 * The file is written by the agent while it runs, in WAL mode. A read-only
 * connection sees the committed state as long as the write-ahead log file is
 * next to it, which it is while the agent is alive.
 */

export const MCODE_RUNTIME_INDEX_RELATIVE_PATH = ['v2', 'sqlite', 'runtime-state.sqlite'];

export type SqliteStatement = {
    get(...params: unknown[]): unknown;
};

export type SqliteDatabase = {
    query(sql: string): SqliteStatement;
    close(): void;
};

/**
 * Open runtime index handles, one per data directory. The handle is kept for
 * the lifetime of the process: the index is read on every attempt and
 * re-opening the database each time costs more than the query itself.
 */
const indexDatabases = new Map<string, SqliteDatabase>();

export async function openMcodeRuntimeIndex(databasePath: string): Promise<SqliteDatabase | null> {
    const cached = indexDatabases.get(databasePath);
    if (cached) return cached;
    try {
        const { Database } = await import('bun:sqlite');
        const database = new Database(databasePath, { readonly: true }) as unknown as SqliteDatabase;
        indexDatabases.set(databasePath, database);
        return database;
    } catch (error) {
        // A missing, locked, or unreadable index is not fatal: the readers
        // degrade to "no entry". The failure is not cached so an index that
        // appears later is still picked up.
        logger.debug(`[mcode-runtime-index] Runtime index unavailable at ${databasePath}`, error);
        return null;
    }
}
