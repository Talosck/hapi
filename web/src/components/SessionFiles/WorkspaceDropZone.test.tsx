import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { WorkspaceDropZone } from './WorkspaceDropZone'
import type { WorkspaceUploadController } from './WorkspaceUploadControls'

function createUpload() {
    return {
        dropFiles: vi.fn(async () => {}),
        canUpload: true,
        isUploading: false,
        status: null,
        cancel: vi.fn(),
        pickFiles: vi.fn(),
        pickFolder: vi.fn(),
    } as unknown as WorkspaceUploadController
}

function dragEvent(type: string, files: File[] = [], types: string[] = ['Files']): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: { types, files, items: [], dropEffect: 'none' },
        configurable: true,
    })
    return event
}

function zoneOf(container: HTMLElement): HTMLElement {
    return container.firstChild as HTMLElement
}

describe('WorkspaceDropZone', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('shows the drop hint while a file is dragged over the page', () => {
        const upload = createUpload()
        const { container } = render(
            <WorkspaceDropZone upload={upload}>
                <div />
            </WorkspaceDropZone>
        )
        const zone = zoneOf(container)

        expect(screen.queryByText('files.upload.dropToUpload')).not.toBeInTheDocument()

        fireEvent(zone, dragEvent('dragenter'))
        expect(screen.getByText('files.upload.dropToUpload')).toBeInTheDocument()

        fireEvent(zone, dragEvent('dragleave'))
        expect(screen.queryByText('files.upload.dropToUpload')).not.toBeInTheDocument()
    })

    it('names the directory the drop lands in', () => {
        const upload = createUpload()
        const { container } = render(
            <WorkspaceDropZone upload={upload} targetDirectory="src" targetLabel="src">
                <div />
            </WorkspaceDropZone>
        )

        fireEvent(zoneOf(container), dragEvent('dragenter'))

        expect(screen.getByText('files.upload.dropIntoDirectory')).toBeInTheDocument()
    })

    it('uploads the dropped files into the target directory', () => {
        const upload = createUpload()
        const { container } = render(
            <WorkspaceDropZone upload={upload} targetDirectory="src">
                <div />
            </WorkspaceDropZone>
        )
        const zone = zoneOf(container)
        const file = new File(['x'], 'a.txt', { type: 'text/plain' })
        const event = dragEvent('drop', [file])

        fireEvent(zone, dragEvent('dragenter'))
        fireEvent(zone, event)

        expect(event.defaultPrevented).toBe(true)
        expect(upload.dropFiles).toHaveBeenCalledTimes(1)
        expect(upload.dropFiles).toHaveBeenCalledWith(expect.objectContaining({ files: [file] }), 'src')
    })

    it('hides the hint after the drop', () => {
        const upload = createUpload()
        const { container } = render(
            <WorkspaceDropZone upload={upload}>
                <div />
            </WorkspaceDropZone>
        )
        const zone = zoneOf(container)

        fireEvent(zone, dragEvent('dragenter'))
        fireEvent(zone, dragEvent('drop'))

        expect(screen.queryByText('files.upload.dropToUpload')).not.toBeInTheDocument()
    })

    it('ignores a drop that carries no files so the browser keeps its default', () => {
        const upload = createUpload()
        const { container } = render(
            <WorkspaceDropZone upload={upload}>
                <div />
            </WorkspaceDropZone>
        )
        const event = dragEvent('drop', [], ['text/plain'])

        fireEvent(zoneOf(container), event)

        expect(event.defaultPrevented).toBe(false)
        expect(upload.dropFiles).not.toHaveBeenCalled()
    })

    it('does not upload while the drop zone is disabled', () => {
        const upload = createUpload()
        const { container } = render(
            <WorkspaceDropZone upload={upload} disabled>
                <div />
            </WorkspaceDropZone>
        )
        const zone = zoneOf(container)
        const event = dragEvent('drop', [new File(['x'], 'a.txt')])

        fireEvent(zone, dragEvent('dragenter'))
        fireEvent(zone, event)

        // The browser default is still cancelled, so the file is not opened
        // by the browser, but nothing is uploaded.
        expect(event.defaultPrevented).toBe(true)
        expect(upload.dropFiles).not.toHaveBeenCalled()
        expect(screen.queryByText('files.upload.dropToUpload')).not.toBeInTheDocument()
    })

    it('keeps the browser from opening a file dropped outside of the zone', () => {
        const upload = createUpload()
        render(
            <WorkspaceDropZone upload={upload}>
                <div />
            </WorkspaceDropZone>
        )
        const event = dragEvent('drop', [new File(['x'], 'a.txt')])

        fireEvent(document.body, event)

        expect(event.defaultPrevented).toBe(true)
        expect(upload.dropFiles).not.toHaveBeenCalled()
    })
})
