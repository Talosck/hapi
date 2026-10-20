import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params?: unknown }>
}));

vi.mock('./AcpStdioTransport', () => {
    class MockAcpStdioTransport {
        static async create(_options: unknown) {
            return new MockAcpStdioTransport();
        }
        onNotification = vi.fn();
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
});
