import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './en'

/**
 * Every `t('...')` call site must name a key the english locale defines.
 *
 * The locale parity test compares the locales with each other, so a key that
 * is missing from *all* of them passes it. `t()` then falls back to the key
 * itself and the screen shows `chat.sendError.aborted` to the user.
 *
 * Only string literals are checked: a key built at runtime (`t(\`a.${b}\`)`)
 * cannot be resolved statically, and a dynamic key is the caller's business.
 */
const SRC_ROOT = join(import.meta.dirname, '..', '..')

function sourceFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            found.push(...sourceFiles(full))
            continue
        }
        if (!/\.tsx?$/.test(entry)) continue
        if (/\.test\.tsx?$/.test(entry)) continue
        if (/\.d\.ts$/.test(entry)) continue
        found.push(full)
    }
    return found
}

/** The literal keys of every `t('...')` / `t("...")` call in a file. */
function literalKeysIn(source: string): string[] {
    const keys: string[] = []
    const pattern = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g
    for (const match of source.matchAll(pattern)) {
        keys.push(match[2])
    }
    return keys
}

describe('i18n call sites', () => {
    it('every literal t() call names a key the english locale defines', () => {
        const missing: string[] = []
        for (const file of sourceFiles(SRC_ROOT)) {
            const keys = literalKeysIn(readFileSync(file, 'utf8'))
            for (const key of keys) {
                if (!(key in en)) {
                    missing.push(`${relative(SRC_ROOT, file)}: ${key}`)
                }
            }
        }
        expect(missing).toEqual([])
    })
})
