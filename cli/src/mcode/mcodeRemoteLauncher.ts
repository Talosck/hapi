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
import type { AcpSessionStateUpdate } from '@/agent/backends/acp';
import { McodePermissionHandler } from './utils/permissionHandler';
import {
    applyMcodePermissionMode,
    mapMcodePermissionMode,
    readMcodePermissionOption,
    resolveMcodePermissionMode
} from './utils/permissionModes';
import {
    McodeQuestionHandler,
    normalizeMcodeAskUserToolCall,
    type McodeAskUserCallHint
} from './utils/questionHandler';
import { BackgroundTaskAggregator } from './utils/backgroundTaskAggregator';
import { normalizeMcodeToolCall } from './utils/toolCallNormalizer';
import { acpModelIdToCliModelId, cliModelIdToAcpModelId } from './utils/modelId';
import {
    MCODE_NOTIFICATION_DELEGATION_UPDATE,
    MCODE_NOTIFICATION_GOAL_UPDATE,
    goalLifecycleSignature,
    parseMcodeDelegationUpdate,
    parseMcodeGoalUpdate,
    toHapiThreadGoal,
    toSubagentSnapshotMembers
} from './utils/mcodeExtensions';

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
    /**
     * Fired when the agent reports a permission mode of its own — the session
     * mode it switched to, or the tool permission policy it re-published.
     */
    onPermissionModeChanged?: (mode: PermissionMode) => void;
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
    private readonly backgroundTasks = new BackgroundTaskAggregator();
    /** ACP session id of the running MiniMax Code session. */
    private acpSessionId: string | null = null;
    /** Last delegation snapshot forwarded to the hub (state dedupe). */
    private lastDelegationSignature: string | null = null;
    /** Last goal lifecycle state rendered as a chat card. */
    private lastGoalLifecycleSignature: string | null = null;
    /** ACP session mode last reported by the agent (`default` / `plan`). */
    private currentSessionMode: string | null = null;
    /** The permission mode the hub currently shows for this session. */
    private hubPermissionMode: PermissionMode | null = null;

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

        // MiniMax Code streams its delegation tree and thread goal through
        // ACP extension notifications; the agent only emits them because the
        // backend advertised the matching capability during initialize.
        backend.setExtensionNotificationListener((method, params) => {
            this.handleExtensionNotification(method, params);
        });

        // The agent publishes the mode and the config options it actually runs
        // over the standard ACP session updates. HAPI mirrors them so the
        // session never advertises a mode the agent moved away from.
        backend.setSessionStateListener((update) => {
            this.handleSessionStateUpdate(update);
        });

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
                submitAnswer: (text) => this.submitQuestionAnswer(text),
                // Aborting a questionnaire aborts the turn: the agent would
                // otherwise keep working on it, and the other pending tool
                // approvals would stay open.
                onAbort: async (acpSessionId) => {
                    if (acpSessionId) {
                        await backend.cancelPrompt(acpSessionId);
                    }
                    await this.permissionHandler?.cancelAll('User aborted');
                }
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
        this.acpSessionId = acpSessionId;

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
            // The abort controller is replaced right after every abort, so the
            // signal has to be captured before the wait: reading
            // `this.abortController.signal` afterwards would inspect the NEW
            // controller, report "not aborted" and break out of the loop — an
            // abort while the agent is idle would end the whole HAPI session
            // instead of cancelling a turn.
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
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
            let modelSwitched = false;
            if (requestedModel && requestedModel !== this.currentBackendModel) {
                const resolvedModel = this.resolveModelId(acpSessionId, requestedModel);
                try {
                    await backend.setModel(acpSessionId, resolvedModel, { flavor: 'mcode' });
                    this.currentBackendModel = resolvedModel;
                    modelSwitched = true;
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
            // user's per-turn choice if it differs. The agent re-publishes its
            // config options right after the switch, so wait for that update
            // before reading the option: the cached list still belongs to the
            // previous model otherwise.
            if (modelSwitched) {
                await this.backend?.waitForSessionUpdateQueue(500);
            }
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
                this.flushBackgroundTasks();
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
            this.hubPermissionMode = mode ?? null;
            // HAPI's own request decides the session mode the agent runs with:
            // MiniMax Code applies a mode transition on the next prompt.
            this.currentSessionMode = mapMcodePermissionMode(mode).sessionMode;
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
            this.hubPermissionMode = previous;
            this.currentSessionMode = mapMcodePermissionMode(previous).sessionMode;
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

        const requestedModel = this.resolveModelId(sessionId, model);
        try {
            await this.backend.setModel(sessionId, requestedModel, { flavor: 'mcode' });
            return requestedModel;
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

    /**
     * Resolves a requested model to the id the agent publishes.
     *
     * The catalog carries the agent's wire ids (`m:provider:model:v:variant`),
     * while a user may name a model the way the MiniMax CLI does
     * (`provider/model#variant`). The catalog wins: the CLI form is matched
     * against the published models, and only a model the agent does not
     * publish is converted syntactically — so the agent rejects it with its
     * own message instead of the client guessing an id.
     */
    private resolveModelId(sessionId: string, requested: string): string {
        const catalog = this.backend?.getSessionModelsMetadata(sessionId)?.availableModels ?? [];
        if (catalog.some((model) => model.modelId === requested)) {
            return requested;
        }
        const byCliForm = catalog.find((model) => acpModelIdToCliModelId(model.modelId) === requested);
        if (byCliForm) {
            return byCliForm.modelId;
        }
        return cliModelIdToAcpModelId(requested) ?? requested;
    }

    private handleAgentMessage(message: AgentMessage): void {
        const askUser = normalizeMcodeAskUserToolCall(message);
        if (askUser.hint) {
            this.pendingAskUserCall = askUser.hint;
        }
        const normalized = normalizeMcodeToolCall(askUser.message);
        const terminalId = normalized.type === 'tool_result'
            ? normalized.id
            : normalized.type === 'tool_call'
                && (normalized.status === 'completed' || normalized.status === 'failed')
                ? normalized.id
                : null;
        if (terminalId && this.pendingAskUserCall?.id === terminalId) {
            this.pendingAskUserCall = null;
        }

        for (const forwarded of this.backgroundTasks.handle(normalized)) {
            this.emitAgentMessage(forwarded);
        }
        this.reportBackgroundTaskDelta();
    }

    private reportBackgroundTaskDelta(): void {
        const delta = this.backgroundTasks.takeBackgroundTaskDelta();
        if (delta) {
            this.session.sendBackgroundTaskDelta(delta);
        }
    }

    /**
     * Routes MiniMax Code's ACP extension notifications. Unknown methods are
     * ignored: the agent may add more extensions over time.
     */
    private handleExtensionNotification(method: string, params: unknown): void {
        if (method === MCODE_NOTIFICATION_DELEGATION_UPDATE) {
            this.handleDelegationUpdate(params);
            return;
        }
        if (method === MCODE_NOTIFICATION_GOAL_UPDATE) {
            this.handleGoalUpdate(params);
        }
    }

    /**
     * Handles the ACP session updates that publish the agent's own state: the
     * session mode it switched to, the config options it re-published and the
     * plan it withdrew.
     */
    private handleSessionStateUpdate(update: AcpSessionStateUpdate): void {
        if (update.kind === 'mode') {
            this.currentSessionMode = update.modeId;
        }
        if (update.kind === 'plan-removed') {
            // The agent withdrew a plan (MiniMax Code removes the plan it
            // attached to a questionnaire once the questionnaire is answered).
            // The web drops the matching plan card.
            this.session.sendSessionEvent({ type: 'plan-removed', planId: update.planId });
            return;
        }
        this.publishAgentPermissionMode();
    }

    /**
     * Publishes the permission mode the agent runs with.
     *
     * MiniMax Code keeps the tool permission policy and the ACP session mode
     * on separate axes, and the policy is process-scoped: another session
     * attached to the same process changes it without HAPI asking. The agent
     * re-publishes its config options whenever that happens, so the effective
     * mode is derived from what the agent reports rather than from what HAPI
     * last requested.
     *
     * Publishing starts once HAPI applied a mode of its own: before that the
     * agent may still report the state of a session HAPI has not taken over
     * yet, and the user's choice is the one that counts.
     */
    private publishAgentPermissionMode(): void {
        const backend = this.backend;
        const sessionId = this.acpSessionId;
        if (!backend || !sessionId) return;
        if (!this.hasAppliedPermissionMode) return;

        const permissionMode = resolveMcodePermissionMode(
            this.currentSessionMode,
            readMcodePermissionOption(backend, sessionId)
        );
        if (permissionMode === this.hubPermissionMode) return;
        this.hubPermissionMode = permissionMode;
        this.opts.onPermissionModeChanged?.(permissionMode);
    }

    /**
     * Forwards the live delegation tree. MiniMax Code does not stream the
     * subagents' own tool calls, so this snapshot is the only view of them.
     */
    private handleDelegationUpdate(params: unknown): void {
        const snapshot = parseMcodeDelegationUpdate(params);
        if (!snapshot) {
            logger.debug('[mcode-remote] ignoring malformed delegation update');
            return;
        }

        const members = toSubagentSnapshotMembers(snapshot);
        const signature = JSON.stringify(members);
        if (signature === this.lastDelegationSignature) {
            return;
        }
        this.lastDelegationSignature = signature;

        this.session.sendSessionEvent({ type: 'subagent-snapshot', members });
    }

    /**
     * Forwards the live thread goal. The goal state event keeps the web
     * status panel current; the chat card records the goal's lifecycle
     * (objective / status / budget) without one card per accounting update.
     */
    private handleGoalUpdate(params: unknown): void {
        const update = parseMcodeGoalUpdate(params);
        if (!update) {
            logger.debug('[mcode-remote] ignoring malformed goal update');
            return;
        }

        if (update.kind === 'cleared') {
            this.lastGoalLifecycleSignature = null;
            this.session.sendSessionEvent({ type: 'thread-goal-cleared' });
            return;
        }

        const threadId = this.acpSessionId ?? update.goal.sessionId;
        const goal = toHapiThreadGoal(update.goal, threadId);
        this.session.sendSessionEvent({ type: 'thread-goal-updated', goal });

        const signature = goalLifecycleSignature(goal, update.goal.goalId);
        if (signature === this.lastGoalLifecycleSignature) {
            return;
        }
        this.lastGoalLifecycleSignature = signature;
        this.session.sendSessionEvent({
            type: 'message',
            message: JSON.stringify({ goal })
        });
    }

    private emitAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentBackendModel);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                if (!message.live) {
                    this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
                }
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'plan_document':
                this.messageBuffer.addMessage('Plan document received', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            case 'usage':
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    /** Release background task cards that could not be tracked reliably. */
    private flushBackgroundTasks(): void {
        for (const message of this.backgroundTasks.flushPromptEnd()) {
            this.emitAgentMessage(message);
        }
        this.reportBackgroundTaskDelta();
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
        for (const message of this.backgroundTasks.cancelAll('Session aborted')) {
            this.emitAgentMessage(message);
        }
        this.reportBackgroundTaskDelta();
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
