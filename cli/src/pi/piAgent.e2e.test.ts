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
};

class RecordingSession {
    readonly sessionId = randomUUID();
    state: AgentState = { requests: {} };
    metadata: Metadata;
    /** Every chat message the wrapper sent to the hub. */
    readonly agentMessages: AgentMessage[] = [];
    /** Every session event (the ⚠️ lines and the status messages). */
    readonly sessionEvents: Array<{ type?: string; message?: string }> = [];
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

describe.skipIf(process.env.HAPI_RUN_PI_E2E !== '1')('Pi agent end to end', () => {
    let session: RecordingSession;
    let run: Promise<void>;
    let workingDirectory: string;
    let home: string;
    let transcriptsBefore: Set<string>;

    beforeAll(async () => {
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
        // Vitest replaces `process.exit` with a throwing stub, so the runner's
        // crash handler would re-enter itself forever when it tries to exit.
        // Neutralize it while the session shuts down, then restore it.
        const originalExit = process.exit;
        process.exit = (() => undefined) as unknown as typeof process.exit;
        try {
            // The wrapper's own lifecycle kills Pi as part of its cleanup, so
            // the teardown does not look like a crash to the runner.
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
            process.exit = originalExit;
        }
        await rm(home, { recursive: true, force: true });
        await rm(workingDirectory, { recursive: true, force: true });
    }, 60_000);

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
});
