import { describe, expect, it } from 'vitest'
import { PiRpcTimeoutError } from './loop'
import { isPiRpcTimeout } from './conversationHistoryTimeout'

describe('isPiRpcTimeout', () => {
    it('recognizes a Pi RPC timeout error', () => {
        expect(isPiRpcTimeout(new PiRpcTimeoutError('get_state', 1, 10_000))).toBe(true)
    })

    it('recognizes a timeout whose request id is not a positive number', () => {
        // The abort-lock path constructs a timeout without a real request id.
        // A matcher built on the message text would miss it, because the id
        // is not a plain digit.
        const error = new PiRpcTimeoutError('abort-lock', -1, 5_000)
        expect(isPiRpcTimeout(error)).toBe(true)
    })

    it('recognizes an adapter error that only carries the error name', () => {
        // Test doubles and adapters may not construct the real class, so the
        // name is the contract.
        const error = Object.assign(new Error('timed out'), { name: 'PiRpcTimeoutError' })
        expect(isPiRpcTimeout(error)).toBe(true)
    })

    it('does not treat an ordinary error as a timeout', () => {
        expect(isPiRpcTimeout(new Error('Pi RPC get_state (id=1) failed'))).toBe(false)
        expect(isPiRpcTimeout(new Error('boom'))).toBe(false)
        expect(isPiRpcTimeout('not an error')).toBe(false)
        expect(isPiRpcTimeout(undefined)).toBe(false)
    })
})
