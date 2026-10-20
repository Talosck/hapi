import { describe, expect, it } from 'vitest';
import { mapMcodePermissionMode } from './permissionModes';

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
