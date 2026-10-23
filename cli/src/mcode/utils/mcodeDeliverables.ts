/**
 * The delivery block a MiniMax Code agent writes into its final answer.
 *
 * The runtime tells the agent to declare the files it hands over in a
 * `<deliver-assets>` block, because the MiniMax Code apps render that block as
 * a file card. HAPI's clients do not know the markup, so the block would
 * reach the chat as raw XML - and, because the text is stored in the
 * transcript, it would stay there.
 *
 * The block is therefore taken out of the agent's text, and the files it
 * names are reported as file citations, the way HAPI reports a file anywhere
 * else.
 *
 * A block that names no file is left alone: it is text the agent wrote, not a
 * delivery, and an answer that talks about the markup must not lose it.
 */
import { relative, resolve, sep } from 'node:path';
import { validatePath } from '@/modules/common/pathSecurity';

/** A file the agent declared as delivered. */
export type McodeDeliverable = {
    /** The path of the file on the machine the agent runs on. */
    path: string
    /** The title the agent gave the file, if any. */
    title: string | null
    /** The kind of the file the agent declared, if any. */
    kind: string | null
}

/** The text of an answer, without the delivery block, and what it declared. */
export type McodeDeliverableSplit = {
    /** The text that is not part of a delivery block. */
    text: string
    /** The files the agent declared as delivered. */
    deliverables: McodeDeliverable[]
}

const OPEN_TAG = '<deliver-assets'
const CLOSE_TAG = '</deliver-assets>'
const MEDIA_TAG = /<media\b([^>]*?)\/?>/g

/** Reads an attribute of a tag, in either quoting style. */
function readAttribute(attributes: string, name: string): string | null {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`)
    const match = pattern.exec(attributes)
    if (!match) return null
    const value = match[1] ?? match[2] ?? ''
    return value.trim().length > 0 ? value : null
}

/** The files a delivery block names. */
function parseDeliverables(block: string): McodeDeliverable[] {
    const deliverables: McodeDeliverable[] = []
    MEDIA_TAG.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MEDIA_TAG.exec(block)) !== null) {
        const attributes = match[1] ?? ''
        const path = readAttribute(attributes, 'src')
        if (!path) continue
        deliverables.push({
            path,
            title: readAttribute(attributes, 'title'),
            kind: readAttribute(attributes, 'type')
        })
    }
    return deliverables
}

/**
 * Takes the delivery block out of an answer.
 *
 * The block is only taken out when it names at least one file: a block
 * without one is the agent talking, not the agent delivering.
 */
export function splitMcodeDeliverables(text: string): McodeDeliverableSplit {
    const open = text.indexOf(OPEN_TAG)
    if (open === -1) return { text, deliverables: [] };

    const close = text.indexOf(CLOSE_TAG, open)
    if (close === -1) return { text, deliverables: [] };

    const block = text.slice(open + OPEN_TAG.length, close);
    const deliverables = parseDeliverables(block);
    if (deliverables.length === 0) return { text, deliverables: [] };

    const before = text.slice(0, open);
    const after = text.slice(close + CLOSE_TAG.length);
    return { text: `${before}${after}`, deliverables };
}

/**
 * The line that reports a delivered file to the user.
 *
 * The path is given the way the clients expect a file citation: relative to
 * the session's working directory. Both the web app and the native apps turn
 * such a path into a link that opens the file - an absolute path is not
 * linked by either of them.
 *
 * The file is not read here. Reading it is what the click does, and that read
 * is checked against the working directory before a byte is served.
 */
export function renderMcodeDeliverables(
    deliverables: McodeDeliverable[],
    workspace: string
): string {
    const entries = deliverables.map((deliverable) => {
        const relative = relativeToWorkspace(deliverable.path, workspace);
        // A file outside the working directory cannot be opened by the viewer,
        // so its path stays plain text instead of a link that would fail.
        return `\`${relative ?? deliverable.path}\``;
    });
    return `Delivered: ${entries.join(', ')}`;
}

/**
 * The path of a file relative to the session's working directory, if the file
 * is inside it.
 */
function relativeToWorkspace(path: string, workspace: string): string | null {
    if (!workspace) return null;
    const validation = validatePath(path, workspace);
    if (!validation.valid) return null;
    const fromWorkspace = relative(workspace, resolve(workspace, path));
    if (!fromWorkspace || fromWorkspace.startsWith('..')) return null;
    return fromWorkspace.split(sep).join('/');
}
