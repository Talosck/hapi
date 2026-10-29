import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, act, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { clearDraft, getDraft } from '@/lib/composer-drafts'
import { encodeBase64 } from '@/lib/utils'
import FilesPage from './files'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    fileSearch: vi.fn(),
    sessionId: 'session-1',
    transferComposerDraftThenNavigate: vi.fn(async (
        _source: string,
        _target: string,
        navigate: () => void | Promise<void>,
    ) => {
        await navigate()
    }),
    sessionHeaderProps: null as null | {
        onSessionReopened?: (newSessionId: string) => void | Promise<void>
    },
    search: {} as { tab?: 'changes' | 'directories'; query?: string },
    gitStatus: {
        status: null as null | Record<string, unknown>,
        error: null as null | string,
        isLoading: false,
        refetch: vi.fn(),
    },
    api: {
        startWorkspaceUpload: vi.fn<(sessionId: string, options: unknown) => Promise<{ success: boolean; uploadId?: string; error?: string }>>(
            async () => ({ success: true, uploadId: 'upload-1' })
        ),
        appendWorkspaceUpload: vi.fn<(sessionId: string, options: unknown) => Promise<{ success: boolean; received?: number; error?: string }>>(
            async () => ({ success: true, received: 5 })
        ),
        finishWorkspaceUpload: vi.fn<(sessionId: string, uploadId: string) => Promise<{ success: boolean; path?: string; size?: number; replaced?: boolean; error?: string }>>(
            async () => ({ success: true, path: 'a.txt', size: 5, replaced: false })
        ),
        abortWorkspaceUpload: vi.fn<(sessionId: string, uploadId: string) => Promise<{ success: boolean; error?: string }>>(
            async () => ({ success: true })
        ),
        deleteWorkspaceFile: vi.fn<(sessionId: string, path: string) => Promise<{ success: boolean; path?: string; directory?: boolean; error?: string }>>(
            async () => ({ success: true, path: 'src/感言.ts', directory: false })
        ),
    },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: mocks.sessionId }),
    useSearch: () => mocks.search,
}))

vi.mock('@/lib/composer-draft-transfer', () => ({
    transferComposerDraftThenNavigate: mocks.transferComposerDraftThenNavigate,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: mocks.api }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: {
            id: mocks.sessionId,
            metadata: { path: '/workspace/project' },
        },
    }),
}))

vi.mock('@/hooks/queries/useGitStatusFiles', () => ({
    useGitStatusFiles: () => mocks.gitStatus,
}))

vi.mock('@/hooks/queries/useSessionFileSearch', () => ({
    useSessionFileSearch: (...args: unknown[]) => {
        mocks.fileSearch(...args)
        return {
            files: [{
                fileName: '感言.ts',
                filePath: 'src',
                fullPath: 'src/感言.ts',
                fileType: 'file' as const,
            }],
            error: null,
            isLoading: false,
            refetch: vi.fn(),
        }
    },
}))

vi.mock('@/components/SessionHeader', () => ({
    SessionHeader: (props: { onSessionReopened?: (newSessionId: string) => void | Promise<void> }) => {
        mocks.sessionHeaderProps = props
        return null
    },
}))

vi.mock('@/components/SessionFiles/DirectoryTree', () => ({
    DirectoryTree: () => null,
}))

function renderFilesPage() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <FilesPage />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
}

// Most tests do not render git rows; only the changes-row suite installs a status.
beforeEach(() => {
    mocks.gitStatus = { status: null, error: null, isLoading: false, refetch: vi.fn() }
})

describe('FilesPage search navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = { tab: 'directories', query: '感' }
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('restores the route query and carries it through file navigation', () => {
        renderFilesPage()

        const input = screen.getByRole('textbox')
        expect(input).toHaveValue('感')
        const sortButton = screen.getByRole('button', { name: 'Sort files' })
        const refreshButton = screen.getByRole('button', { name: 'Refresh filesystem view' })
        const uploadFilesButton = screen.getByRole('button', { name: 'Upload files' })
        const uploadFolderButton = screen.getByRole('button', { name: 'Upload folder' })
        expect(sortButton.parentElement?.parentElement).toBe(input.parentElement)
        // The toolbar order is search, upload files, upload folder, refresh.
        // The hidden file inputs sit between the buttons, so the order is
        // checked by document position rather than by sibling.
        const toolbarOrder = [input, uploadFilesButton, uploadFolderButton, refreshButton]
        for (let index = 1; index < toolbarOrder.length; index += 1) {
            const follows = toolbarOrder[index - 1].compareDocumentPosition(toolbarOrder[index]) & Node.DOCUMENT_POSITION_FOLLOWING
            expect(follows).toBeTruthy()
        }
        expect(sortButton).toHaveClass('w-10', 'self-stretch')
        expect(refreshButton).toHaveClass('h-9', 'w-9')
        expect(mocks.fileSearch).toHaveBeenCalledWith(
            expect.anything(),
            'session-1',
            '感',
            { enabled: true },
        )

        fireEvent.click(screen.getByRole('button', { name: /感言\.ts/ }))
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64('src/感言.ts'),
                tab: 'directories',
                query: '感',
            },
            resetScroll: false,
        })

        fireEvent.change(input, { target: { value: '言' } })
        expect(mocks.navigate).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-1' },
            search: {
                tab: 'directories',
                query: '言',
            },
            replace: true,
            resetScroll: false,
        })

        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
        expect(mocks.navigate).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-1' },
            search: { tab: 'directories' },
            replace: true,
            resetScroll: false,
        })
    })
})

describe('FilesPage tab preference', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.sessionHeaderProps = null
        mocks.search = {}
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('restores the globally remembered tab for a different session', () => {
        const firstRender = renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(screen.getByRole('tab', { name: 'Directories' }))
        expect(window.localStorage.getItem('hapi-files-tab')).toBe('directories')
        firstRender.unmount()

        mocks.sessionId = 'session-2'
        renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Directories' })).toHaveAttribute('aria-selected', 'true')
    })

    it('remembers Changes after the user switches back from Directories', () => {
        window.localStorage.setItem('hapi-files-tab', 'directories')
        const firstRender = renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Directories' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
        expect(window.localStorage.getItem('hapi-files-tab')).toBe('changes')
        firstRender.unmount()

        renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')
    })

    it('uses an explicit route tab before the stored browser preference', () => {
        window.localStorage.setItem('hapi-files-tab', 'directories')
        mocks.search = { tab: 'changes' }

        renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')
        expect(window.localStorage.getItem('hapi-files-tab')).toBe('changes')
    })
})

describe('FilesPage reopen draft transfer', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.sessionHeaderProps = null
        mocks.search = { tab: 'directories', query: '感' }
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('transfers the composer draft before navigating to a reopened files route', async () => {
        renderFilesPage()
        expect(mocks.sessionHeaderProps?.onSessionReopened).toEqual(expect.any(Function))

        await mocks.sessionHeaderProps!.onSessionReopened!('session-reopened')

        expect(mocks.transferComposerDraftThenNavigate).toHaveBeenCalledWith(
            'session-1',
            'session-reopened',
            expect.any(Function),
        )
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-reopened' },
            replace: true,
            resetScroll: false,
        })
    })

    it('preserves the directory scroll position across route remounts', () => {
        const firstRender = renderFilesPage()
        const firstScrollRegion = document.querySelector('[data-hapi-session-files-scroll="true"]') as HTMLElement
        firstScrollRegion.scrollTop = 87
        firstRender.unmount()

        renderFilesPage()
        const secondScrollRegion = document.querySelector('[data-hapi-session-files-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(87)
    })
})

describe('FilesPage change errors', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.gitStatus = { status: null, error: null, isLoading: false, refetch: vi.fn() }
        mocks.search = { tab: 'changes', query: undefined }
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('collapses long Git status errors until clicked', () => {
        const tail = 'FULL GIT STATUS ERROR TAIL'
        const longError = `Command failed: git status --porcelain=v2 --branch --untracked-files=all ${'diagnostic '.repeat(30)}${tail}`
        mocks.gitStatus.error = longError

        renderFilesPage()

        const errorToggle = screen.getByRole('button', { name: /Show full error/ })
        expect(errorToggle).toHaveAttribute('aria-expanded', 'false')
        expect(errorToggle).toHaveTextContent('…')
        expect(errorToggle).not.toHaveTextContent(tail)

        fireEvent.click(errorToggle)
        expect(errorToggle).toHaveAttribute('aria-expanded', 'true')
        expect(errorToggle).toHaveTextContent(longError)

        fireEvent.click(errorToggle)
        expect(errorToggle).toHaveAttribute('aria-expanded', 'false')
        expect(errorToggle).not.toHaveTextContent(tail)
    })
})

describe('FilesPage file context menu', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = { tab: 'directories', query: '感' }
        window.localStorage.clear()
        window.sessionStorage.clear()
        clearDraft('session-1')
    })

    it('adds a file to the composer draft and navigates back to the chat', () => {
        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to composer' }))

        expect(getDraft('session-1')).toBe('`src/感言.ts`')
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
            resetScroll: false,
        })
    })

    it('copies the absolute path resolved from the session workspace', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy absolute path' }))

        await vi.waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('/workspace/project/src/感言.ts')
        })
    })
})

describe('FilesPage workspace delete', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = { tab: 'directories', query: '感' }
        mocks.api.deleteWorkspaceFile.mockImplementation(async () => ({
            success: true,
            path: 'src/感言.ts',
            directory: false,
        }))
        window.localStorage.clear()
        window.sessionStorage.clear()
        clearDraft('session-1')
    })

    it('asks before it deletes and deletes the picked file', async () => {
        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

        // The dialog names the file and waits for the confirmation.
        const dialog = screen.getByRole('dialog')
        expect(dialog).toBeInTheDocument()
        expect(within(dialog).getByText(/src\/感言\.ts/)).toBeInTheDocument()
        expect(mocks.api.deleteWorkspaceFile).not.toHaveBeenCalled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

        await vi.waitFor(() => {
            expect(mocks.api.deleteWorkspaceFile).toHaveBeenCalledWith('session-1', 'src/感言.ts')
        })
    })

    it('keeps the file when the confirmation is cancelled', () => {
        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

        expect(mocks.api.deleteWorkspaceFile).not.toHaveBeenCalled()
    })

    it('keeps the dialog open and names the reason when the deletion is refused', async () => {
        mocks.api.deleteWorkspaceFile.mockImplementation(async () => ({
            success: false,
            error: 'File not found',
        }))

        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

        await vi.waitFor(() => {
            expect(screen.getByText('File not found')).toBeInTheDocument()
        })
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
})

describe('FilesPage changes-row context menu', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = {}
        mocks.gitStatus = {
            status: {
                stagedFiles: [],
                unstagedFiles: [{
                    fileName: 'README.md',
                    filePath: '',
                    fullPath: 'README.md',
                    status: 'modified',
                    isStaged: false,
                    linesAdded: 2,
                    linesRemoved: 1,
                }],
                branch: 'main',
                totalStaged: 0,
                totalUnstaged: 1,
            },
            error: null,
            isLoading: false,
            refetch: vi.fn(),
        }
        window.localStorage.clear()
        window.sessionStorage.clear()
        clearDraft('session-1')
    })

    it('opens the menu on a git change row and adds it to the composer', () => {
        renderFilesPage()

        fireEvent.contextMenu(screen.getByText('README.md').closest('button')!)
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to composer' }))

        expect(getDraft('session-1')).toBe('`README.md`')
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
            resetScroll: false,
        })
    })

    it('copies the absolute path for a git change row', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        renderFilesPage()

        fireEvent.contextMenu(screen.getByText('README.md').closest('button')!)
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy absolute path' }))

        await vi.waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('/workspace/project/README.md')
        })
    })

    it('opens the menu on touch long-press and does not navigate on release', () => {
        vi.useFakeTimers()
        try {
            renderFilesPage()
            const row = screen.getByText('README.md').closest('button')!

            fireEvent.touchStart(row, { touches: [{ clientX: 120, clientY: 240 }] })
            act(() => {
                vi.advanceTimersByTime(600)
            })
            expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument()

            fireEvent.touchEnd(row, { changedTouches: [{ clientX: 120, clientY: 240 }] })
            expect(mocks.navigate).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('FilesPage workspace upload', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = { tab: 'directories' }
        mocks.api.startWorkspaceUpload.mockImplementation(async () => ({ success: true, uploadId: 'upload-1' }))
        mocks.api.appendWorkspaceUpload.mockImplementation(async () => ({ success: true, received: 5 }))
        mocks.api.finishWorkspaceUpload.mockImplementation(async () => ({ success: true, path: 'a.txt', size: 5, replaced: false }))
        mocks.api.abortWorkspaceUpload.mockImplementation(async () => ({ success: true }))
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    function fileInput(): HTMLInputElement {
        return document.querySelector('input[type="file"]') as HTMLInputElement
    }

    it('opens the file picker from the toolbar', () => {
        renderFilesPage()

        const input = fileInput()
        const click = vi.spyOn(input, 'click')
        fireEvent.click(screen.getByRole('button', { name: 'Upload files' }))

        expect(click).toHaveBeenCalled()
    })

    it('uploads the picked file even though the input is reset afterwards', async () => {
        renderFilesPage()

        const input = fileInput()
        const file = new File(['hello'], 'a.txt')

        // The FileList of a file input is live: browsers empty it when the
        // input is reset. The fake below behaves that way, so the upload only
        // works when the files are snapshotted before the reset.
        const liveFiles = {
            0: file,
            length: 1,
            item: (index: number) => (index === 0 ? file : null)
        }
        Object.defineProperty(input, 'files', { value: liveFiles, configurable: true, writable: true })
        let currentValue = ''
        Object.defineProperty(input, 'value', {
            configurable: true,
            get: () => currentValue,
            set: (next: string) => {
                currentValue = next
                liveFiles.length = 0
            }
        })

        await act(async () => {
            fireEvent.change(input, { target: { files: liveFiles } })
        })

        expect(mocks.api.startWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            path: 'a.txt',
            size: 5,
            overwrite: true
        }, expect.any(AbortSignal))
    })

    it('uploads the picked file into the workspace', async () => {
        renderFilesPage()

        const file = new File(['hello'], 'a.txt')
        await act(async () => {
            fireEvent.change(fileInput(), { target: { files: [file] } })
        })

        expect(mocks.api.startWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            path: 'a.txt',
            size: 5,
            overwrite: true
        }, expect.any(AbortSignal))
        await vi.waitFor(() => {
            expect(mocks.api.appendWorkspaceUpload).toHaveBeenCalledWith('session-1', {
                uploadId: 'upload-1',
                offset: 0,
                content: btoa('hello')
            }, expect.any(AbortSignal))
        })
        await vi.waitFor(() => {
            expect(mocks.api.finishWorkspaceUpload).toHaveBeenCalledWith('session-1', 'upload-1')
        })
    })

    it('keeps the folder structure of a picked folder', async () => {
        renderFilesPage()

        const file = new File(['hello'], 'a.txt')
        Object.defineProperty(file, 'webkitRelativePath', { value: 'myfolder/a.txt' })
        await act(async () => {
            fireEvent.change(fileInput(), { target: { files: [file] } })
        })

        expect(mocks.api.startWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            path: 'myfolder/a.txt',
            size: 5,
            overwrite: true
        }, expect.any(AbortSignal))
    })

    it('uploads a file that is dropped on the page', async () => {
        const { container } = renderFilesPage()

        const file = new File(['hello'], 'dropped.txt')
        const event = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', {
            value: { types: ['Files'], files: [file], items: [] },
            configurable: true,
        })

        await act(async () => {
            fireEvent(container.firstChild as HTMLElement, event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(mocks.api.startWorkspaceUpload).toHaveBeenCalledWith('session-1', {
            path: 'dropped.txt',
            size: 5,
            overwrite: true
        }, expect.any(AbortSignal))
    })

    it('ignores a drop that carries no files', async () => {
        const { container } = renderFilesPage()

        const event = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', {
            value: { types: ['text/plain'], files: [], items: [] },
            configurable: true,
        })

        await act(async () => {
            fireEvent(container.firstChild as HTMLElement, event)
        })

        expect(mocks.api.startWorkspaceUpload).not.toHaveBeenCalled()
    })

    it('drops the partial file when the upload fails', async () => {
        mocks.api.appendWorkspaceUpload.mockImplementation(async () => ({ success: false, error: 'Chunk too large' }))
        renderFilesPage()

        const file = new File(['hello'], 'a.txt')
        await act(async () => {
            fireEvent.change(fileInput(), { target: { files: [file] } })
        })

        await vi.waitFor(() => {
            expect(mocks.api.abortWorkspaceUpload).toHaveBeenCalledWith('session-1', 'upload-1')
        })
        expect(mocks.api.finishWorkspaceUpload).not.toHaveBeenCalled()
    })
})
