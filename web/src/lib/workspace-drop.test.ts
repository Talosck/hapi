import { describe, expect, it } from 'vitest'
import { collectDroppedEntries, hasFileDrag } from './workspace-drop'

/**
 * The file API of a drag-and-drop is not part of the DOM types of jsdom, so
 * the entries are built by hand here. The shapes mirror what a browser hands
 * out: a file entry hands out its file, a directory entry hands out a reader
 * that delivers its children in batches.
 */
function fileEntry(name: string, content = 'hello'): FileSystemEntry {
    const file = new File([content], name, { type: 'text/plain' })
    return {
        isFile: true,
        isDirectory: false,
        name,
        file: (success: FileCallback) => success(file),
    } as unknown as FileSystemEntry
}

function directoryEntry(name: string, children: FileSystemEntry[], batchSize = 100): FileSystemEntry {
    return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => {
            let index = 0
            return {
                readEntries: (success: FileSystemEntriesCallback) => {
                    const batch = children.slice(index, index + batchSize)
                    index += batch.length
                    success(batch)
                },
            }
        },
    } as unknown as FileSystemEntry
}

function dropItem(entry: FileSystemEntry): { kind: string; type: string; webkitGetAsEntry: () => FileSystemEntry } {
    return { kind: 'file', type: 'text/plain', webkitGetAsEntry: () => entry }
}

function dataTransfer(items: unknown[], files: File[] = []): DataTransfer {
    return {
        items,
        files,
        types: files.length > 0 || items.length > 0 ? ['Files'] : [],
    } as unknown as DataTransfer
}

describe('hasFileDrag', () => {
    it('is true for a drag that carries files', () => {
        expect(hasFileDrag({ types: ['Files'] } as unknown as DataTransfer)).toBe(true)
    })

    it('is false for a drag of text', () => {
        expect(hasFileDrag({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false)
        expect(hasFileDrag(null)).toBe(false)
    })
})

describe('collectDroppedEntries', () => {
    it('collects a dropped file', async () => {
        const entries = await collectDroppedEntries(dataTransfer([dropItem(fileEntry('a.txt'))]))

        expect(entries).toHaveLength(1)
        expect(entries[0].relativePath).toBe('a.txt')
        expect(entries[0].file.name).toBe('a.txt')
    })

    it('keeps the structure of a dropped folder', async () => {
        const entries = await collectDroppedEntries(dataTransfer([
            dropItem(directoryEntry('myfolder', [
                fileEntry('notes.md'),
                directoryEntry('sub', [fileEntry('deep.txt')]),
            ])),
        ]))

        expect(entries.map((entry) => entry.relativePath).sort()).toEqual([
            'myfolder/notes.md',
            'myfolder/sub/deep.txt',
        ])
    })

    it('reads a folder with more entries than one batch holds', async () => {
        // Chrome hands out at most 100 children per read, so a folder with
        // 150 entries needs two reads.
        const children = Array.from({ length: 150 }, (_, index) => fileEntry(`file-${index}.txt`))
        const entries = await collectDroppedEntries(dataTransfer([
            dropItem(directoryEntry('big', children, 100)),
        ]))

        expect(entries).toHaveLength(150)
        expect(entries[149].relativePath).toBe('big/file-149.txt')
    })

    it('falls back to the file list when the browser hands out no entries', async () => {
        // A browser without the file API of a drop only has the flat list.
        const file = new File(['hello'], 'a.txt')
        const entries = await collectDroppedEntries(dataTransfer([], [file]))

        expect(entries).toHaveLength(1)
        expect(entries[0].relativePath).toBe('a.txt')
    })

    it('falls back to the file list when the entries are unreadable', async () => {
        const broken = {
            kind: 'file',
            type: 'text/plain',
            webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: 'x' }) as unknown as FileSystemEntry,
        }
        const file = new File(['hello'], 'a.txt')
        const entries = await collectDroppedEntries(dataTransfer([broken], [file]))

        expect(entries.map((entry) => entry.relativePath)).toEqual(['a.txt'])
    })

    it('ignores a path that would leave the workspace', async () => {
        const entries = await collectDroppedEntries(dataTransfer([
            dropItem(directoryEntry('..', [fileEntry('escape.txt')])),
        ]))

        expect(entries).toEqual([])
    })

    it('does not upload an empty folder as an empty file', async () => {
        // The file list of a folder drop holds the folder itself, so it must
        // not be used as a fallback for a folder without a file in it.
        const folder = new File([], 'empty-folder')
        const entries = await collectDroppedEntries(dataTransfer([
            dropItem(directoryEntry('empty-folder', [])),
        ], [folder]))

        expect(entries).toEqual([])
    })
})
