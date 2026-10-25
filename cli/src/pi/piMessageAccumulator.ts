import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@/agent/types';
import { PiAssistantMessageEventSchema } from './schemas';
import type { PiAgentEvent } from './types';

const DEFAULT_SNAPSHOT_INTERVAL_MS = 1_000;

/**
 * How much text has to grow since the last snapshot before the next one goes
 * out.
 *
 * Every snapshot carries the whole text of the message so far, so the number
 * of snapshots decides the total volume: a message of n characters that is
 * snapshotted k times sends ~n*k/2 characters. Measured against a real Pi
 * turn, a fixed 250 ms interval pushed 47x the answer text over the wire.
 * Pacing by growth instead of by time makes the volume scale with the answer
 * rather than with its duration.
 *
 * The size matches the bash preview step (PI_BASH_PREVIEW_STEP_CHARS): below
 * it, a snapshot cannot show enough new text to be worth the row it replaces.
 */
const DEFAULT_SNAPSHOT_STEP_CHARS = 4 * 1024;

type PiMessageAccumulatorOptions = {
    snapshotIntervalMs?: number;
    snapshotStepChars?: number;
    now?: () => number;
    streamNonceFactory?: () => string;
};

type Segment = {
    text: string;
    lastSnapshot: string;
};

/**
 * Turns Pi's delta stream into throttled, cumulative snapshots. Pi content
 * blocks are independently indexed, so a message with multiple text or thinking
 * blocks never concatenates unrelated blocks into one timeline row. Every
 * accumulator instance has a nonce as a session resume/restart must not reuse a
 * previous timeline stream id.
 */
/**
 * Extract the failure text from a Pi assistant message that ended in error.
 *
 * On a mid-turn LLM/API failure (auth, 5xx, network drop) Pi finalizes the
 * assistant message with `stopReason: 'error'` and an `errorMessage`, emitted
 * on both `message_end` and `turn_end`. `aborted` is user-initiated (web Abort)
 * and intentionally not surfaced as an error. Returns null for anything else.
 */
export function extractPiTurnError(message: unknown): string | null {
    if (typeof message !== 'object' || message === null) return null;
    const record = message as { stopReason?: unknown; errorMessage?: unknown };
    if (record.stopReason !== 'error') return null;
    return typeof record.errorMessage === 'string' && record.errorMessage.length > 0
        ? record.errorMessage
        : 'Pi agent error';
}

export class PiMessageAccumulator {
    private active = false;
    private turnSequence = 0;
    private messageSequence = 0;
    private errorEmitted = false;
    private readonly streamNonce: string;
    private readonly textSegments = new Map<number, Segment>();
    private readonly reasoningSegments = new Map<number, Segment>();
    private lastSnapshotAt: number | null = null;
    /** The text length at the last snapshot, used to measure the growth. */
    private lastSnapshotLength = 0;
    private readonly snapshotIntervalMs: number;
    private readonly snapshotStepChars: number;
    private readonly now: () => number;

    constructor(options: PiMessageAccumulatorOptions = {}) {
        this.snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
        this.snapshotStepChars = options.snapshotStepChars ?? DEFAULT_SNAPSHOT_STEP_CHARS;
        this.now = options.now ?? Date.now;
        this.streamNonce = options.streamNonceFactory?.() ?? randomUUID();
    }

    handleEvent(event: PiAgentEvent): AgentMessage[] {
        if (event.type === 'turn_start') {
            this.turnSequence += 1;
            return [];
        }

        if (event.type === 'message_start') {
            const pending = this.active ? this.flush() : [];
            this.startMessage();
            return pending;
        }

        if (event.type === 'message_update') {
            if (!('assistantMessageEvent' in event)) return [];
            const parsed = PiAssistantMessageEventSchema.safeParse(event.assistantMessageEvent);
            if (!parsed.success || !this.active || !parsed.data.delta) return [];

            const index = parsed.data.contentIndex ?? 0;
            if (parsed.data.type === 'text_delta') {
                this.append(this.textSegments, index, parsed.data.delta);
            } else if (parsed.data.type === 'thinking_delta') {
                this.append(this.reasoningSegments, index, parsed.data.delta);
            } else {
                return [];
            }
            return this.snapshotIfDue();
        }

        if (event.type === 'message_end' || event.type === 'turn_end') {
            const wasActive = this.active;
            const messages = this.flush();
            // Pi reports the failure on both message_end and turn_end; emit the
            // error once (first boundary wins) so the web shows a failed turn
            // instead of silent partial text. turn_end doubles as the safety
            // net for Pi builds that skip message_end on stream failure.
            if (wasActive && !this.errorEmitted && 'message' in event) {
                const errorMessage = extractPiTurnError(event.message);
                if (errorMessage) {
                    messages.push({ type: 'error', message: errorMessage });
                    this.errorEmitted = true;
                }
            }
            return messages;
        }

        if (event.type === 'agent_end') {
            return this.flush();
        }

        return [];
    }

    /** Explicit transport-close/error safety net. Idempotent after a flush. */
    flush(): AgentMessage[] {
        if (!this.active) return [];
        const snapshots = this.createSnapshots(false);
        this.resetMessage();
        return snapshots;
    }

    private startMessage(): void {
        this.active = true;
        this.messageSequence += 1;
        this.errorEmitted = false;
        this.textSegments.clear();
        this.reasoningSegments.clear();
        this.lastSnapshotAt = null;
        this.lastSnapshotLength = 0;
    }

    private append(segments: Map<number, Segment>, index: number, delta: string): void {
        const segment = segments.get(index) ?? { text: '', lastSnapshot: '' };
        segment.text += delta;
        segments.set(index, segment);
    }

    /**
     * Decides whether the grown text is worth a snapshot yet.
     *
     * A snapshot goes out when the text grew by `snapshotStepChars` since the
     * last one, or when `snapshotIntervalMs` elapsed since the last one —
     * whichever comes first. The growth is what paces the traffic; the
     * elapsed time only keeps a slow stream from looking frozen.
     *
     * The very first snapshot of a message always goes out: there is nothing
     * to compare against, and a short answer must not stay invisible until
     * its boundary.
     */
    private snapshotIfDue(): AgentMessage[] {
        const now = this.now();
        const grown = this.currentLength() - this.lastSnapshotLength;
        const elapsed = this.lastSnapshotAt === null
            ? Number.POSITIVE_INFINITY
            : now - this.lastSnapshotAt;
        if (grown < this.snapshotStepChars && elapsed < this.snapshotIntervalMs) {
            return [];
        }
        this.lastSnapshotAt = now;
        return this.createSnapshots(true);
    }

    /** The combined length of the text and reasoning segments. */
    private currentLength(): number {
        let total = 0;
        for (const segment of this.textSegments.values()) total += segment.text.length;
        for (const segment of this.reasoningSegments.values()) total += segment.text.length;
        return total;
    }

    private createSnapshots(live: boolean): AgentMessage[] {
        const messages: AgentMessage[] = [];
        this.addSnapshots(messages, 'reasoning', this.reasoningSegments, live);
        this.addSnapshots(messages, 'text', this.textSegments, live);
        // The next snapshot is paced against what has been sent so far.
        this.lastSnapshotLength = this.currentLength();
        return messages;
    }

    private addSnapshots(
        output: AgentMessage[],
        kind: 'reasoning' | 'text',
        segments: Map<number, Segment>,
        live: boolean,
    ): void {
        for (const [index, segment] of Array.from(segments.entries()).sort(([left], [right]) => left - right)) {
            if (!segment.text.trim() || segment.text === segment.lastSnapshot) continue;
            segment.lastSnapshot = segment.text;
            const id = `pi-${this.streamNonce}-turn-${this.turnSequence}-message-${this.messageSequence}-${kind}-${index}`;
            output.push({
                type: kind,
                text: segment.text,
                id,
                ...(kind === 'text' ? { streamSnapshot: true } : {}),
                ...(live ? { live: true } : {}),
            });
        }
    }

    private resetMessage(): void {
        this.active = false;
        this.textSegments.clear();
        this.reasoningSegments.clear();
        this.lastSnapshotAt = null;
        this.lastSnapshotLength = 0;
    }
}
