import React from 'react';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { McodeModelsResponse } from '@hapi/protocol/apiTypes';
import { getBuiltinSlashCommands, mergeSlashCommands } from '@hapi/protocol/slashCommands';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { McodeDisplay } from '@/ui/ink/McodeDisplay';
import type { McodeSession } from './session';
import type { PermissionMode } from './types';
import { createMcodeBackend } from './utils/mcodeBackend';
import { McodePermissionHandler } from './utils/permissionHandler';
import { applyMcodePermissionMode } from './utils/permissionModes';
import {
    McodeQuestionHandler,
    normalizeMcodeAskUserToolCall,
    type McodeAskUserCallHint
} from './utils/questionHandler';

export type McodeRemoteLauncherOptions = {
    model?: string;
    effort?: string;
    /** Fired once after session/new or session/load with the effective model/effort. */
    onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void;
    /** Fired after a failed inline switch, with the model still active. */
    onModelRollback?: (model: string | null) => void;
    /** Fired after a failed effort switch, with the effort still active. */
    onEffortRollback?: (effort: string | null) => void;
    /** Fired after a failed permission-mode apply, with the restored mode. */
    onPermissionModeRollback?: (mode: PermissionMode) => void;
};

class McodeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: McodeSession;
    private readonly opts: McodeRemoteLauncherOptions;
    private backend: ReturnType<typeof createMcodeBackend> | null = null;
    private permissionHandler: McodePermissionHandler | null = null;
    private questionHandler: McodeQuestionHandler | null = null;
    private pendingAskUserCall: McodeAskUserCallHint | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private currentBackendEffort: string | null = null;
    private defaultBackendEffort: string | null = null;
    private appliedPermissionMode: PermissionMode | null = null;
    private hasAppliedPermissionMode = false;

    constructor(session: McodeSession, opts: McodeRemoteLauncherOptions) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.opts = opts;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(McodeDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'mcode' }
        });
        this.happyServer = happyServer;

        const backend = createMcodeBackend();
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            logger.debug('[mcode-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        this.questionHandler = new McodeQuestionHandler(
            session.client,
            backend,
            () => {
                const hint = this.pendingAskUserCall;
                this.pendingAskUserCall = null;
                return hint;
            },
            {
                // mcode ends the ask_user turn as soon as the questionnaire is
                // raised, so answering it continues the conversation as the
                // next user turn (see McodeQuestionHandler).
                submitAnswer: (text) => this.submitQuestionAnswer(text)
            }
        );

        const acpMcpServers = toAcpMcpServers(mcpServers);
        let acpSessionId: string;
        if (session.sessionId) {
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: session.sessionId,
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
            } catch (error) {
                logger.warn('[mcode-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'MiniMax Code resume failed; starting a new session.'
                });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
            }
        } else {
            acpSessionId = await backend.newSession({
                cwd: session.path,
                mcpServers: acpMcpServers
            });
        }
        session.onSessionFound(acpSessionId);

        this.permissionHandler = new McodePermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined,
            {
                handleMissingResponse: (response) => (
                    this.questionHandler?.handleResponse(response) ?? Promise.resolve(false)
                )
            }
        );

        // The permission policy is a per-process config option and the plan
        // mode is an ACP session mode; both have to be applied before the
        // first turn so the agent never runs with a policy the user did not
        // pick.
        await this.applyPermissionMode(acpSessionId, session.getPermissionMode() as PermissionMode | undefined);

        const effectiveModel = await this.applyInitialModel(acpSessionId, this.opts.model);
        this.currentBackendModel = effectiveModel;
        this.defaultBackendModel = effectiveModel;
        if (effectiveModel) {
            this.displayModel = effectiveModel;
            messageBuffer.addMessage(`[MODEL:${effectiveModel}]`, 'system');
        }
        const effectiveEffort = await this.applyInitialEffort(acpSessionId, this.opts.effort);
        this.currentBackendEffort = effectiveEffort;
        this.defaultBackendEffort = effectiveEffort;
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode | undefined, effectiveModel ?? undefined);
        // The native session's current model/effort are only known after
        // session/new (or session/load). Report them so the hub does not keep
        // showing values the agent never accepted, and adopt the fallback when
        // a requested value was rejected.
        this.opts.onConfigDiscovered?.({ model: effectiveModel, effort: effectiveEffort });
        this.registerAcpCommandHandlers(acpSessionId);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal);
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            // A new user message supersedes any questionnaire still waiting from
            // the previous turn: mcode dismisses the pending questionnaire in
            // that case, so drop the card instead of leaving a dead request.
            await this.questionHandler?.cancelAll('Superseded by a new message');

            // `null` means "back to the agent default" (the model the session
            // was created with); `undefined` means "no explicit choice".
            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;
            if (requestedModel && requestedModel !== this.currentBackendModel) {
                try {
                    await backend.setModel(acpSessionId, requestedModel, { flavor: 'mcode' });
                    this.currentBackendModel = requestedModel;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn('[mcode-remote] Inline model switch failed', error);
                    session.sendSessionEvent({
                        type: 'message',
                        message: `Failed to switch model to ${requestedModel}: ${message}`
                    });
                    batch.mode.model = this.currentBackendModel;
                    this.opts.onModelRollback?.(this.currentBackendModel);
                }
            }

            // A model switch can change the advertised thinking-effort levels.
            // Adopt the agent's current value after the switch, then apply the
            // user's per-turn choice if it differs.
            const effortOptionAfterModel = backend.getThoughtLevelConfigOption(acpSessionId);
            if (effortOptionAfterModel) {
                this.currentBackendEffort = effortOptionAfterModel.currentValue === 'default'
                ? null
                : effortOptionAfterModel.currentValue ?? null;
            }
            const requestedEffort = batch.mode.effort === null
                ? this.defaultBackendEffort
                : batch.mode.effort;
            if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
                try {
                    await this.applyEffort(acpSessionId, requestedEffort);
                    this.currentBackendEffort = requestedEffort;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn('[mcode-remote] Inline effort switch failed', error);
                    session.sendSessionEvent({
                        type: 'message',
                        message: `Failed to switch thinking effort to ${requestedEffort}: ${message}`
                    });
                    batch.mode.effort = this.currentBackendEffort;
                    this.opts.onEffortRollback?.(this.currentBackendEffort);
                }
            }

            const permissionApplied = await this.applyPermissionMode(acpSessionId, batch.mode.permissionMode);
            if (!permissionApplied) {
                // Keep the per-turn mode in sync with the policy the agent
                // actually runs; runMcode's keepalive was rolled back too.
                batch.mode.permissionMode = this.appliedPermissionMode ?? 'default';
            }

            this.applyDisplayMode(batch.mode.permissionMode, this.currentBackendModel ?? undefined);
            messageBuffer.addMessage(batch.message, 'user');

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn('[mcode-remote] prompt failed', { message: errorMessage });
                session.sendSessionEvent({
                    type: 'message',
                    message: `MiniMax Code prompt failed: ${errorMessage}`
                });
                messageBuffer.addMessage(`MiniMax Code prompt failed: ${errorMessage}`, 'status');
            } finally {
                session.onThinkingChange(false);
                this.pendingAskUserCall = null;
                // Questions outlive the turn: mcode's ask_user tool ends the
                // turn as soon as the questionnaire is raised, and the answer
                // arrives later as a new user message. Only tool approvals are
                // turn-scoped.
                await this.permissionHandler?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    /**
     * Sends a question answer back as the next turn. mcode's `ask_user` tool
     * ends the agent turn immediately, so this is the only path that makes the
     * agent read the answer (an elicitation reply after the turn is ignored).
     */
    private submitQuestionAnswer(text: string): void {
        if (this.shouldExit) {
            return;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return;
        }

        try {
            this.session.queue.pushIsolated(trimmed, {
                permissionMode: (this.appliedPermissionMode ?? this.session.getPermissionMode() ?? 'default') as PermissionMode,
                model: this.currentBackendModel,
                effort: this.currentBackendEffort
            });
        } catch (error) {
            logger.warn('[mcode-remote] Failed to queue the question answer', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Failed to send the question answer to MiniMax Code; reply in the chat instead.'
            });
            return;
        }
        // Queue the turn first so a failure cannot leave a user message with no
        // reply; the prompt only starts on the next microtask.
        this.session.sendUserMessage(trimmed);
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        this.pendingAskUserCall = null;
        if (this.questionHandler) {
            await this.questionHandler.cancelAll('Session ended');
            this.questionHandler = null;
        }

        if (this.permissionHandler) {
            await this.permissionHandler.cancelAll('Session ended');
            this.permissionHandler = null;
        }

        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }
    }

    /**
     * Applies the requested permission mode and reports whether the agent
     * accepted it. A failure can leave the policy half-applied (the config
     * option is process-scoped and the mode is a separate session axis), so
     * restore the previously applied mode before reporting the failure.
     */
    private async applyPermissionMode(sessionId: string, mode: PermissionMode | undefined): Promise<boolean> {
        if (!this.backend) return true;
        if (this.hasAppliedPermissionMode && this.appliedPermissionMode === mode) return true;
        try {
            await applyMcodePermissionMode(this.backend, sessionId, mode);
            this.appliedPermissionMode = mode ?? null;
            this.hasAppliedPermissionMode = true;
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const previous = this.appliedPermissionMode ?? 'default';
            logger.warn('[mcode-remote] Failed to apply permission mode; rolling back', error);
            try {
                await applyMcodePermissionMode(this.backend, sessionId, previous);
            } catch (rollbackError) {
                // Keep retrying the previous mode on the next turn rather than
                // claiming it was applied.
                logger.warn('[mcode-remote] Failed to roll back permission mode', rollbackError);
            }
            this.appliedPermissionMode = previous;
            this.hasAppliedPermissionMode = false;
            this.opts.onPermissionModeRollback?.(previous);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to apply MiniMax Code permission mode: ${message}. Keeping ${previous}.`
            });
            return false;
        }
    }

    /**
     * Registers the session-scoped ACP discovery RPCs. The launcher owns the
     * live backend, so model/effort reads do not need a throwaway probe
     * session, and the command roster can be refreshed on every request after
     * `available_commands_update`.
     */
    private registerAcpCommandHandlers(sessionId: string): void {
        const backend = this.backend;
        if (!backend) return;

        this.session.client.rpcHandlerManager.registerHandler<unknown, McodeModelsResponse>(
            RPC_METHODS.ListMcodeModels,
            async () => {
                const metadata = backend.getSessionModelsMetadata(sessionId);
                const effort = backend.getThoughtLevelConfigOption(sessionId);
                return {
                    success: true,
                    availableModels: (metadata?.availableModels ?? []).map((model) => ({
                        modelId: model.modelId,
                        ...(model.name ? { name: model.name } : {})
                    })),
                    currentModelId: metadata?.currentModelId ?? null,
                    effortOptions: (effort?.options ?? []).filter((option) => option.value !== 'default'),
                    currentEffort: effort?.currentValue === 'default' ? null : effort?.currentValue ?? null
                };
            }
        );

        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListSlashCommands, async () => {
            const acpCommands = backend.getAvailableCommands(sessionId).map((command) => ({
                name: command.name,
                ...(command.description ? { description: command.description } : {}),
                source: 'builtin' as const
            }));
            const localCommands = await listSlashCommands('mcode', this.session.path).catch(() => []);
            return {
                success: true,
                commands: mergeSlashCommands([
                    ...getBuiltinSlashCommands('mcode'),
                    ...localCommands,
                    ...acpCommands
                ])
            };
        });
    }

    private async applyInitialEffort(sessionId: string, effort: string | undefined): Promise<string | null> {
        if (!this.backend) return null;

        const option = this.backend.getThoughtLevelConfigOption(sessionId);
        if (!option) {
            if (effort) {
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'MiniMax Code did not advertise a thinking-effort option; using the agent default.'
                });
            }
            return null;
        }

        const currentEffort = option.currentValue === 'default' ? null : option.currentValue ?? null;
        if (!effort || effort === 'default') {
            return currentEffort;
        }

        try {
            await this.applyEffort(sessionId, effort);
            return effort;
        } catch (error) {
            const detail = (error instanceof Error ? error.message : String(error)).replace(/\.+$/, '');
            logger.warn('[mcode-remote] Failed to apply effort', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to set thinking effort to ${effort}: ${detail}. Using the agent default.`
            });
            return currentEffort;
        }
    }

    private async applyEffort(sessionId: string, effort: string): Promise<void> {
        if (!this.backend) {
            throw new Error('ACP backend is not initialized');
        }
        const option = this.backend.getThoughtLevelConfigOption(sessionId);
        if (!option) {
            throw new Error('MiniMax Code exposes no thinking-effort option');
        }
        if (option.options.length > 0 && !option.options.some((candidate) => candidate.value === effort)) {
            throw new Error(`Thinking effort ${effort} is not advertised`);
        }
        await this.backend.setConfigOption(sessionId, option.id, effort);
    }

    private async applyInitialModel(sessionId: string, model: string | undefined): Promise<string | null> {
        if (!this.backend) return null;

        const catalogModel = this.backend.getSessionModelsMetadata(sessionId)?.currentModelId ?? null;

        if (!model) {
            return catalogModel;
        }

        try {
            await this.backend.setModel(sessionId, model, { flavor: 'mcode' });
            return model;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const detail = message.replace(/\.+$/, '');
            logger.warn('[mcode-remote] Failed to apply model', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch model to ${model}: ${detail}. Using the agent default.`
            });
            return catalogModel;
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const { message: normalized, hint } = normalizeMcodeAskUserToolCall(message);
        if (hint) {
            this.pendingAskUserCall = hint;
        }
        const terminalId = normalized.type === 'tool_result'
            ? normalized.id
            : normalized.type === 'tool_call'
                && (normalized.status === 'completed' || normalized.status === 'failed')
                ? normalized.id
                : null;
        if (terminalId && this.pendingAskUserCall?.id === terminalId) {
            this.pendingAskUserCall = null;
        }

        const converted = convertAgentMessage(normalized, this.currentBackendModel);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (normalized.type) {
            case 'text':
                this.messageBuffer.addMessage(normalized.text, 'assistant');
                break;
            case 'reasoning':
                if (!normalized.live) {
                    this.messageBuffer.addMessage(`[Thinking] ${normalized.text.substring(0, 100)}...`, 'system');
                }
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${normalized.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(normalized.message, 'status');
                break;
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${normalized.fileName}`, 'assistant');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            case 'usage':
                break;
            default: {
                const _exhaustive: never = normalized;
                return _exhaustive;
            }
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined, model?: string): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
        if (model && model !== this.displayModel) {
            this.displayModel = model;
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
        }
    }

    private async handleAbort(): Promise<void> {
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            await backend.cancelPrompt(this.session.sessionId);
        }
        this.pendingAskUserCall = null;
        await this.questionHandler?.cancelAll('User aborted');
        await this.permissionHandler?.cancelAll('User aborted');
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' });
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }));
}

export async function mcodeRemoteLauncher(
    session: McodeSession,
    opts: McodeRemoteLauncherOptions
): Promise<'switch' | 'exit'> {
    const launcher = new McodeRemoteLauncher(session, opts);
    return launcher.launch();
}
