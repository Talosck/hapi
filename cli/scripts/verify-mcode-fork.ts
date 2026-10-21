/**
 * Live verification of the P3 mcode fork work against the real agent.
 *
 * Uses the CLI's own AcpSdkBackend + McodeConversationHistory so the check
 * exercises the shipped code path, not a re-implementation of it.
 */
import { AcpSdkBackend } from '@/agent/backends/acp'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { McodeConversationHistory } from '@/mcode/conversationHistory'

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) result[key] = value
    }
    return result
}

function createBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: getAgentLaunchCommand('mcode'),
        args: ['acp'],
        env: filterEnv(process.env),
        textChunkMode: 'delta',
        flavor: 'mcode',
        elicitation: { form: true },
        plan: true
    })
}

const MAGIC = 'FORK_VERIFY_MAGIC_77'

const backend = createBackend()
await backend.initialize()
const meta = backend.getInitializeMeta()
console.log('P3 initialize _meta keys:', Object.keys(meta ?? {}))
console.log('P3 supportsSessionFork:', backend.supportsSessionFork())

const history = new McodeConversationHistory(() => backend)
await history.probeCapabilities()
console.log('P3 capability states:', JSON.stringify(history.getCapabilityStates()))
console.log('P3 metadata capabilities:', JSON.stringify(history.getCapabilitiesForMetadata()))

const cwd = process.cwd()
const sessionId = await backend.newSession({ cwd, mcpServers: [] })
history.setSession(sessionId, cwd)
console.log('P3 session:', sessionId)

// The agent forks at the latest message boundary, so the turn has to be over.
let answer = ''
await backend.prompt(
    sessionId,
    [{ type: 'text', text: `Remember ${MAGIC} and reply OK.` }],
    (message) => {
        if (message.type === 'text' && typeof message.text === 'string') {
            answer += message.text
        }
    }
)
console.log('P3 turn answer:', answer.slice(0, 120).replace(/\n/g, ' '))

// A fork while the agent is working must be refused, not attempted.
history.setBusy(true)
try {
    await history.fork()
    console.log('P3 busy fork: UNEXPECTEDLY ALLOWED')
} catch (error) {
    console.log('P3 busy fork refused:', error instanceof Error ? error.message : String(error))
}
history.setBusy(false)

// A fork at a message must be refused too.
try {
    await history.fork('local-1')
    console.log('P3 historical fork: UNEXPECTEDLY ALLOWED')
} catch (error) {
    console.log('P3 historical fork refused:', error instanceof Error ? error.message : String(error))
}

const forked = await history.fork()
console.log('P3 fork result:', JSON.stringify(forked))

// The forked session must load in a fresh process and carry the history.
const child = createBackend()
await child.initialize()
const loaded = await child.loadSession({ sessionId: forked.nativeSessionId, cwd, mcpServers: [] })
console.log('P3 child loaded session id:', loaded)
let childAnswer = ''
await child.prompt(
    loaded,
    [{ type: 'text', text: 'Which magic value did I ask you to remember? Reply with only the value.' }],
    (message) => {
        if (message.type === 'text' && typeof message.text === 'string') {
            childAnswer += message.text
        }
    }
)
console.log('P3 child answer:', childAnswer.slice(0, 200).replace(/\n/g, ' '))
console.log('P3 child inherited history:', childAnswer.includes(MAGIC))

await child.closeSession(loaded).catch(() => {})
await child.disconnect()
await backend.closeSession(sessionId).catch(() => {})
await backend.disconnect()
process.exit(0)
