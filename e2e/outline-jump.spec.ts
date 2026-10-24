import { expect as baseExpect, test, type Page } from '@playwright/test'

// The outline covers the whole session, but the transcript only holds a
// bounded window of it. Opening a prompt that the window does not hold has to
// load the page around that message and scroll to it.

test.setTimeout(90_000)
const expect = baseExpect.configure({ timeout: 20_000 })

const ANCHOR = '[id="hapi-message-user-text:m-5"]'

async function openFixture(page: Page) {
    await page.goto('/e2e-fixtures/outline-jump-fixture.html')
    const viewport = page.locator('.chat-scroll-y')
    await expect(viewport).toBeVisible()
    // Wait for the initial tail sync and the initial scroll-settling window.
    await page.waitForTimeout(3500)
    return viewport
}

test('opening an old prompt loads the page around it and scrolls to it', async ({ page }) => {
    await openFixture(page)

    const outline = page.getByRole('complementary', { name: 'Outline' })
    await expect(outline).toBeVisible()

    // The prompt is far outside the loaded window, but the outline lists it.
    const oldPrompt = outline.getByRole('button', { name: /Fixture message 5$/ })
    await expect(oldPrompt).toBeVisible()

    await oldPrompt.click()

    // The hub served the page around the message.
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'around').length
    )).toBe(1)
    expect(await page.evaluate(() =>
        window.__probe.requests.find((request) => request.direction === 'around')?.messageId ?? null
    )).toBe('m-5')

    // The window was swapped to that page: the prompt is rendered and the
    // tail of the conversation is not.
    const transcript = page.locator('.happy-thread-messages')
    await expect(page.locator(ANCHOR)).toBeVisible()
    await expect(transcript.getByText('Fixture message 5', { exact: true })).toBeVisible()
    await expect(transcript.getByText('Fixture message 1200', { exact: true })).toHaveCount(0)

    // The prompt ended up at the top of the viewport.
    await expect.poll(async () => await page.evaluate(() => {
        const viewport = document.querySelector('.chat-scroll-y') as HTMLElement
        const anchor = document.getElementById('hapi-message-user-text:m-5')
        if (!anchor) return null
        return Math.round(anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top)
    })).toBeLessThan(40)
})

test('the window stays on the opened message while the tail keeps arriving', async ({ page }) => {
    await openFixture(page)

    const outline = page.getByRole('complementary', { name: 'Outline' })
    await expect(outline).toBeVisible()
    await outline.getByRole('button', { name: /Fixture message 5$/ }).click()
    await expect(page.locator(ANCHOR)).toBeVisible()

    const pinned = await page.evaluate(() => window.__probe.windowState())
    expect(pinned.pinnedMessageId).toBe('m-5')

    // A message that arrives while the operator reads the opened one must not
    // replace the window.
    await page.evaluate(() => window.__probe.pushIncoming(1201))
    await page.waitForTimeout(1000)

    const after = await page.evaluate(() => window.__probe.windowState())
    expect(after.pinnedMessageId).toBe('m-5')
    expect(after.newestSeq).toBe(pinned.newestSeq)
    await expect(page.locator('.happy-thread-messages').getByText('Fixture message 1201', { exact: true })).toHaveCount(0)
})

test('a prompt that is already on screen does not load another page', async ({ page }) => {
    await openFixture(page)

    const outline = page.getByRole('complementary', { name: 'Outline' })
    await expect(outline).toBeVisible()

    // The newest prompt is part of the loaded window.
    await outline.getByRole('button', { name: /Fixture message 1200$/ }).click()

    await expect(page.locator('[id="hapi-message-user-text:m-1200"]')).toBeVisible()
    expect(await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'around').length
    )).toBe(0)
})
