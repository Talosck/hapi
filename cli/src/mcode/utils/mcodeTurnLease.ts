import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { getMcodeDataDir } from './mcodeSessionDirs';
import { MCODE_RUNTIME_INDEX_RELATIVE_PATH, openMcodeRuntimeIndex } from './mcodeRuntimeIndex';

/**
 * The agent's turn lease.
 *
 * MiniMax Code gives every native session exactly one turn lease, and a turn
 * holds it for its whole duration. A `session/prompt` that arrives while the
 * lease is held is refused ("Session already has an active Turn. Use queue
 * send to deliver the message after it.").
 *
 * The runtime takes that lease for turns HAPI did not start. The common case
 * is the delivery of a finished background task: the agent's own subagent
 * ends, and the runtime steers a turn into the owner session to report it.
 * That turn holds the lease for as long as it runs, and a user message that
 * arrives in that window is refused.
 *
 * The lease lives in the agent's runtime index, next to the session catalog
 * HAPI already reads. It is the only place that says which turn currently
 * owns the session - the agent's ACP surface has no busy getter, and the
 * lease is what the agent itself consults before it admits a turn.
 */

/** Who holds the lease and since when. */
export type McodeTurnLease = {
    /** `turn-lease:<pid>:<uuid>.<uuid>` - the holder's process and turn. */
    ownerId: string;
    /** `turn` for a normal turn; other kinds exist for the agent's own work. */
    ownerKind: string;
    acquiredAtMs: number;
    expiresAtMs: number;
};

/**
 * The lease state of a session.
 *
 * `unknown` is not the same as `free`: it means the index could not be read
 * (an older agent without the table, a locked file, a different data
 * directory), and the caller must not treat it as "the agent is busy".
 */
export type McodeTurnLeaseState =
    | { status: 'free' }
    | { status: 'held'; lease: McodeTurnLease }
    | { status: 'unknown' };

const LEASE_QUERY = 'SELECT owner_id, owner_kind, acquired_at_ms, expires_at_ms FROM local_runtime_session_locks WHERE session_id = ?';

/** The part of a SQLite handle the lease reader needs. */
export type McodeLeaseQuery = {
    query(sql: string): { get(...params: unknown[]): unknown };
};

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The process that holds a lease, read out of its owner id.
 *
 * The agent writes `turn-lease:<pid>:<uuid>.<uuid>`, and the pid is the
 * agent process. The agent itself reclaims a lease whose owner is gone by
 * asking whether that process is alive, and HAPI can ask the same question.
 */
export function parseMcodeLeaseOwnerPid(ownerId: string): number | null {
    const match = /^turn-lease:(\d+):/.exec(ownerId);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether the process that holds the lease is still running.
 *
 * A lease whose owner died is a leftover: nobody will ever release it, and a
 * session that waits for it waits forever.
 */
export function isMcodeLeaseOwnerAlive(ownerId: string): boolean {
    const pid = parseMcodeLeaseOwnerPid(ownerId);
    if (pid === null) return true;
    try {
        // Signal 0 tests for the process without touching it.
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process is there but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Reads the turn lease of a session from an open runtime index.
 *
 * Split out from the file access so the reading rules can be tested without
 * a database.
 *
 * A lease that has expired, or whose owner is no longer running, is not a
 * lease: the agent reclaims both itself, and a leftover row would keep the
 * message waiting for a turn that will never end.
 */
export function readMcodeTurnLeaseFromDatabase(
    database: McodeLeaseQuery,
    sessionId: string,
    nowMs: number = Date.now()
): McodeTurnLeaseState {
    try {
        const row = database.query(LEASE_QUERY).get(sessionId) as
            | Record<string, unknown>
            | null
            | undefined;
        if (!row) return { status: 'free' };

        const ownerId = typeof row.owner_id === 'string' ? row.owner_id : '';
        const ownerKind = typeof row.owner_kind === 'string' ? row.owner_kind : '';
        const acquiredAtMs = readNumber(row.acquired_at_ms);
        const expiresAtMs = readNumber(row.expires_at_ms);
        // A row that does not carry the fields the reader needs is a row the
        // reader cannot interpret: treating it as "no lease" would fire a turn
        // into a session that is busy.
        if (!ownerId || !ownerKind || acquiredAtMs === null || expiresAtMs === null) {
            return { status: 'unknown' };
        }
        if (expiresAtMs <= nowMs || !isMcodeLeaseOwnerAlive(ownerId)) {
            // The lease is over: it expired, or the agent that held it is
            // gone and nobody will ever release it.
            return { status: 'free' };
        }
        return {
            status: 'held',
            lease: { ownerId, ownerKind, acquiredAtMs, expiresAtMs }
        };
    } catch (error) {
        // The table does not exist in this agent version, or the schema
        // changed: the lease is unknown, and an unknown lease never blocks a
        // turn.
        logger.debug(`[mcode-turn-lease] Lease lookup failed for ${sessionId}`, error);
        return { status: 'unknown' };
    }
}

/**
 * Reads the turn lease of a native session.
 *
 * The session id is the agent's own session id (`mvs_...`), the same one the
 * ACP `session/new` response hands out and the same one the lease table is
 * keyed by.
 */
export async function readMcodeTurnLease(
    sessionId: string,
    dataDir: string = getMcodeDataDir()
): Promise<McodeTurnLeaseState> {
    if (!sessionId) return { status: 'unknown' };

    const databasePath = join(dataDir, ...MCODE_RUNTIME_INDEX_RELATIVE_PATH);
    const database = await openMcodeRuntimeIndex(databasePath);
    if (!database) return { status: 'unknown' };

    return readMcodeTurnLeaseFromDatabase(database, sessionId);
}
