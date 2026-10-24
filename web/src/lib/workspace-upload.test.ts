import { describe, expect, it, vi } from 'vitest'
import {
    collectUploadEntries,
    joinWorkspacePath,
    readBlobAsBase64,
    sanitizeUploadPath,
    uploadWorkspaceFile,
    uploadWorkspaceFiles,
    WorkspaceUploadCancelledError,
} from './workspace-upload'

// Small chunks keep the chunking test fast; the real size is 4 MB.
vi.mock('@hapi/protocol/apiTypes', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@hapi/protocol/apiTypes')>()
    return { ...actual, WORKSPACE_UPLOAD_CHUNK_BYTES: 4 }
})

function makeFile(content: string, name: string, relativePath?: string): File {
    const file = new File([content], name)
    if (relativePath !== undefined) {
        Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
    }
    return file
}

function createApi(overrides: Record<string, unknown> = {}) {
    const api = {
        startWorkspaceUpload: vi.fn(async () => ({ success: true, uploadId: 'upload-1' })),
        appendWorkspaceUpload: vi.fn(async () => ({ success: true, received: 0 })),
        finishWorkspaceUpload: vi.fn(async () => ({ success: true, path: 'a.txt', size: 5, replaced: false })),
        abortWorkspaceUpload: vi.fn(async () => ({ success: true })),
        ...overrides
    }
    return api as never as Parameters<typeof uploadWorkspaceFile>[0]
}

describe('sanitizeUploadPath', () => {
    it('keeps a plain relative path', () => {
        expect(sanitizeUploadPath('notes/todo.md')).toBe('notes/todo.md')
    })

    it('normalizes separators and drops redundant segments', () => {
        expect(sanitizeUploadPath('notes\\todo.md')).toBe('notes/todo.md')
        expect(sanitizeUploadPath('./notes//todo.md')).toBe('notes/todo.md')
    })

    it('rejects paths that leave the target directory', () => {
        expect(sanitizeUploadPath('../outside.txt')).toBeNull()
        expect(sanitizeUploadPath('notes/../../outside.txt')).toBeNull()
    })

    it('rejects absolute paths', () => {
        expect(sanitizeUploadPath('/etc/passwd')).toBeNull()
        expect(sanitizeUploadPath('C:\\Windows\\system32')).toBeNull()
    })

    it('rejects an empty path', () => {
        expect(sanitizeUploadPath('   ')).toBeNull()
        expect(sanitizeUploadPath('./')).toBeNull()
    })
})

describe('joinWorkspacePath', () => {
    it('joins a directory with a relative path', () => {
        expect(joinWorkspacePath('src', 'a.txt')).toBe('src/a.txt')
        expect(joinWorkspacePath('', 'a.txt')).toBe('a.txt')
        expect(joinWorkspacePath(undefined, 'nested/a.txt')).toBe('nested/a.txt')
    })

    it('normalizes the directory separators', () => {
        expect(joinWorkspacePath('/src/', 'a.txt')).toBe('src/a.txt')
    })
})

describe('collectUploadEntries', () => {
    it('keeps the folder structure of a folder pick', () => {
        const entries = collectUploadEntries([
            makeFile('a', 'a.txt', 'myfolder/a.txt'),
            makeFile('b', 'b.txt', 'myfolder/sub/b.txt')
        ])

        expect(entries.map((entry) => entry.relativePath)).toEqual([
            'myfolder/a.txt',
            'myfolder/sub/b.txt'
        ])
    })

    it('uses the file name for a plain file pick', () => {
        const entries = collectUploadEntries([makeFile('a', 'a.txt')])

        expect(entries.map((entry) => entry.relativePath)).toEqual(['a.txt'])
    })

    it('drops a file whose path tries to escape the target', () => {
        const entries = collectUploadEntries([makeFile('a', 'a.txt', '../a.txt')])

        expect(entries).toEqual([])
    })
})

describe('readBlobAsBase64', () => {
    it('encodes the bytes of a blob', async () => {
        const blob = new Blob([new Uint8Array([0, 1, 2, 250, 255])])

        expect(await readBlobAsBase64(blob)).toBe(btoa(String.fromCharCode(0, 1, 2, 250, 255)))
    })
})

describe('uploadWorkspaceFile', () => {
    it('opens, streams and closes an upload', async () => {
        const api = createApi({
            appendWorkspaceUpload: vi.fn(async () => ({ success: true, received: 4 })),
            finishWorkspaceUpload: vi.fn(async () => ({ success: true, path: 'notes/a.txt', size: 4, replaced: false }))
        })

        const result = await uploadWorkspaceFile(api, 'session-1', {
            relativePath: 'a.txt',
            file: makeFile('hell', 'a.txt')
        }, { targetDirectory: 'notes' })

        expect(result).toEqual({ path: 'notes/a.txt', size: 4, replaced: false })
        expect(api.startWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            path: 'notes/a.txt',
            size: 4,
            overwrite: false
        }, undefined)
        expect(api.appendWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            uploadId: 'upload-1',
            offset: 0,
            content: btoa('hell')
        }, undefined)
        expect(api.finishWorkspaceUpload).toHaveBeenCalledWith('session-1', 'upload-1')
        expect(api.abortWorkspaceUpload).not.toHaveBeenCalled()
    })

    it('splits a large file into chunks', async () => {
        const api = createApi()
        const file = new File([new Uint8Array(9)], 'big.bin')

        await uploadWorkspaceFile(api, 'session-1', { relativePath: 'big.bin', file })

        const calls = (api.appendWorkspaceUpload as unknown as { mock: { calls: Array<[string, { offset: number; content: string }]> } }).mock.calls
        expect(calls.map((call) => call[1].offset)).toEqual([0, 4, 8])
        expect(calls.map((call) => call[1].content.length)).toEqual([8, 8, 4])
    })

    it('uploads an empty file without sending a chunk', async () => {
        const api = createApi()

        await uploadWorkspaceFile(api, 'session-1', { relativePath: 'empty.txt', file: makeFile('', 'empty.txt') })

        expect(api.appendWorkspaceUpload).not.toHaveBeenCalled()
        expect(api.finishWorkspaceUpload).toHaveBeenCalled()
    })

    it('drops the partial file when a chunk fails', async () => {
        const api = createApi({
            appendWorkspaceUpload: vi.fn(async () => ({ success: false, error: 'Chunk too large' }))
        })

        await expect(uploadWorkspaceFile(api, 'session-1', {
            relativePath: 'a.txt',
            file: makeFile('hello', 'a.txt')
        })).rejects.toThrow('Chunk too large')
        expect(api.abortWorkspaceUpload).toHaveBeenCalledWith('session-1', 'upload-1')
        expect(api.finishWorkspaceUpload).not.toHaveBeenCalled()
    })

    it('refuses a file that is too large before sending a chunk', async () => {
        const api = createApi()
        const file = { name: 'big.bin', size: 600 * 1024 * 1024, slice: () => new Blob([]) } as unknown as File

        await expect(uploadWorkspaceFile(api, 'session-1', { relativePath: 'big.bin', file }))
            .rejects.toThrow('too large')
        expect(api.startWorkspaceUpload).not.toHaveBeenCalled()
    })

    it('reports a failed start without streaming anything', async () => {
        const api = createApi({
            startWorkspaceUpload: vi.fn(async () => ({ success: false, error: 'File already exists' }))
        })

        await expect(uploadWorkspaceFile(api, 'session-1', {
            relativePath: 'a.txt',
            file: makeFile('hello', 'a.txt')
        })).rejects.toThrow('File already exists')
        expect(api.appendWorkspaceUpload).not.toHaveBeenCalled()
    })

    it('stops when the upload is cancelled', async () => {
        const api = createApi()
        const controller = new AbortController()
        controller.abort()

        await expect(uploadWorkspaceFile(api, 'session-1', {
            relativePath: 'a.txt',
            file: makeFile('hello', 'a.txt')
        }, { signal: controller.signal })).rejects.toBeInstanceOf(WorkspaceUploadCancelledError)
        expect(api.startWorkspaceUpload).not.toHaveBeenCalled()
    })
})

describe('uploadWorkspaceFiles', () => {
    it('uploads every file and reports the replaced ones', async () => {
        let upload = 0
        const api = createApi({
            startWorkspaceUpload: vi.fn(async () => {
                upload += 1
                return { success: true, uploadId: `upload-${upload}` }
            }),
            finishWorkspaceUpload: vi.fn(async (_sessionId: string, uploadId: string) => ({
                success: true,
                path: uploadId === 'upload-1' ? 'a.txt' : 'b.txt',
                size: 1,
                replaced: uploadId === 'upload-2'
            }))
        })

        const summary = await uploadWorkspaceFiles(api, 'session-1', [
            { relativePath: 'a.txt', file: makeFile('a', 'a.txt') },
            { relativePath: 'b.txt', file: makeFile('b', 'b.txt') }
        ])

        expect(summary.uploaded).toHaveLength(2)
        expect(summary.failed).toEqual([])
        expect(summary.replaced).toBe(1)
    })

    it('keeps going when one file fails', async () => {
        let call = 0
        const api = createApi({
            startWorkspaceUpload: vi.fn(async () => {
                call += 1
                return call === 1
                    ? { success: false, error: 'File already exists' }
                    : { success: true, uploadId: 'upload-2' }
            })
        })

        const summary = await uploadWorkspaceFiles(api, 'session-1', [
            { relativePath: 'a.txt', file: makeFile('a', 'a.txt') },
            { relativePath: 'b.txt', file: makeFile('b', 'b.txt') }
        ])

        expect(summary.uploaded).toHaveLength(1)
        expect(summary.failed).toEqual([{ path: 'a.txt', error: 'File already exists' }])
    })

    it('reports the batch progress', async () => {
        const api = createApi()
        const onBatchProgress = vi.fn()

        await uploadWorkspaceFiles(api, 'session-1', [
            { relativePath: 'a.txt', file: makeFile('a', 'a.txt') },
            { relativePath: 'b.txt', file: makeFile('b', 'b.txt') }
        ], { onBatchProgress })

        expect(onBatchProgress).toHaveBeenNthCalledWith(1, 1, 2)
        expect(onBatchProgress).toHaveBeenNthCalledWith(2, 2, 2)
    })
})
