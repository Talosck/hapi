import type { AgentState } from '@/types/api'
import type { AgentEvent, ChatBlock, NormalizedMessage, RoundSummary, UsageData } from '@/chat/types'
import type { ThreadGoal } from '@/types/api'
import { traceMessages, type TracedMessage } from '@/chat/tracer'
import { dedupeAgentEvents, foldApiErrorEvents } from '@/chat/reducerEvents'
import { collectTitleChanges, ensureToolBlock, getPermissions } from '@/chat/reducerTools'
import { reduceTimeline } from '@/chat/reducerTimeline'
import { isRedundantGoalStatusMessageText } from '@hapi/protocol/messages'

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
    if (typeof usage.context_tokens === 'number') {
        return usage.context_tokens
    }
    const cacheTokens = (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    // An inclusive input already contains the cache hits, so adding them
    // again would report a context larger than the window (and a cached count
    // larger than the used one).
    if (usage.input_includes_cache) {
        return usage.input_tokens
    }
    return usage.input_tokens + cacheTokens
}

/**
 * Whether a message's usage describes the *parent* thread's context.
 *
 * A Task subagent runs with its own, much smaller context, so letting its usage
 * through makes the status bar's numerator collapse mid-run and snap back when
 * the parent resumes. `scope_role` alone cannot catch this: Claude never stamps
 * it (see sdkToLogConverter.ts), and Codex drops child `token_count` events in
 * the CLI before they reach us — so the guard never actually fires on any path.
 * `isSidechain` is the signal that survives both.
 */
function isUsageVisibleInParentContext(msg: NormalizedMessage): boolean {
    if (msg.isSidechain) return false
    return msg.usage?.scope_role !== 'child'
}

/**
 * Whether a usage sample actually measured anything.
 *
 * Some Anthropic-compatible providers answer with an all-zero usage block
 * (input 0, output 0, no cache counts). The reducer keeps the newest usage
 * message, so such a sample would overwrite the measured context with 0 and
 * the status bar would report "0% · 0 / 1M" for a session that is actually
 * half full. Ignoring it keeps the last real measurement on screen.
 *
 * A sample that reports a context size of its own (the post-compaction
 * refresh carries the boundary's post-tokens in `context_tokens`) is a real
 * measurement even though its input/output counts are zero, so it still counts.
 */
function isMeasuredUsage(usage: UsageData): boolean {
    if (typeof usage.context_tokens === 'number' && usage.context_tokens > 0) return true
    const cacheTokens = (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    return usage.input_tokens > 0 || usage.output_tokens > 0 || cacheTokens > 0
}

/**
 * The usage a Claude turn reported on its result frame.
 *
 * Claude's remote (SDK) path reports an all-zero usage block on every
 * assistant frame and carries the real numbers only on the turn's result
 * frame, which reaches the web as a turn-summary event. The turn's own
 * usage is the increment of that turn, so it is what the status bar shows
 * once the turn is over.
 *
 * Returns null when the summary carries no measurable usage, so a summary
 * without tokens never replaces a real measurement.
 */
function usageFromRoundSummary(summary: RoundSummary | undefined): UsageData | null {
    if (!summary) return null
    const usage = summary.usage
    if (!usage) return null
    if (!isMeasuredUsage(usage)) return null
    // The window the agent was measured against. Claude reports it per model,
    // and without it the status bar falls back to a heuristic that can be
    // wrong by a factor of five.
    const contextWindow = usage.context_window
        ?? Object.values(summary.modelUsage)
            .map((modelUsage) => modelUsage.contextWindow)
            .find((window): window is number => typeof window === 'number' && window > 0)
    return {
        ...usage,
        context_window: contextWindow
    }
}

/**
 * Whether a message is the summary of a finished turn.
 */
function isTurnSummaryMessage(msg: NormalizedMessage): boolean {
    if (msg.role !== 'event') return false
    const content = msg.content
    if (!content || typeof content !== 'object' || !('type' in content)) return false
    return (content as { type: string }).type === 'turn-summary'
}

/**
 * The usage a message reports, if it reports one.
 *
 * A turn-summary carries the turn's usage in place of the assistant frame's
 * own, so both are read from the same place.
 */
function messageUsage(msg: NormalizedMessage): UsageData | null {
    if (isTurnSummaryMessage(msg)) {
        const content = msg.content as { summary?: RoundSummary }
        return usageFromRoundSummary(content.summary)
    }
    return msg.usage ?? null
}

/**
 * Where a usage sample came from.
 *
 * A frame reports the context of a single request, which is what the context
 * bar shows. A turn reports the work of a whole turn — every request of it
 * summed — which is a different number: it grows with the number of requests
 * and can exceed the window even when the context never came close to it.
 */
export type UsageSource = 'frame' | 'turn'

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    contextWindow: number | null
    /**
     * Model reported by the usage-bearing message itself. Local-mode Claude
     * sessions often have session.model = null (the model is picked inside the
     * TUI), so this is the only model signal available for the context-window
     * heuristic when the usage carries no explicit context_window.
     */
    model: string | null
    timestamp: number
    /**
     * Which kind of measurement this is, so the status bar can tell a
     * context size from a turn's processing volume.
     */
    source: UsageSource
}

export type ReduceChatBlocksOptions = {
    goalStateMessages?: NormalizedMessage[]
}

function getLatestThreadGoal(normalized: NormalizedMessage[]): ThreadGoal | null {
    let sawNewerNonGoalUserMessage = false
    // The threads whose goal a newer clear event took away. A clear that
    // names a thread only takes that thread's goal, so the goal of another
    // thread stays.
    const clearedThreadIds: string[] = []
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.role === 'user') {
            if (!/^\s*\/goal(?:\s|$)/i.test(msg.content.text)) {
                sawNewerNonGoalUserMessage = true
            }
            continue
        }
        if (msg.role !== 'event') continue
        const event = msg.content as AgentEvent
        if (event.type === 'thread-goal-cleared') {
            const threadId = (event as { threadId?: string }).threadId
            if (!threadId) return null
            clearedThreadIds.push(threadId)
            continue
        }
        if (event.type === 'thread-goal-updated') {
            const goal = (event as { goal?: ThreadGoal }).goal ?? null
            if (!goal) continue
            if (goal.threadId && clearedThreadIds.includes(goal.threadId)) continue
            if (goal.status === 'complete' && sawNewerNonGoalUserMessage) {
                return null
            }
            return goal
        }
    }
    return null
}

function isRedundantGoalStatusMessage(event: AgentEvent): boolean {
    if (event.type !== 'message') return false
    return isRedundantGoalStatusMessageText(event.message)
}

/**
 * Session state that belongs in the status panel, not in the timeline: the
 * goal of the session and the live delegation tree. The web renders them in
 * the session status panel, so a timeline row would only repeat them.
 */
function isSilentStateEventBlock(block: ChatBlock): boolean {
    return block.kind === 'agent-event'
        && (
            block.event.type === 'thread-goal-updated'
            || block.event.type === 'thread-goal-cleared'
            || block.event.type === 'subagent-snapshot'
            || block.event.type === 'background-task-snapshot'
            || isRedundantGoalStatusMessage(block.event)
        )
}

function filterSilentStateBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const filtered: ChatBlock[] = []

    for (const block of blocks) {
        if (isSilentStateEventBlock(block)) continue
        if (block.kind === 'tool-call' && block.children.length > 0) {
            filtered.push({
                ...block,
                children: filterSilentStateBlocks(block.children)
            })
            continue
        }
        filtered.push(block)
    }

    return filtered
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined,
    options: ReduceChatBlocksOptions = {}
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null; latestGoal: ThreadGoal | null } {
    const permissionsById = getPermissions(agentState)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else {
            root.push(msg)
        }
    }

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = { permissionsById, groups, consumedGroupIds, titleChangesByToolUseId, emittedTitleChangeToolUseIds }
    const rootResult = reduceTimeline(root, reducerContext)
    let hasReadyEvent = rootResult.hasReadyEvent

    // Synthesize a tool card only for a *pending* permission that is not
    // rendered anywhere in the final block tree — so the user can still
    // answer it when its tool_use message hasn't loaded. A resolved request
    // (approved/denied/canceled) is history: agentState keeps it in
    // completedRequests, but synthesizing it here appends a card to the end
    // of the timeline (there is no chronological re-sort), pinning a stale
    // "answered" card above the composer forever. Resolved requests render
    // only via their own message, when it is in the window.
    // Also skip if the permission is older than the oldest message in the
    // current view, to avoid mixing old tool cards with newer messages when
    // paginating.
    //
    // The check must walk the *rendered* tree (including blocks nested under
    // Task/Agent cards), not raw transcript ids: the tracer drops sidechain
    // messages it cannot attribute to a parent Task (no parentToolUseId and
    // no prompt-holding sidechain root — e.g. background subagents), so a
    // raw-id check suppresses this fallback for a card that was never
    // rendered, leaving the pending permission answerable nowhere
    // (hapi#1073).
    const renderedToolBlockIds = new Set<string>()
    const collectRenderedToolBlockIds = (list: ChatBlock[]): void => {
        for (const block of list) {
            if (block.kind !== 'tool-call') continue
            renderedToolBlockIds.add(block.id)
            collectRenderedToolBlockIds(block.children)
        }
    }
    collectRenderedToolBlockIds(rootResult.blocks)

    const oldestMessageTime = normalized.length > 0
        ? Math.min(...normalized.map(m => m.createdAt))
        : null

    for (const [id, entry] of permissionsById) {
        if (entry.permission.status !== 'pending') continue
        if (renderedToolBlockIds.has(id)) continue

        const createdAt = entry.permission.createdAt ?? Date.now()

        // Skip permissions that are older than the oldest message in the current view.
        // These will be shown when the user loads older messages.
        if (oldestMessageTime !== null && createdAt < oldestMessageTime) {
            continue
        }

        ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })
    }

    // Calculate latest usage from messages (find the most recent message with usage data)
    //
    // A turn's usage can arrive in two places. Claude's local (transcript) path
    // reports it on the assistant frame itself, while its remote (SDK) path
    // reports an all-zero block there and carries the real numbers on the
    // turn's result frame, which reaches the web as a turn-summary event.
    // Both are read, newest first, so whichever carries a real measurement
    // wins.
    //
    // The window the usage is measured against is looked up separately: a
    // turn-summary does not carry one, but the assistant frames of the same
    // turn do (the CLI stamps it), and without it the status bar falls back to
    // a heuristic that can be off by a factor of five. Only the frames up to
    // the measured message count — a session that switched models would
    // otherwise be measured against the window of the model it left.
    const contextWindows: Array<{ index: number; window: number }> = []
    normalized.forEach((msg, index) => {
        const window = msg.usage?.context_window
        if (typeof window === 'number' && window > 0) contextWindows.push({ index, window })
    })
    // The window of the newest frame at or before the measured message. The
    // newest one is the one the session was on: a session that switched
    // models would otherwise be measured against the window of the model it
    // left.
    const windowBefore = (index: number): number | null => {
        let newest: { index: number; window: number } | null = null
        for (const entry of contextWindows) {
            if (entry.index > index) break
            if (!newest || entry.index > newest.index) newest = entry
        }
        return newest?.window ?? null
    }

    let latestUsage: LatestUsage | null = null
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        const usage = messageUsage(msg)
        if (!usage || !isUsageVisibleInParentContext(msg) || !isMeasuredUsage(usage)) {
            continue
        }
        const contextWindow = usage.context_window ?? windowBefore(i)
        latestUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            contextSize: calculateContextSize(usage),
            contextWindow,
            model: msg.model ?? null,
            timestamp: msg.createdAt,
            source: isTurnSummaryMessage(msg) ? 'turn' : 'frame'
        }
        break
    }

    return {
        blocks: filterSilentStateBlocks(dedupeAgentEvents(foldApiErrorEvents(rootResult.blocks))),
        hasReadyEvent,
        latestUsage,
        latestGoal: getLatestThreadGoal(options.goalStateMessages ?? normalized)
    }
}
