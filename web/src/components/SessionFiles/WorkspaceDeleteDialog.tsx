import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'

/**
 * Confirmation for deleting an entry from the workspace of a session.
 *
 * Deleting is not undoable from the app, so the dialog names the entry and
 * says what happens to it: a file goes, a directory goes with its content.
 */
export function WorkspaceDeleteDialog(props: {
    isOpen: boolean
    /** Workspace-relative path of the entry. */
    path: string
    /** True when the entry is a directory (deleted with its content). */
    directory: boolean
    isPending: boolean
    onCancel: () => void
    onConfirm: () => Promise<void>
}) {
    const { t } = useTranslation()

    return (
        <ConfirmDialog
            isOpen={props.isOpen}
            onClose={props.onCancel}
            title={t('files.delete.confirm.title')}
            description={props.directory
                ? t('files.delete.confirm.directoryBody', { path: props.path })
                : t('files.delete.confirm.fileBody', { path: props.path })}
            confirmLabel={t('files.delete.confirm.confirm')}
            confirmingLabel={t('files.delete.confirm.confirming')}
            onConfirm={props.onConfirm}
            isPending={props.isPending}
            destructive
        />
    )
}
