import { trimIdent } from '@/utils/trimIdent';
import {
    DISPLAY_IMAGE_PROMPT_HAPI_MCP,
    DISPLAY_MEDIA_PROMPT_HAPI_MCP,
    DISPLAY_VIDEO_PROMPT_HAPI_MCP,
} from './displayImagePrompt';

/** Shell fallback for `hapi doctor inline-media` only — not injected into agent prompts. */
export const INLINE_MEDIA_SHELL_FALLBACK = trimIdent(`
    If display_image / display_video / display_media tools are not in your tool list, inline media via shell from the HAPI repo (needs bun + @modelcontextprotocol/sdk):
    cd <hapi-repo-root> && bun scripts/tooling/hapi-display-image.mjs <HAPI-session-id-prefix> <absolute-file-path> "title"
    Use the HAPI session uuid prefix from the web URL /sessions/<uuid> (first 8 chars), not cursorSessionId or other agent-native ids.
    Run hapi doctor inline-media to list active bridges and copy the exact command.
`);

/**
 * What the `change_title` tool tells the model.
 *
 * The ACP agents never see the title instruction the native ones get in their
 * system prompt, so the tool description is the only instruction they get. It
 * therefore has to say *when* to call the tool: an agent like MiniMax Code
 * that is only told the tool exists decides for itself that a long task is not
 * clear yet and starts working instead - the chat then stays untitled until
 * the agent publishes a title of its own, which it does at the end of the
 * first turn.
 *
 * Both MCP servers use this one text: the HTTP server (the native agents talk
 * to it directly) and the stdio bridge (every ACP agent talks to that one).
 * A description that only one of them carries reaches half the agents.
 */
export const CHANGE_TITLE_TOOL_DESCRIPTION = 'Set the title of the current HAPI chat session. You MUST call this tool exactly once at the start of every new chat, before reading any file, before planning and before any other tool call. Do not skip it and do not postpone it until later. Pass a concise task title (under 20 characters, no quotes and no trailing punctuation). Do not call it again for routine progress, substeps, implementation details or a slightly better wording.';

/**
 * Title + display_image / display_video / display_media instructions for OpenCode first-prompt /
 * hapi-instructions.md. Cursor uses native MCP overlay + tool descriptions instead
 * (no user-turn prepend — that path was prompt-taint).
 */
export const HAPI_MCP_TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call the tool "hapi_change_title" once after the user's initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user's primary objective changes substantially and the existing title would be misleading.
`);

export const HAPI_MCP_BRIDGE_PROMPT = trimIdent(`
    ${HAPI_MCP_TITLE_INSTRUCTION}
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
    ${DISPLAY_VIDEO_PROMPT_HAPI_MCP}
    ${DISPLAY_MEDIA_PROMPT_HAPI_MCP}
`);
