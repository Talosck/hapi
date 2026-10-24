import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { WORKSPACE_UPLOAD_CHUNK_BYTES } from '@hapi/protocol/apiTypes'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

/**
 * Body limit for one upload request.
 *
 * A chunk is base64 encoded on the way, which inflates it by ~4/3. The limit
 * is derived from the chunk size so the two can never drift apart.
 */
export const WORKSPACE_UPLOAD_BODY_LIMIT_BYTES = Math.ceil(WORKSPACE_UPLOAD_CHUNK_BYTES / 3) * 4 + 64 * 1024

const startSchema = z.object({
    action: z.literal('start'),
    path: z.string().min(1),
    size: z.number().int().min(0).optional(),
    overwrite: z.boolean().optional()
})

const chunkSchema = z.object({
    action: z.literal('chunk'),
    uploadId: z.string().min(1),
    offset: z.number().int().min(0),
    content: z.string().min(1)
})

const finishSchema = z.object({
    action: z.literal('finish'),
    uploadId: z.string().min(1)
})

const abortSchema = z.object({
    action: z.literal('abort'),
    uploadId: z.string().min(1)
})

const uploadRequestSchema = z.discriminatedUnion('action', [
    startSchema,
    chunkSchema,
    finishSchema,
    abortSchema
])

function errorResponse(error: unknown, fallback: string): { success: false; error: string } {
    return {
        success: false,
        error: error instanceof Error ? error.message : fallback
    }
}

/**
 * Workspace upload endpoints.
 *
 * The hub is a relay here: the file lands on the machine that runs the
 * session, so every call is forwarded to that session's CLI over the RPC
 * channel. The CLI owns the path validation - it knows the working directory
 * and rejects anything outside of it.
 */
export function createWorkspaceUploadRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/workspace/upload', bodyLimit({
        maxSize: WORKSPACE_UPLOAD_BODY_LIMIT_BYTES,
        onError: (c) => c.json({ success: false, error: 'Upload chunk too large' }, 413)
    }), async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const raw = await c.req.text().catch(() => null)
        if (raw === null || raw.length > WORKSPACE_UPLOAD_BODY_LIMIT_BYTES) {
            // The body was cut off by the size limit (the middleware only sees
            // a content-length when the client sent one).
            return c.json({ success: false, error: 'Upload chunk too large' }, 413)
        }

        let body: unknown
        try {
            body = JSON.parse(raw)
        } catch {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        const parsed = uploadRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        const request = parsed.data
        const sessionId = sessionResult.sessionId

        try {
            switch (request.action) {
                case 'start': {
                    const result = await engine.startWorkspaceUpload(sessionId, {
                        path: request.path,
                        size: request.size,
                        overwrite: request.overwrite === true
                    })
                    return c.json(result)
                }
                case 'chunk': {
                    const result = await engine.appendWorkspaceUpload(sessionId, {
                        uploadId: request.uploadId,
                        offset: request.offset,
                        content: request.content
                    })
                    return c.json(result)
                }
                case 'finish': {
                    const result = await engine.finishWorkspaceUpload(sessionId, request.uploadId)
                    return c.json(result)
                }
                case 'abort': {
                    const result = await engine.abortWorkspaceUpload(sessionId, request.uploadId)
                    return c.json(result)
                }
            }
        } catch (error) {
            return c.json(errorResponse(error, 'Failed to upload file'), 500)
        }
    })

    return app
}
