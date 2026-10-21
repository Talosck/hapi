import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { McodeSession } from './session';
import { mcodeLocalLauncher } from './mcodeLocalLauncher';
import { mcodeRemoteLauncher } from './mcodeRemoteLauncher';
import { buildMcodeUsageMessage, createMcodeUsageWatcher } from './utils/mcodeUsage';
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
    /**
     * Fired when the agent reports a permission mode of its own (the session
     * mode it switched to, or the tool permission policy it re-published).
     */
    onPermissionModeChanged?: (mode: PermissionMode) => void;
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

    // The requested resume id stays local until the agent has actually bound
    // the session: the launcher publishes the id it really runs. Publishing the
    // requested id up front would make a failed resume look like a successful
    // one - the hub could not tell a loaded session from a blank fallback.

    const getCurrentModel = (): string | undefined => {
        const sessionModel = session.getModel();
        return sessionModel != null ? sessionModel : opts.model;
    };
    const getCurrentEffort = (): string | undefined => {
        const sessionEffort = session.getEffort();
        return sessionEffort != null ? sessionEffort : opts.effort;
    };

    // mcode's ACP server exposes context size but not token counts, so usage is
    // read from the native transcript it writes for every model call. The
    // watcher only forwards records written after HAPI attaches, keeping
    // pre-HAPI history out of the dashboard.
    const usageWatcher = createMcodeUsageWatcher({
        onUsage: (record) => {
            const converted = buildMcodeUsageMessage(
                record,
                session.getModel() ?? opts.model ?? record.model,
                session.getLastContextUsage()
            );
            if (converted) {
                session.sendAgentMessage(converted);
            }
        },
        // A transcript that cannot be found leaves the session without any
        // usage at all, so say so instead of failing silently.
        onWarning: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        }
    });
    const attachUsageWatcher = (nativeSessionId: string): void => {
        void usageWatcher.attach(nativeSessionId).catch((error) => {
            logger.debug('[mcode] Failed to attach usage watcher', error);
        });
    };
    session.addSessionFoundCallback(attachUsageWatcher);
    if (session.sessionId) {
        attachUsageWatcher(session.sessionId);
    }

    try {
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
                onPermissionModeRollback: opts.onPermissionModeRollback,
                onPermissionModeChanged: opts.onPermissionModeChanged
            }),
            onSessionReady: opts.onSessionReady
        });
    } finally {
        session.removeSessionFoundCallback(attachUsageWatcher);
        await usageWatcher.cleanup();
    }
}
