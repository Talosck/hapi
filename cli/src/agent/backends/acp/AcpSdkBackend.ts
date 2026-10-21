import type { AgentFlavor } from '@hapi/protocol';
import type { AgentBackend, AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { asString, isObject } from '@hapi/protocol';
import { AcpStdioTransport, type AcpStderrError } from './AcpStdioTransport';
import { AcpMessageHandler, type AcpTextChunkMode } from './AcpMessageHandler';
import { ACP_SESSION_UPDATE_TYPES } from './constants';
import { ACP_MODEL_CONFIG_ID, extractModelCatalog, findModelConfigOption, findThinkingEffortConfigOption } from './acpConfigOptions';
import { thinkingHintFromSessionUpdate } from './shouldBumpThinkingFromSessionUpdate';
import { logger } from '@/ui/logger';
import { withRetry } from '@/utils/time';
import packageJson from '../../../../package.json';

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

type AcpPromptUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    thoughtTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
};

type AcpUsageUpdate = {
    contextTokens: number | undefined;
    contextWindow: number | undefined;
};

export type AcpModelDescriptor = {
    modelId: string;
    name?: string;
    reasoningEfforts?: Array<{ value: string; name?: string; isDefault?: boolean }>;
};

export type AcpSessionModelsMetadata = {
    availableModels: AcpModelDescriptor[];
    currentModelId: string | null;
};

export type AcpSessionInfoUpdate = {
    sessionId: string | null;
    title: string | null;
};

export type AcpConfigOptionDescriptor = {
    id: string;
    category?: string;
    currentValue?: string;
    options: Array<{ value: string; name?: string }>;
};

/**
 * The agent does not implement `session/set_mode` at all.
 *
 * A capability gap, not a rejected request: the agent cannot run in that
 * mode, but the other permission axis it publishes as a config option is
 * unaffected and must keep working.
 */
export class AcpSessionModeUnsupportedError extends Error {
    constructor() {
        super('ACP agent does not support session/set_mode');
        this.name = 'AcpSessionModeUnsupportedError';
    }
}

/**
 * Session state the agent publishes over `session/update` outside of the
 * message stream. These updates describe what the agent currently runs, so a
 * launcher can keep the displayed mode / model / effort honest.
 */
export type AcpSessionStateUpdate =
    /** The agent switched its ACP session mode (`default` / `plan`, …). */
    | { kind: 'mode'; sessionId: string | null; modeId: string }
    /** The agent re-published its config options (model, thinking effort, …). */
    | { kind: 'config-options'; sessionId: string | null }
    /**
     * The agent withdrew a plan it had published. MiniMax Code emits this
     * once the plan it attached to a questionnaire has been answered.
     */
    | { kind: 'plan-removed'; sessionId: string | null; planId: string };

/** One command advertised by the agent over ACP (`available_commands`). */
export type AcpAvailableCommand = {
    name: string;
    description?: string;
    /** Optional argument hint from `input.hint` (e.g. `[provider/model]`). */
    inputHint?: string;
};

type AcpInitializeResult = {
    protocolVersion: number;
    authMethods?: Array<{ id: string; name?: string }>;
    agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: unknown;
        sessionCapabilities?: unknown;
    };
};

export class AcpSdkBackend implements AgentBackend {
    private transport: AcpStdioTransport | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private stderrErrorHandler: ((error: AcpStderrError) => void) | null = null;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private readonly sessionModelsMetadata = new Map<string, AcpSessionModelsMetadata>();
    private readonly sessionConfigOptions = new Map<string, AcpConfigOptionDescriptor[]>();
    private readonly sessionInfoRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private initialAvailableCommands: AcpAvailableCommand[] = [];
    private readonly sessionAvailableCommands = new Map<string, AcpAvailableCommand[]>();
    private autoPermissionModeEnabled: boolean | null = null;
    private messageHandler: AcpMessageHandler | null = null;
    private activeSessionId: string | null = null;
    private initializeResult: AcpInitializeResult | null = null;
    /** The agent's `_meta` block from the initialize response (extension surface). */
    private initializeMeta: Record<string, unknown> | null = null;
    private initializeInFlight: Promise<void> | null = null;
    private setModeSupported: boolean | undefined = undefined;
    /** Whether the agent implements `session/set_mode` at all. */
    private setSessionModeSupported: boolean | undefined = undefined;
    private isProcessingMessage = false;
    private promptRequestInFlight = false;
    /** Concurrent session/prompt requests (main prompt + soft steers). */
    private activePromptRequests = 0;
    /** Foreground prompt only; soft steers are excluded after Abort. */
    private foregroundPromptRequests = 0;
    /** Bumped by abortSoftSteers; stale finishes from cancelled requests are dropped. */
    private promptRequestEpoch = 0;
    /** Incremented for each foreground prompt turn, including retry-wrapped turns. */
    private promptGeneration = 0;
    private responseCompleteResolvers: Array<() => void> = [];
    private lastSessionUpdateAt = 0;
    private latestUsageUpdate: AcpUsageUpdate | null = null;
    private promptUsageCallback: ((msg: AgentMessage) => void) | null = null;
    private usageUpdateListener: ((msg: AgentMessage) => void) | null = null;
    private sessionInfoUpdateListener: ((update: AcpSessionInfoUpdate) => void) | null = null;
    /** Fired on foreground ACP state / permission so launchers can bump hub thinking (#1470). */
    private agentActivityListener: ((thinking: boolean) => void) | null = null;
    /** Debounce timer for state_update running → thinking (#1502 chatter). */
    private runningThinkingTimer: ReturnType<typeof setTimeout> | null = null;
    private lastForwardedUsageUpdate: AcpUsageUpdate | null = null;
    private sessionUpdateQueue: Promise<void> = Promise.resolve();
    /** Receives agent-specific notifications that are not `session/update`. */
    private extensionNotificationListener: ((method: string, params: unknown) => void) | null = null;
    /** Receives `session/update` notifications that carry session state. */
    private sessionStateListener: ((update: AcpSessionStateUpdate) => void) | null = null;

    /** Retry configuration for ACP initialization */
    private static readonly INIT_RETRY_OPTIONS = {
        maxAttempts: 3,
        minDelay: 1000,
        maxDelay: 5000
    };
    private static readonly UPDATE_QUIET_PERIOD_MS = 120;
    private static readonly UPDATE_DRAIN_TIMEOUT_MS = 2000;
    private static readonly PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 200;
    private static readonly PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 1200;
    private static readonly SESSION_TITLE_REFRESH_DELAYS_MS = [1000, 3000];
    /** Cursor chatters running↔idle ~1–2s; require sustained running before bump. */
    private static readonly RUNNING_THINKING_DEBOUNCE_MS = 750;
    // After the initial post-prompt drain, slow-tailing models (DeepSeek,
    // GPT-5.5, etc.) can keep sending agentMessageChunk notifications. We poll
    // drainBuffers() on a short interval so the UI keeps streaming smoothly,
    // and block prompt() from resolving until the model is truly quiet — that
    // way turn_complete and the launcher's ready signal only fire after every
    // straggler has been emitted to the current turn's onUpdate. Bounded by
    // LATE_FLUSH_WINDOW_MS so a stuck stream never wedges the session.
    //
    // 6000ms covers tails up to ~5s observed against GPT-5.5 / DeepSeek V4 Pro
    // with 1s headroom. 250ms quiet is anchored to drainLateBuffers entry
    // time, so every turn pays at least one quiet period before resolving —
    // that minimum is what catches stragglers arriving just after
    // session/prompt resolves when the model paused mid-turn. 50ms polling
    // keeps the UI responsive without measurable CPU cost (drainBuffers is a
    // no-op on empty buffers). All three can be tightened once we have
    // telemetry on real-world tail distributions.
    private static readonly LATE_FLUSH_INTERVAL_MS = 50;
    private static readonly LATE_FLUSH_QUIET_PERIOD_MS = 250;
    private static readonly LATE_FLUSH_WINDOW_MS = 6000;

    constructor(private readonly options: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        textChunkMode?: AcpTextChunkMode;
        flavor?: AgentFlavor;
        /**
         * Advertise ACP `elicitation/create` support during initialize. Agents
         * (notably MiniMax Code) only route interactive questions through
         * elicitation when the client declares the matching mode; otherwise
         * they may silently dismiss the request.
         */
        elicitation?: { form?: boolean; url?: boolean };
        /**
         * Advertise ACP `plan` support during initialize. Agents that publish
         * a plan for review (MiniMax Code) only attach the plan document to
         * the session when the client declares this capability.
         */
        plan?: boolean;
        /**
         * Extra `clientCapabilities._meta` entries advertised during
         * initialize. Agents that do not know the metadata ignore it; agents
         * that do (MiniMax Code) gate their extension notifications on it.
         */
        clientCapabilityMeta?: Record<string, unknown>;
    }) {}

    async initialize(): Promise<void> {
        if (this.transport) return;
        if (this.initializeInFlight) {
            await this.initializeInFlight;
            return;
        }

        this.initializeInFlight = this.bootstrapTransport();
        try {
            await this.initializeInFlight;
        } finally {
            this.initializeInFlight = null;
        }
    }

    private async bootstrapTransport(): Promise<void> {
        if (this.transport) return;

        const transport = await AcpStdioTransport.create({
            command: this.options.command,
            args: this.options.args,
            env: this.options.env
        });

        if (this.transport) {
            await transport.close();
            return;
        }

        this.transport = transport;

        this.transport.onNotification((method, params) => {
            if (method === 'session/update') {
                this.handleSessionUpdate(params);
            } else if (
                method === '_x.ai/settings/update'
                && isObject(params)
                && 'auto_permission_mode_enabled' in params
            ) {
                this.autoPermissionModeEnabled = params.auto_permission_mode_enabled === true;
            } else {
                this.extensionNotificationListener?.(method, params);
            }
        });

        this.transport.onStderrError((error) => {
            this.stderrErrorHandler?.(error);
        });

        this.transport.registerRequestHandler('session/request_permission', async (params, requestId) => {
            return await this.handlePermissionRequest(params, requestId);
        });

        const elicitation = this.options.elicitation;
        const elicitationCapability = elicitation && (elicitation.form || elicitation.url)
            ? {
                ...(elicitation.form ? { form: {} } : {}),
                ...(elicitation.url ? { url: {} } : {})
            }
            : undefined;

        const response = await withRetry(
            () => this.transport!.sendRequest('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false,
                    ...(elicitationCapability ? { elicitation: elicitationCapability } : {}),
                    ...(this.options.plan ? { plan: {} } : {}),
                    _meta: {
                        // Cursor ACP exposes Composer's non-fast/fast choice as separate
                        // `model` + `fast` config options only when the client advertises
                        // this capability. Agents that do not know this metadata ignore it.
                        parameterizedModelPicker: true,
                        ...(this.options.clientCapabilityMeta ?? {})
                    }
                },
                clientInfo: {
                    name: 'hapi',
                    version: packageJson.version
                }
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] Initialize attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        if (!isObject(response) || typeof response.protocolVersion !== 'number') {
            throw new Error('Invalid initialize response from ACP agent');
        }

        this.captureAvailableCommands(null, response);

        // The agent's own `_meta` block describes the extension surface it
        // supports (e.g. MiniMax Code's `minimax-code/extensions`). The backend
        // stays flavor-agnostic and hands the raw block to the flavor adapter.
        this.initializeMeta = isObject(response._meta) ? response._meta : null;

        this.initializeResult = {
            protocolVersion: response.protocolVersion,
            authMethods: Array.isArray(response.authMethods)
                ? response.authMethods
                    .filter((entry): entry is Record<string, unknown> => isObject(entry))
                    .map((entry) => ({
                        id: asString(entry.id) ?? '',
                        name: asString(entry.name) ?? undefined
                    }))
                    .filter((entry) => entry.id.length > 0)
                : undefined,
            agentCapabilities: isObject(response.agentCapabilities)
                ? {
                    loadSession: response.agentCapabilities.loadSession === true,
                    promptCapabilities: response.agentCapabilities.promptCapabilities,
                    sessionCapabilities: response.agentCapabilities.sessionCapabilities
                }
                : undefined
        };

        logger.debug(`[ACP] Initialized with protocol version ${response.protocolVersion}`);
    }

    async authenticate(methodId: string): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        await this.transport.sendRequest('_client/authenticate', { methodId });
    }

    async authenticateIfAvailable(methodId: string): Promise<void> {
        const methods = this.initializeResult?.authMethods ?? [];
        if (!methods.some((method) => method.id === methodId)) {
            logger.debug(`[ACP] Auth method not advertised: ${methodId}`);
            return;
        }
        try {
            await this.authenticate(methodId);
        } catch (error) {
            // Cursor advertises cursor_login but may not implement _client/authenticate yet.
            logger.debug(`[ACP] authenticate skipped (${methodId})`, error);
        }
    }

    supportsLoadSession(): boolean {
        return this.initializeResult?.agentCapabilities?.loadSession === true;
    }

    /**
     * Whether the agent advertises `session/fork` support.
     *
     * The agent lists it in `agentCapabilities.sessionCapabilities` during
     * initialize, so the answer comes from the handshake instead of a probe
     * that would fork a real session to find out.
     */
    supportsSessionFork(): boolean {
        const capabilities = this.initializeResult?.agentCapabilities?.sessionCapabilities;
        if (!isObject(capabilities)) return false;
        const fork = capabilities.fork;
        // An agent advertises the capability either as a flag or as an (empty)
        // options object - both mean "supported".
        return fork === true || isObject(fork);
    }

    /**
     * The agent's `_meta` block from the initialize response.
     *
     * Agents describe their extension surface here (e.g. MiniMax Code's
     * `minimax-code/extensions` with the methods and notifications it
     * supports). The block is returned raw: interpreting it belongs to the
     * flavor adapter, not to this generic backend.
     */
    getInitializeMeta(): Record<string, unknown> | null {
        return this.initializeMeta;
    }

    getSessionConfigOptions(sessionId: string): AcpConfigOptionDescriptor[] | undefined {
        return this.sessionConfigOptions.get(sessionId);
    }

    getConfigOptionByCategory(sessionId: string, category: string): AcpConfigOptionDescriptor | undefined {
        return this.sessionConfigOptions.get(sessionId)?.find((option) => option.category === category);
    }

    registerExtensionRequestHandler(
        method: string,
        handler: (params: unknown, requestId: string | number | null) => Promise<unknown>
    ): void {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        this.transport.registerRequestHandler(method, handler);
    }

    /**
     * Waits for `session/update` work already queued by the transport to be
     * forwarded. Incoming client requests such as `elicitation/create` are
     * dispatched synchronously while updates are queued, so a question handler
     * that correlates an elicitation with the immediately preceding tool call
     * must drain the queue first. Bounded so a slow image registration cannot
     * delay the prompt indefinitely.
     */
    async waitForSessionUpdateQueue(timeoutMs = 1500): Promise<void> {
        if (timeoutMs <= 0) {
            await this.sessionUpdateQueue;
            return;
        }

        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                this.sessionUpdateQueue,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, timeoutMs);
                    timer.unref?.();
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async setMode(sessionId: string, modeId: string): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        await this.waitForResponseComplete();

        if (this.setModeSupported !== false) {
            try {
                await this.transport.sendRequest('session/set_mode', { sessionId, modeId });
                this.setModeSupported = true;
                this.updateThoughtLevelCurrentValue(sessionId, modeId);
                return;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/method not found/i.test(message)) {
                    this.setModeSupported = false;
                } else {
                    throw error;
                }
            }
        }

        const modeOption = this.getConfigOptionByCategory(sessionId, 'mode');
        if (!modeOption) {
            throw new Error('ACP agent does not support session/set_mode and no mode config option is available');
        }

        await this.setConfigOption(sessionId, modeOption.id, modeId);
    }

    /**
     * Switches the agent's ACP session mode (`session/set_mode`).
     *
     * Distinct from {@link setMode}, which OpenCode/Grok use to switch the
     * reasoning effort and which mirrors the new value into the session's
     * `thought_level` config option. MiniMax Code's session modes
     * (`default` / `plan`) are a different axis, so they must not overwrite
     * the cached thinking-effort value.
     *
     * An agent that does not implement the method at all cannot run in that
     * mode. That is a capability gap rather than a rejected request, so it
     * raises {@link AcpSessionModeUnsupportedError} and the caller decides
     * how to degrade — the capability gap must not take the other permission
     * axis down with it.
     */
    async setSessionMode(sessionId: string, modeId: string): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        await this.waitForResponseComplete();

        if (this.setSessionModeSupported === false) {
            throw new AcpSessionModeUnsupportedError();
        }

        try {
            await this.transport.sendRequest('session/set_mode', { sessionId, modeId });
            this.setSessionModeSupported = true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/method not found/i.test(message)) {
                this.setSessionModeSupported = false;
                throw new AcpSessionModeUnsupportedError();
            }
            throw error;
        }
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/new', {
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/new attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) {
            throw new Error('Invalid session/new response from ACP agent');
        }

        this.activeSessionId = sessionId;
        this.captureSessionMetadata(sessionId, response);
        return sessionId;
    }

    async loadSession(config: AgentSessionConfig & { sessionId: string }): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/load', {
                sessionId: config.sessionId,
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/load attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const loadedSessionId = isObject(response) ? asString(response.sessionId) : null;
        const sessionId = loadedSessionId ?? config.sessionId;
        this.activeSessionId = sessionId;
        this.captureSessionMetadata(sessionId, response);
        return sessionId;
    }

    async setModel(
        sessionId: string,
        modelId: string,
        opts?: { flavor?: AgentFlavor }
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        // The launcher serializes setModel between turns, but defensively wait for any
        // in-flight prompt to drain so we never interleave a switch with a session/prompt.
        await this.waitForResponseComplete();

        // ACP defines `session/set_model` ({ sessionId, modelId }) for inline model
        // switching — see ACP SDK schema `x-method: session/set_model`. OpenCode
        // 1.14.30 implements this exact wire name (the SDK's TypeScript helper is
        // exposed as `unstable_setSessionModel` but the JSON-RPC method on the wire
        // is unprefixed). Errors (including JSON-RPC 'method not found') propagate
        // as rejections from the transport; the launcher's catch block handles them.
        let configOptionResponse: unknown;
        let usedConfigOption = false;
        if (opts?.flavor === 'opencode' || opts?.flavor === 'mcode') {
            // OpenCode's `session/set_model` response only carries an opaque
            // `_meta` block with no `configOptions`, so the per-session
            // thought_level options captured at session/new go stale after an
            // inline switch. `session/set_config_option` with configId "model"
            // (OpenCode's fixed id for the model picker) echoes fresh
            // `configOptions` including thought_level for the new model.
            //
            // MiniMax Code does not implement `session/set_model` at all — its
            // model picker is the `model` config option.
            //
            // The picker is matched by id *or* category when it is read, so it
            // is written to the id the agent actually published: a build that
            // publishes it under another id would otherwise show the catalog
            // fine and then reject every switch.
            const modelOption = findModelConfigOption(this.sessionConfigOptions.get(sessionId));
            const configId = modelOption?.id ?? ACP_MODEL_CONFIG_ID;
            try {
                configOptionResponse = await this.transport.sendRequest('session/set_config_option', {
                    sessionId,
                    configId,
                    value: modelId
                });
                usedConfigOption = true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // Older OpenCode builds predate set_config_option — fall back to
                // the legacy set_model path below. Any other error propagates to
                // the launcher's existing catch handling.
                if (!/method not found/i.test(message)) {
                    throw error;
                }
            }
        }

        const response = usedConfigOption
            ? configOptionResponse
            : await this.transport.sendRequest('session/set_model', {
                sessionId,
                modelId
            });

        if (usedConfigOption) {
            this.captureSessionMetadata(sessionId, response);
        } else if (opts?.flavor === 'opencode' || opts?.flavor === 'grok') {
            // OpenCode's set_model response only carries an opaque `_meta` block,
            // not `availableModels`/`currentModelId`. Optimistically update the
            // cached currentModelId (the call succeeded, so the agent has switched)
            // while preserving the availableModels list captured from session/new.
            this.updateCurrentModelOptimistic(sessionId, modelId);
            if (opts.flavor === 'opencode') {
                const options = this.sessionConfigOptions.get(sessionId);
                if (options) {
                    this.sessionConfigOptions.set(
                        sessionId,
                        options.filter((option) => option.category !== 'thought_level')
                    );
                }
            }
        } else {
            // For other flavors (e.g. Gemini), if the response carries metadata,
            // capture it. Missing fields are silently ignored.
            this.captureSessionMetadata(sessionId, response);
        }
    }

    async setConfigOption(
        sessionId: string,
        configId: string,
        value: string
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        await this.waitForResponseComplete();

        const response = await this.transport.sendRequest('session/set_config_option', {
            sessionId,
            configId,
            value
        });
        this.captureSessionMetadata(sessionId, response);
    }

    /**
     * Low-level extension RPC for agent-specific methods (e.g. Grok `_x.ai/*`).
     * Keep method names and schemas in the agent adapter — not here.
     */
    async sendExtensionRequest<T = unknown>(
        method: string,
        params: Record<string, unknown>,
        options?: { timeoutMs?: number }
    ): Promise<T> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        return await this.transport.sendRequest(method, params, {
            timeoutMs: options?.timeoutMs
        }) as T;
    }

    /**
     * Returns the per-session models metadata captured from session/new (or
     * session/load, or session/set_model). Returns undefined if the agent did
     * not include the optional `models` block in its response.
     */
    getSessionModelsMetadata(sessionId: string): AcpSessionModelsMetadata | undefined {
        return this.sessionModelsMetadata.get(sessionId);
    }

    getThoughtLevelConfigOption(sessionId: string): AcpConfigOptionDescriptor | undefined {
        return findThinkingEffortConfigOption(this.sessionConfigOptions.get(sessionId));
    }

    hasAvailableCommand(sessionId: string, command: string): boolean {
        if (command === 'auto' && this.autoPermissionModeEnabled === true) {
            return true;
        }
        const commands = this.sessionAvailableCommands.get(sessionId) ?? this.initialAvailableCommands;
        return commands.some((entry) => entry.name === command);
    }

    /** Full command roster published by the agent for a session (or the initialize-level list). */
    getAvailableCommands(sessionId?: string | null): AcpAvailableCommand[] {
        const commands = (sessionId ? this.sessionAvailableCommands.get(sessionId) : undefined)
            ?? this.initialAvailableCommands;
        return commands.map((command) => ({ ...command }));
    }

    /** Forwards ACP `usage_update` to the web status bar when no prompt is active (e.g. session resume). */
    setUsageUpdateListener(listener: ((msg: AgentMessage) => void) | null): void {
        this.usageUpdateListener = listener;
    }

    /** Forwards stable ACP session metadata updates independently of prompt streaming. */
    setSessionInfoUpdateListener(listener: ((update: AcpSessionInfoUpdate) => void) | null): void {
        this.sessionInfoUpdateListener = listener;
    }

    /**
     * Registers a listener for agent-specific notifications that arrive next to
     * `session/update` (e.g. MiniMax Code's `mcode/session/*` extensions).
     * The listener owns the payload shape — the backend forwards the method
     * name and the raw params unchanged.
     */
    setExtensionNotificationListener(listener: ((method: string, params: unknown) => void) | null): void {
        this.extensionNotificationListener = listener;
    }

    /**
     * Registers a listener for `session/update` notifications that publish
     * session state instead of message content: the current session mode and
     * the config options (model, thinking effort, permission policy).
     */
    setSessionStateListener(listener: ((update: AcpSessionStateUpdate) => void) | null): void {
        this.sessionStateListener = listener;
    }

    /**
     * Called when ACP reports foreground state / permission for harness wake (#1470 / #1502).
     * `true` = sustained `running` (debounced), `requires_action`, or permission.
     * `false` = `state_update` idle (skipped while a HAPI prompt turn is still draining).
     * Launchers should ignore no-ops when session.thinking already matches.
     */
    setAgentActivityListener(listener: ((thinking: boolean) => void) | null): void {
        this.agentActivityListener = listener;
    }

    /** Reads the agent's persisted native title through stable ACP session/list. */
    async refreshSessionInfo(sessionId: string, cwd: string): Promise<void> {
        const existingTimer = this.sessionInfoRefreshTimers.get(sessionId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.sessionInfoRefreshTimers.delete(sessionId);
        }
        await this.refreshSessionInfoAttempt(sessionId, cwd, 0);
    }

    private async refreshSessionInfoAttempt(sessionId: string, cwd: string, retryIndex: number): Promise<void> {
        if (!this.transport) {
            return;
        }
        try {
            const response = await this.transport.sendRequest('session/list', { cwd }, { timeoutMs: 5000 });
            if (!isObject(response) || !Array.isArray(response.sessions)) {
                return;
            }
            const match = response.sessions.find((entry) =>
                isObject(entry) && asString(entry.sessionId) === sessionId
            );
            if (!isObject(match) || (typeof match.title !== 'string' && match.title !== null)) {
                return;
            }
            this.sessionInfoUpdateListener?.({ sessionId, title: match.title });
            if (match.title === null || !this.isPlaceholderSessionTitle(match.title)) {
                return;
            }
            const delayMs = AcpSdkBackend.SESSION_TITLE_REFRESH_DELAYS_MS[retryIndex];
            if (delayMs === undefined) {
                return;
            }
            const timer = setTimeout(() => {
                this.sessionInfoRefreshTimers.delete(sessionId);
                void this.refreshSessionInfoAttempt(sessionId, cwd, retryIndex + 1);
            }, delayMs);
            timer.unref();
            this.sessionInfoRefreshTimers.set(sessionId, timer);
        } catch (error) {
            logger.debug('[ACP] session/list title refresh unavailable', error);
        }
    }

    private isPlaceholderSessionTitle(title: string): boolean {
        const normalizedTitle = title.trim();
        return normalizedTitle.length === 0
            || normalizedTitle === 'Untitled'
            || /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T/.test(normalizedTitle);
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        this.activeSessionId = sessionId;
        // Single-phase handler swap: drain any chunks still buffered in the
        // previous turn's handler so they emit via that turn's onUpdate, then
        // immediately install the new handler. The post-prompt drainLateBuffers
        // means by this point the previous turn should already be quiet; this
        // wait is a cheap safety net for the rare case where a chunk arrived
        // between prompt() resolving and the next turn starting.
        await this.waitForSessionUpdateQuiet(
            AcpSdkBackend.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            AcpSdkBackend.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
        );
        await this.sessionUpdateQueue;
        this.messageHandler?.drainBuffers();
        this.messageHandler = new AcpMessageHandler(onUpdate, {
            textChunkMode: this.options.textChunkMode,
            flavor: this.options.flavor,
        });
        this.promptGeneration++;
        this.foregroundPromptRequests++;
        const promptRequestEpoch = this.beginPromptRequest();
        this.lastSessionUpdateAt = Date.now();
        this.latestUsageUpdate = null;
        this.lastForwardedUsageUpdate = null;
        this.promptUsageCallback = onUpdate;
        let stopReason: string | null = null;
        let promptUsage: AcpPromptUsage | null = null;

        try {
            // No timeout for prompt requests - they can run for extended periods
            // during complex tasks, tool-heavy operations, or slow model responses
            this.promptRequestInFlight = true;
            let response: unknown;
            try {
                response = await this.transport.sendRequest('session/prompt', {
                    sessionId,
                    prompt: content
                }, { timeoutMs: Infinity });
            } finally {
                this.promptRequestInFlight = false;
            }

            stopReason = isObject(response) ? asString(response.stopReason) : null;
            promptUsage = this.extractPromptUsage(response);
        } finally {
            await this.waitForSessionUpdateQuiet(
                AcpSdkBackend.UPDATE_QUIET_PERIOD_MS,
                AcpSdkBackend.UPDATE_DRAIN_TIMEOUT_MS
            );
            await this.sessionUpdateQueue;
            this.messageHandler?.drainBuffers();
            // Block here until the model truly stops streaming straggler
            // chunks (or LATE_FLUSH_WINDOW_MS elapses), so turn_complete and
            // the launcher's ready signal only fire once every chunk has been
            // emitted to this turn's onUpdate.
            await this.drainLateBuffers();
            // Late window can enqueue async image registration; drain again
            // before turn_complete so generated_image precedes turn boundary.
            await this.sessionUpdateQueue;
            this.messageHandler?.drainBuffers();
            try {
                const latestUsageUpdate = this.readLatestUsageUpdate();
                if (promptUsage) {
                    onUpdate({
                        type: 'usage',
                        inputTokens: promptUsage.inputTokens,
                        outputTokens: promptUsage.outputTokens,
                        totalTokens: promptUsage.totalTokens,
                        thoughtTokens: promptUsage.thoughtTokens,
                        cacheReadTokens: promptUsage.cacheReadTokens,
                        ...(promptUsage.cacheCreationTokens !== undefined
                            ? { cacheCreationTokens: promptUsage.cacheCreationTokens }
                            : {}),
                        contextTokens: latestUsageUpdate ? latestUsageUpdate.contextTokens : undefined,
                        contextWindow: latestUsageUpdate ? latestUsageUpdate.contextWindow : undefined
                    });
                } else if (
                    latestUsageUpdate
                    && (latestUsageUpdate.contextTokens !== undefined || latestUsageUpdate.contextWindow !== undefined)
                    && !this.hasForwardedUsage(latestUsageUpdate)
                ) {
                    // Agent did not return prompt usage (slash-handled turns,
                    // errored turns), but we did see ACP usage updates during
                    // the turn. Emit a context-only usage so the status bar
                    // reflects the current context size.
                    onUpdate({
                        type: 'usage',
                        inputTokens: 0,
                        outputTokens: 0,
                        contextTokens: latestUsageUpdate.contextTokens,
                        contextWindow: latestUsageUpdate.contextWindow
                    });
                }
                if (stopReason) {
                    onUpdate({ type: 'turn_complete', stopReason });
                }
            } finally {
                this.promptUsageCallback = null;
                this.foregroundPromptRequests = Math.max(0, this.foregroundPromptRequests - 1);
                if (promptRequestEpoch !== this.promptRequestEpoch) {
                    this.activePromptRequests = Math.max(0, this.activePromptRequests - 1);
                    this.isProcessingMessage = this.activePromptRequests > 0;
                    if (!this.isProcessingMessage) this.notifyResponseComplete();
                } else {
                    this.finishPromptRequest(promptRequestEpoch);
                }
            }
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        if (!this.transport) {
            return;
        }

        this.transport.sendNotification('session/cancel', { sessionId });
    }

    /**
     * Closes the ACP session.
     *
     * `session/close` releases the attachment state the agent keeps for a
     * connected session. The session itself stays in the agent's data
     * directory, so a later run can pick it up again with `session/load`.
     */
    async closeSession(sessionId: string): Promise<void> {
        if (!this.transport) {
            return;
        }

        await this.transport.sendRequest('session/close', { sessionId });
    }

    /**
     * Soft-inject a follow-up `session/prompt` while another prompt is in flight.
     *
     * Used for Cursor mid-turn steer (GUI "Send" / next-opportune soft send).
     * Does **not** cancel the active prompt and does **not** swap message handlers —
     * `session/update` notifications keep flowing to the in-flight turn's handler.
     *
     * Awaits the full concurrent `session/prompt` JSON-RPC response (turn completion
     * for that inject). Do **not** call this from the hub `SteerQueuedMessage` handler —
     * that RPC uses a 30s Socket.IO timeout. Use {@link beginSoftSteerPrompt} there.
     */
    async softSteerPrompt(sessionId: string, content: PromptContent[]): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        if (!this.isProcessingMessage) {
            throw new Error('No active ACP prompt to soft-steer into');
        }

        const promptRequestEpoch = this.beginPromptRequest();
        try {
            await this.transport.sendRequest('session/prompt', {
                sessionId,
                prompt: content
            }, { timeoutMs: Infinity });
        } finally {
            this.finishPromptRequest(promptRequestEpoch);
        }
    }

    /**
     * Kick off a soft steer without blocking the hub RPC on turn completion.
     * Separates transport dispatch from prompt completion so callers can commit
     * queue state only after stdin accepted the request without waiting for the turn.
     */
    beginSoftSteerPrompt(sessionId: string, content: PromptContent[]): {
        dispatched: Promise<void>;
        completed: Promise<void>;
    } {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        if (!this.isProcessingMessage) {
            throw new Error('No active ACP prompt to soft-steer into');
        }

        const transport = this.transport;
        const promptRequestEpoch = this.beginPromptRequest();
        const request = transport.sendRequestWithDispatch('session/prompt', {
            sessionId,
            prompt: content
        }, { timeoutMs: Infinity, dispatchTimeoutMs: 20_000 });
        const completed = (async () => {
            try {
                await request.completed;
            } finally {
                try {
                    await this.waitForSessionUpdateQuiet(
                        AcpSdkBackend.UPDATE_QUIET_PERIOD_MS,
                        AcpSdkBackend.UPDATE_DRAIN_TIMEOUT_MS
                    );
                    this.messageHandler?.drainBuffers();
                    await this.drainLateBuffers();
                    this.messageHandler?.drainBuffers();
                } finally {
                    this.finishPromptRequest(promptRequestEpoch);
                }
            }
        })();

        void completed.catch((error) => {
            logger.warn('[ACP] soft-steer session/prompt failed', error);
        });

        return { dispatched: request.dispatched, completed };
    }

    async respondToPermission(
        _sessionId: string,
        request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const pending = this.pendingPermissions.get(request.id);
        if (!pending) {
            logger.debug('[ACP] No pending permission request for id', request.id);
            return;
        }

        this.pendingPermissions.delete(request.id);

        if (response.outcome === 'cancelled') {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            return;
        }

        pending.resolve({
            outcome: {
                outcome: 'selected',
                optionId: response.optionId
            }
        });
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    onStderrError(handler: (error: AcpStderrError) => void): void {
        this.stderrErrorHandler = handler;
    }

    /**
     * Runs `fn` with `session/update` notifications temporarily prevented
     * from reaching whatever `messageHandler` is currently installed (i.e.
     * the last prompt() turn's handler), restoring it once `fn` settles.
     *
     * Needed for out-of-band calls that don't go through `prompt()` at all —
     * e.g. OpenCode's /compact bridge, which triggers native compaction via
     * a raw HTTP request to the agent subprocess instead of `session/prompt`.
     * The agent keeps streaming `session/update` notifications (thought
     * chunks etc.) over the same ACP transport while that HTTP call runs,
     * and `handleSessionUpdate` forwards them unconditionally — with no
     * prompt() turn in flight to own them, they'd otherwise land on the
     * previous turn's now-stale `messageHandler` and render as a duplicate
     * assistant message alongside whatever the caller explicitly displays
     * from the HTTP response.
     *
     * `captureAvailableCommands` / `forwardSessionInfoUpdate` /
     * `captureUsageUpdate` in `handleSessionUpdate` are untouched by this —
     * only the `messageHandler.handleUpdate` forwarding is suppressed.
     *
     * Session-agnostic: this is a pure prompt()-adjacent utility with no
     * Gemini/OpenCode-specific behavior, so it's safe on the shared
     * AcpSdkBackend class — nothing calls it unless a caller opts in.
     *
     * The `this.messageHandler === null` guard on restore is defense in
     * depth: normal serialization (compact and prompts run through the same
     * single dequeue loop — see opencodeRemoteLauncher.ts) means `fn` should
     * never overlap with a real prompt() turn, but if `disconnect()` or a
     * new `prompt()` did run concurrently and changed `messageHandler`
     * during `fn`, this avoids clobbering whatever it set.
     *
     * Restoring the handler waits for the same quiet-drain `prompt()` already
     * uses before installing a *new* handler for the next turn (see its
     * `PRE_PROMPT_UPDATE_QUIET_PERIOD_MS`/`_DRAIN_TIMEOUT_MS` call) — the
     * same class of race, just on the way back in instead of the way out.
     * Aborting `fn()` client-side (e.g. OpenCode's compact bridge aborting
     * its HTTP call) does not necessarily stop the agent from continuing the
     * operation server-side: `session/update` is a separate notification
     * channel from that HTTP request's lifecycle (confirmed while building
     * the /compact bridge — see runCompactOperation's doc comment). Without
     * this wait, late notifications from a still-running server-side
     * operation would immediately leak into whichever handler gets restored
     * (or into a brand new one prompt() installs right after) the instant
     * `fn()` returns. `messageHandler` stays null (suppression still in
     * effect) for the whole drain, so nothing leaks during it either.
     */
    async suppressUpdatesDuring<T>(fn: () => Promise<T>): Promise<T> {
        const previousHandler = this.messageHandler;
        this.messageHandler = null;
        try {
            return await fn();
        } finally {
            await this.waitForSessionUpdateQuiet(
                AcpSdkBackend.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
                AcpSdkBackend.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
            );
            if (this.messageHandler === null) {
                this.messageHandler = previousHandler;
            }
        }
    }

    /**
     * Returns true if currently processing a message (prompt in progress).
     * Useful for checking if it's safe to perform session operations.
     */
    get processingMessage(): boolean {
        return this.activePromptRequests > 0;
    }

    isPromptRequestInFlight(): boolean {
        return this.promptRequestInFlight;
    }

    getPromptGeneration(): number {
        return this.promptGeneration;
    }

    getLastSessionUpdateAt(): number {
        return this.lastSessionUpdateAt;
    }

    /**
     * Wait for any in-progress response to complete.
     * Resolves immediately if no response is being processed.
     * Use this before performing operations that require the response to be complete,
     * like session swap or sending task_complete.
     */
    async waitForResponseComplete(): Promise<void> {
        if (this.activePromptRequests === 0) {
            return;
        }
        return new Promise<void>((resolve) => {
            this.responseCompleteResolvers.push(resolve);
        });
    }

    async disconnect(): Promise<void> {
        if (!this.transport) return;
        for (const timer of this.sessionInfoRefreshTimers.values()) {
            clearTimeout(timer);
        }
        this.sessionInfoRefreshTimers.clear();
        this.clearRunningThinkingTimer();
        await this.sessionUpdateQueue;
        this.messageHandler?.drainBuffers();
        this.messageHandler = null;
        this.activeSessionId = null;
        this.activePromptRequests = 0;
        this.foregroundPromptRequests = 0;
        this.isProcessingMessage = false;
        this.sessionModelsMetadata.clear();
        this.initialAvailableCommands = [];
        this.sessionAvailableCommands.clear();
        this.autoPermissionModeEnabled = null;
        this.notifyResponseComplete();
        await this.transport.close();
        this.transport = null;
    }

    private handleSessionUpdate(params: unknown): void {
        if (!isObject(params)) return;
        const sessionId = asString(params.sessionId);
        if (this.activeSessionId && sessionId && sessionId !== this.activeSessionId) {
            return;
        }
        this.lastSessionUpdateAt = Date.now();
        const update = params.update;
        // Title/usage/commands stay synchronous (#1028). Only message-handler
        // work is queued so async image registration preserves event order.
        if (sessionId) {
            this.captureAvailableCommands(sessionId, update);
        }
        this.forwardSessionInfoUpdate(sessionId, update);
        this.captureUsageUpdate(update);
        this.forwardSessionStateUpdate(sessionId, update);
        this.notifyAgentActivity(update);
        // Capture the handler at enqueue time. Looking up `this.messageHandler`
        // when the queued microtask runs can leak a suppressUpdatesDuring
        // update into the restored handler if earlier async image work kept
        // the queue busy past restore.
        const handler = this.messageHandler;
        this.sessionUpdateQueue = this.sessionUpdateQueue
            .then(async () => {
                await handler?.handleUpdate(update);
            })
            .catch((error) => {
                logger.debug(
                    '[AcpSdkBackend] session update failed:',
                    error instanceof Error ? error.message : String(error)
                );
            });
    }

    /**
     * Forwards the `session/update` notifications that publish session state:
     * the current ACP session mode and the config options (model, thinking
     * effort, permission policy).
     *
     * `config_option_update` also refreshes the cached descriptors, so a
     * launcher that reads the model or the effort afterwards sees the values
     * the agent just published instead of the ones from `session/new`.
     */
    private forwardSessionStateUpdate(sessionId: string | null, update: unknown): void {
        if (!isObject(update)) return;

        if (update.sessionUpdate === ACP_SESSION_UPDATE_TYPES.configOptionUpdate) {
            if (sessionId) {
                this.mergeSessionConfigOptions(sessionId, update.configOptions);
                this.captureSessionModelsMetadata(sessionId, { configOptions: update.configOptions });
            }
            this.sessionStateListener?.({ kind: 'config-options', sessionId });
            return;
        }

        if (update.sessionUpdate === ACP_SESSION_UPDATE_TYPES.currentModeUpdate) {
            const modeId = asString(update.currentModeId);
            if (!modeId) return;
            this.sessionStateListener?.({ kind: 'mode', sessionId, modeId });
            return;
        }

        if (update.sessionUpdate === ACP_SESSION_UPDATE_TYPES.planRemoved) {
            // The agent withdrew a plan it published before (MiniMax Code
            // removes the plan it attached to a questionnaire once the
            // questionnaire is answered). The plan card has to disappear with
            // it, otherwise the transcript keeps a plan nobody is working on.
            const planId = asString(update.planId);
            if (!planId) return;
            this.sessionStateListener?.({ kind: 'plan-removed', sessionId, planId });
        }
    }

    private notifyAgentActivity(update: unknown): void {
        if (!this.agentActivityListener) {
            return;
        }
        if (!isObject(update)) {
            return;
        }
        const hint = thinkingHintFromSessionUpdate(update);
        if (hint === null) {
            return;
        }

        if (hint === false) {
            this.clearRunningThinkingTimer();
            // Launcher owns thinking for the duration of prompt(); idle chatter
            // mid-drain must not clear the spinner before finally runs.
            if (this.isProcessingMessage) {
                return;
            }
            this.agentActivityListener(false);
            return;
        }

        // Sustained running only — Cursor flaps running↔idle while queue-idle (#1502).
        if (update.sessionUpdate === 'state_update' && update.state === 'running') {
            if (this.runningThinkingTimer) {
                return;
            }
            this.runningThinkingTimer = setTimeout(() => {
                this.runningThinkingTimer = null;
                this.agentActivityListener?.(true);
            }, AcpSdkBackend.RUNNING_THINKING_DEBOUNCE_MS);
            return;
        }

        this.clearRunningThinkingTimer();
        this.agentActivityListener(true);
    }

    private clearRunningThinkingTimer(): void {
        if (this.runningThinkingTimer) {
            clearTimeout(this.runningThinkingTimer);
            this.runningThinkingTimer = null;
        }
    }

    private forwardSessionInfoUpdate(sessionId: string | null, update: unknown): void {
        if (!isObject(update) || update.sessionUpdate !== ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate) {
            return;
        }
        if (typeof update.title !== 'string' && update.title !== null) {
            return;
        }
        this.sessionInfoUpdateListener?.({ sessionId, title: update.title });
    }

    private captureUsageUpdate(update: unknown): void {
        if (!isObject(update)) return;

        const sessionUpdate = asString(update.sessionUpdate);
        let contextTokens: number | null = null;
        let contextWindow: number | null = null;

        if (sessionUpdate === ACP_SESSION_UPDATE_TYPES.usageUpdate) {
            contextTokens = this.asFiniteNumber(update.used);
            contextWindow = this.asFiniteNumber(update.size);
        } else if (sessionUpdate === ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate) {
            contextTokens = this.asFiniteNumber(
                update.used
                ?? update.contextTokens
                ?? update.context_tokens
                ?? update.contextUsed
            );
            contextWindow = this.asFiniteNumber(
                update.size
                ?? update.contextWindow
                ?? update.context_window
                ?? update.contextLimit
            );
        } else {
            return;
        }

        this.latestUsageUpdate = {
            contextTokens: contextTokens ?? undefined,
            contextWindow: contextWindow ?? undefined
        };
        this.forwardUsageUpdate();
    }

    private hasForwardedUsage(update: AcpUsageUpdate): boolean {
        return this.lastForwardedUsageUpdate !== null
            && this.lastForwardedUsageUpdate.contextTokens === update.contextTokens
            && this.lastForwardedUsageUpdate.contextWindow === update.contextWindow;
    }

    private forwardUsageUpdate(): void {
        const update = this.latestUsageUpdate;
        if (
            !update
            || (update.contextTokens === undefined && update.contextWindow === undefined)
        ) {
            return;
        }

        if (
            this.lastForwardedUsageUpdate
            && this.lastForwardedUsageUpdate.contextTokens === update.contextTokens
            && this.lastForwardedUsageUpdate.contextWindow === update.contextWindow
        ) {
            return;
        }

        this.lastForwardedUsageUpdate = update;
        const message: AgentMessage = {
            type: 'usage',
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: update.contextTokens,
            contextWindow: update.contextWindow
        };

        if (this.promptUsageCallback) {
            this.promptUsageCallback(message);
        } else if (this.usageUpdateListener) {
            this.usageUpdateListener(message);
        }
    }

    private readLatestUsageUpdate(): AcpUsageUpdate | null {
        return this.latestUsageUpdate;
    }

    /**
     * Poll drainBuffers() on a short interval until the model has been quiet
     * for LATE_FLUSH_QUIET_PERIOD_MS or LATE_FLUSH_WINDOW_MS elapses. Polling
     * keeps the UI streaming smoothly while we wait; the quiet-window check
     * lets fast models exit almost immediately (Claude tail typically < 100ms)
     * while still bounding slow-tailing models (GPT-5.5, DeepSeek V4 Pro).
     *
     * The quiet measurement is anchored to entry time, not just
     * lastSessionUpdateAt: if session/prompt paused mid-turn (chunks → pause
     * → stopReason), lastSessionUpdateAt is already stale on entry and we
     * would otherwise exit immediately, missing any straggler that arrives
     * just after session/prompt resolves.
     */
    private async drainLateBuffers(): Promise<void> {
        const quietBaseline = Date.now();
        const deadline = quietBaseline + AcpSdkBackend.LATE_FLUSH_WINDOW_MS;
        while (Date.now() < deadline) {
            const latestActivityAt = Math.max(this.lastSessionUpdateAt, quietBaseline);
            const elapsedSinceUpdate = Date.now() - latestActivityAt;
            if (elapsedSinceUpdate >= AcpSdkBackend.LATE_FLUSH_QUIET_PERIOD_MS) {
                return;
            }
            const remainingBudget = deadline - Date.now();
            const waitMs = Math.max(1, Math.min(AcpSdkBackend.LATE_FLUSH_INTERVAL_MS, remainingBudget));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            this.messageHandler?.drainBuffers();
        }
    }

    private async waitForSessionUpdateQuiet(quietMs: number, timeoutMs: number): Promise<void> {
        if (quietMs <= 0 || timeoutMs <= 0) {
            return;
        }

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const elapsedSinceUpdate = Date.now() - this.lastSessionUpdateAt;
            if (elapsedSinceUpdate >= quietMs) {
                return;
            }

            const remainingToQuiet = quietMs - elapsedSinceUpdate;
            const remainingBudget = deadline - Date.now();
            const waitMs = Math.max(1, Math.min(remainingToQuiet, remainingBudget));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
    }

    private async handlePermissionRequest(params: unknown, requestId: string | number | null): Promise<unknown> {
        if (!isObject(params)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const sessionId = asString(params.sessionId) ?? this.activeSessionId ?? 'unknown';
        const toolCall = isObject(params.toolCall) ? params.toolCall : {};
        const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
        const title = asString(toolCall.title) ?? undefined;
        const kind = asString(toolCall.kind) ?? undefined;
        const rawInput = 'rawInput' in toolCall ? toolCall.rawInput : undefined;
        const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined;
        const options = Array.isArray(params.options)
            ? params.options
                .filter((option) => isObject(option))
                .map((option, index) => ({
                    optionId: asString(option.optionId) ?? `option-${index + 1}`,
                    name: asString(option.name) ?? `Option ${index + 1}`,
                    kind: asString(option.kind) ?? 'allow_once'
                }))
            : [];

        const request: PermissionRequest = {
            id: toolCallId,
            sessionId,
            toolCallId,
            title,
            kind,
            rawInput,
            rawOutput,
            options
        };

        const responsePromise = new Promise((resolve) => {
            this.pendingPermissions.set(toolCallId, { resolve });
        });

        if (this.permissionHandler) {
            try {
                // Permission prompts imply the agent is awake (#1470).
                this.agentActivityListener?.(true);
                this.permissionHandler(request);
            } catch (error) {
                this.pendingPermissions.delete(toolCallId);
                throw error;
            }
        } else {
            logger.debug('[ACP] No permission handler registered; cancelling request');
            this.pendingPermissions.delete(toolCallId);
            return { outcome: { outcome: 'cancelled' } };
        }

        return await responsePromise;
    }

    private beginPromptRequest(): number {
        this.activePromptRequests++;
        this.isProcessingMessage = true;
        return this.promptRequestEpoch;
    }

    /**
     * Force-settle soft-steer bookkeeping without waiting for the concurrent
     * `session/prompt` to finish. Called on abort: the in-flight turn is
     * cancelled anyway, so a pending soft steer may never complete; dropping
     * its counter keeps {@link waitForResponseComplete} from blocking the next
     * turn. Bumps the epoch so a stale finish from a cancelled request cannot
     * decrement a newer prompt's counter.
     */
    abortSoftSteers(): void {
        this.messageHandler?.drainBuffers();
        this.messageHandler?.deactivate?.();
        this.promptRequestEpoch++;
        this.activePromptRequests = this.foregroundPromptRequests;
        this.isProcessingMessage = this.activePromptRequests > 0;
        if (!this.isProcessingMessage) {
            this.notifyResponseComplete();
        }
    }

    private finishPromptRequest(epoch: number): void {
        if (epoch !== this.promptRequestEpoch) {
            return;
        }
        this.activePromptRequests = Math.max(0, this.activePromptRequests - 1);
        this.isProcessingMessage = this.activePromptRequests > 0;
        if (!this.isProcessingMessage) {
            this.notifyResponseComplete();
        }
    }

    private notifyResponseComplete(): void {
        const resolvers = this.responseCompleteResolvers;
        this.responseCompleteResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }

    /**
     * Optimistically update the cached `currentModelId` for a session after a
     * successful `session/set_model` call whose response does not echo the
     * model metadata (OpenCode 1.14.30 returns only `_meta.opencode.modelId`).
     * The previously captured `availableModels` list is preserved.
     */
    private updateCurrentModelOptimistic(sessionId: string, modelId: string): void {
        const existing = this.sessionModelsMetadata.get(sessionId);
        this.sessionModelsMetadata.set(sessionId, {
            availableModels: existing?.availableModels ?? [],
            currentModelId: modelId
        });
    }

    private updateThoughtLevelCurrentValue(sessionId: string, value: string): void {
        const options = this.sessionConfigOptions.get(sessionId);
        if (!options) return;
        this.sessionConfigOptions.set(sessionId, options.map((option) => (
            option.category === 'thought_level'
                ? { ...option, currentValue: value }
                : option
        )));
    }

    /** After a successful model config apply, avoid stale base-only ACP currentValue overwriting cache. */
    pinSessionModelWireId(sessionId: string, modelId: string): void {
        this.updateCurrentModelOptimistic(sessionId, modelId);
    }

    private extractPromptUsage(response: unknown): AcpPromptUsage | null {
        if (!isObject(response) || !isObject(response.usage)) return null;
        const usage = response.usage;
        const inputTokens = this.asFiniteNumber(usage.inputTokens ?? usage.input_tokens);
        const outputTokens = this.asFiniteNumber(usage.outputTokens ?? usage.output_tokens);
        if (inputTokens === null || outputTokens === null) return null;

        return {
            inputTokens,
            outputTokens,
            totalTokens: this.asFiniteNumber(usage.totalTokens ?? usage.total_tokens) ?? undefined,
            thoughtTokens: this.asFiniteNumber(usage.thoughtTokens ?? usage.thought_tokens) ?? undefined,
            cacheReadTokens: this.asFiniteNumber(
                usage.cachedReadTokens
                ?? usage.cached_read_tokens
                ?? usage.cachedInputTokens
                ?? usage.cached_input_tokens
            ) ?? undefined,
            cacheCreationTokens: this.asFiniteNumber(
                usage.cachedWriteTokens
                ?? usage.cached_write_tokens
                ?? usage.cacheCreationInputTokens
                ?? usage.cache_creation_input_tokens
            ) ?? undefined
        };
    }

    private asFiniteNumber(value: unknown): number | null {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }


    private captureSessionMetadata(sessionId: string, response: unknown): void {
        this.captureSessionModelsMetadata(sessionId, response);
        this.captureSessionConfigOptions(sessionId, response);
        this.captureAvailableCommands(sessionId, response);
    }

    private captureAvailableCommands(sessionId: string | null, source: unknown): void {
        if (!isObject(source)) return;

        const meta = isObject(source._meta) ? source._meta : null;
        const rawCommands = Array.isArray(source.availableCommands)
            ? source.availableCommands
            : meta && Array.isArray(meta.availableCommands)
                ? meta.availableCommands
                : null;
        if (!rawCommands) return;

        const byName = new Map<string, AcpAvailableCommand>();
        for (const entry of rawCommands) {
            if (!isObject(entry)) continue;
            const name = asString(entry.name)?.trim();
            if (!name) continue;
            const description = asString(entry.description)?.trim();
            const inputHint = isObject(entry.input) ? asString(entry.input.hint)?.trim() : undefined;
            byName.set(name, {
                name,
                ...(description ? { description } : {}),
                ...(inputHint ? { inputHint } : {})
            });
        }
        const commands = [...byName.values()];
        if (sessionId) {
            this.sessionAvailableCommands.set(sessionId, commands);
            return;
        }

        this.initialAvailableCommands = commands;
    }

    private captureSessionConfigOptions(sessionId: string, response: unknown): void {
        if (!isObject(response)) return;

        const options = this.parseConfigOptions(response.configOptions);

        const meta = isObject(response._meta) ? response._meta : null;
        const xaiConfig = meta && isObject(meta['x.ai/sessionConfig'])
            ? meta['x.ai/sessionConfig']
            : null;
        const xaiOptions = xaiConfig && Array.isArray(xaiConfig.options)
            ? xaiConfig.options.filter((entry): entry is Record<string, unknown> => isObject(entry))
            : [];
        const effortOptions = xaiOptions
            .filter((entry) => asString(entry.category) === 'mode')
            .map((entry) => ({
                value: asString(entry.id) ?? '',
                name: asString(entry.label) ?? undefined,
                selected: entry.selected === true
            }))
            .filter((entry) => entry.value.length > 0);
        if (effortOptions.length > 0) {
            options.push({
                id: 'x.ai/reasoning-effort',
                category: 'thought_level',
                currentValue: effortOptions.find((entry) => entry.selected)?.value,
                options: effortOptions.map(({ value, name }) => ({ value, name }))
            });
        }

        if (options.length > 0) {
            // Merge, do not replace: an agent answers a config change with the
            // options it re-published, not with the full roster. Replacing the
            // cache with that partial list drops the options the agent left out
            // (MiniMax Code answers a model switch with `[permissionMode,
            // model]` and no `thinkingEffort`), so the thinking-effort option
            // disappears and the next effort switch fails with "MiniMax Code
            // exposes no thinking-effort option".
            this.mergeParsedSessionConfigOptions(sessionId, options);
        }
    }

    /** Normalises the raw `configOptions` array of an ACP payload. */
    private parseConfigOptions(raw: unknown): AcpConfigOptionDescriptor[] {
        return (Array.isArray(raw) ? raw : [])
            .filter((entry): entry is Record<string, unknown> => isObject(entry))
            .map((entry): AcpConfigOptionDescriptor | null => {
                const id = asString(entry.id);
                if (!id) return null;
                const rawOptions = Array.isArray(entry.options) ? entry.options : [];
                return {
                    id,
                    category: asString(entry.category) ?? undefined,
                    currentValue: asString(entry.currentValue) ?? undefined,
                    options: rawOptions
                        .filter((option): option is Record<string, unknown> => isObject(option))
                        .map((option) => ({
                            value: asString(option.value) ?? '',
                            name: asString(option.name) ?? undefined
                        }))
                        .filter((option) => option.value.length > 0)
                };
            })
            .filter((entry): entry is AcpConfigOptionDescriptor => entry !== null);
    }

    /**
     * Refreshes the cached config options from a `config_option_update`.
     *
     * The update carries the options the agent re-published; options it left
     * out keep their cached value, so a partial update does not drop the model
     * or the thinking effort the session still runs with.
     */
    private mergeSessionConfigOptions(sessionId: string, raw: unknown): void {
        this.mergeParsedSessionConfigOptions(sessionId, this.parseConfigOptions(raw));
    }

    /** Merges already parsed config options into the session's cached list. */
    private mergeParsedSessionConfigOptions(
        sessionId: string,
        options: AcpConfigOptionDescriptor[]
    ): void {
        if (options.length === 0) return;
        const byId = new Map((this.sessionConfigOptions.get(sessionId) ?? []).map((option) => [option.id, option]));
        for (const option of options) {
            byId.set(option.id, option);
        }
        this.sessionConfigOptions.set(sessionId, [...byId.values()]);
    }

    /**
     * Extract `availableModels` and `currentModelId` from an ACP response and
     * store them keyed by sessionId. Both top-level and nested-under-`models`
     * shapes are accepted because different agents use different conventions.
     * Missing or malformed fields are silently ignored — flavors that do not
     * expose model metadata (e.g. current Gemini ACP build) simply leave the
     * cache untouched.
     */
    private captureSessionModelsMetadata(sessionId: string, response: unknown): void {
        if (!isObject(response)) return;

        const {
            availableModels: rawModels,
            currentModelId: rawCurrent,
            configModelOptions
        } = extractModelCatalog(response);

        if (rawModels === null && rawCurrent === null) {
            return;
        }

        const byModelId = new Map<string, AcpModelDescriptor>();
        const addModel = (
            modelId: string,
            name?: string,
            reasoningEfforts?: AcpModelDescriptor['reasoningEfforts']
        ) => {
            const trimmedId = modelId.trim();
            if (!trimmedId) return;
            const trimmedName = name?.trim();
            const existing = byModelId.get(trimmedId);
            if (!existing) {
                byModelId.set(
                    trimmedId,
                    trimmedName && trimmedName !== trimmedId
                        ? { modelId: trimmedId, name: trimmedName, ...(reasoningEfforts ? { reasoningEfforts } : {}) }
                        : { modelId: trimmedId, ...(reasoningEfforts ? { reasoningEfforts } : {}) }
                );
                return;
            }
            if (!existing.name && trimmedName && trimmedName !== trimmedId) {
                byModelId.set(trimmedId, { ...existing, name: trimmedName });
            }
        };

        if (Array.isArray(rawModels)) {
            for (const entry of rawModels) {
                if (!isObject(entry)) continue;
                const modelId = asString(entry.modelId) ?? asString(entry.value);
                if (!modelId) continue;
                const meta = isObject(entry._meta) ? entry._meta : null;
                const reasoningEfforts = meta && Array.isArray(meta.reasoningEfforts)
                    ? meta.reasoningEfforts
                        .filter((effort): effort is Record<string, unknown> => isObject(effort))
                        .map((effort) => ({
                            value: asString(effort.value) ?? asString(effort.id) ?? '',
                            name: asString(effort.label) ?? undefined,
                            isDefault: effort.default === true
                        }))
                        .filter((effort) => effort.value.length > 0)
                    : undefined;
                addModel(modelId, asString(entry.name) ?? undefined, reasoningEfforts);
            }
        } else {
            // Preserve previously-captured availableModels when the response only
            // updates currentModelId (e.g. a setModel response from some agents).
            const existing = this.sessionModelsMetadata.get(sessionId);
            for (const entry of existing?.availableModels ?? []) {
                addModel(entry.modelId, entry.name, entry.reasoningEfforts);
            }
        }

        // Cursor often lists one wire id per family in `models` but every variant in
        // `configOptions` category=model — merge so metadata matches Zed-style pickers.
        if (configModelOptions) {
            for (const entry of configModelOptions) {
                if (!isObject(entry)) continue;
                const modelId = asString(entry.value) ?? asString(entry.modelId);
                if (!modelId) continue;
                addModel(modelId, asString(entry.name) ?? undefined);
            }
        }

        const existing = this.sessionModelsMetadata.get(sessionId);
        const currentModelId = this.preferSpecificCursorWireId(
            rawCurrent,
            existing?.currentModelId ?? null
        );

        // A response that carries the model option without its option list must
        // not wipe the catalog the session/new response published: an empty
        // list would leave the model picker with nothing but "Default".
        const availableModels = [...byModelId.values()];
        this.sessionModelsMetadata.set(sessionId, {
            availableModels: availableModels.length > 0
                ? availableModels
                : (existing?.availableModels ?? []),
            currentModelId
        });
    }

    private preferSpecificCursorWireId(
        incoming: string | null,
        existing: string | null
    ): string | null {
        if (!incoming) {
            return existing;
        }
        if (!existing) {
            return incoming;
        }

        const incomingBase = incoming.split('[')[0];
        const existingBase = existing.split('[')[0];
        if (incomingBase !== existingBase) {
            return incoming;
        }

        const incomingHasVariant = incoming.includes('[');
        const existingHasVariant = existing.includes('[');
        if (!incomingHasVariant && existingHasVariant) {
            return existing;
        }

        return incoming;
    }
}
