/**
 * Formatter for Pi's session tree (`get_tree`).
 *
 * Pi exposes the session as a tree of entries so a session with rewinds and
 * forks can be navigated. HAPI renders it as plain text in the chat: the web
 * has no tree view, and the point of the command is to let the user see which
 * branch the session is on.
 *
 * The tree is rendered as a fenced code block. The web renders chat messages
 * as markdown, and the tree contains the user's own earlier messages — a
 * markdown image in one of them would otherwise make the browser fetch a
 * remote URL on the user's behalf.
 */

/** How many entries the rendered tree may contain. */
const PI_SESSION_TREE_MAX_LINES = 200;
/** How deep the indentation may grow before it is capped. */
const PI_SESSION_TREE_MAX_DEPTH = 40;
/** How much of an entry's text is shown. */
const PI_SESSION_TREE_CLIP_CHARS = 72;

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

/**
 * Clip to a number of characters without splitting a surrogate pair.
 *
 * A 4-byte emoji counts as two UTF-16 units, so cutting at a fixed offset
 * can leave half of one behind and put a lone surrogate into the payload.
 */
function clipText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const points = Array.from(text);
    if (points.length <= maxChars) return text;
    return `${points.slice(0, maxChars).join('')}…`;
}

function summarizeEntry(entry: UnknownRecord): string {
    const type = asString(entry.type) ?? 'entry';
    const message = asRecord(entry.message);
    if (!message) return type;
    const role = asString(message.role);
    const text = extractText(message.content).replace(/\s+/g, ' ').trim();
    const head = role ? `${role}: ` : '';
    if (!text) return `${head}(${type})`;
    return `${head}${clipText(text, PI_SESSION_TREE_CLIP_CHARS)}`;
}

/**
 * Walk the tree depth-first with an explicit stack.
 *
 * A session can hold a branch chain thousands of entries deep, and a
 * recursive walk would blow the stack on exactly the long sessions where the
 * tree is most useful.
 */
function collectLines(roots: unknown[], leafId: string | undefined, lines: string[]): boolean {
    const stack: Array<{ node: unknown; depth: number }> = [];
    for (let index = roots.length - 1; index >= 0; index--) {
        stack.push({ node: roots[index], depth: 0 });
    }
    while (stack.length > 0) {
        const item = stack.pop()!;
        const record = asRecord(item.node);
        if (!record) continue;
        const entry = asRecord(record.entry);
        const depth = Math.min(item.depth, PI_SESSION_TREE_MAX_DEPTH);
        const indent = '  '.repeat(depth);
        const connector = depth === 0 ? '' : '└─ ';
        const entryId = entry ? asString(entry.id) : undefined;
        // The leaf is where the session currently is, so it is marked.
        const marker = entryId !== undefined && entryId === leafId ? ' ← current' : '';
        lines.push(`${indent}${connector}${entry ? summarizeEntry(entry) : 'entry'}${marker}`);
        if (lines.length >= PI_SESSION_TREE_MAX_LINES) return false;
        const children = Array.isArray(record.children) ? record.children : [];
        for (let index = children.length - 1; index >= 0; index--) {
            stack.push({ node: children[index], depth: item.depth + 1 });
        }
    }
    return true;
}

/** Wrap text in a code fence that its own content cannot break out of. */
function fenceBlock(text: string): string {
    let longestRun = 0;
    for (const run of text.match(/`+/g) ?? []) {
        if (run.length > longestRun) longestRun = run.length;
    }
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${fence}\n${text}\n${fence}`;
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
    const complete = collectLines(tree, leafId, lines);
    if (!complete) {
        lines.push(`… (${PI_SESSION_TREE_MAX_LINES} entries shown, more were not rendered)`);
    }
    return fenceBlock(lines.join('\n'));
}
