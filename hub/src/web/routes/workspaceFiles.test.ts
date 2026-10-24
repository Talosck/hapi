import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createWorkspaceFileRoutes } from './workspaceFiles'

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createWorkspaceFileRoutes(() => engine as SyncEngine))
    return app
}

function activeSession(): Session {
    return { id: 'session-1', namespace: 'default', active: true } as unknown as Session
}

describe('workspace file route', () => {
    it('forwards the delete to the session CLI', async () => {
        const calls: Array<{ method: string; args: unknown[] }> = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() }),
            deleteWorkspaceFile: async (...args: unknown[]) => {
                calls.push({ method: 'delete', args })
                return { success: true, path: 'notes/a.txt', directory: false }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'notes/a.txt' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, path: 'notes/a.txt', directory: false })
        expect(calls).toEqual([{ method: 'delete', args: ['session-1', 'notes/a.txt'] }])
    })

    it('rejects a body without a path', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: '' })
        })

        expect(response.status).toBe(400)
    })

    it('refuses a delete for an inactive session', async () => {
        const engine = {
            resolveSessionAccess: () => ({
                ok: true as const,
                sessionId: 'session-1',
                session: { id: 'session-1', namespace: 'default', active: false } as unknown as Session
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'notes/a.txt' })
        })

        expect(response.status).toBe(409)
    })

    it('reports a CLI failure without pretending the file is gone', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() }),
            deleteWorkspaceFile: async () => {
                throw new Error('CLI offline')
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'notes/a.txt' })
        })

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ success: false, error: 'CLI offline' })
    })

    it('passes a refusal of the CLI through to the client', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() }),
            deleteWorkspaceFile: async () => ({ success: false, error: 'File not found' })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'gone.txt' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: false, error: 'File not found' })
    })
})
