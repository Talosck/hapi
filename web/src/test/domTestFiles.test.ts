import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOM_TEST_FILES } from './domTestFiles'

/**
 * The two environments of the web suite have to cover every test file.
 *
 * A file that is in neither project would not run at all, and the suite
 * would report green without it. A file that needs a browser and is not
 * listed in `DOM_TEST_FILES` runs in the node environment and fails with
 * `window is not defined`, which says what to do.
 *
 * A listed file that no longer needs a browser is the harmless kind of
 * stale: it still passes, it only keeps the suite slower.
 */
const SRC_ROOT = join(import.meta.dirname, '..', '..')

function testFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            found.push(...testFiles(full))
            continue
        }
        if (/\.test\.tsx?$/.test(entry)) found.push(relative(SRC_ROOT, full))
    }
    return found
}

describe('the list of the test files that need a browser', () => {
    it('names files that exist', () => {
        const missing = DOM_TEST_FILES.filter((file) => !existsSync(join(SRC_ROOT, file)))
        expect(missing).toEqual([])
    })

    it('names no file twice', () => {
        const seen = new Set<string>()
        const twice: string[] = []
        for (const file of DOM_TEST_FILES) {
            if (seen.has(file)) twice.push(file)
            seen.add(file)
        }
        expect(twice).toEqual([])
    })

    it('leaves no test file without an environment', () => {
        // A `.test.ts` file that is not listed runs in the node project, a
        // `.test.tsx` file runs in the browser project. A file that is
        // neither - a `.spec.ts`, say - would not run at all, and the suite
        // would report green without it.
        const listed = new Set(DOM_TEST_FILES)
        const orphans = testFiles(SRC_ROOT).filter((file) => {
            if (file.endsWith('.test.tsx')) return false
            if (listed.has(file)) return false
            return !file.endsWith('.test.ts')
        })
        expect(orphans).toEqual([])
    })

    it('runs every listed file in the browser project only', () => {
        // The node project takes every `.test.ts` file and leaves the list
        // out, so a listed file must not be a `.test.tsx` file - that one is
        // in the browser project by the glob of its extension, and it would
        // run twice.
        const listedTwice = DOM_TEST_FILES.filter((file) => file.endsWith('.test.tsx'))
        expect(listedTwice).toEqual([])
    })
})
