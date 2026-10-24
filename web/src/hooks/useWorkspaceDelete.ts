import { useCallback, useState } from 'react'
import { ApiError } from '@/api/client'
import type { ApiClient } from '@/api/client'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

export type WorkspaceDeleteTarget = {
    /** Workspace-relative path of the entry. */
    path: string
    /** True when the entry is a directory and goes with its content. */
    directory: boolean
}

function describeDeleteError(
    error: unknown,
    t: (key: string, values?: Record<string, string | number>) => string
): string {
    if (error instanceof ApiError && error.body) {
        try {
            const parsed = JSON.parse(error.body) as { error?: string }
            if (typeof parsed.error === 'string' && parsed.error.trim()) {
                return parsed.error
            }
        } catch {
            // Not a JSON body: fall through to the message.
        }
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message
    }
    return t('files.delete.error.default')
}

/**
 * Delete an entry from the workspace of a session.
 *
 * The hook owns the confirmation: `requestDelete` remembers what the user
 * picked, `confirmDelete` performs the deletion and reports the outcome. A
 * failed deletion throws, so the confirmation dialog can keep the error in
 * front of the user instead of closing on a delete that never happened.
 */
export function useWorkspaceDelete(options: {
    api: ApiClient | null
    sessionId: string
    /** Called after an entry was deleted. */
    onDeleted?: (path: string) => void
}) {
    const { api, sessionId, onDeleted } = options
    const { t } = useTranslation()
    const toast = useToast()
    const [target, setTarget] = useState<WorkspaceDeleteTarget | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    const requestDelete = useCallback((path: string, directory = false) => {
        setTarget({ path, directory })
    }, [])

    const cancelDelete = useCallback(() => {
        setTarget(null)
    }, [])

    const confirmDelete = useCallback(async () => {
        if (!api || !target) {
            throw new Error(t('files.delete.error.default'))
        }

        setIsDeleting(true)
        try {
            const result = await api.deleteWorkspaceFile(sessionId, target.path)
            if (!result.success) {
                throw new Error(result.error ?? t('files.delete.error.default'))
            }

            toast.addToast({
                title: t('files.delete.success.title'),
                body: t('files.delete.success.body', { path: target.path }),
                sessionId,
                url: `/sessions/${sessionId}/files?tab=directories`
            })
            setTarget(null)
            onDeleted?.(target.path)
        } catch (error) {
            // The dialog shows the reason; the toast tells the user that
            // nothing was deleted even when the dialog is out of sight.
            toast.addToast({
                title: t('files.delete.error.title'),
                body: describeDeleteError(error, t),
                sessionId,
                url: `/sessions/${sessionId}/files?tab=directories`
            })
            throw error instanceof Error ? error : new Error(describeDeleteError(error, t))
        } finally {
            setIsDeleting(false)
        }
    }, [api, sessionId, target, onDeleted, toast, t])

    return {
        /** The entry waiting for confirmation, or null when nothing is pending. */
        target,
        isDeleting,
        /** False when the client has no api to talk to (no hub connection). */
        canDelete: api !== null,
        requestDelete,
        cancelDelete,
        confirmDelete
    }
}
