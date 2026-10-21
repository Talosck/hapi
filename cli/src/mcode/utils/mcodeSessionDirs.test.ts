import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createMcodeSessionDirResolver,
    findMcodeSessionDir,
    findMcodeSessionDirFromIndex,
    findMcodeSessionDirInDayDirs,
    listMcodeSessionDayDirs,
    mcodeSessionDirSuffix,
    type McodeSessionIndexReader
} from './mcodeSessionDirs';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-mcode-dirs-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type DayParts = { year: string; month: string; day: string };

/** The dated directory name mcode uses for a session. */
function dayParts(date: Date): DayParts {
    return {
        year: String(date.getFullYear()),
        month: String(date.getMonth() + 1).padStart(2, '0'),
        day: String(date.getDate()).padStart(2, '0')
    };
}

function dayDirPath(dataDir: string, day: DayParts): string {
    return join(dataDir, 'v2', 'sessions', day.year, day.month, day.day);
}

/** `<dataDir>/v2/sessions/<year>/<month>/<day>/<time>-session_<id>/`. */
function sessionDirPath(dataDir: string, day: DayParts, sessionId: string, time = '12-34-56-789'): string {
    return join(dayDirPath(dataDir, day), `${time}-${mcodeSessionDirSuffix(sessionId)}`);
}

async function createSessionDir(dataDir: string, day: DayParts, sessionId: string): Promise<string> {
    const dir = sessionDirPath(dataDir, day, sessionId);
    await mkdir(dir, { recursive: true });
    return dir;
}

/** An index reader that always misses, standing in for an absent runtime index. */
const emptyIndex: McodeSessionIndexReader = async () => null;

describe('findMcodeSessionDirFromIndex', () => {
    it('resolves the dated directory from the runtime index', async () => {
        const dataDir = await createTempDir();
        const relativeDir = '2026/10/20/09-20-41-291-session_bXZzX2E5';
        await mkdir(join(dataDir, 'v2', 'sessions', relativeDir), { recursive: true });
        const readRelativeDir = vi.fn(async () => relativeDir);

        await expect(findMcodeSessionDirFromIndex('mvs_1', dataDir, readRelativeDir))
            .resolves.toBe(join(dataDir, 'v2', 'sessions', relativeDir));
        expect(readRelativeDir).toHaveBeenCalledWith('mvs_1', dataDir);
    });

    it('ignores an index entry that points at a directory that no longer exists', async () => {
        const dataDir = await createTempDir();
        const readRelativeDir = vi.fn(async () => '2026/10/20/09-20-41-291-session_gone');

        await expect(findMcodeSessionDirFromIndex('mvs_1', dataDir, readRelativeDir))
            .resolves.toBeNull();
    });

    it('reports a missing index entry as not found', async () => {
        const dataDir = await createTempDir();
        await expect(findMcodeSessionDirFromIndex('mvs_1', dataDir, async () => null))
            .resolves.toBeNull();
    });

    it('does not throw when the index reader fails', async () => {
        const dataDir = await createTempDir();
        const readRelativeDir: McodeSessionIndexReader = async () => {
            throw new Error('database is locked');
        };
        await expect(findMcodeSessionDirFromIndex('mvs_1', dataDir, readRelativeDir))
            .resolves.toBeNull();
    });
});

describe('listMcodeSessionDayDirs', () => {
    it('lists the dated directories newest first', async () => {
        const dataDir = await createTempDir();
        for (const day of [
            { year: '2026', month: '01', day: '05' },
            { year: '2026', month: '11', day: '30' },
            { year: '2026', month: '02', day: '09' }
        ]) {
            await mkdir(dayDirPath(dataDir, day), { recursive: true });
        }

        const dayDirs = await listMcodeSessionDayDirs(dataDir);
        expect(dayDirs.map((dir) => dir.split(/[\\/]/).slice(-3).join('/'))).toEqual([
            '2026/11/30',
            '2026/02/09',
            '2026/01/05'
        ]);
    });

    it('returns nothing when the sessions tree is missing', async () => {
        const dataDir = await createTempDir();
        await expect(listMcodeSessionDayDirs(dataDir)).resolves.toEqual([]);
    });
});

describe('findMcodeSessionDirInDayDirs', () => {
    it('finds the session directory inside the given dated directories', async () => {
        const dataDir = await createTempDir();
        const day = { year: '2026', month: '10', day: '20' };
        const expected = await createSessionDir(dataDir, day, 'mvs_target');
        await createSessionDir(dataDir, day, 'mvs_other');

        const dayDirs = await listMcodeSessionDayDirs(dataDir);
        await expect(findMcodeSessionDirInDayDirs('mvs_target', dayDirs)).resolves.toBe(expected);
        await expect(findMcodeSessionDirInDayDirs('mvs_missing', dayDirs)).resolves.toBeNull();
    });
});

describe('findMcodeSessionDir', () => {
    it('prefers the runtime index over the dated tree', async () => {
        const dataDir = await createTempDir();
        const treeDay = { year: '2026', month: '10', day: '20' };
        const treeDir = await createSessionDir(dataDir, treeDay, 'mvs_target');
        const indexedRelativeDir = '2025/01/02/03-04-05-006-session_x';
        await mkdir(join(dataDir, 'v2', 'sessions', indexedRelativeDir), { recursive: true });

        const readRelativeDir = async () => indexedRelativeDir;
        await expect(findMcodeSessionDir('mvs_target', dataDir, readRelativeDir)).resolves.toBe(
            join(dataDir, 'v2', 'sessions', indexedRelativeDir)
        );
        await expect(findMcodeSessionDir('mvs_target', dataDir, readRelativeDir)).resolves.not.toBe(treeDir);
    });

    it('falls back to the dated tree when the index entry is stale', async () => {
        const dataDir = await createTempDir();
        const day = { year: '2026', month: '10', day: '20' };
        const expected = await createSessionDir(dataDir, day, 'mvs_target');

        // The index still points at a directory mcode removed.
        const readRelativeDir = async () => '2025/01/02/03-04-05-006-session_gone';
        await expect(findMcodeSessionDir('mvs_target', dataDir, readRelativeDir)).resolves.toBe(expected);
    });

    it('falls back to the dated tree when the index has no entry', async () => {
        const dataDir = await createTempDir();
        const day = { year: '2026', month: '10', day: '20' };
        const expected = await createSessionDir(dataDir, day, 'mvs_target');

        await expect(findMcodeSessionDir('mvs_target', dataDir, emptyIndex)).resolves.toBe(expected);
        await expect(findMcodeSessionDir('mvs_missing', dataDir, emptyIndex)).resolves.toBeNull();
    });
});

describe('createMcodeSessionDirResolver', () => {
    it('finds a session that appears in a recent dated directory after the first lookup', async () => {
        const dataDir = await createTempDir();
        const today = dayParts(new Date());
        // The dated directory already exists when the first lookup runs.
        await mkdir(dayDirPath(dataDir, today), { recursive: true });

        const resolver = createMcodeSessionDirResolver({ dataDir, readRelativeDir: emptyIndex });
        await expect(resolver.resolve('mvs_target')).resolves.toBeNull();

        const expected = await createSessionDir(dataDir, today, 'mvs_target');
        await expect(resolver.resolve('mvs_target')).resolves.toBe(expected);
    });

    it('does not search an already searched dated directory outside the recent window again', async () => {
        const dataDir = await createTempDir();
        const oldDay = { year: '2020', month: '01', day: '01' };
        await mkdir(dayDirPath(dataDir, oldDay), { recursive: true });

        const resolver = createMcodeSessionDirResolver({ dataDir, readRelativeDir: emptyIndex });
        await expect(resolver.resolve('mvs_target')).resolves.toBeNull();

        // The old dated directory was already searched, so a session that
        // shows up there later is not picked up again.
        await createSessionDir(dataDir, oldDay, 'mvs_target');
        await expect(resolver.resolve('mvs_target')).resolves.toBeNull();
    });

    it('searches the dated tree again when the session id changes', async () => {
        const dataDir = await createTempDir();
        const day = { year: '2026', month: '10', day: '20' };
        const expected = await createSessionDir(dataDir, day, 'mvs_second');

        const resolver = createMcodeSessionDirResolver({ dataDir, readRelativeDir: emptyIndex });
        await expect(resolver.resolve('mvs_first')).resolves.toBeNull();
        await expect(resolver.resolve('mvs_second')).resolves.toBe(expected);
    });

    it('uses the runtime index when it has an entry', async () => {
        const dataDir = await createTempDir();
        const relativeDir = '2026/10/20/09-20-41-291-session_x';
        await mkdir(join(dataDir, 'v2', 'sessions', relativeDir), { recursive: true });
        const readRelativeDir = vi.fn(async () => relativeDir);
        const resolver = createMcodeSessionDirResolver({ dataDir, readRelativeDir });

        await expect(resolver.resolve('mvs_target')).resolves.toBe(
            join(dataDir, 'v2', 'sessions', relativeDir)
        );
        expect(readRelativeDir).toHaveBeenCalledTimes(1);
    });
});
