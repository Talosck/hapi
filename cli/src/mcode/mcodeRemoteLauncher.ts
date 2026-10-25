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
import { rememberMcodeAgentHostPid, markMcodeAgentStarting } from './utils/mcodeConnectorTools';
import { classifyMcodeConnectFailure } from './utils/mcodeConnectFailure';
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
import { readMcodeTurnLease, type McodeTurnLeaseState } from './utils/mcodeTurnLease';
import {
    readMcodeBackgroundTaskStates,
    type McodeBackgroundTaskState
} from './utils/mcodeBackgroundTaskState';
import { renderMcodeDeliverables, splitMcodeDeliverables } from './utils/mcodeDeliverables';
import { McodeDisplayedMessageIds } from './utils/mcodeDisplayedMessageIds';
import { findMcodeMessagesPath } from './utils/mcodeUsage';
import { readMcodeTranscriptToolMessages } from './utils/mcodeSessionTranscript';
import { McodeConversationHistory } from './conversationHistory';

/** First wait before retrying a turn the agent refused because it was busy. */
const MCODE_BUSY_RETRY_BASE_MS = 1_000;
/**
 * Longest wait between two attempts at a refused turn.
 *
 * The wait doubles with every refusal (1s, 2s, 4s, ...), so a turn the agent
 * holds for minutes does not turn into a prompt-per-second loop.
 */
const MCODE_BUSY_RETRY_MAX_MS = 60_000;
/**
 * How often the session's turn lease is read while the agent holds it.
 *
 * The lease is a row in the agent's runtime index, so a poll is a local file
 * read - no round trip to the agent, nothing written, nothing logged.
 */
const MCODE_TURN_LEASE_POLL_MS = 400;
/**
 * How long the agent may hold the session before the user is told that the
 * wait is not ending.
 */
const MCODE_TURN_LEASE_STUCK_MS = 60_000;

/**
 * How often the background work of a session is checked against the record
 * the agent's runtime keeps of it.
 *
 * The runtime reports a finished background task into the owner session with a
 * turn of the agent's own, and that turn is not streamed to the client. A
 * client that only watches the tool stream therefore keeps showing a task that
 * ended as one that still runs. The runtime's record settles it, and the
 * check is a local file read - no round trip to the agent.
 */
const MCODE_BACKGROUND_TASK_POLL_MS = 5_000;

/**
 * How often the agent may be started again in a row before the session ends.
 *
 * An agent that keeps dying (a broken build, a missing dependency) must not
 * turn into a restart loop.
 */
const MCODE_MAX_AGENT_RESTARTS = 3;
/**
 * The span in which restarts are counted as one failure.
 *
 * The consecutive counter is reset by every turn that ran, so an agent that
 * answers a turn and dies right after would restart forever without ever
 * reaching the limit. Restarts that pile up inside this window are the same
 * failure, however many turns ran between them.
 */
const MCODE_AGENT_RESTART_WINDOW_MS = 5 * 60_000;

/**
 * Why the agent refused the turn.
 *
 * MiniMax Code refuses a `session/prompt` while the session is not ready to
 * take a turn, and it answers with 409 in a handful of shapes:
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
 * - and the rest: the session's own queue has an earlier message, the queue
 *   is paused, the turn is waiting for an answer, a plan review is in the way.
 *
 * All of them end when the agent finishes what it is doing, so the message can
 * simply be delivered later. Only a request the agent can never accept (the
 * session is gone, the input is invalid) is a real failure.
 */
/**
 * Why the agent refused the turn.
 *
 * MiniMax Code refuses a turn for a handful of reasons, and only one of
 * them means "this request is wrong". The rest say "not right now": the
 * session is busy, compacting, waiting for the user, or something else is in
 * the way. The message can be delivered later, so it is kept.
 *
 * `fatal` is the exception: the request itself cannot be delivered (the
 * session is gone, the input is invalid), and retrying it would only produce
 * the same answer.
 */
/** The ACP backend of the running MiniMax Code process. */
type McodeBackend = ReturnType<typeof createMcodeBackend>;

type McodeRefusalReason =
    | 'busy'
    | 'compacting'
    | 'mutating'
    | 'queued'
    | 'paused'
    | 'conflict'
    | 'waiting'
    | 'unavailable'
    | 'plan'
    | 'duplicate'
    | 'fatal'
    | 'unknown';

/**
 * The refusals MiniMax Code can answer a turn with.
 *
 * The table is the agent's own wording (`local_runtime` maps every refusal
 * reason to one of these messages). A refusal HAPI does not know is not a
 * failure - it is "not right now" with a wording HAPI has not seen yet - so
 * the unknown case keeps the message instead of dropping it.
 */
const MCODE_REFUSAL_PATTERNS: ReadonlyArray<readonly [McodeRefusalReason, RegExp]> = [
    ['busy', /session already has an active turn/i],
    ['compacting', /session compaction is active/i],
    ['mutating', /session conversation is being changed/i],
    ['queued', /an earlier queued message has priority/i],
    ['paused', /the session queue is paused/i],
    ['conflict', /turn ingress conflicts/i],
    ['waiting', /the current turn is waiting for user input/i],
    ['unavailable', /the current turn is already complete or cannot be continued/i],
    ['plan', /plan review processing must finish before this request can run/i],
    ['plan', /resolve the pending questionnaire before entering plan mode/i],
    ['plan', /new plan mode entry is temporarily disabled/i],
    ['plan', /session mode changed before plan mode entry/i],
    ['duplicate', /turn was already accepted/i],
    // The request cannot be delivered at all.
    ['fatal', /session not found/i],
    ['fatal', /session is being deleted/i],
    ['fatal', /turn input is invalid/i],
    ['fatal', /queue message is invalid/i],
    ['fatal', /validation_error/i]
];

/**
 * Whether the error is the agent's own answer.
 *
 * A refusal comes back as a JSON-RPC error, and the transport keeps its code
 * on the error. An error without one is a broken transport or a bug in HAPI:
 * asking again would fail the same way.
 */
function isAgentError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && typeof (error as { code?: unknown }).code === 'number';
}

/**
 * Why the agent refused the turn, or null when the turn did not fail at all.
 */
function classifyMcodeRefusal(error: unknown): McodeRefusalReason | null {
    const message = error instanceof Error ? error.message : String(error);
    for (const [reason, pattern] of MCODE_REFUSAL_PATTERNS) {
        if (pattern.test(message)) {
            return reason;
        }
    }
    // An answer from the agent that HAPI does not recognize is still a
    // refusal: the agent refused for a reason it did not name. The agent
    // refuses a turn it cannot start yet, and every refusal it knows ends on
    // its own, so a wording HAPI has not seen is far more likely to be
    // another "not right now" than a broken request.
    return isAgentError(error) ? 'unknown' : null;
}

/**
 * The reasons a client is told about while the message waits.
 *
 * A refusal that means "later" keeps the message: it goes back to the queue
 * and is delivered when the session is ready again. A fatal one is not a
 * notice - nothing is waiting.
 */
type McodeQueueNoticeReason = Exclude<McodeRefusalReason, 'fatal'>;

function isRetryableMcodeRefusal(reason: McodeRefusalReason): reason is McodeQueueNoticeReason {
    return reason !== 'fatal';
}

/**
 * What the user is told while the message waits.
 */
function describeMcodeRefusal(reason: McodeRefusalReason): string {
    switch (reason) {
        case 'busy':
            return 'MiniMax Code is busy with another turn on this session - a task it is running, or another MiniMax Code window attached to it.';
        case 'compacting':
            return 'MiniMax Code is compacting this conversation and refused your message.';
        case 'mutating':
            return 'MiniMax Code is changing this conversation and refused your message.';
        case 'queued':
            return 'MiniMax Code still has an earlier queued message to deliver and refused yours.';
        case 'paused':
            return 'The MiniMax Code message queue is paused, so your message was not taken.';
        case 'conflict':
            return 'MiniMax Code refused your message because another turn is starting at the same time.';
        case 'waiting':
            return 'MiniMax Code is waiting for an answer to something it asked, and refused your message until then.';
        case 'unavailable':
            return 'MiniMax Code just finished a turn and could not take your message yet.';
        case 'plan':
            return 'MiniMax Code is still working through a plan review and refused your message until that is done.';
        case 'duplicate':
            return 'MiniMax Code had already accepted this turn.';
        case 'fatal':
            return 'MiniMax Code refused the message itself.';
        default:
            return 'MiniMax Code refused the message for a reason it did not explain, and will be asked again.';
    }
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
    /**
     * Fired after an effort switch that did not take, or after a model that
     * has no effort levels at all, with the effort that is in effect - null
     * when the session has no thinking effort.
     */
    onEffortRollback?: (effort: string | null) => void;
    /** Fired after a failed permission-mode apply, with the restored mode. */
    onPermissionModeRollback?: (mode: PermissionMode) => void;
    /**
     * Fired when the agent reports a permission mode of its own — the session
     * mode it switched to, or the tool permission policy it re-published.
     */
    onPermissionModeChanged?: (mode: PermissionMode) => void;
    /**
     * Reads the session's turn lease.
     *
     * The lease is the agent's own "a turn is running" state, and it decides
     * whether a turn can be attempted at all. Injectable so the launcher can
     * be driven without the agent's runtime index.
     */
    readTurnLease?: (sessionId: string) => Promise<McodeTurnLeaseState>;
    /**
     * Reads the background tasks the agent's runtime recorded for a session.
     *
     * The runtime knows when a background task ended, and the completion it
     * reports into the owner session is not streamed to the client. Injectable
     * so the launcher can be driven without the agent's runtime index.
     */
    readBackgroundTaskStates?: (sessionId: string) => Promise<Map<string, McodeBackgroundTaskState>>;
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
    /**
     * The background work the session has going.
     *
     * The ledger is what the user is shown, so it only holds what HAPI can
     * back up: a task the agent launched and never reported as finished.
     */
    private readonly backgroundTasks = new BackgroundTaskAggregator();
    /**
     * The ledger that was last published to the hub.
     *
     * The snapshot is only sent when it changed: the count is an absolute
     * number, so an unchanged ledger does not need a new message.
     */
    private publishedBackgroundTasks: string | null = null;
    /** The timer that checks the background work against the runtime's record. */
    private backgroundTaskTimer: ReturnType<typeof setInterval> | null = null;
    /** True while the background work is being reconciled with the runtime. */
    private backgroundTaskReconcileRunning = false;
    /** ACP session id of the running MiniMax Code session. */
    private acpSessionId: string | null = null;
    /** The MCP servers handed to the agent, kept for a restart. */
    private acpMcpServers: McpServerStdio[] | null = null;
    /**
     * How often the agent process was started again in a row.
     *
     * An agent that keeps dying must not start a restart loop: the counter
     * is reset by a turn that actually ran, and a session that cannot keep an
     * agent alive ends with a clear message instead of spinning.
     */
    private agentRestarts = 0;
    /**
     * When the agent process was started again, for the restart window.
     *
     * The counter above is reset by every turn that ran, so an agent that
     * answers a turn and *then* dies would restart forever without ever
     * reaching the limit. The window closes that hole: restarts that pile up
     * inside a short span are the same failure, however many turns ran
     * between them.
     */
    private readonly agentRestartTimes: number[] = [];
    /** Last delegation snapshot forwarded to the hub (state dedupe). */
    private lastDelegationSignature: string | null = null;
    /** Last goal lifecycle state rendered as a chat card. */
    private lastGoalLifecycleSignature: string | null = null;
    /** ACP session mode last reported by the agent (`default` / `plan`). */
    private currentSessionMode: string | null = null;
    /**
     * The mode hash of the turn the agent is running right now.
     *
     * A message that was queued under a different mode cannot be injected
     * into this turn: the mode decided what the agent was allowed to do, and
     * the message would be answered under rules the user did not pick. The
     * hash is the one the queue computed when the message was queued, so the
     * two are compared by identity of the mode rather than by its spelling.
     */
    private activePromptModeHash: string | null = null;
    /** The permission mode the hub currently shows for this session. */
    private hubPermissionMode: PermissionMode | null = null;
    /**
     * Whether the user was already told that this build cannot run the mode
     * they asked for. The answer does not change while the session runs, so
     * it is said once instead of on every turn.
     */
    private warnedAboutUnsupportedMode = false;
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
     * Whether the "the agent is busy" notice was already published for the
     * current busy episode.
     *
     * The episode starts when the session is found to be busy and ends when
     * the agent takes the turn again, so a message that waits for minutes
     * produces one notice and not one per poll.
     */
    private busyNoticePublished = false;
    /**
     * Whether the follow-up notice ("still busy after a minute") was already
     * published for the current busy episode.
     */
    private busyStuckNoticePublished = false;
    /**
     * The last published "the agent holds a turn" value. `null` means it was
     * never published for the current agent session.
     */
    private waitingForAgentPublished: boolean | null = null;
    /**
     * The local ids of the messages that are already in the display buffer.
     *
     * A refused turn goes back into the queue and is delivered on the retry:
     * without this the message would show up twice in the transcript. The
     * ids of the messages the agent has taken are dropped again, so a session
     * that runs for hours does not hold one id per message it ever sent.
     */
    private readonly displayedMessageIds = new McodeDisplayedMessageIds();

    constructor(session: McodeSession, opts: McodeRemoteLauncherOptions) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.opts = opts;
        // The agent's bash tool does not repeat the working directory in every
        // call, so the session's own directory is the fallback for the tasks
        // that do not name one.
        this.backgroundTasks.setDefaultCwd(session.path);
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

    /**
     * Starts the agent again after its process died.
     *
     * Returns the new ACP session id and backend, or null when the agent
     * could not be started again - in that case the session ends with a
     * message that says why, instead of spinning on a dead agent.
     */
    private async restartAgent(): Promise<{
        acpSessionId: string;
        backend: McodeBackend;
    } | null> {
        const session = this.session;
        this.agentRestarts += 1;
        this.agentRestartTimes.push(Date.now());
        // Restarts that pile up inside the window are the same failure, even
        // when turns ran between them: an agent that answers a turn and dies
        // right after would otherwise restart forever.
        const windowStart = Date.now() - MCODE_AGENT_RESTART_WINDOW_MS;
        while (this.agentRestartTimes.length > 0 && this.agentRestartTimes[0] < windowStart) {
            this.agentRestartTimes.shift();
        }
        const tooManyInARow = this.agentRestarts > MCODE_MAX_AGENT_RESTARTS;
        const tooManyInTheWindow = this.agentRestartTimes.length > MCODE_MAX_AGENT_RESTARTS;
        if (tooManyInARow || tooManyInTheWindow) {
            session.sendSessionEvent({
                type: 'message',
                message: tooManyInARow
                    ? `MiniMax Code stopped ${this.agentRestarts - 1} times in a row; ending this session.`
                    : `MiniMax Code stopped ${this.agentRestartTimes.length} times in the last few minutes; ending this session.`
            });
            this.shouldExit = true;
            return null;
        }
        const acpMcpServers = this.acpMcpServers;
        if (!acpMcpServers) {
            this.shouldExit = true;
            return null;
        }
        try {
            const acpSessionId = await this.connectAgent(acpMcpServers, { isRespawn: true });
            const backend = this.backend;
            if (!backend) {
                throw new Error('the agent backend is not connected');
            }
            logger.info('[mcode-remote] the agent is back', { sessionId: acpSessionId });
            // The session is usable again: say so, so a client that showed
            // the session as not ready picks it up.
            session.sendSessionEvent({ type: 'ready' });
            return { acpSessionId, backend };
        } catch (error) {
            logger.warn('[mcode-remote] could not start MiniMax Code again', error);
            // The failure already says what is wrong - it names the reason the
            // agent gave ("not installed", "not signed in").
            session.sendSessionEvent({
                type: 'message',
                message: `MiniMax Code could not be started again. ${error instanceof Error ? error.message : String(error)}`
            });
            this.shouldExit = true;
            return null;
        }
    }

    /**
     * Starts the agent and opens the ACP session.
     *
     * Split out of the main loop because it has to run again: when the agent
     * process dies, the session is brought back by starting a new agent and
     * loading the native session again. The conversation lives in the agent's
     * own session store, so a new process picks it up where the dead one
     * left it.
     */
    private async connectAgent(
        acpMcpServers: McpServerStdio[],
        options: { isRespawn: boolean }
    ): Promise<string> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        // The backend of the agent that died is replaced here. It is closed
        // first: a backend that is dropped still holds its session-info timers
        // and, when the agent never came up, a child process.
        await this.closeBackend(this.backend);
        // The approvals and the questionnaire of the dead agent belong to a
        // process that is gone: they cannot be answered any more, so they are
        // taken down instead of being left on the screen as a card that no
        // handler answers.
        await this.discardDeadRequests();

        const backend = createMcodeBackend();
        this.backend = backend;
        // The permission policy is a per-process config option and the plan
        // mode is an ACP session mode: a new agent process starts without
        // either of them. The state that says "already applied" belongs to the
        // process that died, so it is dropped here - otherwise the apply
        // below would be skipped and the session would run under the agent's
        // own default while the web still shows the mode the user picked.
        this.hasAppliedPermissionMode = false;
        this.requestedPermissionMode = null;
        this.appliedPermissionMode = null;
        registerAcpSessionTitleSync(backend, session.client);

        // MiniMax Code publishes its context usage over ACP when a turn ends,
        // and it sends that notification from the agent's own task queue - so
        // it can land after the prompt has already been answered. The prompt
        // callback is gone by then, and without this listener the update is
        // dropped: the context window never reaches the session, so the usage
        // the transcript watcher reports has no denominator and the context bar
        // cannot show "used / window".
        backend.setUsageUpdateListener((message) => this.handleAgentMessage(message));

        backend.onStderrError((error) => {
            logger.debug('[mcode-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        // The agent publishes its broker a moment after it is spawned, so a
        // read that arrives while it is coming up has no answer yet. The state
        // lets the readout say "starting" instead of reporting the missing
        // broker as a failure of the installation.
        markMcodeAgentStarting(true);
        try {
            await backend.initialize();
        } catch (error) {
            // The agent says why it cannot start - it knows the difference
            // between "not installed" and "not signed in". The user needs that
            // difference too: a session that goes quiet leaves them guessing.
            // The message is sent by the caller, which knows whether this was
            // the first start or a restart.
            const failure = classifyMcodeConnectFailure(error);
            logger.warn('[mcode-remote] MiniMax Code could not be started', failure.reason, failure.detail);
            throw new Error(failure.message, { cause: error });
        } finally {
            markMcodeAgentStarting(false);
        }

        // The connected apps of this session live behind the broker of the
        // agent that is running it, and the agent names that broker after its
        // own pid. Remembering the pid lets the readout ask exactly this
        // agent, instead of scanning the machine for whichever MiniMax Code
        // host happens to be alive.
        const agentPid = typeof backend.getAgentPid === 'function' ? backend.getAgentPid() : null;
        if (agentPid !== null) {
            rememberMcodeAgentHostPid(agentPid);
        }

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

        let acpSessionId: string;
        if (session.sessionId) {
            try {
                if (backend.supportsSessionResume()) {
                    // The agent can reattach to the session it remembers
                    // without replaying the conversation into HAPI. The replay
                    // is what `session/load` does, and on a long session it is
                    // hundreds of kilobytes of JSON that are parsed and dropped
                    // - the transcript already holds those messages.
                    acpSessionId = await backend.resumeSession({
                        sessionId: session.sessionId,
                        cwd: session.path,
                        mcpServers: acpMcpServers
                    });
                    // The replay also carried the turns the agent ran on its
                    // own - the turn in which it read a background task that
                    // finished while HAPI was not watching - so the ledger is
                    // reconciled with the agent's own transcript instead.
                    await this.reconcileBackgroundTasksFromTranscript(acpSessionId);
                } else {
                    acpSessionId = await backend.loadSession({
                        sessionId: session.sessionId,
                        cwd: session.path,
                        mcpServers: acpMcpServers
                    }, {
                        // The agent replays the conversation it remembers. The
                        // replay holds the turns it ran on its own - the turn in
                        // which it read a background task that finished while HAPI
                        // was not watching - so the ledger is reconciled with it.
                        onHistory: (messages) => this.backgroundTasks.reconcile(
                            // The replay carries the raw tool names of the agent
                            // ("bash", "task_output"); the ledger knows them by
                            // their canonical name.
                            messages.map((message) => normalizeMcodeToolCall(message))
                        )
                    });
                }
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
        // A new agent session: the next waiting flag has to be published even
        // when it says the same thing the previous session said.
        this.waitingForAgentPublished = null;

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

        // A respawn loads the same native session again: the agent restores
        // the model and the effort it was running with. HAPI's start-time
        // request must not be applied on top of that - it would silently drop
        // a model the user picked in the middle of the session. The model in
        // effect before the crash is the one the user sees, so it is applied
        // again; when HAPI does not know one, the agent's own answer wins.
        const requestedModel = options.isRespawn
            ? (this.currentBackendModel ?? undefined)
            : this.opts.model;
        const effectiveModel = await this.applyInitialModel(acpSessionId, requestedModel);
        this.currentBackendModel = effectiveModel;
        if (!options.isRespawn) {
            this.defaultBackendModel = effectiveModel;
        }
        if (effectiveModel && !options.isRespawn) {
            this.displayModel = effectiveModel;
            messageBuffer.addMessage(`[MODEL:${effectiveModel}]`, 'system');
        }
        // A model switch can change the advertised thinking-effort levels: the
        // agent re-publishes its config options right after the switch, so the
        // option list has to be read after that update - the cached one still
        // belongs to the previous model otherwise, and an effort the new model
        // supports would be rejected as "not advertised".
        if (requestedModel) {
            await backend.waitForSessionUpdateQueue(500);
        }
        const requestedEffort = options.isRespawn
            ? (this.currentBackendEffort ?? undefined)
            : this.opts.effort;
        const effectiveEffort = await this.applyInitialEffort(acpSessionId, requestedEffort);
        this.currentBackendEffort = effectiveEffort;
        if (!options.isRespawn) {
            this.defaultBackendEffort = effectiveEffort;
        }
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
        // The goal and the delegation tree are independent reads, so they are
        // asked for at the same time - one round trip instead of two on every
        // connect.
        await Promise.all([
            this.restoreGoalState(acpSessionId),
            this.restoreDelegationState(acpSessionId)
        ]);

        return acpSessionId;
    }

    /**
     * Rebuilds the background-task ledger from the agent's own transcript.
     *
     * The ledger is what the user is shown: the background work the session
     * still has going. It is built from the tool calls the agent made, and a
     * runner that attaches to an existing session has not seen any of them -
     * the agent may have launched a task, or read one that finished, while
     * HAPI was not watching.
     *
     * `session/load` used to hand those calls back as a replay of the whole
     * conversation. The transcript on disk holds the same tool calls in the
     * same order, so it is read from there instead: the reattach does not
     * carry the conversation across the wire just to keep the ledger right.
     *
     * A transcript that cannot be read leaves the ledger empty. That is the
     * safe direction: the ledger undercounts the work in flight instead of
     * counting a task that is already gone.
     */
    private async reconcileBackgroundTasksFromTranscript(sessionId: string): Promise<void> {
        try {
            const transcriptPath = await findMcodeMessagesPath(sessionId);
            if (!transcriptPath) return;
            const messages = await readMcodeTranscriptToolMessages(transcriptPath);
            if (messages.length === 0) return;
            // The transcript carries the raw tool names of the agent
            // ("bash", "task_output"); the ledger knows them by their
            // canonical name.
            this.backgroundTasks.reconcile(messages.map((message) => normalizeMcodeToolCall(message)));
        } catch (error) {
            logger.debug('[mcode-remote] transcript reconcile failed', error);
        }
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            // MiniMax Code publishes its own session title over ACP only after
            // the turn it derives it from has finished, so a new chat stayed
            // untitled until the first answer was done.
            //
            // The session is named after the text of the user's first message
            // instead, and the agent's own title replaces it when it arrives.
            // The title tool is not offered to the model: the user already
            // wrote the request the title is about, so asking the model for a
            // name spends a model round on something the chat already knows.
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'mcode' }
        });
        this.happyServer = happyServer;

        const acpMcpServers = toAcpMcpServers(mcpServers);
        this.acpMcpServers = acpMcpServers;
        let acpSessionId = await this.connectAgent(acpMcpServers, { isRespawn: false });
        // The backend is replaced when the agent process dies and the session
        // is brought back, so the loop always reads the current one.
        const connectedBackend = this.backend;
        if (!connectedBackend) {
            throw new Error('MiniMax Code backend is not connected');
        }
        let backend: McodeBackend = connectedBackend;

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

            // The agent's runtime holds the session's turn lease for every turn
            // it runs, and it runs turns HAPI did not start: a background task
            // that finished has to be reported into the owner session, and
            // that delivery holds the lease while it runs.
            //
            // A session that holds the lease refuses more than the turn: the
            // model, effort and permission mode cannot be applied either, and
            // a `session/prompt` sent into it is refused as well. HAPI used to
            // fire blind, eat the refusal and retry on a guessed backoff -
            // which is how a message ended up minutes late. The lease says
            // when the agent is free, so wait for it instead: the wait ends
            // the moment the other turn ends, and the turn is admitted the
            // first time it is tried.
            //
            // The wait comes BEFORE the message is taken from the queue. That
            // is what keeps a waiting message a queued message: it stays
            // cancellable (the hub asks this runner to drop it) and it stays
            // unacknowledged in the hub, so a runner that dies while it waits
            // hands the message to the next runner instead of losing it.
            if (!await this.waitForAgentTurn(session, acpSessionId, waitSignal)) {
                continue;
            }

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
            } else if (modelSwitched) {
                // The new model reasons by toggle instead of by level, so it
                // publishes no thinking-effort option at all. The effort of the
                // old model does not exist anymore: it is dropped here, so the
                // hub is not told about an effort the new model does not have.
                this.currentBackendEffort = null;
                this.opts.onEffortRollback?.(null);
            }
            const requestedEffort = batch.mode.effort === null
                ? this.defaultBackendEffort
                : batch.mode.effort;
            if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
                if (!effortOptionAfterModel) {
                    // The model has no thinking-effort levels, so there is
                    // nothing to apply. A choice the user made is reported,
                    // the default of the previous model is simply dropped.
                    if (batch.mode.effort !== null) {
                        session.sendSessionEvent({
                            type: 'message',
                            message: `MiniMax Code's current model has no thinking-effort levels, so the thinking effort cannot be set to ${requestedEffort}.`
                        });
                    }
                    batch.mode.effort = null;
                    this.currentBackendEffort = null;
                    this.opts.onEffortRollback?.(null);
                } else {
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
            }

            await this.applyPermissionMode(acpSessionId, batch.mode.permissionMode);
            // Keep the per-turn mode in sync with the policy the agent
            // actually runs: a rolled-back apply and an agent that cannot
            // switch session modes both end up on a different mode than the
            // one that was asked for.
            batch.mode.permissionMode = this.appliedPermissionMode ?? 'default';

            // The turn that starts now owns the session: a message that was
            // queued under another mode cannot be steered into it. The mode is
            // the one the turn runs under, which is not always the one the
            // message was queued with: a model the agent cannot switch to or a
            // permission mode it cannot honor rolls the mode back, and the
            // turn then runs under the mode that is in effect.
            this.activePromptModeHash = this.session.queue.modeHasher(batch.mode);

            this.applyDisplayMode(batch.mode.permissionMode, this.currentBackendModel ?? undefined);
            this.showUserMessage(messageBuffer, batch);

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            // A new attempt starts here: the session is not waiting for the
            // agent any more.
            this.setWaitingForAgent(false);

            // Publish the steerable flag before the thinking flag: a client
            // that offers Steer on "thinking" must never be ahead of the
            // agent's own "a turn is running" state.
            //
            // Only an agent that advertises `mcode/session/steer` can be
            // steered into; offering the action on a build without it is a
            // dead button.
            this.setSteeringActive(this.canSteerIntoTurn());
            session.onThinkingChange(true);
            // The agent can only be forked at the end of a finished turn, so the
            // fork control has to know that a turn is running.
            this.conversationHistory?.setBusy(true);

            // Set when the agent refused the turn because the session was
            // busy: the batch is back in the queue and the loop has to wait
            // before it tries again.
            let refusedAsBusy = false;

            // Set when the request reached the agent. From that point the
            // agent may have consumed the message, so nothing can prove the
            // outcome any more - which decides what a crash of the agent
            // means for this batch.
            let promptSent = false;

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                }, {
                    // The abort can land between taking the message and
                    // starting the turn: the model / effort / mode round trips
                    // above take real time, and `handleAbort` cancels a
                    // *running* prompt — of which there is none yet, so the
                    // abort would be lost and the agent would keep working on
                    // a message the user just stopped. The batch cannot be
                    // dropped either. Start the turn and cancel it right
                    // behind the request instead: the transport keeps the
                    // order, so the agent registers the turn and then
                    // cancels it before it does any work.
                    onPromptSent: () => {
                        promptSent = true;
                        // The message is the agent's from here: the runner
                        // hands it over and owns the delivery from now on,
                        // so the hub can mark it delivered. A message that
                        // never gets this far - one that waited for a busy
                        // agent and was never sent - stays queued in the hub
                        // and is handed to the next runner if this one dies.
                        this.acknowledgeBatch(session, batch);
                        if (waitSignal.aborted) {
                            void backend.cancelPrompt(acpSessionId);
                        }
                    }
                });
                this.busyRefusals = 0;
                this.busySinceMs = null;
                this.busyNoticePublished = false;
                this.busyStuckNoticePublished = false;
                // The agent is alive and working: a restart that happens
                // later starts from a clean count.
                this.agentRestarts = 0;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const refusal = classifyMcodeRefusal(error);
                if (this.backend?.isClosed() && !waitSignal.aborted && !this.shouldExit) {
                    // The agent process is gone.
                    if (promptSent) {
                        // The agent was handed the message and then stopped:
                        // it may have consumed it, and nothing can prove
                        // which. The message is held instead of being sent
                        // again - the agent could run the same work twice.
                        // The user resolves it (retry or cancel).
                        this.holdBatchIndeterminate(session, batch);
                        logger.warn('[mcode-remote] the agent stopped mid-turn; the message outcome is unknown', error);
                        session.sendSessionEvent({
                            type: 'message',
                            message: 'MiniMax Code stopped while it was working on your message. We cannot tell what it did with it - retry it or discard it.'
                        });
                    } else {
                        // The agent died before the request went out: it never
                        // saw the message. Give it back to the queue - and to
                        // the hub, so a runner that dies before the retry
                        // cannot lose it.
                        this.requeueRefusedBatch(batch);
                        this.releaseBatchToHub(session, batch);
                        logger.warn('[mcode-remote] the agent stopped, starting it again', error);
                        session.sendSessionEvent({
                            type: 'message',
                            message: 'MiniMax Code stopped; starting it again. Your message goes out as soon as it is back.'
                        });
                    }
                    const restarted = await this.restartAgent();
                    if (restarted) {
                        acpSessionId = restarted.acpSessionId;
                        backend = restarted.backend;
                        // Give the new agent a moment before the retry.
                        refusedAsBusy = true;
                    }
                } else if (refusal && isRetryableMcodeRefusal(refusal) && !waitSignal.aborted && !this.shouldExit) {
                    // The agent refused the turn for a transient reason: the
                    // session still has an active one - the common case is the
                    // agent's own background task running as a turn on this
                    // session, but a second live client attached to it (the
                    // local TUI, another runner) holds it as well. It says to
                    // deliver the message after the turn ends. The batch was
                    // acknowledged when it left the queue, so dropping it
                    // would lose the message - put it back and let the loop
                    // deliver it once the session is ready again.
                    //
                    // Every refusal the agent knows means "not right now", and
                    // a refusal HAPI does not recognize means the same: the
                    // agent is not ready, it just said so in a wording HAPI
                    // has not seen. Only a request it can never accept is
                    // dropped.
                    this.requeueRefusedBatch(batch);
                    this.releaseBatchToHub(session, batch);
                    this.reportBusyNotice(session, refusal);
                    logger.debug('[mcode-remote] session refused the turn', { refusal, message: errorMessage });
                    // The agent still holds a turn. Say so, so a client can
                    // show that the message is waiting instead of looking
                    // like it was lost.
                    this.setWaitingForAgent(true);
                    refusedAsBusy = true;
                } else if (waitSignal.aborted) {
                    // The session was aborted while the turn was refused. The
                    // abort already told the user, and it cleared the queue,
                    // so the message goes with it - a failure notice on top of
                    // that would only be noise.
                    logger.debug('[mcode-remote] turn refused while the session was aborted', { message: errorMessage });
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
                await this.reconcileBackgroundTasksWithRuntime();
                session.onThinkingChange(false);
                this.conversationHistory?.setBusy(false);
                this.setSteeringActive(false);
                // The turn is over, so there is no mode a message could be
                // steered into any more.
                this.activePromptModeHash = null;
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
     *
     * The notice is its own event type, not an agent message: it is HAPI
     * talking about the queue, and a client has to be able to tell that
     * apart from something the agent said.
     *
     * One notice per busy episode, not one per attempt: the episode starts
     * when the session is found to be busy and ends when the agent takes
     * the turn again.
     */
    private reportBusyNotice(session: McodeSession, reason: McodeQueueNoticeReason): void {
        this.busySinceMs ??= Date.now();
        const waitingSeconds = Math.round((Date.now() - (this.busySinceMs ?? Date.now())) / 1000);
        if (!this.busyNoticePublished) {
            this.busyNoticePublished = true;
            const what = describeMcodeRefusal(reason);
            session.sendSessionEvent({
                type: 'queue-notice',
                reason,
                waitingSeconds,
                message: `${what} Your message is kept and goes out as soon as that finishes.`
            });
            logger.debug('[mcode-remote] session is busy', { reason });
            return;
        }
        if (!this.busyStuckNoticePublished && waitingSeconds >= MCODE_TURN_LEASE_STUCK_MS / 1000) {
            this.busyStuckNoticePublished = true;
            session.sendSessionEvent({
                type: 'queue-notice',
                reason,
                waitingSeconds,
                message: `MiniMax Code is still busy after ${waitingSeconds} seconds. Your message is still queued and goes out on its own as soon as the session frees up. If nothing is running, close any leftover MiniMax Code process, or start a new session.`
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
        if (!this.displayedMessageIds.areAllShown(localIds)) {
            messageBuffer.addMessage(batch.message, 'user');
        }
        this.displayedMessageIds.remember(localIds);
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
     * The re-queued message lives in this process only, so the caller also
     * has to give it back to the hub - see {@link releaseBatchToHub}.
     */
    private requeueRefusedBatch(batch: {
        message: string;
        mode: McodeMode;
        isolate?: boolean;
        items?: Array<{ message: string; localId?: string }>;
    }): void {
        this.requeueBatch(batch);
        this.busyRefusals += 1;
        logger.debug('[mcode-remote] Refused turn re-queued', { messages: batch.items?.length ?? 1 });
    }

    /**
     * Gives the message back to the hub.
     *
     * The batch was acknowledged when it was handed to the agent, and the
     * agent refused the turn - it did not take the message. The hub has to
     * learn that: it believes the message was delivered, and a runner that
     * dies while the retry waits would lose it. Releasing the rows puts
     * them back into the hub's durable queue, where the replay path picks
     * them up: this runner gets them again through the replay (and drops
     * them, because it already holds them), the next runner gets them for
     * real.
     */
    private releaseBatchToHub(
        session: McodeSession,
        batch: { items?: Array<{ localId?: string }> }
    ): void {
        const localIds = this.batchLocalIds(batch);
        if (localIds.length === 0) return;
        session.client.emitMessagesReleased(localIds);
    }

    /**
     * Holds a message whose delivery cannot be proven.
     *
     * The agent was handed the message and then stopped, so it may have
     * consumed it - but nothing can tell. The message must not be sent
     * again (the agent could run the same work twice), and it must not be
     * acked (nobody proved a delivery). It waits for the user: the hub
     * keeps the row out of the automatic replay and shows it as "outcome
     * unknown", with a retry and a cancel.
     */
    private holdBatchIndeterminate(
        session: McodeSession,
        batch: { items?: Array<{ localId?: string }> }
    ): void {
        const localIds = this.batchLocalIds(batch);
        if (localIds.length === 0) return;
        session.client.emitMessagesIndeterminate(localIds);
    }

    /** The local ids of a batch, in the order the batch holds them. */
    private batchLocalIds(batch: { items?: Array<{ localId?: string }> }): string[] {
        return (batch.items ?? [])
            .map((item) => item.localId)
            .filter((localId): localId is string => Boolean(localId));
    }

    /**
     * Marks a batch as handed over to the agent.
     *
     * The hub acknowledges a message when the runner hands it to the agent,
     * not when the runner takes it out of its own queue. A message that waits
     * for a busy agent therefore stays queued in the hub: the user sees it as
     * a queued message, can cancel it, and a runner that dies while it waits
     * hands it to the next runner instead of losing it.
     */
    private acknowledgeBatch(
        session: McodeSession,
        batch: { items?: Array<{ localId?: string }> }
    ): void {
        const localIds = this.batchLocalIds(batch);
        if (localIds.length === 0) return;
        // The agent has the message now, so it is never shown again. The id
        // does not have to be remembered for the rest of the session, and a
        // session that runs for hours would otherwise hold one id per
        // message it ever sent.
        this.displayedMessageIds.forget(localIds);
        session.client.emitMessagesConsumed(localIds);
    }

    private requeueBatch(batch: {
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
        // The message goes back into the queue, so it is shown again when the
        // loop takes it out. The user already read it, so the id has to be
        // remembered again: the launcher forgets the ids of the messages the
        // agent has taken, and a message the agent refused after taking it
        // was never delivered.
        this.displayedMessageIds.remember(this.batchLocalIds(batch));
    }

    /**
     * Waits before the next attempt at a refused turn.
     *
     * The refusal says the session is not ready for a turn. The wait for the
     * agent to be free happens in the next round of the loop, before the
     * message is taken from the queue, so this is only the floor that keeps a
     * refusal that is not about the turn lease - a session that is compacting
     * or changing - from turning into a request per second.
     */
    private async waitBeforeRetry(signal: AbortSignal): Promise<void> {
        const delay = Math.min(
            MCODE_BUSY_RETRY_BASE_MS * 2 ** Math.min(Math.max(this.busyRefusals - 1, 0), 6),
            MCODE_BUSY_RETRY_MAX_MS
        );
        await this.sleepWithAbort(delay, signal);
    }

    /**
     * Waits until the agent's runtime releases the session's turn lease.
     *
     * MiniMax Code gives every native session one turn lease and holds it for
     * the whole turn. The runtime takes that lease for turns HAPI did not
     * start - a background task that finished has to be reported into the
     * owner session, and that delivery holds the lease while it runs. A
     * `session/prompt` sent into a held lease is refused, so the wait is
     * what keeps the message from being refused in the first place.
     *
     * The lease lives in the agent's runtime index, next to the session
     * catalog HAPI already reads, and it is the same lease the agent itself
     * consults before it admits a turn. Polling it is a local file read: no
     * round trip to the agent and nothing written.
     *
     * An index that cannot be read (an older agent without the table, a
     * locked file) leaves the lease state unknown, and an unknown lease never
     * blocks: the turn is attempted and refused the way it was before.
     *
     * Returns false when the session was aborted while it waited.
     */
    private async waitForAgentTurn(
        session: McodeSession,
        sessionId: string,
        signal: AbortSignal
    ): Promise<boolean> {
        for (;;) {
            if (signal.aborted) return false;

            const state = await this.readTurnLease(sessionId);
            if (state.status !== 'held') {
                // The busy episode does not end here: the turn has not
                // started yet, and it can still be refused. The episode ends
                // when the agent takes the turn, and the notice flags are
                // reset there - so a session that is busy, freed and busy
                // again is still one episode with one notice.
                return true;
            }

            // The agent is busy. Say so, so a client can show that the
            // message is waiting instead of looking like it was lost. The
            // notice comes first: it starts the busy episode, and the wait
            // the client shows is measured from that moment.
            //
            // Only a message that is actually waiting is announced: an agent
            // that is busy with a turn of its own is not something the user
            // has to act on until they have something to send.
            if (session.queue.size() > 0) {
                this.reportBusyNotice(session, 'busy');
                this.setWaitingForAgent(true);
            }
            await this.sleepWithAbort(MCODE_TURN_LEASE_POLL_MS, signal);
        }
    }

    /**
     * Reads the session's turn lease.
     *
     * The reader is injectable so the launcher can be driven without the
     * agent's runtime index.
     */
    private readTurnLease(sessionId: string): Promise<McodeTurnLeaseState> {
        const read = this.opts.readTurnLease ?? readMcodeTurnLease;
        return read(sessionId);
    }

    /** Sleeps, and gives up early when the session is aborted. */
    private sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
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

        if (this.backgroundTaskTimer) {
            clearInterval(this.backgroundTaskTimer);
            this.backgroundTaskTimer = null;
        }

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
        this.session.sendSessionEvent(this.goalClearedEvent());
        this.session.sendSessionEvent({ type: 'subagent-snapshot', members: [] });
        // The extension surface belongs to the agent process that just went
        // away, so the web must not offer controls the local TUI cannot honor.
        // The flags are set to "off" rather than removed: the hub merges
        // metadata writes, so a removed key could survive the merge.
        this.extensionControl = null;
        // The agent is gone: a client must not keep showing that it waits for
        // a turn that no longer exists.
        this.setWaitingForAgent(false);
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
                    delegationStop: false,
                    steer: false
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
     * Closes the backend of the agent that died.
     *
     * The close is bounded: the update queue of a dead agent can still be
     * busy, and a session that waits for it forever would never bring the
     * agent back.
     */
    private async closeBackend(backend: McodeBackend | null): Promise<void> {
        if (!backend) return;
        try {
            await Promise.race([
                backend.disconnect(),
                new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, 2_000);
                    timer.unref?.();
                })
            ]);
        } catch (error) {
            logger.debug('[mcode-remote] Could not close the backend of the dead agent', error);
        }
    }

    /**
     * Takes down the requests of the agent that died.
     *
     * A pending approval and a pending questionnaire belong to the process
     * that asked for them. When that process is gone the card the user sees
     * cannot be answered any more: the handler behind it is replaced with the
     * one of the new agent, which does not know the old requests. They are
     * dropped here, so the web does not keep a card that nothing answers.
     */
    private async discardDeadRequests(): Promise<void> {
        const questionHandler = this.questionHandler;
        const permissionHandler = this.permissionHandler;
        this.questionHandler = null;
        this.permissionHandler = null;

        if (questionHandler) {
            try {
                await questionHandler.cancelAll('The agent restarted');
            } catch (error) {
                logger.debug('[mcode-remote] Could not close the questionnaire of the dead agent', error);
            }
        }
        if (permissionHandler) {
            try {
                await permissionHandler.cancelAll('The agent restarted');
            } catch (error) {
                logger.debug('[mcode-remote] Could not close the approvals of the dead agent', error);
            }
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
            } else if (applied.mode !== (mode ?? 'default')) {
                // The agent cannot run the mode the user asked for: a build
                // without `session/set_mode` cannot run in plan mode. The hub
                // must be told what the agent really runs, or the web keeps
                // advertising a mode the session does not have.
                this.opts.onPermissionModeChanged?.(applied.mode);
                if (!this.warnedAboutUnsupportedMode) {
                    this.warnedAboutUnsupportedMode = true;
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: `MiniMax Code cannot run in ${mode} mode on this build; it runs in ${applied.mode} mode instead.`
                    });
                }
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
     * The event that says "this session has no goal any more".
     *
     * The thread id tells the web which goal disappeared: without it, a
     * session that runs several threads drops the goal of all of them.
     */
    private goalClearedEvent(): { type: 'thread-goal-cleared'; threadId?: string } {
        const threadId = this.acpSessionId;
        return threadId ? { type: 'thread-goal-cleared', threadId } : { type: 'thread-goal-cleared' };
    }

    /**
     * Whether a message can be steered into the running turn.
     *
     * Steering is an optional part of the agent's extension surface: a build
     * that does not advertise `mcode/session/steer` refuses the call, so the
     * clients must not be told that steering is possible.
     */
    private canSteerIntoTurn(): boolean {
        return this.extensionControl?.supportsMethod(MCODE_METHOD_STEER) === true;
    }

    /**
     * Publishes whether the session is waiting for the agent to free its turn.
     *
     * The agent refuses a turn while it holds one, and it can hold a turn HAPI
     * never started - MiniMax Code opens a turn of its own to deliver a
     * finished background task. HAPI has no way to see that turn, so without
     * this flag the session looks idle to every client while the message sits
     * in the queue, and an operator sends it again.
     */
    private setWaitingForAgent(value: boolean): void {
        // The flag is published on change only: the agent state write is a
        // hub round trip, and a turn would otherwise publish it twice for a
        // value nobody can see change.
        if (this.waitingForAgentPublished === value) return;
        this.waitingForAgentPublished = value;
        // Captured now: the handler runs later, and the busy window can have
        // moved on by then.
        const sinceMs = value ? (this.busySinceMs ?? Date.now()) : undefined;
        this.session.client.updateAgentState((state) => ({
            ...state,
            waitingForAgent: value,
            waitingSinceMs: sinceMs
        }));
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
                // The agent's own answer first: a build without the steer
                // extension cannot be steered into at all, whatever the
                // session state says.
                if (!this.extensionControl?.supportsMethod(MCODE_METHOD_STEER)) {
                    return { steered: false, error: 'MiniMax Code did not advertise the steer extension' };
                }
                if (!this.steeringActive) {
                    return { steered: false, error: 'MiniMax Code has no running turn to steer' };
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
                // The turn that is running now decided what the agent was
                // allowed to do. A message that was queued under another mode
                // belongs to another turn, and injecting it here would answer
                // it under rules the user did not pick.
                if (this.activePromptModeHash !== null
                    && this.activePromptModeHash !== taken.item.modeHash) {
                    this.session.queue.restoreReservation(taken);
                    return { steered: false, error: 'Queued message mode differs from the active turn' };
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
                        MCODE_METHOD_STEER,
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
                    this.session.sendSessionEvent(this.goalClearedEvent());
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
        this.reportBackgroundTasks();
        // The agent reports a finished background task with a turn of its own,
        // and that turn reaches the client as a plain usage update. It is the
        // one moment the client learns that a task ended without the agent
        // polling it, so the ledger is checked against the runtime's record.
        void this.reconcileBackgroundTasksWithRuntime();
    }

    /**
     * Publishes the background work the session has going.
     *
     * The ledger is published as a whole, not as a delta: the count is the
     * size of the ledger, so a hub that missed a message cannot end up with a
     * count that drifts away from the truth. The snapshot is only sent when
     * it changed, because it is a chat message.
     */
    private reportBackgroundTasks(): void {
        const tasks = this.backgroundTasks.snapshot();
        const signature = JSON.stringify(tasks);
        this.syncBackgroundTaskTimer();
        if (signature === this.publishedBackgroundTasks) return;
        // A session that never had background work does not publish an empty
        // list: the snapshot is a chat message, and a client that has none
        // falls back to what it can read out of the transcript.
        if (tasks.length === 0 && this.publishedBackgroundTasks === null) return;
        this.publishedBackgroundTasks = signature;
        this.session.sendSessionEvent({ type: 'background-task-snapshot', tasks });
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

        // The agent publishes the tree of every session it knows about. After
        // a fork the fork's own (empty) tree arrives next to the one of this
        // session, and forwarding it would clear the panel the user is
        // watching. Only the tree rooted at this session is its state.
        if (snapshot.rootSessionId !== this.acpSessionId) {
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
            this.session.sendSessionEvent(this.goalClearedEvent());
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
        // MiniMax Code declares the files it hands over in a `<deliver-assets>`
        // block, because the MiniMax Code apps render that block as a file
        // card. HAPI's clients do not know the markup, so it would reach the
        // chat - and the transcript - as raw XML. The block is taken out of
        // the answer and the files it names are reported on their own.
        if (message.type === 'text') {
            const split = splitMcodeDeliverables(message.text);
            if (split.deliverables.length > 0) {
                // The files are reported as file citations, the way HAPI
                // reports a file anywhere else: the clients turn the path into
                // a link that opens the file.
                const text = [
                    split.text.trim(),
                    renderMcodeDeliverables(split.deliverables, this.session.path)
                ].filter((part) => part.length > 0).join('\n\n');
                this.emitAgentMessage({
                    type: 'text',
                    text,
                    ...(message.id !== undefined ? { id: message.id } : {}),
                    ...(message.streamSnapshot === true ? { streamSnapshot: true } : {})
                });
                return;
            }
        }

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
        this.reportBackgroundTasks();
    }

    /**
     * Settles the background work against the record the agent's runtime keeps.
     *
     * The runtime reports a finished background task into the owner session
     * with a turn of the agent's own, and that turn is not streamed to the
     * client: a task that ended between two turns stays "running" in the
     * ledger and on its card until the agent happens to poll it again. The
     * runtime's record is the one place that knows the task is over, so the
     * ledger is checked against it.
     */
    private async reconcileBackgroundTasksWithRuntime(): Promise<void> {
        const sessionId = this.acpSessionId;
        if (!sessionId) return;
        if (!this.backgroundTasks.hasTrackedTasks()) return;
        if (this.backgroundTaskReconcileRunning) return;
        this.backgroundTaskReconcileRunning = true;

        try {
            const states = await this.readBackgroundTaskStates(sessionId);
            if (states.size === 0) return;
            for (const message of this.backgroundTasks.applyRuntimeTaskStates(states)) {
                this.emitAgentMessage(message);
            }
            this.reportBackgroundTasks();
        } catch (error) {
            logger.debug('[mcode-remote] background task reconcile failed', error);
        } finally {
            this.backgroundTaskReconcileRunning = false;
        }
    }

    private readBackgroundTaskStates(
        sessionId: string
    ): Promise<Map<string, McodeBackgroundTaskState>> {
        const read = this.opts.readBackgroundTaskStates ?? readMcodeBackgroundTaskStates;
        return read(sessionId);
    }

    /**
     * Watches the background work of the session while it has some.
     *
     * The check is a local read of the runtime's record, and it stops as soon
     * as the session has no background work left.
     */
    private syncBackgroundTaskTimer(): void {
        const wanted = this.backgroundTasks.hasTrackedTasks();
        if (wanted) {
            if (this.backgroundTaskTimer) return;
            this.backgroundTaskTimer = setInterval(() => {
                void this.reconcileBackgroundTasksWithRuntime();
            }, MCODE_BACKGROUND_TASK_POLL_MS);
            this.backgroundTaskTimer.unref?.();
            return;
        }
        if (!this.backgroundTaskTimer) return;
        clearInterval(this.backgroundTaskTimer);
        this.backgroundTaskTimer = null;
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
        this.reportBackgroundTasks();
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' });
        // The messages that were still queued are dropped by the reset, so
        // they have to be acknowledged before it: an unacknowledged row stays
        // queued in the hub and would be handed to the next runner, which
        // would deliver a message the user just aborted.
        const dropped = this.session.queue.pendingLocalIds();
        if (dropped.length > 0) {
            this.session.client.emitMessagesConsumed(dropped);
        }
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
