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
    resumeSessionId?: string;
    onSessionReady?: (session: McodeSession) => void;
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
        permissionMode: opts.permissionMode ?? 'default'
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    const getCurrentModel = (): string | undefined => {
        const sessionModel = session.getModel();
        return sessionModel != null ? sessionModel : opts.model;
    };

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'mcode-loop',
        runLocal: (instance) => mcodeLocalLauncher(instance, {
            model: getCurrentModel()
        }),
        runRemote: (instance) => mcodeRemoteLauncher(instance, {
            model: getCurrentModel()
        }),
        onSessionReady: opts.onSessionReady
    });
}
