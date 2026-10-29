import { describe, expect, it, test } from 'bun:test'
import {
    AGENT_FLAVORS,
    AgentFlavorSchema,
    CREATABLE_AGENT_FLAVORS,
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    getPermissionModeTone,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
    isSteeringSupportedForFlavor,
    isSteeringSupportedForSession,
    PERMISSION_MODE_FLAVOR_LABEL_KEYS,
    PERMISSION_MODE_FLAVOR_LABELS,
    STEERING_SUPPORTED_FLAVORS,
} from './modes'

describe('Gemini CLI sunset (read-only, not creatable)', () => {
    test('gemini stays a valid flavor so existing stored sessions still validate/load', () => {
        expect(AGENT_FLAVORS).toContain('gemini')
        expect(AgentFlavorSchema.safeParse('gemini').success).toBe(true)
    })

    test('gemini is excluded from creatable flavors (not offered for new sessions)', () => {
        expect(CREATABLE_AGENT_FLAVORS).not.toContain('gemini')
    })

    test('all other flavors remain creatable', () => {
        for (const flavor of AGENT_FLAVORS) {
            if (flavor === 'gemini') continue
            expect(CREATABLE_AGENT_FLAVORS).toContain(flavor)
        }
    })
})

describe('getPermissionModesForFlavor', () => {
    test("returns the conservative Grok modes", () => {
        expect(getPermissionModesForFlavor('grok')).toEqual([
            'default',
            'auto',
            'plan',
            'bypassPermissions'
        ])
    })

    test("returns no HAPI mode selector for DSH's server-owned permission policy", () => {
        expect(getPermissionModesForFlavor('dsh')).toEqual([])
    })

    test("returns [] for flavor 'pi' (RPC mode has no runtime permission switching)", () => {
        expect(getPermissionModesForFlavor('pi')).toEqual([])
    })

    test('returns the MiniMax Code native permission policy plus plan mode', () => {
        expect(getPermissionModesForFlavor('mcode')).toEqual([
            'default',
            'auto',
            'bypassPermissions',
            'plan'
        ])
    })

    test('allows every MiniMax Code mode for the mcode flavor only', () => {
        for (const mode of getPermissionModesForFlavor('mcode')) {
            expect(isPermissionModeAllowedForFlavor(mode, 'mcode')).toBe(true)
        }
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'kimi')).toBe(false)
    })

    test("returns [] for pi and does not fall back to Claude modes", () => {
        // Ensure Pi is opt-in empty, not silently inheriting Claude defaults.
        expect(getPermissionModesForFlavor('pi')).not.toEqual(getPermissionModesForFlavor('claude'))
        expect(getPermissionModesForFlavor('pi')).not.toEqual(getPermissionModesForFlavor(null))
    })

    test("unknown flavors fall back to Claude modes, not Pi's empty list", () => {
        expect(getPermissionModesForFlavor(null)).not.toEqual([])
        expect(getPermissionModesForFlavor(undefined)).not.toEqual([])
        expect(getPermissionModesForFlavor('PI')).not.toEqual([])
        expect(getPermissionModesForFlavor('Pi')).not.toEqual([])
    })
})

describe('isPermissionModeAllowedForFlavor', () => {
    test("allows only the supported Grok modes", () => {
        expect(isPermissionModeAllowedForFlavor('default', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('plan', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'grok')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('yolo', 'grok')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('read-only', 'dsh')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('plan', 'dsh')).toBe(false)
    })

    test("no mode is allowed for pi", () => {
        expect(isPermissionModeAllowedForFlavor('yolo', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('default', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('plan', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('read-only', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('safe-yolo', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('ask', 'pi')).toBe(false)
    })

    test("cursor includes autoReview", () => {
        expect(getPermissionModesForFlavor('cursor')).toContain('autoReview')
        expect(getPermissionModeLabel('autoReview')).toBe('Auto')
        expect(getPermissionModeTone('autoReview')).toBe('warning')
        expect(isPermissionModeAllowedForFlavor('autoReview', 'cursor')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('autoReview', 'claude')).toBe(false)
    })

    test("codex offers autoReview at launch and mid-session", () => {
        expect(getPermissionModesForFlavor('codex')).toEqual(['default', 'read-only', 'autoReview', 'yolo'])
        expect(isPermissionModeAllowedForFlavor('autoReview', 'codex')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('autoReview', 'gemini')).toBe(false)
    })
})

describe('getPermissionModeLabel', () => {
    test("yolo label is 'Yolo'", () => {
        expect(getPermissionModeLabel('yolo')).toBe('Yolo')
    })

    test("default label is 'Default'", () => {
        expect(getPermissionModeLabel('default')).toBe('Default')
    })

    test('uses the wording of the agent that runs the mode', () => {
        // MiniMax Code calls its modes Ask, Auto and Full access. "Yolo" is
        // the wording of another agent, and a user who reads "Yolo" in HAPI
        // and "Ask" in the agent's own window has to work out that both mean
        // the same thing.
        expect(getPermissionModeLabel('default', 'mcode')).toBe('Ask')
        expect(getPermissionModeLabel('auto', 'mcode')).toBe('Auto')
        expect(getPermissionModeLabel('bypassPermissions', 'mcode')).toBe('Full access')
        expect(getPermissionModeLabel('plan', 'mcode')).toBe('Plan')
    })

    test('leaves the other agents with the shared wording', () => {
        expect(getPermissionModeLabel('bypassPermissions', 'codex')).toBe('Yolo')
        expect(getPermissionModeLabel('bypassPermissions', 'claude')).toBe('Yolo')
        expect(getPermissionModeLabel('default', undefined)).toBe('Default')
    })
})

describe('the wording of an agent that names its modes', () => {
    test('names the same modes in the english text and in the localization key', () => {
        // The english text is what the native clients print, the key is what
        // the web translates. A mode that is in one and not in the other
        // would leave a client without a wording for it, so the two catalogs
        // have to hold the same modes.
        for (const flavor of Object.keys(PERMISSION_MODE_FLAVOR_LABELS)) {
            expect(Object.keys(PERMISSION_MODE_FLAVOR_LABEL_KEYS[flavor] ?? {}).sort())
                .toEqual(Object.keys(PERMISSION_MODE_FLAVOR_LABELS[flavor] ?? {}).sort())
        }
    })

    test('gives every mode of the flavor a key the web can translate', () => {
        const keys = PERMISSION_MODE_FLAVOR_LABEL_KEYS.mcode ?? {}
        for (const [mode, key] of Object.entries(keys)) {
            expect(key).toStartWith('permissionMode.')
            expect(mode).toBeTruthy()
        }
    })
})

describe('getPermissionModeOptionsForFlavor', () => {
    test("returns [] for pi (no permission options offered)", () => {
        expect(getPermissionModeOptionsForFlavor('pi')).toEqual([])
    })

    test('labels the MiniMax Code options the way the agent names them', () => {        const options = getPermissionModeOptionsForFlavor('mcode')
        expect(options.map((option) => option.label)).toEqual([
            'Ask',
            'Auto',
            'Full access',
            'Plan'
        ])
    })

    test('keeps the shared labels for the other agents', () => {
        const options = getPermissionModeOptionsForFlavor('claude')
        expect(options.find((option) => option.mode === 'bypassPermissions')?.label).toBe('Yolo')
    })
})

describe('getPermissionModeTone', () => {
    test("yolo tone is danger", () => {
        expect(getPermissionModeTone('yolo')).toBe('danger')
    })

    test("default tone is neutral", () => {
        expect(getPermissionModeTone('default')).toBe('neutral')
    })
})

describe('claude auto permission mode', () => {
    it('is allowed for claude only', () => {
        expect(isPermissionModeAllowedForFlavor('auto', 'claude')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('auto', 'codex')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'gemini')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'cursor')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'opencode')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'kimi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'pi')).toBe(false)
    })

    it('has a label and tone', () => {
        expect(getPermissionModeLabel('auto')).toBe('Auto')
        expect(getPermissionModeTone('auto')).toBe('warning')
    })
})

describe('isSteeringSupportedForFlavor', () => {
    it('supports codex, cursor, pi and mcode', () => {
        expect(isSteeringSupportedForFlavor('codex')).toBe(true)
        expect(isSteeringSupportedForFlavor('cursor')).toBe(true)
        expect(isSteeringSupportedForFlavor('pi')).toBe(true)
        expect(isSteeringSupportedForFlavor('mcode')).toBe(true)
        expect(isSteeringSupportedForFlavor('claude')).toBe(false)
        expect(isSteeringSupportedForFlavor('opencode')).toBe(false)
        expect(isSteeringSupportedForFlavor(undefined)).toBe(false)
        expect(isSteeringSupportedForFlavor(null)).toBe(false)
    })
})

describe('isSteeringSupportedForSession', () => {
    it('supports codex, pi and mcode sessions', () => {
        expect(isSteeringSupportedForSession({ flavor: 'codex' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'pi' })).toBe(true)
        // MiniMax Code steers into the running ACP prompt turn.
        expect(isSteeringSupportedForSession({ flavor: 'mcode' })).toBe(true)
    })

    it('supports Cursor ACP sessions', () => {
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionProtocol: 'acp',
            cursorSessionId: 'sess-1',
        })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'cursor' })).toBe(true)
    })

    it('rejects legacy Cursor stream-json sessions', () => {
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionProtocol: 'stream-json',
            cursorSessionId: 'legacy-1',
        })).toBe(false)
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionId: 'legacy-without-protocol',
        })).toBe(false)
    })

    it('rejects non-steerable flavors', () => {
        expect(isSteeringSupportedForSession({ flavor: 'claude' })).toBe(false)
        expect(isSteeringSupportedForSession(null)).toBe(false)
    })

    it('follows the flavor whitelist instead of a second list', () => {
        // The session gate used to hardcode 'codex' | 'pi' | 'mcode', so a
        // flavor added to the whitelist did nothing. Now every flavor on the
        // whitelist steers, except the ones with a per-session condition.
        for (const flavor of STEERING_SUPPORTED_FLAVORS) {
            if (flavor === 'cursor') continue
            expect(isSteeringSupportedForSession({ flavor })).toBe(true)
        }
        expect(isSteeringSupportedForSession({ flavor: 'claude' })).toBe(false)
    })
})
