import { isAbsolute, sep } from 'path'

/** Windows drive letters (`C:\...`) are absolute on Windows but not on POSIX. */
export function looksAbsolute(path: string): boolean {
    return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Normalize a client-supplied relative path.
 *
 * The client speaks POSIX separators, but a Windows client may send backslashes.
 * Trailing separators are dropped so the path always names a file.
 */
export function normalizeRelativePath(path: string): string {
    return path
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '')
}

/** True when `target` is the directory itself or inside of it. */
export function isInsideDirectory(directory: string, target: string): boolean {
    const normalizedDirectory = process.platform === 'win32' ? directory.toLowerCase() : directory
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target
    const prefix = normalizedDirectory.endsWith(sep) ? normalizedDirectory : `${normalizedDirectory}${sep}`
    return normalizedTarget === normalizedDirectory || normalizedTarget.startsWith(prefix)
}
