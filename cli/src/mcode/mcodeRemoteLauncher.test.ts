import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { McodeMode } from './types'

const harness = vi.hoisted(() => ({
    backend: {} as Record<string, unknown>
}))

vi.mock('./utils/mcodeBackend', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/mcodeBackend')>()
    return {
        ...actual,
        createMcodeBackend: () => harness.backend
    }
})

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: { stop: () => {} },
        mcpServers: {}
    })
}))

vi.mock('./utils/permissionHandler', () => ({
    McodePermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))

vi.mock('./utils/questionHandler', () => ({
    McodeQuestionHandler: class {
        async cancelAll(): Promise<void> {}
        async handleResponse(): Promise<boolean> { return false }
    },
    normalizeMcodeAskUserToolCall: (message: unknown) => ({ message, hint: null })
}))

vi.mock('@/ui/ink/McodeDisplay', () => ({ McodeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

import { mcodeRemoteLauncher } from './mcodeRemoteLauncher'

type QueuedMessage = { message: string; mode: McodeMode }

function createBackend(overrides: Record<string, unknown> = {}) {
    const backend = {
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'mcode-session-1'),
        loadSession: vi.fn(async () => 'mcode-session-1'),
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
        prompt: vi.fn(async () => {}),
        cancelPrompt: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        setSessionInfoUpdateListener: vi.fn(),
        onPermissionRequest: vi.fn(),
        disconnect: vi.fn(async () => {}),
        ...overrides
    }
    harness.backend = backend
    return backend
}

function createSession(messages: QueuedMessage[] = []) {
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
        updateAgentState: vi.fn()
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
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        pushKeepAlive: vi.fn()
    }
    return session
}

describe('mcodeRemoteLauncher config sync', () => {
    afterEach(() => {
        harness.backend = {}
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
})
