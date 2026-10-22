import { describe, expect, it } from 'vitest'
import {
    classifyMcodeConnectFailure,
    mcodeConnectFailureArchiveReason,
} from './mcodeConnectFailure'

describe('classifyMcodeConnectFailure', () => {
    it('recognizes an agent that is not installed', () => {
        const failure = classifyMcodeConnectFailure(
            new Error('Failed to spawn mcode: spawn mcode ENOENT. Is it installed and on PATH?')
        )

        expect(failure.reason).toBe('not_installed')
        expect(failure.message).toContain('not installed')
        expect(mcodeConnectFailureArchiveReason(failure)).toBe('MiniMax Code is not installed')
    })

    it('recognizes an agent without an account', () => {
        const failure = classifyMcodeConnectFailure(
            new Error('ACP process exited (agent error); stderr: error: Unauthenticated. Sign in to continue.')
        )

        expect(failure.reason).toBe('not_signed_in')
        expect(failure.message).toContain('mcode login')
        expect(mcodeConnectFailureArchiveReason(failure)).toBe('MiniMax Code is not signed in')
    })

    it('reads the reason out of the stderr of the agent', () => {
        const failure = classifyMcodeConnectFailure({
            message: 'ACP process exited (agent error)',
            stderr: 'Error: 401 Unauthorized',
        })

        expect(failure.reason).toBe('not_signed_in')
    })

    it('reads the reason out of the details of an ACP error', () => {
        const failure = classifyMcodeConnectFailure({
            message: 'Request failed',
            data: { details: 'login required' },
        })

        expect(failure.reason).toBe('not_signed_in')
    })

    it('falls back to the message of the agent when it says nothing usable', () => {
        const failure = classifyMcodeConnectFailure(new Error('ACP process exited (agent error)'))

        expect(failure.reason).toBe('unknown')
        expect(failure.message).toContain('ACP process exited')
        expect(mcodeConnectFailureArchiveReason(failure)).toBe('MiniMax Code crashed')
    })

    it('keeps a failure without a message readable', () => {
        const failure = classifyMcodeConnectFailure(undefined)

        expect(failure.reason).toBe('unknown')
        expect(failure.message).toContain('the agent gave no reason')
    })
})
