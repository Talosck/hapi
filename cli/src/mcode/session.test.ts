import { describe, expect, it, vi } from 'vitest';
import { McodeSession } from './session';
import type { MessageQueue2 } from '@/utils/MessageQueue2';
import type { McodeMode } from './types';

function createSession() {
    const client = {
        keepAlive: vi.fn(),
        sendAgentMessage: vi.fn()
    };
    const session = new McodeSession({
        api: {} as never,
        client: client as never,
        path: '/tmp/mcode-test',
        logPath: '/tmp/mcode-test/test.log',
        sessionId: null,
        messageQueue: { onBatchConsumed: null } as unknown as MessageQueue2<McodeMode>,
        onModeChange: () => {},
        startedBy: 'terminal',
        startingMode: 'remote',
        permissionMode: 'default'
    });
    return { session, client };
}

describe('McodeSession context usage', () => {
    it('remembers the latest context window reported by ACP usage', () => {
        const { session, client } = createSession();
        try {
            session.sendAgentMessage({
                type: 'token_count',
                info: { contextTokens: 28_119, modelContextWindow: 512_000 }
            });
            expect(session.getLastContextUsage()).toEqual({
                contextTokens: 28_119,
                contextWindow: 512_000
            });
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
        } finally {
            session.stopKeepAlive();
        }
    });

    it('ignores non-usage and context-less messages', () => {
        const { session } = createSession();
        try {
            session.sendAgentMessage({ type: 'message', message: 'hi' });
            session.sendAgentMessage({ type: 'token_count', info: { total: { inputTokens: 10 } } });
            expect(session.getLastContextUsage()).toBeNull();
        } finally {
            session.stopKeepAlive();
        }
    });
});

describe('McodeSession repeated usage reports', () => {
    const emptyCount = {
        type: 'token_count',
        info: {
            total: { inputTokens: 0, outputTokens: 0 },
            contextTokens: 133_965
        }
    };

    it('drops a repeated count that carries no tokens', () => {
        const { session, client } = createSession();
        try {
            session.sendAgentMessage(emptyCount);
            session.sendAgentMessage(emptyCount);
            session.sendAgentMessage(emptyCount);
            // A refused turn makes the agent write a transcript line without
            // tokens in it, so the watcher reports the same count once per
            // refusal. Only the first one carries information.
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
        } finally {
            session.stopKeepAlive();
        }
    });

    it('keeps a count that carries tokens, even when it repeats', () => {
        const { session, client } = createSession();
        try {
            const count = {
                type: 'token_count',
                info: { total: { inputTokens: 12, outputTokens: 3 } }
            };
            session.sendAgentMessage(count);
            session.sendAgentMessage(count);
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(2);
        } finally {
            session.stopKeepAlive();
        }
    });

    it('keeps a first empty count that differs from the one before it', () => {
        const { session, client } = createSession();
        try {
            session.sendAgentMessage(emptyCount);
            session.sendAgentMessage({
                ...emptyCount,
                info: { ...emptyCount.info, contextTokens: 140_000 }
            });
            expect(client.sendAgentMessage).toHaveBeenCalledTimes(2);
        } finally {
            session.stopKeepAlive();
        }
    });
});
