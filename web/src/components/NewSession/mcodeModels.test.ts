import { describe, expect, it } from 'vitest'
import {
    buildMcodeModelOptions,
    shouldEnableMcodeModelDiscovery
} from './mcodeModels'

describe('MiniMax Code Create-session options', () => {
    it('enables model discovery only for an existing cwd on the target machine', () => {
        const args = {
            agent: 'mcode' as const,
            machineId: 'machine-1',
            cwd: '/home/user/project',
            cwdExists: true,
        }

        expect(shouldEnableMcodeModelDiscovery(args)).toBe(true)
        expect(shouldEnableMcodeModelDiscovery({ ...args, cwdExists: undefined })).toBe(false)
        expect(shouldEnableMcodeModelDiscovery({ ...args, cwdExists: false })).toBe(false)
        expect(shouldEnableMcodeModelDiscovery({ ...args, agent: 'claude' })).toBe(false)
    })

    it('shows Default plus every discovered model', () => {
        expect(buildMcodeModelOptions([
            { modelId: 'm:minimax:MiniMax-M3:v:' },
            { modelId: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' }
        ])).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'm:minimax:MiniMax-M3:v:', label: 'm:minimax:MiniMax-M3:v:' },
            { value: 'm:minimax:MiniMax-M3:v:thinking', label: 'M3 · thinking' }
        ])
    })
})
