import { describe, expect, test } from 'bun:test'
import {
    acpModelIdToCliModelId,
    cliModelIdToAcpModelId,
    formatMcodeModelLabel,
    isCliModelId,
    parseCliModelId
} from './mcodeModelId'

describe('acpModelIdToCliModelId', () => {
    test('converts a wire id with a variant', () => {
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3:v:thinking')).toBe('minimax/MiniMax-M3#thinking')
    })

    test('converts a wire id without a variant', () => {
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3:u')).toBe('minimax/MiniMax-M3')
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3.1-Flash:v:')).toBe('minimax/MiniMax-M3.1-Flash')
    })

    test('rejects ids the CLI grammar cannot represent', () => {
        expect(acpModelIdToCliModelId('minimax/MiniMax-M3')).toBeNull()
        expect(acpModelIdToCliModelId('m:pro%2Fvider:model:u')).toBeNull()
        expect(acpModelIdToCliModelId('m:minimax:model:v:variant%23x')).toBeNull()
        expect(acpModelIdToCliModelId('m:minimax:model:v')).toBeNull()
        expect(acpModelIdToCliModelId('')).toBeNull()
        expect(acpModelIdToCliModelId(null)).toBeNull()
    })
})

describe('parseCliModelId', () => {
    test('splits provider, model and variant', () => {
        expect(parseCliModelId('minimax/MiniMax-M3#thinking')).toEqual({
            provider: 'minimax',
            model: 'MiniMax-M3',
            variant: 'thinking'
        })
        expect(parseCliModelId('minimax/MiniMax-M3')).toEqual({
            provider: 'minimax',
            model: 'MiniMax-M3',
            variant: null
        })
    })

    test('splits at the first slash and the last hash', () => {
        expect(parseCliModelId('my provider/model/name#a#b')).toEqual({
            provider: 'my provider',
            model: 'model/name#a',
            variant: 'b'
        })
    })

    test('rejects ids that are not in the CLI grammar', () => {
        expect(parseCliModelId('minimax')).toBeNull()
        expect(parseCliModelId('/model')).toBeNull()
        expect(parseCliModelId('provider/')).toBeNull()
        expect(parseCliModelId('provider/model#')).toBeNull()
        expect(parseCliModelId('')).toBeNull()
        expect(parseCliModelId(null)).toBeNull()
    })
})

describe('cliModelIdToAcpModelId', () => {
    test('converts a model with a variant', () => {
        expect(cliModelIdToAcpModelId('minimax/MiniMax-M3#thinking'))
            .toBe('m:minimax:MiniMax-M3:v:thinking')
    })

    test('converts a model without a variant to the empty variant form', () => {
        // The agent publishes its own models that way and rejects the `u` form.
        expect(cliModelIdToAcpModelId('minimax/MiniMax-M3')).toBe('m:minimax:MiniMax-M3:v:')
    })

    test('round trips a wire id', () => {
        for (const wireId of [
            'm:minimax:MiniMax-M3:v:thinking',
            'm:minimax:MiniMax-M3.1-Flash:v:'
        ]) {
            const cliId = acpModelIdToCliModelId(wireId)
            expect(cliId).not.toBeNull()
            expect(cliModelIdToAcpModelId(cliId)).toBe(wireId)
        }
    })

    test('encodes the segments', () => {
        expect(cliModelIdToAcpModelId('my provider/model name#thinking hard'))
            .toBe('m:my%20provider:model%20name:v:thinking%20hard')
    })

    test('rejects ids that are not in the CLI grammar', () => {
        expect(cliModelIdToAcpModelId('minimax')).toBeNull()
        expect(cliModelIdToAcpModelId('')).toBeNull()
        expect(cliModelIdToAcpModelId(null)).toBeNull()
    })
})

describe('isCliModelId', () => {
    test('recognizes the CLI grammar', () => {
        expect(isCliModelId('minimax/MiniMax-M3')).toBe(true)
        expect(isCliModelId('minimax/MiniMax-M3#thinking')).toBe(true)
        expect(isCliModelId('m:minimax:MiniMax-M3:v:thinking')).toBe(false)
        expect(isCliModelId('minimax')).toBe(false)
        expect(isCliModelId(null)).toBe(false)
    })
})

describe('formatMcodeModelLabel', () => {
    test('renders the model name and its variant', () => {
        expect(formatMcodeModelLabel('m:minimax:MiniMax-M3.1-Flash:v:thinking'))
            .toBe('MiniMax-M3.1-Flash · thinking')
        expect(formatMcodeModelLabel('m:minimax:MiniMax-M3.1-Flash:v:'))
            .toBe('MiniMax-M3.1-Flash')
    })

    test('returns null for anything that is not a MiniMax Code model id', () => {
        expect(formatMcodeModelLabel('gpt-5.4')).toBeNull()
        expect(formatMcodeModelLabel('minimax/MiniMax-M3')).toBeNull()
        expect(formatMcodeModelLabel(null)).toBeNull()
    })
})
