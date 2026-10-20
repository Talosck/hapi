import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { McodeMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export type McodeContextUsage = {
    contextTokens?: number;
    contextWindow?: number;
};

export class McodeSession extends AgentSessionBase<McodeMode> {
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    private lastContextUsage: McodeContextUsage | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<McodeMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode;
        effort?: string;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'McodeSession',
            sessionIdLabel: 'MiniMax Code',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                mcodeSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            effort: opts.effort
        });

        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.effort = opts.effort;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: string | null): void => {
        this.model = model;
    };

    setEffort = (effort: string | null): void => {
        this.effort = effort;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendAgentMessage = (message: unknown): void => {
        this.captureContextUsage(message);
        this.client.sendAgentMessage(message);
    };

    /**
     * Latest context window reported by the ACP backend. The usage watcher
     * attaches it to transcript-derived token counts so they do not replace the
     * context bar's `used / window` reading with a single call's prompt size.
     */
    getLastContextUsage = (): McodeContextUsage | null => this.lastContextUsage;

    private captureContextUsage = (message: unknown): void => {
        if (!message || typeof message !== 'object') return;
        const record = message as Record<string, unknown>;
        if (record.type !== 'token_count') return;
        const info = record.info;
        if (!info || typeof info !== 'object') return;

        const infoRecord = info as Record<string, unknown>;
        const contextTokens = typeof infoRecord.contextTokens === 'number'
            ? infoRecord.contextTokens
            : undefined;
        const contextWindow = typeof infoRecord.modelContextWindow === 'number'
            ? infoRecord.modelContextWindow
            : undefined;
        if (contextTokens === undefined && contextWindow === undefined) return;

        this.lastContextUsage = {
            ...(contextTokens !== undefined ? { contextTokens } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {})
        };
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendBackgroundTaskDelta = (delta: { started?: number; completed?: number }): void => {
        this.client.sendBackgroundTaskDelta(delta);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
