import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { AcpSessionModeUnsupportedError } from '@/agent/backends/acp'
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { McodeMode } from './types'
import { knownMcodeAgentHostPids } from './utils/mcodeConnectorTools'

const harness = vi.hoisted(() => ({
    backend: {} as Record<string, unknown>,
    question: {
        cancelReasons: [] as string[],
        submitAnswer: null as ((text: string) => void) | null
    },
    restoredHandlers: {
        model: 0,
        slashCommands: 0
    },
    mcpBridgeOptions: null as { enableChangeTitle?: boolean; titleMode?: string } | null
}))

vi.mock('@/modules/common/handlers/mcodeModels', () => ({
    registerMcodeSessionModelHandlers: vi.fn(() => {
        harness.restoredHandlers.model += 1
    })
}))

vi.mock('@/modules/common/handlers/slashCommands', () => ({
    registerSlashCommandHandlers: vi.fn(() => {
        harness.restoredHandlers.slashCommands += 1
    })
}))

vi.mock('./utils/mcodeBackend', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/mcodeBackend')>()
    return {
        ...actual,
        createMcodeBackend: () => harness.backend
    }
})

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async (_client: unknown, options: { enableChangeTitle?: boolean; titleMode?: string }) => {
        harness.mcpBridgeOptions = options;
        return {
            server: { stop: () => {} },
            mcpServers: {}
        };
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    McodePermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('./utils/questionHandler', () => ({
    McodeQuestionHandler: class {
        constructor(
            _client: unknown,
            _backend: unknown,
            _takeHint: unknown,
            options: { submitAnswer: (text: string) => void }
        ) {
            harness.question.submitAnswer = options.submitAnswer
        }
        async cancelAll(reason?: string): Promise<void> {
            harness.question.cancelReasons.push(reason ?? '')
        }
        async handleResponse(): Promise<boolean> { return false }
    },
    normalizeMcodeAskUserToolCall: (message: unknown) => ({ message, hint: null })
}))

vi.mock('@/ui/ink/McodeDisplay', () => ({ McodeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

// The transcript of the agent, which the launcher reads when it reattaches to
// a session the agent can resume.
const transcriptState = vi.hoisted(() => ({
    messagesPath: null as string | null,
    messages: [] as unknown[]
}))

vi.mock('./utils/mcodeUsage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils/mcodeUsage')>()),
    findMcodeMessagesPath: vi.fn(async () => transcriptState.messagesPath)
}))

vi.mock('./utils/mcodeSessionTranscript', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils/mcodeSessionTranscript')>()),
    readMcodeTranscriptToolMessages: vi.fn(async () => transcriptState.messages)
}))

import { mcodeRemoteLauncher } from './mcodeRemoteLauncher'

type QueuedMessage = { message: string; mode: McodeMode }

function createBackend(overrides: Record<string, unknown> = {}) {
    const backend = {
        initialize: vi.fn(async () => {}),
        // The launcher asks whether the agent process is still there before
        // it treats a failure as "the agent died".
        isClosed: vi.fn(() => false),
        // The pid of the agent process. The connected-apps readout asks the
        // broker of exactly that host.
        getAgentPid: vi.fn(() => 4242),
        newSession: vi.fn(async () => 'mcode-session-1'),
        loadSession: vi.fn(async () => 'mcode-session-1'),
        // An agent that cannot resume is reattached with `session/load`, which
        // replays the conversation into HAPI.
        supportsSessionResume: vi.fn(() => false),
        resumeSession: vi.fn(async () => 'mcode-session-1'),
        setModel: vi.fn(async (_sessionId: string, _model: string) => {}),
        setSessionMode: vi.fn(async (_sessionId: string, _mode: string) => {}),
        setConfigOption: vi.fn(async (_sessionId: string, _id: string, _value: string) => {}),
        getConfigOptionByCategory: vi.fn(() => ({
            id: 'permissionMode',
            currentValue: 'default',
            options: []
        })),
        getSessionModelsMetadata: vi.fn(() => ({
            currentModelId: 'm:good',
            availableModels: [{ modelId: 'm:good' }]
        })),
        getThoughtLevelConfigOption: vi.fn(() => ({
            id: 'thinkingEffort',
            currentValue: 'max',
            options: [
                { value: 'low', name: 'Low' },
                { value: 'max', name: 'Max' }
            ]
        })),
        getAvailableCommands: vi.fn(() => []),
        getInitializeMeta: vi.fn(() => ({
            'minimax-code/extensions': {
                version: 1,
                methods: [
                    'mcode/session/goal/get',
                    'mcode/session/goal/create',
                    'mcode/session/goal/patch',
                    'mcode/session/goal/clear',
                    'mcode/session/delegation/get',
                    'mcode/session/delegation/stop',
                    'mcode/session/steer'
                ],
                notifications: ['mcode/session/goal_update', 'mcode/session/delegation_update']
            }
        })),
        sendExtensionRequest: vi.fn(async (method: string) => {
            if (method === 'mcode/session/goal/get') return { goal: null }
            if (method === 'mcode/session/delegation/get') return { snapshot: null }
            if (method === 'session/fork') return { sessionId: 'mvs-forked-1' }
            if (method === 'mcode/session/steer') return { turnId: 'turn-1', mode: 'steered' }
            throw new Error(`unexpected method ${method}`)
        }),
        supportsSessionFork: vi.fn(() => true),
        waitForSessionUpdateQueue: vi.fn(async () => {}),
        // The real backend calls onPromptSent once the request is on the
        // wire: that is where the runner hands the message to the agent.
        prompt: vi.fn(async (
            _sessionId: string,
            _content: unknown,
            _onUpdate: unknown,
            options?: { onPromptSent?: () => void }
        ) => {
            options?.onPromptSent?.();
        }),
        cancelPrompt: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        setSessionInfoUpdateListener: vi.fn(),
        setUsageUpdateListener: vi.fn(),
        setExtensionNotificationListener: vi.fn(),
        setSessionStateListener: vi.fn(),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {}),
        ...overrides
    }
    harness.backend = backend
    return backend
}

function createSession(messages: QueuedMessage[] = [], permissionMode: 'default' | 'plan' = 'default') {
    const queue = new MessageQueue2<McodeMode>((mode) => JSON.stringify(mode))
    for (const message of messages) {
        queue.push(message.message, message.mode)
    }
    queue.close()

    const client = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        updateAgentState: vi.fn(),
        updateMetadata: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitMessagesReleased: vi.fn(),
        emitMessagesIndeterminate: vi.fn()
    }
    const session = {
        path: '/tmp/mcode-test',
        logPath: '/tmp/mcode-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => permissionMode,
        onSessionFound(id: string) {
            session.sessionId = id
        },
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return session
}

/** The permission-mode failure messages the session reported to the user. */
function failureMessages(session: { sendSessionEvent: ReturnType<typeof vi.fn> }): string[] {
    return session.sendSessionEvent.mock.calls
        .map((call) => call[0] as { type?: string; message?: string })
        .filter((event) => event?.type === 'message' && typeof event.message === 'string')
        .map((event) => event.message as string)
        .filter((message) => message.includes('Failed to apply MiniMax Code permission mode'))
}

function createScriptedSession() {
    const queue = {
        waitForMessagesAndGetAsString: vi.fn()
            .mockResolvedValueOnce({ message: 'hi', mode: { permissionMode: 'default', model: null } })
            .mockResolvedValue(null),
        size: () => 0,
        reset: vi.fn(),
        pushIsolated: vi.fn(),
        pendingLocalIds: () => []
    }
    const client = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        updateAgentState: vi.fn(),
        updateMetadata: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitMessagesReleased: vi.fn(),
        emitMessagesIndeterminate: vi.fn()
    }
    const session = {
        path: '/tmp/mcode-test',
        logPath: '/tmp/mcode-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) {
            session.sessionId = id
        },
        onThinkingChange: vi.fn(),
        sendUserMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return { session, queue }
}

/**
 * A session whose message loop stays open, so the launcher's RPC handlers can
 * be called while the launcher is still running - it tears the backend down
 * when the loop ends.
 */
function createBlockingSession() {
    let release: (value: null) => void = () => {}
    const queue = {
        waitForMessagesAndGetAsString: vi.fn(() => new Promise<null>((resolve) => {
            release = resolve
        })),
        size: () => 0,
        reset: vi.fn(),
        pushIsolated: vi.fn(),
        pendingLocalIds: () => []
    }
    const client = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        updateAgentState: vi.fn(),
        updateMetadata: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        emitMessagesReleased: vi.fn(),
        emitMessagesIndeterminate: vi.fn()
    }
    const session = {
        path: '/tmp/mcode-test',
        logPath: '/tmp/mcode-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) {
            session.sessionId = id
        },
        onThinkingChange: vi.fn(),
        sendUserMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return { session, finish: () => release(null) }
}

/**
 * A session with a real message queue, so the steer handler can take a
 * message out of the queue and put it back.
 */
function createSteerSession() {
    const queue = new MessageQueue2<McodeMode>((mode) => JSON.stringify(mode))
    const client = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        updateAgentState: vi.fn(),
        updateMetadata: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        setSteerDeliveryState: vi.fn(async () => true),
        emitSteerIndeterminate: vi.fn(),
        emitMessagesReleased: vi.fn(),
        emitMessagesIndeterminate: vi.fn()
    }
    const session = {
        path: '/tmp/mcode-test',
        logPath: '/tmp/mcode-test/test.log',
        client,
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default' as const,
        onSessionFound(id: string) {
            session.sessionId = id
        },
        onThinkingChange: vi.fn(),
        sendUserMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return { session, queue, client }
}

function findRpcHandler(
    session: { client: { rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> } } },
    method: string
): (payload: unknown) => Promise<unknown> {
    const call = session.client.rpcHandlerManager.registerHandler.mock.calls.find((entry) => entry[0] === method)
    if (!call) throw new Error(`no handler registered for ${method}`)
    return call[1] as (payload: unknown) => Promise<unknown>
}

describe('mcodeRemoteLauncher config sync', () => {
    afterEach(() => {
        harness.backend = {}
        harness.question.cancelReasons = []
        harness.question.submitAnswer = null
        harness.mcpBridgeOptions = null
    })

    it('gives the agent the title tool so a new chat is named while it works', async () => {
        // MiniMax Code publishes its own title over ACP only after the turn it
        // derives it from has finished, so a new chat stayed untitled until
        // the first answer was done. The title tool lets the model name the
        // session while it is still working on it.
        const backend = createBackend()
        const session = createSession([{ message: 'hi', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(harness.mcpBridgeOptions?.enableChangeTitle).toBe(true)
        expect(backend.setModel).not.toHaveBeenCalled()
    })

    it('lets the title of the agent replace the one the model offers', async () => {
        // The title the model sets is a placeholder: the agent publishes the
        // real one at the end of the first turn, and that one has to win. A
        // rename would take the title away from the agent that owns it.
        const backend = createBackend()
        const session = createSession([{ message: 'hi', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(harness.mcpBridgeOptions?.titleMode).toBe('placeholder')
        expect(backend.setModel).not.toHaveBeenCalled()
    })

    it('keeps the context usage the agent publishes outside a turn', async () => {
        // MiniMax Code publishes its context usage over ACP when a turn ends,
        // from the agent's own task queue - so the notification can land after
        // the prompt was answered. The prompt callback is gone by then, so the
        // update has to reach the session through the usage listener. Without
        // it the context window never arrives, the usage the transcript
        // watcher reports has no denominator, and the context bar cannot show
        // "used / window".
        const backend = createBackend()
        const session = createSession([{ message: 'hi', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const registerUsageListener = backend.setUsageUpdateListener as unknown as ReturnType<typeof vi.fn>
        expect(registerUsageListener).toHaveBeenCalledTimes(1)

        const listener = registerUsageListener.mock.calls[0]?.[0] as ((message: unknown) => void) | undefined
        expect(listener).toBeDefined()

        listener?.({
            type: 'usage',
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: 15_928,
            contextWindow: 512_000
        })

        const sent = session.sendAgentMessage.mock.calls
            .map((call) => call[0] as { type?: string; info?: { contextTokens?: number; modelContextWindow?: number } })
            .filter((message) => message.type === 'token_count')
        expect(sent.length).toBeGreaterThan(0)
        expect(sent[sent.length - 1].info?.modelContextWindow).toBe(512_000)
    })

    it('remembers the agent it launched so the apps readout can ask it', async () => {
        // The connected apps live behind the broker of the agent that runs the
        // session, and the agent names that broker after its own pid.
        createBackend()
        const session = createSession([{ message: 'hi', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(knownMcodeAgentHostPids()).toContain(4242)
    })

    it('reports the model discovered from session/new when none was requested', async () => {
        const backend = createBackend()
        const session = createSession([{ message: 'hi', mode: { permissionMode: 'default', model: null } }])
        const onConfigDiscovered = vi.fn()

        await mcodeRemoteLauncher(session as never, { onConfigDiscovered })

        expect(onConfigDiscovered).toHaveBeenCalledWith({ model: 'm:good', effort: 'max' })
        expect(backend.setModel).not.toHaveBeenCalled()
    })

    it('rolls the hub model back when an inline switch is rejected', async () => {
        const backend = createBackend({
            setModel: vi.fn(async (_sessionId: string, model: string) => {
                if (model === 'm:bad') throw new Error('Model selection is not advertised.')
            })
        })
        const session = createSession([
            { message: 'first', mode: { permissionMode: 'default', model: 'm:good' } },
            { message: 'second', mode: { permissionMode: 'default', model: 'm:bad' } }
        ])
        const onModelRollback = vi.fn()

        await mcodeRemoteLauncher(session as never, {
            model: 'm:good',
            onConfigDiscovered: vi.fn(),
            onModelRollback
        })

        expect(backend.setModel).toHaveBeenCalledWith('mcode-session-1', 'm:good', { flavor: 'mcode' })
        expect(backend.setModel).toHaveBeenCalledWith('mcode-session-1', 'm:bad', { flavor: 'mcode' })
        expect(onModelRollback).toHaveBeenCalledWith('m:good')
        expect(backend.prompt).toHaveBeenCalledTimes(2)
    })

    it('reports the agent default when the requested startup model is rejected', async () => {
        createBackend({
            setModel: vi.fn(async () => {
                throw new Error('Model selection is not advertised.')
            })
        })
        const session = createSession()
        const onConfigDiscovered = vi.fn()

        await mcodeRemoteLauncher(session as never, {
            model: 'm:bad',
            onConfigDiscovered
        })

        expect(onConfigDiscovered).toHaveBeenCalledWith({ model: 'm:good', effort: 'max' })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Failed to switch model to m:bad: Model selection is not advertised. Using the agent default.'
        })
    })

    it('forwards the ACP model/effort catalog and command roster over session RPCs', async () => {
        const backend = createBackend({
            getAvailableCommands: vi.fn(() => [
                { name: 'help', description: 'Show available commands' }
            ])
        })
        const session = createSession()

        await mcodeRemoteLauncher(session as never, {})

        const register = session.client.rpcHandlerManager.registerHandler
        const commandsHandler = register.mock.calls.find(
            (call) => call[0] === RPC_METHODS.ListSlashCommands
        )?.[1] as ((payload: unknown) => Promise<unknown>) | undefined
        const modelsHandler = register.mock.calls.find(
            (call) => call[0] === RPC_METHODS.ListMcodeModels
        )?.[1] as ((payload: unknown) => Promise<unknown>) | undefined

        expect(commandsHandler).toBeTypeOf('function')
        expect(modelsHandler).toBeTypeOf('function')
        await expect(commandsHandler!({})).resolves.toMatchObject({
            success: true,
            commands: expect.arrayContaining([
                { name: 'help', description: 'Show available commands', source: 'builtin' }
            ])
        })
        await expect(modelsHandler!({})).resolves.toMatchObject({
            success: true,
            currentModelId: 'm:good',
            currentEffort: 'max'
        })
        expect(backend.setConfigOption).not.toHaveBeenCalledWith(
            'mcode-session-1',
            'thinkingEffort',
            expect.anything()
        )
    })

    it('applies the per-turn thinking effort through the ACP config option', async () => {
        const backend = createBackend()
        const session = createSession([
            { message: 'think harder', mode: { permissionMode: 'default', model: null, effort: 'low' } }
        ])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.setConfigOption).toHaveBeenCalledWith('mcode-session-1', 'thinkingEffort', 'low')
    })

    it('resolves a model the user named the CLI way to the published id', async () => {
        // The user may name a model the way the MiniMax CLI does
        // (`provider/model#variant`); the agent only accepts its own wire id.
        const backend = createBackend({
            getSessionModelsMetadata: vi.fn(() => ({
                currentModelId: 'm:minimax:MiniMax-M3:v:thinking',
                availableModels: [
                    { modelId: 'm:minimax:MiniMax-M3:v:thinking' },
                    { modelId: 'm:minimax:MiniMax-M3:v:' }
                ]
            }))
        })
        const session = createSession()

        await mcodeRemoteLauncher(session as never, { model: 'minimax/MiniMax-M3#thinking' })

        expect(backend.setModel).toHaveBeenCalledWith(
            'mcode-session-1',
            'm:minimax:MiniMax-M3:v:thinking',
            { flavor: 'mcode' }
        )
    })

    it('applies the per-turn thinking effort after a model switch', async () => {
        // MiniMax Code answers a model switch with a partial config-option
        // list, so the thinking-effort option must survive the switch.
        const backend = createBackend()
        const session = createSession([
            { message: 'switch model', mode: { permissionMode: 'default', model: 'm:other', effort: null } },
            { message: 'think harder', mode: { permissionMode: 'default', model: 'm:other', effort: 'low' } }
        ])

        await mcodeRemoteLauncher(session as never, { model: 'm:good' })

        expect(backend.setModel).toHaveBeenCalledWith('mcode-session-1', 'm:other', { flavor: 'mcode' })
        expect(backend.setConfigOption).toHaveBeenCalledWith('mcode-session-1', 'thinkingEffort', 'low')
    })

    it('restores the previous permission mode when plan entry is rejected', async () => {
        const backend = createBackend({
            setSessionMode: vi.fn(async (_sessionId: string, mode: string) => {
                if (mode === 'plan') throw new Error('Unsupported Session mode: plan')
            })
        })
        const session = createSession([{ message: 'plan this', mode: { permissionMode: 'plan', model: null } }])
        const onPermissionModeRollback = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeRollback })

        expect(onPermissionModeRollback).toHaveBeenCalledWith('default')
        expect(backend.setSessionMode.mock.calls.map((call) => call[1]))
            .toEqual(['default', 'plan', 'default'])
        expect(backend.prompt).toHaveBeenCalledTimes(1)
    })

    it('keeps the tool permission policy when the agent cannot switch session modes', async () => {
        const backend = createBackend({
            setSessionMode: vi.fn(async () => {
                throw new AcpSessionModeUnsupportedError()
            })
        })
        const session = createSession([
            { message: 'go', mode: { permissionMode: 'bypassPermissions', model: null } }
        ])
        const onPermissionModeRollback = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeRollback })

        // The policy rides on its own config option and must still be applied.
        expect(backend.setConfigOption).toHaveBeenCalledWith(
            'mcode-session-1',
            'permissionMode',
            'bypassPermissions'
        )
        expect(onPermissionModeRollback).not.toHaveBeenCalled()
        expect(failureMessages(session)).toEqual([])
        expect(backend.prompt).toHaveBeenCalledTimes(1)
    })

    it('reports the default mode when plan is asked for and the agent cannot switch modes', async () => {
        const backend = createBackend({
            setSessionMode: vi.fn(async () => {
                throw new AcpSessionModeUnsupportedError()
            })
        })
        const session = createSession([
            { message: 'plan this', mode: { permissionMode: 'plan', model: null } }
        ])
        const onPermissionModeRollback = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeRollback })

        expect(onPermissionModeRollback).not.toHaveBeenCalled()
        expect(backend.setConfigOption).toHaveBeenCalledWith(
            'mcode-session-1',
            'permissionMode',
            'default'
        )
    })

    it('keeps questions answerable after the turn that raised them ends', async () => {
        createBackend()
        const session = createSession([{ message: 'hi', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        // mcode ends the ask_user turn as soon as the questionnaire is raised,
        // so the turn boundary must not cancel the pending question.
        expect(harness.question.cancelReasons).not.toContain('Prompt finished')
        expect(harness.question.cancelReasons).toContain('Superseded by a new message')
    })

    it('delivers a question answer as the next user turn', async () => {
        createBackend()
        const { session, queue } = createScriptedSession()

        await mcodeRemoteLauncher(session as never, {})

        expect(harness.question.submitAnswer).toBeTypeOf('function')
        harness.question.submitAnswer!('Q: Which site?\nA: China')

        expect(session.sendUserMessage).toHaveBeenCalledWith('Q: Which site?\nA: China')
        expect(queue.pushIsolated).toHaveBeenCalledWith('Q: Which site?\nA: China', {
            permissionMode: 'default',
            model: 'm:good',
            effort: 'max'
        })
    })

    it('normalizes mcode todowrite calls into the canonical TodoWrite shape', async () => {
        const backend = createBackend({
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown,
                onMessage: (message: unknown) => void
            ) => {
                onMessage({
                    type: 'tool_call',
                    id: 'call-todo',
                    name: 'todowrite',
                    input: {
                        todos: [
                            { content: 'Ship the fix', status: 'in_progress', priority: 'high' },
                            { content: 'Abandoned idea', status: 'cancelled', priority: 'low' }
                        ]
                    },
                    status: 'completed'
                })
            })
        })
        const session = createSession([{ message: 'plan', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.prompt).toHaveBeenCalledTimes(1)
        expect(session.sendAgentMessage).toHaveBeenCalledWith({
            type: 'tool-call',
            name: 'TodoWrite',
            callId: 'call-todo',
            input: {
                todos: [
                    { content: 'Ship the fix', status: 'in_progress', priority: 'high' },
                    { content: 'Abandoned idea', status: 'completed', priority: 'low' }
                ]
            },
            status: 'completed'
        })
    })

    it('reconciles the background work of the conversation the agent replays', async () => {
        const backend = createBackend({
            loadSession: vi.fn(async (
                _config: unknown,
                options?: { onHistory?: (messages: unknown[]) => void }
            ) => {
                // The agent replays the conversation it remembers, with the
                // raw tool names of the agent.
                options?.onHistory?.([
                    {
                        type: 'tool_call',
                        id: 'call-1',
                        name: 'bash',
                        input: { command: 'npm run dev', run_in_background: true },
                        status: 'completed'
                    },
                    {
                        type: 'tool_result',
                        id: 'call-1',
                        output: {
                            content: [{ type: 'text', text: '<bash_background task_id="bg_1">Started.</bash_background>' }],
                            details: { task_id: 'bg_1', status: 'started' }
                        },
                        status: 'completed'
                    }
                ]);
                return 'mcode-session-1';
            })
        });
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }]);
        session.sessionId = 'mcode-existing';

        await mcodeRemoteLauncher(session as never, {});

        const snapshots = session.sendSessionEvent.mock.calls
            .map((call) => call[0] as { type?: string; tasks?: unknown })
            .filter((event) => event.type === 'background-task-snapshot');
        expect(snapshots).toEqual([
            {
                type: 'background-task-snapshot',
                tasks: [expect.objectContaining({ id: 'bg_1', command: 'npm run dev' })]
            }
        ]);
    });

    it('folds background task polls into the launch card', async () => {
        const backend = createBackend({
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown,
                onMessage: (message: unknown) => void
            ) => {
                onMessage({
                    type: 'tool_call',
                    id: 'task-call',
                    name: 'task',
                    input: { description: 'Research the repo', prompt: 'Look around' },
                    status: 'in_progress'
                })
                onMessage({
                    type: 'tool_result',
                    id: 'task-call',
                    output: {
                        content: [{ type: 'text', text: '<task_background task_id="bg_1">Started</task_background>' }],
                        details: { task_id: 'bg_1', status: 'started' }
                    },
                    status: 'completed'
                })
                onMessage({ type: 'tool_call', id: 'poll-1', name: 'task_output', input: null, status: 'pending' })
                onMessage({
                    type: 'tool_call',
                    id: 'poll-1',
                    name: 'task_output',
                    input: { task_id: 'bg_1', wait_ms: 5000 },
                    status: 'completed'
                })
                onMessage({
                    type: 'tool_result',
                    id: 'poll-1',
                    output: {
                        content: [{ type: 'text', text: '<task_output status="running">halfway there</task_output>' }],
                        details: { task_id: 'bg_1', status: 'running' }
                    },
                    status: 'completed'
                })
                onMessage({
                    type: 'tool_call',
                    id: 'poll-2',
                    name: 'task_output',
                    input: { task_id: 'bg_1' },
                    status: 'completed'
                })
                onMessage({
                    type: 'tool_result',
                    id: 'poll-2',
                    output: {
                        content: [{ type: 'text', text: '<task_output status="succeeded">all done</task_output>' }],
                        details: { task_id: 'bg_1', status: 'succeeded' }
                    },
                    status: 'completed'
                })
            })
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const sent = session.sendAgentMessage.mock.calls.map((call) => call[0])
        expect(sent).toHaveLength(3)
        expect(sent[0]).toMatchObject({ type: 'tool-call', name: 'Task', callId: 'task-call' })
        expect(sent[1]).toMatchObject({
            type: 'tool-call',
            name: 'Task',
            callId: 'task-call',
            progress: { content: [{ type: 'text', text: expect.stringContaining('halfway there') }] }
        })
        expect(sent[2]).toMatchObject({ type: 'tool-call-result', callId: 'task-call', is_error: false })
        expect(JSON.stringify(sent[2])).toContain('all done')
        expect(JSON.stringify(sent)).not.toContain('task_output')

        // The background work is published as a whole list, so the count the
        // hub stores cannot drift away from the session.
        const snapshots = session.sendSessionEvent.mock.calls
            .map((call) => call[0] as { type?: string; tasks?: unknown })
            .filter((event) => event.type === 'background-task-snapshot')
        expect(snapshots).toEqual([
            { type: 'background-task-snapshot', tasks: [expect.objectContaining({ id: 'bg_1' })] },
            { type: 'background-task-snapshot', tasks: [] }
        ])
    })
})

describe('mcodeRemoteLauncher ACP extensions', () => {
    afterEach(() => {
        harness.backend = {}
    })

    function createExtensionBackend(notifications: Array<[string, unknown]>) {
        let listener: ((method: string, params: unknown) => void) | null = null
        const backend = createBackend({
            setExtensionNotificationListener: vi.fn((next: (method: string, params: unknown) => void) => {
                listener = next
            }),
            prompt: vi.fn(async () => {
                for (const [method, params] of notifications) {
                    listener?.(method, params)
                }
            })
        })
        return backend
    }

    it('forwards the delegation snapshot to the hub', async () => {
        createExtensionBackend([
            ['mcode/session/delegation_update', {
                sessionId: 'mcode-session-1',
                snapshot: {
                    rootSessionId: 'mcode-session-1',
                    members: [
                        {
                            sessionId: 'child-1',
                            parentSessionId: 'mcode-session-1',
                            agentName: 'explore',
                            task: 'Explore the API',
                            status: 'running',
                            createdAtMs: 5
                        }
                    ]
                }
            }]
        ])
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'subagent-snapshot',
            members: [{
                id: 'child-1',
                parentId: 'mcode-session-1',
                title: 'Explore the API',
                detail: 'explore',
                status: 'running',
                startedAt: 5,
                endedAt: null,
                depth: 0
            }]
        })
    })

    it('ignores a malformed delegation snapshot', async () => {
        createExtensionBackend([['mcode/session/delegation_update', { snapshot: { members: [] } }]])
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        // The only snapshot is the empty one the cleanup sends when the
        // remote session ends.
        expect(events.filter((event) => event?.type === 'subagent-snapshot')).toEqual([
            { type: 'subagent-snapshot', members: [] }
        ])
    })

    it('forwards the thread goal and records its lifecycle', async () => {
        createExtensionBackend([
            ['mcode/session/goal_update', {
                sessionId: 'mcode-session-1',
                goal: {
                    goalId: 'goal-1',
                    sessionId: 'mcode-session-1',
                    objective: 'Ship the feature',
                    status: 'active',
                    createdAt: 1_700_000_000_000,
                    updatedAt: 1_700_000_060_000,
                    tokensUsed: 1200,
                    turnsUsed: 3,
                    timeUsedSeconds: 42,
                    tokenBudget: 10_000
                }
            }]
        ])
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const goal = {
            threadId: 'mcode-session-1',
            objective: 'Ship the feature',
            status: 'active',
            tokenBudget: 10_000,
            tokensUsed: 1200,
            timeUsedSeconds: 42,
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_060
        }
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'thread-goal-updated', goal })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: JSON.stringify({ goal })
        })
    })

    it('forwards a cleared thread goal', async () => {
        createExtensionBackend([
            ['mcode/session/goal_update', { sessionId: 'mcode-session-1', goal: null, goalId: 'goal-1' }]
        ])
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        // The thread id tells the web which goal disappeared: without it, a
        // session that runs several threads drops the goal of all of them.
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'thread-goal-cleared',
            threadId: 'mcode-session-1'
        })
    })
})

describe('mcodeRemoteLauncher extension capabilities', () => {
    afterEach(() => {
        harness.backend = {}
    })

    function createExtensionBackend(notifications: Array<[string, unknown]>, meta?: unknown) {
        let listener: ((method: string, params: unknown) => void) | null = null
        const backend = createBackend({
            getInitializeMeta: vi.fn(() => meta),
            setExtensionNotificationListener: vi.fn((next: (method: string, params: unknown) => void) => {
                listener = next
            }),
            prompt: vi.fn(async () => {
                for (const [method, params] of notifications) {
                    listener?.(method, params)
                }
            })
        })
        return backend
    }

    it('publishes the advertised extension surface as session capabilities', async () => {
        createBackend()
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(session.client.updateMetadata).toHaveBeenCalledWith(expect.any(Function))
        const updater = session.client.updateMetadata.mock.calls[0][0] as (m: unknown) => unknown
        expect(updater({ capabilities: { terminal: true } })).toMatchObject({
            capabilities: {
                terminal: true,
                mcodeExtensions: {
                    goal: true,
                    goalCreate: true,
                    goalPatch: true,
                    goalClear: true,
                    delegation: true,
                    delegationStop: true
                }
            }
        })
    })

    it('reports no goal capabilities when the agent disabled the goal extension', async () => {
        createBackend({
            getInitializeMeta: vi.fn(() => ({
                'minimax-code/extensions': {
                    version: 1,
                    methods: ['mcode/session/delegation/stop'],
                    notifications: ['mcode/session/delegation_update']
                }
            }))
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const updater = session.client.updateMetadata.mock.calls[0][0] as (m: unknown) => unknown
        expect(updater({})).toMatchObject({
            capabilities: {
                mcodeExtensions: {
                    goal: false,
                    goalCreate: false,
                    goalPatch: false,
                    goalClear: false,
                    delegation: true,
                    delegationStop: true
                }
            }
        })
    })

    it('publishes the fork capability when the agent advertises session/fork', async () => {
        createBackend()
        const { session, finish } = createBlockingSession()

        const launched = mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(session.client.updateMetadata).toHaveBeenCalled()
        })
        finish()
        await launched

        const calls = session.client.updateMetadata.mock.calls
        const updaters = calls.map((call) => call[0] as (m: unknown) => unknown)
        const published = updaters.map((updater) => updater({}) as {
            capabilities?: { conversationHistory?: { forkCurrent?: boolean } }
        })
        expect(published.some((entry) => entry.capabilities?.conversationHistory?.forkCurrent === true)).toBe(true)
    })

    it('drops the fork capability when the agent goes away', async () => {
        createBackend()
        const { session, finish } = createBlockingSession()

        const launched = mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(session.client.updateMetadata).toHaveBeenCalled()
        })
        finish()
        await launched

        // The hub merges the metadata writes, so the chain of updates is what
        // the hub ends up with. The local TUI cannot fork: a stale "fork
        // supported" would leave a dead Fork button on the last message.
        const calls = session.client.updateMetadata.mock.calls
        let metadata: { capabilities?: { conversationHistory?: { forkCurrent?: boolean } } } = {}
        for (const call of calls) {
            const updater = call[0] as (m: unknown) => unknown
            metadata = updater(metadata) as typeof metadata
        }
        expect(metadata.capabilities?.conversationHistory?.forkCurrent).toBe(false)
    })

    it('does not publish a fork capability the agent does not have', async () => {
        createBackend({ supportsSessionFork: vi.fn(() => false) })
        const { session, finish } = createBlockingSession()

        const launched = mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(session.client.updateMetadata).toHaveBeenCalled()
        })
        finish()
        await launched

        const calls = session.client.updateMetadata.mock.calls
        const published = calls.map((call) => {
            const updater = call[0] as (m: unknown) => unknown
            return updater({}) as { capabilities?: { conversationHistory?: { forkCurrent?: boolean } } }
        })
        expect(published.some((entry) => entry.capabilities?.conversationHistory?.forkCurrent === true)).toBe(false)
    })

    it('forks the session through the registered RPC handler', async () => {
        const backend = createBackend()
        const { session, finish } = createBlockingSession()

        const launched = mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            const registration = session.client.rpcHandlerManager.registerHandler.mock.calls
                .find((call) => call[0] === RPC_METHODS.ForkConversation)
            expect(registration).toBeDefined()
        })

        const registration = session.client.rpcHandlerManager.registerHandler.mock.calls
            .find((call) => call[0] === RPC_METHODS.ForkConversation)!
        const handler = registration[1] as (payload: unknown) => Promise<unknown>

        await expect(handler({})).resolves.toEqual({ nativeSessionId: 'mvs-forked-1' })
        expect(backend.sendExtensionRequest).toHaveBeenCalledWith('session/fork', {
            sessionId: 'mcode-session-1',
            cwd: '/tmp/mcode-test',
            mcpServers: []
        })

        finish()
        await launched
    })

    it('steers a queued message into the running turn', async () => {
        // The turn never ends, so the launcher stays inside the prompt.
        const backend = createBackend({ prompt: vi.fn(() => new Promise(() => {})) });
        const { session, queue, client } = createSteerSession();
        queue.push('first', { permissionMode: 'default', model: null });

        void mcodeRemoteLauncher(session as never, {});
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalled();
        });
        // The user sends a second message while the agent is working: it waits
        // in the queue until it is steered.
        queue.push('steer me', { permissionMode: 'default', model: null }, 'local-1');

        const handler = findRpcHandler(session, RPC_METHODS.SteerQueuedMessage);
        await expect(handler({ localId: 'local-1' })).resolves.toEqual({ steered: true });
        expect(backend.sendExtensionRequest).toHaveBeenCalledWith('mcode/session/steer', {
            sessionId: 'mcode-session-1',
            text: 'steer me',
            // The client request id is the agent's idempotency key.
            clientRequestId: 'local-1'
        });
        await vi.waitFor(() => {
            expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1'], { steered: true });
        });
        // The message left the queue: the normal loop must not deliver it too.
        expect(queue.peekByLocalId('local-1')).toBeNull();
        queue.close();
    });

    it('refuses a steer while no turn is running', async () => {
        const backend = createBackend();
        const { session, queue } = createSteerSession();

        void mcodeRemoteLauncher(session as never, {});
        await vi.waitFor(() => {
            expect(findRpcHandler(session, RPC_METHODS.SteerQueuedMessage)).toBeDefined();
        });

        const handler = findRpcHandler(session, RPC_METHODS.SteerQueuedMessage);
        const result = await handler({ localId: 'local-1' });
        expect(result).toEqual({ steered: false, error: 'MiniMax Code has no running turn to steer' });
        expect(backend.sendExtensionRequest).not.toHaveBeenCalledWith('mcode/session/steer', expect.anything());
        queue.close();
    });

    it('puts the message back when the agent rejects the steer', async () => {
        const backend = createBackend({
            prompt: vi.fn(() => new Promise(() => {})),
            sendExtensionRequest: vi.fn(async (method: string) => {
                if (method === 'mcode/session/steer') {
                    throw new Error('Invalid params: The active ACP prompt Turn changed before steering was admitted.');
                }
                if (method === 'mcode/session/goal/get') return { goal: null };
                if (method === 'mcode/session/delegation/get') return { snapshot: null };
                throw new Error(`unexpected method ${method}`);
            })
        });
        const { session, queue, client } = createSteerSession();
        queue.push('first', { permissionMode: 'default', model: null });

        void mcodeRemoteLauncher(session as never, {});
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalled();
        });
        queue.push('steer me', { permissionMode: 'default', model: null }, 'local-1');

        const handler = findRpcHandler(session, RPC_METHODS.SteerQueuedMessage);
        const result = await handler({ localId: 'local-1' });
        expect(result).toEqual({
            steered: false,
            error: 'Invalid params: The active ACP prompt Turn changed before steering was admitted.'
        });
        // The row goes back to the queue: the normal loop delivers it later.
        expect(queue.peekByLocalId('local-1')?.message).toBe('steer me');
        expect(client.emitMessagesConsumed).not.toHaveBeenCalled();
        queue.close();
    });

    it('holds a steer whose transport failed instead of replaying it', async () => {
        const backend = createBackend({
            prompt: vi.fn(() => new Promise(() => {})),
            sendExtensionRequest: vi.fn(async (method: string) => {
                if (method === 'mcode/session/steer') {
                    // The request may have reached the agent: the transport
                    // failed before the answer came back.
                    const error = new Error('ACP request timed out')
                    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true })
                    throw error
                }
                if (method === 'mcode/session/goal/get') return { goal: null };
                if (method === 'mcode/session/delegation/get') return { snapshot: null };
                throw new Error(`unexpected method ${method}`);
            })
        });
        const { session, queue, client } = createSteerSession();
        queue.push('first', { permissionMode: 'default', model: null });

        void mcodeRemoteLauncher(session as never, {});
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalled();
        });
        queue.push('steer me', { permissionMode: 'default', model: null }, 'local-1');

        const handler = findRpcHandler(session, RPC_METHODS.SteerQueuedMessage);
        const result = await handler({ localId: 'local-1' });
        expect(result).toEqual({ steered: false, error: 'Steer outcome is being reconciled' });
        // The row must not go back into the automatic queue: the agent may
        // have injected the message, and the hub would replay it.
        expect(queue.peekByLocalId('local-1')).toBeNull();
        expect(client.emitSteerIndeterminate).toHaveBeenCalledWith(['local-1']);
        expect(client.emitMessagesConsumed).not.toHaveBeenCalled();
        queue.close();
    });

    it('never calls a steer method the agent did not advertise', async () => {
        const backend = createBackend({
            prompt: vi.fn(() => new Promise(() => {})),
            getInitializeMeta: vi.fn(() => ({
                'minimax-code/extensions': {
                    version: 1,
                    methods: ['mcode/session/goal/get'],
                    notifications: []
                }
            }))
        });
        const { session, queue } = createSteerSession();
        queue.push('first', { permissionMode: 'default', model: null });

        void mcodeRemoteLauncher(session as never, {});
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalled();
        });
        queue.push('steer me', { permissionMode: 'default', model: null }, 'local-1');

        const handler = findRpcHandler(session, RPC_METHODS.SteerQueuedMessage);
        const result = await handler({ localId: 'local-1' });
        expect(result).toEqual({
            steered: false,
            error: 'MiniMax Code did not advertise the steer extension'
        });
        expect(backend.sendExtensionRequest).not.toHaveBeenCalledWith('mcode/session/steer', expect.anything());
        queue.close();
    });

    it('ignores an extension notification the agent did not advertise', async () => {
        // The agent feature-gates its goal extension: a build without goals
        // never emits goal_update, and a build that renames it must not leave
        // the web showing a goal nobody can control.
        createExtensionBackend(
            [['mcode/session/goal_update', {
                sessionId: 'mcode-session-1',
                goal: {
                    goalId: 'goal-1',
                    sessionId: 'mcode-session-1',
                    objective: 'Ship the feature',
                    status: 'active',
                    createdAt: 1_700_000_000_000,
                    updatedAt: 1_700_000_060_000,
                    tokensUsed: 1200,
                    turnsUsed: 3,
                    timeUsedSeconds: 42,
                    tokenBudget: 10_000
                }
            }]],
            {
                'minimax-code/extensions': {
                    version: 1,
                    methods: [],
                    notifications: ['mcode/session/delegation_update']
                }
            }
        )
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event) => event?.type === 'thread-goal-updated')).toEqual([])
    })

    it('restores the goal of a resumed session', async () => {
        // The goal notification is a one-way push, so a CLI that restarted
        // would otherwise leave the web without the goal the agent runs on.
        const backend = createBackend({
            sendExtensionRequest: vi.fn(async (method: string) => {
                if (method === 'mcode/session/goal/get') {
                    return {
                        goal: {
                            goalId: 'goal-1',
                            sessionId: 'mcode-session-1',
                            objective: 'Ship the feature',
                            status: 'active',
                            createdAt: 1_700_000_000_000,
                            updatedAt: 1_700_000_060_000,
                            tokensUsed: 1200,
                            turnsUsed: 3,
                            timeUsedSeconds: 42,
                            tokenBudget: 10_000
                        }
                    }
                }
                throw new Error(`unexpected method ${method}`)
            })
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.sendExtensionRequest).toHaveBeenCalledWith(
            'mcode/session/goal/get',
            { sessionId: 'mcode-session-1' }
        )
        expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'thread-goal-updated',
            goal: expect.objectContaining({ objective: 'Ship the feature', status: 'active' })
        }))
    })

    it('restores the delegation tree of a resumed session', async () => {
        // The tree is a one-way push like the goal: a CLI that restarted would
        // otherwise show no subagents even though the agent runs them.
        const backend = createBackend({
            sendExtensionRequest: vi.fn(async (method: string) => {
                if (method === 'mcode/session/delegation/get') {
                    return {
                        snapshot: {
                            schemaVersion: 1,
                            rootSessionId: 'mcode-session-1',
                            members: [{
                                sessionId: 'child-1',
                                parentSessionId: 'mcode-session-1',
                                agentName: 'explore',
                                task: 'Explore the API',
                                status: 'running',
                                createdAtMs: 5
                            }]
                        }
                    }
                }
                if (method === 'mcode/session/goal/get') return { goal: null }
                throw new Error(`unexpected method ${method}`)
            })
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.sendExtensionRequest).toHaveBeenCalledWith(
            'mcode/session/delegation/get',
            { sessionId: 'mcode-session-1' }
        )
        expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'subagent-snapshot',
            members: [expect.objectContaining({ id: 'child-1', title: 'Explore the API' })]
        }))
    })

    it('does not ask for a goal the agent did not advertise', async () => {        const backend = createBackend({
            getInitializeMeta: vi.fn(() => ({
                'minimax-code/extensions': {
                    version: 1,
                    methods: [],
                    notifications: []
                }
            }))
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.sendExtensionRequest).not.toHaveBeenCalled()
    })

    it('registers the goal and delegation control RPCs', async () => {
        createBackend()
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const methods = session.client.rpcHandlerManager.registerHandler.mock.calls
            .map((call) => call[0] as string)
        expect(methods).toEqual(expect.arrayContaining([
            RPC_METHODS.McodeCreateGoal,
            RPC_METHODS.McodePatchGoal,
            RPC_METHODS.McodeClearGoal,
            RPC_METHODS.McodeStopDelegation
        ]))
    })
})

describe('mcodeRemoteLauncher session state', () => {
    afterEach(() => {
        harness.backend = {}
    })

    type ConfigOption = {
        id: string
        category?: string
        currentValue?: string
        options: Array<{ value: string }>
    }

    function createStateBackend(options: {
        configOptions?: ConfigOption[]
        updates?: Array<
            | { kind: 'mode'; sessionId: string | null; modeId: string }
            | { kind: 'config-options'; sessionId: string | null }
            | { kind: 'plan-removed'; sessionId: string | null; planId: string }
        >
    }) {
        let listener: ((update: never) => void) | null = null
        const configOptions: ConfigOption[] = options.configOptions ?? [
            { id: 'permissionMode', category: '_permission', currentValue: 'default', options: [] }
        ]
        const backend = createBackend({
            setSessionStateListener: vi.fn((next: (update: never) => void) => {
                listener = next
            }),
            getSessionConfigOptions: vi.fn(() => configOptions),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                configOptions.find((option) => option.category === category)),
            prompt: vi.fn(async () => {
                for (const update of options.updates ?? []) {
                    listener?.(update as never)
                }
            })
        })
        return backend
    }

    it('publishes the mode the agent reports when it disagrees with the applied mode', async () => {
        createStateBackend({
            updates: [{ kind: 'mode', sessionId: 'mcode-session-1', modeId: 'default' }]
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'plan', model: null } }], 'plan')
        const onPermissionModeChanged = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeChanged })

        expect(onPermissionModeChanged).toHaveBeenCalledWith('default')
    })

    it('does not publish a mode the agent confirms', async () => {
        createStateBackend({
            updates: [{ kind: 'mode', sessionId: 'mcode-session-1', modeId: 'plan' }]
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'plan', model: null } }], 'plan')
        const onPermissionModeChanged = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeChanged })

        expect(onPermissionModeChanged).not.toHaveBeenCalled()
    })

    it('publishes the permission policy the agent republishes', async () => {
        createStateBackend({
            configOptions: [
                { id: 'permissionMode', category: '_permission', currentValue: 'bypassPermissions', options: [] }
            ],
            updates: [{ kind: 'config-options', sessionId: 'mcode-session-1' }]
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])
        const onPermissionModeChanged = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeChanged })

        expect(onPermissionModeChanged).toHaveBeenCalledWith('bypassPermissions')
    })

    it('republishes the applied mode when the agent returns to it', async () => {
        createStateBackend({
            updates: [
                { kind: 'mode', sessionId: 'mcode-session-1', modeId: 'default' },
                { kind: 'mode', sessionId: 'mcode-session-1', modeId: 'plan' }
            ]
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'plan', model: null } }], 'plan')
        const onPermissionModeChanged = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeChanged })

        expect(onPermissionModeChanged.mock.calls.map((call) => call[0])).toEqual(['default', 'plan'])
    })

    it('keeps the plan mode while the agent reports the plan session mode', async () => {
        createStateBackend({
            configOptions: [
                { id: 'permissionMode', category: '_permission', currentValue: 'default', options: [] }
            ],
            updates: [
                { kind: 'config-options', sessionId: 'mcode-session-1' },
                { kind: 'mode', sessionId: 'mcode-session-1', modeId: 'plan' }
            ]
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'plan', model: null } }], 'plan')
        const onPermissionModeChanged = vi.fn()

        await mcodeRemoteLauncher(session as never, { onPermissionModeChanged })

        expect(onPermissionModeChanged).not.toHaveBeenCalled()
    })

    it('forwards a withdrawn plan so the web can drop the plan card', async () => {
        createStateBackend({
            updates: [{ kind: 'plan-removed', sessionId: 'mcode-session-1', planId: 'plan-1' }]
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'plan-removed', planId: 'plan-1' })
    })
})

describe('mcodeRemoteLauncher abort handling', () => {
    afterEach(() => {
        harness.backend = {}
    })

    /**
     * A session whose agent is idle: the first wait blocks until the user
     * aborts, the second one returns immediately (the queue is closed).
     */
    function createIdleSession() {
        const abortHandlers: Array<() => Promise<void>> = []
        const waits: number[] = []
        const queue = {
            waitForMessagesAndGetAsString: vi.fn((signal?: AbortSignal) => {
                waits.push(waits.length)
                if (waits.length === 1) {
                    return new Promise((resolve) => {
                        signal?.addEventListener('abort', () => resolve(null))
                    })
                }
                return Promise.resolve(null)
            }),
            size: () => 0,
            reset: vi.fn(),
            pushIsolated: vi.fn(),
            pendingLocalIds: () => []
        }
        const client = {
            rpcHandlerManager: {
                registerHandler: vi.fn((method: string, handler: () => Promise<void>) => {
                    if (method === RPC_METHODS.Abort) abortHandlers.push(handler)
                })
            },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            updateAgentState: vi.fn(),
            updateMetadata: vi.fn()
        }
        const session = {
            path: '/tmp/mcode-test',
            logPath: '/tmp/mcode-test/test.log',
            client,
            queue,
            sessionId: null as string | null,
            getPermissionMode: () => 'default' as const,
            onSessionFound(id: string) { session.sessionId = id },
            onThinkingChange: vi.fn(),
            sendUserMessage: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            setModel: vi.fn(),
            setPermissionMode: vi.fn(),
            pushKeepAlive: vi.fn()
        }
        return { session, abortHandlers, waits }
    }

    it('keeps the session alive when the user aborts while the agent is idle', async () => {
        createBackend()
        const { session, abortHandlers, waits } = createIdleSession()

        const launched = mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => expect(abortHandlers.length).toBeGreaterThan(0))
        await vi.waitFor(() => expect(waits.length).toBe(1))

        await abortHandlers[0]()

        // The abort only cancels a turn: the launcher waits for the next
        // message instead of ending the whole HAPI session.
        const reason = await launched
        expect(waits.length).toBe(2)
        expect(reason).toBe('exit')
    })

    it('cancels a turn whose abort landed before the prompt started', async () => {
        const abortHandlers: Array<() => Promise<void>> = []
        const events: string[] = []

        let configOptionCalls = 0
        const backend = createBackend({
            setConfigOption: vi.fn(async () => {
                events.push('setConfigOption')
                configOptionCalls += 1
                // The second call is the one the message loop makes, after the
                // launcher applied the session's startup mode. The abort lands
                // there: between taking the message and starting the turn.
                if (configOptionCalls === 2) {
                    while (abortHandlers.length === 0) {
                        await new Promise((resolve) => setTimeout(resolve, 0))
                    }
                    await abortHandlers[0]()
                }
            }),
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown,
                _onUpdate: unknown,
                options?: { onPromptSent?: () => void }
            ) => {
                events.push('prompt')
                options?.onPromptSent?.()
            }),
            cancelPrompt: vi.fn(async () => {
                events.push('cancel')
            })
        })

        const queue = {
            waitForMessagesAndGetAsString: vi.fn()
                .mockResolvedValueOnce({
                    message: 'hi',
                    mode: { permissionMode: 'bypassPermissions', model: null }
                })
                .mockResolvedValue(null),
            size: () => 0,
            reset: vi.fn(),
            pushIsolated: vi.fn(),
            pendingLocalIds: () => []
        }
        const client = {
            rpcHandlerManager: {
                registerHandler: vi.fn((method: string, handler: () => Promise<void>) => {
                    if (method === RPC_METHODS.Abort) abortHandlers.push(handler)
                })
            },
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            updateAgentState: vi.fn(),
            updateMetadata: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            emitMessagesReleased: vi.fn(),
        emitMessagesIndeterminate: vi.fn()
        }
        const session = {
            path: '/tmp/mcode-test',
            logPath: '/tmp/mcode-test/test.log',
            client,
            queue,
            sessionId: null as string | null,
            getPermissionMode: () => 'default' as const,
            onSessionFound(id: string) { session.sessionId = id },
            onThinkingChange: vi.fn(),
            sendUserMessage: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            setModel: vi.fn(),
            setPermissionMode: vi.fn(),
            pushKeepAlive: vi.fn()
        }

        const launched = mcodeRemoteLauncher(session as never, {})

        await launched

        // The abort's own cancel went out before the turn existed, so it
        // cancelled nothing. The turn starts - the message was already
        // acknowledged when it left the queue - and a second cancel goes out
        // right behind the prompt request, which is what stops the agent.
        expect(events).toEqual(['setConfigOption', 'setConfigOption', 'cancel', 'prompt', 'cancel'])
    })
})

describe('mcodeRemoteLauncher refused turn', () => {
    const BUSY_ERROR = 'Internal error: MiniMax Code Runtime failed: Session already has an active Turn. Use queue send to deliver the message after it.'

    it('keeps a message the agent refused because the session was busy', async () => {
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    // The agent refuses the turn: its session still has an
                    // active one (a background task it is running, or another
                    // client attached to the same native session).
                    throw new Error(BUSY_ERROR)
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 5_000 })

        // The message was not lost: the refused batch went back into the
        // queue and was delivered on the retry.
        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[0][1]).toEqual([{ type: 'text', text: 'first' }])
        expect(promptMock.mock.calls[1][1]).toEqual([{ type: 'text', text: 'first' }])
        // The user is told what is going on, once - not once per attempt.
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        const notices = events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('busy'))
        expect(notices).toHaveLength(1)
        // The notice says the message is kept, so the user does not resend it.
        expect((notices[0] as { message: string }).message).toContain('Your message is kept')
        // The raw agent error is not shown: it is not actionable on its own.
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('prompt failed'))).toHaveLength(0)
        queue.close()
    })

    it('gives a refused message back to the hub', async () => {
        // The batch was acknowledged when it was handed to the agent, and the
        // agent refused the turn: it never took the message. The hub has to
        // learn that, or a runner that dies before the retry loses the
        // message for good - the re-queued copy only lives in this process.
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) throw new Error(BUSY_ERROR)
            })
        })
        const { session, queue, client } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null }, 'local-refused')

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 10_000 })

        expect(client.emitMessagesReleased).toHaveBeenCalledWith(['local-refused'])
        queue.close()
    })

    it('does not give a fatally refused message back to the hub', async () => {
        // The agent will never accept this request, so the message is
        // dropped. Releasing it would send it round the loop forever.
        const backend = createBackend({
            prompt: vi.fn(async () => {
                throw new Error('Internal error: MiniMax Code Runtime failed: turn input is invalid')
            })
        })
        const { session, queue, client } = createSteerSession()
        queue.push('broken', { permissionMode: 'default', model: null }, 'local-broken')

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 10_000 })

        expect(client.emitMessagesReleased).not.toHaveBeenCalled()
        queue.close()
    })

    it('keeps the message through several refusals in a row', async () => {
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls <= 3) {
                    throw new Error(BUSY_ERROR)
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('kept', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(4)
        }, { timeout: 20_000 })

        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        for (const call of promptMock.mock.calls) {
            expect(call[1]).toEqual([{ type: 'text', text: 'kept' }])
        }
        // One notice for the wait, not one per refusal.
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('busy'))).toHaveLength(1)
        queue.close()
    }, 25_000)

    it('keeps a message the agent refused because its queue is paused', async () => {
        // Another refusal of the same family: the session is not ready, so
        // the message must not be lost.
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    throw new Error('Internal error: MiniMax Code Runtime failed: The session Queue is paused')
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 10_000 })

        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[1][1]).toEqual([{ type: 'text', text: 'first' }])
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('paused'))).toHaveLength(1)
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('prompt failed'))).toHaveLength(0)
        queue.close()
    }, 15_000)

    it('keeps a message the agent refused for a reason it did not name', async () => {
        // The agent answered with an error of its own, but the wording is one
        // HAPI has not seen. That is still a refusal - the agent is not ready
        // - and the message stays.
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    const error = new Error('Internal error: MiniMax Code Runtime failed: something new') as Error & { code?: number }
                    error.code = -32603
                    throw error
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 10_000 })

        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[1][1]).toEqual([{ type: 'text', text: 'first' }])
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('Your message is kept'))).toHaveLength(1)
        queue.close()
    }, 15_000)

    it('starts the agent again when its process died, and keeps the message', async () => {
        // The agent process died mid-turn. The message is not lost: it goes
        // back into the queue, a new agent is started for it, and the
        // conversation continues where the dead one left it.
        let promptCalls = 0;
        let agentDead = false;
        const backend = createBackend({
            isClosed: vi.fn(() => agentDead),
            initialize: vi.fn(async () => {
                agentDead = false;
            }),
            prompt: vi.fn(async () => {
                promptCalls += 1;
                if (promptCalls === 1) {
                    agentDead = true;
                    throw new Error('ACP transport is closed');
                }
            })
        });
        const { session, queue } = createSteerSession();
        queue.push('first', { permissionMode: 'default', model: null });

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 20_000 })

        // The same message goes out once the agent is back.
        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[1][1]).toEqual([{ type: 'text', text: 'first' }])
        // The user is told what happened instead of watching the message
        // disappear.
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('starting it again'))).toHaveLength(1)
        queue.close()
    }, 25_000)

    it('holds a message the agent died on instead of sending it again', async () => {
        // The agent was handed the message and then died: it may have
        // consumed it, and nothing can prove which. Sending the message
        // again would let the agent run the same work twice, so the message
        // waits for the user instead.
        let promptCalls = 0
        let agentDead = false
        const backend = createBackend({
            isClosed: vi.fn(() => agentDead),
            initialize: vi.fn(async () => {
                agentDead = false
            }),
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown,
                _onUpdate: unknown,
                options?: { onPromptSent?: () => void }
            ) => {
                promptCalls += 1
                if (promptCalls === 1) {
                    options?.onPromptSent?.()
                    agentDead = true
                    throw new Error('ACP transport is closed')
                }
            })
        })
        const { session, queue, client } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null }, 'local-unknown')

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(client.emitMessagesIndeterminate).toHaveBeenCalledWith(['local-unknown'])
        }, { timeout: 20_000 })

        // It is not sent again on its own, and it is not acked either: the
        // hub holds it until the user retries or cancels it.
        expect(backend.prompt).toHaveBeenCalledTimes(1)
        expect(client.emitMessagesReleased).not.toHaveBeenCalled()
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('cannot tell what it did with it'))).toHaveLength(1)
        queue.close()
    }, 25_000)

    it('says why the agent could not be started', async () => {
        // "mcode is not installed" and "mcode is not signed in" lead to
        // different actions, so the message has to name one of them.
        const backend = createBackend({
            initialize: vi.fn(async () => {
                throw new Error('Failed to spawn mcode: spawn mcode ENOENT. Is it installed and on PATH?')
            })
        })
        const { session } = createSteerSession()

        // The failure carries the reason, so the runner can tell the user what
        // to do instead of leaving a grey session behind.
        await expect(mcodeRemoteLauncher(session as never, {})).rejects.toThrow(/not installed/)
    })

    it('gives up on an agent that keeps dying instead of restarting forever', async () => {
        // An agent that dies on every start must not turn into a restart
        // loop: the session ends with a message that says so.
        let agentDead = false;
        const backend = createBackend({
            isClosed: vi.fn(() => agentDead),
            initialize: vi.fn(async () => {
                agentDead = false;
            }),
            prompt: vi.fn(async () => {
                agentDead = true;
                throw new Error('ACP transport is closed');
            })
        });
        const { session, queue } = createSteerSession();
        queue.push('first', { permissionMode: 'default', model: null });

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
            expect(events.filter((event: { message?: string } | undefined) =>
                typeof event?.message === 'string' && event.message.includes('ending this session'))).toHaveLength(1)
        }, { timeout: 30_000 })

        // The agent was started again a bounded number of times.
        expect((backend.initialize as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5)
        queue.close()
    }, 35_000)

    it('drops a message the agent can never accept', async () => {
        // The request itself is wrong: asking again produces the same answer.
        const backend = createBackend({
            prompt: vi.fn(async () => {
                throw new Error('Internal error: MiniMax Code Runtime failed: Turn input is invalid')
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })

        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('prompt failed'))).toHaveLength(1)
        // A request that can never work is not retried.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(backend.prompt).toHaveBeenCalledTimes(1)
        queue.close()
    })

    it('still reports a failure that is not a busy session', async () => {
        const backend = createBackend({
            prompt: vi.fn(async () => {
                throw new Error('the model is gone')
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })

        // A real failure is reported as it was - only the busy refusal is
        // treated as "try again later".
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('prompt failed'))).toHaveLength(1)
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('busy'))).toHaveLength(0)
        queue.close()
    })

    it('keeps the refused message ahead of the messages queued behind it', async () => {
        // The refused batch goes back to the head of the queue, so the user
        // still reads their messages in the order they wrote them.
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    throw new Error(BUSY_ERROR)
                }
            })
        })
        const { session, queue } = createSteerSession()
        // Different modes: the two messages are not batched together.
        queue.push('first', { permissionMode: 'default', model: null }, 'local-1')
        queue.push('second', { permissionMode: 'auto', model: null }, 'local-2')

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(3)
        }, { timeout: 10_000 })

        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[0][1]).toEqual([{ type: 'text', text: 'first' }])
        expect(promptMock.mock.calls[1][1]).toEqual([{ type: 'text', text: 'first' }])
        expect(promptMock.mock.calls[2][1]).toEqual([{ type: 'text', text: 'second' }])
        queue.close()
    })

    it('keeps a message the agent refused while it compacts the conversation', async () => {
        // The same refusal family, a different reason: the session is
        // compacting, so it is not ready for a turn - and the message must not
        // be lost either.
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    throw new Error('Internal error: MiniMax Code Runtime failed: Session compaction is active')
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 5_000 })

        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[1][1]).toEqual([{ type: 'text', text: 'first' }])
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('compacting'))).toHaveLength(1)
        expect(events.filter((event: { message?: string } | undefined) =>
            typeof event?.message === 'string' && event.message.includes('prompt failed'))).toHaveLength(0)
        queue.close()
    })

    it('sends the refusal as a queue notice, not as something the agent said', async () => {
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    throw new Error(BUSY_ERROR)
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 5_000 })

        const events = session.sendSessionEvent.mock.calls.map((call) => call[0]) as Array<{
            type?: string
            reason?: string
            message?: string
            waitingSeconds?: number
        }>
        // The notice has its own type: it is HAPI talking about the queue,
        // and a client has to be able to tell it apart from agent speech.
        const notices = events.filter((event) => event?.type === 'queue-notice')
        expect(notices).toHaveLength(1)
        expect(notices[0].reason).toBe('busy')
        expect(notices[0].message).toContain('Your message is kept')
        expect(typeof notices[0].waitingSeconds).toBe('number')
        // It is not an agent message.
        expect(events.filter((event) =>
            event?.type === 'message' && typeof event.message === 'string' && event.message.includes('busy'))).toHaveLength(0)
        queue.close()
    })

    it('publishes that the session waits for the agent while the message waits', async () => {
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    throw new Error(BUSY_ERROR)
                }
            })
        })
        const { session, queue, client } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 5_000 })

        // The agent holds a turn HAPI never started, so the session looks idle
        // from HAPI's side. The state has to say so, or a client cannot tell
        // "the agent is busy" from "the agent ignored me".
        const states = client.updateAgentState.mock.calls.map((call) =>
            (call[0] as (state: Record<string, unknown>) => Record<string, unknown>)({})
        )
        expect(states.some((state) => state.waitingForAgent === true)).toBe(true)
        // The flag is cleared once the turn starts again.
        expect(states.some((state) => state.waitingForAgent === false)).toBe(true)
        const waiting = states.find((state) => state.waitingForAgent === true)
        expect(typeof waiting?.waitingSinceMs).toBe('number')
        queue.close()
    })
})

describe('mcodeRemoteLauncher local handoff', () => {
    afterEach(() => {
        harness.backend = {}
        harness.restoredHandlers.model = 0
        harness.restoredHandlers.slashCommands = 0
    })

    it('restores the probe handlers and clears the remote state when the session ends', async () => {
        createBackend()
        // The counters are shared with the other tests in this file, and a
        // launcher from an earlier test can still be shutting down: the
        // restore that belongs to *this* launcher is the one that happens
        // after it started.
        const modelsBefore = harness.restoredHandlers.model
        const commandsBefore = harness.restoredHandlers.slashCommands
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        // The live catalog died with the backend: the local mode has to be
        // able to answer the model picker again.
        expect(harness.restoredHandlers.model).toBeGreaterThan(modelsBefore)
        expect(harness.restoredHandlers.slashCommands).toBeGreaterThan(commandsBefore)

        // The goal and the delegation tree belong to the remote session.
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'thread-goal-cleared',
            threadId: 'mcode-session-1'
        })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'subagent-snapshot', members: [] })
    })

    it('closes the ACP session before the backend goes away', async () => {
        // `session/close` releases the attachment state the agent keeps for a
        // connected session; the session itself stays in its data directory.
        const backend = createBackend()
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.closeSession).toHaveBeenCalledWith('mcode-session-1')
        expect(backend.disconnect).toHaveBeenCalled()
    })

    it('still disconnects when closing the session fails', async () => {
        const backend = createBackend({
            closeSession: vi.fn(async () => {
                throw new Error('Method not found')
            })
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.disconnect).toHaveBeenCalled()
    })
})

describe('mcodeRemoteLauncher turn lease', () => {
    const HELD_LEASE = {
        status: 'held' as const,
        lease: {
            ownerId: 'turn-lease:17826:cd08c161-4c0d-4f53-8823-2814223f43ee.3a2ee0d3',
            ownerKind: 'turn',
            acquiredAtMs: 1792650918661,
            expiresAtMs: 1792654038974
        }
    };
    const FREE = { status: 'free' as const };
    const UNKNOWN = { status: 'unknown' as const };

    it('does not send a turn while the agent holds the session', async () => {
        // The agent's runtime runs a turn of its own on this session - a
        // background task that finished has to be reported - and a turn sent
        // into that lease is refused. The lease is read first, so the message
        // waits instead of being refused.
        let leaseReads = 0
        const backend = createBackend()
        const { session, queue } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => {
                leaseReads += 1
                return leaseReads <= 3 ? HELD_LEASE : FREE
            })
        })

        // The turn is not sent while the lease is held.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(backend.prompt).not.toHaveBeenCalled()

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })

        // The message went out unchanged, once the agent was free.
        const promptMock = backend.prompt as ReturnType<typeof vi.fn>
        expect(promptMock.mock.calls[0][1]).toEqual([{ type: 'text', text: 'go' }])
        queue.close()
    })

    it('tells the user the session is busy while it waits for the lease', async () => {
        let leaseReads = 0
        const backend = createBackend()
        const { session, queue } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => {
                leaseReads += 1
                return leaseReads <= 3 ? HELD_LEASE : FREE
            })
        })

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })

        // One notice for the wait, not one per poll.
        const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
        const notices = events.filter((event: { type?: string; message?: string } | undefined) =>
            event?.type === 'queue-notice')
        expect(notices).toHaveLength(1)
        expect((notices[0] as { message: string }).message).toContain('Your message is kept')
        queue.close()
    })

    it('publishes that the session waits for the agent while the lease is held', async () => {
        let leaseReads = 0
        const backend = createBackend()
        const { session, queue, client } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => {
                leaseReads += 1
                return leaseReads <= 3 ? HELD_LEASE : FREE
            })
        })

        await vi.waitFor(() => {
            const states = client.updateAgentState.mock.calls.map((call) =>
                (call[0] as (state: Record<string, unknown>) => Record<string, unknown>)({})
            )
            expect(states.some((state) => state.waitingForAgent === true)).toBe(true)
        }, { timeout: 5_000 })
        queue.close()
    })

    it('does not touch the agent configuration while it holds the session', async () => {
        // A session that holds the lease refuses more than the turn: the
        // model, the effort and the permission mode cannot be applied either.
        // Applying them first would report a failed model switch to the user
        // every time their message waited for a turn that was already running.
        const backend = createBackend()
        const configOption = backend.setConfigOption as ReturnType<typeof vi.fn>
        const { session, queue } = createSteerSession()
        // A mode the session did not start with, so the turn really has to
        // apply it.
        queue.push('go', { permissionMode: 'auto', model: null })

        let configCallsWhenTheWaitStarted = -1
        let leaseReads = 0
        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => {
                leaseReads += 1
                if (leaseReads === 1) {
                    configCallsWhenTheWaitStarted = configOption.mock.calls.length
                }
                return leaseReads <= 3 ? HELD_LEASE : FREE
            })
        })

        // The configuration is not touched while the agent holds the session.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(configOption.mock.calls.length).toBe(configCallsWhenTheWaitStarted)

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })
        // The configuration is applied once the agent is free.
        expect(configOption.mock.calls.length).toBeGreaterThan(configCallsWhenTheWaitStarted)
        queue.close()
    })

    it('acknowledges the message when the agent takes it', async () => {
        // The hub is told the message is delivered when the runner hands it
        // to the agent, not when the runner takes it out of its own queue.
        const backend = createBackend()
        const { session, queue, client } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null }, 'local-1')

        void mcodeRemoteLauncher(session as never, {})

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1'])
        queue.close()
    })

    it('keeps a waiting message queued while the agent is busy', async () => {
        // The wait happens before the message is taken from the queue, so a
        // message that waits for a busy agent is still a queued message: the
        // user can cancel it, the hub still has it, and a runner that dies
        // here hands it to the next runner instead of losing it.
        let leaseReads = 0
        const backend = createBackend()
        const { session, queue, client } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null }, 'local-1')

        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => {
                leaseReads += 1
                return leaseReads <= 3 ? HELD_LEASE : FREE
            })
        })

        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(queue.size()).toBe(1)
        expect(backend.prompt).not.toHaveBeenCalled()
        expect(client.emitMessagesConsumed).not.toHaveBeenCalled()

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })
        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1'])
        queue.close()
    })

    it('acknowledges the messages an abort dropped', async () => {
        // The abort clears the queue. A message that stays unacknowledged
        // would stay queued in the hub and be handed to the next runner,
        // which would deliver a message the user just stopped.
        const backend = createBackend()
        const { session, queue, client } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null }, 'local-1')

        void mcodeRemoteLauncher(session as never, {
            // The agent holds the session, so the message stays queued and
            // the abort finds it there.
            readTurnLease: vi.fn(async () => HELD_LEASE)
        })

        const registerHandler = client.rpcHandlerManager.registerHandler as ReturnType<typeof vi.fn>
        await vi.waitFor(() => {
            expect(registerHandler.mock.calls.some((call) => call[0] === RPC_METHODS.Abort)).toBe(true)
        }, { timeout: 5_000 })
        const abortHandler = registerHandler.mock.calls.find((call) => call[0] === RPC_METHODS.Abort)?.[1] as () => Promise<void>
        await abortHandler()

        expect(client.emitMessagesConsumed).toHaveBeenCalledWith(['local-1'])
        queue.close()
    })

    it('sends the turn right away when the lease state is unknown', async () => {
        // An agent whose runtime index cannot be read must not hold the
        // session hostage: the turn is attempted the way it was before.
        const backend = createBackend()
        const { session, queue } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null })

        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => UNKNOWN)
        })

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(1)
        }, { timeout: 5_000 })
        queue.close()
    })

    it('waits for the lease before it retries a refused turn', async () => {
        // The refusal says the session is not ready; the lease says when it
        // will be. The retry waits for the lease, not for a guessed backoff.
        const BUSY_ERROR = 'Internal error: MiniMax Code Runtime failed: Session already has an active Turn. Use queue send to deliver the message after it.'
        let promptCalls = 0
        const backend = createBackend({
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) throw new Error(BUSY_ERROR)
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('go', { permissionMode: 'default', model: null })

        let leaseReads = 0
        void mcodeRemoteLauncher(session as never, {
            readTurnLease: vi.fn(async () => {
                leaseReads += 1
                // The lease is held while the refusal is being handled, and
                // free afterwards.
                return leaseReads <= 4 ? HELD_LEASE : FREE
            })
        })

        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 10_000 })
        queue.close()
    })
})

describe('mcodeRemoteLauncher agent restart', () => {
    it('applies the permission policy again when the agent is started again', async () => {
        // The tool permission policy is a per-process config option: an agent
        // that was started again runs without it. The policy has to be applied
        // again, or the session runs under the agent's own default while the
        // web still shows the mode the user picked.
        let promptCalls = 0
        let agentDead = false
        const backend = createBackend({
            isClosed: vi.fn(() => agentDead),
            initialize: vi.fn(async () => {
                agentDead = false
            }),
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    agentDead = true
                    throw new Error('ACP transport is closed')
                }
            })
        })
        const { session, queue } = createSteerSession()
        ;(session as unknown as { getPermissionMode: () => string }).getPermissionMode = () => 'auto'
        queue.push('first', { permissionMode: 'auto', model: null })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 20_000 })

        const configMock = backend.setConfigOption as ReturnType<typeof vi.fn>
        const policyWrites = configMock.mock.calls.filter((call) => call[1] === 'permissionMode')
        // Once for the agent that started the session, once for the agent that
        // was started again.
        expect(policyWrites.length).toBeGreaterThanOrEqual(2)
        expect(policyWrites[policyWrites.length - 1][2]).toBe('auto')
        queue.close()
    }, 25_000)

    it('keeps the model the user picked when the agent is started again', async () => {
        // The model the user picked in the middle of the session is not the
        // one the session was started with: a restart must not put the old
        // one back, and the hub must not be told that it did.
        let promptCalls = 0
        let agentDead = false
        const reportedModels: (string | null)[] = []
        const backend = createBackend({
            isClosed: vi.fn(() => agentDead),
            initialize: vi.fn(async () => {
                agentDead = false
            }),
            getSessionModelsMetadata: vi.fn(() => ({
                currentModelId: 'm:good',
                availableModels: [{ modelId: 'm:good' }, { modelId: 'm:fast' }]
            })),
            prompt: vi.fn(async () => {
                promptCalls += 1
                if (promptCalls === 1) {
                    agentDead = true
                    throw new Error('ACP transport is closed')
                }
            })
        })
        const { session, queue } = createSteerSession()
        queue.push('first', { permissionMode: 'default', model: 'm:fast' })

        void mcodeRemoteLauncher(session as never, {
            onConfigDiscovered: (config: { model: string | null }) => {
                reportedModels.push(config.model)
            }
        })
        await vi.waitFor(() => {
            expect(backend.prompt).toHaveBeenCalledTimes(2)
        }, { timeout: 20_000 })

        // The model that is in effect after the restart is the one the user
        // asked for, not the one the session was started with.
        expect(reportedModels[reportedModels.length - 1]).toBe('m:fast')
        queue.close()
    }, 25_000)

    it('ends the session when the agent keeps dying after it answered a turn', async () => {
        // An agent that answers a turn and dies right after it resets the
        // "died in a row" counter every time, so the session would restart it
        // forever. The restarts that pile up in a short span are the same
        // failure and end the session.
        let agentDead = false
        let turns = 0
        const backend = createBackend({
            isClosed: vi.fn(() => agentDead),
            initialize: vi.fn(async () => {
                agentDead = false
            })
        })
        const { session, queue } = createSteerSession()
        const mode = { permissionMode: 'default' as const, model: null }
        queue.push('first', mode)

        backend.prompt = vi.fn(async () => {
            if (agentDead) {
                throw new Error('ACP transport is closed')
            }
            // The agent answered the turn and died right after it.
            agentDead = true
            turns += 1
            // The next message finds the agent gone.
            queue.push(`follow up ${turns}`, mode)
        })

        void mcodeRemoteLauncher(session as never, {})
        await vi.waitFor(() => {
            const events = session.sendSessionEvent.mock.calls.map((call) => call[0])
            expect(events.filter((event: { message?: string } | undefined) =>
                typeof event?.message === 'string' && event.message.includes('ending this session'))).toHaveLength(1)
        }, { timeout: 40_000 })

        // The agent was started again a bounded number of times.
        expect((backend.initialize as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5)
        queue.close()
    }, 45_000)
})

describe('mcodeRemoteLauncher session resume', () => {
    afterEach(() => {
        transcriptState.messagesPath = null
        transcriptState.messages = []
    })

    it('reattaches without replaying the conversation when the agent can resume', async () => {
        // `session/load` makes the agent stream the whole conversation back
        // into HAPI - every message, every thought - only for HAPI to drop it
        // again. `session/resume` reattaches to the same conversation without
        // the replay.
        const backend = createBackend({
            supportsSessionResume: vi.fn(() => true)
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])
        session.sessionId = 'mcode-existing'

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'mcode-existing'
        }))
        expect(backend.loadSession).not.toHaveBeenCalled()
    })

    it('falls back to the replay when the agent cannot resume', async () => {
        const backend = createBackend()
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])
        session.sessionId = 'mcode-existing'

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.loadSession).toHaveBeenCalled()
        expect(backend.resumeSession).not.toHaveBeenCalled()
    })

    it('reconciles the background work with the transcript of the agent', async () => {
        // The turns the agent ran on its own are not in HAPI's transcript, so a
        // runner that attaches to an existing session has to learn about them
        // from the agent's own file.
        const backend = createBackend({
            supportsSessionResume: vi.fn(() => true)
        })
        transcriptState.messagesPath = '/tmp/mcode-session/messages.jsonl'
        transcriptState.messages = [
            {
                type: 'tool_call',
                id: 'call-1',
                name: 'bash',
                input: { command: 'npm run dev', run_in_background: true },
                status: 'completed'
            },
            {
                type: 'tool_result',
                id: 'call-1',
                output: {
                    content: [{ type: 'text', text: '<bash_background task_id="bg_1">Started.</bash_background>' }],
                    details: { task_id: 'bg_1', status: 'started' }
                },
                status: 'completed'
            }
        ]
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])
        session.sessionId = 'mcode-existing'

        await mcodeRemoteLauncher(session as never, {})

        const snapshots = session.sendSessionEvent.mock.calls
            .map((call) => call[0] as { type?: string; tasks?: unknown })
            .filter((event) => event.type === 'background-task-snapshot')
        expect(snapshots).toEqual([
            {
                type: 'background-task-snapshot',
                tasks: [expect.objectContaining({ id: 'bg_1', command: 'npm run dev' })]
            }
        ])
    })

    it('keeps the ledger empty when the transcript cannot be read', async () => {
        const backend = createBackend({
            supportsSessionResume: vi.fn(() => true)
        })
        transcriptState.messagesPath = null
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])
        session.sessionId = 'mcode-existing'

        await mcodeRemoteLauncher(session as never, {})

        expect(backend.resumeSession).toHaveBeenCalled()
        const snapshots = session.sendSessionEvent.mock.calls
            .map((call) => call[0] as { type?: string })
            .filter((event) => event.type === 'background-task-snapshot')
        expect(snapshots).toEqual([])
    })
})

describe('mcodeRemoteLauncher delivered files', () => {
    it('takes the delivery block out of the answer and reports the file', async () => {
        // MiniMax Code declares the files it hands over in a `<deliver-assets>`
        // block. The MiniMax Code apps render that block; HAPI's clients do
        // not know it, so it would reach the chat as raw XML.
        const backend = createBackend({
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown,
                onMessage: (message: unknown) => void
            ) => {
                onMessage({
                    type: 'text',
                    text: 'The report is ready.\n\n<deliver-assets><media type="text" src="/home/talos/coding/hapi/report.md" title="report.md" /></deliver-assets>'
                })
            })
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])
        session.path = '/home/talos/coding/hapi'

        await mcodeRemoteLauncher(session as never, {})

        const spoken = session.sendAgentMessage.mock.calls
            .map((call) => call[0] as { type?: string; message?: string })
        expect(spoken.some((message) => (message.message ?? '').includes('deliver-assets'))).toBe(false)
        expect(spoken.some((message) => (message.message ?? '').includes('The report is ready.'))).toBe(true)

        // The file is reported the way HAPI reports a file anywhere else: a
        // path relative to the session's working directory, which the clients
        // turn into a link that opens the file.
        const answer = spoken.map((message) => message.message ?? '').join('\n')
        expect(answer).toContain('Delivered: `report.md`')
    })

    it('keeps an answer that only talks about the markup', async () => {
        const backend = createBackend({
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown,
                onMessage: (message: unknown) => void
            ) => {
                onMessage({
                    type: 'text',
                    text: 'The tag <deliver-assets></deliver-assets> means a delivery.'
                })
            })
        })
        const session = createSession([{ message: 'go', mode: { permissionMode: 'default', model: null } }])

        await mcodeRemoteLauncher(session as never, {})

        const spoken = session.sendAgentMessage.mock.calls
            .map((call) => call[0] as { message?: string })
        expect(spoken.some((message) => (message.message ?? '').includes('deliver-assets'))).toBe(true)
    })
})
