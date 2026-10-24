import { collectUploadEntries, sanitizeUploadPath, type WorkspaceUploadEntry } from './workspace-upload'

/**
 * True when a drag carries files.
 *
 * A drag of selected text or a link must keep its default behaviour, so the
 * drop handlers check this before they cancel anything.
 */
export function hasFileDrag(dataTransfer: Pick<DataTransfer, 'types'> | null | undefined): boolean {
    return Array.from(dataTransfer?.types ?? []).includes('Files')
}

/** Read the file of a dropped file entry. */
function readFileEntry(entry: FileSystemFileEntry): Promise<File | null> {
    return new Promise((resolve) => {
        try {
            entry.file(
                (file) => resolve(file),
                () => resolve(null),
            )
        } catch {
            resolve(null)
        }
    })
}

/**
 * Read every child of a dropped directory.
 *
 * The reader hands the children out in batches (Chrome gives at most 100 per
 * call), so it has to be drained until a batch comes back empty. Otherwise a
 * folder with more than 100 entries would be uploaded half.
 */
function readDirectoryChildren(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    return new Promise((resolve) => {
        let reader: FileSystemDirectoryReader
        try {
            reader = entry.createReader()
        } catch {
            resolve([])
            return
        }

        const children: FileSystemEntry[] = []
        const readBatch = () => {
            try {
                reader.readEntries(
                    (batch) => {
                        if (batch.length === 0) {
                            resolve(children)
                            return
                        }
                        children.push(...batch)
                        readBatch()
                    },
                    () => resolve(children),
                )
            } catch {
                resolve(children)
            }
        }
        readBatch()
    })
}

/**
 * Turn the entries of a drop into upload entries.
 *
 * A dropped folder keeps its structure: the files inside it are uploaded
 * relative to the folder, so the workspace mirrors what the user dragged.
 */
async function collectEntryFiles(
    entry: FileSystemEntry,
    prefix: string,
    collected: WorkspaceUploadEntry[]
): Promise<void> {
    if (entry.isFile) {
        const file = await readFileEntry(entry as FileSystemFileEntry)
        if (!file) return
        const relativePath = sanitizeUploadPath(prefix ? `${prefix}/${entry.name}` : entry.name)
        if (!relativePath) return
        collected.push({ relativePath, file })
        return
    }

    if (!entry.isDirectory) return

    const children = await readDirectoryChildren(entry as FileSystemDirectoryEntry)
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    for (const child of children) {
        await collectEntryFiles(child, childPrefix, collected)
    }
}

/** The entries of a drop, as the browser's file API hands them out. */
function readDroppedEntries(dataTransfer: DataTransfer): FileSystemEntry[] {
    const items = Array.from(dataTransfer.items ?? [])
    const entries: FileSystemEntry[] = []
    for (const item of items) {
        if (item.kind !== 'file') continue
        try {
            const entry = item.webkitGetAsEntry?.() ?? null
            if (entry) entries.push(entry)
        } catch {
            // A browser that cannot hand out the entry simply has none.
        }
    }
    return entries
}

/**
 * Collect the files of a drag-and-drop as upload entries.
 *
 * The file API of a drop (`webkitGetAsEntry`) is the only way to see the
 * content of a dropped folder: `dataTransfer.files` hands out the folder
 * itself, not the files inside it. A browser without that API (or a drop the
 * browser does not describe with entries) falls back to the flat file list.
 */
export async function collectDroppedEntries(dataTransfer: DataTransfer): Promise<WorkspaceUploadEntry[]> {
    const entries = readDroppedEntries(dataTransfer)
    if (entries.length > 0) {
        const collected: WorkspaceUploadEntry[] = []
        let hasDirectory = false
        for (const entry of entries) {
            if (entry.isDirectory) hasDirectory = true
            await collectEntryFiles(entry, '', collected)
        }
        // A drop the browser described with a folder is fully described by
        // its entries: the file list holds the folder itself, so falling back
        // to it would upload the folder as an empty file.
        if (collected.length > 0 || hasDirectory) return collected
    }

    return collectUploadEntries(dataTransfer.files ?? [])
}
