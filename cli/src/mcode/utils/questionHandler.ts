import { randomUUID } from 'node:crypto';
import { asString, isObject } from '@hapi/protocol';
import { PERMISSION_REQUEST_NOT_FOUND_MESSAGE } from '@hapi/protocol/rpcMethods';
import type { AgentState } from '@/api/types';
import type { AgentMessage } from '@/agent/types';
import type { AcpPermissionResponseMessage } from '@/modules/common/permission/AcpPermissionHandler';
import { logger } from '@/ui/logger';

/**
 * MiniMax Code's `ask_user` tool is bridged over ACP as a standard
 * `elicitation/create` form request. The form schema is dynamic
 * (`requestedSchema`), and the agent also announces the same questionnaire on
 * its `ask_user` tool call.
 *
 * HAPI has one transport for structured questions: an `ask_user_question`
 * agentState request answered through the existing permission RPC. This module
 * maps the ACP form onto that shape and turns the user's answer into the next
 * turn.
 *
 * The answer cannot ride back on the elicitation response: mcode terminates
 * the ACP turn right after the `ask_user` tool completes (its result already
 * says "stop this turn until the user replies"), and a reply delivered to the
 * elicitation afterwards is accepted but never resumes the agent. What does
 * resume it is the next user message, so the handler declines the elicitation
 * (letting mcode dismiss the questionnaire) and hands the formatted answer to
 * the launcher, which sends it as a normal user turn.
 */

export type McodeQuestionOption = {
    id: string;
    label: string;
    description: string | null;
};

/** One questionnaire step as published on the agent's `ask_user` tool call. */
export type McodeQuestionStep = {
    id: string;
    header: string | null;
    question: string;
    description: string | null;
    options: McodeQuestionOption[];
    multiSelect: boolean;
};

/** Tool-call hint captured just before the elicitation request arrives. */
export type McodeAskUserCallHint = {
    id: string;
    steps: McodeQuestionStep[];
};

type McodeQuestionSpec = McodeQuestionStep & {
    required: boolean;
    /** Dynamic form property that receives the free-form "Other" answer. */
    otherFieldId: string | null;
};

type ElicitationResult =
    | { action: 'accept'; content: Record<string, unknown> }
    | { action: 'decline' }
    | { action: 'cancel' };

type PendingQuestion = {
    specs: McodeQuestionSpec[];
    toolCallId: string | null;
    input: McodeAskUserQuestionInput;
    createdAt: number;
    /** ACP session the questionnaire belongs to (the turn to cancel). */
    sessionId: string;
    respond: (result: ElicitationResult) => void;
};

/** Shape consumed by the web/native `ask_user_question` card. */
export type McodeAskUserQuestionInput = {
    questions: Array<{
        header: string | null;
        question: string;
        options: Array<{ label: string; description: string | null }>;
        multiSelect: boolean;
        /**
         * False for a question the user may leave unanswered. The ACP form
         * schema decides: a property that is not listed in `required` is
         * optional, and the client has to be able to skip it.
         */
        required: boolean;
    }>;
};

type QuestionSessionClient = {
    updateAgentState: (handler: (state: AgentState) => AgentState) => void;
};

type QuestionBackend = {
    registerExtensionRequestHandler(
        method: string,
        handler: (params: unknown) => Promise<unknown>
    ): void;
    /** Drains queued session/update messages so the ask_user hint is visible. */
    waitForSessionUpdateQueue?: () => Promise<void>;
    /** Stops the turn the agent is running (an aborted questionnaire). */
    cancelPrompt?: (sessionId: string) => Promise<void> | void;
};

export type McodeQuestionHandlerOptions = {
    /**
     * Delivers the user's answer as a new turn. mcode ends the `ask_user` turn
     * as soon as the questionnaire is raised, so answering it means sending the
     * answer back as the next user message.
     */
    submitAnswer: (text: string) => void;
    /**
     * Called when the user aborts a questionnaire. The agent turn has to
     * stop: the question is only one part of it, and the other pending
     * approvals would keep the agent working.
     */
    onAbort?: (sessionId: string) => Promise<void> | void;
};

const ASK_USER_QUESTION_TOOL = 'ask_user_question';
const ELICITATION_CREATE_METHOD = 'elicitation/create';

export class McodeQuestionHandler {
    private readonly pending = new Map<string, PendingQuestion>();

    constructor(
        private readonly session: QuestionSessionClient,
        private readonly backend: QuestionBackend,
        private readonly takeToolCallHint: () => McodeAskUserCallHint | null,
        private readonly options: McodeQuestionHandlerOptions
    ) {
        this.backend.registerExtensionRequestHandler(
            ELICITATION_CREATE_METHOD,
            (params) => this.handleRequest(params)
        );
    }

    /** Consumes a permission response that belongs to a pending question. */
    async handleResponse(response: AcpPermissionResponseMessage): Promise<boolean> {
        const pending = this.pending.get(response.id);
        if (!pending) {
            // The question is gone: it was answered already, canceled by a new
            // message, or the session ended. Throwing (instead of returning
            // false) makes the RPC caller see a real error: the hub turns this
            // message into a 409, so a duplicate answer is not accepted as if
            // it had been delivered.
            logger.debug(PERMISSION_REQUEST_NOT_FOUND_MESSAGE);
            throw new Error(PERMISSION_REQUEST_NOT_FOUND_MESSAGE);
        }

        this.pending.delete(response.id);

        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        if (decision === 'abort') {
            pending.respond({ action: 'cancel' });
            this.complete(pending, response.id, 'canceled', 'abort', response.reason);
            // The questionnaire is only one part of the turn: the agent keeps
            // working (and the other approvals stay open) unless the turn is
            // stopped as well.
            await this.options.onAbort?.(pending.sessionId);
            return true;
        }

        if (decision === 'denied') {
            pending.respond({ action: 'decline' });
            this.complete(pending, response.id, 'denied', decision, response.reason);
            return true;
        }

        // The answer is judged by what the user actually typed, not by the
        // content the ACP form would have carried: a free-text "Other" answer
        // has no place in a schema without an `__other` property, and judging
        // it by the form silently dropped what the user wrote.
        const answered = answeredStepKeys(response.answers);
        const hasAnswer = answered.size > 0;
        const hasRequiredAnswer = pending.specs.every((spec, index) => (
            !spec.required
            || answered.has(spec.id)
            || answered.has(String(index))
            || (spec.otherFieldId !== null && answered.has(spec.otherFieldId))
        ));

        if (!hasAnswer || !hasRequiredAnswer) {
            pending.respond({ action: 'decline' });
            this.complete(
                pending,
                response.id,
                'denied',
                'denied',
                response.reason ?? 'No answers were provided.'
            );
            return true;
        }

        // mcode stops the turn when the questionnaire is raised, so the answer
        // is delivered as the next user message; the elicitation is declined so
        // the agent does not also inject (and silently drop) a reply turn.
        pending.respond({ action: 'decline' });
        this.complete(
            pending,
            response.id,
            'approved',
            decision,
            response.reason,
            buildAnswerSummary(pending.specs, response.answers)
        );
        this.options.submitAnswer(buildAnswerMessage(pending.specs, response.answers));
        return true;
    }

    async cancelAll(reason: string): Promise<void> {
        const entries = Array.from(this.pending.entries());
        this.pending.clear();

        for (const [id, pending] of entries) {
            pending.respond({ action: 'cancel' });
            this.complete(pending, id, 'canceled', 'abort', reason);
        }
    }

    private async handleRequest(params: unknown): Promise<ElicitationResult> {
        let hint = this.takeToolCallHint();
        if (!hint) {
            // The elicitation request is dispatched synchronously, while the
            // preceding ask_user tool call may still be queued behind
            // session/update processing. Drain and retry before falling back
            // to a synthetic request id.
            await this.backend.waitForSessionUpdateQueue?.();
            hint = this.takeToolCallHint();
        }
        const specs = parseElicitationRequest(params, hint?.steps ?? null);
        if (!specs) {
            logger.warn('[mcode] Ignoring unsupported elicitation/create request');
            return Promise.resolve({ action: 'decline' });
        }

        const hintId = hint?.id ?? null;
        const requestId = hintId && !this.pending.has(hintId)
            ? hintId
            : `mcode-question-${randomUUID()}`;
        const toolCallId = hintId ?? null;
        const input = buildQuestionInput(specs);
        const createdAt = Date.now();
        // The elicitation names the session the questionnaire belongs to, so
        // an abort can stop that turn.
        const sessionId = isObject(params) ? (asString(params.sessionId) ?? '') : '';

        logger.debug(`[mcode] Elicitation question queued (${requestId})`);

        return new Promise<ElicitationResult>((resolve) => {
            this.pending.set(requestId, {
                specs,
                toolCallId,
                input,
                createdAt,
                sessionId,
                respond: resolve
            });

            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [requestId]: {
                        tool: ASK_USER_QUESTION_TOOL,
                        ...(toolCallId ? { toolCallId } : {}),
                        arguments: input,
                        createdAt
                    }
                }
            } satisfies AgentState));
        });
    }

    private complete(
        pending: PendingQuestion,
        requestId: string,
        status: 'approved' | 'denied' | 'canceled',
        decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        reason?: string,
        answers?: Record<string, string[]>
    ): void {
        const completedAt = Date.now();
        this.session.updateAgentState((currentState) => {
            const { [requestId]: _removed, ...remaining } = currentState.requests ?? {};
            return {
                ...currentState,
                requests: remaining,
                completedRequests: {
                    ...currentState.completedRequests,
                    [requestId]: {
                        tool: ASK_USER_QUESTION_TOOL,
                        ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
                        arguments: pending.input,
                        createdAt: pending.createdAt,
                        completedAt,
                        status,
                        decision,
                        ...(reason ? { reason } : {}),
                        ...(answers ? { answers } : {})
                    }
                }
            } satisfies AgentState;
        });
    }
}

/**
 * Converts the raw `ask_user` tool-call input into the normalised question
 * shape HAPI renders. Used so the transcript card and the interactive
 * permission card share one toolCallId and one input.
 */
export function parseMcodeAskUserSteps(input: unknown): McodeQuestionStep[] | null {
    if (!isObject(input) || !Array.isArray(input.steps)) return null;

    const steps: McodeQuestionStep[] = [];
    for (const raw of input.steps) {
        if (!isObject(raw)) continue;

        const id = asString(raw.id);
        const question = asString(raw.question) ?? asString(raw.title);
        if (!id || !question) continue;

        const selectionMode = raw.selectionMode;
        const multiSelect = selectionMode === 'multiple' || selectionMode === 1;

        steps.push({
            id,
            header: asString(raw.header) ?? null,
            question,
            description: asString(raw.description) ?? null,
            options: parseOptions(raw.options),
            multiSelect
        });
    }

    return steps.length > 0 ? steps : null;
}

/** Builds the `{ questions }` input shared by the tool card and permission card. */
export function buildMcodeQuestionInput(steps: McodeQuestionStep[]): McodeAskUserQuestionInput {
    return buildQuestionInput(steps.map((step) => ({
        ...step,
        // The tool call carries no required information: only the elicitation
        // schema knows which questions may be skipped. Until it arrives every
        // question counts as required.
        required: true,
        otherFieldId: null
    })));
}

/**
 * Rewrites the ACP `ask_user` tool call into the shared question card and
 * returns the hint the elicitation handler uses to reuse its toolCallId.
 * The permission card then merges with this card instead of duplicating it.
 * Terminal updates are rewritten too so the completed card keeps the question
 * presentation and answers.
 */
export function normalizeMcodeAskUserToolCall(message: AgentMessage): {
    message: AgentMessage;
    hint: McodeAskUserCallHint | null;
} {
    if (message.type !== 'tool_call') {
        return { message, hint: null };
    }

    const normalizedName = message.name.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (normalizedName !== 'ask_user') {
        return { message, hint: null };
    }

    const steps = parseMcodeAskUserSteps(message.input);
    if (!steps) {
        return { message, hint: null };
    }

    return {
        message: {
            ...message,
            name: 'ask_user_question',
            input: buildMcodeQuestionInput(steps)
        },
        hint: message.status === 'completed' || message.status === 'failed'
            ? null
            : { id: message.id, steps }
    };
}

function buildQuestionInput(specs: McodeQuestionSpec[]): McodeAskUserQuestionInput {
    return {
        questions: specs.map((spec) => ({
            header: spec.header,
            question: spec.question,
            options: spec.options.map((option) => ({
                label: option.label,
                description: option.description
            })),
            multiSelect: spec.multiSelect,
            required: spec.required
        }))
    };
}

function parseElicitationRequest(
    params: unknown,
    hintSteps: McodeQuestionStep[] | null
): McodeQuestionSpec[] | null {
    if (!isObject(params) || !isObject(params.requestedSchema)) return null;

    const schema = params.requestedSchema;
    if (!isObject(schema.properties)) return null;

    const properties = schema.properties;
    const required = new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((entry): entry is string => typeof entry === 'string')
            : []
    );

    const stepKeys = collectStepKeys(properties, hintSteps);
    const specs: McodeQuestionSpec[] = [];

    for (const key of stepKeys) {
        const property = properties[key];
        if (!isObject(property)) continue;

        const hint = hintSteps?.find((step) => step.id === key) ?? null;
        const options = parseFormOptions(property, hint);
        const otherFieldId = findOtherFieldId(key, properties);
        const question = asString(property.title) ?? hint?.question ?? key;

        specs.push({
            id: key,
            header: hint?.header ?? null,
            question,
            description: asString(property.description) ?? hint?.description ?? null,
            options,
            multiSelect: property.type === 'array' || hint?.multiSelect === true,
            required: required.has(key),
            otherFieldId
        });
    }

    return specs.length > 0 ? specs : null;
}

function collectStepKeys(
    properties: Record<string, unknown>,
    hintSteps: McodeQuestionStep[] | null
): string[] {
    if (hintSteps && hintSteps.length > 0) {
        const hinted = hintSteps
            .map((step) => step.id)
            .filter((id) => id in properties);
        if (hinted.length > 0) return hinted;
    }

    // Without a tool-call hint, dynamic-form `__other` fields are generated
    // from a step id, so a key that is an "other" suffix of another property
    // is not a step of its own.
    const keys = Object.keys(properties);
    return keys.filter((key) => !keys.some((base) => (
        base !== key && key.startsWith(`${base}__other`)
    )));
}

function findOtherFieldId(
    stepId: string,
    properties: Record<string, unknown>
): string | null {
    const prefix = `${stepId}__other`;
    for (const key of Object.keys(properties)) {
        if (key.startsWith(prefix)) return key;
    }
    return null;
}

function parseFormOptions(
    property: Record<string, unknown>,
    hint: McodeQuestionStep | null
): McodeQuestionOption[] {
    if (property.type === 'array' && isObject(property.items)) {
        const choices = Array.isArray(property.items.anyOf)
            ? property.items.anyOf
            : Array.isArray(property.items.oneOf)
                ? property.items.oneOf
                : null;
        if (choices) return parseChoices(choices);
    }

    const choices = Array.isArray(property.oneOf)
        ? property.oneOf
        : Array.isArray(property.anyOf)
            ? property.anyOf
            : null;
    if (choices) return parseChoices(choices);

    return hint?.options ?? [];
}

function parseChoices(choices: unknown[]): McodeQuestionOption[] {
    const options: McodeQuestionOption[] = [];
    for (const choice of choices) {
        if (!isObject(choice)) continue;
        const id = asString(choice.const) ?? asString(choice.value);
        const label = asString(choice.title) ?? asString(choice.label) ?? id;
        if (!id || !label) continue;
        options.push({
            id,
            label,
            description: asString(choice.description) ?? null
        });
    }
    return options;
}

function parseOptions(value: unknown): McodeQuestionOption[] {
    if (!Array.isArray(value)) return [];
    return parseChoices(value.map((option) => {
        if (!isObject(option)) return option;
        return {
            const: option.id,
            title: option.label,
            description: option.description
        };
    }));
}

function normalizeAnswers(
    answers: AcpPermissionResponseMessage['answers']
): Record<string, string[]> | null {
    if (!isObject(answers)) return null;

    const flat: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            flat[key] = value.filter((entry): entry is string => typeof entry === 'string');
        } else if (isObject(value) && Array.isArray(value.answers)) {
            flat[key] = value.answers.filter((entry): entry is string => typeof entry === 'string');
        }
    }
    return flat;
}

/**
 * The keys the user actually answered: a step id, a step index, or the id of
 * a step's free-text field. An entry counts as answered when it holds a
 * non-empty value.
 */
function answeredStepKeys(
    answers: AcpPermissionResponseMessage['answers']
): Set<string> {
    const answered = new Set<string>();
    const flat = normalizeAnswers(answers);
    if (!flat) return answered;
    for (const [key, values] of Object.entries(flat)) {
        if (values.some((value) => value.trim().length > 0)) {
            answered.add(key);
        }
    }
    return answered;
}

/**
 * The values answered for one question.
 *
 * A client may answer under the question's own id, under its index, or — when
 * it fills the ACP form — under the id of the question's free-text ("Other")
 * property. All three are the same answer, so all three are read here.
 */
function answerValuesForSpec(
    flat: Record<string, string[]>,
    spec: McodeQuestionSpec,
    index: number
): string[] {
    const byId = flat[spec.id];
    if (byId && byId.length > 0) return byId;
    const byIndex = flat[String(index)];
    if (byIndex && byIndex.length > 0) return byIndex;
    if (spec.otherFieldId !== null) {
        const byOtherField = flat[spec.otherFieldId];
        if (byOtherField && byOtherField.length > 0) return byOtherField;
    }
    return [];
}

/** Flat `{ index: [labels] }` shape used by the question card's answered view. */
function buildAnswerSummary(
    specs: McodeQuestionSpec[],
    answers: AcpPermissionResponseMessage['answers']
): Record<string, string[]> | undefined {
    const flat = normalizeAnswers(answers);
    if (!flat) return undefined;

    const summary: Record<string, string[]> = {};
    specs.forEach((spec, index) => {
        const raw = answerValuesForSpec(flat, spec, index);
        if (raw.length === 0) return;
        summary[String(index)] = raw.map((value) => {
            const option = spec.options.find((candidate) => (
                candidate.id === value || candidate.label === value
            ));
            return option?.label ?? value;
        });
    });

    return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Renders the answer as the user turn that resumes the agent. mcode's own
 * questionnaire reply uses a `Q: … / A: …` body, so the model sees the same
 * shape here even though the answer arrives as a plain user message.
 */
function buildAnswerMessage(
    specs: McodeQuestionSpec[],
    answers: AcpPermissionResponseMessage['answers']
): string {
    const flat = normalizeAnswers(answers) ?? {};
    const blocks: string[] = [];

    specs.forEach((spec, index) => {
        const values = answerValuesForSpec(flat, spec, index)
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .map((value) => spec.options.find((candidate) => (
                candidate.id === value || candidate.label === value
            ))?.label ?? value);
        if (values.length === 0) return;
        blocks.push(`Q: ${spec.question}\nA: ${values.join(', ')}`);
    });

    return blocks.length > 0 ? blocks.join('\n\n') : 'No answer was provided.';
}
