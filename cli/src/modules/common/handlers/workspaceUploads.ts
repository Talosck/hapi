import { logger } from '@/ui/logger'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, realpath, rename, rm, stat } from 'fs/promises'
import { rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'path'
import type {
    WorkspaceUploadAbortResponse,
    WorkspaceUploadChunkResponse,
    WorkspaceUploadFinishResponse,
    WorkspaceUploadStartResponse,
} from '@hapi/protocol/apiTypes'
import { MAX_WORKSPACE_UPLOAD_BYTES, WORKSPACE_UPLOAD_CHUNK_BYTES } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { isInsideDirectory, looksAbsolute, normalizeRelativePath } from './workspacePaths'

interface StartWorkspaceUploadRequest {
    path: string
    size?: number
    overwrite?: boolean
}

interface AppendWorkspaceUploadRequest {
    uploadId: string
    offset: number
    content: string
}

interface WorkspaceUploadIdRequest {
    uploadId: string
}

interface PendingUpload {
    /** Workspace-relative path the file will land on. */
    relativePath: string
    /** Absolute path of the destination file. */
    targetPath: string
    /** Absolute path of the partial file the chunks are written to. */
    tempPath: string
    /** Bytes stored so far. */
    received: number
    /** Declared size of the file, when the client sent one. */
    expectedSize: number | null
    overwrite: boolean
}

const TEMP_FILE_MARKER = '.hapi-upload-'

/**
 * Age after which a leftover part file is considered abandoned.
 *
 * A part file is normally removed as soon as the upload finishes or aborts.
 * Only a hard kill of the CLI (SIGKILL, a power loss) leaves one behind, and
 * the next upload into the same directory sweeps it away.
 */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Uploads that may be open at the same time in one session.
 *
 * Every open upload holds a part file on disk, so an endless stream of
 * `start` calls without a `finish` must not fill the disk.
 */
const MAX_PENDING_UPLOADS = 32

/** The size limit in megabytes, for the error message. */
const MAX_WORKSPACE_UPLOAD_MB = Math.floor(MAX_WORKSPACE_UPLOAD_BYTES / (1024 * 1024))

/**
 * Exit cleanup for every session that has an open upload.
 *
 * One process listener serves all sessions: each registration adds its own
 * cleanup function, so a CLI that hosts several sessions still cleans up
 * every partial file exactly once.
 */
const sessionCleanupFns = new Set<() => void>()
let exitCleanupRegistered = false

function registerExitCleanup(cleanup: () => void): void {
    sessionCleanupFns.add(cleanup)
    if (!exitCleanupRegistered) {
        exitCleanupRegistered = true
        process.once('exit', () => {
            for (const fn of sessionCleanupFns) {
                fn()
            }
            sessionCleanupFns.clear()
        })
    }
}

/** Drop the cleanup of a session that has no upload left to clean up. */
function unregisterExitCleanup(cleanup: () => void): void {
    sessionCleanupFns.delete(cleanup)
}

/** True when the error means "there is nothing at that path". */
function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Windows refuses to rename over an existing file with these codes. */
function isReplaceRefusedError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES'
}

/**
 * Resolve the real path of the directory an upload writes into.
 *
 * A symlink inside the workspace could point anywhere, so the directory is
 * resolved before it is used. The walk stops at the closest existing ancestor,
 * because the directories of an upload are created on demand.
 */
async function resolveRealParentDirectory(targetPath: string): Promise<string | null> {
    let current = dirname(targetPath)
    for (;;) {
        try {
            return await realpath(current)
        } catch (error) {
            if (!isMissingFileError(error)) {
                return null
            }
            const parent = dirname(current)
            if (parent === current) {
                return null
            }
            current = parent
        }
    }
}

/**
 * The exact shape of a part file: `.<name>.hapi-upload-<uuid>.part`.
 *
 * The sweep matches this and nothing else - a user file that merely contains
 * the marker in its name is never touched.
 */
const TEMP_FILE_PATTERN = /^\..+\.hapi-upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/

/**
 * Remove the part files of uploads that never finished.
 *
 * The sweep only looks at the directory of the new upload, only at files with
 * the exact part-file shape, and never at a file that belongs to an upload
 * that is still running.
 */
async function sweepAbandonedTempFiles(directory: string, livePaths: Set<string>): Promise<void> {
    try {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
            if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) {
                continue
            }
            const fullPath = join(directory, entry.name)
            if (livePaths.has(fullPath)) {
                continue
            }
            try {
                const stats = await stat(fullPath)
                if (Date.now() - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
                    await rm(fullPath, { force: true })
                    logger.debug('Removed abandoned workspace upload file:', fullPath)
                }
            } catch (error) {
                logger.debug('Failed to sweep workspace upload file:', error)
            }
        }
    } catch (error) {
        logger.debug('Failed to sweep workspace upload files:', error)
    }
}

/**
 * Chunked upload of files into the session working directory.
 *
 * The client (web, native) opens an upload, streams base64 chunks and closes
 * it; the file only appears at its final path once the last chunk landed, so a
 * cancelled upload never leaves a half-written file behind.
 *
 * The pending uploads live in the closure of the registration call: every
 * session owns its own handler manager, so one session can never finish or
 * abort another session's upload.
 */
export function registerWorkspaceUploadHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    const pendingUploads = new Map<string, PendingUpload>()

    /** The part files of the uploads that are still running. */
    const liveTempPaths = (): Set<string> => new Set(
        Array.from(pendingUploads.values(), (upload) => upload.tempPath)
    )

    const cleanupTempFilesSync = (): void => {
        for (const upload of pendingUploads.values()) {
            try {
                rmSync(upload.tempPath, { force: true })
            } catch (error) {
                logger.debug('Failed to clean up workspace upload temp file:', error)
            }
        }
        pendingUploads.clear()
    }

    // The cleanup is only registered while an upload is running, so a CLI that
    // hosts many sessions does not collect a closure per session.
    const ensureCleanupRegistered = (): void => {
        if (pendingUploads.size === 0) {
            registerExitCleanup(cleanupTempFilesSync)
        }
    }

    const releaseCleanupIfIdle = (): void => {
        if (pendingUploads.size === 0) {
            unregisterExitCleanup(cleanupTempFilesSync)
        }
    }

    rpcHandlerManager.registerHandler<StartWorkspaceUploadRequest, WorkspaceUploadStartResponse>(
        RPC_METHODS.StartWorkspaceUpload,
        async (data) => {
            const rawPath = typeof data?.path === 'string' ? data.path.trim() : ''
            if (!rawPath) {
                return rpcError('Path is required')
            }
            if (looksAbsolute(rawPath)) {
                return rpcError('Path must be relative to the session workspace')
            }

            const relativePath = normalizeRelativePath(rawPath)
            if (!relativePath) {
                return rpcError('Path is required')
            }

            const validation = validatePath(relativePath, workingDirectory)
            if (!validation.valid) {
                return rpcError(validation.error ?? 'Invalid file path')
            }

            const targetPath = resolve(workingDirectory, relativePath)
            if (targetPath === resolve(workingDirectory)) {
                return rpcError('Invalid file path')
            }

            // A symlinked directory must not turn the upload into a write
            // outside of the workspace.
            const realWorkingDirectory = await realpath(workingDirectory).catch(() => resolve(workingDirectory))
            const realParentDirectory = await resolveRealParentDirectory(targetPath)
            if (!realParentDirectory || !isInsideDirectory(realWorkingDirectory, realParentDirectory)) {
                return rpcError('Access denied: the target directory is outside the working directory')
            }

            const declaredSize = typeof data.size === 'number' && Number.isFinite(data.size)
                ? Math.max(0, Math.floor(data.size))
                : null
            if (declaredSize !== null && declaredSize > MAX_WORKSPACE_UPLOAD_BYTES) {
                return rpcError(`File too large (max ${MAX_WORKSPACE_UPLOAD_MB}MB)`)
            }

            const overwrite = data.overwrite === true

            if (pendingUploads.size >= MAX_PENDING_UPLOADS) {
                return rpcError('Too many uploads in progress')
            }

            try {
                try {
                    const stats = await stat(targetPath)
                    if (stats.isDirectory()) {
                        return rpcError('A directory with that name already exists')
                    }
                    if (!overwrite) {
                        return rpcError('File already exists')
                    }
                } catch (error) {
                    if (!isMissingFileError(error)) {
                        throw error
                    }
                }

                const targetDir = dirname(targetPath)
                await mkdir(targetDir, { recursive: true })
                await sweepAbandonedTempFiles(targetDir, liveTempPaths())

                const uploadId = randomUUID()
                const tempPath = join(targetDir, `.${basename(targetPath)}${TEMP_FILE_MARKER}${uploadId}.part`)
                const handle = await open(tempPath, 'wx', 0o600)
                await handle.close()

                ensureCleanupRegistered()
                pendingUploads.set(uploadId, {
                    relativePath,
                    targetPath,
                    tempPath,
                    received: 0,
                    expectedSize: declaredSize,
                    overwrite
                })

                logger.debug('Workspace upload started:', relativePath)
                return { success: true, uploadId }
            } catch (error) {
                logger.debug('Failed to start workspace upload:', error)
                return rpcError(getErrorMessage(error, 'Failed to start upload'))
            }
        }
    )

    rpcHandlerManager.registerHandler<AppendWorkspaceUploadRequest, WorkspaceUploadChunkResponse>(
        RPC_METHODS.AppendWorkspaceUpload,
        async (data) => {
            const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : ''
            const upload = pendingUploads.get(uploadId)
            if (!upload) {
                return rpcError('Upload not found')
            }

            const offset = typeof data.offset === 'number' ? Math.floor(data.offset) : Number.NaN
            if (!Number.isInteger(offset) || offset < 0) {
                return rpcError('Invalid chunk offset')
            }
            if (offset !== upload.received) {
                return rpcError('Unexpected chunk offset')
            }

            if (typeof data.content !== 'string' || data.content.length === 0) {
                return rpcError('Content is required')
            }

            const buffer = Buffer.from(data.content, 'base64')
            if (buffer.length === 0) {
                return rpcError('Content is required')
            }
            if (buffer.length > WORKSPACE_UPLOAD_CHUNK_BYTES) {
                return rpcError('Chunk too large')
            }
            if (upload.received + buffer.length > MAX_WORKSPACE_UPLOAD_BYTES) {
                return rpcError(`File too large (max ${MAX_WORKSPACE_UPLOAD_MB}MB)`)
            }
            if (upload.expectedSize !== null && upload.received + buffer.length > upload.expectedSize) {
                return rpcError('Chunk exceeds the declared file size')
            }

            try {
                const handle = await open(upload.tempPath, 'r+')
                try {
                    // A single write can be partial, so keep writing until the
                    // whole chunk is on disk.
                    let written = 0
                    while (written < buffer.length) {
                        const result = await handle.write(buffer, written, buffer.length - written, upload.received + written)
                        if (result.bytesWritten <= 0) {
                            throw new Error('Failed to write chunk')
                        }
                        written += result.bytesWritten
                    }
                } finally {
                    await handle.close()
                }
                upload.received += buffer.length
                return { success: true, received: upload.received }
            } catch (error) {
                logger.debug('Failed to append workspace upload chunk:', error)
                return rpcError(getErrorMessage(error, 'Failed to upload chunk'))
            }
        }
    )

    rpcHandlerManager.registerHandler<WorkspaceUploadIdRequest, WorkspaceUploadFinishResponse>(
        RPC_METHODS.FinishWorkspaceUpload,
        async (data) => {
            const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : ''
            const upload = pendingUploads.get(uploadId)
            if (!upload) {
                return rpcError('Upload not found')
            }

            if (upload.expectedSize !== null && upload.received !== upload.expectedSize) {
                return rpcError('Incomplete upload')
            }

            try {
                // The part file is private (0600); the finished file gets the
                // permissions a normal file creation would produce.
                await chmod(upload.tempPath, 0o666 & ~process.umask()).catch(() => undefined)

                let replaced = false
                try {
                    const stats = await stat(upload.targetPath)
                    if (stats.isDirectory()) {
                        return rpcError('A directory with that name already exists')
                    }
                    if (!upload.overwrite) {
                        return rpcError('File already exists')
                    }
                    replaced = true
                } catch (error) {
                    if (!isMissingFileError(error)) {
                        throw error
                    }
                }

                if (replaced) {
                    // POSIX rename replaces the target atomically, so the old
                    // file stays until the new one is in place. Windows
                    // refuses to rename over an existing file, so there the
                    // old one has to go first.
                    try {
                        await rename(upload.tempPath, upload.targetPath)
                    } catch (error) {
                        if (!isReplaceRefusedError(error)) {
                            throw error
                        }
                        await rm(upload.targetPath, { force: true })
                        await rename(upload.tempPath, upload.targetPath)
                    }
                } else {
                    await rename(upload.tempPath, upload.targetPath)
                }
                pendingUploads.delete(uploadId)
                releaseCleanupIfIdle()

                logger.debug('Workspace upload finished:', upload.relativePath)
                return {
                    success: true,
                    path: upload.relativePath,
                    size: upload.received,
                    replaced
                }
            } catch (error) {
                logger.debug('Failed to finish workspace upload:', error)
                return rpcError(getErrorMessage(error, 'Failed to finish upload'))
            }
        }
    )

    rpcHandlerManager.registerHandler<WorkspaceUploadIdRequest, WorkspaceUploadAbortResponse>(
        RPC_METHODS.AbortWorkspaceUpload,
        async (data) => {
            const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : ''
            const upload = pendingUploads.get(uploadId)
            if (!upload) {
                // Aborting twice is not an error: the upload is already gone.
                return { success: true }
            }

            pendingUploads.delete(uploadId)
            releaseCleanupIfIdle()
            try {
                await rm(upload.tempPath, { force: true })
            } catch (error) {
                logger.debug('Failed to remove workspace upload temp file:', error)
            }
            return { success: true }
        }
    )
}
