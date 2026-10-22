import { describe, expect, it } from 'vitest'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { buildSessionStatusData, latestBackgroundTaskSnapshot } from './sessionStatus'

function toolBlock(overrides: Omit<Partial<ToolCallBlock>, 'tool'> & {
    name: string
    tool?: Partial<ToolCallBlock['tool']>
}): ToolCallBlock {
    const { name, tool, ...blockOverrides } = overrides
    return {
        kind: 'tool-call',
        id: overrides.id ?? `block-${name}`,
        localId: null,
        createdAt: overrides.createdAt ?? 100,
        children: overrides.children ?? [],
        tool: {
            id: tool?.id ?? `tool-${name}`,
            name,
            state: tool?.state ?? 'running',
            input: tool?.input ?? {},
            createdAt: overrides.createdAt ?? 100,
            startedAt: tool?.startedAt ?? null,
            completedAt: tool?.completedAt ?? null,
            execStartedAt: null,
            execCompletedAt: null,
            description: tool?.description ?? null,
            result: tool?.result
        },
        ...blockOverrides
    }
}

function taskNotification(taskId?: string): NormalizedMessage {
    return {
        id: `notification-${taskId ?? 'anonymous'}`,
        localId: null,
        createdAt: 200,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'sidechain',
            uuid: 'notification',
            parentUUID: null,
            prompt: `<task-notification>${taskId ? `<task-id>${taskId}</task-id>` : ''}<summary>Done</summary></task-notification>`
        }]
    }
}

function backgroundTaskSnapshot(tasks: unknown): NormalizedMessage {
    return {
        id: 'background-task-snapshot',
        localId: null,
        createdAt: 300,
        role: 'event',
        isSidechain: false,
        content: { type: 'background-task-snapshot', tasks } as never
    }
}

describe('latestBackgroundTaskSnapshot', () => {
    it('returns null when the session never published one', () => {
        expect(latestBackgroundTaskSnapshot([])).toBeNull()
    })

    it('reads the newest snapshot the session published', () => {
        const messages: NormalizedMessage[] = [
            backgroundTaskSnapshot([{ id: 'bg_1', command: 'npm run dev', cwd: '/repo', startedAt: 1 }]),
            backgroundTaskSnapshot([{ id: 'bg_2', command: 'npm test', cwd: '/repo', startedAt: 2 }])
        ]

        expect(latestBackgroundTaskSnapshot(messages)).toEqual([
            { id: 'bg_2', command: 'npm test', cwd: '/repo', startedAt: 2 }
        ])
    })

    it('ignores a snapshot the client cannot read', () => {
        expect(latestBackgroundTaskSnapshot([backgroundTaskSnapshot([{ id: 'bg_1' }])])).toBeNull()
    })
})

describe('buildSessionStatusData', () => {
    it('returns null when the session has no hidden status', () => {
        expect(buildSessionStatusData({ goal: null, tasks: [], blocks: [], messages: [] })).toBeNull()
    })

    it('keeps goal and ordered task snapshots', () => {
        const goal = {
            threadId: 'thread-1',
            objective: 'Ship status panel',
            status: 'active' as const,
            tokenBudget: 50_000,
            tokensUsed: 10_000,
            timeUsedSeconds: 120,
            createdAt: 1,
            updatedAt: 2
        }
        const tasks = [
            { id: '1', content: 'Research', priority: 'medium' as const, status: 'completed' as const },
            { id: '2', content: 'Implement', priority: 'high' as const, status: 'in_progress' as const }
        ]

        expect(buildSessionStatusData({ goal, tasks, blocks: [], messages: [] })).toMatchObject({ goal, tasks })
    })

    it('lists only active or failed subagents', () => {
        const blocks: ChatBlock[] = [
            toolBlock({ name: 'CodexAgent', tool: { id: 'agent-1', state: 'running', input: { summary: 'Inspect API', activity: 'Reading files' } } }),
            toolBlock({ name: 'Agent', tool: { id: 'agent-2', state: 'error', input: { description: 'Review changes' } } }),
            toolBlock({ name: 'Agent', tool: { id: 'agent-pending', state: 'pending', input: { description: 'Needs permission' } } }),
            toolBlock({
                name: 'Task',
                tool: { id: 'agent-3', state: 'completed', input: { description: 'Done' } },
                children: [
                    toolBlock({ name: 'Agent', tool: { id: 'agent-4', input: { description: 'Nested work' } } })
                ]
            })
        ]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks, messages: [] })?.subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', title: 'Inspect API', detail: 'Reading files', state: 'running', endedAt: null }),
            expect.objectContaining({ id: 'agent-2', title: 'Review changes', state: 'error', endedAt: 100 }),
            expect.objectContaining({ id: 'agent-pending', state: 'waiting', startedAt: null }),
            expect.objectContaining({ id: 'agent-4', title: 'Nested work', state: 'running' })
        ])
    })

    it('shows the background work the session published instead of guessing from the transcript', () => {
        const messages: NormalizedMessage[] = [
            backgroundTaskSnapshot([
                { id: 'bg_1', command: 'npm run dev', cwd: '/repo/web', startedAt: 1000 }
            ])
        ]

        const data = buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks: [],
            messages,
            backgroundTaskCount: 1
        })

        expect(data?.terminals).toEqual([
            { id: 'bg_1', command: 'npm run dev', cwd: '/repo/web', startedAt: 1000 }
        ])
        // The session says what it is running, so there is nothing left to
        // discover and nothing to guess.
        expect(data?.undiscoveredTerminalCount).toBe(0)
        expect(data?.possibleTerminalCommands).toEqual([])
    })

    it('shows no terminals when the session published an empty list', () => {
        const data = buildSessionStatusData({
            goal: {
                threadId: 'thread-1',
                objective: 'Ship status panel',
                status: 'active',
                tokenBudget: 50_000,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 1
            },
            tasks: [],
            blocks: [],
            messages: [backgroundTaskSnapshot([])],
            backgroundTaskCount: 0
        })

        expect(data?.terminals ?? []).toEqual([])
        expect(data?.undiscoveredTerminalCount).toBe(0)
    })

    it('tracks Claude background terminals until their task notification arrives', () => {
        const blocks: ChatBlock[] = [toolBlock({
            name: 'Agent',
            tool: { state: 'completed' },
            children: [
                toolBlock({
                    name: 'Bash',
                    tool: {
                        id: 'bash-1',
                        state: 'completed',
                        input: { command: 'bun run dev', cwd: '/repo/web' },
                        result: 'Command running in background with ID: bg-1',
                        startedAt: 123
                    }
                }),
                toolBlock({
                    name: 'Bash',
                    tool: {
                        id: 'bash-2',
                        state: 'completed',
                        input: { command: 'bun test --watch' },
                        result: [{ type: 'text', text: 'Command running in background with ID: bg-2' }]
                    }
                }),
                toolBlock({
                    name: 'Read',
                    tool: { result: 'Command running in background with ID: not-a-terminal' }
                })
            ]
        })]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks, messages: [taskNotification('bg-1')] })?.terminals).toEqual([
            { id: 'bg-2', command: 'bun test --watch', cwd: null, startedAt: 100 }
        ])
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks,
            messages: [],
            backgroundTaskCount: 0
        })).toBeNull()
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks: [],
            messages: [],
            backgroundTaskCount: 2
        })).toMatchObject({ terminals: [], undiscoveredTerminalCount: 2 })
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks,
            messages: [taskNotification()],
            backgroundTaskCount: 1
        })).toMatchObject({
            terminals: [],
            undiscoveredTerminalCount: 1,
            possibleTerminalCommands: ['bun run dev', 'bun test --watch']
        })
    })
})

function delegationSnapshot(members: unknown[]): NormalizedMessage {
    return {
        id: 'snapshot-1',
        localId: null,
        createdAt: 300,
        role: 'event',
        isSidechain: false,
        content: {
            type: 'subagent-snapshot',
            members
        }
    }
}

describe('delegation snapshots', () => {
    it('lists the subagents of the latest delegation snapshot', () => {
        const messages = [delegationSnapshot([
            {
                id: 'child-1',
                parentId: 'session-1',
                title: 'Explore the API',
                detail: 'explore',
                status: 'running',
                startedAt: 5,
                endedAt: null,
                depth: 0
            },
            {
                id: 'child-2',
                parentId: 'child-1',
                title: 'Nested',
                detail: 'nested',
                status: 'queued',
                startedAt: 6,
                endedAt: null,
                depth: 1
            },
            {
                id: 'child-3',
                parentId: 'session-1',
                title: 'Done already',
                detail: null,
                status: 'completed',
                startedAt: 7,
                endedAt: 9,
                depth: 0
            }
        ])]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks: [], messages })

        expect(data?.subagents).toEqual([
            {
                id: 'child-1',
                title: 'Explore the API',
                detail: 'explore',
                state: 'running',
                startedAt: 5,
                endedAt: null,
                depth: 0
            },
            {
                id: 'child-2',
                title: 'Nested',
                detail: 'nested',
                state: 'waiting',
                startedAt: 6,
                endedAt: null,
                depth: 1
            }
        ])
    })

    it('keeps the newest delegation snapshot', () => {
        const messages = [
            delegationSnapshot([{
                id: 'old',
                parentId: null,
                title: 'Old',
                detail: null,
                status: 'running',
                startedAt: 1,
                endedAt: null,
                depth: 0
            }]),
            {
                ...delegationSnapshot([{
                    id: 'new',
                    parentId: null,
                    title: 'New',
                    detail: null,
                    status: 'running',
                    startedAt: 2,
                    endedAt: null,
                    depth: 0
                }]),
                id: 'snapshot-2',
                createdAt: 400
            }
        ]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks: [], messages })

        expect(data?.subagents.map((subagent) => subagent.id)).toEqual(['new'])
    })

    it('ignores a malformed delegation snapshot', () => {
        const messages = [delegationSnapshot([{ id: 'child-1' }])]

        expect(buildSessionStatusData({ goal: null, tasks: [], blocks: [], messages })).toBeNull()
    })
})

describe('subagent counting', () => {
    function snapshotMember(overrides: Partial<{
        id: string
        title: string
        status: string
    }>): Record<string, unknown> {
        return {
            id: overrides.id ?? 'mvs-child-1',
            parentId: 'session-1',
            title: overrides.title ?? 'Audit the web side',
            detail: 'explore',
            status: overrides.status ?? 'running',
            startedAt: 5,
            endedAt: null,
            depth: 0
        }
    }

    function taskBlock(id: string, description: string): ToolCallBlock {
        return toolBlock({
            id: `block-${id}`,
            name: 'Task',
            tool: { id, state: 'running', input: { description } }
        })
    }

    it('counts a subagent once when the snapshot and the tool block describe it', () => {
        const messages = [delegationSnapshot([
            snapshotMember({ id: 'mvs-child-1', title: 'Audit the web side' }),
            snapshotMember({ id: 'mvs-child-2', title: 'Audit the utils' })
        ])]
        const blocks = [
            taskBlock('call-1', 'Audit the web side'),
            taskBlock('call-2', 'Audit the utils')
        ]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks, messages })

        expect(data?.subagents.map((subagent) => subagent.id)).toEqual(['mvs-child-1', 'mvs-child-2'])
    })

    it('keeps a tool block for an agent the snapshot does not mention', () => {
        const messages = [delegationSnapshot([snapshotMember({ id: 'mvs-child-1', title: 'Audit the web side' })])]
        const blocks = [
            taskBlock('call-1', 'Audit the web side'),
            taskBlock('call-2', 'Audit something else')
        ]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks, messages })

        expect(data?.subagents.map((subagent) => subagent.id)).toEqual(['mvs-child-1', 'call-2'])
    })

    it('drops the tool block of a subagent the snapshot already finished', () => {
        const messages = [delegationSnapshot([
            snapshotMember({ id: 'mvs-child-1', title: 'Audit the web side', status: 'completed' })
        ])]
        const blocks = [taskBlock('call-1', 'Audit the web side')]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks, messages })

        expect(data?.subagents ?? []).toEqual([])
    })

    it('counts two agents that share a task description twice', () => {
        const messages = [delegationSnapshot([
            snapshotMember({ id: 'mvs-child-1', title: 'Same title' }),
            snapshotMember({ id: 'mvs-child-2', title: 'Same title' })
        ])]
        const blocks = [taskBlock('call-1', 'Same title')]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks, messages })

        expect(data?.subagents.map((subagent) => subagent.id)).toEqual(['mvs-child-1', 'mvs-child-2'])
    })

    it('matches a task description the tool block had to truncate', () => {
        const description = `Audit the web side ${'x'.repeat(120)}`
        const messages = [delegationSnapshot([snapshotMember({ id: 'mvs-child-1', title: description })])]
        const blocks = [taskBlock('call-1', description)]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks, messages })

        expect(data?.subagents.map((subagent) => subagent.id)).toEqual(['mvs-child-1'])
    })

    it('lists tool block subagents when the session reports no delegation snapshot', () => {
        const blocks = [taskBlock('call-1', 'Inspect the API')]

        const data = buildSessionStatusData({ goal: null, tasks: [], blocks, messages: [] })

        expect(data?.subagents.map((subagent) => subagent.id)).toEqual(['call-1'])
    })
})

describe('buildSessionStatusData alwaysVisible', () => {
    it('keeps the panel rendered when a session supports goals but has none yet', () => {
        // The goal controls live in the panel, so a session whose agent
        // supports goals needs the panel to exist before the first goal.
        expect(buildSessionStatusData({
            goal: null,
            tasks: [],
            blocks: [],
            messages: [],
            alwaysVisible: true
        })).toMatchObject({ goal: null, tasks: [], subagents: [] })
    })

    it('still hides an empty panel without the flag', () => {
        expect(buildSessionStatusData({ goal: null, tasks: [], blocks: [], messages: [] })).toBeNull()
    })
})
