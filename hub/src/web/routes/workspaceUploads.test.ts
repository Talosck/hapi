import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createWorkspaceUploadRoutes, WORKSPACE_UPLOAD_BODY_LIMIT_BYTES } from './workspaceUploads'

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createWorkspaceUploadRoutes(() => engine as SyncEngine))
    return app
}

function activeSession(): Session {
    return { id: 'session-1', namespace: 'default', active: true } as unknown as Session
}

describe('workspace upload route', () => {
    it('forwards the upload steps to the session CLI', async () => {
        const calls: Array<{ method: string; args: unknown[] }> = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() }),
            startWorkspaceUpload: async (...args: unknown[]) => {
                calls.push({ method: 'start', args })
                return { success: true, uploadId: 'upload-1' }
            },
            appendWorkspaceUpload: async (...args: unknown[]) => {
                calls.push({ method: 'chunk', args })
                return { success: true, received: 3 }
            },
            finishWorkspaceUpload: async (...args: unknown[]) => {
                calls.push({ method: 'finish', args })
                return { success: true, path: 'notes/a.txt', size: 3, replaced: false }
            },
            abortWorkspaceUpload: async (...args: unknown[]) => {
                calls.push({ method: 'abort', args })
                return { success: true }
            }
        } as unknown as Partial<SyncEngine>

        const app = buildApp(engine)

        const start = await app.request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'start', path: 'notes/a.txt', size: 3, overwrite: true })
        })
        expect(start.status).toBe(200)
        expect(await start.json()).toEqual({ success: true, uploadId: 'upload-1' })

        const chunk = await app.request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'chunk', uploadId: 'upload-1', offset: 0, content: 'YWJj' })
        })
        expect(chunk.status).toBe(200)

        const finish = await app.request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'finish', uploadId: 'upload-1' })
        })
        expect(finish.status).toBe(200)

        const abort = await app.request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'abort', uploadId: 'upload-1' })
        })
        expect(abort.status).toBe(200)

        expect(calls.map((call) => call.method)).toEqual(['start', 'chunk', 'finish', 'abort'])
        expect(calls[0].args[0]).toBe('session-1')
        expect(calls[0].args[1]).toEqual({ path: 'notes/a.txt', size: 3, overwrite: true })
        expect(calls[1].args[1]).toEqual({ uploadId: 'upload-1', offset: 0, content: 'YWJj' })
    })

    it('rejects a body that is not a known upload action', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'explode' })
        })

        expect(response.status).toBe(400)
    })

    it('rejects an oversized chunk body', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'chunk', uploadId: 'upload-1', offset: 0, content: 'x'.repeat(WORKSPACE_UPLOAD_BODY_LIMIT_BYTES) })
        })

        expect(response.status).toBe(413)
    })

    it('refuses an upload for an inactive session', async () => {
        const engine = {
            resolveSessionAccess: () => ({
                ok: true as const,
                sessionId: 'session-1',
                session: { id: 'session-1', namespace: 'default', active: false } as unknown as Session
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'start', path: 'a.txt', size: 1 })
        })

        expect(response.status).toBe(409)
    })

    it('reports a CLI failure without pretending the file landed', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session: activeSession() }),
            startWorkspaceUpload: async () => {
                throw new Error('CLI offline')
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/workspace/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'start', path: 'a.txt', size: 1 })
        })

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ success: false, error: 'CLI offline' })
    })
})
