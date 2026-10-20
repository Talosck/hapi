import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { McodeSession } from './session';
import { mcodeLocalLauncher } from './mcodeLocalLauncher';
import { mcodeRemoteLauncher } from './mcodeRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { McodeMode, PermissionMode } from './types';

interface McodeLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<McodeMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    onSessionReady?: (session: McodeSession) => void;
    /**
     * Fired when the remote launcher discovers the model the native session is
     * actually using (or falls back after a rejected switch). `runMcode` feeds
     * this back into the keepalive so the hub does not keep advertising a
     * model the agent never accepted.
     */
    onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void;
    /** Fired after a failed inline model switch, with the model still active. */
    onModelRollback?: (model: string | null) => void;
    /** Fired after a failed effort switch, with the effort still active. */
    onEffortRollback?: (effort: string | null) => void;
    /** Fired after a failed permission-mode apply, with the restored mode. */
    onPermissionModeRollback?: (mode: PermissionMode) => void;
}

export async function mcodeLoop(opts: McodeLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new McodeSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.resumeSessionId ?? null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        permissionMode: opts.permissionMode ?? 'default',
        effort: opts.effort === 'default' ? undefined : opts.effort
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    const getCurrentModel = (): string | undefined => {
        const sessionModel = session.getModel();
        return sessionModel != null ? sessionModel : opts.model;
    };
    const getCurrentEffort = (): string | undefined => {
        const sessionEffort = session.getEffort();
        return sessionEffort != null ? sessionEffort : opts.effort;
    };

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'mcode-loop',
        runLocal: (instance) => mcodeLocalLauncher(instance, {
            model: getCurrentModel()
        }),
        runRemote: (instance) => mcodeRemoteLauncher(instance, {
            model: getCurrentModel(),
            effort: getCurrentEffort(),
            onConfigDiscovered: opts.onConfigDiscovered,
            onModelRollback: opts.onModelRollback,
            onEffortRollback: opts.onEffortRollback,
            onPermissionModeRollback: opts.onPermissionModeRollback
        }),
        onSessionReady: opts.onSessionReady
    });
}
