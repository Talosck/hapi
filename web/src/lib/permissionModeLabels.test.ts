import { describe, expect, it } from 'vitest'
import { permissionModeLabelForAgent } from './permissionModeLabels'

const t = (key: string) => key

describe('permissionModeLabelForAgent', () => {
    it('uses the words of the agent that runs the mode', () => {
        // MiniMax Code calls its modes Ask, Auto and Full access. "Yolo" is
        // the wording of another agent.
        expect(permissionModeLabelForAgent({ mode: 'default', agent: 'mcode', t }))
            .toBe('permissionMode.ask')
        expect(permissionModeLabelForAgent({ mode: 'auto', agent: 'mcode', t }))
            .toBe('permissionMode.auto')
        expect(permissionModeLabelForAgent({ mode: 'bypassPermissions', agent: 'mcode', t }))
            .toBe('permissionMode.fullAccess')
        expect(permissionModeLabelForAgent({ mode: 'plan', agent: 'mcode', t }))
            .toBe('permissionMode.plan')
    })

    it('leaves the other agents with their own labels', () => {
        expect(permissionModeLabelForAgent({ mode: 'bypassPermissions', agent: 'codex', t }))
            .toBe('Yolo')
        expect(permissionModeLabelForAgent({ mode: 'default', agent: undefined, t }))
            .toBe('Default')
    })
})
