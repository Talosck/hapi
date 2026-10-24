import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { DEFAULT_DIRECTORY_SORT } from '@/lib/directory-sort'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'

const mocks = vi.hoisted(() => ({
    entries: [
        { name: 'README.md', type: 'file' as const, size: 12, modified: 1_784_175_060_000 },
        { name: 'src', type: 'directory' as const },
    ] as Array<{ name: string; type: 'file' | 'directory'; size?: number; modified?: number }>,
}))

vi.mock('@/hooks/queries/useSessionDirectory', () => ({
    useSessionDirectory: () => ({
        entries: mocks.entries,
        error: null,
        isLoading: false,
        refetch: vi.fn(),
    }),
}))

function renderTree(handlers: {
    onOpenFile?: () => void
    onRequestFileMenu?: (path: string, point: { x: number; y: number }) => void
    onUploadFiles?: (path: string) => void
    onUploadFolder?: (path: string) => void
    onDropTargetChange?: (path: string | null) => void
} = {}) {
    const onOpenFile = handlers.onOpenFile ?? vi.fn()
    const onRequestFileMenu = handlers.onRequestFileMenu ?? vi.fn()
    const onUploadFiles = handlers.onUploadFiles ?? vi.fn()
    const onUploadFolder = handlers.onUploadFolder ?? vi.fn()
    const onDropTargetChange = handlers.onDropTargetChange ?? vi.fn()

    render(
        <I18nProvider>
            <ToastProvider>
                <DirectoryTree
                    api={{} as never}
                    sessionId="session-1"
                    rootLabel="project"
                    onOpenFile={onOpenFile}
                    onRequestFileMenu={onRequestFileMenu}
                    onUploadFiles={onUploadFiles}
                    onUploadFolder={onUploadFolder}
                    onDropTargetChange={onDropTargetChange}
                    sort={DEFAULT_DIRECTORY_SORT}
                />
            </ToastProvider>
        </I18nProvider>
    )

    return { onOpenFile, onRequestFileMenu, onUploadFiles, onUploadFolder, onDropTargetChange }
}

/** The file name button (a directory row's download button also mentions the name in its aria-label). */
function fileRow(): HTMLButtonElement {
    return screen.getByText('README.md').closest('button') as HTMLButtonElement
}

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
})

afterEach(() => cleanup())

describe('DirectoryTree file context menu', () => {
    it('requests the menu on right-click with the entry path and pointer', () => {
        const { onRequestFileMenu } = renderTree()

        fireEvent.contextMenu(fileRow(), { clientX: 321, clientY: 123 })

        expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 321, y: 123 })
    })

    it('requests the menu on touch long-press and does not open the file on release', () => {
        vi.useFakeTimers()
        try {
            const { onOpenFile, onRequestFileMenu } = renderTree()

            fireEvent.touchStart(fileRow(), { touches: [{ clientX: 44, clientY: 55 }] })
            act(() => {
                vi.advanceTimersByTime(600)
            })

            expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 44, y: 55 })
            expect(onOpenFile).not.toHaveBeenCalled()

            fireEvent.touchEnd(fileRow(), { changedTouches: [{ clientX: 44, clientY: 55 }] })
            expect(onOpenFile).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('DirectoryTree upload actions', () => {
    it('asks for the files to upload into the picked directory', () => {
        const { onUploadFiles } = renderTree()

        fireEvent.click(screen.getByRole('button', { name: 'Upload to src' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Upload files to src' }))

        expect(onUploadFiles).toHaveBeenCalledWith('src')
    })

    it('asks for the folder to upload into the picked directory', () => {
        const { onUploadFolder } = renderTree()

        fireEvent.click(screen.getByRole('button', { name: 'Upload to src' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Upload folder to src' }))

        expect(onUploadFolder).toHaveBeenCalledWith('src')
    })

    it('has no upload action when the page does not offer one', () => {
        render(
            <I18nProvider>
                <ToastProvider>
                    <DirectoryTree
                        api={{} as never}
                        sessionId="session-1"
                        rootLabel="project"
                        onOpenFile={vi.fn()}
                        sort={DEFAULT_DIRECTORY_SORT}
                    />
                </ToastProvider>
            </I18nProvider>
        )

        expect(screen.queryByRole('button', { name: 'Upload to src' })).toBeNull()
    })
})

describe('DirectoryTree drop target', () => {
    /** A drag event with a file in it, as the browser hands it out. */
    function dragEvent(type: string, relatedTarget: EventTarget | null = null): Event {
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', {
            value: { types: ['Files'], files: [], items: [] },
            configurable: true,
        })
        Object.defineProperty(event, 'relatedTarget', {
            value: relatedTarget,
            configurable: true,
        })
        return event
    }

    it('reports the directory the drag hovers', () => {
        const { onDropTargetChange } = renderTree()

        fireEvent(screen.getByText('src'), dragEvent('dragover'))

        expect(onDropTargetChange).toHaveBeenCalledWith('src')
    })

    it('reports the root when the drag hovers the root row', () => {
        const { onDropTargetChange } = renderTree()

        fireEvent(screen.getByText('project'), dragEvent('dragover'))

        expect(onDropTargetChange).toHaveBeenCalledWith('')
    })

    it('reports no directory when the drag hovers a file', () => {
        const { onDropTargetChange } = renderTree()

        // The drag has to leave a directory first: the target is only
        // reported when it changes.
        fireEvent(screen.getByText('src'), dragEvent('dragover'))
        fireEvent(fileRow(), dragEvent('dragover'))

        expect(onDropTargetChange).toHaveBeenLastCalledWith(null)
    })

    it('reports no directory when the drag leaves the tree', () => {
        const { onDropTargetChange } = renderTree()

        fireEvent(screen.getByText('src'), dragEvent('dragover'))
        fireEvent(screen.getByText('src').closest('div')!, dragEvent('dragleave', document.body))

        expect(onDropTargetChange).toHaveBeenLastCalledWith(null)
    })

    it('keeps the directory when the drag moves to another row of the tree', () => {
        const { onDropTargetChange } = renderTree()
        const tree = screen.getByText('project').closest('div')!

        fireEvent(screen.getByText('src'), dragEvent('dragover'))
        fireEvent(tree, dragEvent('dragleave', screen.getByText('src')))

        expect(onDropTargetChange).toHaveBeenLastCalledWith('src')
    })
})
