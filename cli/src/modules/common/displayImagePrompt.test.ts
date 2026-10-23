import { describe, expect, it } from 'vitest'
import {
    DISPLAY_IMAGE_PROMPT_CLAUDE,
    DISPLAY_IMAGE_PROMPT_CODEX,
    DISPLAY_IMAGE_PROMPT_CURSOR,
    DISPLAY_IMAGE_PROMPT_HAPI_MCP,
    DISPLAY_MEDIA_PROMPT_CURSOR,
    DISPLAY_VIDEO_PROMPT_CURSOR,
} from './displayImagePrompt'

const displayImagePrompts = [
    DISPLAY_IMAGE_PROMPT_CLAUDE,
    DISPLAY_IMAGE_PROMPT_CODEX,
    DISPLAY_IMAGE_PROMPT_HAPI_MCP,
    DISPLAY_IMAGE_PROMPT_CURSOR,
]

describe('display_image prompt semantics', () => {
    it('describes image display as agent-to-user output, not model image input', () => {
        for (const prompt of displayImagePrompts) {
            expect(prompt).toContain('human user')
            expect(prompt).toContain('absolute filesystem path')
            expect(prompt).toContain('sends the image to the human user')
            expect(prompt).toContain('does not provide image input to the model')
            expect(prompt).toContain('cannot be used to read, inspect, or analyze image contents')
        }
    })

    it('keeps each agent flavor instruction pointed at the corresponding tool alias', () => {
        expect(DISPLAY_IMAGE_PROMPT_CLAUDE).toContain('mcp__hapi__display_image')
        expect(DISPLAY_IMAGE_PROMPT_CODEX).toContain('functions.hapi__display_image')
        expect(DISPLAY_IMAGE_PROMPT_HAPI_MCP).toContain('hapi_display_image')
        expect(DISPLAY_IMAGE_PROMPT_CURSOR).toContain('"display_image"')
    })

    it('tells the agent that the card is the way to deliver a file', () => {
        // MiniMax Code declares the files it hands over in a `<deliver-assets>`
        // block in its answer, because the MiniMax Code apps render that
        // block. HAPI does not, so the tool description has to say so.
        for (const prompt of [DISPLAY_IMAGE_PROMPT_CURSOR, DISPLAY_VIDEO_PROMPT_CURSOR, DISPLAY_MEDIA_PROMPT_CURSOR]) {
            expect(prompt).toContain('"<deliver-assets>"')
            expect(prompt).toContain('the card is the way to deliver a file')
        }
    })
})
