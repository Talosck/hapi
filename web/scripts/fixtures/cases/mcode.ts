import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * MiniMax Code (mcode) flavor.
 *
 * The agent talks over ACP, so its tool calls arrive in the same
 * `content.type === 'codex'` envelope every other agent uses. What is its
 * own is the question card and the delegation tree.
 *
 * - `ask_user_question` is the name HAPI gives the agent's `ask_user` tool.
 *   The agent ends its turn when it raises the questionnaire, so the card
 *   stays answerable across that turn boundary instead of being treated as
 *   a pending tool approval.
 * - `subagent-snapshot` is session state, not a timeline entry: the agent
 *   runs subagents as delegated sessions and reports the whole tree, and the
 *   web renders the tree in the session status panel. A row in the
 *   transcript would only repeat it.
 */
export const mcodeCases: FixtureCase[] = [
    {
        name: 'mcode-ask-user-question',
        description: 'mcode flavor: the agent\'s ask_user tool arrives as an ask_user_question tool-call (single-select with an optional step, the "Other" field is an open option), and the card stays answerable because the agent ended its turn when it raised the questionnaire.',
        messages: [
            wireMessage({
                id: 'msg-user-m01',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Which site should the landing page use?' }
                }
            }),
            wireMessage({
                id: 'msg-mcode-m02',
                seq: 2,
                createdAt: T0 + 2_400,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            name: 'ask_user_question',
                            callId: 'call_mcode_ask_01',
                            input: {
                                questions: [
                                    {
                                        header: 'Site',
                                        question: 'Which site should the landing page use?',
                                        multiSelect: false,
                                        required: true,
                                        options: [
                                            { label: 'CN', description: 'The Chinese site' },
                                            { label: 'Global', description: 'The international site' }
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            })
        ]
    },
    {
        name: 'mcode-subagent-snapshot',
        description: 'mcode flavor: a subagent-snapshot event carries the whole delegation tree, and the tree is session state and not a timeline entry - the web renders it in the session status panel, so the event leaves no block behind in the transcript.',
        messages: [
            wireMessage({
                id: 'msg-user-m11',
                seq: 1,
                createdAt: T0,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Split the migration across both packages.' }
                }
            }),
            wireMessage({
                id: 'msg-mcode-m12',
                seq: 2,
                createdAt: T0 + 3_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'event',
                        data: {
                            type: 'subagent-snapshot',
                            members: [
                                {
                                    id: 'sub-1',
                                    parentId: null,
                                    title: 'migrate the api package',
                                    detail: null,
                                    status: 'running',
                                    startedAt: T0 + 2_000,
                                    endedAt: null,
                                    depth: 0
                                },
                                {
                                    id: 'sub-2',
                                    parentId: 'sub-1',
                                    title: 'rewrite the client of the api package',
                                    detail: 'the generated client is out of date',
                                    status: 'completed',
                                    startedAt: T0 + 2_400,
                                    endedAt: T0 + 3_000,
                                    depth: 1
                                }
                            ]
                        }
                    }
                }
            })
        ]
    }
]
