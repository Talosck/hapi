import { describe, expect, it } from 'vitest';
import { parseMcodeCommandOptions } from './mcode';

describe('parseMcodeCommandOptions', () => {
    it('parses the launch controls HAPI passes to the runner', () => {
        expect(parseMcodeCommandOptions([
            '--started-by', 'runner',
            '--hapi-starting-mode', 'remote',
            '--hapi-session-id', 'reserved-id',
            '--model', 'm:minimax:MiniMax-M3:v:thinking'
        ])).toEqual({
            startedBy: 'runner',
            startingMode: 'remote',
            reservedSessionId: 'reserved-id',
            model: 'm:minimax:MiniMax-M3:v:thinking'
        });
    });

    it('maps --yolo onto MiniMax Code full access', () => {
        expect(parseMcodeCommandOptions(['--yolo']).permissionMode).toBe('bypassPermissions');
    });

    it('maps --plan onto the MiniMax Code plan session mode', () => {
        expect(parseMcodeCommandOptions(['--plan']).permissionMode).toBe('plan');
    });

    it('lets an explicit permission mode win over the shortcuts', () => {
        expect(parseMcodeCommandOptions(['--yolo', '--permission-mode', 'auto']).permissionMode).toBe('auto');
        expect(parseMcodeCommandOptions(['--permission-mode', 'auto', '--yolo']).permissionMode).toBe('auto');
    });

    it('rejects permission modes MiniMax Code does not expose', () => {
        expect(() => parseMcodeCommandOptions(['--permission-mode', 'read-only']))
            .toThrow('Invalid --permission-mode value');
        expect(() => parseMcodeCommandOptions(['--permission-mode', 'safe-yolo']))
            .toThrow('Invalid --permission-mode value');
    });

    it('rejects an unsupported starting mode', () => {
        expect(() => parseMcodeCommandOptions(['--hapi-starting-mode', 'pty']))
            .toThrow('Invalid --hapi-starting-mode');
    });

    it('keeps an explicit reopen distinct from the fresh-spawn stub', () => {
        expect(parseMcodeCommandOptions(['--existing-session-id', 'existing'])).toEqual({
            existingSessionId: 'existing'
        });
    });
});
