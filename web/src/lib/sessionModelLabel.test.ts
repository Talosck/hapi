import { describe, expect, it } from 'vitest'
import { getSessionModelLabel } from './sessionModelLabel'

describe('getSessionModelLabel', () => {
    it('prefers the explicit session model', () => {
        expect(getSessionModelLabel({ model: 'gpt-5.4' })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.4'
        })
    })

    it('renders friendly labels for known Claude aliases', () => {
        expect(getSessionModelLabel({ model: 'opus' })).toEqual({
            key: 'session.item.model',
            value: 'Opus'
        })
    })

    it('renders a MiniMax Code wire model id as a readable label', () => {
        expect(getSessionModelLabel({ model: 'm:minimax:MiniMax-M3.1-Flash:v:thinking' })).toEqual({
            key: 'session.item.model',
            value: 'MiniMax-M3.1-Flash · thinking'
        })
        expect(getSessionModelLabel({ model: 'm:minimax:MiniMax-M3.1-Flash:v:' })).toEqual({
            key: 'session.item.model',
            value: 'MiniMax-M3.1-Flash'
        })
    })

    it('returns null when no model is available', () => {
        expect(getSessionModelLabel({})).toBeNull()
    })
})
