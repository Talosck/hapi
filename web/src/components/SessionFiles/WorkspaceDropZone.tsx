import { useCallback, useEffect, useRef, useState } from 'react'
import { hasFileDrag } from '@/lib/workspace-drop'
import { useTranslation } from '@/lib/use-translation'
import type { WorkspaceUploadController } from './WorkspaceUploadControls'

/**
 * The drop target of the files page.
 *
 * A file that is dragged onto the page is uploaded into the workspace of the
 * session. The directory the drop lands in is decided by the caller: the
 * directory tree reports the row the pointer is over, everything else lands
 * in the workspace root.
 */
export function WorkspaceDropZone(props: {
    upload: WorkspaceUploadController
    /** Directory the drop lands in; the empty path is the workspace root. */
    targetDirectory?: string
    /** Name of the target directory, shown in the drop hint. */
    targetLabel?: string | null
    /** Nothing can be uploaded (e.g. no hub connection). */
    disabled?: boolean
    children: React.ReactNode
}) {
    const { upload, targetDirectory = '', targetLabel, disabled, children } = props
    const { t } = useTranslation()
    const [isDragging, setIsDragging] = useState(false)
    // A drag walks over nested elements, so every element reports an enter
    // and a leave. The counter keeps the overlay up until the pointer left
    // the zone for good.
    const dragDepthRef = useRef(0)

    const clearDrag = useCallback(() => {
        dragDepthRef.current = 0
        setIsDragging(false)
    }, [])

    // A drop outside of the zone (e.g. on the sidebar) never reaches the
    // drop handler of the zone, so the overlay is cleared on the document.
    // The default is cancelled there as well, so the browser does not open
    // the file the user dragged onto the page.
    useEffect(() => {
        const preventFileDefault = (event: DragEvent) => {
            if (hasFileDrag(event.dataTransfer)) event.preventDefault()
        }
        const onDocumentDrop = () => clearDrag()
        document.addEventListener('dragover', preventFileDefault)
        document.addEventListener('drop', preventFileDefault)
        document.addEventListener('drop', onDocumentDrop)
        document.addEventListener('dragend', onDocumentDrop)
        return () => {
            document.removeEventListener('dragover', preventFileDefault)
            document.removeEventListener('drop', preventFileDefault)
            document.removeEventListener('drop', onDocumentDrop)
            document.removeEventListener('dragend', onDocumentDrop)
        }
    }, [clearDrag])

    const onDragEnter = useCallback((event: React.DragEvent) => {
        if (!hasFileDrag(event.dataTransfer)) return
        dragDepthRef.current += 1
        setIsDragging(true)
    }, [])

    const onDragOver = useCallback((event: React.DragEvent) => {
        if (!hasFileDrag(event.dataTransfer)) return
        // The browser only performs a drop when the default of `dragover` is
        // cancelled. Cancelling it also keeps the browser from opening the
        // file when it is dropped on the zone.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
    }, [])

    const onDragLeave = useCallback((event: React.DragEvent) => {
        if (!hasFileDrag(event.dataTransfer)) return
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setIsDragging(false)
    }, [])

    const onDrop = useCallback((event: React.DragEvent) => {
        if (!hasFileDrag(event.dataTransfer)) return
        event.preventDefault()
        clearDrag()
        if (disabled) return
        void upload.dropFiles(event.dataTransfer, targetDirectory)
    }, [clearDrag, disabled, targetDirectory, upload])

    return (
        <div
            className="relative flex h-full min-h-0 flex-col"
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {children}
            {isDragging && !disabled ? (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-4">
                    <div className="rounded-lg border-2 border-dashed border-[var(--app-link)] bg-[var(--app-bg)]/90 px-6 py-4 text-center shadow-lg">
                        <div className="text-sm font-medium text-[var(--app-link)]">
                            {targetLabel
                                ? t('files.upload.dropIntoDirectory', { name: targetLabel })
                                : t('files.upload.dropToUpload')}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}
