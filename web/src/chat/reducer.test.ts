import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import { reconcileChatBlocks } from './reconcile'
import { normalizeDecryptedMessage } from './normalize'
import type { NormalizedMessage } from './types'
import type { DecryptedMessage } from '@/types/api'
import type { AgentState, ThreadGoal, ThreadGoalStatus } from '@/types/api'

function userMessage(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false
    }
}

function goalMessage(id: string, status: ThreadGoalStatus, createdAt: number): NormalizedMessage {
    const goal: ThreadGoal = {
        threadId: 'thread-1',
        objective: 'ship goal support',
        status,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt,
        updatedAt: createdAt
    }
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: {
            type: 'thread-goal-updated',
            threadId: 'thread-1',
            goal
        },
        isSidechain: false
    }
}

function goalClearedMessage(id: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: {
            type: 'thread-goal-cleared',
            threadId: 'thread-1'
        },
        isSidechain: false
    }
}

function eventMessage(id: string, message: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: {
            type: 'message',
            message
        },
        isSidechain: false
    }
}

function decryptedMessage(id: string, content: unknown, createdAt: number): DecryptedMessage {
    return {
        id,
        seq: 1,
        localId: null,
        content,
        createdAt
    }
}

describe('reduceChatBlocks', () => {
    it('renders Codex proposed plan tool messages as a completed plan card', () => {
        const plan = '# Plan\n\n1. Inspect\n2. Implement'
        const messages = [
            decryptedMessage('plan-call', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        name: 'ExitPlanMode',
                        callId: 'codex-proposed-plan:plan-1',
                        input: { plan },
                        id: 'plan-1'
                    }
                }
            }, 1),
            decryptedMessage('plan-result', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'codex-proposed-plan:plan-1',
                        output: null,
                        id: 'plan-1:result'
                    }
                }
            }, 2)
        ].map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toContainEqual(expect.objectContaining({
            kind: 'tool-call',
            id: 'codex-proposed-plan:plan-1',
            tool: expect.objectContaining({
                name: 'ExitPlanMode',
                state: 'completed',
                input: { plan },
                result: null
            })
        }))
    })

    it('drops the plan card the agent withdrew', () => {
        const planDocument = decryptedMessage('plan-doc', {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan-document',
                    planId: 'plan-1',
                    format: 'markdown',
                    content: '# Plan\n\n1. Do it'
                }
            }
        }, 1)
        const planRemoved = decryptedMessage('plan-removed', {
            role: 'agent',
            content: {
                id: 'event-1',
                type: 'event',
                data: { type: 'plan-removed', planId: 'plan-1' }
            }
        }, 2)

        const withPlan = [planDocument]
            .map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)
        expect(reduceChatBlocks(withPlan, null).blocks).toContainEqual(expect.objectContaining({
            kind: 'tool-call',
            id: 'plan-document:plan-1'
        }))

        const messages = [planDocument, planRemoved]
            .map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).not.toContainEqual(expect.objectContaining({
            kind: 'tool-call',
            id: 'plan-document:plan-1'
        }))
    })

    it('takes the question definition from the question request', () => {
        // The tool call only carries the questions; the request carries the
        // agent's own definition, including which questions may be skipped.
        const messages = [
            decryptedMessage('question-call', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        callId: 'call-question-1',
                        name: 'ask_user_question',
                        input: {
                            questions: [{
                                question: 'Which one?',
                                options: [{ label: 'Alpha', description: null }],
                                multiSelect: false
                            }]
                        }
                    }
                }
            }, 1)
        ].map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const agentState = {
            requests: {
                'request-1': {
                    tool: 'ask_user_question',
                    toolCallId: 'call-question-1',
                    arguments: {
                        questions: [{
                            question: 'Which one?',
                            options: [{ label: 'Alpha', description: null }],
                            multiSelect: false,
                            required: false
                        }]
                    },
                    createdAt: 2
                }
            },
            completedRequests: {}
        } as unknown as Parameters<typeof reduceChatBlocks>[1]

        const reduced = reduceChatBlocks(messages, agentState)

        expect(reduced.blocks).toContainEqual(expect.objectContaining({
            kind: 'tool-call',
            id: 'call-question-1',
            tool: expect.objectContaining({
                input: {
                    questions: [expect.objectContaining({ required: false })]
                }
            })
        }))
    })

    it('keeps a plan card the agent did not withdraw', () => {        const messages = [
            decryptedMessage('plan-doc', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'plan-document',
                        planId: 'plan-1',
                        format: 'markdown',
                        content: '# Plan\n\n1. Do it'
                    }
                }
            }, 1),
            decryptedMessage('other-plan-removed', {
                role: 'agent',
                content: {
                    id: 'event-2',
                    type: 'event',
                    data: { type: 'plan-removed', planId: 'plan-2' }
                }
            }, 2)
        ].map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toContainEqual(expect.objectContaining({
            kind: 'tool-call',
            id: 'plan-document:plan-1'
        }))
    })

    it('ignores child agent usage when calculating parent latest usage', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'parent-usage',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    context_tokens: 100,
                    scope_role: 'parent'
                }
            },
            {
                id: 'child-usage',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 999,
                    output_tokens: 1,
                    context_tokens: 999,
                    scope_role: 'child'
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            inputTokens: 100,
            outputTokens: 10,
            contextSize: 100
        })
    })

    it('does not count the cache twice for an inclusive usage payload', () => {
        // The generic usage envelope reports an inclusive input: the uncached
        // prompt plus the cache hits. Adding the cache again would report a
        // context larger than the window.
        const messages: NormalizedMessage[] = [
            {
                id: 'inclusive-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 19_837,
                    output_tokens: 101,
                    cache_read_input_tokens: 19_349,
                    input_includes_cache: true
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 19_837,
            cacheRead: 19_349
        })
    })

    it('ignores Claude subagent usage when calculating parent latest usage', () => {
        // Claude never stamps scope_role, so a Task subagent's assistant
        // messages look like ordinary parent usage apart from isSidechain.
        // Letting them through made the status bar's ctx numerator collapse
        // while a subagent ran and snap back when the parent resumed.
        const messages: NormalizedMessage[] = [
            {
                id: 'parent-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 500,
                    output_tokens: 20,
                    cache_read_input_tokens: 120_000,
                    context_window: 200_000
                }
            },
            {
                id: 'subagent-turn',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'agent',
                content: [],
                isSidechain: true,
                parentToolUseId: 'tc-task-1',
                usage: {
                    input_tokens: 300,
                    output_tokens: 5,
                    cache_read_input_tokens: 8_000,
                    context_window: 200_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            inputTokens: 500,
            outputTokens: 20,
            cacheRead: 120_000,
            contextSize: 120_500
        })
    })

    it('carries the usage message model for the context-window heuristic', () => {
        // Local-mode Claude transcripts have no context_window in usage and
        // session.model is often null, so latestUsage.model is the only
        // signal the status bar has to resolve a plausible window.
        const messages: NormalizedMessage[] = [
            {
                id: 'local-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                model: 'claude-fable-5',
                usage: {
                    input_tokens: 2,
                    output_tokens: 50,
                    cache_read_input_tokens: 250_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 250_002,
            contextWindow: null,
            model: 'claude-fable-5'
        })
    })

    it('keeps the last measured context when a later usage sample reports no tokens', () => {
        // Some Anthropic-compatible providers answer with an all-zero usage
        // block. The reducer picks the newest usage message, so such a sample
        // used to overwrite the measured context with 0 and the status bar
        // showed "0% · 0 / 1M" for a session that was actually half full.
        const messages: NormalizedMessage[] = [
            {
                id: 'measured-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 210,
                    output_tokens: 98,
                    cache_read_input_tokens: 47_142,
                    context_window: 1_000_000
                }
            },
            {
                id: 'zero-turn',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_window: 1_000_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 47_352,
            cacheRead: 47_142
        })
    })

    it('takes the window of the model the session was on when it switched models', () => {
        // A session that switched models carries the window of both. The
        // measurement has to be read against the window of the model it was
        // on, not the one it left.
        const messages: NormalizedMessage[] = [
            {
                id: 'old-model-frame',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_window: 200_000
                }
            },
            {
                id: 'new-model-frame',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_window: 1_000_000
                }
            },
            {
                id: 'turn-summary',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: {
                    type: 'turn-summary',
                    summary: {
                        usage: {
                            input_tokens: 2_023,
                            output_tokens: 1_312,
                            cache_read_input_tokens: 1_183_507
                        },
                        modelUsage: {},
                        totalCostUsd: 13.44,
                        numTurns: 8,
                        durationMs: 46_731
                    }
                },
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage?.contextWindow).toBe(1_000_000)
    })

    it('keeps the last measured usage when a turn reports no tokens', () => {
        // A provider that answers with an all-zero usage block must not wipe
        // the measurement a previous turn made.
        const messages: NormalizedMessage[] = [
            {
                id: 'measured-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 210,
                    output_tokens: 98,
                    cache_read_input_tokens: 47_142,
                    context_window: 1_000_000
                }
            },
            {
                id: 'empty-turn-summary',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'turn-summary',
                    summary: {
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0
                        },
                        modelUsage: {}
                    }
                },
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 47_352,
            source: 'frame'
        })
    })

    it('takes the usage of a Claude turn from the round summary when the assistant frame reports none', () => {
        // Claude's remote (SDK) path reports an all-zero usage block on every
        // assistant frame and carries the real numbers only on the turn's
        // result frame, which reaches the web as a turn-summary event. The
        // status bar reads latestUsage, so the round summary has to feed it.
        const messages: NormalizedMessage[] = [
            {
                id: 'assistant-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_window: 1_000_000
                }
            },
            {
                id: 'turn-summary',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'turn-summary',
                    summary: {
                        usage: {
                            input_tokens: 2_023,
                            output_tokens: 1_312,
                            cache_read_input_tokens: 1_183_507,
                            cache_creation_input_tokens: 0
                        },
                        modelUsage: {},
                        totalCostUsd: 13.44,
                        numTurns: 8,
                        durationMs: 46_731
                    }
                },
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 1_185_530,
            cacheRead: 1_183_507,
            contextWindow: 1_000_000
        })
    })

    it('does not adopt an all-zero usage sample as the latest usage', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'zero-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_window: 1_000_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toBeNull()
    })

    it('keeps a context-only usage sample that reports a real context size', () => {
        // The post-compaction refresh carries the boundary's post-tokens in
        // context_tokens while its own input/output counts stay zero. That is
        // a real measurement, so it must still replace the previous one.
        const messages: NormalizedMessage[] = [
            {
                id: 'measured-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 210,
                    output_tokens: 98,
                    cache_read_input_tokens: 47_142,
                    context_window: 1_000_000
                }
            },
            {
                id: 'compact-turn',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_tokens: 13_681,
                    context_window: 1_000_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 13_681
        })
    })

    it('keeps active goals visible across later normal user messages', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1),
            userMessage('user-later', 'continue working', 2)
        ], null)

        expect(reduced.latestGoal).toMatchObject({
            status: 'active',
            objective: 'ship goal support'
        })
    })

    it('keeps a completed goal visible when it is the latest relevant event', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1)
        ], null)

        expect(reduced.latestGoal).toMatchObject({
            status: 'complete',
            objective: 'ship goal support'
        })
    })

    it('hides a completed goal after a later non-goal user message', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1),
            userMessage('user-later', 'start a new task', 2)
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })

    it('can clear completed goal state using messages hidden from the rendered timeline', () => {
        const renderedMessages = [
            goalMessage('goal-complete', 'complete', 1)
        ]
        const goalStateMessages = [
            ...renderedMessages,
            userMessage('queued-user-later', 'start a new task', 2)
        ]

        const reduced = reduceChatBlocks(renderedMessages, null, { goalStateMessages })

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toBeNull()
    })

    it('keeps the goal of another thread when a scoped clear names one thread', () => {
        // A clear event that names a thread only takes that thread's goal.
        const otherThread = goalMessage('goal-other', 'active', 3)
        const otherGoal = (otherThread.content as { goal: ThreadGoal }).goal
        otherThread.content = {
            type: 'thread-goal-updated',
            threadId: 'thread-2',
            goal: { ...otherGoal, threadId: 'thread-2' }
        }

        const reduced = reduceChatBlocks([
            goalMessage('goal-one', 'active', 1),
            otherThread,
            goalClearedMessage('goal-cleared', 4)
        ], null)

        expect(reduced.latestGoal).toMatchObject({ threadId: 'thread-2' })
    })

    it('clears the goal when the clear event names no thread', () => {
        const cleared = goalClearedMessage('goal-cleared', 4)
        cleared.content = { type: 'thread-goal-cleared' }

        const reduced = reduceChatBlocks([
            goalMessage('goal-one', 'active', 1),
            cleared
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })

    it('does not treat later goal slash commands as non-goal activity', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1),
            userMessage('user-later', '/goal', 2)
        ], null)

        expect(reduced.latestGoal).toMatchObject({
            status: 'complete'
        })
    })

    it('treats slash commands with a goal prefix as non-goal activity', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1),
            userMessage('user-later', '/goal-foo', 2)
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })

    it('clears latest goal after an explicit goal clear event', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1),
            goalClearedMessage('goal-cleared', 2)
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })

    it('uses goal events for latest goal state without rendering timeline prompts', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1)
        ], null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toMatchObject({
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active'
        })
    })

    it('keeps a delegation snapshot out of the timeline', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'snapshot-1',
                localId: null,
                createdAt: 1,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'subagent-snapshot',
                    members: [{
                        id: 'child-1',
                        parentId: null,
                        title: 'Explore',
                        detail: null,
                        status: 'running',
                        startedAt: 1,
                        endedAt: null,
                        depth: 0
                    }]
                }
            }
        ], null)

        expect(reduced.blocks).toHaveLength(0)
    })

    it('uses goal clear events to clear latest goal without rendering timeline prompts', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1),
            goalClearedMessage('goal-cleared', 2)
        ], null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toBeNull()
    })

    it('hides redundant goal status messages but keeps actionable goal messages', () => {
        const reduced = reduceChatBlocks([
            eventMessage('goal-active-message', 'Goal active', 1),
            eventMessage('goal-active-usage-message', 'Goal active · 181737 tokens', 2),
            eventMessage('goal-complete-message', 'Goal complete', 3),
            eventMessage('goal-cleared-message', 'Goal cleared', 4),
            eventMessage('goal-actionable-message', 'No goal to clear', 5)
        ], null)

        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'agent-event',
            event: { type: 'message', message: 'No goal to clear' }
        })
    })

    it('hides persisted goal status event envelopes alongside structured goal events', () => {
        const goal: ThreadGoal = {
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 8016,
            timeUsedSeconds: 10,
            createdAt: 1,
            updatedAt: 2
        }
        const normalized = [
            decryptedMessage('goal-status-envelope', {
                role: 'agent',
                content: {
                    id: 'event-1',
                    type: 'event',
                    data: { type: 'message', message: 'Goal active · 8016 tokens' }
                }
            }, 1),
            decryptedMessage('goal-structured-envelope', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'thread_goal_updated',
                        thread_id: 'thread-1',
                        goal
                    }
                }
            }, 2)
        ].map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const reduced = reduceChatBlocks(normalized, null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toMatchObject({
            threadId: 'thread-1',
            status: 'active',
            tokensUsed: 8016
        })
    })

    it('does not pin a resolved request as a bottom card when its message is not in the window', () => {
        // agentState keeps completedRequests after an ask is answered. With no
        // tool_use message loaded for it, the permission-only synthesis used to
        // append an "answered" card at the end of the timeline (no re-sort),
        // pinning it above the composer forever.
        const messages = [userMessage('u1', 'hello', 1_700_000_000_000)]
        const agentState = {
            requests: {},
            completedRequests: {
                'ask-done': {
                    tool: 'AskUserQuestion',
                    arguments: { questions: [] },
                    status: 'approved',
                    createdAt: 1_700_000_000_500,
                    completedAt: 1_700_000_000_600
                }
            }
        } as unknown as AgentState

        const reduced = reduceChatBlocks(messages, agentState)
        expect(reduced.blocks.some(b => b.kind === 'tool-call' && b.id === 'ask-done')).toBe(false)
    })

    it('still synthesizes a card for a pending request with no message in the window', () => {
        const messages = [userMessage('u1', 'hello', 1_700_000_000_000)]
        const agentState = {
            requests: {
                'ask-pending': { tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 1_700_000_000_500 }
            },
            completedRequests: {}
        } as unknown as AgentState

        const reduced = reduceChatBlocks(messages, agentState)
        const block = reduced.blocks.find(b => b.kind === 'tool-call' && b.id === 'ask-pending')
        expect(block).toBeDefined()
        expect(block?.kind === 'tool-call' ? block.tool.permission?.status : null).toBe('pending')
    })

    it('synthesizes a card for a pending permission whose sidechain tool_use was dropped by the tracer', () => {
        // Regression (hapi#1073): background subagents arrive with no
        // parentToolUseId and no prompt-holding sidechain root, so the tracer
        // cannot attribute the chain to its parent Task and drops it as
        // orphans. The raw transcript still contains the tool_use id, which
        // used to suppress the orphan fallback — leaving the request pending
        // in agentState with no answerable card anywhere.
        const messages: NormalizedMessage[] = [
            userMessage('u1', 'hello', 1_700_000_000_000),
            {
                id: 'agent-tool', localId: null, createdAt: 1_700_000_000_100, role: 'agent', isSidechain: false,
                content: [{
                    type: 'tool-call', id: 'toolu-task-1', name: 'Agent',
                    input: { prompt: 'research a topic', subagent_type: 'general-purpose' },
                    description: null, uuid: 'root-uuid-1', parentUUID: null
                }]
            },
            {
                id: 'sidechain-call', localId: null, createdAt: 1_700_000_000_200, role: 'agent', isSidechain: true,
                parentToolUseId: null,
                content: [{
                    type: 'tool-call', id: 'toolu-sub-1', name: 'WebFetch',
                    input: { url: 'https://example.com', prompt: 'summarize' },
                    description: null, uuid: 'side-uuid-2', parentUUID: 'side-uuid-1'
                }]
            }
        ]
        const agentState = {
            requests: {
                'toolu-sub-1': {
                    tool: 'WebFetch',
                    arguments: { url: 'https://example.com', prompt: 'summarize' },
                    createdAt: 1_700_000_000_200
                }
            },
            completedRequests: {}
        } as unknown as AgentState

        const reduced = reduceChatBlocks(messages, agentState)
        const block = reduced.blocks.find(b => b.kind === 'tool-call' && b.id === 'toolu-sub-1')
        expect(block).toBeDefined()
        expect(block?.kind === 'tool-call' ? block.tool.permission?.status : null).toBe('pending')
    })

    it('does not duplicate a pending permission card when its sidechain tool_use renders nested', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'agent-tool', localId: null, createdAt: 1_700_000_000_100, role: 'agent', isSidechain: false,
                content: [{
                    type: 'tool-call', id: 'toolu-task-1', name: 'Agent',
                    input: { prompt: 'inspect the code', subagent_type: 'general-purpose' },
                    description: null, uuid: 'root-uuid-1', parentUUID: null
                }]
            },
            {
                id: 'sidechain-call', localId: null, createdAt: 1_700_000_000_200, role: 'agent', isSidechain: true,
                parentToolUseId: 'toolu-task-1',
                content: [{
                    type: 'tool-call', id: 'toolu-sub-2', name: 'WebFetch',
                    input: { url: 'https://example.com', prompt: 'summarize' },
                    description: null, uuid: 'side-uuid-1', parentUUID: null
                }]
            }
        ]
        const agentState = {
            requests: {
                'toolu-sub-2': {
                    tool: 'WebFetch',
                    arguments: { url: 'https://example.com', prompt: 'summarize' },
                    createdAt: 1_700_000_000_200
                }
            },
            completedRequests: {}
        } as unknown as AgentState

        const reduced = reduceChatBlocks(messages, agentState)

        const countBlocksWithId = (list: typeof reduced.blocks, id: string): number =>
            list.reduce((count, block) => {
                const self = block.kind === 'tool-call' && block.id === id ? 1 : 0
                const nested = block.kind === 'tool-call' ? countBlocksWithId(block.children, id) : 0
                return count + self + nested
            }, 0)
        expect(countBlocksWithId(reduced.blocks, 'toolu-sub-2')).toBe(1)

        // The single card must be nested under the Agent card, not a root-level orphan.
        const agentCard = reduced.blocks.find(b => b.kind === 'tool-call' && b.id === 'toolu-task-1')
        expect(
            agentCard?.kind === 'tool-call'
                ? agentCard.children.some(c => c.kind === 'tool-call' && c.id === 'toolu-sub-2')
                : false
        ).toBe(true)
        expect(reduced.blocks.some(b => b.kind === 'tool-call' && b.id === 'toolu-sub-2')).toBe(false)
    })

    it('attaches a result summary to the first block in the preceding contiguous assistant group', () => {
        const summary = {
            usage: { input_tokens: 100, output_tokens: 20 },
            modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20 } },
            totalCostUsd: 0.02,
            numTurns: 2,
            durationMs: 1500
        }
        const messages: NormalizedMessage[] = [
            userMessage('u1', 'hello', 1),
            {
                id: 'a1', localId: 'turn-1', createdAt: 2, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'thinking', uuid: 'a1', parentUUID: null }]
            },
            {
                id: 'a2', localId: 'turn-2', createdAt: 3, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'answer', uuid: 'a2', parentUUID: 'a1' }]
            },
            {
                id: 'summary', localId: null, createdAt: 4, role: 'event', isSidechain: false,
                content: { type: 'turn-summary', summary } as any
            }
        ]

        const reduced = reduceChatBlocks(messages, null)
        const firstAssistant = reduced.blocks.find(block => block.kind === 'agent-text' && block.id.startsWith('a1'))
        expect((firstAssistant as any)?.roundSummary).toEqual(summary)
        const secondAssistant = reduced.blocks.find(block => block.kind === 'agent-text' && block.id.startsWith('a2'))
        expect((secondAssistant as any)?.roundSummary).toBeUndefined()
    })

    it('keeps a sidechain result summary on the subagent card instead of the next root response', () => {
        const summary = {
            modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 2 } },
            totalCostUsd: 0.01,
            numTurns: 1,
            durationMs: 800
        }
        const messages: NormalizedMessage[] = [
            {
                id: 'agent-tool', localId: null, createdAt: 1, role: 'agent', isSidechain: false,
                content: [{
                    type: 'tool-call', id: 'toolu-agent-1', name: 'Agent',
                    input: { prompt: 'inspect the code', subagent_type: 'general-purpose' },
                    description: null, uuid: 'root-1', parentUUID: null
                }]
            },
            {
                id: 'sidechain-answer', localId: null, createdAt: 2, role: 'agent', isSidechain: true,
                parentToolUseId: 'toolu-agent-1',
                content: [{ type: 'text', text: 'subagent answer', uuid: 'side-1', parentUUID: null }]
            },
            {
                id: 'sidechain-summary', localId: null, createdAt: 3, role: 'event', isSidechain: true,
                parentToolUseId: 'toolu-agent-1',
                content: { type: 'turn-summary', summary } as any
            },
            {
                id: 'root-answer', localId: null, createdAt: 4, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'root answer', uuid: 'root-2', parentUUID: 'root-1' }]
            }
        ]

        const reduced = reduceChatBlocks(messages, null)
        const agentCard = reduced.blocks.find(block => block.kind === 'tool-call')
        const sidechainAnswer = agentCard?.kind === 'tool-call'
            ? agentCard.children.find(block => block.kind === 'agent-text')
            : undefined
        const rootAnswer = reduced.blocks.find(block => block.kind === 'agent-text')

        expect(sidechainAnswer?.kind === 'agent-text' ? sidechainAnswer.roundSummary : undefined).toEqual(summary)
        expect(rootAnswer?.kind === 'agent-text' ? rootAnswer.roundSummary : undefined).toBeUndefined()
    })

    it('keeps a late result summary when reconciling an existing assistant block', () => {
        const summary = {
            usage: { input_tokens: 10, output_tokens: 2 },
            modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 2 } },
            totalCostUsd: 0.02,
            numTurns: 1,
            durationMs: 1200
        }
        const baseMessages: NormalizedMessage[] = [
            userMessage('u1', 'hello', 1),
            {
                id: 'a1', localId: 'turn-1', createdAt: 2, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'answer', uuid: 'a1', parentUUID: null }]
            }
        ]
        const before = reduceChatBlocks(baseMessages, null)
        const previousById = new Map(before.blocks.map(block => [block.id, block]))
        const after = reduceChatBlocks([
            ...baseMessages,
            {
                id: 'summary', localId: null, createdAt: 3, role: 'event', isSidechain: false,
                content: { type: 'turn-summary', summary } as any
            }
        ], null)

        const reconciled = reconcileChatBlocks(after.blocks, previousById)
        const assistant = reconciled.blocks.find(block => block.kind === 'agent-text')
        expect(assistant?.kind === 'agent-text' ? assistant.roundSummary : undefined).toEqual(summary)
    })
})
