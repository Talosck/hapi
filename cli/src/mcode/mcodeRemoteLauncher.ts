import React from 'react';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type {
    McodeDelegationStopResponse,
    McodeGoalClearResponse,
    McodeGoalResponse,
    McodeModelsResponse
} from '@hapi/protocol/apiTypes';
import { isObject } from '@hapi/protocol';
import type { ThreadGoal } from '@hapi/protocol';
import { getBuiltinSlashCommands, mergeSlashCommands } from '@hapi/protocol/slashCommands';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { registerSlashCommandHandlers } from '@/modules/common/handlers/slashCommands';
import { registerMcodeSessionModelHandlers } from '@/modules/common/handlers/mcodeModels';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { McodeDisplay } from '@/ui/ink/McodeDisplay';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { McodeSession } from './session';
import type { McodeMode, PermissionMode } from './types';
import { createMcodeBackend } from './utils/mcodeBackend';
import type { AcpSessionStateUpdate } from '@/agent/backends/acp';
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport';
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
    MCODE_METHOD_DELEGATION_GET,
    MCODE_METHOD_GOAL_GET,
    MCODE_METHOD_STEER,
    MCODE_NOTIFICATION_DELEGATION_UPDATE,
    MCODE_NOTIFICATION_GOAL_UPDATE,
    goalLifecycleSignature,
    parseMcodeDelegationUpdate,
    parseMcodeGoalUpdate,
    parseMcodeExtensionSupport,
    toHapiThreadGoal,
    toMcodeGoalPatchStatus,
    toSubagentSnapshotMembers,
    type McodeGoal
} from './utils/mcodeExtensions';
import { McodeExtensionControl } from './utils/mcodeExtensionControl';
import { McodeConversationHistory } from './conversationHistory';

/** First wait before retrying a turn the agent refused because it was busy. */
const MCODE_BUSY_RETRY_BASE_MS = 1_000;
/** Longest wait between two attempts at a refused turn. */
const MCODE_BUSY_RETRY_MAX_MS = 10_000;
/** How many refusals pass before the user is told the wait is not ending. */
const MCODE_BUSY_STUCK_REFUSALS = 12;

/**
 * Why the agent refused the turn, if it refused it for a transient reason.
 *
 * MiniMax Code refuses a `session/prompt` while the session is not ready to
 * take a turn, and it answers with 409 in three shapes:
 *
 * - `local_session_busy`: the session's turn lease is held. The lease is held
 *   for the whole turn, and the common case inside HAPI is the agent's own
 *   work: a background task (a subagent) runs as a turn on the same native
 *   session, so a user message that arrives while it runs is refused. A
 *   second live client attached to the same native session (the local TUI,
 *   another runner) holds it as well.
 * - `local_session_compacting`: the session is compacting its context.
 * - `local_session_mutating`: the conversation is being changed (a fork, a
 *   clear).
 *
 * All three end when the agent finishes what it is doing, so the message can
 * simply be delivered later. Every other error is a real failure and is
 * reported as it is.
 */
type McodeRefusalReason = 'busy' | 'compacting' | 'mutating';

function classifyMcodeRefusal(message: string): McodeRefusalReason | null {
    if (/session already has an active turn/i.test(message)) {
        return 'busy';
    }
    if (/session compaction is active/i.test(message)) {
        return 'compacting';
    }
    if (/session conversation is being changed/i.test(message)) {
        return 'mutating';
    }
    return null;
}

export type McodeRemoteLauncherOptions = {
    model?: string;
    effort?: string;
    /** Fired once after session/new or session/load with the effective model/effort. */
    onConfigDiscovered?: (config: { model: string | null; effort: string | null }) => void;
    /** Fired after a failed inline switch, with the model still active. */
    onModelRollback?: (model: string | null) => void;
    /**
     * Fired when the agent moves to another model on its own - a sibling
     * session on the same process, or the user in the agent's own UI.
     */
    onAgentModelChanged?: (model: string) => void;
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
    /** The permission mode HAPI last asked for, even when the agent cannot honor it. */
    private requestedPermissionMode: PermissionMode | null = null;
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
    /** Drives the goal and delegation extension methods the agent advertised. */
    private extensionControl: McodeExtensionControl | null = null;
    /** Drives MiniMax Code's conversation history controls (fork). */
    private conversationHistory: McodeConversationHistory | null = null;
    /**
     * Whether a turn is running and can still take a steer.
     *
     * MiniMax Code steers into the running ACP prompt turn, so the web may
     * only offer the Steer button while a turn is actually in flight.
     */
    private steeringActive = false;
    /**
     * How often the agent refused a turn because the session was busy.
     *
     * The agent hands the message back when the session's turn lease is held
     * by another turn - its own background task, or another live client
     * attached to the same native session. The retry wait grows with this
     * counter so a long-running turn does not turn into a prompt-per-second
     * loop.
     */
    private busyRefusals = 0;
    /** When the agent started refusing turns, for the "still busy" notice. */
    private busySinceMs: number | null = null;
    /**
     * The local ids of the messages that are already in the display buffer.
     *
     * A refused turn goes back into the queue and is delivered on the retry:
     * without this the message would show up twice in the transcript.
     */
    private readonly displayedLocalIds = new Set<string>();

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

        // The agent advertises its extension surface (methods it accepts and
        // notifications it emits) in the initialize response. MiniMax Code
        // feature-gates its goal extension at runtime, so the advertised list —
        // not the HAPI side — decides which features this session has.
        const extensionSupport = parseMcodeExtensionSupport(backend.getInitializeMeta());
        this.extensionControl = new McodeExtensionControl(backend, extensionSupport);
        this.publishCapabilities();

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
        this.registerExtensionControlHandlers(acpSessionId);
        this.registerConversationHistoryHandlers(acpSessionId);
        this.registerSteerHandler(acpSessionId);
        // A resumed session may still carry a stale "a turn is running" flag
        // from the process that died: clear it before anything can steer.
        this.setSteeringActive(false);
        // The goal notification is a one-way push: a resumed session would
        // otherwise show no goal even though the agent is still running one.
        await this.restoreGoalState(acpSessionId);
        await this.restoreDelegationState(acpSessionId);

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

            await this.applyPermissionMode(acpSessionId, batch.mode.permissionMode);
            // Keep the per-turn mode in sync with the policy the agent
            // actually runs: a rolled-back apply and an agent that cannot
            // switch session modes both end up on a different mode than the
            // one that was asked for.
            batch.mode.permissionMode = this.appliedPermissionMode ?? 'default';

            this.applyDisplayMode(batch.mode.permissionMode, this.currentBackendModel ?? undefined);
            this.showUserMessage(messageBuffer, batch);

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            // Publish the steerable flag before the thinking flag: a client
            // that offers Steer on "thinking" must never be ahead of the
            // agent's own "a turn is running" state.
            this.setSteeringActive(true);
            session.onThinkingChange(true);
            // The agent can only be forked at the end of a finished turn, so the
            // fork control has to know that a turn is running.
            this.conversationHistory?.setBusy(true);

            // Set when the agent refused the turn because the session was
            // busy: the batch is back in the queue and the loop has to wait
            // before it tries again.
            let refusedAsBusy = false;

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                }, {
                    // The abort can land between taking the message and
                    // starting the turn: the model / effort / mode round trips
                    // above take real time, and `handleAbort` cancels a
                    // *running* prompt — of which there is none yet, so the
                    // abort would be lost and the agent would keep working on
                    // a message the user just stopped. The batch was
                    // acknowledged when it left the queue, so it cannot be
                    // dropped either. Start the turn and cancel it right
                    // behind the request instead: the transport keeps the
                    // order, so the agent registers the turn and then
                    // cancels it before it does any work.
                    onPromptSent: () => {
                        if (waitSignal.aborted) {
                            void backend.cancelPrompt(acpSessionId);
                        }
                    }
                });
                this.busyRefusals = 0;
                this.busySinceMs = null;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const refusal = classifyMcodeRefusal(errorMessage);
                if (refusal && !waitSignal.aborted && !this.shouldExit) {
                    // The agent refused the turn for a transient reason: the
                    // session still has an active one - the common case is the
                    // agent's own background task running as a turn on this
                    // session, but a second live client attached to it (the
                    // local TUI, another runner) holds it as well. It says to
                    // deliver the message after the turn ends. The batch was
                    // acknowledged when it left the queue, so dropping it
                    // would lose the message - put it back and let the loop
                    // deliver it once the session is ready again.
                    this.requeueRefusedBatch(batch);
                    this.reportRefusal(session, refusal, errorMessage);
                    refusedAsBusy = true;
                } else {
                    logger.warn('[mcode-remote] prompt failed', { message: errorMessage });
                    session.sendSessionEvent({
                        type: 'message',
                        message: `MiniMax Code prompt failed: ${errorMessage}`
                    });
                    messageBuffer.addMessage(`MiniMax Code prompt failed: ${errorMessage}`, 'status');
                }
            } finally {
                this.flushBackgroundTasks();
                session.onThinkingChange(false);
                this.conversationHistory?.setBusy(false);
                this.setSteeringActive(false);
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

            // The wait happens after the turn cleanup above: the agent is not
            // running while it waits, so the session must not look busy - a
            // client that offers "Steer" on a busy session would steer a turn
            // that does not exist.
            if (refusedAsBusy) {
                await this.waitBeforeRetry(waitSignal);
            }
        }
    }

    /**
     * Tells the user why their message is waiting.
     *
     * The agent's own text ("Session already has an active Turn. Use queue
     * send to deliver the message after it.") names a mechanism the user
     * cannot reach, so the notice says what is actually going on: the
     * session is busy, and the message is not lost.
     */
    private reportRefusal(session: McodeSession, reason: McodeRefusalReason, errorMessage: string): void {
        this.busySinceMs ??= Date.now();
        if (this.busyRefusals === 1) {
            const what = reason === 'busy'
                ? 'MiniMax Code is busy with another turn on this session - a task it is running, or another MiniMax Code window attached to it - and refused your message.'
                : reason === 'compacting'
                    ? 'MiniMax Code is compacting this conversation and refused your message.'
                    : 'MiniMax Code is changing this conversation and refused your message.';
            session.sendSessionEvent({
                type: 'message',
                message: `${what} Your message is kept and goes out as soon as that finishes.`
            });
            logger.debug('[mcode-remote] session refused the turn', { reason, message: errorMessage });
            return;
        }
        if (this.busyRefusals === MCODE_BUSY_STUCK_REFUSALS) {
            const waitedSeconds = Math.round((Date.now() - (this.busySinceMs ?? Date.now())) / 1000);
            session.sendSessionEvent({
                type: 'message',
                message: `MiniMax Code is still busy after ${waitedSeconds} seconds. Your message is still queued and goes out on its own as soon as the session frees up. If nothing is running, close any leftover MiniMax Code process, or start a new session.`
            });
        }
    }

    /**
     * Puts the user message in the terminal transcript, once.
     *
     * The message is added before the prompt so it shows up while the agent
     * works. A turn the agent refused is delivered on a later attempt, and the
     * retry must not repeat the line.
     */
    private showUserMessage(messageBuffer: MessageBuffer, batch: {
        message: string;
        items?: Array<{ localId?: string }>;
    }): void {
        const localIds = (batch.items ?? [])
            .map((item) => item.localId)
            .filter((localId): localId is string => Boolean(localId));
        const alreadyShown = localIds.length > 0 && localIds.every((localId) => this.displayedLocalIds.has(localId));
        if (!alreadyShown) {
            messageBuffer.addMessage(batch.message, 'user');
        }
        for (const localId of localIds) {
            this.displayedLocalIds.add(localId);
        }
    }

    /**
     * Puts a refused batch back into the queue.
     *
     * The batch was acknowledged when it left the queue, so a refused turn
     * would lose the message otherwise. Every item goes back on its own, in
     * reverse order, so each one keeps its local id (the hub row it belongs
     * to) and the original order of the messages is restored - the same
     * restore the claude flavor does when its SDK call fails.
     *
     * The batch keeps its shape: an isolated batch (a slash command that has
     * to run alone) goes back isolated, and an ordinary batch goes back as an
     * ordinary batch, so the messages are still delivered together.
     *
     * The re-queued message lives in this process only: the hub already
     * marked it as delivered, so a runner that dies while it waits loses it.
     * The alternative - leaving it unacknowledged in the hub - would change
     * the delivery contract for every MiniMax Code message.
     */
    private requeueRefusedBatch(batch: {
        message: string;
        mode: McodeMode;
        isolate?: boolean;
        items?: Array<{ message: string; localId?: string }>;
    }): void {
        const items = batch.items?.length ? batch.items : [{ message: batch.message }];
        for (const item of [...items].reverse()) {
            try {
                if (batch.isolate) {
                    this.session.queue.unshiftIsolated(item.message, batch.mode, item.localId);
                } else {
                    this.session.queue.unshift(item.message, batch.mode, item.localId);
                }
            } catch (error) {
                logger.warn('[mcode-remote] Failed to re-queue a refused message', error);
            }
        }
        this.busyRefusals += 1;
        logger.debug('[mcode-remote] Refused turn re-queued', { messages: items.length });
    }

    /**
     * Waits before the next attempt at a refused turn.
     *
     * The lease the agent holds is released when the other turn ends, which
     * can take a while - a background task can hold the session for minutes.
     * The wait grows with the number of refusals so a long-running turn does
     * not turn into a prompt-per-second loop.
     */
    private async waitBeforeRetry(signal: AbortSignal): Promise<void> {
        const delay = Math.min(
            MCODE_BUSY_RETRY_BASE_MS * this.busyRefusals,
            MCODE_BUSY_RETRY_MAX_MS
        );
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, delay);
            const onAbort = () => {
                clearTimeout(timer);
                resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
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

        // The goal and the delegation tree belong to the remote session: the
        // local TUI has its own state, so the web must not keep showing them
        // after the handoff.
        this.session.sendSessionEvent({ type: 'thread-goal-cleared' });
        this.session.sendSessionEvent({ type: 'subagent-snapshot', members: [] });
        // The extension surface belongs to the agent process that just went
        // away, so the web must not offer controls the local TUI cannot honor.
        // The flags are set to "off" rather than removed: the hub merges
        // metadata writes, so a removed key could survive the merge.
        this.extensionControl = null;
        // The same goes for the history controls: the local TUI cannot fork
        // either, and the metadata merge would keep a stale "fork supported"
        // that leaves a dead Fork button on the last message.
        await this.conversationHistory?.disable();
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            capabilities: {
                ...metadata?.capabilities,
                mcodeExtensions: {
                    goal: false,
                    goalCreate: false,
                    goalPatch: false,
                    goalClear: false,
                    delegation: false,
                    delegationStop: false
                }
            }
        }));

        // The live session-scoped catalog dies with the backend. Restore the
        // probe-based handlers so the local mode can still answer the model
        // picker and the slash command list.
        registerMcodeSessionModelHandlers(this.session.client.rpcHandlerManager, () => this.session.path);
        registerSlashCommandHandlers(this.session.client.rpcHandlerManager, this.session.path);

        if (this.backend) {
            // `session/close` releases the attachment state the agent keeps for
            // a connected session. The session itself stays in the agent's
            // data directory, so a later run can load it again.
            if (this.acpSessionId) {
                try {
                    await this.backend.closeSession(this.acpSessionId);
                } catch (error) {
                    logger.debug('[mcode-remote] Failed to close the MiniMax Code session', error);
                }
            }
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
    private async applyPermissionMode(sessionId: string, mode: PermissionMode | undefined): Promise<void> {
        if (!this.backend) return;
        if (this.hasAppliedPermissionMode && this.requestedPermissionMode === (mode ?? null)) return;
        try {
            const applied = await applyMcodePermissionMode(this.backend, sessionId, mode);
            this.appliedPermissionMode = applied.mode;
            this.requestedPermissionMode = mode ?? null;
            this.hasAppliedPermissionMode = true;
            this.hubPermissionMode = applied.mode;
            if (applied.sessionModeApplied) {
                // HAPI's own request decides the session mode the agent runs with:
                // MiniMax Code applies a mode transition on the next prompt.
                this.currentSessionMode = mapMcodePermissionMode(mode).sessionMode;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const previous = this.appliedPermissionMode ?? 'default';
            logger.warn('[mcode-remote] Failed to apply permission mode; rolling back', error);
            try {
                const restored = await applyMcodePermissionMode(this.backend, sessionId, previous);
                if (restored.sessionModeApplied) {
                    this.currentSessionMode = mapMcodePermissionMode(previous).sessionMode;
                }
            } catch (rollbackError) {
                // Keep retrying the previous mode on the next turn rather than
                // claiming it was applied.
                logger.warn('[mcode-remote] Failed to roll back permission mode', rollbackError);
            }
            this.appliedPermissionMode = previous;
            this.requestedPermissionMode = previous;
            this.hasAppliedPermissionMode = false;
            this.hubPermissionMode = previous;
            this.opts.onPermissionModeRollback?.(previous);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to apply MiniMax Code permission mode: ${message}. Keeping ${previous}.`
            });
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

    /**
     * Publishes what the running agent supports.
     *
     * The web renders the goal, subagent and fork controls from these flags,
     * so a session whose agent does not support one of them shows no control
     * instead of a button that would fail.
     */
    private publishCapabilities(): void {
        const extensionCapabilities = this.extensionControl?.getCapabilities();
        const historyCapabilities = this.conversationHistory?.getCapabilitiesForMetadata();
        if (!extensionCapabilities && !historyCapabilities) return;
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            capabilities: {
                ...metadata?.capabilities,
                ...(extensionCapabilities ? { mcodeExtensions: extensionCapabilities } : {}),
                ...(historyCapabilities ?? {})
            }
        }));
    }

    /**
     * Registers the conversation history controls.
     *
     * MiniMax Code forks the whole session - its `session/fork` takes the
     * same parameters as `session/load`, so there is no branch at a message.
     */
    private registerConversationHistoryHandlers(sessionId: string): void {
        const history = new McodeConversationHistory(() => this.backend);
        history.setSession(sessionId, this.session.path);
        history.setPublishCapabilities(async () => {
            this.publishCapabilities();
        });
        this.conversationHistory = history;

        this.session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.ForkConversation,
            async (payload: unknown) => {
                const messageLocalId = isObject(payload) && typeof payload.messageLocalId === 'string'
                    ? payload.messageLocalId
                    : undefined;
                return await history.fork(messageLocalId);
            }
        );

        // The agent lists `fork` in its initialize response, so the capability
        // is known without probing by forking a real session.
        void history.probeCapabilities().catch((error) => {
            logger.debug('[mcode-remote] conversation history capability probe failed', error);
        });
    }

    /**
     * Publishes whether a turn is running and can still take a steer.
     *
     * The web offers the Steer button on a queued message only while this is
     * true - MiniMax Code steers into the running turn, not into a turn that
     * has not started yet.
     */
    private setSteeringActive(value: boolean): void {
        this.steeringActive = value;
        this.session.client.updateAgentState((state) => ({ ...state, steeringActive: value }));
    }

    /**
     * Registers the steer RPC.
     *
     * MiniMax Code steers a message into the running ACP prompt turn
     * (`mcode/session/steer`), which is a true mid-turn inject: the agent
     * sees the message while it is still working. The agent refuses a steer
     * when no turn is active, so the row goes back to the queue and is
     * delivered by the normal loop instead.
     */
    private registerSteerHandler(sessionId: string): void {
        this.session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.SteerQueuedMessage,
            async (payload: unknown) => {
                const localId = isObject(payload) && typeof payload.localId === 'string'
                    ? payload.localId
                    : null;
                if (!localId) {
                    return { steered: false, error: 'A steer needs a message local id' };
                }
                if (!this.steeringActive) {
                    return { steered: false, error: 'MiniMax Code has no running turn to steer' };
                }
                if (!this.extensionControl?.supportsMethod(MCODE_METHOD_STEER)) {
                    return { steered: false, error: 'MiniMax Code did not advertise the steer extension' };
                }
                const backend = this.backend;
                if (!backend) {
                    return { steered: false, error: 'MiniMax Code is not connected' };
                }

                // Take the message out of the queue first: the normal loop must
                // not deliver it as well if the steer succeeds.
                const taken = this.session.queue.takeByLocalId(localId);
                if (!taken) {
                    return { steered: false, error: 'Message is not queued' };
                }
                if (!this.session.queue.beginReservationDispatch(taken)) {
                    this.session.queue.restoreReservation(taken);
                    return { steered: false, error: 'Steer was cancelled' };
                }

                // Persist the pre-dispatch state, so a runner restart cannot
                // replay a steer whose outcome was never proven.
                const dispatchStatePersisted = await this.session.client.setSteerDeliveryState([localId], 'dispatching');
                if (!dispatchStatePersisted) {
                    this.session.queue.markReservationIndeterminate(taken);
                    this.session.client.emitSteerIndeterminate([localId]);
                    return { steered: false, error: 'Steer state is indeterminate' };
                }

                try {
                    const response = await backend.sendExtensionRequest<Record<string, unknown>>(
                        'mcode/session/steer',
                        // The client request id is the agent's idempotency key: a
                        // retried steer must not inject the message twice.
                        { sessionId, text: taken.item.message, clientRequestId: localId }
                    );
                    const mode = isObject(response) && typeof response.mode === 'string'
                        ? response.mode
                        : null;
                    if (mode !== 'steered') {
                        // The agent answered, but it did not take the message.
                        await this.session.client.setSteerDeliveryState([localId], 'queued');
                        this.session.queue.restoreReservation(taken);
                        return { steered: false, error: 'MiniMax Code did not accept the steer' };
                    }
                    this.session.queue.commitReservation(taken);
                    this.session.client.emitMessagesConsumed([localId], { steered: true });
                    return { steered: true };
                } catch (error) {
                    if (isAcpIndeterminateError(error)) {
                        // The request may have reached the agent: it can have
                        // injected the message before the transport failed.
                        // Restoring the row would let the hub replay it and the
                        // agent would see the message twice, so the row is held
                        // out of the automatic queue for an explicit retry or
                        // cancel instead.
                        if (this.session.queue.markReservationIndeterminate(taken)) {
                            this.session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[mcode-remote] steer outcome unknown; row held for explicit resolution', error);
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    // A rejection means the agent did not take the message: the
                    // row goes back to the queue and the normal loop delivers
                    // it after the turn.
                    await this.session.client.setSteerDeliveryState([localId], 'queued');
                    this.session.queue.restoreReservation(taken);
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn('[mcode-remote] steer rejected', { message });
                    return { steered: false, error: message };
                }
            }
        );
    }

    /**
     * Registers the goal and delegation control RPCs.
     *
     * Every handler checks the advertised extension surface first: an agent
     * that does not support the goal extension answers with a clear message
     * rather than an opaque JSON-RPC failure.
     */
    private registerExtensionControlHandlers(sessionId: string): void {
        const control = this.extensionControl;
        if (!control) return;
        const manager = this.session.client.rpcHandlerManager;

        manager.registerHandler<unknown, McodeGoalResponse>(
            RPC_METHODS.McodeCreateGoal,
            async (payload) => {
                const objective = readRequestString(payload, 'objective');
                if (!objective) {
                    return { success: false, error: 'A goal needs an objective' };
                }
                const tokenBudget = readRequestNumber(payload, 'tokenBudget');
                const response = await control.createGoal(sessionId, objective, tokenBudget ?? null);
                this.applyGoalResponse(response.goal);
                return response;
            }
        );

        manager.registerHandler<unknown, McodeGoalResponse>(
            RPC_METHODS.McodePatchGoal,
            async (payload) => {
                const patch: { status?: string; objective?: string; tokenBudget?: number | null } = {};
                const status = readRequestString(payload, 'status');
                if (status) {
                    const mapped = toMcodeGoalPatchStatus(status as ThreadGoal['status']);
                    if (!mapped) {
                        return {
                            success: false,
                            error: `MiniMax Code cannot be asked to enter the "${status}" goal status`
                        };
                    }
                    patch.status = mapped;
                }
                const objective = readRequestString(payload, 'objective');
                if (objective) patch.objective = objective;
                const tokenBudget = readRequestNumber(payload, 'tokenBudget');
                if (tokenBudget !== undefined) patch.tokenBudget = tokenBudget;

                if (Object.keys(patch).length === 0) {
                    return { success: false, error: 'A goal update needs at least one field' };
                }
                const response = await control.patchGoal(sessionId, patch);
                this.applyGoalResponse(response.goal);
                return response;
            }
        );

        manager.registerHandler<unknown, McodeGoalClearResponse>(
            RPC_METHODS.McodeClearGoal,
            async () => {
                const response = await control.clearGoal(sessionId);
                if (response.success && response.cleared) {
                    this.lastGoalLifecycleSignature = null;
                    this.session.sendSessionEvent({ type: 'thread-goal-cleared' });
                }
                return response;
            }
        );

        manager.registerHandler<unknown, McodeDelegationStopResponse>(
            RPC_METHODS.McodeStopDelegation,
            async () => {
                const response = await control.stopDelegation(sessionId);
                if (response.success && response.receipt) {
                    // The agent re-publishes the delegation tree after a stop,
                    // but a session without subagents must not keep a stale
                    // tree on screen.
                    if (response.receipt.stoppedSessionIds.length > 0 || response.receipt.rootStopped) {
                        this.lastDelegationSignature = null;
                    }
                }
                return response;
            }
        );
    }

    /**
     * Forwards a goal the agent returned in response to a control call.
     *
     * The agent also pushes goal updates as a notification, but a call
     * response is the only source for a goal created or patched outside the
     * notification stream.
     */
    private applyGoalResponse(goal: McodeGoal | null | undefined): void {
        if (!goal) return;
        this.handleGoalUpdate({ goal });
    }

    /**
     * Restores the goal of a resumed session.
     *
     * The goal notification is a one-way push, so a CLI that restarted would
     * otherwise leave the web without the goal the agent is still running.
     */
    private async restoreGoalState(sessionId: string): Promise<void> {
        const control = this.extensionControl;
        if (!control?.supportsMethod(MCODE_METHOD_GOAL_GET)) return;
        const response = await control.getGoal(sessionId);
        if (!response.success || !response.goal) return;
        this.applyGoalResponse(response.goal);
    }

    /**
     * Restores the delegation tree of a resumed session.
     *
     * The tree is a one-way push like the goal, so a CLI that restarted would
     * otherwise leave the web without the subagents the agent is still
     * running.
     */
    private async restoreDelegationState(sessionId: string): Promise<void> {
        const control = this.extensionControl;
        if (!control?.supportsMethod(MCODE_METHOD_DELEGATION_GET)) return;
        const snapshot = await control.getDelegationSnapshot(sessionId);
        // An empty tree is not a state change: the panel already shows no
        // subagents, and forwarding it would clear a tree the agent has not
        // published yet.
        if (!snapshot || snapshot.members.length === 0) return;
        this.handleDelegationUpdate({ snapshot });
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
     *
     * A notification the agent did not advertise is ignored as well. The agent
     * gates its goal extension at runtime, so a build without goals never
     * emits `goal_update` — and a build that renames it must not leave the
     * web showing a goal nobody can control.
     */
    private handleExtensionNotification(method: string, params: unknown): void {
        if (method === MCODE_NOTIFICATION_DELEGATION_UPDATE) {
            if (!this.supportsExtensionNotification(method)) return;
            this.handleDelegationUpdate(params);
            return;
        }
        if (method === MCODE_NOTIFICATION_GOAL_UPDATE) {
            if (!this.supportsExtensionNotification(method)) return;
            this.handleGoalUpdate(params);
        }
    }

    /**
     * Whether the agent advertised this notification.
     *
     * An agent that advertised no extension surface at all (an older build)
     * is treated as supporting nothing: the notifications it does send are
     * then ignored rather than half-handled.
     */
    private supportsExtensionNotification(notification: string): boolean {
        return this.extensionControl?.supportsNotification(notification) === true;
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
        if (update.kind === 'config-options') {
            this.refreshAgentModel();
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
     * Adopts the model the agent actually runs.
     *
     * The agent can move to another model on its own - a sibling session on the
     * same process, or the user in the agent's own UI. The hub must not keep
     * advertising the model HAPI set earlier, or the session header shows a
     * model the agent is not running.
     */
    private refreshAgentModel(): void {
        const backend = this.backend;
        if (!backend || !this.acpSessionId) return;
        const agentModel = backend.getSessionModelsMetadata(this.acpSessionId)?.currentModelId;
        if (!agentModel || agentModel === this.currentBackendModel) return;
        logger.debug('[mcode-remote] Agent moved to another model', { from: this.currentBackendModel, to: agentModel });
        this.currentBackendModel = agentModel;
        this.opts.onAgentModelChanged?.(agentModel);
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

/** Reads a non-empty string field from an RPC payload. */
function readRequestString(payload: unknown, key: string): string | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads a numeric field from an RPC payload.
 *
 * `null` is a meaningful value for a token budget ("unlimited"), so it is
 * reported separately from "the caller did not send one".
 */
function readRequestNumber(payload: unknown, key: string): number | null | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const value = (payload as Record<string, unknown>)[key];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return value;
}

export async function mcodeRemoteLauncher(
    session: McodeSession,
    opts: McodeRemoteLauncherOptions
): Promise<'switch' | 'exit'> {
    const launcher = new McodeRemoteLauncher(session, opts);
    return launcher.launch();
}
