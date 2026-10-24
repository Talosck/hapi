import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerWorkspaceUploadHandlers } from './workspaceUploads'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

type StartResponse = { success: boolean; uploadId?: string; error?: string }
type ChunkResponse = { success: boolean; received?: number; error?: string }
type FinishResponse = { success: boolean; path?: string; size?: number; replaced?: boolean; error?: string }

describe('workspace upload RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-workspace-upload')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerWorkspaceUploadHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    async function call<T>(method: string, params: unknown): Promise<T> {
        const response = await rpc.handleRequest({
            method: `session-test:${method}`,
            params: JSON.stringify(params)
        })
        return JSON.parse(response) as T
    }

    async function uploadFile(relativePath: string, content: string, options?: { overwrite?: boolean; declaredSize?: number }) {
        const start = await call<StartResponse>('startWorkspaceUpload', {
            path: relativePath,
            size: options?.declaredSize ?? Buffer.byteLength(content),
            overwrite: options?.overwrite ?? false
        })
        expect(start.success).toBe(true)
        expect(start.uploadId).toBeTruthy()

        const buffer = Buffer.from(content)
        const chunk = await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: buffer.toString('base64')
        })
        expect(chunk.success).toBe(true)

        const finish = await call<FinishResponse>('finishWorkspaceUpload', { uploadId: start.uploadId })
        return { start, chunk, finish }
    }

    it('writes an uploaded file into the working directory', async () => {
        const { finish } = await uploadFile('notes/hello.txt', 'hello world')

        expect(finish.success).toBe(true)
        expect(finish.path).toBe('notes/hello.txt')
        expect(finish.size).toBe(11)
        expect(await readFile(join(rootDir, 'notes/hello.txt'), 'utf8')).toBe('hello world')
    })

    it('creates the parent directory of an uploaded file', async () => {
        await uploadFile('nested/deep/file.bin', 'payload')

        const entries = await readdir(join(rootDir, 'nested/deep'))
        expect(entries).toEqual(['file.bin'])
    })

    it('leaves no temporary file behind after a finished upload', async () => {
        await uploadFile('clean.txt', 'payload')

        const entries = await readdir(rootDir)
        expect(entries).toEqual(['clean.txt'])
    })

    it('rejects a path outside the working directory', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: '../escape.txt', size: 1 })

        expect(start.success).toBe(false)
        expect(start.error).toContain('outside the working directory')
    })

    it('rejects a symlinked directory that points outside the working directory', async () => {
        const outside = await createTempDir('hapi-workspace-upload-outside')
        try {
            await symlink(outside, join(rootDir, 'link'))

            const start = await call<StartResponse>('startWorkspaceUpload', { path: 'link/escape.txt', size: 1 })

            expect(start.success).toBe(false)
            expect(start.error).toContain('outside the working directory')
            expect(await readdir(outside)).toEqual([])
        } finally {
            await rm(outside, { recursive: true, force: true })
        }
    })

    it('rejects an absolute path', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: '/etc/passwd', size: 1 })

        expect(start.success).toBe(false)
        expect(start.error).toContain('relative')
    })

    it('refuses to overwrite an existing file unless overwrite is requested', async () => {
        await writeFile(join(rootDir, 'existing.txt'), 'old')

        const refused = await call<StartResponse>('startWorkspaceUpload', { path: 'existing.txt', size: 3 })
        expect(refused.success).toBe(false)
        expect(refused.error).toBe('File already exists')

        const { finish } = await uploadFile('existing.txt', 'new', { overwrite: true })
        expect(finish.success).toBe(true)
        expect(finish.replaced).toBe(true)
        expect(await readFile(join(rootDir, 'existing.txt'), 'utf8')).toBe('new')
    })

    it('keeps the old file until the new one is in place', async () => {
        await writeFile(join(rootDir, 'existing.txt'), 'old')

        const start = await call<StartResponse>('startWorkspaceUpload', {
            path: 'existing.txt',
            size: 3,
            overwrite: true
        })
        expect(start.success).toBe(true)

        await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('new').toString('base64')
        })

        // The upload is not finished yet: the file the user had must still be
        // there, byte for byte.
        expect(await readFile(join(rootDir, 'existing.txt'), 'utf8')).toBe('old')

        const finish = await call<FinishResponse>('finishWorkspaceUpload', { uploadId: start.uploadId })
        expect(finish.success).toBe(true)
        expect(await readFile(join(rootDir, 'existing.txt'), 'utf8')).toBe('new')
    })

    it('rejects an upload whose target is an existing directory', async () => {
        await mkdir(join(rootDir, 'folder'), { recursive: true })

        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'folder', size: 1 })

        expect(start.success).toBe(false)
        expect(start.error).toContain('directory')
    })

    it('streams a file in several chunks', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'big.bin', size: 6 })
        expect(start.success).toBe(true)

        await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('abc').toString('base64')
        })
        const second = await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 3,
            content: Buffer.from('def').toString('base64')
        })
        expect(second.received).toBe(6)

        const finish = await call<FinishResponse>('finishWorkspaceUpload', { uploadId: start.uploadId })
        expect(finish.success).toBe(true)
        expect(await readFile(join(rootDir, 'big.bin'), 'utf8')).toBe('abcdef')
    })

    it('rejects a chunk that does not continue the previous one', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'offset.bin', size: 6 })
        expect(start.success).toBe(true)

        const chunk = await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 3,
            content: Buffer.from('abc').toString('base64')
        })

        expect(chunk.success).toBe(false)
        expect(chunk.error).toContain('offset')
    })

    it('refuses to finish an upload that is missing bytes', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'short.bin', size: 10 })
        expect(start.success).toBe(true)

        await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('abc').toString('base64')
        })

        const finish = await call<FinishResponse>('finishWorkspaceUpload', { uploadId: start.uploadId })
        expect(finish.success).toBe(false)
        expect(finish.error).toBe('Incomplete upload')
    })

    it('sweeps away a part file of an upload that never finished', async () => {
        const abandoned = join(rootDir, '.old.txt.hapi-upload-3f2504e0-4f89-11d3-9a0c-0305e82c3301.part')
        await writeFile(abandoned, 'partial')
        // The sweeper only takes files that are old enough to be abandoned.
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
        await utimes(abandoned, old, old)

        await uploadFile('fresh.txt', 'payload')

        expect(await readdir(rootDir)).toEqual(['fresh.txt'])
    })

    it('never sweeps a file of the user that only looks like a part file', async () => {
        const userFile = join(rootDir, 'backup.hapi-upload-final.tar')
        await writeFile(userFile, 'precious')
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
        await utimes(userFile, old, old)

        await uploadFile('fresh.txt', 'payload')

        expect(await readdir(rootDir)).toContain('backup.hapi-upload-final.tar')
        expect(await readFile(userFile, 'utf8')).toBe('precious')
    })

    it('never sweeps the part file of a running upload', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'slow.txt', size: 3 })
        expect(start.success).toBe(true)

        await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('abc').toString('base64')
        })

        // Make the part file look old: the sweep must still leave it alone.
        const partFile = (await readdir(rootDir)).find((name) => name.includes('.hapi-upload-'))
        expect(partFile).toBeTruthy()
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
        await utimes(join(rootDir, partFile as string), old, old)

        await uploadFile('other.txt', 'payload')

        expect(await readdir(rootDir)).toContain(partFile as string)
    })

    it('keeps a part file of a running upload', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'running.txt', size: 3 })
        expect(start.success).toBe(true)

        await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('abc').toString('base64')
        })

        const entries = await readdir(rootDir)
        expect(entries).toHaveLength(1)
        expect(entries[0]).toContain('.hapi-upload-')
    })

    it('refuses to open more uploads than a session may hold at once', async () => {
        for (let index = 0; index < 32; index += 1) {
            const start = await call<StartResponse>('startWorkspaceUpload', { path: `file-${index}.txt`, size: 1 })
            expect(start.success).toBe(true)
        }

        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'one-too-many.txt', size: 1 })

        expect(start.success).toBe(false)
        expect(start.error).toContain('Too many uploads')
    })

    it('drops the partial file when the upload is aborted', async () => {
        const start = await call<StartResponse>('startWorkspaceUpload', { path: 'aborted.bin', size: 3 })
        expect(start.success).toBe(true)

        await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('abc').toString('base64')
        })

        const abort = await call<{ success: boolean }>('abortWorkspaceUpload', { uploadId: start.uploadId })
        expect(abort.success).toBe(true)

        expect(await readdir(rootDir)).toEqual([])
    })

    it('does not accept chunks for an unknown upload', async () => {
        const chunk = await call<ChunkResponse>('appendWorkspaceUpload', {
            uploadId: 'does-not-exist',
            offset: 0,
            content: Buffer.from('abc').toString('base64')
        })

        expect(chunk.success).toBe(false)
        expect(chunk.error).toBe('Upload not found')
    })
})
