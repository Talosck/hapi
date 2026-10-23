/**
 * End-to-end coverage against the installed MiniMax Code binary.
 *
 * The unit suite drives a mocked ACP backend, so it proves the launcher logic
 * but not that the agent agrees with it. This file runs the real
 * `mcode acp` process through the real launcher and replaces only the hub
 * with a recording session double, so every assertion below is about what
 * MiniMax Code actually did — including the ground truth, which is the
 * agent's own session directory on disk.
 *
 * It needs the MiniMax Code CLI on PATH, a working login and makes real
 * model calls, so it is opt-in:
 *
 *   HAPI_RUN_MCODE_E2E=1 bun run test:cli -- --run src/mcode/mcodeAgent.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { appendFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentState, Metadata } from '@/api/types';

const LOG_PATH = '/tmp/hapi-mcode-e2e.log';
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;
let logBytes = 0;

/**
 * The launcher's own log, so a failed run can be diagnosed afterwards.
 *
 * The runner's crash handler can loop inside Vitest — `process.exit` does not
 * terminate the worker there, so every rejected promise re-enters the handler
 * — which is why the log is capped.
 */
function writeLog(level: string, args: unknown[]): void {
    if (logBytes >= LOG_LIMIT_BYTES) return;
    const line = `${new Date().toISOString()} [${level}] ${args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`;
    logBytes += line.length;
    try { appendFileSync(LOG_PATH, line); } catch { /* the log is best effort */ }
}

const state = vi.hoisted(() => ({
    home: '',
    session: null as RecordingSession | null,
    lifecycle: null as { cleanupAndExit: () => Promise<void> } | null,
}));

type AgentMessage = {
    type?: string;
    name?: string;
    callId?: string;
    text?: string;
    message?: string;
    output?: unknown;
    status?: string;
    live?: boolean;
    streamSnapshot?: boolean;
    summary?: string;
    info?: { total?: { inputTokens?: number; outputTokens?: number } };
};

class RecordingSession {
    readonly sessionId = randomUUID();
    state: AgentState = { requests: {} };
    metadata: Metadata;
    /** Every chat message the launcher sent to the hub. */
    readonly agentMessages: AgentMessage[] = [];
    /** Every session event (the ⚠️ lines and the status messages). */
    readonly sessionEvents: Array<{ type?: string; message?: string; reason?: string }> = [];
    /** The summaries the agent's own title produced. */
    readonly summaries: Array<{ summary?: string }> = [];
    readonly consumed: string[] = [];
    /** The rows the launcher gave back because the agent refused the turn. */
    readonly released: string[] = [];
    /** The rows whose outcome the agent could not prove. */
    readonly indeterminate: string[] = [];
    /** Set when the launcher reported the session as dead (the agent went away). */
    dead = false;
    /**
     * How many tool calls the agent started. A tool call only appears while a
     * turn is running, so it is the signal that the agent is busy.
     */
    toolCalls = 0;
    /** Forget the tool calls seen so far, so a turn can be timed from zero. */
    resetToolCalls(): void { this.toolCalls = 0; }
    readonly rpc = new Map<string, (params: unknown) => Promise<unknown>>();
    readonly rpcHandlerManager = {
        registerHandler: (name: string, fn: (params: unknown) => Promise<unknown>) => {
            this.rpc.set(name, fn);
        },
    };
    user?: (message: unknown, id?: string) => void;

    constructor(cwd: string) {
        this.metadata = {
            path: cwd,
            host: 'e2e',
            hostPid: process.pid,
            machineId: 'e2e',
            flavor: 'mcode',
            capabilities: { concurrentClients: true },
        } as Metadata;
    }

    getMetadata(): Metadata { return this.metadata; }
    updateMetadata(fn: (m: Metadata) => Metadata): void { this.metadata = fn(this.metadata); }
    updateAgentState(fn: (s: AgentState) => AgentState): void { this.state = fn(this.state); }
    onUserMessage(fn: (message: unknown, id?: string) => void): void { this.user = fn; }
    onCancelQueuedMessage(): void {}
    onRetryQueuedMessage(): void {}
    onReconnect(): void {}
    sendUserMessage(): void {}
    sendAgentMessage(body: unknown): void {
        const message = body as AgentMessage;
        this.agentMessages.push(message);
        if (message.type === 'tool-call') this.toolCalls += 1;
        writeLog('hub', [`agentMessage ${JSON.stringify(body).slice(0, 300)}`]);
    }
    sendSessionEvent(body: unknown): void {
        this.sessionEvents.push(body as { type?: string; message?: string; reason?: string });
        writeLog('hub', [`sessionEvent ${JSON.stringify(body).slice(0, 300)}`]);
    }
    sendClaudeSessionMessage(body: unknown): void {
        this.summaries.push(body as { summary?: string });
        writeLog('hub', [`summary ${JSON.stringify(body).slice(0, 300)}`]);
    }
    emitMessagesConsumed(ids: string[]): void { this.consumed.push(...ids); }
    /** A turn the agent refused puts the rows back into the hub's queue. */
    emitMessagesReleased(ids: string[]): void { this.released.push(...ids); }
    /** A turn whose outcome cannot be proven is held for the user to resolve. */
    emitMessagesIndeterminate(ids: string[]): void { this.indeterminate.push(...ids); }
    emitSteerIndeterminate(): void {}
    keepAlive(): void {}
    emitSessionReady(): void {}
    async setSteerDeliveryState(): Promise<boolean> { return true; }
    syncNativeQueuedMessage(): void {}
    sendSessionDeath(): void {
        this.dead = true;
        writeLog('hub', ['sessionDeath']);
    }
    async flush(): Promise<void> {}
    close(): void {}
    isPending(): boolean { return false; }
}

vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return {
        ...actual,
        // Only the data directory is redirected; everything else the module
        // exports stays real, because the code below reads more of it than
        // the test knows about.
        configuration: new Proxy(actual.configuration, {
            get(target, property, receiver) {
                if (property === 'happyHomeDir') return state.home;
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    };
});

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: async (options: { workingDirectory: string }) => ({
        api: {},
        session: state.session ?? new RecordingSession(options.workingDirectory),
    }),
    bootstrapExistingSession: async (options: { workingDirectory: string }) => ({
        api: {},
        session: state.session ?? new RecordingSession(options.workingDirectory),
    }),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: (...args: unknown[]) => { writeLog('debug', args); },
        warn: (...args: unknown[]) => { writeLog('warn', args); },
        info: (...args: unknown[]) => { writeLog('info', args); },
        error: (...args: unknown[]) => { writeLog('error', args); },
        debugLargeJson: (...args: unknown[]) => { writeLog('debug', args); },
        getLogPath: vi.fn(() => '/tmp/hapi-mcode-e2e.log'),
    },
}));

// The Ink display is a terminal UI; the test has no terminal.
vi.mock('@/ui/ink/McodeDisplay', () => ({ McodeDisplay: () => null }));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    // The real handler ends the session through the runner lifecycle, which
    // shuts the agent down as part of its own cleanup. The test needs that
    // path so the teardown does not look like a crash.
    registerKillSessionHandler: (
        rpcHandlerManager: { registerHandler: (name: string, fn: (params: unknown) => Promise<unknown>) => void },
        lifecycle: { cleanupAndExit: () => Promise<void> },
    ) => {
        state.lifecycle = lifecycle;
        rpcHandlerManager.registerHandler('killSession', async () => {
            void lifecycle.cleanupAndExit();
            return { success: true, message: 'killing', pid: process.pid };
        });
    },
}));
vi.mock('@/agent/localHandoff', () => ({ registerLocalHandoffHandler: vi.fn() }));

// The MCP bridge is shared infrastructure that talks to the hub; the e2e
// replaces the hub, so the bridge has nothing to talk to.
vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({ server: { stop: () => {} }, mcpServers: {} }),
}));

import { runMcode } from './runMcode';
import { acpModelIdToCliModelId } from './utils/modelId';

/**
 * Vitest replaces `process.exit` with a throwing stub, so the runner's crash
 * handler would re-enter itself forever when it tries to exit: every rejected
 * promise lands in the handler again, and the worker never finishes the run.
 * The runner must not end the worker here - Vitest ends the run itself.
 */
const originalProcessExit = process.exit;
process.exit = (() => undefined) as unknown as typeof process.exit;

/** The agent process, found by the working directory it was started in. */
function findAgentChild(cwd: string): number | undefined {
    let real = cwd;
    try { real = realpathSync(cwd); } catch { return undefined; }
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            if (realpathSync(`/proc/${entry}/cwd`) === real) return Number(entry);
        } catch {
            // The process ended between the listing and the read.
        }
    }
    return undefined;
}

/**
 * The directory the agent keeps the session of `sessionId` in.
 *
 * MiniMax Code names it after the base64 of the session id, so the directory
 * can be found without knowing the layout.
 */
function mcodeSessionDir(sessionId: string): string {
    const suffix = Buffer.from(sessionId, 'utf8').toString('base64url').slice(0, 180);
    const root = join(homedir(), '.minimax', 'v2', 'sessions');
    // The agent files the session under the day it started on, so a run that
    // starts before midnight can end after it.
    for (const offset of [0, -1]) {
        const day = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
        const dir = join(
            root,
            String(day.getUTCFullYear()),
            String(day.getUTCMonth() + 1).padStart(2, '0'),
            String(day.getUTCDate()).padStart(2, '0'),
        );
        try {
            for (const entry of readdirSync(dir)) {
                if (entry.endsWith(`session_${suffix}`)) return join(dir, entry);
            }
        } catch {
            // The day directory does not exist yet.
        }
    }
    return join(root, `missing-session_${suffix}`);
}

type TranscriptEntry = {
    message_id?: string;
    message?: { role?: string; content?: unknown };
};

function transcriptText(entry: TranscriptEntry): string {
    const content = entry.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) => {
            if (typeof block !== 'object' || block === null) return '';
            const record = block as Record<string, unknown>;
            if (typeof record.text === 'string') return record.text;
            if (typeof record.toolName === 'string') return `[${record.toolName}]`;
            return '';
        })
        .join(' ');
}

async function readTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const path = join(mcodeSessionDir(sessionId), 'messages.jsonl');
    const raw = await readFile(path, 'utf8');
    return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TranscriptEntry);
}

/**
 * The model name of an ACP wire id.
 *
 * The wire id is `m:<provider>:<model>:u` or `m:<provider>:<model>:v:<variant>`;
 * the agent's own call record names the model without the provider or the
 * variant.
 */
function modelNameOf(wireId: string | null): string | null {
    if (!wireId) return null;
    const cliId = acpModelIdToCliModelId(wireId);
    if (!cliId) return null;
    const model = cliId.split('/')[1] ?? '';
    return model.split('#')[0] ?? null;
}

/**
 * The parameters of the model call the agent made last.
 *
 * The agent writes them next to the transcript, so they are the ground truth
 * for the model a turn really ran on.
 */
async function readLastModelCall(sessionId: string): Promise<{ model?: string; thinkingLevel?: string }> {
    const path = join(mcodeSessionDir(sessionId), 'llm-call.json');
    const raw = await readFile(path, 'utf8');
    const record = JSON.parse(raw) as { model?: string; thinkingLevel?: string };
    return record;
}

describe.skipIf(process.env.HAPI_RUN_MCODE_E2E !== '1')('MiniMax Code end to end', () => {
    let session: RecordingSession;
    let run: Promise<void>;
    let workingDirectory: string;
    let home: string;

    beforeAll(async () => {
        await rm(LOG_PATH, { force: true });
        writeLog('info', ['=== e2e run start ===']);
        home = await mkdtemp(join(tmpdir(), 'hapi-mcode-e2e-home-'));
        workingDirectory = await mkdtemp(join(tmpdir(), 'hapi-mcode-e2e-cwd-'));
        state.home = home;
        session = new RecordingSession(workingDirectory);
        state.session = session;
        run = runMcode({ startingMode: 'remote', workingDirectory });
    }, 120_000);

    afterAll(async () => {
        try {
            // The launcher's own lifecycle kills the agent as part of its
            // cleanup, so the teardown does not look like a crash.
            const kill = session.rpc.get('killSession');
            if (kill) await kill({});
            await Promise.race([
                run.catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, 20_000)),
            ]);
            // Anything that is still alive has to go, otherwise the agent
            // would outlive the test run.
            const pid = findAgentChild(workingDirectory);
            if (pid !== undefined) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
            }
        } finally {
            process.exit = originalProcessExit;
        }
        await rm(home, { recursive: true, force: true });
        await rm(workingDirectory, { recursive: true, force: true });
    }, 120_000);

    it('brings the agent up and answers a prompt', async () => {
        // The launcher publishes the native session id it really runs, so a
        // client can tell a live agent from a blank fallback.
        await vi.waitFor(() => {
            expect(session.metadata.mcodeSessionId).toBeTruthy();
        }, 90_000);

        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: MCODE_E2E_OK' },
        }, 'e2e-prompt-1');
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('MCODE_E2E_OK'));
            expect(answer).toBeDefined();
        }, 180_000);

        // The ground truth: the agent's own transcript holds the same answer.
        // The agent writes it a moment after the hub hears it, so the read
        // waits for the file to catch up.
        const nativeSessionId = session.metadata.mcodeSessionId as string;
        await vi.waitFor(async () => {
            const entries = await readTranscript(nativeSessionId);
            const answers = entries
                .filter((entry) => entry.message?.role === 'assistant')
                .map((entry) => transcriptText(entry));
            expect(answers.some((text) => text.includes('MCODE_E2E_OK'))).toBe(true);
        }, 60_000);
    }, 300_000);

    it('turns a tool call of the agent into a card with the real output', async () => {
        const before = session.agentMessages.length;
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Run the shell command `echo mcode-e2e-tool-output` and then reply with exactly: TOOL_DONE' },
        }, 'e2e-prompt-2');
        await vi.waitFor(() => {
            const call = session.agentMessages.slice(before).find((message) => message.type === 'tool-call');
            expect(call).toBeDefined();
            // The agent calls its own tool "bash"; the card has to carry the
            // name the web renders.
            expect(call?.name).toBe('Bash');
        }, 180_000);
        await vi.waitFor(() => {
            const result = session.agentMessages.slice(before).find((message) => {
                return message.type === 'tool-call-result'
                    && JSON.stringify(message.output).includes('mcode-e2e-tool-output');
            });
            expect(result).toBeDefined();
        }, 180_000);

        // The ground truth: the agent wrote the tool call and its result.
        const nativeSessionId = session.metadata.mcodeSessionId as string;
        const entries = await readTranscript(nativeSessionId);
        const raw = JSON.stringify(entries);
        expect(raw).toContain('mcode-e2e-tool-output');
    }, 300_000);

    it('stops a turn that is aborted and keeps the session alive', async () => {
        const before = session.agentMessages.length;
        session.resetToolCalls();
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Run the shell command `sleep 25` and then reply with exactly: SLEPT' },
        }, 'e2e-prompt-3');

        // The turn has to be running before the abort can mean anything. The
        // tool call is the proof: it only appears while the agent works.
        await vi.waitFor(() => {
            expect(session.toolCalls).toBeGreaterThan(0);
        }, 180_000);

        const abort = session.rpc.get('abort');
        expect(abort).toBeDefined();
        await abort!({});

        // The session says so.
        await vi.waitFor(() => {
            const notice = session.sessionEvents.find((event) => event.message === 'Session aborted');
            expect(notice).toBeDefined();
        }, 30_000);
        // The aborted turn really stopped: the command it started never
        // produced a result.
        const abortedTool = session.agentMessages.slice(before).find((message) => message.type === 'tool-call');
        expect(abortedTool).toBeDefined();
        const abortedResult = session.agentMessages.slice(before).find((message) => {
            return message.type === 'tool-call-result' && message.callId === abortedTool?.callId;
        });
        expect(abortedResult).toBeUndefined();

        // The session survives the abort: the next turn still gets an answer.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: MCODE_E2E_AFTER_ABORT_OK' },
        }, 'e2e-prompt-4');
        await vi.waitFor(() => {
            const answer = session.agentMessages.slice(before).find((message) => JSON.stringify(message).includes('MCODE_E2E_AFTER_ABORT_OK'));
            expect(session.dead).toBe(false);
            expect(answer).toBeDefined();
        }, 180_000);
    }, 300_000);

    it('reports what the agent named the session', async () => {
        // The agent publishes its own title after the turn it derives it from
        // has finished, so this needs the turns above to be done.
        await vi.waitFor(() => {
            expect(session.summaries.length).toBeGreaterThan(0);
        }, 120_000);
        const titles = session.summaries.map((entry) => entry.summary ?? '');
        expect(titles.some((title) => title.length > 0)).toBe(true);
    }, 180_000);

    it('reports the token counts of the turns it ran', async () => {
        await vi.waitFor(() => {
            const count = session.agentMessages.find((message) => {
                if (message.type !== 'token_count') return false;
                const info = (message as { info?: { total?: { inputTokens?: number } } }).info;
                return (info?.total?.inputTokens ?? 0) > 0;
            });
            expect(count).toBeDefined();
        }, 120_000);
    }, 180_000);

    it('switches the model of the running session and the agent really uses it', async () => {
        const listModels = session.rpc.get('listMcodeModels');
        expect(listModels).toBeDefined();
        const catalog = await listModels!({}) as {
            availableModels?: Array<{ modelId: string; name?: string }>;
            currentModelId?: string | null;
        };
        writeLog('info', [`model catalog ${JSON.stringify(catalog)}`]);
        const current = catalog.currentModelId ?? null;
        const currentModel = modelNameOf(current);

        // A model of another family, so the agent's own call record can tell
        // that the switch really happened.
        const candidates = (catalog.availableModels ?? [])
            .map((model) => ({ wire: model.modelId, name: modelNameOf(model.modelId) }))
            .filter((candidate) => candidate.name && candidate.name !== currentModel);
        if (candidates.length === 0) {
            writeLog('info', ['the agent offers no other model family - the switch is not exercised']);
            return;
        }
        const target = candidates[0]!;

        const setConfig = session.rpc.get('set-session-config');
        expect(setConfig).toBeDefined();
        await setConfig!({ model: target.wire });

        // The ground truth: the agent's own call record names the new model.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: MCODE_E2E_MODEL_OK' },
        }, 'e2e-prompt-5');
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('MCODE_E2E_MODEL_OK'));
            expect(answer).toBeDefined();
        }, 180_000);

        const nativeSessionId = session.metadata.mcodeSessionId as string;
        await vi.waitFor(async () => {
            const call = await readLastModelCall(nativeSessionId);
            expect(call.model).toBe(target.name);
        }, 60_000);

        // A model that reasons by toggle has no thinking-effort levels, so
        // the effort of the old model must not be carried over as a failure.
        const effortFailure = session.sessionEvents.find((event) => {
            return typeof event.message === 'string' && event.message.includes('Failed to switch thinking effort');
        });
        expect(effortFailure, 'the effort of the old model was carried over to a model without effort levels').toBeUndefined();
    }, 300_000);
});
