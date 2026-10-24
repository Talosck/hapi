import { MAX_WORKSPACE_UPLOAD_BYTES, WORKSPACE_UPLOAD_CHUNK_BYTES } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'

export { WORKSPACE_UPLOAD_CHUNK_BYTES }

/** One file that the user picked, with its path relative to the upload target. */
export type WorkspaceUploadEntry = {
    /** Path of the file inside the upload target directory. */
    relativePath: string
    file: File
}

export type WorkspaceUploadResult = {
    /** Workspace-relative path the file was written to. */
    path: string
    size: number
    /** True when an existing file was replaced. */
    replaced: boolean
}

export type WorkspaceUploadFailure = {
    path: string
    error: string
}

export type WorkspaceUploadSummary = {
    uploaded: WorkspaceUploadResult[]
    failed: WorkspaceUploadFailure[]
    /** Files that replaced an existing file. */
    replaced: number
    /** Bytes written. */
    bytes: number
}

export type WorkspaceUploadOptions = {
    /** Directory inside the session workspace the files land in. */
    targetDirectory?: string
    /** Replace a file that already exists at the target path. */
    overwrite?: boolean
    signal?: AbortSignal
    /** Called before every file with its path and size. */
    onFileStart?: (path: string, size: number) => void
    /** Called after every chunk with the bytes of the current file. */
    onFileProgress?: (uploadedBytes: number, totalBytes: number) => void
    /** Called after every finished file with the totals of the whole batch. */
    onBatchProgress?: (completed: number, total: number) => void
}

/** Thrown when the user cancels an upload. */
export class WorkspaceUploadCancelledError extends Error {
    constructor() {
        super('Upload cancelled')
        this.name = 'WorkspaceUploadCancelledError'
    }
}

/**
 * Normalize a path the client sends to the CLI.
 *
 * Returns `null` for paths that must not reach the workspace: absolute paths
 * and paths that walk out of the target directory.
 */
export function sanitizeUploadPath(path: string): string | null {
    const normalized = path.replaceAll('\\', '/').trim()
    if (!normalized) return null
    if (normalized.startsWith('/')) return null
    if (/^[A-Za-z]:\//.test(normalized)) return null

    const segments: string[] = []
    for (const segment of normalized.split('/')) {
        if (!segment || segment === '.') continue
        if (segment === '..') return null
        segments.push(segment)
    }
    if (segments.length === 0) return null
    return segments.join('/')
}

/** Join a directory inside the workspace with a relative path. */
export function joinWorkspacePath(directory: string | undefined, relativePath: string): string {
    const cleanDirectory = (directory ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
    const cleanRelative = relativePath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
    if (!cleanDirectory) return cleanRelative
    if (!cleanRelative) return cleanDirectory
    return `${cleanDirectory}/${cleanRelative}`
}

/**
 * Turn the files of a file picker into upload entries.
 *
 * A folder picker fills `webkitRelativePath` (`folder/sub/file.txt`), and the
 * folder itself is kept so the upload mirrors what the user picked. A plain
 * file picker leaves it empty, and the file name is used.
 */
export function collectUploadEntries(files: ArrayLike<File>): WorkspaceUploadEntry[] {
    const entries: WorkspaceUploadEntry[] = []
    for (const file of Array.from(files)) {
        const relative = file.webkitRelativePath?.trim() || file.name
        const sanitized = sanitizeUploadPath(relative)
        if (!sanitized) continue
        entries.push({ relativePath: sanitized, file })
    }
    return entries
}

/** Read a blob into an array buffer, with a fallback for browsers without `Blob.arrayBuffer`. */
async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
    if (typeof blob.arrayBuffer === 'function') {
        return await blob.arrayBuffer()
    }
    return await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
        reader.readAsArrayBuffer(blob)
    })
}

/** Read a blob as base64 without blowing the call stack on large blobs. */
export async function readBlobAsBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await readBlobBytes(blob))
    const blockSize = 0x8000
    let binary = ''
    for (let index = 0; index < bytes.length; index += blockSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + blockSize))
    }
    return btoa(binary)
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new WorkspaceUploadCancelledError()
    }
}

/**
 * Upload one file into the session workspace.
 *
 * The file is streamed in chunks: the CLI keeps the bytes in a temporary file
 * and only moves it to its final path once the last chunk arrived, so a failed
 * or cancelled upload never leaves a half-written file behind.
 */
export async function uploadWorkspaceFile(
    api: ApiClient,
    sessionId: string,
    entry: WorkspaceUploadEntry,
    options?: WorkspaceUploadOptions
): Promise<WorkspaceUploadResult> {
    const targetPath = joinWorkspacePath(options?.targetDirectory, entry.relativePath)
    const size = entry.file.size
    const signal = options?.signal

    if (size > MAX_WORKSPACE_UPLOAD_BYTES) {
        // Fail before the first chunk instead of after the whole file crossed
        // the wire.
        throw new Error(`File is too large to upload (max ${Math.floor(MAX_WORKSPACE_UPLOAD_BYTES / (1024 * 1024))}MB)`)
    }

    throwIfCancelled(signal)

    const start = await api.startWorkspaceUpload(sessionId, {
        path: targetPath,
        size,
        overwrite: options?.overwrite === true
    }, signal)
    if (!start.success || !start.uploadId) {
        throw new Error(start.error ?? 'Failed to start upload')
    }

    const uploadId = start.uploadId
    try {
        let offset = 0
        while (offset < size) {
            throwIfCancelled(signal)
            const end = Math.min(offset + WORKSPACE_UPLOAD_CHUNK_BYTES, size)
            const slice = entry.file.slice(offset, end)
            const content = await readBlobAsBase64(slice)
            const chunk = await api.appendWorkspaceUpload(sessionId, { uploadId, offset, content }, signal)
            if (!chunk.success) {
                throw new Error(chunk.error ?? 'Failed to upload chunk')
            }
            offset = end
            options?.onFileProgress?.(offset, size)
        }

        const finish = await api.finishWorkspaceUpload(sessionId, uploadId)
        if (!finish.success) {
            throw new Error(finish.error ?? 'Failed to finish upload')
        }

        return {
            path: finish.path ?? targetPath,
            size: finish.size ?? size,
            replaced: finish.replaced === true
        }
    } catch (error) {
        // Best effort: drop the partial file so the workspace stays clean.
        await api.abortWorkspaceUpload(sessionId, uploadId).catch(() => {})
        throw error
    }
}

/**
 * Upload a batch of files one after another.
 *
 * A failed file does not stop the batch: the failures are reported so the UI
 * can tell the user which files did not make it.
 */
export async function uploadWorkspaceFiles(
    api: ApiClient,
    sessionId: string,
    entries: WorkspaceUploadEntry[],
    options?: WorkspaceUploadOptions
): Promise<WorkspaceUploadSummary> {
    const summary: WorkspaceUploadSummary = {
        uploaded: [],
        failed: [],
        replaced: 0,
        bytes: 0
    }

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        options?.onFileStart?.(entry.relativePath, entry.file.size)
        try {
            const result = await uploadWorkspaceFile(api, sessionId, entry, options)
            summary.uploaded.push(result)
            summary.bytes += result.size
            if (result.replaced) {
                summary.replaced += 1
            }
        } catch (error) {
            if (error instanceof WorkspaceUploadCancelledError) {
                throw error
            }
            summary.failed.push({
                path: entry.relativePath,
                error: error instanceof Error ? error.message : 'Upload failed'
            })
        }
        options?.onBatchProgress?.(index + 1, entries.length)
    }

    return summary
}
