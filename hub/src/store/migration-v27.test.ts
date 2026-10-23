import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('schema migration v26 to v27', () => {
    it('adds the stream key column and its index', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_stream_key;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const version = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const columns = (internalDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
            .map((row) => row.name)
        const plan = internalDb.prepare(`
            EXPLAIN QUERY PLAN
            SELECT id FROM messages
            WHERE session_id = ?
              AND stream_key = ?
        `).all('session-id', 'reasoning:stream-1') as Array<{ detail: string }>

        expect(version.user_version).toBe(27)
        expect(columns).toContain('stream_key')
        expect(plan.some((row) => row.detail.includes('idx_messages_stream_key'))).toBe(true)
        migrated.close()
    })

    it('keeps existing messages when it runs', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-messages-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX idx_messages_stream_key;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        internalDb.prepare(`
            INSERT INTO sessions (id, namespace, created_at, updated_at)
            VALUES ('session-1', 'default', 1, 1)
        `).run()
        internalDb.prepare(`
            INSERT INTO messages (id, session_id, content, created_at, seq, delivery_state)
            VALUES ('message-1', 'session-1', '{"role":"user","content":{"type":"text","text":"hi"}}', 1, 1, 'queued')
        `).run()
        const migratedVersion = internalDb.prepare('PRAGMA user_version').get() as { user_version: number }
        const rows = internalDb.prepare('SELECT id, stream_key FROM messages').all() as Array<{ id: string; stream_key: string | null }>
        migrated.close()

        expect(migratedVersion.user_version).toBe(27)
        expect(rows).toEqual([{ id: 'message-1', stream_key: null }])
    })

    it('leaves the database integrity intact', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v26-integrity-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        new Store(dbPath).close()
        const legacy = new Database(dbPath)
        legacy.exec('PRAGMA user_version = 26')
        legacy.close()

        const migrated = new Store(dbPath)
        const internalDb = (migrated as unknown as { db: Database }).db
        const integrity = internalDb.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
        migrated.close()

        expect(integrity).toEqual([{ integrity_check: 'ok' }])
    })
})
