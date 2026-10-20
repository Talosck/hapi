import { describe, expect, it } from 'vitest';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import {
    applyMcodePermissionMode,
    mapMcodePermissionMode,
    readMcodePermissionOption,
    resolveMcodePermissionMode
} from './permissionModes';

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

describe('resolveMcodePermissionMode', () => {
    it('prefers the plan session mode over the tool permission policy', () => {
        expect(resolveMcodePermissionMode('plan', 'bypassPermissions')).toBe('plan');
    });

    it('maps the tool permission policy when the session is not planning', () => {
        expect(resolveMcodePermissionMode('default', 'auto')).toBe('auto');
        expect(resolveMcodePermissionMode('default', 'bypassPermissions')).toBe('bypassPermissions');
        expect(resolveMcodePermissionMode('default', 'default')).toBe('default');
    });

    it('falls back to the default mode for an unknown policy', () => {
        expect(resolveMcodePermissionMode('default', null)).toBe('default');
        expect(resolveMcodePermissionMode('default', 'something-else')).toBe('default');
    });
});

describe('readMcodePermissionOption', () => {
    function createConfigBackend(options: Array<{ id: string; category?: string; currentValue?: string }>) {
        return {
            getSessionConfigOptions: () => options.map((option) => ({
                id: option.id,
                category: option.category,
                currentValue: option.currentValue,
                options: []
            })),
            getConfigOptionByCategory: (_sessionId: string, category: string) =>
                options.find((option) => option.category === category)
        } as unknown as AcpSdkBackend;
    }

    it('reads the policy the agent published', () => {
        const backend = createConfigBackend([
            { id: 'permissionMode', category: '_permission', currentValue: 'auto' }
        ]);

        expect(readMcodePermissionOption(backend, 'session-1')).toBe('auto');
    });

    it('returns null when the agent published no policy', () => {
        const backend = createConfigBackend([]);

        expect(readMcodePermissionOption(backend, 'session-1')).toBeNull();
    });
});
