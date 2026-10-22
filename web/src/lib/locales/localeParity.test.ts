import { describe, expect, it } from 'vitest'
import en from './en'
import ru from './ru'
import zhCN from './zh-CN'

/**
 * The locales must define every key the english locale defines.
 *
 * A key that only exists in `en` falls back to the key itself, so the UI
 * shows `tool.goal.create_goal` instead of a sentence. Nothing else catches
 * that, which is how the goal tool card ended up untranslated in Russian
 * while the goal panel next to it was translated.
 *
 * Extra keys are not checked: a locale may keep a string for a feature that
 * no longer exists, and that is dead text rather than a broken screen.
 */
describe('locale key parity', () => {
    const locales = { en, 'zh-CN': zhCN, ru }

    for (const [name, locale] of Object.entries(locales)) {
        it(`${name} defines every key of the english locale`, () => {
            const missing = Object.keys(en).filter((key) => !(key in locale))
            expect(missing).toEqual([])
        })
    }
})
