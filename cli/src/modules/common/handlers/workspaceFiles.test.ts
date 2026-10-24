import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerWorkspaceFileHandlers } from './workspaceFiles'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

type DeleteResponse = { success: boolean; path?: string; directory?: boolean; error?: string }

describe('workspace file RPC handlers', () => {
    let rootDir: string
    let outsideDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-workspace-delete')
        outsideDir = await createTempDir('hapi-workspace-delete-outside')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerWorkspaceFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
        await rm(outsideDir, { recursive: true, force: true })
    })

    async function call(params: unknown): Promise<DeleteResponse> {
        const response = await rpc.handleRequest({
            method: 'session-test:deleteWorkspaceFile',
            params: JSON.stringify(params)
        })
        return JSON.parse(response) as DeleteResponse
    }

    it('deletes a file of the working directory', async () => {
        await writeFile(join(rootDir, 'notes.txt'), 'hello')

        const result = await call({ path: 'notes.txt' })

        expect(result.success).toBe(true)
        expect(result.path).toBe('notes.txt')
        expect(result.directory).toBe(false)
        expect(await readdir(rootDir)).toEqual([])
    })

    it('deletes a file of a subdirectory', async () => {
        await mkdir(join(rootDir, 'src'), { recursive: true })
        await writeFile(join(rootDir, 'src/app.ts'), 'export const app = 1')

        const result = await call({ path: 'src/app.ts' })

        expect(result.success).toBe(true)
        expect(await readdir(join(rootDir, 'src'))).toEqual([])
    })

    it('deletes a directory with its content', async () => {
        await mkdir(join(rootDir, 'build/nested'), { recursive: true })
        await writeFile(join(rootDir, 'build/one.txt'), 'one')
        await writeFile(join(rootDir, 'build/nested/two.txt'), 'two')

        const result = await call({ path: 'build' })

        expect(result.success).toBe(true)
        expect(result.directory).toBe(true)
        expect(await readdir(rootDir)).toEqual([])
    })

    it('refuses a path outside of the working directory', async () => {
        await writeFile(join(outsideDir, 'secret.txt'), 'secret')

        const result = await call({ path: `../${join(outsideDir, 'secret.txt')}` })

        expect(result.success).toBe(false)
        expect(result.error).toContain('outside the working directory')
        expect(await readFile(join(outsideDir, 'secret.txt'), 'utf8')).toBe('secret')
    })

    it('refuses an absolute path', async () => {
        const result = await call({ path: join(outsideDir, 'secret.txt') })

        expect(result.success).toBe(false)
        expect(result.error).toContain('relative')
    })

    it('refuses to delete the workspace root', async () => {
        const result = await call({ path: '.' })

        expect(result.success).toBe(false)
        expect(result.error).toContain('workspace root')
        expect(await readdir(rootDir)).toEqual([])
    })

    it('refuses to delete through a symlinked directory that points outside', async () => {
        await symlink(outsideDir, join(rootDir, 'escape'))
        await writeFile(join(outsideDir, 'secret.txt'), 'secret')

        const result = await call({ path: 'escape/secret.txt' })

        expect(result.success).toBe(false)
        expect(result.error).toContain('outside the working directory')
        expect(await readFile(join(outsideDir, 'secret.txt'), 'utf8')).toBe('secret')
    })

    it('unlinks a symlink without touching the file it points at', async () => {
        await writeFile(join(outsideDir, 'target.txt'), 'keep me')
        await symlink(join(outsideDir, 'target.txt'), join(rootDir, 'link.txt'))

        const result = await call({ path: 'link.txt' })

        expect(result.success).toBe(true)
        expect(await readdir(rootDir)).toEqual([])
        expect(await readFile(join(outsideDir, 'target.txt'), 'utf8')).toBe('keep me')
    })

    it('reports a missing file instead of pretending it is gone', async () => {
        const result = await call({ path: 'nothing-here.txt' })

        expect(result.success).toBe(false)
        expect(result.error).toBe('File not found')
    })

    it('requires a path', async () => {
        const result = await call({ path: '   ' })

        expect(result.success).toBe(false)
        expect(result.error).toBe('Path is required')
    })
})
