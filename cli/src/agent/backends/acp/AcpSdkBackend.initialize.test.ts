import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown }>,
    notificationHandler: null as null | ((method: string, params: unknown) => void)
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn((handler: (method: string, params: unknown) => void) => {
            transportState.notificationHandler = handler;
        });
        onStderrError = vi.fn();
        registerRequestHandler = vi.fn();
        sendRequest = vi.fn(async (method: string, params?: unknown) => {
            transportState.calls.push({ method, params });
            if (method === 'initialize') {
                return { protocolVersion: 1, authMethods: [] };
            }
            return null;
        });
        close = vi.fn(async () => {});
    }
    return { AcpStdioTransport: MockAcpStdioTransport };
});

import { AcpSdkBackend } from './AcpSdkBackend';

describe('AcpSdkBackend.initialize', () => {
    beforeEach(() => {
        transportState.calls.length = 0;
        transportState.notificationHandler = null;
    });

    it('advertises Cursor-compatible parameterized model picker support', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });

        await backend.initialize();

        expect(transportState.calls).toContainEqual({
            method: 'initialize',
            params: expect.objectContaining({
                clientCapabilities: expect.objectContaining({
                    _meta: expect.objectContaining({
                        parameterizedModelPicker: true
                    })
                })
            })
        });
    });

    it('advertises ACP form elicitation only when the backend opts in', async () => {
        const backend = new AcpSdkBackend({
            command: 'agent',
            args: ['acp'],
            elicitation: { form: true }
        });

        await backend.initialize();

        expect(transportState.calls).toContainEqual({
            method: 'initialize',
            params: expect.objectContaining({
                clientCapabilities: expect.objectContaining({
                    elicitation: { form: {} }
                })
            })
        });
    });

    it('advertises the agent-specific capability metadata the backend opts into', async () => {
        const backend = new AcpSdkBackend({
            command: 'agent',
            args: ['acp'],
            clientCapabilityMeta: { 'minimax-code/extensions': { version: 1, notifications: true } }
        });

        await backend.initialize();

        expect(transportState.calls).toContainEqual({
            method: 'initialize',
            params: expect.objectContaining({
                clientCapabilities: expect.objectContaining({
                    _meta: expect.objectContaining({
                        parameterizedModelPicker: true,
                        'minimax-code/extensions': { version: 1, notifications: true }
                    })
                })
            })
        });
    });

    it('does not advertise elicitation by default', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });

        await backend.initialize();

        const initialize = transportState.calls.find((call) => call.method === 'initialize');
        const capabilities = (initialize?.params as {
            clientCapabilities?: Record<string, unknown>;
        } | undefined)?.clientCapabilities;

        expect(capabilities).toBeDefined();
        expect(capabilities).not.toHaveProperty('elicitation');
    });

    it('forwards agent-specific notifications to the extension listener', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        const listener = vi.fn();
        backend.setExtensionNotificationListener(listener);

        await backend.initialize();

        transportState.notificationHandler?.('mcode/session/delegation_update', { sessionId: 's1' });

        expect(listener).toHaveBeenCalledWith('mcode/session/delegation_update', { sessionId: 's1' });
    });

    it('does not forward session updates to the extension listener', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });
        const listener = vi.fn();
        backend.setExtensionNotificationListener(listener);

        await backend.initialize();

        transportState.notificationHandler?.('session/update', { sessionId: 's1', update: {} });

        expect(listener).not.toHaveBeenCalled();
    });

    it('advertises the plan capability only when the backend opts in', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'], plan: true });

        await backend.initialize();

        expect(transportState.calls).toContainEqual({
            method: 'initialize',
            params: expect.objectContaining({
                clientCapabilities: expect.objectContaining({
                    plan: {}
                })
            })
        });
    });

    it('does not advertise the plan capability by default', async () => {
        const backend = new AcpSdkBackend({ command: 'agent', args: ['acp'] });

        await backend.initialize();

        const initialize = transportState.calls.find((call) => call.method === 'initialize');
        const capabilities = (initialize?.params as {
            clientCapabilities?: Record<string, unknown>;
        } | undefined)?.clientCapabilities;

        expect(capabilities).toBeDefined();
        expect(capabilities).not.toHaveProperty('plan');
    });
});
