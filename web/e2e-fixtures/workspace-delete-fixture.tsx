/*
 * Standalone Vite-served fixture for the workspace delete Playwright e2e spec.
 * Mounts the production file action menu, the production delete hook and the
 * production confirmation dialog, wired to a stub API that records every call.
 *
 * The delete starts with a right-click, so the spec drives a real Chromium: the
 * context menu is opened by a native `contextmenu` event, positioned against
 * the pointer and dismissed by a click outside. jsdom has no pointer geometry
 * and no native context menu, so it cannot show that the affordance exists and
 * that the confirmation sits between the click and the deletion.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider, useToast } from '../src/lib/toast-context'
import { FileActionMenu } from '../src/components/FileActionMenu'
import { WorkspaceDeleteDialog } from '../src/components/SessionFiles/WorkspaceDeleteDialog'
import { useWorkspaceDelete } from '../src/hooks/useWorkspaceDelete'
import { useFileMenuTrigger } from '../src/hooks/useFileMenuTrigger'
import type { AnchoredMenuPoint } from '../src/hooks/useAnchoredMenu'
import type { ApiClient } from '../src/api/client'

type RecordedCall = {
    method: string
    args: unknown[]
}

type Harness = {
    calls: RecordedCall[]
    /** When set, the next call of this method fails with this error. */
    failWith: Record<string, string>
    reset(): void
}

declare global {
    interface Window {
        __workspaceDeleteE2E?: Harness
    }
}

const harness: Harness = {
    calls: [],
    failWith: {},
    reset() {
        this.calls = []
        this.failWith = {}
    }
}

window.__workspaceDeleteE2E = harness

function record(method: string, args: unknown[]): void {
    harness.calls.push({ method, args })
}

const api = {
    async deleteWorkspaceFile(sessionId: string, path: string) {
        record('deleteWorkspaceFile', [sessionId, path])
        const failure = harness.failWith.deleteWorkspaceFile
        if (failure) {
            return { success: false as const, error: failure }
        }
        return { success: true as const, path, directory: false }
    }
} as unknown as ApiClient

const SESSION_ID = 'e2e-session'
const FILE_PATH = 'src/notes.md'

/**
 * The app renders the toasts in `ToastContainer`, which needs the router. The
 * fixture only needs the text, so it renders the toasts itself.
 */
function ToastMessages() {
    const { toasts } = useToast()
    return (
        <div data-testid="toasts">
            {toasts.map((toast) => (
                <div key={toast.id}>{toast.title}: {toast.body}</div>
            ))}
        </div>
    )
}

function App() {
    const [menu, setMenu] = React.useState<{ path: string; point: AnchoredMenuPoint } | null>(null)

    const deleteState = useWorkspaceDelete({
        api,
        sessionId: SESSION_ID,
        onDeleted: (path) => {
            record('onDeleted', [path])
        }
    })

    const rowHandlers = useFileMenuTrigger({
        onOpen: () => record('onOpen', []),
        onOpenMenu: (point) => setMenu({ path: FILE_PATH, point })
    })

    return (
        <div data-testid="workspace-delete-fixture">
            <ToastMessages />
            <button
                type="button"
                data-testid="file-row"
                {...rowHandlers}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                <span className="truncate font-medium">{FILE_PATH}</span>
            </button>

            <FileActionMenu
                isOpen={menu !== null}
                onClose={() => setMenu(null)}
                relativePath={menu?.path ?? ''}
                absolutePath={`/workspace/project/${menu?.path ?? ''}`}
                anchorPoint={menu?.point ?? { x: 0, y: 0 }}
                onAddToComposer={() => record('onAddToComposer', [])}
                onDelete={() => {
                    deleteState.requestDelete(menu?.path ?? '')
                }}
            />

            <WorkspaceDeleteDialog
                isOpen={deleteState.target !== null}
                path={deleteState.target?.path ?? ''}
                directory={deleteState.target?.directory ?? false}
                isPending={deleteState.isDeleting}
                onCancel={deleteState.cancelDelete}
                onConfirm={deleteState.confirmDelete}
            />
        </div>
    )
}

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
})

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                        <App />
                    </ToastProvider>
                </I18nProvider>
            </QueryClientProvider>
        </React.StrictMode>
    )
}
