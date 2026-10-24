/*
 * End-to-end coverage for deleting a file from the workspace of a session
 * through the right-click menu.
 *
 * The delete starts with a native `contextmenu` event: the menu is positioned
 * against the pointer and dismissed by a click outside, and the deletion only
 * happens after a confirmation that names the file. jsdom has no pointer
 * geometry and no native context menu, so it cannot show that the affordance
 * exists and that the confirmation sits between the click and the deletion.
 *
 * These specs drive a real Chromium against
 * `web/e2e-fixtures/workspace-delete-fixture.html` (vite dev), which mounts
 * the production file action menu, the production delete hook and the
 * production confirmation dialog against a stub API that records every call.
 */

import { test, expect, Page } from '@playwright/test'

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
    await page.goto('/e2e-fixtures/workspace-delete-fixture.html')
    await expect(page.getByTestId('workspace-delete-fixture')).toBeVisible()
}

async function calls(page: Page): Promise<RecordedCall[]> {
    return await page.evaluate(
        () => (window as unknown as { __workspaceDeleteE2E: Harness }).__workspaceDeleteE2E.calls.slice()
    )
}

/** Right-click the file row and wait for the action menu. */
async function openFileMenu(page: Page): Promise<void> {
    await page.getByTestId('file-row').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
}

test.describe('workspace delete e2e', () => {
    test('deletes the file after the right-click menu and the confirmation', async ({ page }) => {
        await gotoFixture(page)
        await openFileMenu(page)

        await page.getByRole('menuitem', { name: 'Delete' }).click()

        // The confirmation names the file and waits: nothing is deleted before
        // the user confirms.
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('src/notes.md')
        expect(await calls(page)).toEqual([])

        await dialog.getByRole('button', { name: 'Delete' }).click()

        await expect.poll(async () => (await calls(page)).some((call) => call.method === 'deleteWorkspaceFile'))
            .toBe(true)

        const recorded = await calls(page)
        expect(recorded.find((call) => call.method === 'deleteWorkspaceFile')?.args)
            .toEqual(['e2e-session', 'src/notes.md'])
        // The page refreshes the workspace after the deletion.
        expect(recorded.map((call) => call.method)).toEqual(['deleteWorkspaceFile', 'onDeleted'])
        await expect(page.getByTestId('toasts')).toContainText('Deleted')
    })

    test('keeps the file when the confirmation is cancelled', async ({ page }) => {
        await gotoFixture(page)
        await openFileMenu(page)

        await page.getByRole('menuitem', { name: 'Delete' }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()

        await dialog.getByRole('button', { name: 'Cancel' }).click()

        await expect(dialog).toBeHidden()
        expect(await calls(page)).toEqual([])
    })

    test('names the reason and keeps the dialog open when the deletion is refused', async ({ page }) => {
        await gotoFixture(page)
        await page.evaluate(() => {
            ;(window as unknown as { __workspaceDeleteE2E: Harness }).__workspaceDeleteE2E.failWith.deleteWorkspaceFile =
                'File not found'
        })
        await openFileMenu(page)

        await page.getByRole('menuitem', { name: 'Delete' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Delete' }).click()

        await expect(dialog).toContainText('File not found')
        expect(await calls(page)).toEqual([
            { method: 'deleteWorkspaceFile', args: ['e2e-session', 'src/notes.md'] }
        ])
    })
})
