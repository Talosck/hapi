/*
 * Standalone Vite-served fixture for the workspace upload Playwright e2e
 * spec. Mounts the production upload controls (`WorkspaceUploadControls`,
 * `WorkspaceUploadProgress`) and the production directory tree, wired to a
 * stub API that records every call.
 *
 * The point of running this in a real browser is the file input: jsdom hands
 * out a fresh FileList on every `input.files` access, while a browser hands
 * out a live one that empties as soon as the input is reset. The production
 * code has to snapshot the files before it resets the input - a bug that no
 * unit test can see, and that silently uploads nothing in Chrome.
 *
 * The stub API lives on `window.__workspaceUploadE2E` so the spec can assert
 * what the client sent, and can make a call fail on demand.
 */

import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider, useToast } from '../src/lib/toast-context'
import { useWorkspaceUpload } from '../src/hooks/useWorkspaceUpload'
import {
    WorkspaceUploadControls,
    WorkspaceUploadProgress,
} from '../src/components/SessionFiles/WorkspaceUploadControls'
import { WorkspaceDropZone } from '../src/components/SessionFiles/WorkspaceDropZone'
import { DirectoryTree } from '../src/components/SessionFiles/DirectoryTree'
import { DEFAULT_DIRECTORY_SORT } from '../src/lib/directory-sort'
import type { ApiClient } from '../src/api/client'

type RecordedCall = {
    method: string
    args: unknown[]
}

type Harness = {
    calls: RecordedCall[]
    /** Directory entries the stubbed tree returns. */
    directories: Record<string, Array<{ name: string; type: 'file' | 'directory' }>>
    /** When set, the next call of this method fails with this error. */
    failWith: Record<string, string>
    reset(): void
}

declare global {
    interface Window {
        __workspaceUploadE2E?: Harness
    }
}

const harness: Harness = {
    calls: [],
    directories: {
        '': [{ name: 'src', type: 'directory' }],
        src: [{ name: 'app.ts', type: 'file' }]
    },
    failWith: {},
    reset() {
        this.calls = []
        this.failWith = {}
    }
}

window.__workspaceUploadE2E = harness

function record(method: string, args: unknown[]): void {
    harness.calls.push({ method, args })
}

const api = {
    async startWorkspaceUpload(sessionId: string, options: { path: string; size: number; overwrite: boolean }) {
        record('startWorkspaceUpload', [sessionId, options])
        const failure = harness.failWith.startWorkspaceUpload
        if (failure) {
            return { success: false as const, error: failure }
        }
        return { success: true as const, uploadId: 'upload-1' }
    },
    async appendWorkspaceUpload(sessionId: string, options: { uploadId: string; offset: number; content: string }) {
        record('appendWorkspaceUpload', [sessionId, options])
        const failure = harness.failWith.appendWorkspaceUpload
        if (failure) {
            return { success: false as const, error: failure }
        }
        return { success: true as const, received: options.content.length }
    },
    async finishWorkspaceUpload(sessionId: string, uploadId: string) {
        record('finishWorkspaceUpload', [sessionId, uploadId])
        const failure = harness.failWith.finishWorkspaceUpload
        if (failure) {
            return { success: false as const, error: failure }
        }
        const start = harness.calls.find((call) => call.method === 'startWorkspaceUpload')
        const path = (start?.args[1] as { path: string } | undefined)?.path ?? ''
        return { success: true as const, path, size: 0, replaced: false }
    },
    async abortWorkspaceUpload(sessionId: string, uploadId: string) {
        record('abortWorkspaceUpload', [sessionId, uploadId])
        return { success: true as const }
    },
    async listSessionDirectory(_sessionId: string, path?: string) {
        const entries = harness.directories[path ?? ''] ?? []
        return {
            success: true as const,
            entries: entries.map((entry) => ({ name: entry.name, type: entry.type }))
        }
    }
} as unknown as ApiClient

const SESSION_ID = 'e2e-session'

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
    const upload = useWorkspaceUpload({
        api,
        sessionId: SESSION_ID,
        onUploaded: () => {
            record('onUploaded', [])
        }
    })
    // The directory a drag hovers in the tree; null is the workspace root.
    const [dropDirectory, setDropDirectory] = useState<string | null>(null)

    return (
        <WorkspaceDropZone
            upload={upload}
            targetDirectory={dropDirectory ?? ''}
            targetLabel={dropDirectory === null ? null : 'project'}
        >
            <div data-testid="workspace-upload-fixture">
                <ToastMessages />
                <div className="flex items-center gap-2 border-b border-[var(--app-divider)] p-3">
                    <WorkspaceUploadControls upload={upload} />
                </div>
                <WorkspaceUploadProgress upload={upload} />
                <DirectoryTree
                    api={api}
                    sessionId={SESSION_ID}
                    rootLabel="project"
                    onOpenFile={() => record('onOpenFile', [])}
                    onUploadFiles={(path) => upload.pickFiles(path)}
                    onUploadFolder={(path) => upload.pickFolder(path)}
                    onDropTargetChange={setDropDirectory}
                    sort={DEFAULT_DIRECTORY_SORT}
                />
            </div>
        </WorkspaceDropZone>
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
