/**
 * Live verification of the P0/P1 mcode extension work against the real agent.
 *
 * Uses the CLI's own AcpSdkBackend + McodeExtensionControl so the check
 * exercises the shipped code path, not a re-implementation of it.
 */
import { AcpSdkBackend } from '@/agent/backends/acp'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { MCODE_EXTENSION_CAPABILITY_META } from '@/mcode/utils/mcodeExtensions'
import { McodeExtensionControl } from '@/mcode/utils/mcodeExtensionControl'

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) result[key] = value
    }
    return result
}

const backend = new AcpSdkBackend({
    command: getAgentLaunchCommand('mcode'),
    args: ['acp'],
    env: filterEnv(process.env),
    textChunkMode: 'delta',
    flavor: 'mcode',
    elicitation: { form: true },
    plan: true,
    clientCapabilityMeta: MCODE_EXTENSION_CAPABILITY_META
})

await backend.initialize()

const meta = backend.getInitializeMeta()
console.log('P0 initialize _meta keys:', Object.keys(meta ?? {}))
const control = new McodeExtensionControl(backend, parseSupport(meta))
console.log('P0 capabilities:', JSON.stringify(control.getCapabilities()))

const sessionId = await backend.newSession({ cwd: process.cwd(), mcpServers: [] })
console.log('P1 session:', sessionId)

// goal/get on a fresh session: the agent answers "no goal".
const before = await control.getGoal(sessionId)
console.log('P1 goal/get before create:', JSON.stringify(before))

// goal/create
const created = await control.createGoal(sessionId, 'Smoke-test the goal extension', 1000)
console.log('P1 goal/create:', JSON.stringify(created))

// goal/get after create: the goal must be there.
const after = await control.getGoal(sessionId)
console.log('P1 goal/get after create:', JSON.stringify(after))

// goal/patch
const patched = await control.patchGoal(sessionId, { status: 'paused' })
console.log('P1 goal/patch:', JSON.stringify(patched))

// delegation/stop on a session without subagents
const stopped = await control.stopDelegation(sessionId)
console.log('P1 delegation/stop:', JSON.stringify(stopped))

// delegation/get — the recovery path for the delegation tree
const tree = await control.getDelegationSnapshot(sessionId)
console.log('P1 delegation/get:', JSON.stringify(tree))

// goal/clear
const cleared = await control.clearGoal(sessionId)
console.log('P1 goal/clear:', JSON.stringify(cleared))

const afterClear = await control.getGoal(sessionId)
console.log('P1 goal/get after clear:', JSON.stringify(afterClear))

await backend.closeSession(sessionId).catch(() => {})
await backend.disconnect()
process.exit(0)

function parseSupport(meta: unknown) {
    const block = (meta as Record<string, unknown> | null)?.['minimax-code/extensions']
    const read = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return {
        methods: new Set(read((block as Record<string, unknown> | undefined)?.methods)),
        notifications: new Set(read((block as Record<string, unknown> | undefined)?.notifications))
    }
}
