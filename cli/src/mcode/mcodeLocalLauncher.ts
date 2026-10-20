import { logger } from '@/ui/logger';
import { mcodeLocal } from './mcodeLocal';
import { McodeSession } from './session';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { createMcodeSession } from './utils/mcodeSession';

export async function mcodeLocalLauncher(
    session: McodeSession,
    opts: { model?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new BaseLocalLauncher({
        label: 'mcode-local',
        failureLabel: 'Local MiniMax Code process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            // The TUI only reopens an existing session (`mcode --session <id>`)
            // and does not create one until the first prompt, so the session is
            // created up front over ACP. That keeps the native id in HAPI's
            // metadata and lets the remote launcher pick the same conversation
            // up again after the handoff.
            let sessionId = session.sessionId;
            if (!sessionId) {
                try {
                    sessionId = await createMcodeSession({ cwd: session.path });
                } catch (error) {
                    logger.warn('[mcode-local] Failed to create a native session', error);
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'MiniMax Code session could not be created over ACP; the local TUI will start its own session.'
                    });
                }
            }

            if (sessionId) {
                session.onSessionFound(sessionId);
            }

            await mcodeLocal({
                path: session.path,
                abort: abortSignal,
                sessionId,
                model: opts.model
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    return await launcher.run();
}
