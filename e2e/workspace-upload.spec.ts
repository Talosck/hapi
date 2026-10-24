/*
 * End-to-end coverage for the workspace upload (files and folders into the
 * working directory of a session).
 *
 * The unit tests in `web/src/lib/workspace-upload.test.ts` and
 * `web/src/routes/sessions/files.test.tsx` run under jsdom, which hands out a
 * fresh FileList on every `input.files` access. A browser hands out a live
 * one: it empties as soon as the input is reset. The production code resets
 * the input so the same file can be picked twice, so it has to snapshot the
 * files first - and a regression there uploads nothing at all in Chrome while
 * every unit test still passes. Only a real browser catches that.
 *
 * These specs drive a real Chromium against
 * `web/e2e-fixtures/workspace-upload-fixture.html` (vite dev), which mounts
 * the production upload controls and the production directory tree against a
 * stub API that records every call.
 */

import { test, expect, Page, Locator } from '@playwright/test'
import path from 'node:path'

type RecordedCall = {
    method: string
    args: unknown[]
}

type Harness = {
    calls: RecordedCall[]
    failWith: Record<string, string>
    reset(): void
}

async function gotoFixture(page: Page): Promise<void> {
    await page.goto('/e2e-fixtures/workspace-upload-fixture.html')
    await expect(page.getByTestId('workspace-upload-fixture')).toBeVisible()
}

async function calls(page: Page): Promise<RecordedCall[]> {
    return await page.evaluate(
        () => (window as unknown as { __workspaceUploadE2E: Harness }).__workspaceUploadE2E.calls.slice()
    )
}

async function resetCalls(page: Page): Promise<void> {
    await page.evaluate(() => {
        ;(window as unknown as { __workspaceUploadE2E: Harness }).__workspaceUploadE2E.reset()
    })
}

/** The two file inputs of the fixture: files first, folder second. */
function inputs(page: Page) {
    return page.locator('input[type="file"]')
}

test.describe('workspace upload e2e', () => {
    test('uploads a picked file into the workspace', async ({ page }) => {
        await gotoFixture(page)

        await inputs(page).nth(0).setInputFiles({
            name: 'hello.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('hello world')
        })

        await expect.poll(async () => (await calls(page)).some((call) => call.method === 'finishWorkspaceUpload'))
            .toBe(true)

        const recorded = await calls(page)
        const start = recorded.find((call) => call.method === 'startWorkspaceUpload')
        expect(start).toBeDefined()
        expect(start?.args[1]).toEqual({ path: 'hello.txt', size: 11, overwrite: true })

        const chunk = recorded.find((call) => call.method === 'appendWorkspaceUpload')
        expect(chunk?.args[1]).toEqual({
            uploadId: 'upload-1',
            offset: 0,
            content: Buffer.from('hello world').toString('base64')
        })

        // The file only counts as uploaded when the upload is closed.
        expect(recorded.map((call) => call.method)).toEqual([
            'startWorkspaceUpload',
            'appendWorkspaceUpload',
            'finishWorkspaceUpload',
            'onUploaded'
        ])
    })

    test('uploads the same file twice (the input is reset between picks)', async ({ page }) => {
        await gotoFixture(page)

        const file = { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') }
        await inputs(page).nth(0).setInputFiles(file)
        await expect.poll(async () => (await calls(page)).filter((call) => call.method === 'finishWorkspaceUpload').length)
            .toBe(1)

        await resetCalls(page)
        await inputs(page).nth(0).setInputFiles(file)

        await expect.poll(async () => (await calls(page)).filter((call) => call.method === 'finishWorkspaceUpload').length)
            .toBe(1)
        const recorded = await calls(page)
        expect(recorded.find((call) => call.method === 'startWorkspaceUpload')?.args[1]).toEqual({
            path: 'hello.txt',
            size: 11,
            overwrite: true
        })
    })

    test('keeps the folder structure of a picked folder', async ({ page }) => {
        await gotoFixture(page)

        // Playwright cannot pick a real directory, so the folder input gets a
        // file whose `webkitRelativePath` mirrors what a folder pick produces.
        await page.evaluate(() => {
            const input = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement
            const dataTransfer = new DataTransfer()
            const file = new File(['nested'], 'notes.md', { type: 'text/markdown' })
            Object.defineProperty(file, 'webkitRelativePath', { value: 'myfolder/sub/notes.md' })
            dataTransfer.items.add(file)
            input.files = dataTransfer.files
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })

        await expect.poll(async () => (await calls(page)).some((call) => call.method === 'finishWorkspaceUpload'))
            .toBe(true)

        const recorded = await calls(page)
        expect(recorded.find((call) => call.method === 'startWorkspaceUpload')?.args[1]).toEqual({
            path: 'myfolder/sub/notes.md',
            size: 6,
            overwrite: true
        })
    })

    test('uploads into the directory picked in the tree', async ({ page }) => {
        await gotoFixture(page)

        // The tree lists a `src` directory; its upload action opens the file
        // picker for that directory.
        await expect(page.getByRole('button', { name: 'Upload to src' })).toBeVisible()
        await page.getByRole('button', { name: 'Upload to src' }).click()
        await page.getByRole('menuitem', { name: 'Upload files to src' }).click()

        await inputs(page).nth(0).setInputFiles({
            name: 'app.ts',
            mimeType: 'text/plain',
            buffer: Buffer.from('export const app = 1')
        })

        await expect.poll(async () => (await calls(page)).some((call) => call.method === 'finishWorkspaceUpload'))
            .toBe(true)

        const recorded = await calls(page)
        expect(recorded.find((call) => call.method === 'startWorkspaceUpload')?.args[1]).toEqual({
            path: 'src/app.ts',
            size: 20,
            overwrite: true
        })
    })

    test('shows the progress of the running upload and reports the result', async ({ page }) => {
        await gotoFixture(page)

        await inputs(page).nth(0).setInputFiles({
            name: 'hello.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('hello world')
        })

        await expect(page.getByTestId('toasts')).toContainText('Upload complete')
        await expect(page.getByTestId('toasts')).toContainText('Uploaded 1 file(s).')
    })

    test('reports a refused upload without pretending the file landed', async ({ page }) => {
        await gotoFixture(page)

        await page.evaluate(() => {
            ;(window as unknown as { __workspaceUploadE2E: Harness }).__workspaceUploadE2E.failWith.startWorkspaceUpload =
                'File already exists'
        })

        await inputs(page).nth(0).setInputFiles({
            name: 'hello.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('hello world')
        })

        await expect(page.getByTestId('toasts')).toContainText('Upload failed')
        await expect(page.getByTestId('toasts')).toContainText('File already exists')

        const recorded = await calls(page)
        expect(recorded.map((call) => call.method)).toEqual(['startWorkspaceUpload'])
    })

    test('drops the partial file when a chunk fails', async ({ page }) => {
        await gotoFixture(page)

        await page.evaluate(() => {
            ;(window as unknown as { __workspaceUploadE2E: Harness }).__workspaceUploadE2E.failWith.appendWorkspaceUpload =
                'Chunk too large'
        })

        await inputs(page).nth(0).setInputFiles({
            name: 'hello.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('hello world')
        })

        await expect(page.getByTestId('toasts')).toContainText('Upload failed')
        await expect(page.getByTestId('toasts')).toContainText('Chunk too large')

        const recorded = await calls(page)
        expect(recorded.map((call) => call.method)).toEqual([
            'startWorkspaceUpload',
            'appendWorkspaceUpload',
            'abortWorkspaceUpload'
        ])
    })
})

test.describe('workspace upload drag and drop', () => {
    /** Drag a file over an element of the fixture. */
    async function dragFileOver(
        page: Page,
        locator: Locator,
        file: { name: string; mimeType: string; content: string }
    ): Promise<void> {
        const element = await locator.elementHandle()
        if (!element) throw new Error('No drop target')
        await page.evaluate(({ file, element }) => {
            const dataTransfer = new DataTransfer()
            dataTransfer.items.add(new File([file.content], file.name, { type: file.mimeType }))
            element.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }))
            element.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }))
        }, { file, element })
    }

    /** Drop a file onto an element of the fixture. */
    async function dropFile(
        page: Page,
        locator: Locator,
        file: { name: string; mimeType: string; content: string }
    ): Promise<void> {
        const element = await locator.elementHandle()
        if (!element) throw new Error('No drop target')
        await page.evaluate(({ file, element }) => {
            const dataTransfer = new DataTransfer()
            dataTransfer.items.add(new File([file.content], file.name, { type: file.mimeType }))
            element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
        }, { file, element })
    }

    test('uploads a file that is dropped on the page', async ({ page }) => {
        await gotoFixture(page)

        const file = { name: 'dropped.txt', mimeType: 'text/plain', content: 'hello world' }
        await dragFileOver(page, page.getByTestId('workspace-upload-fixture'), file)
        await dropFile(page, page.getByTestId('workspace-upload-fixture'), file)

        await expect.poll(async () => (await calls(page)).some((call) => call.method === 'finishWorkspaceUpload'))
            .toBe(true)

        const recorded = await calls(page)
        expect(recorded.find((call) => call.method === 'startWorkspaceUpload')?.args[1]).toEqual({
            path: 'dropped.txt',
            size: 11,
            overwrite: true
        })
    })

    test('uploads a file that is dropped on a directory of the tree', async ({ page }) => {
        await gotoFixture(page)

        // The tree lists a `src` directory; the drop lands in it.
        const file = { name: 'app.ts', mimeType: 'text/plain', content: 'export const app = 1' }
        await dragFileOver(page, page.getByText('src', { exact: true }), file)
        await dropFile(page, page.getByText('src', { exact: true }), file)

        await expect.poll(async () => (await calls(page)).some((call) => call.method === 'finishWorkspaceUpload'))
            .toBe(true)

        const recorded = await calls(page)
        expect(recorded.find((call) => call.method === 'startWorkspaceUpload')?.args[1]).toEqual({
            path: 'src/app.ts',
            size: 20,
            overwrite: true
        })
    })

    test('shows the drop hint while a file is dragged over the page', async ({ page }) => {
        await gotoFixture(page)

        await dragFileOver(page, page.getByTestId('workspace-upload-fixture'), {
            name: 'dropped.txt',
            mimeType: 'text/plain',
            content: 'hello world'
        })

        await expect(page.getByText('Drop files to upload')).toBeVisible()
    })
})
