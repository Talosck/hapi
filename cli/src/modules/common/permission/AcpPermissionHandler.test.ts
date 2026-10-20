import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgentBackend } from '@/agent/types';
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
