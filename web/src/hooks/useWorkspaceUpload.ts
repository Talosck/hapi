import { useCallback, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { ApiError } from '@/api/client'
import type { ApiClient } from '@/api/client'
import {
    collectUploadEntries,
    uploadWorkspaceFiles,
    WorkspaceUploadCancelledError,
    type WorkspaceUploadSummary,
} from '@/lib/workspace-upload'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

export type WorkspaceUploadStatus = {
    /** Files that finished (uploaded or failed). */
    completed: number
    /** Files in the batch. */
    total: number
    /** Path of the file that is uploading right now. */
    currentPath: string
    /** Bytes of the current file that are already on the machine. */
    fileUploaded: number
    /** Size of the current file. */
    fileTotal: number
}

const HIDDEN_INPUT_STYLE: CSSProperties = { display: 'none' }

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

function describeUploadError(error: unknown, t: (key: string, values?: Record<string, string | number>) => string): string {
    if (error instanceof ApiError) {
        if (error.status === 409) {
            return t('files.upload.error.sessionInactive')
        }
        if (error.status === 413) {
            return t('files.upload.error.tooLarge')
        }
        if (error.body) {
            try {
                const parsed = JSON.parse(error.body) as { error?: string }
                if (typeof parsed.error === 'string' && parsed.error.trim()) {
                    return parsed.error
                }
            } catch {
                // Not a JSON body: fall through to the message.
            }
        }
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message
    }
    return t('files.upload.error.default')
}

/**
 * Upload files from the browser into the workspace of a session.
 *
 * The hook owns the file pickers, the progress of the running upload and the
 * toasts that report the outcome. The pickers are rendered by the caller
 * through `fileInputProps` / `folderInputProps`, so the buttons can live
 * anywhere in the page - the files toolbar and the directory tree both open
 * the same picker, for a different target directory.
 */
export function useWorkspaceUpload(options: {
    api: ApiClient | null
    sessionId: string
    /** Called after a batch finished, successful or not. */
    onUploaded?: (summary: WorkspaceUploadSummary) => void
}) {
    const { api, sessionId, onUploaded } = options
    const { t } = useTranslation()
    const toast = useToast()
    const [status, setStatus] = useState<WorkspaceUploadStatus | null>(null)

    const targetDirectoryRef = useRef('')
    // A set, not a single controller: two uploads can run at the same time
    // (the user starts another pick while the first one is still running) and
    // cancelling has to reach both of them.
    const abortControllersRef = useRef<Set<AbortController>>(new Set())
    // Uploads can overlap (the user starts another pick while the first one
    // runs). The progress bar belongs to the last one, and it may only be
    // cleared when the last upload is done.
    const activeRunsRef = useRef(0)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const folderInputRef = useRef<HTMLInputElement | null>(null)

    const runUpload = useCallback(async (files: File[], targetDirectory: string) => {
        if (!api || files.length === 0) {
            return
        }

        const entries = collectUploadEntries(files)
        if (entries.length === 0) {
            toast.addToast({
                title: t('files.upload.error.title'),
                body: t('files.upload.error.noFiles'),
                sessionId: sessionId,
                url: `/sessions/${sessionId}/files?tab=directories`
            })
            return
        }

        const controller = new AbortController()
        const signal = controller.signal
        abortControllersRef.current.add(controller)
        activeRunsRef.current += 1
        setStatus({ completed: 0, total: entries.length, currentPath: '', fileUploaded: 0, fileTotal: 0 })

        try {
            const summary = await uploadWorkspaceFiles(api, sessionId, entries, {
                targetDirectory,
                // Uploading a file replaces the file with the same name: the
                // user picked the file on purpose and expects it to land.
                overwrite: true,
                signal: controller.signal,
                onFileStart: (path, size) => {
                    setStatus((prev) => prev ? { ...prev, currentPath: path, fileUploaded: 0, fileTotal: size } : prev)
                },
                onFileProgress: (uploaded, total) => {
                    setStatus((prev) => prev ? { ...prev, fileUploaded: uploaded, fileTotal: total } : prev)
                },
                onBatchProgress: (completed, total) => {
                    setStatus((prev) => prev ? { ...prev, completed, total } : prev)
                }
            })

            if (summary.failed.length > 0) {
                // The reason of a failure is worth more than the path: the
                // path alone does not tell the user what went wrong.
                const failedPaths = summary.failed.map((failure) => `${failure.path} (${failure.error})`)
                const shown = failedPaths.slice(0, 5)
                toast.addToast({
                    title: t('files.upload.error.title'),
                    body: t('files.upload.error.partial', {
                        failed: summary.failed.length,
                        paths: shown.join(', ') + (failedPaths.length > shown.length ? '…' : '')
                    }),
                    sessionId: sessionId,
                    url: `/sessions/${sessionId}/files?tab=directories`
                })
            } else {
                toast.addToast({
                    title: t('files.upload.success.title'),
                    body: summary.replaced > 0
                        ? t('files.upload.success.replaced', { count: summary.uploaded.length, replaced: summary.replaced })
                        : t('files.upload.success.body', { count: summary.uploaded.length }),
                    sessionId: sessionId,
                    url: `/sessions/${sessionId}/files?tab=directories`
                })
            }

            // Only a file that actually landed changes the workspace, so the
            // page only has to refresh when there is one.
            if (summary.uploaded.length > 0) {
                onUploaded?.(summary)
            }
        } catch (error) {
            // A cancelled request settles with an AbortError, a cancelled
            // upload with the error of the library - both mean "the user
            // stopped it", not "it failed".
            if (error instanceof WorkspaceUploadCancelledError || isAbortError(error) || signal?.aborted) {
                toast.addToast({
                    title: t('files.upload.cancelled.title'),
                    body: t('files.upload.cancelled.body'),
                    sessionId: sessionId,
                    url: `/sessions/${sessionId}/files?tab=directories`
                })
            } else {
                toast.addToast({
                    title: t('files.upload.error.title'),
                    body: describeUploadError(error, t),
                    sessionId: sessionId,
                    url: `/sessions/${sessionId}/files?tab=directories`
                })
            }
        } finally {
            abortControllersRef.current.delete(controller)
            activeRunsRef.current -= 1
            if (activeRunsRef.current <= 0) {
                activeRunsRef.current = 0
                setStatus(null)
            }
        }
    }, [api, sessionId, onUploaded, toast, t])

    const handleFilesPicked = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        // The FileList of an input is live: clearing the input empties the
        // list the browser handed us. Snapshot the files before the reset,
        // otherwise the upload sees an empty list and does nothing.
        const files = Array.from(event.target.files ?? [])
        // Reset the input so picking the same file again still fires a change.
        event.target.value = ''
        void runUpload(files, targetDirectoryRef.current)
    }, [runUpload])

    const pickFiles = useCallback((targetDirectory: string) => {
        targetDirectoryRef.current = targetDirectory
        fileInputRef.current?.click()
    }, [])

    const pickFolder = useCallback((targetDirectory: string) => {
        targetDirectoryRef.current = targetDirectory
        folderInputRef.current?.click()
    }, [])

    const cancel = useCallback(() => {
        for (const controller of abortControllersRef.current) {
            controller.abort()
        }
    }, [])

    const setFolderInputRef = useCallback((node: HTMLInputElement | null) => {
        folderInputRef.current = node
        if (node) {
            // `webkitdirectory` is not part of the React DOM types, so it is
            // set on the element itself.
            node.setAttribute('webkitdirectory', '')
        }
    }, [])

    return {
        status,
        isUploading: status !== null,
        /** False when the client has no api to talk to (no hub connection). */
        canUpload: api !== null,
        fileInputProps: {
            ref: fileInputRef,
            type: 'file' as const,
            multiple: true,
            onChange: handleFilesPicked,
            style: HIDDEN_INPUT_STYLE
        },
        folderInputProps: {
            ref: setFolderInputRef,
            type: 'file' as const,
            multiple: true,
            onChange: handleFilesPicked,
            style: HIDDEN_INPUT_STYLE
        },
        pickFiles,
        pickFolder,
        cancel
    }
}
