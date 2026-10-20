import { logger } from '@/ui/logger';
import type { McpServerStdio } from '@/agent/types';
import { createMcodeBackend } from './mcodeBackend';

/**
 * Creates a native MiniMax Code session through the ACP server.
 *
 * The local TUI can only reopen a session that already exists (`mcode --session
 * <id>`) — it does not create one until the first prompt, which is too late
 * for HAPI to know the session id and hand the conversation over to the ACP
 * backend. Creating the session up front gives both sides the same id.
 */
export async function createMcodeSession(opts: {
    cwd: string;
    mcpServers?: McpServerStdio[];
}): Promise<string> {
    const backend = createMcodeBackend();
    try {
        await backend.initialize();
        const sessionId = await backend.newSession({
            cwd: opts.cwd,
            mcpServers: opts.mcpServers ?? []
        });
        logger.debug(`[mcode] Created native session ${sessionId}`);
        return sessionId;
    } finally {
        await backend.disconnect().catch(() => undefined);
    }
}
