import { describe, expect, it } from 'vitest';
import { readMcodeTurnLeaseFromDatabase, type McodeLeaseQuery } from './mcodeTurnLease';

function databaseWith(row: unknown | undefined, throws = false): McodeLeaseQuery {
    return {
        query: () => ({
            get: () => {
                if (throws) throw new Error('no such table: local_runtime_session_locks');
                return row;
            }
        })
    };
}

describe('readMcodeTurnLeaseFromDatabase', () => {
    it('reads a held lease with its holder and its age', () => {
        const state = readMcodeTurnLeaseFromDatabase(
            databaseWith({
                owner_id: 'turn-lease:17826:cd08c161-4c0d-4f53-8823-2814223f43ee.3a2ee0d3',
                owner_kind: 'turn',
                acquired_at_ms: 1792650918661,
                expires_at_ms: 1792654038974
            }),
            'mvs_06f452e77bd7475182e6ec512377484e'
        );

        expect(state).toEqual({
            status: 'held',
            lease: {
                ownerId: 'turn-lease:17826:cd08c161-4c0d-4f53-8823-2814223f43ee.3a2ee0d3',
                ownerKind: 'turn',
                acquiredAtMs: 1792650918661,
                expiresAtMs: 1792654038974
            }
        });
    });

    it('reads a session without a lease as free', () => {
        // No row at all: nobody holds the session, so a turn can be sent.
        expect(readMcodeTurnLeaseFromDatabase(databaseWith(undefined), 'mvs_free')).toEqual({
            status: 'free'
        });
    });

    it('reads a row it cannot interpret as unknown, not as free', () => {
        // A lease the reader cannot read must not be mistaken for a free
        // session: that would fire a turn into a session that is busy.
        expect(
            readMcodeTurnLeaseFromDatabase(
                databaseWith({ owner_id: '', owner_kind: 'turn', acquired_at_ms: 1, expires_at_ms: 2 }),
                'mvs_broken'
            )
        ).toEqual({ status: 'unknown' });
    });

    it('reads a missing lock table as unknown', () => {
        // An agent whose runtime index has no lock table: the lease state is
        // unknown, and an unknown lease never blocks a turn.
        expect(readMcodeTurnLeaseFromDatabase(databaseWith(undefined, true), 'mvs_old')).toEqual({
            status: 'unknown'
        });
    });
});
