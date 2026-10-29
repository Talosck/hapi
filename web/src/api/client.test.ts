import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProxyRedirectError } from './authProxy'
import { ApiClient, ApiError, apiErrorMessage } from './client'

describe('ApiClient error mapping', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('prefers the stable `code` field over the human-readable `error` message in ApiError.code', async () => {
        // Match the shape /sessions/:id/reopen actually returns on a 503.
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'No machine online', code: 'no_machine_online' }),
                { status: 503, statusText: 'Service Unavailable' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-X')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(503)
            // The stable taxonomy must survive into ApiError.code so callers can
            // branch on `no_machine_online` rather than parsing the message text.
            expect(apiError.code).toBe('no_machine_online')
            expect(apiError.body).toContain('no_machine_online')
        }
    })

    it('falls back to `parsed.error` when `code` is absent (legacy route shape)', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'something broke' }),
                { status: 500, statusText: 'Internal Server Error' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Y')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            expect((error as ApiError).code).toBe('something broke')
        }
    })

    it('preserves the structured ambiguous-boundary code for Rewind fallbacks', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Rewind is unavailable for this Codex history',
                    code: 'ambiguous_native_boundary_fork_safe',
                    hydrateFailed: false
                }),
                { status: 409, statusText: 'Conflict' }
            )
        )

        const api = new ApiClient('test-token')
        await expect(api.rewindConversation('session-1', 'local-1')).rejects.toMatchObject({
            status: 409,
            code: 'ambiguous_native_boundary_fork_safe'
        })
    })

    it('passes the 422 missing-metadata body through unchanged so the UI can show the missing fields', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                    missing: ['cursorSessionId']
                }),
                { status: 422, statusText: 'Unprocessable Entity' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Z')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(422)
            expect(apiError.body).toContain('cursorSessionId')
        }
    })

    it('returns export warnings and sends explicit confirmation for large exports', async () => {
        const warning = {
            type: 'warning',
            count: 20_001,
            limit: 20_000,
            estimatedBytes: 12_345_678
        }
        const payload = {
            schemaVersion: 2,
            exportedAt: 1_762_000_000_000,
            session: { id: 'session-1' },
            messages: [],
            scratchlist: []
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(warning), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.getSessionExport('session-1')).resolves.toEqual(warning)
        await expect(api.getSessionExport('session-1', { force: true })).resolves.toEqual(payload)

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session-1/export')
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/sessions/session-1/export?force=true')
    })

    it('loads the Cursor chat store status for the selected session', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ onDisk: false, store: null }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.getCursorChatStoreStatus('session cursor')).resolves.toEqual({
            onDisk: false,
            store: null
        })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%20cursor/cursor-chat-store')
    })

    it('generates a title and saves the summary through separate session endpoints', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Generated title' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.suggestSessionTitle('session /?#')).resolves.toEqual({ title: 'Generated title' })
        await api.updateSessionSummary('session /?#', 'Generated title')

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%20%2F%3F%23/title-suggestion')
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/sessions/session%20%2F%3F%23/summary')
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({ text: 'Generated title' })
        })
    })

    it('reads the Hub title suggestion capability', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            status: 'ok',
            protocolVersion: 1,
            capabilities: { titleSuggestion: true }
        }), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.getHealth()).resolves.toEqual({
            status: 'ok',
            protocolVersion: 1,
            capabilities: { titleSuggestion: true }
        })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/health')
    })

    it('asks the machine to re-probe agy only when the caller forces a refresh', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(
            new Response(JSON.stringify({ success: true, availableModels: [] }), { status: 200 })
        ))

        const api = new ApiClient('test-token')
        await api.getMachineAgyModels('machine-1')
        await api.getMachineAgyModels('machine-1', { refresh: true })

        expect(fetchMock.mock.calls[0][0]).toContain('/api/machines/machine-1/agy-models')
        expect(fetchMock.mock.calls[0][0]).not.toContain('refresh')
        expect(fetchMock.mock.calls[1][0]).toContain('/api/machines/machine-1/agy-models?refresh=true')
    })

    it('lists and imports Pi sessions through the selected machine', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, sessions: [], machineId: 'machine-1' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [], machineId: 'machine-1' }), { status: 200 }))
        const api = new ApiClient('test-token')

        await api.getPiSessions('/tmp/project', 'machine-1')
        await api.importPiSessions({ sessionIds: ['pi-1'], cwd: '/tmp/project', machineId: 'machine-1' })

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/pi/sessions?cwd=%2Ftmp%2Fproject&machineId=machine-1')
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/pi/import-sessions')
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['pi-1'], cwd: '/tmp/project', machineId: 'machine-1' })
        })
    })

    it('loads the authoritative queued state for encoded session IDs', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({
                queuedLocalIds: ['local-2'],
                invokedLocalMessages: [{ localId: 'local-3', invokedAt: 1_000 }]
            }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.getQueuedState('session /?#', ['local-1', 'local-2'])).resolves.toEqual({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: [{ localId: 'local-3', invokedAt: 1_000 }]
        })

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages/queued-state')
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ localIds: ['local-1', 'local-2'] })
        })
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('forwards the selected delivery mode when sending a message', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

        const api = new ApiClient('test-token')
        await api.sendMessage('session /?#', 'steer this', 'local-1', undefined, null, 'steer')

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages')
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({
                text: 'steer this',
                localId: 'local-1',
                deliveryMode: 'steer',
            })
        })
    })

    it('posts a steer for a queued message', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ status: 'steered', localId: 'local-1' }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.steerMessage('session /?#', 'msg-1')).resolves.toEqual({
            status: 'steered',
            localId: 'local-1',
        })

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages/msg-1/steer')
        expect(init).toMatchObject({ method: 'POST' })
    })

    it('requests usage buckets in the viewer IANA time zone', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

        const api = new ApiClient('test-token')
        await api.getUsageSummary('7d', 'America/New_York')

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/usage/summary?range=7d&timeZone=America%2FNew_York'
        )
    })

    it('lets fetch set the multipart boundary for transcription uploads', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: 'hello' }), { status: 200 }))

        const api = new ApiClient('test-token')
        const file = new File(['audio'], 'speech.webm', { type: 'audio/webm' })
        await api.transcribeVoice({ file, provider: 'openai', mode: 'standard' })

        const [, init] = fetchMock.mock.calls[0] ?? []
        expect(init?.body).toBeInstanceOf(FormData)
        expect(new Headers(init?.headers).has('content-type')).toBe(false)
    })

    it('preserves an unavailable voice backend response', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ backend: null, backends: [] }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.fetchVoiceBackend()).resolves.toEqual({ backend: null, backends: [] })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/voice/backend')
    })

    it('reads and updates masked transcription credentials', async () => {
        const status = {
            openai: { configured: true, source: 'settings', hint: '••••cret', editable: true },
            elevenlabs: { configured: false, source: 'none', hint: null, editable: true },
            deepgram: { configured: false, source: 'none', hint: null, editable: true },
            groq: { configured: false, source: 'none', hint: null, editable: true },
            openaiCompatible: {
                configured: false,
                source: 'none',
                baseUrl: null,
                model: null,
                baseUrlEditable: true,
                modelEditable: true,
                apiKey: { configured: false, source: 'none', hint: null, editable: true },
            },
            voiceBackends: {
                elevenlabs: { configured: false, source: 'none', hint: null, editable: true },
                geminiLive: { configured: false, source: 'none', hint: null, editable: true },
                qwenRealtime: { configured: false, source: 'none', hint: null, editable: true },
            },
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.fetchTranscriptionCredentials()).resolves.toEqual(status)
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/voice/transcription/credentials')

        await expect(api.updateTranscriptionCredentials({ openai: 'sk-test' })).resolves.toEqual(status)
        const [, init] = fetchMock.mock.calls[1] ?? []
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/voice/transcription/credentials')
        expect(init?.method).toBe('PUT')
        expect(init?.body).toBe(JSON.stringify({ openai: 'sk-test' }))
    })
})

describe('ApiClient Kimi session model discovery', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('requests the running session instead of the machine kimi-models endpoint', async () => {
        const catalog = {
            success: true,
            availableModels: [
                { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' }
            ],
            currentModelId: 'GLM-5.3-flash'
        }
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.getSessionKimiModels('session/1')).resolves.toEqual(catalog)
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%2F1/kimi-models')
    })
})

describe('ApiClient retry policy', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
        globalThis.fetch = originalFetch
    })

    it('replays a GET after a transient 503 and returns the eventual success', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'restarting' }), { status: 503 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }))

        const api = new ApiClient('test-token')
        const promise = api.getSessions()
        await vi.advanceTimersByTimeAsync(1_000)

        await expect(promise).resolves.toEqual({ sessions: [] })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('replays a GET after the transport itself fails', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }))

        const api = new ApiClient('test-token')
        const promise = api.getSessions()
        await vi.advanceTimersByTimeAsync(1_000)

        await expect(promise).resolves.toEqual({ sessions: [] })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('never replays a mutation, so a POST effect cannot be duplicated', async () => {
        fetchMock.mockImplementation(() => new Response(JSON.stringify({ error: 'no machine online' }), { status: 503 }))

        const api = new ApiClient('test-token')
        const promise = api.setVisibility({ subscriptionId: 'sub-1', visibility: 'hidden' })
        const expectation = expect(promise).rejects.toBeInstanceOf(ApiError)
        await vi.advanceTimersByTimeAsync(1_000)

        await expectation
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('replays an authentication that only mints a token', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'restarting' }), { status: 503 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }))

        const api = new ApiClient('test-token')
        const promise = api.authenticate({ accessToken: 'cli-token' })
        await vi.advanceTimersByTimeAsync(1_000)

        await expect(promise).resolves.toMatchObject({ token: 'jwt' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('replays a binding, which is idempotent for the same user and namespace', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }))

        const api = new ApiClient('test-token')
        const promise = api.bind({ initData: 'init', accessToken: 'cli-token' })
        await vi.advanceTimersByTimeAsync(1_000)

        await expect(promise).resolves.toMatchObject({ token: 'jwt' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not replay a GET that failed with a status that is not transient', async () => {
        fetchMock.mockImplementation(() => new Response(JSON.stringify({ error: 'nope' }), { status: 400 }))

        const api = new ApiClient('test-token')
        const promise = api.getSessions()
        const expectation = expect(promise).rejects.toBeInstanceOf(ApiError)
        await vi.advanceTimersByTimeAsync(1_000)

        await expectation
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('gives up after the attempt budget and reports the last response', async () => {
        const bodies = ['first', 'second', 'third']
        let call = 0
        fetchMock.mockImplementation(() => new Response(bodies[call++], { status: 503 }))

        const api = new ApiClient('test-token')
        const promise = api.getSessions()
        // The body of the *final* response is what the caller gets: draining
        // intermediate bodies must not cost the last one its content.
        const expectation = expect(promise).rejects.toMatchObject({ status: 503, body: 'third' })
        await vi.advanceTimersByTimeAsync(10_000)

        await expectation
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('never replays an aborted request', async () => {
        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        fetchMock.mockRejectedValue(abortError)

        const api = new ApiClient('test-token')
        const promise = api.getSessionExport('session-1')
        const expectation = expect(promise).rejects.toBe(abortError)
        await vi.advanceTimersByTimeAsync(1_000)

        await expectation
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('waits out Retry-After before replaying a throttled GET', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '1' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }))

        const api = new ApiClient('test-token')
        const promise = api.getSessions()

        // Past the longest computed backoff but short of the Retry-After the
        // hub asked for: the retry must not have happened yet.
        await vi.advanceTimersByTimeAsync(500)
        expect(fetchMock).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(600)
        await expect(promise).resolves.toEqual({ sessions: [] })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})

describe('apiErrorMessage', () => {
    it('reads the reason the hub gave instead of the raw response body', () => {
        // The transport puts the whole body into the message: showing that
        // to a user means showing them the transport.
        const error = new ApiError(
            'HTTP 400 Bad Request: {"success":false,"error":"A goal needs an objective"}',
            400,
            'A goal needs an objective',
            '{"success":false,"error":"A goal needs an objective"}'
        )

        expect(apiErrorMessage(error, 'fallback')).toBe('A goal needs an objective')
    })

    it('never shows a body that is not a JSON answer', () => {
        // An HTML error page from a proxy is not something to show a user
        // either: the caller knows better than the transport.
        const error = new ApiError(
            'HTTP 502 Bad Gateway: <html><body>Bad Gateway</body></html>',
            502,
            undefined,
            '<html><body>Bad Gateway</body></html>'
        )

        expect(apiErrorMessage(error, 'fallback')).toBe('fallback')
    })

    it('never shows a JSON body that names no reason', () => {
        const error = new ApiError('HTTP 500 Internal Server Error', 500, undefined, '{"success":false}')

        expect(apiErrorMessage(error, 'fallback')).toBe('fallback')
    })

    it('uses the given fallback when there is nothing to show', () => {
        expect(apiErrorMessage(new Error(''), 'fallback')).toBe('fallback')
        expect(apiErrorMessage(undefined, 'fallback')).toBe('fallback')
    })

    it('passes a plain error message through', () => {
        expect(apiErrorMessage(new Error('boom'), 'fallback')).toBe('boom')
    })
})

describe('ApiClient auth proxy redirect', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    const opaqueRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false }) as Response

    // Every hub call site must classify an auth-proxy redirect instead of
    // surfacing the browser's opaque `Failed to fetch`.
    const callSites: Array<{ name: string; run: (api: ApiClient) => Promise<unknown> }> = [
        { name: 'authenticate', run: (api) => api.authenticate({ accessToken: 'token' }) },
        { name: 'bind', run: (api) => api.bind({ initData: 'init', accessToken: 'token' }) },
        { name: 'getSessions', run: (api) => api.getSessions() },
        {
            name: 'getGeneratedImageBlob',
            run: (api) => api.getGeneratedImageBlob('session-1', 'image-1')
        },
        { name: 'migrateCursorSessionToAcp', run: (api) => api.migrateCursorSessionToAcp('session-1') },
        {
            name: 'fetchScratchlistAttachmentBlob',
            run: (api) => api.fetchScratchlistAttachmentBlob('session-1', 'attachment-1')
        }
    ]

    it.each(callSites)('$name rejects with AuthProxyRedirectError', async ({ run }) => {
        fetchMock
            .mockResolvedValueOnce(opaqueRedirect())
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))

        const api = new ApiClient('test-token', { baseUrl: 'https://hub.example' })
        await expect(run(api)).rejects.toBeInstanceOf(AuthProxyRedirectError)
    })

    it('getGeneratedImageBlob rejects with AuthProxyRedirectError on the 304 cache re-read', async () => {
        fetchMock
            .mockResolvedValueOnce({ type: 'basic', status: 304, ok: false } as Response)
            .mockResolvedValueOnce(opaqueRedirect())
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))

        const api = new ApiClient('test-token', { baseUrl: 'https://hub.example' })
        await expect(api.getGeneratedImageBlob('session-1', 'image-1')).rejects.toBeInstanceOf(AuthProxyRedirectError)
        expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'force-cache', redirect: 'manual' })
    })
})
