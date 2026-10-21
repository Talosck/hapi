import { beforeEach, describe, expect, it } from 'vitest'
import {
    _resetMcodeConnectorCacheForTests,
    connectorProviderOf,
    groupMcodeConnectorApps,
    listMcodeConnectorApps,
    parseMcodeConnectorAuth,
    parseMcodeConnectorTools,
    resolveMcodeToolsCommand
} from './mcodeConnectorTools'

beforeEach(() => {
    _resetMcodeConnectorCacheForTests()
})

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

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })

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

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })

        expect(catalog.apps).toEqual([])
        expect(catalog.error).toContain('ENOENT')
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

        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })
        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })

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

        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })
        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })

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

        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })
        await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })

        expect(calls).toBe(4)
    })

    it('keeps the auth state when the tool listing fails', async () => {
        const runTools = async (command: string, args: string[]) => {
            if (args[0] === 'auth') {
                return { stdout: JSON.stringify({ status: 'unauthenticated' }), stderr: '' }
            }
            throw new Error('boom')
        }

        const catalog = await listMcodeConnectorApps({ mcodeCommand: 'mcode', runTools })

        expect(catalog.auth.status).toBe('unauthenticated')
        expect(catalog.error).toBe('boom')
    })
})
