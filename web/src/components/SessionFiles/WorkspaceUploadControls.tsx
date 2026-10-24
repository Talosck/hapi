import { useTranslation } from '@/lib/use-translation'
import type { useWorkspaceUpload } from '@/hooks/useWorkspaceUpload'
import { Button } from '@/components/ui/button'

/**
 * The upload controls of the files page.
 *
 * The buttons and the hidden file inputs live here, while the controller comes
 * from `useWorkspaceUpload`, so the directory tree can open the same picker
 * for a different target directory.
 */
export type WorkspaceUploadController = ReturnType<typeof useWorkspaceUpload>

function UploadFileIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 9 12 4 17 9" />
            <line x1="12" y1="4" x2="12" y2="15" />
        </svg>
    )
}

function UploadFolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="12 17 12 11" />
            <polyline points="9.5 13.5 12 11 14.5 13.5" />
        </svg>
    )
}

/** The buttons that open the file and folder pickers, plus the pickers. */
export function WorkspaceUploadControls(props: { upload: WorkspaceUploadController }) {
    const { t } = useTranslation()
    const { upload } = props

    return (
        <>
            <Button
                variant="outline"
                type="button"
                onClick={() => upload.pickFiles('')}
                disabled={!upload.canUpload || upload.isUploading}
                className="h-9 w-9 shrink-0 px-0"
                title={t('files.upload.files')}
                aria-label={t('files.upload.files')}
            >
                <UploadFileIcon />
            </Button>
            <Button
                variant="outline"
                type="button"
                onClick={() => upload.pickFolder('')}
                disabled={!upload.canUpload || upload.isUploading}
                className="h-9 w-9 shrink-0 px-0"
                title={t('files.upload.folder')}
                aria-label={t('files.upload.folder')}
            >
                <UploadFolderIcon />
            </Button>

            <input {...upload.fileInputProps} />
            <input {...upload.folderInputProps} />
        </>
    )
}

/** The progress of the running upload. */
export function WorkspaceUploadProgress(props: { upload: WorkspaceUploadController }) {
    const { t } = useTranslation()
    const { upload } = props

    if (!upload.status) {
        return null
    }

    return (
        <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)]">
            <div className="mx-auto flex w-full max-w-content items-center gap-3 px-3 py-2 text-xs text-[var(--app-hint)]">
                <span className="shrink-0">
                    {t('files.upload.progress', {
                        completed: upload.status.completed,
                        total: upload.status.total
                    })}
                </span>
                {upload.status.currentPath ? (
                    <span className="min-w-0 flex-1 truncate">{upload.status.currentPath}</span>
                ) : (
                    <span className="min-w-0 flex-1" />
                )}
                <button
                    type="button"
                    onClick={upload.cancel}
                    className="shrink-0 rounded px-2 py-1 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    {t('files.upload.cancel')}
                </button>
            </div>
        </div>
    )
}
