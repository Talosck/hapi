/**
 * End-to-end coverage against the installed Pi binary.
 *
 * The unit suite drives a mocked Pi transport, so it proves the wrapper's
 * logic but not that Pi agrees with it. This file drives the real
 * `pi --mode rpc` process through the real wrapper and replaces only the hub
 * with a recording session double, so every assertion below is about what
 * Pi actually did — including the ground truth, which is Pi's own session
 * transcript on disk.
 *
 * It needs the Pi CLI on PATH, a working Pi login and makes real model
 * calls, so it is opt-in:
 *
 *   HAPI_RUN_PI_E2E=1 bun run test:cli -- --run src/pi/piAgent.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { appendFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentState, Metadata } from '@/api/types';

const LOG_PATH = '/tmp/hapi-pi-e2e.log';
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;
let logBytes = 0;

/**
 * The wrapper's own log, so a failed run can be diagnosed afterwards.
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
}));

type AgentMessage = {
    type?: string;
    name?: string;
    message?: string;
    output?: string;
    status?: string;
    live?: boolean;
    streamSnapshot?: boolean;
    /** The token counts of a finished turn. */
    info?: { total?: { totalTokens?: number } };
};

class RecordingSession {
    readonly sessionId = randomUUID();
    state: AgentState = { requests: {} };
    metadata: Metadata;
    /** Every chat message the wrapper sent to the hub. */
    readonly agentMessages: AgentMessage[] = [];
    /** Every session event (the ⚠️ lines and the status messages). */
    readonly sessionEvents: Array<{ type?: string; message?: string }> = [];
    /** Every keepalive runtime the hub was told about. */
    readonly keepAliveRuntimes: Array<{ model?: string; effort?: string | null } | undefined> = [];
    readonly consumed: string[] = [];
    /** Set when the wrapper reported the session as dead (Pi went away). */
    dead = false;
    /**
     * How many partial model outputs the wrapper published. It only grows
     * while Pi is streaming, so it is the signal that a turn is still running.
     */
    streamingUpdates = 0;
    /** Forget the partial outputs seen so far, so a turn can be timed from zero. */
    resetStreamingUpdates(): void { this.streamingUpdates = 0; }
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
            flavor: 'pi',
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
        if (message.live === true || message.streamSnapshot === true) this.streamingUpdates += 1;
        writeLog('hub', [`agentMessage ${JSON.stringify(body).slice(0, 300)}`]);
    }
    sendSessionEvent(body: unknown): void {
        this.sessionEvents.push(body as { type?: string; message?: string });
        writeLog('hub', [`sessionEvent ${JSON.stringify(body).slice(0, 300)}`]);
    }
    emitMessagesConsumed(ids: string[]): void { this.consumed.push(...ids); }
    emitSteerIndeterminate(): void {}
    keepAlive(_thinking?: boolean, _mode?: unknown, runtime?: unknown): void {
        // The runtime is the only place the hub learns which model and which
        // thinking effort the session really runs with.
        this.keepAliveRuntimes.push(runtime as { model?: string; effort?: string | null } | undefined);
    }
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

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() { return state.home; },
        apiUrl: 'http://mock-hub',
        cliApiToken: 'test',
    },
}));

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
        getLogPath: vi.fn(() => '/tmp/hapi-pi-e2e.log'),
    },
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    // The real handler ends the session through the runner lifecycle, which
    // shuts Pi down as part of its own cleanup. The test needs that path so
    // the teardown does not look like a crash.
    registerKillSessionHandler: (
        rpcHandlerManager: { registerHandler: (name: string, fn: (params: unknown) => Promise<unknown>) => void },
        lifecycle: { cleanupAndExit: () => Promise<void> },
    ) => {
        rpcHandlerManager.registerHandler('killSession', async () => {
            void lifecycle.cleanupAndExit();
            return { success: true, message: 'killing', pid: process.pid };
        });
    },
}));
vi.mock('@/agent/localHandoff', () => ({ registerLocalHandoffHandler: vi.fn() }));

import { runPi } from './runPi';

/** The Pi child process, found by the working directory it was started in. */
function findPiChild(cwd: string): number | undefined {
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

/** Every Pi session transcript on this machine. */
async function listPiTranscripts(): Promise<Set<string>> {
    const root = join(homedir(), '.pi', 'agent', 'sessions');
    const found = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
        let entries: string[];
        try { entries = await readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            const path = join(dir, entry);
            if (entry.endsWith('.jsonl')) { found.add(path); continue; }
            let stats;
            try { stats = await stat(path); } catch { continue; }
            if (stats.isDirectory()) await walk(path);
        }
    };
    await walk(root);
    return found;
}

type PiTranscriptEntry = { type: string; message?: { role?: string; content?: unknown } };

function transcriptText(entry: PiTranscriptEntry): string {
    const content = entry.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : ''))
        .join('');
}

/**
 * The newest Pi session transcript on this machine.
 *
 * Pi writes one JSONL file per native session, so this is the ground truth
 * for what the running agent really did — the hub only ever sees what the
 * wrapper chose to forward.
 */
async function newestPiTranscript(): Promise<string> {
    const transcripts = await listPiTranscripts();
    const withTime = await Promise.all([...transcripts].map(async (path) => ({
        path,
        time: (await stat(path)).mtimeMs,
    })));
    withTime.sort((a, b) => b.time - a.time);
    return withTime[0]!.path;
}

/** The raw text of the newest Pi session transcript. */
async function newestPiTranscriptText(): Promise<string> {
    return readFile(await newestPiTranscript(), 'utf8');
}

/**
 * The thinking level Pi recorded last in its own session log.
 *
 * Pi writes a `thinking_level_change` entry whenever the level moves — also
 * when a model switch makes it pick the level of the new model. That entry is
 * the ground truth for the level the agent really runs with.
 */
async function piRecordedThinkingLevel(): Promise<string | undefined> {
    const raw = await newestPiTranscriptText();
    const levels = [...raw.matchAll(/"thinkingLevel"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!);
    return levels[levels.length - 1];
}

describe.skipIf(process.env.HAPI_RUN_PI_E2E !== '1')('Pi agent end to end', () => {
    let session: RecordingSession;
    let run: Promise<void>;
    let workingDirectory: string;
    let home: string;
    let transcriptsBefore: Set<string>;
    let originalProcessExit: typeof process.exit;

    beforeAll(async () => {
        // Vitest replaces `process.exit` with a throwing stub, so the runner's
        // crash handler would re-enter itself forever when it tries to exit.
        // Neutralize it for the whole run, then restore it in the teardown.
        //
        // The override lives in `beforeAll`, not at module level: a skipped
        // suite never runs its hooks, and a module-level override would stay
        // in place for every other test file that the worker picks up
        // afterwards.
        originalProcessExit = process.exit;
        process.exit = (() => undefined) as unknown as typeof process.exit;
        await rm(LOG_PATH, { force: true });
        writeLog('info', ['=== e2e run start ===']);
        home = await mkdtemp(join(tmpdir(), 'hapi-pi-e2e-home-'));
        workingDirectory = await mkdtemp(join(tmpdir(), 'hapi-pi-e2e-cwd-'));
        state.home = home;
        transcriptsBefore = await listPiTranscripts();
        session = new RecordingSession(workingDirectory);
        state.session = session;
        run = runPi({ workingDirectory });
    }, 60_000);

    afterAll(async () => {
        // The wrapper's own lifecycle kills Pi as part of its cleanup, so
        // the teardown does not look like a crash to the runner.
        try {
            const kill = session.rpc.get('killSession');
            if (kill) await kill({});
            await Promise.race([
                run.catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, 20_000)),
            ]);
            // Anything that is still alive has to go, otherwise the Pi child
            // would outlive the test run.
            const pid = findPiChild(workingDirectory);
            if (pid !== undefined) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
            }
        } finally {
            if (originalProcessExit) process.exit = originalProcessExit;
        }
        await rm(home, { recursive: true, force: true });
        await rm(workingDirectory, { recursive: true, force: true });
    }, 60_000);

    it('delivers a prompt that arrives while Pi is still starting', async () => {
        // The wrapper registers its message handler before Pi even starts, so
        // a prompt can arrive in the window before Pi answers its first
        // get_state. That prompt has to be buffered and released later — it
        // must not be swallowed (issue #1143).
        await vi.waitFor(() => {
            expect(session.user).toBeDefined();
        }, 30_000);

        // Pi really was not ready yet — that is the whole point of this link.
        expect(session.metadata.piSessionId).toBeUndefined();

        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: E2E_STARTUP_PROMPT_OK' },
        }, 'e2e-startup-1');

        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('E2E_STARTUP_PROMPT_OK'));
            expect(answer).toBeDefined();
        }, 180_000);

        // The usage of that turn is Pi's own, and the hub has to see it.
        await vi.waitFor(() => {
            const usage = session.agentMessages.find((message) => message.type === 'token_count');
            expect(usage).toBeDefined();
            expect(usage?.info?.total?.totalTokens ?? 0).toBeGreaterThan(0);
        }, 60_000);
    }, 300_000);

    it('reports a compaction the agent refuses without wedging the session', async () => {
        // Pi refuses to compact a session that is too small. The refusal has
        // to reach the user, and the session has to stay usable: this path
        // poisons the runtime lease on a timeout, so a failed compaction must
        // not leave the session unable to run anything else.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: '/compact' },
        }, 'e2e-compact-1');
        await vi.waitFor(() => {
            const report = session.sessionEvents.find((event) => {
                return typeof event.message === 'string' && /Compaction (failed|completed)/.test(event.message);
            });
            expect(report).toBeDefined();
        }, 120_000);

        // The session still answers afterwards.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: E2E_AFTER_COMPACT_OK' },
        }, 'e2e-after-compact-1');
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('E2E_AFTER_COMPACT_OK'));
            expect(session.dead).toBe(false);
            expect(answer).toBeDefined();
        }, 180_000);
    }, 400_000);

    it('titles the chat with the tool that the Pi title extension gives the model', async () => {
        // HAPI ships a Pi extension with a `hapi_change_title` tool, and Pi
        // turns the call into an extension UI request. The hub has to see the
        // title that comes out of it.
        //
        // This runs before the rename test on purpose: a name the user picked
        // is never overwritten, so the title can only be observed while the
        // session still has no user name.
        await vi.waitFor(() => {
            expect(session.metadata.piSessionId).toBeTruthy();
        }, 60_000);

        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Use the hapi_change_title tool to title this chat "Sea Haiku", then write one haiku about the sea.' },
        }, 'e2e-title-1');

        await vi.waitFor(() => {
            expect(session.metadata.name).toBeTruthy();
        }, 180_000);

        // The ground truth: Pi really ran the tool HAPI gave it, and the
        // title really came out of the extension UI channel.
        await vi.waitFor(async () => {
            const raw = await newestPiTranscriptText();
            expect(raw).toContain('hapi_change_title');
        }, 60_000);
    }, 300_000);

    it('runs a prompt, a shell command, a rename, a tree and an aborted steer against the real Pi', async () => {
        const transcript: string[] = [];

        // --- Pi comes up and reports its state -----------------------------
        await vi.waitFor(() => {
            expect(session.metadata.piSessionId).toBeTruthy();
        }, 30_000);
        transcript.push(`Pi is up (native session ${session.metadata.piSessionId}).`);

        // --- A plain prompt gets a real answer ------------------------------
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: E2E_PROMPT_OK' },
        }, 'e2e-prompt-1');
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('E2E_PROMPT_OK'));
            expect(answer).toBeDefined();
        }, 120_000);
        transcript.push('The prompt was answered by the real model.');

        // --- /bash runs a command and reports it as a card -----------------
        const beforeBash = session.agentMessages.length;
        session.user?.({
            role: 'user',
            content: { type: 'text', text: '/bash echo e2e-bash-output' },
        }, 'e2e-bash-1');
        await vi.waitFor(() => {
            const cards = session.agentMessages.slice(beforeBash).filter((message) => {
                return message.type === 'tool-call' && message.name === 'Bash';
            });
            expect(cards.length).toBeGreaterThan(0);
        }, 120_000);
        await vi.waitFor(() => {
            const results = session.agentMessages.slice(beforeBash).filter((message) => {
                return message.type === 'tool-call-result' && String(message.output).includes('e2e-bash-output');
            });
            expect(results.length).toBeGreaterThan(0);
        }, 120_000);
        transcript.push('/bash ran the command and the card carries its real output.');

        // --- /name renames the session --------------------------------------
        session.user?.({
            role: 'user',
            content: { type: 'text', text: '/name e2e-renamed-session' },
        }, 'e2e-name-1');
        await vi.waitFor(() => {
            expect(session.metadata.name).toBe('e2e-renamed-session');
            expect(session.metadata.piUserNamedSession).toBe(true);
        }, 30_000);
        transcript.push('/name renamed the session and marked the name as the user\'s.');

        // --- /tree renders the session tree ----------------------------------
        session.user?.({
            role: 'user',
            content: { type: 'text', text: '/tree' },
        }, 'e2e-tree-1');
        await vi.waitFor(() => {
            const tree = session.sessionEvents.find((event) => typeof event.message === 'string' && event.message.includes('E2E_PROMPT_OK'));
            expect(tree).toBeDefined();
        }, 60_000);
        transcript.push('/tree rendered the session tree with the real entries.');

        // --- An aborted steer is taken back, not replayed -------------------
        //
        // Pi delivers the steering queue when a turn ends, so the abort only
        // has a chance to take the steer back while the turn is still
        // running. The test therefore waits for the model to stream before it
        // steers, and waits for another partial output before it aborts: that
        // proves the turn was still live, so the steer was still queued.
        const marker = `E2E_STEER_${Date.now()}`;
        session.resetStreamingUpdates();
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Write an exhaustive essay of at least 2500 words about the history of printing technology, from woodblock printing to digital presses. Use section headings.' },
        }, 'e2e-prompt-2');
        await vi.waitFor(() => {
            expect(session.streamingUpdates).toBeGreaterThan(0);
        }, 120_000);
        session.user?.({
            role: 'user',
            content: { type: 'text', text: `IMPORTANT: remember to use ${marker}` },
            meta: { deliveryMode: 'steer' },
        }, 'e2e-steer-1');

        // The turn has to outlive the steer, otherwise Pi delivers the steer
        // before the abort arrives and there is nothing left to take back.
        const updatesBeforeAbort = session.streamingUpdates;
        await vi.waitFor(() => {
            expect(session.streamingUpdates).toBeGreaterThan(updatesBeforeAbort);
        }, 30_000);

        const abort = session.rpc.get('abort');
        expect(abort).toBeDefined();
        await abort!({});

        await vi.waitFor(() => {
            const discarded = session.sessionEvents.find((event) => typeof event.message === 'string' && event.message.includes('discarded'));
            expect(discarded).toBeDefined();
        }, 60_000);
        transcript.push('The aborted steer was reported as discarded — the queue cleanup ran.');

        // The steer must not come back in the next turn.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: E2E_AFTER_ABORT_OK' },
        }, 'e2e-prompt-3');
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('E2E_AFTER_ABORT_OK'));
            expect(session.dead).toBe(false);
            expect(answer).toBeDefined();
        }, 120_000);
        transcript.push('The next turn went through.');

        // --- Ground truth: Pi's own transcript --------------------------------
        const transcriptsAfter = await listPiTranscripts();
        const created = [...transcriptsAfter].filter((path) => !transcriptsBefore.has(path));
        expect(created.length).toBeGreaterThan(0);
        // The newest one belongs to this run.
        const createdWithTime = await Promise.all(created.map(async (path) => ({
            path,
            time: (await stat(path)).mtimeMs,
        })));
        createdWithTime.sort((a, b) => b.time - a.time);
        const transcriptPath = createdWithTime[0]!.path;
        transcript.push(`Pi wrote its own transcript to ${transcriptPath}.`);
        const entries = (await readFile(transcriptPath, 'utf8'))
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as PiTranscriptEntry);
        const messages = entries.filter((entry) => entry.type === 'message');
        // A steer Pi never delivered never reaches the transcript, so the
        // marker must not appear anywhere in it.
        const replayed = messages.some((entry) => transcriptText(entry).includes(marker));
        expect(replayed).toBe(false);
        transcript.push('Pi\'s own transcript does not contain the steer at all.');

        // --- What the user would have seen ----------------------------------
        console.log('\n===== Pi end-to-end transcript =====');
        for (const line of transcript) console.log(`  • ${line}`);
        console.log('  chat messages the wrapper sent to the hub:');
        for (const message of session.agentMessages) {
            if (message.type === 'tool-call') console.log(`    [tool-call] ${message.name} (${message.status})`);
            else if (message.type === 'tool-call-result') console.log(`    [tool-result] ${String(message.output).slice(0, 120)}`);
            else console.log(`    [${message.type}] ${String(message.message ?? '').slice(0, 160)}`);
        }
        console.log('  session events the wrapper sent to the hub:');
        for (const event of session.sessionEvents) console.log(`    ${event.message ?? event.type}`);
        console.log('  Pi\'s own transcript (ground truth):');
        for (const entry of messages) {
            const text = transcriptText(entry).replace(/\s+/g, ' ').trim();
            console.log(`    ${entry.message?.role}: ${text.slice(0, 120)}`);
        }
        console.log('=====================================\n');
    }, 600_000);

    it('steers a queued message into the turn that is running', async () => {
        // Pi delivers a steering message after the current turn finished its
        // tool calls and before the next model call, so the turn has to be
        // long enough for the steer to arrive while it is still running.
        const marker = `E2E_STEER_DELIVERED_${Date.now()}`;
        session.resetStreamingUpdates();
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Run the shell command `sleep 25` with the bash tool and then reply with exactly: STEER_TARGET_DONE' },
        }, 'e2e-steer-prompt-1');
        await vi.waitFor(() => {
            expect(session.streamingUpdates).toBeGreaterThan(0);
        }, 120_000);

        // The steer goes in while the turn is still live.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: `IMPORTANT: remember to use ${marker}` },
            meta: { deliveryMode: 'steer' },
        }, 'e2e-steer-2');

        // The ground truth: Pi really delivered the steer into the running
        // turn, so the marker is in Pi's own transcript.
        await vi.waitFor(async () => {
            const raw = await newestPiTranscriptText();
            expect(raw).toContain(marker);
        }, 180_000);

        // The turn still finishes normally afterwards.
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('STEER_TARGET_DONE'));
            expect(session.dead).toBe(false);
            expect(answer).toBeDefined();
        }, 180_000);
    }, 600_000);

    it('publishes the model catalog of the running Pi and switches its thinking effort', async () => {
        // The catalog the hub asks the session for.
        const listModels = session.rpc.get('listPiModels');
        expect(listModels).toBeDefined();
        const catalog = await listModels!({}) as {
            success?: boolean;
            availableModels?: Array<{ provider?: string; modelId?: string }>;
            currentModelId?: string | null;
        };
        expect(catalog.success).toBe(true);
        const models = catalog.availableModels ?? [];
        expect(models.length).toBeGreaterThan(0);
        // Every entry has to be usable as a selector, so both halves of it
        // have to be there.
        for (const model of models) {
            expect(model.provider).toBeTruthy();
            expect(model.modelId).toBeTruthy();
        }

        // The thinking effort: Pi has to take it and say so.
        const setConfig = session.rpc.get('set-session-config');
        expect(setConfig).toBeDefined();
        const applied = await setConfig!({ effort: 'low' }) as { applied?: { effort?: string | null } };
        expect(applied.applied?.effort).toBe('low');

        // The ground truth: Pi's own session log records the level change.
        await vi.waitFor(async () => {
            const raw = await newestPiTranscriptText();
            expect(raw).toMatch(/"thinkingLevel"\s*:\s*"low"/);
        }, 60_000);
    }, 300_000);

    it('switches the model of the running Pi and Pi really uses it', async () => {
        const listModels = session.rpc.get('listPiModels');
        expect(listModels).toBeDefined();
        const catalog = await listModels!({}) as {
            availableModels?: Array<{ provider?: string; modelId?: string }>;
        };
        const models = catalog.availableModels ?? [];
        const selected = session.metadata.piSelectedModel as { modelId?: string } | undefined;
        const target = models.find((model) => model.modelId !== selected?.modelId);
        expect(target).toBeDefined();

        const setConfig = session.rpc.get('set-session-config');
        expect(setConfig).toBeDefined();
        const applied = await setConfig!({
            model: { provider: target!.provider, modelId: target!.modelId },
        }) as { applied?: { model?: { provider?: string; modelId?: string } } };
        expect(applied.applied?.model?.modelId).toBe(target!.modelId);
        expect(applied.applied?.model?.provider).toBe(target!.provider);

        // The hub's own selection follows the switch.
        await vi.waitFor(() => {
            const current = session.metadata.piSelectedModel as { modelId?: string; provider?: string } | undefined;
            expect(current?.modelId).toBe(target!.modelId);
            expect(current?.provider).toBe(target!.provider);
        }, 30_000);

        // The ground truth: Pi's own session log records the model change.
        await vi.waitFor(async () => {
            const raw = await newestPiTranscriptText();
            expect(raw).toMatch(new RegExp(`"modelId"\\s*:\\s*"${target!.modelId!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
        }, 60_000);

        // Pi picks the thinking level of the new model itself, and the hub
        // has to be told the level the agent really runs with — not the one
        // of the model that was running before.
        await vi.waitFor(async () => {
            const level = await piRecordedThinkingLevel();
            expect(level).toBeTruthy();
            const told = session.keepAliveRuntimes
                .filter((runtime): runtime is { model?: string; effort?: string | null } => runtime !== undefined);
            expect(told.length).toBeGreaterThan(0);
            expect(told[told.length - 1]?.effort).toBe(level);
        }, 60_000);
    }, 300_000);

    it('reports the session stats of the running Pi', async () => {
        const before = session.sessionEvents.length;
        session.user?.({
            role: 'user',
            content: { type: 'text', text: '/session' },
        }, 'e2e-session-1');
        await vi.waitFor(() => {
            const stats = session.sessionEvents.slice(before).find((event) => {
                return typeof event.message === 'string' && event.message.includes('Pi session stats');
            });
            expect(stats).toBeDefined();
            // The numbers are the agent's own, not a placeholder.
            expect(String(stats?.message)).toMatch(/Tokens: total \d+/);
        }, 60_000);
    }, 120_000);

    it('publishes the slash commands and the skills of the running Pi', async () => {
        const listCommands = session.rpc.get('listSlashCommands');
        expect(listCommands).toBeDefined();
        const commands = await listCommands!({}) as {
            success?: boolean;
            commands?: Array<{ name?: string }>;
        };
        expect(commands.success).toBe(true);
        const names = (commands.commands ?? []).map((command) => command.name);
        // The built-ins Pi's RPC surface can actually serve.
        expect(names).toContain('compact');
        expect(names).toContain('session');
        expect(names).toContain('model');
        expect(names).toContain('bash');
        expect(names).toContain('tree');
        expect(names).toContain('name');
        expect(names).toContain('help');

        const listSkills = session.rpc.get('listSkills');
        expect(listSkills).toBeDefined();
        const skills = await listSkills!({}) as { success?: boolean; skills?: unknown[] };
        expect(skills.success).toBe(true);
        expect(Array.isArray(skills.skills)).toBe(true);
    }, 120_000);

    it('refuses a terminal-only Pi command instead of passing it to the model', async () => {
        const before = session.sessionEvents.length;
        session.user?.({
            role: 'user',
            content: { type: 'text', text: '/export' },
        }, 'e2e-export-1');
        await vi.waitFor(() => {
            const refusal = session.sessionEvents.slice(before).find((event) => {
                return typeof event.message === 'string' && event.message.includes('terminal-only');
            });
            expect(refusal).toBeDefined();
        }, 60_000);
    }, 120_000);

    it('forks the conversation of the running Pi', async () => {
        const transcriptsBefore = await listPiTranscripts();
        const nativeSessionIdBefore = session.metadata.piSessionId;

        const fork = session.rpc.get('fork-conversation');
        expect(fork).toBeDefined();
        const result = await fork!({}) as { nativeSessionId?: string; error?: string };
        expect(result.nativeSessionId, result.error).toBeTruthy();
        expect(result.nativeSessionId).not.toBe(nativeSessionIdBefore);

        // The ground truth: Pi really wrote a second session of its own.
        await vi.waitFor(async () => {
            const transcriptsAfter = await listPiTranscripts();
            const created = [...transcriptsAfter].filter((path) => !transcriptsBefore.has(path));
            expect(created.length).toBeGreaterThan(0);
            const withTime = await Promise.all(created.map(async (path) => ({ path, time: (await stat(path)).mtimeMs })));
            withTime.sort((a, b) => b.time - a.time);
            expect(withTime[0]!.path).toContain(result.nativeSessionId!);
        }, 60_000);
    }, 300_000);

    it('rewinds the conversation of the running Pi to an earlier message', async () => {
        const nativeSessionIdBefore = session.metadata.piSessionId;

        const rewind = session.rpc.get('rewind-conversation');
        expect(rewind).toBeDefined();
        const result = await rewind!({ messageLocalId: 'e2e-prompt-1' }) as {
            success?: boolean;
            error?: string;
            outcome?: string;
        };
        expect(result.success, result.error).toBe(true);

        // Pi forks the session at that message, so the running session has a
        // new native identity.
        await vi.waitFor(() => {
            expect(session.metadata.piSessionId).toBeTruthy();
            expect(session.metadata.piSessionId).not.toBe(nativeSessionIdBefore);
        }, 60_000);

        // The session is still usable after the rewind.
        session.user?.({
            role: 'user',
            content: { type: 'text', text: 'Reply with exactly: E2E_AFTER_REWIND_OK' },
        }, 'e2e-after-rewind-1');
        await vi.waitFor(() => {
            const answer = session.agentMessages.find((message) => JSON.stringify(message).includes('E2E_AFTER_REWIND_OK'));
            expect(session.dead).toBe(false);
            expect(answer).toBeDefined();
        }, 120_000);
    }, 300_000);
});
