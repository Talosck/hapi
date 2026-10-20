import { describe, expect, it } from 'vitest';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { applyMcodePermissionMode, mapMcodePermissionMode } from './permissionModes';

function createBackend() {
    const calls: string[] = [];
    const backend = {
        getConfigOptionByCategory: (_sessionId: string, category: string) => {
            calls.push(`lookup:${category}`);
            return { id: 'permissionMode', currentValue: 'default', options: [] };
        },
        setSessionMode: async (_sessionId: string, mode: string) => {
            calls.push(`mode:${mode}`);
        },
        setConfigOption: async (_sessionId: string, id: string, value: string) => {
            calls.push(`config:${id}:${value}`);
        }
    } as unknown as AcpSdkBackend;
    return { backend, calls };
}

describe('mapMcodePermissionMode', () => {
    it('maps the HAPI modes onto the agent permission policy', () => {
        expect(mapMcodePermissionMode('default'))
            .toEqual({ permissionOption: 'default', sessionMode: 'default' });
        expect(mapMcodePermissionMode('auto'))
            .toEqual({ permissionOption: 'auto', sessionMode: 'default' });
        expect(mapMcodePermissionMode('bypassPermissions'))
            .toEqual({ permissionOption: 'bypassPermissions', sessionMode: 'default' });
    });

    it('maps plan onto the ACP session mode and keeps asking for tool approval', () => {
        expect(mapMcodePermissionMode('plan'))
            .toEqual({ permissionOption: 'default', sessionMode: 'plan' });
    });

    it('falls back to the default policy for an unknown mode', () => {
        expect(mapMcodePermissionMode(undefined))
            .toEqual({ permissionOption: 'default', sessionMode: 'default' });
    });
});

describe('applyMcodePermissionMode', () => {
    it('applies the session mode before the process permission policy', async () => {
        const { backend, calls } = createBackend();

        await applyMcodePermissionMode(backend, 'session-1', 'plan');

        expect(calls).toEqual([
            'mode:plan',
            'lookup:_permission',
            'config:permissionMode:default'
        ]);
    });

    it('does not touch the permission policy when the session mode is rejected', async () => {
        const calls: string[] = [];
        const backend = {
            getConfigOptionByCategory: () => {
                calls.push('lookup');
                return { id: 'permissionMode', currentValue: 'default', options: [] };
            },
            setSessionMode: async () => {
                calls.push('mode');
                throw new Error('Unsupported Session mode');
            },
            setConfigOption: async () => {
                calls.push('config');
            }
        } as unknown as AcpSdkBackend;

        await expect(applyMcodePermissionMode(backend, 'session-1', 'plan'))
            .rejects.toThrow('Unsupported Session mode');
        expect(calls).toEqual(['mode']);
    });
});
