import { describe, expect, it } from 'vitest';
import { authHintForFlavor, authenticationFailedMessage } from './acpAuthHint';

describe('acpAuthHint', () => {
    it('names the login command of the agent that failed', () => {
        expect(authHintForFlavor('mcode')).toBe('run "mcode login" on the machine');
        expect(authHintForFlavor('gemini')).toBe('run "gemini auth login"');
    });

    it('has no hint for an agent without a known login command', () => {
        expect(authHintForFlavor('codex')).toBeNull();
        expect(authHintForFlavor(undefined)).toBeNull();
    });

    it('never sends a MiniMax Code user to the Gemini CLI', () => {
        const message = authenticationFailedMessage('mcode');
        expect(message).toContain('mcode login');
        expect(message).not.toContain('gemini');
    });

    it('keeps the message plain when the agent is unknown', () => {
        expect(authenticationFailedMessage('codex')).toBe('Authentication failed. Please check your credentials.');
    });
});
