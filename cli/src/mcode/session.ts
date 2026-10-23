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
    private lastEmptyTokenCountSignature: string | null = null;
    /**
     * True once a token count with real tokens has been seen.
     *
     * That is the signal that the transcript watcher is delivering. Until then
     * the ACP copy of the context is the only reading there is.
     */
    private hasSeenTokenCount = false;

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
            effort: opts.effort,
            // The hub acknowledges a message when the runner hands it to the
            // agent, not when the runner takes it out of its own queue. A
            // message that waits for a busy agent would be lost with a runner
            // that dies while it waits: the hub already marked it delivered,
            // and the only copy left was in the runner's memory.
            // Unacknowledged rows stay queued in the hub, so the next runner
            // picks them up again.
            acknowledgeMessagesOnDequeue: false
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
        const counts = this.readTokenCounts(message);
        if (counts && (counts.inputTokens !== 0 || counts.outputTokens !== 0)) {
            this.hasSeenTokenCount = true;
        } else if (counts && this.hasSeenTokenCount) {
            // A count with a context but without tokens is the ACP copy of the
            // context. The agent publishes it at the end of a turn, so it is a
            // snapshot and not the live value. Once the transcript watcher is
            // reporting, the live value is the newer one and the snapshot must
            // not overwrite it: after a compaction the snapshot is even higher
            // than the real context, so it pinned the context bar to a number
            // that was too high and never moved again.
            return;
        }
        if (this.isRepeatedEmptyTokenCount(message)) {
            return;
        }
        this.client.sendAgentMessage(message);
    };

    /**
     * The token counts of a token count message, or null when the message is
     * not one.
     */
    private readTokenCounts(message: unknown): {
        inputTokens: number;
        outputTokens: number;
    } | null {
        if (!message || typeof message !== 'object') return null;
        const record = message as Record<string, unknown>;
        if (record.type !== 'token_count') return null;
        const info = record.info;
        if (!info || typeof info !== 'object') return null;
        const total = (info as Record<string, unknown>).total;
        if (!total || typeof total !== 'object') return null;

        const totalRecord = total as Record<string, unknown>;
        return {
            inputTokens: typeof totalRecord.inputTokens === 'number' ? totalRecord.inputTokens : 0,
            outputTokens: typeof totalRecord.outputTokens === 'number' ? totalRecord.outputTokens : 0
        };
    }

    /**
     * True for a token count that repeats the previous one and carries no
     * tokens.
     *
     * A turn the agent refused makes it write a transcript line without any
     * tokens in it, so the usage watcher reports the same count once per
     * refusal. The hub stores every report as a message row, and a session
     * that stayed busy for minutes produced dozens of identical rows that way
     * - rows that carry no information but still cost a write, a hub event and
     * a web re-render each.
     *
     * A count with tokens in it is never dropped: two real turns can report
     * the same numbers, and the dashboard has to see both.
     */
    private isRepeatedEmptyTokenCount(message: unknown): boolean {
        const counts = this.readTokenCounts(message);
        if (!counts) return false;
        if (counts.inputTokens !== 0 || counts.outputTokens !== 0) return false;

        let signature: string;
        try {
            signature = JSON.stringify(message);
        } catch {
            return false;
        }
        if (signature === this.lastEmptyTokenCountSignature) return true;
        this.lastEmptyTokenCountSignature = signature;
        return false;
    }

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

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
