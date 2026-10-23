/**
 * Formatter for Pi's session tree (`get_tree`).
 *
 * Pi exposes the session as a tree of entries so a session with rewinds and
 * forks can be navigated. HAPI renders it as plain text in the chat: the web
 * has no tree view, and the point of the command is to let the user see which
 * branch the session is on.
 */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    return typeof value === 'object' && value !== null ? value as UnknownRecord : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Pull the readable text out of an entry's message content. */
function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
        const record = asRecord(block);
        if (!record) continue;
        if (record.type === 'text' && typeof record.text === 'string') {
            parts.push(record.text);
        }
    }
    return parts.join(' ');
}

function summarizeEntry(entry: UnknownRecord): string {
    const type = asString(entry.type) ?? 'entry';
    const message = asRecord(entry.message);
    if (!message) return type;
    const role = asString(message.role);
    const text = extractText(message.content).replace(/\s+/g, ' ').trim();
    const head = role ? `${role}: ` : '';
    if (!text) return `${head}(${type})`;
    const clipped = text.length > 72 ? `${text.slice(0, 72)}…` : text;
    return `${head}${clipped}`;
}

function collectLines(node: unknown, depth: number, leafId: string | undefined, lines: string[]): void {
    const record = asRecord(node);
    if (!record) return;
    const entry = asRecord(record.entry);
    const indent = '  '.repeat(depth);
    const connector = depth === 0 ? '' : '└─ ';
    const entryId = entry ? asString(entry.id) : undefined;
    // The leaf is where the session currently is, so it is marked.
    const marker = entryId !== undefined && entryId === leafId ? ' ← current' : '';
    lines.push(`${indent}${connector}${entry ? summarizeEntry(entry) : 'entry'}${marker}`);
    const children = Array.isArray(record.children) ? record.children : [];
    for (const child of children) {
        collectLines(child, depth + 1, leafId, lines);
    }
}

/**
 * Render Pi's `get_tree` payload as an indented text tree.
 *
 * Returns an empty string when Pi reported no tree, so the caller can tell
 * "no branches" apart from a rendering failure.
 */
export function formatPiSessionTree(data: unknown): string {
    const record = asRecord(data);
    const tree = Array.isArray(record?.tree) ? record.tree : [];
    if (tree.length === 0) return '';
    const leafId = asString(record?.leafId);
    const lines: string[] = [];
    for (const node of tree) {
        collectLines(node, 0, leafId, lines);
    }
    return lines.join('\n');
}
