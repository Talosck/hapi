import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgentBackend, PermissionRequest } from '@/agent/types';
import type { AgentState } from '@/api/types';
import { AcpPermissionHandler, type AcpPermissionResponseMessage } from './AcpPermissionHandler';

describe('AcpPermissionHandler missing-response hook', () => {
    it('routes responses without a pending ACP permission to the hook', async () => {
        let permissionRpc: ((response: AcpPermissionResponseMessage) => Promise<void>) | null = null;
        let state: AgentState = { requests: {}, completedRequests: {} };

        const client = {
            rpcHandlerManager: {
                registerHandler(method: string, handler: (response: AcpPermissionResponseMessage) => Promise<void>) {
                    if (method === RPC_METHODS.Permission) {
                        permissionRpc = handler;
                    }
                }
            },
            updateAgentState(handler: (current: AgentState) => AgentState) {
                state = handler(state);
            }
        };

        const backend = {
            onPermissionRequest: vi.fn(),
            respondToPermission: vi.fn(async () => {})
        } as unknown as AgentBackend;

        const handleMissingResponse = vi.fn(async () => true);
        new AcpPermissionHandler(
            client as never,
            backend,
            () => 'default',
            { handleMissingResponse }
        );

        const response: AcpPermissionResponseMessage = {
            id: 'ask-user-1',
            approved: true,
            answers: { '0': ['Alpha'] }
        };

        await permissionRpc!(response);

        expect(handleMissingResponse).toHaveBeenCalledWith(response);
        expect(backend.respondToPermission).not.toHaveBeenCalled();
        expect(state).toEqual({ requests: {}, completedRequests: {} });
    });
});

describe('AcpPermissionHandler cancelAll', () => {
    it('cancels only the requests it registered', async () => {
        let state: AgentState = { requests: {}, completedRequests: {} };
        let onPermissionRequest: ((request: PermissionRequest) => void) | null = null;

        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState(handler: (current: AgentState) => AgentState) {
                state = handler(state);
            }
        };

        const backend = {
            onPermissionRequest: vi.fn((handler: (request: PermissionRequest) => void) => {
                onPermissionRequest = handler;
            }),
            respondToPermission: vi.fn(async () => {})
        } as unknown as AgentBackend;

        const handler = new AcpPermissionHandler(
            client as never,
            backend,
            () => 'default'
        );

        onPermissionRequest!({
            id: 'acp-request-1',
            sessionId: 'acp-session-1',
            toolCallId: 'call-1',
            title: 'Bash',
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
        });

        // Another subsystem publishes its own request into the same map: the
        // session's request map is shared, and this request is not turn-scoped.
        client.updateAgentState((current) => ({
            ...current,
            requests: {
                ...current.requests,
                'question-1': { tool: 'ask_user_question', arguments: {}, createdAt: 1 }
            }
        }));

        await handler.cancelAll('Prompt finished');

        expect(state.requests?.['acp-request-1']).toBeUndefined();
        expect(state.completedRequests?.['acp-request-1']).toMatchObject({
            status: 'canceled',
            reason: 'Prompt finished'
        });
        expect(state.requests?.['question-1']).toBeDefined();
        expect(state.completedRequests?.['question-1']).toBeUndefined();
    });
});
