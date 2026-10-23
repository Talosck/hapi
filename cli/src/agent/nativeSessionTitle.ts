import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type NativeSessionTitleMetadataClient = Pick<ApiSessionClient, 'getMetadata' | 'updateMetadata'>;

/**
 * Longest title HAPI stores for a session. The hub's own title suggestion
 * caps at the same length, so a native title is not allowed to be longer.
 */
const NATIVE_SESSION_TITLE_MAX_LENGTH = 80;

/**
 * Strips the markup an agent may leave around a title.
 *
 * An agent that writes its title as markup - or that copies one out of its
 * own transcript - can leave the tags in the text: a title came back as
 * `Fix the parser</</title>`, because the closing tag was pasted along with
 * the title and the opening one had already been stripped.
 */
function stripTitleMarkup(title: string): string {
    let stripped = title.trim();
    // A title wrapped in a tag pair: <title>Fix the parser</title>.
    stripped = stripped.replace(/^<title>\s*/i, '').replace(/\s*<\/title>$/i, '');
    // A half-written tag left at the end - a named tag that was never closed,
    // or a closing tag that was never opened.
    stripped = stripped.replace(/\s*<\/?[a-z][^<>]*$/i, '');
    // What is left of a closing tag once its name is gone.
    stripped = stripped.replace(/\s*<\/?$/, '');
    return stripped.trim();
}

export function normalizeNativeSessionTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const normalizedTitle = stripTitleMarkup(title).replace(/\s+/g, ' ').trim();
    if (!normalizedTitle
        || /^(?:Untitled|New Session)$/i.test(normalizedTitle)
        || /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T/i.test(normalizedTitle)) {
        return null;
    }
    return normalizedTitle.slice(0, NATIVE_SESSION_TITLE_MAX_LENGTH).trim() || null;
}

/** Syncs a native agent title into HAPI metadata without creating a chat row. */
export function createNativeSessionTitleMetadataSync(
    client: NativeSessionTitleMetadataClient
): (title: unknown) => void {
    let lastTitle: string | null = null;

    return (title) => {
        const normalizedTitle = normalizeNativeSessionTitle(title);
        if (!normalizedTitle || normalizedTitle === lastTitle) {
            return;
        }
        lastTitle = normalizedTitle;

        if (metadataHasTitle(client.getMetadata(), normalizedTitle)) {
            return;
        }
        client.updateMetadata((metadata) => {
            if (metadataHasTitle(metadata, normalizedTitle)) {
                return metadata;
            }
            return {
                ...metadata,
                summary: {
                    text: normalizedTitle,
                    updatedAt: Date.now()
                }
            };
        });
    };
}

function metadataHasTitle(metadata: Readonly<Metadata> | null, title: string): boolean {
    return metadata?.name?.trim() === title || metadata?.summary?.text.trim() === title;
}
