import { isObject } from '@hapi/protocol'
import { SubagentSnapshotMemberSchema } from '@hapi/protocol/schemas'
import type { SubagentSnapshotMember, ThreadGoal, TodoItem } from '@/types/api'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { isSubagentToolName } from '@/chat/subagentTool'
import { getCodexAgentActivity, getCodexAgentSummary } from '@/components/ToolCard/codexAgents'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'

export type SessionStatusSubagent = {
    id: string
    title: string
    detail: string | null
    state: 'running' | 'waiting' | 'error'
    startedAt: number | null
    endedAt: number | null
    /** Nesting level in the delegation tree (0 = a direct subagent). */
    depth?: number
}

export type SessionStatusTerminal = {
    id: string
    command: string
    cwd: string | null
    startedAt: number
}

export type SessionStatusData = {
    goal: ThreadGoal | null
    tasks: TodoItem[]
    subagents: SessionStatusSubagent[]
    terminals: SessionStatusTerminal[]
    undiscoveredTerminalCount: number
    possibleTerminalCommands: string[]
}

const BACKGROUND_START_RE = /Command running in background with ID:\s*([^\s<]+)/
const TASK_ID_RE = /<task-id>\s*([^<]+?)\s*<\/task-id>/

function findBackgroundTaskId(value: unknown): string | null {
    if (typeof value === 'string') return value.match(BACKGROUND_START_RE)?.[1] ?? null
    const values = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []
    for (const item of values) {
        const taskId = findBackgroundTaskId(item)
        if (taskId) return taskId
    }
    return null
}

function commandFromInput(input: unknown): string | null {
    const command = getInputStringAny(input, ['command', 'cmd'])
    if (command) return command
    if (!isObject(input) || !Array.isArray(input.command)) return null
    const parts = input.command.filter((part): part is string => typeof part === 'string')
    return parts.length > 0 ? parts.join(' ') : null
}

function terminalFromBlock(block: ToolCallBlock): SessionStatusTerminal | null {
    if (block.tool.name !== 'Bash') return null
    const taskId = findBackgroundTaskId(block.tool.result)
    if (!taskId) return null

    return {
        id: taskId,
        command: commandFromInput(block.tool.input) ?? block.tool.description ?? block.tool.name,
        cwd: getInputStringAny(block.tool.input, ['cwd', 'workdir', 'path']),
        startedAt: block.tool.startedAt ?? block.createdAt
    }
}

function collectToolBlocks(blocks: readonly ChatBlock[]): ToolCallBlock[] {
    const tools: ToolCallBlock[] = []
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        tools.push(block, ...collectToolBlocks(block.children))
    }
    return tools
}

function backgroundTaskCompletions(messages: readonly NormalizedMessage[]): {
    ids: Set<string>
    latestUnknownAt: number | null
} {
    const ids = new Set<string>()
    let latestUnknownAt: number | null = null

    for (const message of messages) {
        if (message.role !== 'agent') continue
        for (const content of message.content) {
            if (content.type !== 'sidechain') continue
            const prompt = content.prompt.trimStart()
            if (!prompt.startsWith('<task-notification>')) continue
            const taskId = prompt.match(TASK_ID_RE)?.[1]?.trim()
            if (taskId) ids.add(taskId)
            else latestUnknownAt = Math.max(latestUnknownAt ?? 0, message.createdAt)
        }
    }

    return { ids, latestUnknownAt }
}

function buildBackgroundTerminals(
    tools: readonly ToolCallBlock[],
    messages: readonly NormalizedMessage[]
): { confirmed: SessionStatusTerminal[]; uncertain: SessionStatusTerminal[] } {
    const terminals = tools
        .map(terminalFromBlock)
        .filter((terminal): terminal is SessionStatusTerminal => terminal !== null)
    const completions = backgroundTaskCompletions(messages)
    const remaining = terminals.filter((terminal) => !completions.ids.has(terminal.id))
    const latestUnknownAt = completions.latestUnknownAt
    if (latestUnknownAt === null) return { confirmed: remaining, uncertain: [] }
    return {
        confirmed: remaining.filter((terminal) => terminal.startedAt > latestUnknownAt),
        uncertain: remaining.filter((terminal) => terminal.startedAt <= latestUnknownAt)
    }
}

function subagentTitle(block: ToolCallBlock): string {
    if (block.tool.name === 'CodexAgent') {
        return getCodexAgentSummary(block.tool.input) ?? 'Agent'
    }
    const explicit = getInputStringAny(block.tool.input, ['description', 'summary', 'title'])
    if (explicit) return truncate(explicit.replace(/\s+/g, ' ').trim(), 100)
    const prompt = getInputStringAny(block.tool.input, ['prompt', 'message'])
    if (prompt) return truncate(prompt.replace(/\s+/g, ' ').trim(), 100)
    return getInputStringAny(block.tool.input, ['subagent_type', 'agent_type']) ?? 'Agent'
}

function subagentFromBlock(block: ToolCallBlock): SessionStatusSubagent | null {
    if (block.tool.name !== 'CodexAgent' && !isSubagentToolName(block.tool.name)) return null
    if (block.tool.state === 'completed') return null

    const latestChild = block.children.at(-1)
    const activity = block.tool.name === 'CodexAgent'
        ? getCodexAgentActivity(block.tool.input)
        : latestChild?.kind === 'tool-call'
            ? latestChild.tool.nativeTitle ?? latestChild.tool.name
            : null
    const waiting = block.tool.state === 'pending'
        || (activity?.toLowerCase().startsWith('waiting') ?? false)

    return {
        id: block.tool.id,
        title: subagentTitle(block),
        detail: activity,
        state: block.tool.state === 'error' ? 'error' : waiting ? 'waiting' : 'running',
        startedAt: block.tool.startedAt ?? (block.tool.state === 'pending' ? null : block.createdAt),
        endedAt: block.tool.state === 'error'
            ? block.tool.completedAt ?? block.tool.startedAt ?? block.createdAt
            : null
    }
}

/**
 * The state a delegation snapshot maps onto. Finished members are not listed:
 * the status panel shows the work that is still going on, and the transcript
 * keeps the history.
 */
const SNAPSHOT_SUBAGENT_STATES: Record<
    SubagentSnapshotMember['status'],
    SessionStatusSubagent['state'] | null
> = {
    queued: 'waiting',
    running: 'running',
    failed: 'error',
    completed: null,
    stopped: null,
    unknown: null
}

/** The newest delegation snapshot the session reported, if any. */
export function latestSubagentSnapshot(
    messages: readonly NormalizedMessage[]
): SubagentSnapshotMember[] | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.role !== 'event') continue
        const event = message.content
        if (event.type !== 'subagent-snapshot') continue
        const parsed = SubagentSnapshotMemberSchema.array().safeParse(event.members)
        if (!parsed.success) continue
        return parsed.data
    }
    return null
}

/**
 * Orders the delegation members as a tree: a parent comes before its
 * children, and siblings keep the order the agent reported them in.
 */
function orderByTree(members: readonly SubagentSnapshotMember[]): SubagentSnapshotMember[] {
    const byId = new Map(members.map((member) => [member.id, member]))
    const childrenOf = new Map<string | null, SubagentSnapshotMember[]>()
    for (const member of members) {
        const parentId = member.parentId && byId.has(member.parentId) ? member.parentId : null
        const siblings = childrenOf.get(parentId) ?? []
        siblings.push(member)
        childrenOf.set(parentId, siblings)
    }

    const ordered: SubagentSnapshotMember[] = []
    const visit = (parentId: string | null): void => {
        for (const member of childrenOf.get(parentId) ?? []) {
            ordered.push(member)
            visit(member.id)
        }
    }
    visit(null)
    return ordered
}

/** The subagents a delegation snapshot describes, in tree order. */
export function subagentsFromSnapshot(
    messages: readonly NormalizedMessage[]
): SessionStatusSubagent[] {
    const members = latestSubagentSnapshot(messages)
    if (!members) return []
    return orderByTree(members)
        .map((member): SessionStatusSubagent | null => {
            const state = SNAPSHOT_SUBAGENT_STATES[member.status]
            if (!state) return null
            return {
                id: member.id,
                title: member.title,
                detail: member.detail,
                state,
                startedAt: member.startedAt,
                endedAt: member.endedAt,
                depth: member.depth
            }
        })
        .filter((subagent): subagent is SessionStatusSubagent => subagent !== null)
}

export function buildSessionStatusData(args: {
    goal: ThreadGoal | null | undefined
    tasks: readonly TodoItem[] | null | undefined
    blocks: readonly ChatBlock[]
    messages: readonly NormalizedMessage[]
    backgroundTaskCount?: number
}): SessionStatusData | null {
    const tools = collectToolBlocks(args.blocks)
    const detectedTerminals = buildBackgroundTerminals(tools, args.messages)
    const terminals = args.backgroundTaskCount === undefined
        ? [...detectedTerminals.confirmed, ...detectedTerminals.uncertain]
        : args.backgroundTaskCount > 0
            ? detectedTerminals.confirmed.slice(-args.backgroundTaskCount)
            : []
    const undiscoveredTerminalCount = args.backgroundTaskCount === undefined
        ? 0
        : Math.max(0, args.backgroundTaskCount - terminals.length)
    const possibleTerminalCommands = undiscoveredTerminalCount > 0
        ? detectedTerminals.uncertain.map((terminal) => terminal.command)
        : []
    const snapshotSubagents = subagentsFromSnapshot(args.messages)
    const data: SessionStatusData = {
        goal: args.goal ?? null,
        tasks: args.tasks ? [...args.tasks] : [],
        subagents: [
            ...snapshotSubagents,
            ...tools
                .map(subagentFromBlock)
                .filter((subagent): subagent is SessionStatusSubagent => subagent !== null)
        ],
        terminals,
        undiscoveredTerminalCount,
        possibleTerminalCommands
    }

    return data.goal
        || data.tasks.length > 0
        || data.subagents.length > 0
        || data.terminals.length > 0
        || data.undiscoveredTerminalCount > 0
        ? data
        : null
}
