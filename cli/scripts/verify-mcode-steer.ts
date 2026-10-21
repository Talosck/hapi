/**
 * Live verification of the P4 mcode steer work against the real agent.
 *
 * Uses the CLI's own AcpSdkBackend and the same extension call the launcher
 * makes, so the check exercises the shipped code path.
 */
import { AcpSdkBackend } from '@/agent/backends/acp'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'

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

const backend = createBackend()
await backend.initialize()

const meta = backend.getInitializeMeta()
const advertised = (meta as Record<string, unknown> | null)?.['minimax-code/extensions'] as
    | { methods?: string[] }
    | undefined
console.log('P4 advertised steer:', advertised?.methods?.includes('mcode/session/steer') === true)

const cwd = process.cwd()
const sessionId = await backend.newSession({ cwd, mcpServers: [] })
console.log('P4 session:', sessionId)

// A steer without a running turn must be refused by the agent. The session
// lives in this process, so the refusal is the real one - not "unknown
// session" from another process.
try {
    await backend.sendExtensionRequest('mcode/session/steer', { sessionId, text: 'no turn here' })
    console.log('P4 steer without a turn: UNEXPECTEDLY ALLOWED')
} catch (error) {
    console.log('P4 steer without a turn refused:', error instanceof Error ? error.message : String(error))
}

// A turn that keeps running, so there is something to steer into.
let answer = ''
const turn = backend.prompt(
    sessionId,
    [{ type: 'text', text: 'Run `sleep 20` in bash, then reply with SLEPT.' }],
    (message) => {
        if (message.type === 'text' && typeof message.text === 'string') {
            answer += message.text
        }
    }
)

await new Promise((resolve) => setTimeout(resolve, 6000))

try {
    const response = await backend.sendExtensionRequest<{ turnId?: string; mode?: string }>(
        'mcode/session/steer',
        // The client request id is the agent's idempotency key - the same
        // shape the launcher sends.
        {
            sessionId,
            text: 'Stop the sleep. Reply with exactly STEER_ACK and nothing else.',
            clientRequestId: 'verify-mcode-steer-1'
        }
    )
    console.log('P4 steer result:', JSON.stringify(response))
} catch (error) {
    console.log('P4 steer failed:', error instanceof Error ? error.message : String(error))
}

await turn
console.log('P4 answer:', answer.slice(0, 400).replace(/\n/g, ' '))
console.log('P4 steer had effect:', answer.includes('STEER_ACK'))

await backend.closeSession(sessionId).catch(() => {})
await backend.disconnect()
process.exit(0)
