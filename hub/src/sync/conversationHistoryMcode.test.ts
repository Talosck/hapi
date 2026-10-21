import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('MiniMax Code conversation-history hub integration', () => {
    it('does not seed the fork child with the forked native id', async () => {
        // The child publishes the native id it really bound. Seeding the row
        // with the requested id would make the bind check pass even when the
        // child fell back to a blank session.
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('mcode-source', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'mcode',
                mcodeSessionId: 'mvs-source-native',
                summary: { text: 'mcode source title', updatedAt: 100 },
                capabilities: { conversationHistory: { forkCurrent: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'hello' }, 'local1')
            store.messages.markMessagesInvoked(source.id, ['local1'], Date.now())

            ;(engine as any).rpcGateway.forkConversation = async () => ({ nativeSessionId: 'mvs-clone-native' })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => ({
                type: 'success', sessionId: args[12]
            })
            const exactBinds: unknown[][] = []
            ;(engine as any).waitForExactNativeForkBound = async (...args: unknown[]) => {
                exactBinds.push(args)
                return true
            }
            let capturedChildMetadata: Record<string, unknown> | undefined
            const cache = (engine as any).sessionCache
            const originalCreate = cache.getOrCreateSession.bind(cache)
            cache.getOrCreateSession = (...args: unknown[]) => {
                if (typeof args[0] === 'string' && args[0].startsWith('fork:')) {
                    capturedChildMetadata = args[1] as Record<string, unknown>
                }
                return originalCreate(...args)
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)

            expect(capturedChildMetadata).toMatchObject({
                flavor: 'mcode',
                summary: { text: 'Fork: mcode source title', updatedAt: expect.any(Number) },
            })
            expect(capturedChildMetadata?.mcodeSessionId).toBeUndefined()
            expect(exactBinds).toEqual([[result.sessionId, 'mvs-clone-native', 'mcodeSessionId', false]])
            expect(store.messages.getAllMessages(result.sessionId).map((message) => message.localId)).toContain('local1')
        } finally {
            engine.stop()
        }
    })

    it('rejects a child that bound a different native session', async () => {
        // MiniMax Code falls back to a blank session when it cannot load the
        // forked one. The hub has to see that and refuse the fork instead of
        // handing the user an empty thread.
        const { engine } = createEngine()
        try {
            const bound = engine.getOrCreateSession('mcode-bound', {
                path: '/tmp/project', host: 'localhost', flavor: 'mcode', mcodeSessionId: 'mvs-forked',
            }, null, 'default')
            const other = engine.getOrCreateSession('mcode-other', {
                path: '/tmp/project', host: 'localhost', flavor: 'mcode', mcodeSessionId: 'mvs-blank',
            }, null, 'default')

            expect(await (engine as any).waitForExactNativeForkBound(
                bound.id, 'mvs-forked', 'mcodeSessionId', false
            )).toBe(true)
            expect(await (engine as any).waitForExactNativeForkBound(
                other.id, 'mvs-forked', 'mcodeSessionId', false
            )).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('refuses a historical fork', async () => {
        // MiniMax Code cannot branch at a message; the only fork is the
        // current state.
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('mcode-historical', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'mcode',
                capabilities: { conversationHistory: { forkCurrent: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'hello' }, 'local1')
            store.messages.markMessagesInvoked(source.id, ['local1'], Date.now())

            const result = await engine.forkConversation(source.id, 'default', 'local1')
            expect(result).toEqual({
                type: 'error', message: 'Historical fork is not supported for this session',
            })
        } finally {
            engine.stop()
        }
    })
})
