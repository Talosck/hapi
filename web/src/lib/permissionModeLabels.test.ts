import { describe, expect, it } from 'vitest'
import { PERMISSION_MODE_FLAVOR_LABEL_KEYS } from '@hapi/protocol'
import { permissionModeLabelForAgent } from './permissionModeLabels'
import en from './locales/en'

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

    it('takes the wording from the shared catalog, not from a list of its own', () => {
        // A flavor that names its modes has to say so in the shared catalog,
        // so the web, the native clients and the protocol cannot drift apart.
        // The web only translates the wording - it does not decide which mode
        // of which agent is called what.
        expect(PERMISSION_MODE_FLAVOR_LABEL_KEYS.mcode).toEqual({
            default: 'permissionMode.ask',
            auto: 'permissionMode.auto',
            bypassPermissions: 'permissionMode.fullAccess',
            plan: 'permissionMode.plan'
        })
    })

    it('names keys the locale defines', () => {
        // The key reaches `t()` as a value, so the scan that checks the
        // literal call sites cannot see it. A key that no locale defines
        // falls back to the key itself, and the user reads
        // `permissionMode.ask` instead of a word.
        for (const keys of Object.values(PERMISSION_MODE_FLAVOR_LABEL_KEYS)) {
            for (const key of Object.values(keys)) {
                expect(key in en).toBe(true)
            }
        }
    })
})
