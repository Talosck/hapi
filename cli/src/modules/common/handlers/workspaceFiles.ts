import { logger } from '@/ui/logger'
import { lstat, realpath, rm, unlink } from 'fs/promises'
import { resolve } from 'path'
import type { WorkspaceDeleteResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { isInsideDirectory, looksAbsolute, normalizeRelativePath } from './workspacePaths'

interface DeleteWorkspaceFileRequest {
    path: string
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Deleting an entry from the session working directory.
 *
 * The CLI owns the path. It knows the working directory of the session and
 * refuses everything that points outside of it - including a path that only
 * escapes through a symlinked directory - so a client cannot delete files it
 * cannot see.
 *
 * A directory is removed with its content. A symlink is unlinked, never
 * followed: the entry it points at stays untouched.
 */
export function registerWorkspaceFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<DeleteWorkspaceFileRequest, WorkspaceDeleteResponse>(
        RPC_METHODS.DeleteWorkspaceFile,
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

            const rootPath = resolve(workingDirectory)
            const targetPath = resolve(rootPath, relativePath)
            if (targetPath === rootPath) {
                return rpcError('Refusing to delete the workspace root')
            }

            let isDirectory = false
            try {
                const stats = await lstat(targetPath)
                isDirectory = stats.isDirectory()

                if (stats.isSymbolicLink()) {
                    // The link itself is removed; whatever it points at is not
                    // touched, so a link into the system stays safe.
                    await unlink(targetPath)
                } else {
                    // A symlinked parent directory could point outside of the
                    // workspace, so the whole path is resolved before it is
                    // used.
                    const realWorkingDirectory = await realpath(rootPath).catch(() => rootPath)
                    const realTarget = await realpath(targetPath)
                    if (!isInsideDirectory(realWorkingDirectory, realTarget)) {
                        return rpcError('Access denied: the target is outside the working directory')
                    }
                    await rm(targetPath, { recursive: true, force: false })
                }

                logger.debug('Deleted workspace entry:', relativePath)
                return { success: true, path: relativePath, directory: isDirectory }
            } catch (error) {
                if (isMissingFileError(error)) {
                    return rpcError('File not found')
                }
                logger.debug('Failed to delete workspace entry:', error)
                return rpcError(getErrorMessage(error, 'Failed to delete file'))
            }
        }
    )
}
