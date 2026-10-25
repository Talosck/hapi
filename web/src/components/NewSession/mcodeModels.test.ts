import { describe, expect, it } from 'vitest'
import {
    buildMcodeModelOptions,
    buildMcodeSessionModelOptions,
    shouldEnableMcodeModelDiscovery,
    shouldResetMcodeModel
} from './mcodeModels'

describe('MiniMax Code model reset', () => {
    const base = {
        agent: 'mcode' as const,
        cwdExists: true as boolean | undefined,
        isLoading: false,
        error: null as string | null,
        availableModels: [{ modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' }],
        model: 'm:minimax:MiniMax-M3:u'
    }

    it('resets a model the agent does not publish', () => {
        expect(shouldResetMcodeModel(base)).toBe(true)
    })

    it('keeps a model the agent publishes', () => {
        expect(shouldResetMcodeModel({ ...base, model: 'm:minimax:MiniMax-M3:v:' })).toBe(false)
    })

    it('keeps the default selection', () => {
        expect(shouldResetMcodeModel({ ...base, model: 'auto' })).toBe(false)
    })

    it('keeps the selection while the catalog is still loading', () => {
        expect(shouldResetMcodeModel({ ...base, isLoading: true })).toBe(false)
    })

    it('keeps the selection when the catalog failed to load', () => {
        expect(shouldResetMcodeModel({ ...base, error: 'boom' })).toBe(false)
    })

    it('keeps the selection when the agent published no model at all', () => {
        // An empty catalog means the agent has no model picker, not that the
        // selection is wrong — the effort reset keeps the same guard.
        expect(shouldResetMcodeModel({ ...base, availableModels: [] })).toBe(false)
    })

    it('ignores other agents', () => {
        expect(shouldResetMcodeModel({ ...base, agent: 'claude' })).toBe(false)
    })
})

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
            // A model without a name still gets a readable label - the wire id
            // is never what the user reads.
            { value: 'm:minimax:MiniMax-M3:v:', label: 'MiniMax-M3' },
            { value: 'm:minimax:MiniMax-M3:v:thinking', label: 'M3 · thinking' }
        ])
    })
})

describe('MiniMax Code session options', () => {
    it('offers the agent default as null', () => {
        // The picker of a running session sends the value it holds, and the
        // hub records `null` for a session that runs on the agent's default
        // model. The form's 'auto' is a name the agent cannot resolve.
        expect(buildMcodeSessionModelOptions([
            { modelId: 'm:minimax:MiniMax-M3:v:' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'm:minimax:MiniMax-M3:v:', label: 'MiniMax-M3' }
        ])
    })

    it('shows the same models as the create-session form', () => {
        const models = [{ modelId: 'm:minimax:MiniMax-M3:v:' }]
        expect(buildMcodeSessionModelOptions(models).slice(1))
            .toEqual(buildMcodeModelOptions(models).slice(1))
    })
})
