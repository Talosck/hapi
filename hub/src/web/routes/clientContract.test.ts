import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every MiniMax Code route the hub serves has to be in the client contract.
 *
 * The contract is the spec the native clients are written against, so a route
 * that is not in it is an endpoint a client cannot know about. The mcode
 * routes are the ones this guard covers: the goal, the delegation and the two
 * catalogs.
 *
 * The paths of a table row are written with a shared prefix - the row for the
 * catalogs names `/api/sessions/:id/codex-models` and then the other flavors
 * by their tail - so the tails are expanded here as well.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const ROUTES_DIR = join(REPO_ROOT, 'hub', 'src', 'web', 'routes')
const CONTRACT_DIR = join(REPO_ROOT, 'docs', 'api', 'client-contract')

/** The parameter names differ between the hub and the doc; compare the shape. */
function normalize(path: string): string {
    return path.replace(/:[a-zA-Z_]+/g, ':p')
}

function sourceFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            found.push(...sourceFiles(full))
            continue
        }
        if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full)
    }
    return found
}

function hubRoutes(): string[] {
    const routes: string[] = []
    for (const file of sourceFiles(ROUTES_DIR)) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
            routes.push(`/api${match[1]}`)
        }
    }
    return routes
}

/** The paths the contract names, with the shared prefixes of a row expanded. */
function documentedPaths(): Set<string> {
    const covered = new Set<string>()
    for (const doc of readdirSync(CONTRACT_DIR).filter((file) => file.endsWith('.md'))) {
        for (const line of readFileSync(join(CONTRACT_DIR, doc), 'utf8').split('\n')) {
            if (!line.includes('/api/')) continue
            const paths = [...line.matchAll(/\/api\/[a-zA-Z0-9:_\-/]*/g)].map((match) => match[0])
            for (const path of paths) covered.add(normalize(path))
            const first = paths[0]
            if (!first) continue
            const base = first.includes('/:p')
                ? first.slice(0, first.indexOf('/:p') + 3)
                : first.replace(/\/[a-zA-Z0-9:_-]*$/, '')
            for (const match of line.matchAll(/,?\s*`?(\/[a-zA-Z0-9:_\-/]+)/g)) {
                if (match[1] === first) continue
                covered.add(normalize(base + match[1]))
            }
        }
    }
    return covered
}

describe('the client contract', () => {
    it('names every MiniMax Code route the hub serves', () => {
        const documented = documentedPaths()
        const missing = hubRoutes()
            .filter((route) => route.includes('mcode'))
            .filter((route) => !documented.has(normalize(route)))
            .sort()

        expect(missing).toEqual([])
    })
})
