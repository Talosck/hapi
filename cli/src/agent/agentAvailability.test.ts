import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as codexExecutable from '@/codex/utils/codexExecutable'
import { executableCandidates, getAgentLaunchCommand, resolveExecutable } from './agentLaunchCommand'
import { getAgentAvailability } from './agentAvailability'

async function makeExecutable(directory: string, name: string): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    return path
}

describe('agent executable resolution', () => {
    it('resolves commands from PATH and absolute environment overrides', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const copilot = await makeExecutable(directory, 'copilot-custom')

        expect(resolveExecutable('copilot-custom', { pathValue: directory })).toBe(copilot)
        expect(getAgentLaunchCommand('copilot', { COPILOT_CLI_PATH: copilot })).toBe(copilot)
        expect(getAgentAvailability('copilot', {
            COPILOT_CLI_PATH: copilot,
            PATH: directory,
        })).toEqual({ agent: 'copilot', available: true })
    })

    it('pins the MiniMax Code install through HAPI_MCODE_PATH', () => {
        expect(getAgentLaunchCommand('mcode', {})).toBe('mcode')
        expect(getAgentLaunchCommand('mcode', { HAPI_MCODE_PATH: '  ' })).toBe('mcode')
        expect(getAgentLaunchCommand('mcode', { HAPI_MCODE_PATH: '/opt/mcode/bin/mcode' }))
            .toBe('/opt/mcode/bin/mcode')
    })

    it('uses PATHEXT when resolving Windows commands', () => {        expect(executableCandidates('agent', {
            platform: 'win32',
            pathValue: 'C:\\Tools;D:\\Bin',
            pathExt: '.EXE;.CMD',
        })).toEqual([
            'C:\\Tools\\agent.EXE',
            'C:\\Tools\\agent.CMD',
            'D:\\Bin\\agent.EXE',
            'D:\\Bin\\agent.CMD',
        ])
    })

    it('reports missing executables without invoking them', () => {
        expect(getAgentAvailability('grok', { PATH: '' })).toEqual({
            agent: 'grok',
            available: false,
            reason: 'not_found',
        })
        expect(getAgentAvailability('claude', { PATH: '' })).toEqual({
            agent: 'claude',
            available: false,
            reason: 'not_found',
        })
        expect(getAgentAvailability('codex', {
            PATH: '',
            HAPI_CODEX_APP_SERVER_BIN: '/missing/codex',
        })).toEqual({
            agent: 'codex',
            available: false,
            reason: 'invalid_configuration',
        })
    })

    it('uses the configured Codex app-server executable for availability', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const codex = await makeExecutable(directory, 'codex-app-server')

        expect(getAgentAvailability('codex', {
            PATH: '',
            HAPI_CODEX_APP_SERVER_BIN: codex,
        })).toEqual({ agent: 'codex', available: true })
    })

    it('checks the terminal Codex executable independently of the runner override', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const codex = await makeExecutable(directory, 'codex')
        const resolveSpy = vi.spyOn(codexExecutable, 'resolveCodexCommand')
        try {
            resolveSpy.mockReturnValue({ command: codex, args: [] })
            expect(getAgentAvailability('codex', {
                PATH: '', HAPI_CODEX_APP_SERVER_BIN: '/missing/app-server'
            }, 'terminal')).toEqual({ agent: 'codex', available: true })

            resolveSpy.mockReturnValue({ command: join(directory, 'missing-codex'), args: [] })
            expect(getAgentAvailability('codex', {
                PATH: '', HAPI_CODEX_APP_SERVER_BIN: codex
            }, 'terminal')).toEqual({ agent: 'codex', available: false, reason: 'not_found' })
        } finally {
            resolveSpy.mockRestore()
        }
    })

    it('rejects malformed or missing DSH static configuration', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        await makeExecutable(directory, 'dsh-acp-demo')
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_ARGS_JSON: 'not json',
        }).reason).toBe('invalid_configuration')
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_CONFIG: join(directory, 'missing.yml'),
        }).reason).toBe('invalid_configuration')

        const config = join(directory, 'cordis.yml')
        await writeFile(config, 'agents: []\n')
        expect(getAgentAvailability('dsh', {
            PATH: directory,
            HAPI_DSH_ACP_CONFIG: config,
        })).toEqual({ agent: 'dsh', available: true })
    })

    it('accepts a macOS Codex app executable when the CLI is absent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const appCommand = join(directory, 'Codex.app', 'Contents', 'Resources', 'codex')
        await mkdir(join(directory, 'Codex.app', 'Contents', 'Resources'), { recursive: true })
        await writeFile(appCommand, '#!/bin/sh\n')
        await chmod(appCommand, 0o755)

        expect(resolveExecutable(appCommand, { pathValue: '' })).toBe(appCommand)
    })

    it('reports a MiniMax Code install without an account as not signed in', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const home = await mkdtemp(join(tmpdir(), 'hapi-agent-home-'))
        await makeExecutable(directory, 'mcode')
        const accountDir = join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public')
        await mkdir(accountDir, { recursive: true })
        await writeFile(join(accountDir, 'auth-state.json'), JSON.stringify({
            status: 'unauthenticated',
            region: 'cn',
        }))

        expect(getAgentAvailability('mcode', {
            PATH: directory,
            HOME: home,
        })).toEqual({
            agent: 'mcode',
            available: false,
            reason: 'not_signed_in',
        })
    })

    it('keeps a signed-in MiniMax Code install available', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const home = await mkdtemp(join(tmpdir(), 'hapi-agent-home-'))
        await makeExecutable(directory, 'mcode')
        const accountDir = join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public')
        await mkdir(accountDir, { recursive: true })
        await writeFile(join(accountDir, 'auth-state.json'), JSON.stringify({
            status: 'authenticated',
            region: 'cn',
            expiresAtMs: Date.now() + 3_600_000,
        }))

        expect(getAgentAvailability('mcode', {
            PATH: directory,
            HOME: home,
        })).toEqual({ agent: 'mcode', available: true })
    })

    it('keeps a signed-in MiniMax Code install available when its access token expired', async () => {
        // The access token running out is not a signed-out account: the agent
        // renews it when it starts, so the install stays usable.
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const home = await mkdtemp(join(tmpdir(), 'hapi-agent-home-'))
        await makeExecutable(directory, 'mcode')
        const accountDir = join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public')
        await mkdir(accountDir, { recursive: true })
        await writeFile(join(accountDir, 'auth-state.json'), JSON.stringify({
            status: 'authenticated',
            region: 'cn',
            expiresAtMs: Date.now() - 3_600_000,
        }))

        expect(getAgentAvailability('mcode', {
            PATH: directory,
            HOME: home,
        })).toEqual({ agent: 'mcode', available: true })
    })

    it('keeps a MiniMax Code install without a readable account available', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-path-'))
        const home = await mkdtemp(join(tmpdir(), 'hapi-agent-home-'))
        await makeExecutable(directory, 'mcode')

        // The account may live somewhere the agent keeps to itself, so an
        // unreadable state must not lock the agent out.
        expect(getAgentAvailability('mcode', {
            PATH: directory,
            HOME: home,
        })).toEqual({ agent: 'mcode', available: true })
    })
})
