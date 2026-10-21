import { describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@/api/types';
import type { AgentBackend } from '@/agent/types';
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler';
import {
    buildMcodeQuestionInput,
    McodeQuestionHandler,
    normalizeMcodeAskUserToolCall,
    parseMcodeAskUserSteps,
    type McodeAskUserCallHint
} from './questionHandler';

function createHarness(
    hint: McodeAskUserCallHint | null = null,
    options: {
        drain?: () => Promise<void>;
        hintGate?: () => boolean;
    } = {}
) {
    let state: AgentState = { requests: {}, completedRequests: {} };
    const client = {
        updateAgentState(handler: (current: AgentState) => AgentState) {
            state = handler(state);
        }
    };

    let elicitationHandler: ((params: unknown) => Promise<unknown>) | null = null;
    const backend = {
        registerExtensionRequestHandler(
            method: string,
            handler: (params: unknown) => Promise<unknown>
        ) {
            if (method === 'elicitation/create') {
                elicitationHandler = handler;
            }
        },
        waitForSessionUpdateQueue: options.drain
    };

    let nextHint = hint;
    const submitAnswer = vi.fn<(text: string) => void>();
    const questionHandler = new McodeQuestionHandler(
        client,
        backend,
        () => {
            if (options.hintGate && !options.hintGate()) return null;
            const value = nextHint;
            nextHint = null;
            return value;
        },
        { submitAnswer }
    );

    return {
        questionHandler,
        getState: () => state,
        submitAnswer,
        elicit: (params: unknown) => {
            if (!elicitationHandler) throw new Error('elicitation handler not registered');
            return elicitationHandler(params) as Promise<Record<string, unknown>>;
        }
    };
}

const choiceRequest = {
    mode: 'form',
    sessionId: 'acp-session-1',
    message: 'Choose an option',
    requestedSchema: {
        type: 'object',
        properties: {
            option_choice: {
                type: 'string',
                title: 'Which option do you prefer?',
                oneOf: [
                    { const: 'alpha', title: 'Alpha' },
                    { const: 'beta', title: 'Beta' }
                ]
            },
            option_choice__other: {
                type: 'string',
                title: 'Which option do you prefer? — Other',
                description: 'Others...'
            }
        }
    }
};

const choiceHint: McodeAskUserCallHint = {
    id: 'call_function_1',
    steps: [{
        id: 'option_choice',
        header: 'Preference',
        question: 'Which option do you prefer?',
        description: null,
        options: [
            { id: 'alpha', label: 'Alpha', description: null },
            { id: 'beta', label: 'Beta', description: null }
        ],
        multiSelect: false
    }]
};

describe('McodeQuestionHandler', () => {
    it('surfaces an elicitation form as an ask_user_question request', async () => {
        const { questionHandler, getState, elicit, submitAnswer } = createHarness(choiceHint);

        const resultPromise = elicit(choiceRequest);

        const request = getState().requests?.['call_function_1'];
        expect(request).toMatchObject({
            tool: 'ask_user_question',
            toolCallId: 'call_function_1',
            arguments: {
                questions: [{
                    header: 'Preference',
                    question: 'Which option do you prefer?',
                    options: [
                        { label: 'Alpha', description: null },
                        { label: 'Beta', description: null }
                    ],
                    multiSelect: false
                }]
            }
        });

        await expect(questionHandler.handleResponse({
            id: 'call_function_1',
            approved: true,
            answers: { '0': ['Alpha'] }
        })).resolves.toBe(true);

        // mcode ends the ask_user turn as soon as the question is raised, so
        // the answer continues the conversation as the next user message; the
        // elicitation is declined instead of being resumed out of band.
        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith('Q: Which option do you prefer?\nA: Alpha');
        expect(getState().requests?.['call_function_1']).toBeUndefined();
        expect(getState().completedRequests?.['call_function_1']).toMatchObject({
            tool: 'ask_user_question',
            toolCallId: 'call_function_1',
            status: 'approved',
            decision: 'approved',
            answers: { '0': ['Alpha'] }
        });
    });

    it('drains queued session updates before reading the ask_user hint', async () => {
        let drained = false;
        const { questionHandler, getState, elicit, submitAnswer } = createHarness(choiceHint, {
            drain: async () => {
                drained = true;
            },
            hintGate: () => drained
        });

        const resultPromise = elicit(choiceRequest);
        await vi.waitFor(() => {
            expect(getState().requests?.['call_function_1']).toBeDefined();
        });

        await questionHandler.handleResponse({
            id: 'call_function_1',
            approved: true,
            answers: { '0': ['Alpha'] }
        });
        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith('Q: Which option do you prefer?\nA: Alpha');
    });

    it('accepts stable step and option ids from native clients', async () => {
        const { questionHandler, elicit, submitAnswer } = createHarness(choiceHint);
        const resultPromise = elicit(choiceRequest);

        await questionHandler.handleResponse({
            id: 'call_function_1',
            approved: true,
            answers: { option_choice: ['beta'] }
        });

        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith('Q: Which option do you prefer?\nA: Beta');
    });

    it('maps multi-select choices and the dynamic Other field', async () => {
        const hint: McodeAskUserCallHint = {
            id: 'call_function_2',
            steps: [{
                id: 'pick',
                header: 'Pick',
                question: 'Pick one or more',
                description: null,
                options: [
                    { id: 'one', label: 'One', description: null },
                    { id: 'two', label: 'Two', description: null }
                ],
                multiSelect: true
            }]
        };
        const { questionHandler, elicit, submitAnswer } = createHarness(hint);
        const resultPromise = elicit({
            mode: 'form',
            sessionId: 'acp-session-1',
            message: 'Pick',
            requestedSchema: {
                type: 'object',
                properties: {
                    pick: {
                        type: 'array',
                        title: 'Pick one or more',
                        items: {
                            anyOf: [
                                { const: 'one', title: 'One' },
                                { const: 'two', title: 'Two' }
                            ]
                        }
                    },
                    pick__other: { type: 'string', title: 'Pick — Other' }
                }
            }
        });

        await questionHandler.handleResponse({
            id: 'call_function_2',
            approved: true,
            answers: { '0': ['One', 'custom answer'] }
        });

        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith('Q: Pick one or more\nA: One, custom answer');
    });

    it('maps a free-form step answer to the step id', async () => {
        const hint: McodeAskUserCallHint = {
            id: 'call_function_3',
            steps: [{
                id: 'reason',
                header: 'Why',
                question: 'Why?',
                description: null,
                options: [],
                multiSelect: false
            }]
        };
        const { questionHandler, elicit, submitAnswer } = createHarness(hint);
        const resultPromise = elicit({
            mode: 'form',
            sessionId: 'acp-session-1',
            message: 'Why?',
            requestedSchema: {
                type: 'object',
                properties: {
                    reason: { type: 'string', title: 'Why?' }
                }
            }
        });

        await questionHandler.handleResponse({
            id: 'call_function_3',
            approved: true,
            answers: { '0': ['because the tests failed'] }
        });

        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith('Q: Why?\nA: because the tests failed');
    });

    it('keeps a free-text answer when the form has no Other field', async () => {
        // The web always offers an "Other" row. When the agent's form has no
        // `__other` property the typed text has no place in the form content,
        // but the user still answered: the answer must reach the agent
        // instead of being reported as "No answers were provided".
        const hint: McodeAskUserCallHint = {
            id: 'call_function_4',
            steps: [{
                id: 'pick',
                header: 'Pick',
                question: 'Which option do you prefer?',
                description: null,
                options: [
                    { id: 'alpha', label: 'Alpha', description: null },
                    { id: 'beta', label: 'Beta', description: null }
                ],
                multiSelect: false
            }]
        };
        const { questionHandler, getState, elicit, submitAnswer } = createHarness(hint);
        const resultPromise = elicit({
            mode: 'form',
            sessionId: 'acp-session-1',
            message: 'Which option do you prefer?',
            requestedSchema: {
                type: 'object',
                properties: {
                    pick: {
                        type: 'string',
                        title: 'Which option do you prefer?',
                        oneOf: [
                            { const: 'alpha', title: 'Alpha' },
                            { const: 'beta', title: 'Beta' }
                        ]
                    }
                }
            }
        });

        await questionHandler.handleResponse({
            id: 'call_function_4',
            approved: true,
            answers: { '0': ['because the API is rate limited'] }
        });

        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith(
            'Q: Which option do you prefer?\nA: because the API is rate limited'
        );
        expect(getState().completedRequests?.['call_function_4']).toMatchObject({
            status: 'approved'
        });
    });

    it('declines when no answers are provided', async () => {
        const { questionHandler, elicit, getState, submitAnswer } = createHarness(choiceHint);
        const resultPromise = elicit(choiceRequest);

        await questionHandler.handleResponse({
            id: 'call_function_1',
            approved: true,
            answers: {}
        });

        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).not.toHaveBeenCalled();
        expect(getState().completedRequests?.['call_function_1']).toMatchObject({
            status: 'denied',
            decision: 'denied'
        });
    });

    it('maps denied and abort decisions to decline and cancel', async () => {
        const denied = createHarness(choiceHint);
        const deniedPromise = denied.elicit(choiceRequest);
        await denied.questionHandler.handleResponse({
            id: 'call_function_1',
            approved: false,
            decision: 'denied'
        });
        await expect(deniedPromise).resolves.toEqual({ action: 'decline' });

        const aborted = createHarness(choiceHint);
        const abortedPromise = aborted.elicit(choiceRequest);
        await aborted.questionHandler.handleResponse({
            id: 'call_function_1',
            approved: false,
            decision: 'abort'
        });
        await expect(abortedPromise).resolves.toEqual({ action: 'cancel' });
    });

    it('cancels pending questions when they are superseded or the session ends', async () => {
        const { questionHandler, elicit, getState } = createHarness(choiceHint);
        const resultPromise = elicit(choiceRequest);

        await questionHandler.cancelAll('Superseded by a new message');

        await expect(resultPromise).resolves.toEqual({ action: 'cancel' });
        expect(getState().requests?.['call_function_1']).toBeUndefined();
        expect(getState().completedRequests?.['call_function_1']).toMatchObject({
            status: 'canceled',
            decision: 'abort',
            reason: 'Superseded by a new message'
        });
    });

    it('ignores responses for unknown question ids', async () => {
        const { questionHandler } = createHarness();

        await expect(questionHandler.handleResponse({
            id: 'missing',
            approved: true
        })).resolves.toBe(false);
    });

    it('declines malformed elicitation requests', async () => {
        const { elicit } = createHarness();

        await expect(elicit({ mode: 'form', requestedSchema: null })).resolves.toEqual({
            action: 'decline'
        });
    });

    it('stays answerable when the turn ends and tool approvals are canceled', async () => {
        // mcode ends the turn as soon as the questionnaire is raised, so the
        // launcher cancels the turn-scoped tool approvals right after. The
        // question shares the session's request map with them and has to
        // survive that sweep, otherwise the card is already dead by the time
        // the user sees it and no answer can be submitted.
        let state: AgentState = { requests: {}, completedRequests: {} };
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState(handler: (current: AgentState) => AgentState) {
                state = handler(state);
            }
        };

        let elicitationHandler: ((params: unknown) => Promise<unknown>) | null = null;
        const backend = {
            registerExtensionRequestHandler(
                method: string,
                handler: (params: unknown) => Promise<unknown>
            ) {
                if (method === 'elicitation/create') {
                    elicitationHandler = handler;
                }
            }
        };

        const submitAnswer = vi.fn<(text: string) => void>();
        const questionHandler = new McodeQuestionHandler(
            client,
            backend,
            () => choiceHint,
            { submitAnswer }
        );

        const permissionHandler = new AcpPermissionHandler(
            client as never,
            {
                onPermissionRequest: vi.fn(),
                respondToPermission: vi.fn(async () => {})
            } as unknown as AgentBackend,
            () => 'default',
            { handleMissingResponse: (response) => questionHandler.handleResponse(response) }
        );

        const resultPromise = elicitationHandler!(choiceRequest) as Promise<Record<string, unknown>>;

        // The turn ends here: the launcher cancels the turn-scoped approvals.
        await permissionHandler.cancelAll('Prompt finished');

        expect(state.requests?.['call_function_1']).toBeDefined();
        expect(state.completedRequests?.['call_function_1']).toBeUndefined();

        await expect(questionHandler.handleResponse({
            id: 'call_function_1',
            approved: true,
            answers: { '0': ['Alpha'] }
        })).resolves.toBe(true);

        await expect(resultPromise).resolves.toEqual({ action: 'decline' });
        expect(submitAnswer).toHaveBeenCalledWith('Q: Which option do you prefer?\nA: Alpha');
    });
});

describe('mcode ask_user tool-call parsing', () => {
    it('normalises questionnaire steps into the shared question input', () => {
        const steps = parseMcodeAskUserSteps({
            mode: 'questionnaire',
            title: 'Choose an option',
            steps: [{
                id: 'option_choice',
                header: 'Preference',
                question: 'Which option do you prefer?',
                options: [
                    { id: 'alpha', label: 'Alpha', recommended: true },
                    { id: 'beta', label: 'Beta' }
                ],
                selectionMode: 'single'
            }]
        });

        expect(steps).not.toBeNull();
        expect(buildMcodeQuestionInput(steps!)).toEqual({
            questions: [{
                header: 'Preference',
                question: 'Which option do you prefer?',
                options: [
                    { label: 'Alpha', description: null },
                    { label: 'Beta', description: null }
                ],
                multiSelect: false
            }]
        });
    });

    it('returns null for non-questionnaire tool inputs', () => {
        expect(parseMcodeAskUserSteps({ command: 'ls' })).toBeNull();
        expect(parseMcodeAskUserSteps(null)).toBeNull();
    });

    it('reshapes an in-progress ask_user tool call and returns its hint', () => {
        const normalized = normalizeMcodeAskUserToolCall({
            type: 'tool_call',
            id: 'call_function_1',
            name: 'ask_user',
            status: 'in_progress',
            input: {
                mode: 'questionnaire',
                title: 'Choose an option',
                steps: [{
                    id: 'option_choice',
                    header: 'Preference',
                    question: 'Which option do you prefer?',
                    options: [
                        { id: 'alpha', label: 'Alpha' },
                        { id: 'beta', label: 'Beta' }
                    ],
                    selectionMode: 'single'
                }]
            }
        });

        expect(normalized.message).toMatchObject({
            type: 'tool_call',
            id: 'call_function_1',
            name: 'ask_user_question',
            input: {
                questions: [{
                    header: 'Preference',
                    question: 'Which option do you prefer?',
                    options: [
                        { label: 'Alpha', description: null },
                        { label: 'Beta', description: null }
                    ],
                    multiSelect: false
                }]
            }
        });
        expect(normalized.hint).toMatchObject({
            id: 'call_function_1',
            steps: [{ id: 'option_choice', header: 'Preference' }]
        });
    });

    it('keeps the question presentation on terminal updates but drops the hint', () => {
        const completed = normalizeMcodeAskUserToolCall({
            type: 'tool_call',
            id: 'call_function_1',
            name: 'ask_user',
            status: 'completed',
            input: { steps: [{ id: 'step', question: 'Q', options: [] }] }
        });
        expect(completed.message).toMatchObject({
            name: 'ask_user_question',
            input: { questions: [{ question: 'Q' }] }
        });
        expect(completed.hint).toBeNull();

        const other = normalizeMcodeAskUserToolCall({
            type: 'tool_call',
            id: 'call_function_2',
            name: 'Bash',
            status: 'in_progress',
            input: { command: 'ls' }
        });
        expect(other.message).toMatchObject({ name: 'Bash' });
        expect(other.hint).toBeNull();
    });
});
