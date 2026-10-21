import { describe, expect, it, vi } from 'vitest';
import { McodeConversationHistory } from './conversationHistory';

type FakeBackend = {
    supportsSessionFork: ReturnType<typeof vi.fn>;
    sendExtensionRequest: ReturnType<typeof vi.fn>;
};

function createBackend(overrides?: Partial<FakeBackend>) {
    const backend: FakeBackend = {
        supportsSessionFork: vi.fn(() => true),
        sendExtensionRequest: vi.fn(async () => ({ sessionId: 'mvs_forked_1' })),
        ...overrides
    };
    return backend;
}

function createHistory(backend: FakeBackend) {
    const history = new McodeConversationHistory(() => backend as never);
    history.setSession('mvs_source_1', '/tmp/project');
    return history;
}

describe('McodeConversationHistory capability probe', () => {
    it('enables forkCurrent when the agent advertises session/fork', async () => {
        const backend = createBackend();
        const history = createHistory(backend);

        await history.probeCapabilities();

        expect(history.getCapabilityStates().forkCurrent).toBe('supported');
        expect(history.getCapabilitiesForMetadata()).toEqual({
            conversationHistory: { forkCurrent: true, forkAtMessage: false, rewindToMessage: false }
        });
    });

    it('disables forkCurrent when the agent does not advertise session/fork', async () => {
        const backend = createBackend({ supportsSessionFork: vi.fn(() => false) });
        const history = createHistory(backend);

        await history.probeCapabilities();

        expect(history.getCapabilityStates().forkCurrent).toBe('unsupported');
        // Explicit false, so a session that ran an older agent build cannot
        // keep a stale "fork supported" in its metadata.
        expect(history.getCapabilitiesForMetadata()).toEqual({
            conversationHistory: { forkCurrent: false, forkAtMessage: false, rewindToMessage: false }
        });
    });

    it('never offers a historical fork or a rewind', async () => {
        // MiniMax Code's session/fork takes the same parameters as
        // session/load - there is no branch at a message and no rewind.
        const history = createHistory(createBackend());

        await history.probeCapabilities();

        expect(history.getCapabilityStates().forkAtMessage).toBe('unsupported');
        expect(history.getCapabilityStates().rewindToMessage).toBe('unsupported');
    });

    it('publishes the capabilities when they change', async () => {
        const backend = createBackend();
        const history = createHistory(backend);
        const publish = vi.fn(async () => {});
        history.setPublishCapabilities(publish);

        await history.probeCapabilities();

        expect(publish).toHaveBeenCalledTimes(1);
    });
});

describe('McodeConversationHistory fork', () => {
    it('forks the session and returns the new native session id', async () => {
        const backend = createBackend();
        const history = createHistory(backend);

        const result = await history.fork();

        expect(backend.sendExtensionRequest).toHaveBeenCalledWith('session/fork', {
            sessionId: 'mvs_source_1',
            cwd: '/tmp/project',
            mcpServers: []
        });
        expect(result).toEqual({ nativeSessionId: 'mvs_forked_1' });
    });

    it('refuses a fork at a message instead of forking the current state', async () => {
        // A fork at a message is not a thing MiniMax Code can do. Silently
        // answering with a fork of the current state would hand the user a
        // different conversation than they asked for.
        const backend = createBackend();
        const history = createHistory(backend);

        await expect(history.fork('local-1')).rejects.toThrow('Historical fork is not supported');
        expect(backend.sendExtensionRequest).not.toHaveBeenCalled();
    });

    it('fails when the agent does not return a session id', async () => {
        const backend = createBackend({ sendExtensionRequest: vi.fn(async () => ({})) });
        const history = createHistory(backend);

        await expect(history.fork()).rejects.toThrow('did not return a session id');
    });

    it('marks the capability unsupported when the agent has no session/fork', async () => {
        const backend = createBackend({
            sendExtensionRequest: vi.fn(async () => {
                throw new Error('Method not found');
            })
        });
        const history = createHistory(backend);

        await expect(history.fork()).rejects.toThrow('Method not found');
        expect(history.getCapabilityStates().forkCurrent).toBe('unsupported');
    });

    it('refuses to fork while the agent is working on a turn', async () => {
        // The agent forks at the latest message boundary, and that boundary
        // only exists once a turn has ended.
        const backend = createBackend();
        const history = createHistory(backend);
        history.setBusy(true);

        await expect(history.fork()).rejects.toThrow('still working on a turn');
        expect(backend.sendExtensionRequest).not.toHaveBeenCalled();
    });

    it('explains the agent boundary error instead of leaking the protocol code', async () => {
        const backend = createBackend({
            sendExtensionRequest: vi.fn(async () => {
                throw new Error('Invalid params: message-boundary-not-found');
            })
        });
        const history = createHistory(backend);

        await expect(history.fork()).rejects.toThrow('only fork at the end of a finished turn');
    });

    it('refuses to fork before the session is ready', async () => {
        const backend = createBackend();
        const history = new McodeConversationHistory(() => backend as never);

        await expect(history.fork()).rejects.toThrow('not ready');
    });

    it('never calls a fork method the agent did not advertise', async () => {
        // The agent did not advertise session/fork, so the method must not be
        // called at all.
        const backend = createBackend({ supportsSessionFork: vi.fn(() => false) });
        const history = createHistory(backend);
        await history.probeCapabilities();

        await expect(history.fork()).rejects.toThrow('does not support forking');
        expect(backend.sendExtensionRequest).not.toHaveBeenCalled();
    });
});
