import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    _resetMcodeConnectorCacheForTests,
    buildMcodeToolsEnv,
    connectorProviderOf,
    discoverMcodeConnectorBrokers,
    findMcodeConnectorBrokerForPid,
    groupMcodeConnectorApps,
    knownMcodeAgentHostPids,
    listMcodeConnectorApps,
    mcodeConnectorProbes,
    parseMcodeConnectorAuth,
    parseMcodeConnectorTools,
    preferredMcodeConnectorBrokers,
    rememberMcodeAgentHostPid,
    resolveMcodeToolsCommand
} from './mcodeConnectorTools'

const tempRoots: string[] = []

/**
 * A directory that looks like the temp root of a machine with MiniMax Code
 * hosts running in it.
 */
function makeBrokerRoot(hosts: { dir: string; withBroker: boolean }[]): string {
    const root = mkdtempSync(join(tmpdir(), 'hapi-broker-test-'))
    tempRoots.push(root)
    for (const host of hosts) {
        const runDir = join(root, host.dir, 'run')
        mkdirSync(runDir, { recursive: true })
        if (host.withBroker) {
            writeFileSync(join(runDir, 'mcode-auth-lease-v1.cap'), 'secret')
            writeFileSync(join(runDir, 'mcode-auth-lease-v1.sock'), '')
        }
    }
    return root
}

/**
 * A data directory that looks like the one of a machine with MiniMax Code
 * hosts running in it.
 *
 * The current MiniMax Code keeps its broker in the data directory: one
 * instance per host under a generated name, next to one shared instance.
 */
function makeDataDir(instances: { dir: string; withBroker: boolean }[]): string {
    const dataDir = mkdtempSync(join(tmpdir(), 'hapi-mcode-data-'))
    tempRoots.push(dataDir)
    const runDir = join(dataDir, 'run')
    mkdirSync(runDir, { recursive: true })
    for (const instance of instances) {
        const dir = instance.dir ? join(runDir, instance.dir) : runDir
        mkdirSync(dir, { recursive: true })
        if (instance.withBroker) {
            writeFileSync(join(dir, 'mcode-auth-lease-v1.cap'), 'secret')
            writeFileSync(join(dir, 'mcode-auth-lease-v1.sock'), '')
        }
    }
    return dataDir
}

/**
 * A data directory without a broker in it.
 *
 * The tests ask through a fixed machine, so the data directory of the machine
 * they run on has to stay out of the way.
 */
function emptyDataDir(): string {
    return makeDataDir([])
}

/** The socket of a broker instance in a data directory. */
function instanceSocket(dataDir: string, instance: string): string {
    return join(dataDir, 'run', instance, 'mcode-auth-lease-v1.sock')
}

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
    }
})

beforeEach(() => {
    _resetMcodeConnectorCacheForTests()
})

/**
 * One probe with an empty environment.
 *
 * The probes of a real run depend on the MiniMax Code hosts running on the
 * machine, so the tests ask through a fixed one.
 */
const TEST_PROBE = [{ command: 'mcode-tools', env: {} as NodeJS.ProcessEnv }]

describe('resolveMcodeToolsCommand', () => {
    it('resolves the sibling of an absolute mcode path', () => {
        // A custom HAPI_MCODE_PATH points at one install, and that install's
        // mcode-tools is the one sharing its auth lease.
        expect(resolveMcodeToolsCommand('/opt/minimax/bin/mcode')).toBe('/opt/minimax/bin/mcode-tools')
    })

    it('uses the Windows shim name', () => {
        expect(resolveMcodeToolsCommand('C:/tools/mcode', 'win32')).toBe('C:\\tools\\mcode-tools.cmd')
        expect(resolveMcodeToolsCommand('C:\\tools\\mcode', 'win32')).toBe('C:\\tools\\mcode-tools.cmd')
    })

    it('falls back to PATH for a bare command', () => {
        expect(resolveMcodeToolsCommand('mcode')).toBe('mcode-tools')
        expect(resolveMcodeToolsCommand('  ')).toBe('mcode-tools')
    })
})

describe('connectorProviderOf', () => {
    it('reads the provider out of a connector tool name', () => {
        expect(connectorProviderOf('connector__matrix__generate_image')).toBe('matrix')
        expect(connectorProviderOf('connector__email_workbench_credentials__session')).toBe('email_workbench_credentials')
    })

    it('keeps an unfamiliar name as its own provider', () => {
        expect(connectorProviderOf('some_other_tool')).toBe('some_other_tool')
    })
})

describe('parseMcodeConnectorTools', () => {
    it('reads the tool catalog', () => {
        const tools = parseMcodeConnectorTools({
            tools: [
                { tool_name: 'connector__matrix__generate_image', description: 'Text-to-image.' },
                { tool_name: 'connector__matrix__listen_audio', description: 'Transcribe audio.' }
            ]
        })

        expect(tools).toEqual([
            { toolName: 'connector__matrix__generate_image', provider: 'matrix', description: 'Text-to-image.' },
            { toolName: 'connector__matrix__listen_audio', provider: 'matrix', description: 'Transcribe audio.' }
        ])
    })

    it('returns nothing for an unexpected payload', () => {
        expect(parseMcodeConnectorTools(null)).toEqual([])
        expect(parseMcodeConnectorTools({})).toEqual([])
        expect(parseMcodeConnectorTools({ tools: 'nope' })).toEqual([])
    })
})

describe('parseMcodeConnectorAuth', () => {
    it('reads the broker status', () => {
        expect(parseMcodeConnectorAuth({
            auth_mode: 'shared-broker',
            status: 'authenticated',
            scope: 'agent.default',
            expires_at_ms: 1_700_000_000_000
        })).toEqual({
            status: 'authenticated',
            authMode: 'shared-broker',
            scope: 'agent.default',
            expiresAt: 1_700_000_000_000
        })
    })

    it('reports an unknown status for an unexpected payload', () => {
        expect(parseMcodeConnectorAuth(null)).toEqual({
            status: 'unknown',
            authMode: null,
            scope: null,
            expiresAt: null
        })
    })
})

describe('groupMcodeConnectorApps', () => {
    it('groups the tools by app and sorts the apps', () => {
        const apps = groupMcodeConnectorApps([
            { toolName: 'connector__matrix__a', provider: 'matrix', description: '' },
            { toolName: 'connector__email_workbench_credentials__b', provider: 'email_workbench_credentials', description: '' },
            { toolName: 'connector__matrix__c', provider: 'matrix', description: '' }
        ])

        expect(apps.map((app) => [app.provider, app.toolCount])).toEqual([
            ['email_workbench_credentials', 1],
            ['matrix', 2]
        ])
    })
})

describe('discoverMcodeConnectorBrokers', () => {
    it('finds the broker of a running MiniMax Code host', () => {
        const root = makeBrokerRoot([
            { dir: 'mcode-tools-tui-4242-abc', withBroker: true }
        ])

        const brokers = discoverMcodeConnectorBrokers({ tmpRoot: root, dataDir: emptyDataDir(), isProcessAlive: () => true })

        expect(brokers).toEqual([{
            endpoint: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.sock'),
            capabilityFile: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.cap')
        }])
    })

    it('skips the hosts that are gone', () => {
        const root = makeBrokerRoot([
            { dir: 'mcode-tools-tui-111-dead', withBroker: true },
            { dir: 'mcode-tools-tui-222-live', withBroker: true }
        ])

        const brokers = discoverMcodeConnectorBrokers({
            tmpRoot: root,
            dataDir: emptyDataDir(),
            isProcessAlive: (pid) => pid === 222
        })

        expect(brokers.map((broker) => broker.capabilityFile)).toEqual([
            join(root, 'mcode-tools-tui-222-live', 'run', 'mcode-auth-lease-v1.cap')
        ])
    })

    it('skips a directory without a broker in it', () => {
        const root = makeBrokerRoot([{ dir: 'mcode-tools-tui-333-empty', withBroker: false }])

        expect(discoverMcodeConnectorBrokers({ tmpRoot: root, dataDir: emptyDataDir(), isProcessAlive: () => true })).toEqual([])
    })

    it('finds the brokers the current MiniMax Code keeps in its data directory', () => {
        // The host no longer keeps its broker in the temp directory under a
        // name that carries its pid - it keeps it in the data directory, one
        // instance per host under a generated name.
        const dataDir = makeDataDir([
            { dir: 'mt-aaaaaa', withBroker: true },
            { dir: 'mt-bbbbbb', withBroker: true }
        ])
        const owners = new Map([
            [instanceSocket(dataDir, 'mt-aaaaaa'), 111],
            [instanceSocket(dataDir, 'mt-bbbbbb'), 222]
        ])

        const brokers = discoverMcodeConnectorBrokers({
            tmpRoot: makeBrokerRoot([]),
            dataDir,
            owners,
            isProcessAlive: () => true
        })

        expect(brokers.map((broker) => broker.capabilityFile).sort()).toEqual([
            join(dataDir, 'run', 'mt-aaaaaa', 'mcode-auth-lease-v1.cap'),
            join(dataDir, 'run', 'mt-bbbbbb', 'mcode-auth-lease-v1.cap')
        ])
    })

    it('finds the shared instance of the data directory', () => {
        const dataDir = makeDataDir([{ dir: '', withBroker: true }])

        const brokers = discoverMcodeConnectorBrokers({
            tmpRoot: makeBrokerRoot([]),
            dataDir,
            owners: new Map([[instanceSocket(dataDir, ''), 333]]),
            isProcessAlive: () => true
        })

        expect(brokers).toEqual([{
            endpoint: join(dataDir, 'run', 'mcode-auth-lease-v1.sock'),
            capabilityFile: join(dataDir, 'run', 'mcode-auth-lease-v1.cap')
        }])
    })

    it('skips an instance whose host is gone', () => {
        // A host that crashed leaves its instance behind, and nobody can ask
        // that one.
        const dataDir = makeDataDir([
            { dir: 'mt-aaaaaa', withBroker: true },
            { dir: 'mt-bbbbbb', withBroker: true }
        ])
        const owners = new Map([
            [instanceSocket(dataDir, 'mt-aaaaaa'), 111],
            [instanceSocket(dataDir, 'mt-bbbbbb'), 222]
        ])

        const brokers = discoverMcodeConnectorBrokers({
            tmpRoot: makeBrokerRoot([]),
            dataDir,
            owners,
            isProcessAlive: (pid) => pid === 222
        })

        expect(brokers.map((broker) => broker.capabilityFile)).toEqual([
            join(dataDir, 'run', 'mt-bbbbbb', 'mcode-auth-lease-v1.cap')
        ])
    })
})

describe('findMcodeConnectorBrokerForPid', () => {
    it('finds the broker of one host by its pid', () => {
        // The host names its broker after its own pid, so the agent HAPI
        // launched is found exactly - no scan of the whole temp directory.
        const root = makeBrokerRoot([
            { dir: 'mcode-tools-tui-4242-abc', withBroker: true },
            { dir: 'mcode-tools-tui-5252-def', withBroker: true }
        ])

        const broker = findMcodeConnectorBrokerForPid(5252, { tmpRoot: root, dataDir: emptyDataDir() })

        expect(broker).toEqual({
            endpoint: join(root, 'mcode-tools-tui-5252-def', 'run', 'mcode-auth-lease-v1.sock'),
            capabilityFile: join(root, 'mcode-tools-tui-5252-def', 'run', 'mcode-auth-lease-v1.cap')
        })
    })

    it('has no broker for a host that is not running', () => {
        const root = makeBrokerRoot([{ dir: 'mcode-tools-tui-4242-abc', withBroker: true }])

        expect(findMcodeConnectorBrokerForPid(9999, { tmpRoot: root, dataDir: emptyDataDir() })).toBeNull()
    })

    it('has no broker for a host that is still starting up', () => {
        // The host creates its broker directory first and the socket a moment
        // later. A host without a socket cannot sign a request.
        const root = makeBrokerRoot([{ dir: 'mcode-tools-tui-4242-abc', withBroker: false }])

        expect(findMcodeConnectorBrokerForPid(4242, { tmpRoot: root, dataDir: emptyDataDir() })).toBeNull()
    })

    it('finds the broker of a host of the current MiniMax Code by its pid', () => {
        // The directory of the current MiniMax Code carries no pid, so the
        // owner of the socket is what identifies the host.
        const dataDir = makeDataDir([
            { dir: 'mt-aaaaaa', withBroker: true },
            { dir: 'mt-bbbbbb', withBroker: true }
        ])
        const owners = new Map([
            [instanceSocket(dataDir, 'mt-aaaaaa'), 111],
            [instanceSocket(dataDir, 'mt-bbbbbb'), 222]
        ])

        const broker = findMcodeConnectorBrokerForPid(222, {
            tmpRoot: makeBrokerRoot([]),
            dataDir,
            owners,
            isProcessAlive: () => true
        })

        expect(broker).toEqual({
            endpoint: join(dataDir, 'run', 'mt-bbbbbb', 'mcode-auth-lease-v1.sock'),
            capabilityFile: join(dataDir, 'run', 'mt-bbbbbb', 'mcode-auth-lease-v1.cap')
        })
    })
})

describe('buildMcodeToolsEnv', () => {
    it('hands the broker coordinates to the tools', () => {
        const env = buildMcodeToolsEnv({
            baseEnv: { PATH: '/usr/bin' },
            broker: { endpoint: '/tmp/broker.sock', capabilityFile: '/tmp/broker.cap' }
        })

        expect(env.MCODE_AUTH_PROVIDER).toBe('shared-broker')
        expect(env.MCODE_AUTH_BROKER_ENDPOINT).toBe('/tmp/broker.sock')
        expect(env.MCODE_AUTH_BROKER_CAPABILITY_FILE).toBe('/tmp/broker.cap')
        expect(env.PATH).toBe('/usr/bin')
    })

    it('drops the variables of a host that is gone', () => {
        // The host's own variables win over anything set here, so a stale
        // broker would fail the call for a reason the user cannot act on.
        const env = buildMcodeToolsEnv({
            baseEnv: {
                __MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: '/tmp/old.sock',
                __MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE: '/tmp/old.cap',
                MCODE_AUTH_PROVIDER: 'shared-broker'
            },
            broker: { endpoint: '/tmp/new.sock', capabilityFile: '/tmp/new.cap' }
        })

        expect(env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBeUndefined()
        expect(env.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE).toBeUndefined()
        expect(env.MCODE_AUTH_BROKER_ENDPOINT).toBe('/tmp/new.sock')
    })

    it('publishes the whole host environment when it knows the runtime', () => {
        // The launcher the host puts first on PATH needs the runtime
        // executable, and the tools refuse a partial set.
        const env = buildMcodeToolsEnv({
            baseEnv: { PATH: '/usr/bin' },
            broker: { endpoint: '/tmp/broker.sock', capabilityFile: '/tmp/broker.cap' },
            runtimeExecutable: '/usr/bin/node',
            region: 'cn',
            configDir: '/home/user/.minimax/integrations/mcode-tools/cn'
        })

        expect(env.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE).toBe('/usr/bin/node')
        expect(env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBe('/tmp/broker.sock')
        expect(env.__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE).toBe('/tmp/broker.cap')
        expect(env.__MAVIS_MCODE_TOOLS_CONFIG_DIR).toBe('/home/user/.minimax/integrations/mcode-tools/cn')
        expect(env.__MAVIS_MCODE_TOOLS_REGION).toBe('cn')
    })

    it('keeps the minimal set when the runtime is unknown', () => {
        const env = buildMcodeToolsEnv({
            baseEnv: { PATH: '/usr/bin' },
            broker: { endpoint: '/tmp/broker.sock', capabilityFile: '/tmp/broker.cap' },
            runtimeExecutable: null,
            region: null,
            configDir: null
        })

        expect(env.MCODE_AUTH_PROVIDER).toBe('shared-broker')
        expect(env.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE).toBeUndefined()
    })
})

describe('mcodeConnectorProbes', () => {
    it('asks the host HAPI runs in first', () => {
        const probes = mcodeConnectorProbes({
            command: 'mcode-tools',
            dataDir: emptyDataDir(),
            env: {
                __MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: '/tmp/host.sock',
                __MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE: '/tmp/host.cap'
            },
            brokers: [{ endpoint: '/tmp/other.sock', capabilityFile: '/tmp/other.cap' }]
        })

        expect(probes).toHaveLength(2)
        expect(probes[0].env.__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT).toBe('/tmp/host.sock')
        expect(probes[1].env.MCODE_AUTH_BROKER_ENDPOINT).toBe('/tmp/other.sock')
    })

    it('does not ask the same broker twice', () => {
        const probes = mcodeConnectorProbes({
            command: 'mcode-tools',
            dataDir: emptyDataDir(),
            env: {
                __MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: '/tmp/host.sock',
                __MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE: '/tmp/host.cap'
            },
            brokers: [{ endpoint: '/tmp/host.sock', capabilityFile: '/tmp/host.cap' }]
        })

        expect(probes).toHaveLength(1)
    })

    it('has nothing to ask when no host is running', () => {
        expect(mcodeConnectorProbes({ command: 'mcode-tools', env: {}, brokers: [] })).toEqual([])
    })

    it('does not ask more hosts than the answer is worth waiting for', () => {
        const brokers = [1, 2, 3, 4, 5].map((n) => ({
            endpoint: `/tmp/${n}.sock`,
            capabilityFile: `/tmp/${n}.cap`
        }))

        const probes = mcodeConnectorProbes({ command: 'mcode-tools', env: {}, brokers })

        expect(probes).toHaveLength(3)
        expect(probes[0].env.MCODE_AUTH_BROKER_ENDPOINT).toBe('/tmp/1.sock')
    })

    it('asks the agent this session launched first', () => {
        // The agent names its broker after its own pid, so the session asks
        // exactly that agent instead of whichever host is running on the
        // machine.
        const root = makeBrokerRoot([
            { dir: 'mcode-tools-tui-4242-abc', withBroker: true },
            { dir: 'mcode-tools-tui-5252-def', withBroker: true }
        ])
        rememberMcodeAgentHostPid(5252)

        const probes = mcodeConnectorProbes({
            command: 'mcode-tools',
            env: {},
            dataDir: emptyDataDir(),
            tmpRoot: root,
            brokers: [{
                endpoint: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.sock'),
                capabilityFile: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.cap')
            }]
        })

        expect(probes[0].env.MCODE_AUTH_BROKER_ENDPOINT).toBe(
            join(root, 'mcode-tools-tui-5252-def', 'run', 'mcode-auth-lease-v1.sock')
        )
    })

    it('asks the agent it launched only once', () => {
        const root = makeBrokerRoot([{ dir: 'mcode-tools-tui-4242-abc', withBroker: true }])
        rememberMcodeAgentHostPid(4242)
        rememberMcodeAgentHostPid(4242)

        expect(knownMcodeAgentHostPids()).toEqual([4242])

        const probes = mcodeConnectorProbes({
            command: 'mcode-tools',
            env: {},
            dataDir: emptyDataDir(),
            tmpRoot: root,
            brokers: [{
                endpoint: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.sock'),
                capabilityFile: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.cap')
            }]
        })

        expect(probes).toHaveLength(1)
    })

    it('falls back to the hosts of the machine when its own agent is gone', () => {
        const root = makeBrokerRoot([{ dir: 'mcode-tools-tui-4242-abc', withBroker: true }])
        rememberMcodeAgentHostPid(9999)

        const probes = mcodeConnectorProbes({
            command: 'mcode-tools',
            env: {},
            dataDir: emptyDataDir(),
            tmpRoot: root,
            brokers: [{
                endpoint: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.sock'),
                capabilityFile: join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.cap')
            }]
        })

        expect(probes).toHaveLength(1)
        expect(probes[0].env.MCODE_AUTH_BROKER_ENDPOINT).toBe(
            join(root, 'mcode-tools-tui-4242-abc', 'run', 'mcode-auth-lease-v1.sock')
        )
    })

    it('puts the agent it launched before the hosts of the machine', () => {
        // The usage of the account and the connected apps are read through the
        // same host, so both have to name the agent of the session first.
        const root = makeBrokerRoot([
            { dir: 'mcode-tools-tui-4242-abc', withBroker: true },
            { dir: 'mcode-tools-tui-5252-def', withBroker: true }
        ])
        rememberMcodeAgentHostPid(5252)

        const brokers = preferredMcodeConnectorBrokers({ tmpRoot: root, dataDir: emptyDataDir() })

        expect(brokers[0].endpoint).toBe(
            join(root, 'mcode-tools-tui-5252-def', 'run', 'mcode-auth-lease-v1.sock')
        )
        // The other host of the machine is not running, so it is not asked.
        expect(brokers).toHaveLength(1)
    })
})

describe('listMcodeConnectorApps', () => {
    it('reports the connected apps and the auth state', async () => {
        const runTools = async (command: string, args: string[]) => {
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'authenticated', auth_mode: 'shared-broker' }), stderr: '' }
            }
            return {
                stdout: JSON.stringify({
                    tools: [
                        { tool_name: 'connector__matrix__generate_image', description: 'Text-to-image.' },
                        { tool_name: 'connector__email_workbench_credentials__session', description: 'Handshake.' }
                    ]
                }),
                stderr: ''
            }
        }

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })

        expect(catalog.error).toBeUndefined()
        expect(catalog.auth.status).toBe('authenticated')
        expect(catalog.apps.map((app) => app.provider)).toEqual(['email_workbench_credentials', 'matrix'])
    })
    it('reports a failure instead of pretending there are no apps', async () => {
        // "No apps connected" and "HAPI could not look" mean different things
        // to the user, so a failure must not look like an empty catalog.
        const runTools = async () => {
            throw new Error('spawn mcode-tools ENOENT')
        }

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })

        expect(catalog.apps).toEqual([])
        expect(catalog.error).toContain('ENOENT')
    })

    it('does not cache a failed auth read as "unknown"', async () => {
        let authCalls = 0
        const runTools = async (_command: string, args: string[]) => {
            if (args[0] === 'auth') {
                authCalls += 1
                if (authCalls === 1) throw new Error('mcode-tools auth status failed')
                return { stdout: JSON.stringify({ status: 'authenticated', auth_mode: 'shared-broker' }), stderr: '' }
            }
            return { stdout: JSON.stringify({ tools: [] }), stderr: '' }
        }

        const first = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, forceRefresh: true, probes: TEST_PROBE })
        expect(first.auth.status).toBe('unknown')

        // The failed read must not be cached: the next request has to try
        // again instead of showing "unknown" for the whole TTL.
        const second = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })
        expect(second.auth.status).toBe('authenticated')
    })

    it('caches the answer so a polling client does not spawn again', async () => {
        let calls = 0
        const runTools = async (command: string, args: string[]) => {
            calls++
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'authenticated' }), stderr: '' }
            }
            return {
                stdout: JSON.stringify({ tools: [{ tool_name: 'connector__matrix__a', description: '' }] }),
                stderr: ''
            }
        }

        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })
        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })

        // Two spawns for the first read (auth + tools), none for the second.
        expect(calls).toBe(2)
    })

    it('does not cache a failed read', async () => {
        let calls = 0
        const runTools = async (command: string, args: string[]) => {
            calls++
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'authenticated' }), stderr: '' }
            }
            throw new Error('boom')
        }

        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })
        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })

        expect(calls).toBe(4)
    })

    it('does not serve a cached answer whose auth lease expired', async () => {
        let calls = 0
        const runTools = async (command: string, args: string[]) => {
            calls++
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'authenticated', expires_at_ms: Date.now() - 1 }), stderr: '' }
            }
            return {
                stdout: JSON.stringify({ tools: [{ tool_name: 'connector__matrix__a', description: '' }] }),
                stderr: ''
            }
        }

        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })
        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })

        expect(calls).toBe(4)
    })

    it('keeps the auth state when the tool listing fails', async () => {
        const runTools = async (command: string, args: string[]) => {
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'unauthenticated' }), stderr: '' }
            }
            throw new Error('boom')
        }

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes: TEST_PROBE })

        expect(catalog.auth.status).toBe('unauthenticated')
        expect(catalog.error).toBe('boom')
    })

    it('asks the next broker when one does not answer', async () => {
        // The broker of a host that just died is still on disk for a moment,
        // so the probe has to move on to the next live one.
        const probes = [
            { command: 'mcode-tools', env: { MCODE_AUTH_BROKER_ENDPOINT: '/tmp/dead.sock' } as NodeJS.ProcessEnv },
            { command: 'mcode-tools', env: { MCODE_AUTH_BROKER_ENDPOINT: '/tmp/live.sock' } as NodeJS.ProcessEnv }
        ]
        const runTools = async (_command: string, args: string[], env: NodeJS.ProcessEnv) => {
            if (env.MCODE_AUTH_BROKER_ENDPOINT === '/tmp/dead.sock') {
                throw new Error('BROKER_UNAVAILABLE')
            }
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'authenticated' }), stderr: '' }
            }
            return {
                stdout: JSON.stringify({ tools: [{ tool_name: 'connector__matrix__a', description: '' }] }),
                stderr: ''
            }
        }

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools, probes })

        expect(catalog.error).toBeUndefined()
        expect(catalog.apps.map((app) => app.provider)).toEqual(['matrix'])
    })

    it('says so when no host is running to ask', async () => {
        const catalog = await listMcodeConnectorApps({
            mcodeCommand: 'mcode',
            runTools: async () => {
                throw new Error('should not be called')
            },
            probes: []
        })

        expect(catalog.apps).toEqual([])
        expect(catalog.error).toContain('No MiniMax Code host is running')
    })
})
