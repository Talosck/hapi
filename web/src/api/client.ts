import type {
    AttachmentMetadata,
    AuthResponse,
    CodexLocalSessionsResponse,
    CodexDuplicateSessionsResponse,
    CodexMergeDuplicateSessionsResponse,
    CodexDesktopScriptResponse,
    CodexDesktopSyncRequest,
    CodexDesktopStatusResponse,
    CodexArchiveSessionResponse,
    DecryptedMessage,
    CodexCollaborationMode,
    CopilotAgentMode,
    FileSearchResponse,
    MachinesResponse,
    MessagesResponse,
    PermissionMode,
    PiImportSessionsResponse,
    PiLocalSessionsResponse,
    PushSubscriptionPayload,
    PushUnsubscribePayload,
    PushVapidPublicKeyResponse,
    SlashCommandsResponse,
    SkillsResponse,
    SpawnResponse,
    VisibilityPayload,
    HapiSessionExportResponse,
    HubHealthResponse,
    SessionResponse,
    SessionTitleSuggestionResponse,
    SessionsResponse
} from '@/types/api'
import type {
    AgyModelsResponse,
    AgentAvailabilityResponse,
    CodexModelsResponse,
    CursorMigrateOutcome,
    CursorMigrateToAcpRequest,
    CursorChatStoreStatus,
    CursorModelsResponse,
    DeleteUploadResponse,
    FileReadResponse,
    GitCommandResponse,
    GrokModelsResponse,
    KimiModelsResponse,
    McodeModelsResponse,
    McodeAppsResponse,
    MinimaxQuotaResponse,
    MinimaxQuotaSource,
    McodeGoalResponse,
    McodeGoalClearResponse,
    McodeDelegationStopResponse,
    CopilotModelsResponse,
    GrokReasoningEffortResponse,
    ListDirectoryResponse,
    MachineListDirectoryResponse,
    MachinePathsExistsResponse,
    OpencodeModelsResponse,
    OpencodeModelVariantsResponse,
    OpencodeReasoningEffortResponse,
    PiModelsResponse,
    QueuedStateResponse,
    ReopenSessionResponse,
    SqliteStorageUsageResponse,
    HubSettingsResponse,
    UpdateHubSettingsRequest,
    UsageSummaryResponse,
    UploadFileResponse,
    WorkspaceDeleteResponse,
    WorkspaceUploadAbortResponse,
    WorkspaceUploadChunkResponse,
    WorkspaceUploadFinishResponse,
    WorkspaceUploadStartResponse
} from '@hapi/protocol/apiTypes'
import type { AgentFlavor, MessageDeliveryMode } from '@hapi/protocol'
import type { CancelMessageResponse, SteerQueuedMessageResponse } from '@hapi/protocol/schemas'
import type { TranscriptionMode, TranscriptionProvider, TranscriptionProviderInfo } from '@hapi/protocol/voice'

export type RetryIndeterminateMessageResponse =
    | { status: 'retried' | 'already-queued' | 'retry-unavailable'; localId: string | null }
    | { status: 'invoked'; message: DecryptedMessage }
    | { status: 'not-found' }

export type ProviderCredentialSource = 'env' | 'settings' | 'none'

export interface MaskedCredentialStatus {
    configured: boolean
    source: ProviderCredentialSource
    hint: string | null
    editable: boolean
}

export interface TranscriptionCredentialStatus {
    openai: MaskedCredentialStatus
    elevenlabs: MaskedCredentialStatus
    deepgram: MaskedCredentialStatus
    groq: MaskedCredentialStatus
    openaiCompatible: {
        configured: boolean
        source: ProviderCredentialSource
        baseUrl: string | null
        model: string | null
        baseUrlEditable: boolean
        modelEditable: boolean
        apiKey: MaskedCredentialStatus
    }
    voiceBackends: {
        elevenlabs: MaskedCredentialStatus
        geminiLive: MaskedCredentialStatus
        qwenRealtime: MaskedCredentialStatus
    }
    /** Optional: older hub versions won't send this. */
    elevenLabsMaxDurationSeconds?: {
        value: number
        source: ProviderCredentialSource
        editable: boolean
    }
}

export interface TranscriptionCredentialsUpdate {
    openai?: string | null
    elevenlabs?: string | null
    deepgram?: string | null
    groq?: string | null
    openaiCompatible?: {
        baseUrl?: string | null
        model?: string | null
        apiKey?: string | null
    }
    geminiLive?: string | null
    qwenRealtime?: string | null
    /** null resets to the hub default (1800s) */
    elevenLabsMaxDurationSeconds?: number | null
}

type ApiClientOptions = {
    baseUrl?: string
    getToken?: () => string | null
    onUnauthorized?: () => Promise<string | null>
}

type ErrorPayload = {
    error?: unknown
    code?: unknown
    message?: unknown
}

function parseErrorCode(bodyText: string): string | undefined {
    try {
        const parsed = JSON.parse(bodyText) as ErrorPayload
        if (typeof parsed.code === 'string') return parsed.code
        if (typeof parsed.error === 'string') return parsed.error
        return undefined
    } catch {
        return undefined
    }
}

/**
 * The message the hub meant, without the transport around it.
 *
 * A failed request carries the whole response body in its message
 * (`HTTP 400 Bad Request: {"success":false,"error":"A goal needs an objective"}`),
 * which is not something to show a user. The hub always answers with a JSON
 * body that names the reason, so the reason is extracted here.
 *
 * A body that is not such an answer - an HTML error page from a proxy, say -
 * is not shown either: the caller knows better than the transport what the
 * user should be told.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError) {
        const body = error.body
        if (body) {
            try {
                const parsed = JSON.parse(body) as ErrorPayload
                if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
                if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message
            } catch {
                // Not a JSON body: fall through to the fallback.
            }
        }
        return fallback
    }
    if (error instanceof Error && error.message.trim()) return error.message
    return fallback
}

export class ApiError extends Error {
    status: number
    code?: string
    body?: string

    constructor(message: string, status: number, code?: string, body?: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.body = body
    }
}

/**
 * Retry policy for hub requests.
 *
 * The hub is local, but the browser talking to it often is not: a phone on
 * flaky WiFi, a laptop waking from sleep, or the hub restarting under a dev
 * reload all surface as a failed fetch. Those failures are transient, so a
 * bounded retry turns a blip into a successful response instead of an error
 * the user has to act on.
 */

/** Total attempts, including the first one. */
const RETRY_MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 300
const RETRY_MAX_DELAY_MS = 5_000

/**
 * Statuses worth another attempt: the request never reached a handler that
 * could have applied it, or the handler itself failed transiently.
 *
 * 401 is deliberately absent - it is handled by the token refresh path, which
 * knows how to fix it.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/**
 * Only safe methods are replayed.
 *
 * A POST may already have been applied by the hub before the connection broke
 * - sending a message, archiving a session - and replaying it would duplicate
 * the effect. Mutations therefore fail fast and leave recovery to the caller.
 *
 * An endpoint may opt back in when its effect is idempotent; see
 * `FetchRetryOptions.replayable`.
 */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD'])

/**
 * Per-request overrides for the retry policy.
 */
type FetchRetryOptions = {
    /**
     * Replay this request even though its method is not inherently safe.
     *
     * Only for endpoints whose effect is idempotent. Authenticating and
     * binding qualify: both merely mint a token, so running them twice
     * changes nothing the second call would not have changed anyway. A phone
     * on flaky WiFi failing to log in deserves the same retry a read gets.
     */
    replayable?: boolean
}

/**
 * Sleep for the given delay, but wake up early if the caller aborts.
 *
 * A backoff that outlives the request it belongs to leaves the UI waiting on
 * a call the caller has already given up on.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Exponential backoff with jitter. The jitter keeps a fleet of clients from
 * retrying a restarting hub in lockstep.
 */
function backoffDelayMs(attempt: number): number {
    const capped = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS)
    return Math.round(capped * (0.5 + Math.random() * 0.5))
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Clamped to the
 * same ceiling as the computed backoff so a misbehaving hub cannot pin the UI.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
    if (!header) return undefined
    const trimmed = header.trim()
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds)) {
        return Math.min(Math.max(0, Math.round(seconds * 1000)), RETRY_MAX_DELAY_MS)
    }
    const target = Date.parse(trimmed)
    if (Number.isNaN(target)) return undefined
    return Math.min(Math.max(0, target - Date.now()), RETRY_MAX_DELAY_MS)
}

/**
 * Browsers reject an aborted fetch with a DOMException, which is not an
 * `instanceof Error`, so the name is checked on both shapes.
 */
function isAbortError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') return true
    return typeof DOMException === 'function'
        && error instanceof DOMException
        && error.name === 'AbortError'
}

/**
 * The error a cancelled request settles with. A DOMException named
 * `AbortError` is what the platform itself produces, so callers that treat
 * cancellation as "not a failure" keep treating it that way.
 */
function abortError(): DOMException | Error {
    if (typeof DOMException === 'function') {
        return new DOMException('The operation was aborted.', 'AbortError')
    }
    const error = new Error('The operation was aborted.')
    error.name = 'AbortError'
    return error
}

/**
 * Fetch with a bounded retry for transient failures.
 *
 * Retries both transport failures (the fetch itself threw) and transient
 * statuses, so a 503 from a restarting hub is replayed instead of surfacing
 * as an error. The last response is returned as-is, leaving the status to
 * error mapping to the caller.
 */
async function fetchWithRetry(
    url: string,
    init: RequestInit,
    options: FetchRetryOptions = {}
): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const replayable = options.replayable ?? REPLAYABLE_METHODS.has(method)
    const maxAttempts = replayable ? RETRY_MAX_ATTEMPTS : 1
    const signal = init.signal ?? null

    for (let attempt = 1; ; attempt++) {
        let response: Response
        try {
            response = await fetch(url, init)
        } catch (error) {
            // A transport failure: the request may never have reached the hub.
            // An aborted request is the caller's own doing and is never retried.
            if (attempt >= maxAttempts || isAbortError(error) || signal?.aborted) {
                throw error
            }
            await sleep(backoffDelayMs(attempt), signal)
            // The caller may have given up while we were waiting: do not spend
            // another request on a call nobody is waiting for.
            if (signal?.aborted) throw abortError()
            continue
        }

        if (attempt >= maxAttempts || !RETRYABLE_STATUSES.has(response.status)) {
            return response
        }

        // Release the connection before waiting, then sleep out the backoff.
        await response.text().catch(() => '')
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
        await sleep(retryAfterMs ?? backoffDelayMs(attempt), signal)
        if (signal?.aborted) throw abortError()
    }
}

export class ApiClient {
    private token: string
    private readonly baseUrl: string | null
    private readonly getToken: (() => string | null) | null
    private readonly onUnauthorized: (() => Promise<string | null>) | null

    constructor(token: string, options?: ApiClientOptions) {
        this.token = token
        this.baseUrl = options?.baseUrl ?? null
        this.getToken = options?.getToken ?? null
        this.onUnauthorized = options?.onUnauthorized ?? null
    }

    private buildUrl(path: string): string {
        if (!this.baseUrl) {
            return path
        }
        try {
            return new URL(path, this.baseUrl).toString()
        } catch {
            return path
        }
    }

    private async request<T>(
        path: string,
        init?: RequestInit,
        attempt: number = 0,
        overrideToken?: string | null
    ): Promise<T> {
        const headers = new Headers(init?.headers)
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined
            ? (overrideToken ?? (liveToken ?? this.token))
            : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
            headers.set('content-type', 'application/json')
        }

        const res = await fetchWithRetry(this.buildUrl(path), {
            ...init,
            headers
        })

        if (res.status === 401) {
            if (attempt === 0 && this.onUnauthorized) {
                const refreshed = await this.onUnauthorized()
                if (refreshed) {
                    this.token = refreshed
                    return await this.request<T>(path, init, attempt + 1, refreshed)
                }
            }
            throw new Error('Session expired. Please sign in again.')
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            throw new ApiError(
                `HTTP ${res.status} ${res.statusText}: ${body}`,
                res.status,
                code,
                body || undefined
            )
        }

        return await res.json() as T
    }

    async authenticate(auth: { initData: string } | { accessToken: string }): Promise<AuthResponse> {
        // Authenticating only mints a token, so replaying it is safe: a
        // dropped connection on a phone should not read as a failed login.
        const res = await fetchWithRetry(this.buildUrl('/api/auth'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        }, { replayable: true })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Auth failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async bind(auth: { initData: string; accessToken: string }): Promise<AuthResponse> {
        // Binding is idempotent too: the same Telegram user bound to the same
        // namespace is a no-op, so a dropped connection is safe to replay.
        const res = await fetchWithRetry(this.buildUrl('/api/bind'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        }, { replayable: true })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Bind failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async getSessions(): Promise<SessionsResponse> {
        return await this.request<SessionsResponse>('/api/sessions')
    }

    async getHealth(): Promise<HubHealthResponse> {
        return await this.request<HubHealthResponse>('/health')
    }

    async getPushVapidPublicKey(): Promise<PushVapidPublicKeyResponse> {
        return await this.request<PushVapidPublicKeyResponse>('/api/push/vapid-public-key')
    }

    async subscribePushNotifications(payload: PushSubscriptionPayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async syncCodexSession(payload?: CodexDesktopSyncRequest): Promise<CodexDesktopScriptResponse> {
        // 中文注释：当前按钮语义已改为“从 Codex 导入到 Hapi”；这里提交的是本地 transcript 对应的 Codex thread ID 列表。
        return await this.request<CodexDesktopScriptResponse>('/api/codex/sync-session', {
            method: 'POST',
            ...(payload ? { body: JSON.stringify(payload) } : {})
        })
    }

    async getCodexSessions(cwd?: string | null, machineId?: string | null): Promise<CodexLocalSessionsResponse> {
        const params = new URLSearchParams()
        if (cwd?.trim()) params.set('cwd', cwd.trim())
        if (machineId?.trim()) params.set('machineId', machineId.trim())
        const query = params.size ? `?${params.toString()}` : ''
        return await this.request<CodexLocalSessionsResponse>(`/api/codex/sessions${query}`)
    }

    async getPiSessions(cwd?: string | null, machineId?: string | null): Promise<PiLocalSessionsResponse> {
        const params = new URLSearchParams()
        if (cwd?.trim()) params.set('cwd', cwd.trim())
        if (machineId?.trim()) params.set('machineId', machineId.trim())
        const query = params.size ? `?${params.toString()}` : ''
        return await this.request<PiLocalSessionsResponse>(`/api/pi/sessions${query}`)
    }

    async importPiSessions(payload: { sessionIds: string[]; cwd?: string | null; machineId?: string | null }): Promise<PiImportSessionsResponse> {
        return await this.request<PiImportSessionsResponse>('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async archiveCodexSession(sessionId: string, machineId?: string | null): Promise<CodexArchiveSessionResponse> {
        return await this.request<CodexArchiveSessionResponse>('/api/codex/archive-session', {
            method: 'POST',
            body: JSON.stringify({ sessionId, machineId: machineId ?? undefined })
        })
    }

    async getCodexDesktopStatus(): Promise<CodexDesktopStatusResponse> {
        return await this.request<CodexDesktopStatusResponse>('/api/codex/status')
    }

    async getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): Promise<CodexDuplicateSessionsResponse> {
        // 中文注释：重复会话检测只传本次用户勾选导入的 codexSessionId，避免把未选中的历史会话也纳入提示。
        return await this.request<CodexDuplicateSessionsResponse>('/api/codex/duplicate-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): Promise<CodexMergeDuplicateSessionsResponse> {
        // 中文注释：真正执行合并时沿用同一批选中 codexSessionId，保证检测范围与执行范围一致。
        return await this.request<CodexMergeDuplicateSessionsResponse>('/api/codex/merge-duplicate-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async restartCodexDesktop(): Promise<CodexDesktopScriptResponse> {
        return await this.request<CodexDesktopScriptResponse>('/api/codex/restart-desktop', {
            method: 'POST'
        })
    }

    async unsubscribePushNotifications(payload: PushUnsubscribePayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'DELETE',
            body: JSON.stringify(payload)
        })
    }

    async setVisibility(payload: VisibilityPayload): Promise<void> {
        await this.request('/api/visibility', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async getSession(sessionId: string): Promise<SessionResponse> {
        return await this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    }

    async getSessionExport(
        sessionId: string,
        options?: { force?: boolean; signal?: AbortSignal }
    ): Promise<HapiSessionExportResponse> {
        const query = options?.force ? '?force=true' : ''
        return await this.request<HapiSessionExportResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/export${query}`,
            { signal: options?.signal }
        )
    }

    async getMessages(
        sessionId: string,
        options: {
            beforeSeq?: number | null
            beforeAt?: number | null
            afterSeq?: number | null
            afterAt?: number | null
            untilSeq?: number | null
            untilAt?: number | null
            epoch?: number | null
            limit?: number
        }
    ): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.beforeAt !== undefined && options.beforeAt !== null) {
            params.set('beforeAt', `${options.beforeAt}`)
        }
        if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.afterAt !== undefined && options.afterAt !== null) {
            params.set('afterAt', `${options.afterAt}`)
        }
        if (options.afterSeq !== undefined && options.afterSeq !== null) {
            params.set('afterSeq', `${options.afterSeq}`)
        }
        if (options.untilAt !== undefined && options.untilAt !== null) {
            params.set('untilAt', `${options.untilAt}`)
        }
        if (options.untilSeq !== undefined && options.untilSeq !== null) {
            params.set('untilSeq', `${options.untilSeq}`)
        }
        if (options.epoch !== undefined && options.epoch !== null) {
            params.set('epoch', `${options.epoch}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }

        const qs = params.toString()
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
        return await this.request<MessagesResponse>(url)
    }

    async getGitStatus(sessionId: string): Promise<GitCommandResponse> {
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-status`)
    }

    async getGitDiffNumstat(sessionId: string, staged: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('staged', staged ? 'true' : 'false')
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`)
    }

    async getGitDiffFile(sessionId: string, path: string, staged?: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (staged !== undefined) {
            params.set('staged', staged ? 'true' : 'false')
        }
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`)
    }

    async searchSessionFiles(sessionId: string, query: string, limit?: number): Promise<FileSearchResponse> {
        const params = new URLSearchParams()
        if (query) {
            params.set('query', query)
        }
        if (limit !== undefined) {
            params.set('limit', `${limit}`)
        }
        const qs = params.toString()
        return await this.request<FileSearchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ''}`)
    }

    async getGeneratedImageBlob(sessionId: string, imageId: string, attempt: number = 0, overrideToken?: string | null): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined
            ? (overrideToken ?? (liveToken ?? this.token))
            : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const url = this.buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/generated-images/${encodeURIComponent(imageId)}`)
        let res = await fetchWithRetry(url, { headers })
        // Hub returns ETag + immutable Cache-Control (#927). Default fetch cache stores 200
        // responses so remounts avoid RPC; on 304 the body is empty — read from cache.
        if (res.status === 304) {
            res = await fetchWithRetry(url, { headers, cache: 'force-cache' })
        }
        if (res.status === 401 && attempt === 0 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                return await this.getGeneratedImageBlob(sessionId, imageId, attempt + 1, refreshed)
            }
        }
        if (!res.ok) {
            throw new ApiError(`HTTP ${res.status}`, res.status, undefined, await res.text().catch(() => undefined))
        }
        return await res.blob()
    }

    async readSessionFile(sessionId: string, path: string): Promise<FileReadResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        return await this.request<FileReadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`)
    }

    async listSessionDirectory(sessionId: string, path?: string): Promise<ListDirectoryResponse> {
        const params = new URLSearchParams()
        if (path) {
            params.set('path', path)
        }

        const qs = params.toString()
        return await this.request<ListDirectoryResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/directory${qs ? `?${qs}` : ''}`
        )
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<UploadFileResponse> {
        return await this.request<UploadFileResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload`, {
            method: 'POST',
            body: JSON.stringify({ filename, content, mimeType })
        })
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<DeleteUploadResponse> {
        return await this.request<DeleteUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload/delete`, {
            method: 'POST',
            body: JSON.stringify({ path })
        })
    }

    /**
     * Delete a file or directory from the working directory of the session.
     *
     * The path is workspace-relative. The CLI owns it and refuses anything
     * outside of the working directory.
     */
    async deleteWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceDeleteResponse> {
        return await this.request<WorkspaceDeleteResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/workspace/delete`,
            {
                method: 'POST',
                body: JSON.stringify({ path })
            }
        )
    }

    /** Open a chunked upload of a file into the session working directory. */
    async startWorkspaceUpload(
        sessionId: string,
        options: { path: string; size: number; overwrite: boolean },
        signal?: AbortSignal
    ): Promise<WorkspaceUploadStartResponse> {
        return await this.request<WorkspaceUploadStartResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload`,
            {
                method: 'POST',
                body: JSON.stringify({ action: 'start', ...options }),
                signal
            }
        )
    }

    /** Send one chunk of an open workspace upload. */
    async appendWorkspaceUpload(
        sessionId: string,
        options: { uploadId: string; offset: number; content: string },
        signal?: AbortSignal
    ): Promise<WorkspaceUploadChunkResponse> {
        return await this.request<WorkspaceUploadChunkResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload`,
            {
                method: 'POST',
                body: JSON.stringify({ action: 'chunk', ...options }),
                signal
            }
        )
    }

    /** Close an open workspace upload and move the file into place. */
    async finishWorkspaceUpload(sessionId: string, uploadId: string): Promise<WorkspaceUploadFinishResponse> {
        return await this.request<WorkspaceUploadFinishResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload`,
            {
                method: 'POST',
                body: JSON.stringify({ action: 'finish', uploadId })
            }
        )
    }

    /** Drop an open workspace upload and its partial file. */
    async abortWorkspaceUpload(sessionId: string, uploadId: string): Promise<WorkspaceUploadAbortResponse> {
        return await this.request<WorkspaceUploadAbortResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload`,
            {
                method: 'POST',
                body: JSON.stringify({ action: 'abort', uploadId })
            }
        )
    }

    async resumeSession(sessionId: string, opts?: { permissionMode?: string }): Promise<string> {
        const response = await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
            {
                method: 'POST',
                ...(opts?.permissionMode !== undefined && {
                    body: JSON.stringify({ permissionMode: opts.permissionMode })
                })
            }
        )
        return response.sessionId
    }

    async getCursorChatStoreStatus(sessionId: string): Promise<CursorChatStoreStatus> {
        return await this.request<CursorChatStoreStatus>(
            `/api/sessions/${encodeURIComponent(sessionId)}/cursor-chat-store`
        )
    }

    async sendMessage(
        sessionId: string,
        text: string,
        localId?: string | null,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                text,
                localId: localId ?? undefined,
                attachments: attachments ?? undefined,
                scheduledAt: scheduledAt ?? undefined,
                deliveryMode: deliveryMode ?? undefined,
            })
        })
    }

    async getQueuedState(sessionId: string, localIds: string[]): Promise<QueuedStateResponse> {
        return await this.request<QueuedStateResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/queued-state`,
            {
                method: 'POST',
                body: JSON.stringify({ localIds })
            }
        )
    }

    async cancelMessage(sessionId: string, messageId: string): Promise<CancelMessageResponse> {
        const response = await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
            { method: 'DELETE' }
        )
        return response as CancelMessageResponse
    }

    async steerMessage(sessionId: string, messageId: string): Promise<SteerQueuedMessageResponse> {
        const response = await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/steer`,
            { method: 'POST' }
        )
        return response as SteerQueuedMessageResponse
    }

    async retryIndeterminateMessage(sessionId: string, messageId: string): Promise<RetryIndeterminateMessageResponse> {
        return await this.request<RetryIndeterminateMessageResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/retry`,
            { method: 'POST' }
        )
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async clearConversation(sessionId: string): Promise<{ sessionId: string }> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, { method: 'POST' })
    }

    async implementCodexPlan(sessionId: string, planId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/codex/plan/implement`, {
            method: 'POST', body: JSON.stringify({ planId })
        })
    }

    async forkConversation(sessionId: string, messageLocalId?: string): Promise<{ sessionId: string }> {
        return await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
            {
                method: 'POST',
                body: JSON.stringify(messageLocalId ? { messageLocalId } : {})
            }
        )
    }

    async rewindConversation(sessionId: string, messageLocalId: string): Promise<{ success: true }> {
        return await this.request<{ success: true }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/rewind`,
            {
                method: 'POST',
                body: JSON.stringify({ messageLocalId })
            }
        )
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async reopenSession(sessionId: string): Promise<ReopenSessionResponse> {
        return await this.request<ReopenSessionResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/reopen`,
            { method: 'POST', body: JSON.stringify({}) }
        )
    }

    /**
     * Migrate a legacy stream-json Cursor session to ACP. See tiann/hapi#824.
     *
     * Refusals (e.g. running session, missing on-disk store, target collision)
     * are returned as structured `{ok: false, reason, message}` outcomes
     * rather than thrown - the UI surfaces the reason to the operator and the
     * underlying state on disk is unchanged.
     *
     * 401s trigger the same onUnauthorized refresh path as the shared
     * `request()` helper so an expired JWT silently re-auths instead of
     * hard-failing the migration dialog (Codex review #34 P2).
     */
    async migrateCursorSessionToAcp(sessionId: string, body: CursorMigrateToAcpRequest = {}): Promise<CursorMigrateOutcome> {
        const path = `/api/sessions/${encodeURIComponent(sessionId)}/migrate-to-acp`
        const tryOnce = async (overrideToken: string | null): Promise<Response> => {
            const headers = new Headers({ 'content-type': 'application/json' })
            const liveToken = this.getToken ? this.getToken() : null
            const authToken = overrideToken ?? liveToken ?? this.token
            if (authToken) {
                headers.set('authorization', `Bearer ${authToken}`)
            }
            return fetchWithRetry(this.buildUrl(path), { method: 'POST', headers, body: JSON.stringify(body) })
        }

        let res = await tryOnce(null)
        if (res.status === 401 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                res = await tryOnce(refreshed)
            }
        }
        if (res.status === 401) {
            throw new Error('Session expired. Please sign in again.')
        }
        const text = await res.text()
        let parsed: CursorMigrateOutcome | null = null
        try {
            parsed = text ? JSON.parse(text) as CursorMigrateOutcome : null
        } catch {
            parsed = null
        }
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            return parsed
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
    }

    async switchSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/switch`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setCollaborationMode(sessionId: string, mode: CodexCollaborationMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/collaboration-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setModel(sessionId: string, model: { provider: string; modelId: string } | string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify({ model })
        })
    }

    async setModelReasoningEffort(sessionId: string, modelReasoningEffort: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model-reasoning-effort`, {
            method: 'POST',
            body: JSON.stringify({ modelReasoningEffort })
        })
    }

    async setEffort(sessionId: string, effort: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/effort`, {
            method: 'POST',
            body: JSON.stringify({ effort })
        })
    }

    async setServiceTier(sessionId: string, serviceTier: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/service-tier`, {
            method: 'POST',
            body: JSON.stringify({ serviceTier })
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        modeOrOptions?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan' | {
            mode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
            allowTools?: string[]
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
            answers?: Record<string, string[]> | Record<string, { answers: string[] }>
        }
    ): Promise<void> {
        const body = typeof modeOrOptions === 'string' || modeOrOptions === undefined
            ? { mode: modeOrOptions }
            : modeOrOptions
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`, {
            method: 'POST',
            body: JSON.stringify(body)
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        options?: {
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
        }
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`, {
            method: 'POST',
            body: JSON.stringify(options ?? {})
        })
    }

    async getMachines(): Promise<MachinesResponse> {
        return await this.request<MachinesResponse>('/api/machines')
    }

    /** Pass an empty string to clear the custom name and fall back to the hostname. */
    async renameMachine(machineId: string, displayName: string): Promise<void> {
        await this.request(`/api/machines/${encodeURIComponent(machineId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ displayName })
        })
    }

    async getSqliteStorageUsage(): Promise<SqliteStorageUsageResponse> {
        return await this.request<SqliteStorageUsageResponse>('/api/storage/sqlite')
    }

    async getHubSettings(): Promise<HubSettingsResponse> {
        return await this.request<HubSettingsResponse>('/api/hub-settings')
    }

    async updateHubSettings(settings: UpdateHubSettingsRequest): Promise<HubSettingsResponse> {
        return await this.request<HubSettingsResponse>('/api/hub-settings', {
            method: 'PUT',
            body: JSON.stringify(settings)
        })
    }

    async getUsageSummary(
        range: '7d' | '30d' | 'all' = '7d',
        timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    ): Promise<UsageSummaryResponse> {
        const params = new URLSearchParams({
            range,
            timeZone
        })
        return await this.request<UsageSummaryResponse>(`/api/usage/summary?${params.toString()}`)
    }

    async restartMachineRunner(machineId: string): Promise<{ message: string }> {
        return await this.request<{ message: string }>(
            `/api/machines/${encodeURIComponent(machineId)}/restart-runner`,
            { method: 'POST', body: '{}' }
        )
    }

    async listMachineDirectory(
        machineId: string,
        path: string,
        options?: { includeHidden?: boolean }
    ): Promise<MachineListDirectoryResponse> {
        return await this.request<MachineListDirectoryResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/list-directory`,
            {
                method: 'POST',
                body: JSON.stringify({ path, includeHidden: options?.includeHidden === true })
            }
        )
    }

    async getMachineAgentAvailability(machineId: string): Promise<AgentAvailabilityResponse> {
        return await this.request<AgentAvailabilityResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/agent-availability`
        )
    }

    async checkMachinePathsExists(
        machineId: string,
        paths: string[]
    ): Promise<MachinePathsExistsResponse> {
        return await this.request<MachinePathsExistsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/paths/exists`,
            {
                method: 'POST',
                body: JSON.stringify({ paths })
            }
        )
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent?: AgentFlavor,
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: 'fast' | 'standard',
        collaborationMode?: CodexCollaborationMode,
        copilotAgentMode?: CopilotAgentMode,
        startingMode?: 'remote' | 'pty'
    ): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({
                directory,
                agent,
                model,
                modelReasoningEffort,
                yolo,
                sessionType,
                worktreeName,
                effort,
                permissionMode,
                serviceTier,
                collaborationMode,
                copilotAgentMode,
                startingMode
            })
        })
    }

    async getMachineAgyModels(
        machineId: string,
        options?: { refresh?: boolean }
    ): Promise<AgyModelsResponse> {
        // Without `refresh` the machine may answer from its cached catalog.
        const query = options?.refresh ? '?refresh=true' : ''
        return await this.request<AgyModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/agy-models${query}`
        )
    }

    async getMachinePiModels(machineId: string): Promise<PiModelsResponse> {
        return await this.request<PiModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/pi-models`
        )
    }

    async getMachineCodexModels(machineId: string): Promise<CodexModelsResponse> {
        return await this.request<CodexModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/codex-models`
        )
    }

    async getSessionCodexModels(sessionId: string): Promise<CodexModelsResponse> {
        return await this.request<CodexModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/codex-models`
        )
    }

    async getSessionOpencodeModels(sessionId: string): Promise<OpencodeModelsResponse> {
        return await this.request<OpencodeModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/opencode-models`
        )
    }

    async getSessionOpencodeReasoningEffortOptions(sessionId: string): Promise<OpencodeReasoningEffortResponse> {
        return await this.request<OpencodeReasoningEffortResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/opencode-reasoning-effort-options`
        )
    }

    async getSessionCursorModels(sessionId: string): Promise<CursorModelsResponse> {
        return await this.request<CursorModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/cursor-models`
        )
    }

    /** Generic Pi session endpoint — replaces per-method wrappers. */
    async callPiEndpoint<T = unknown>(sessionId: string, path: string, init?: RequestInit): Promise<T> {
        return await this.request<T>(
            `/api/sessions/${encodeURIComponent(sessionId)}/pi-${path}`,
            init
        )
    }

    async getMachineCursorModels(machineId: string): Promise<CursorModelsResponse> {
        return await this.request<CursorModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/cursor-models`
        )
    }

    async getMachineOpencodeModelsForCwd(machineId: string, cwd: string): Promise<OpencodeModelsResponse> {
        return await this.request<OpencodeModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/opencode-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getMachineOpencodeModelVariants(machineId: string, cwd?: string | null): Promise<OpencodeModelVariantsResponse> {
        return await this.request<OpencodeModelVariantsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/opencode-model-variants${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
        )
    }

    async getMachineGrokModelsForCwd(machineId: string, cwd: string): Promise<GrokModelsResponse> {
        return await this.request<GrokModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/grok-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getMachineCopilotModelsForCwd(machineId: string, cwd: string): Promise<CopilotModelsResponse> {
        return await this.request<CopilotModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/copilot-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getMachineKimiModelsForCwd(machineId: string, cwd: string): Promise<KimiModelsResponse> {
        return await this.request<KimiModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/kimi-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    async getSessionKimiModels(sessionId: string): Promise<KimiModelsResponse> {
        return await this.request<KimiModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/kimi-models`
        )
    }

    async getMachineMcodeModelsForCwd(machineId: string, cwd: string): Promise<McodeModelsResponse> {
        return await this.request<McodeModelsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/mcode-models?cwd=${encodeURIComponent(cwd)}`
        )
    }

    /**
     * Lists the apps connected to the machine's MiniMax Code installation.
     *
     * The connector tools are not part of the ACP surface, so this is the
     * only way a client learns what the agent can reach.
     */
    async getMachineMcodeApps(machineId: string, options?: { forceRefresh?: boolean }): Promise<McodeAppsResponse> {
        const query = options?.forceRefresh ? '?forceRefresh=1' : ''
        return await this.request<McodeAppsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/mcode-apps${query}`
        )
    }

    /**
     * Lists the apps connected to the session's MiniMax Code installation.
     *
     * The session scope is the exact one for a running session: the agent
     * that runs it names its own broker, so the answer is about the agent
     * the user is looking at.
     */
    async getSessionMcodeApps(sessionId: string, options?: { forceRefresh?: boolean }): Promise<McodeAppsResponse> {
        const query = options?.forceRefresh ? '?forceRefresh=1' : ''
        return await this.request<McodeAppsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/mcode-apps${query}`
        )
    }

    /**
     * The usage window of a MiniMax account of the machine.
     *
     * The source names the credential the window is read with: the account of
     * the MiniMax Code install, or the account of the Pi install.
     */
    async getMachineMinimaxQuota(machineId: string, source: MinimaxQuotaSource = 'mcode'): Promise<MinimaxQuotaResponse> {
        return await this.request<MinimaxQuotaResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/minimax-quota?source=${encodeURIComponent(source)}`
        )
    }

    /**
     * The usage window of the MiniMax account the session spends.
     *
     * The session decides which account is read: a Pi session reads the
     * account of the Pi install and needs nothing of MiniMax Code.
     */
    async getSessionMinimaxQuota(sessionId: string): Promise<MinimaxQuotaResponse> {
        return await this.request<MinimaxQuotaResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/minimax-quota`
        )
    }

    async getSessionMcodeModels(sessionId: string): Promise<McodeModelsResponse> {
        return await this.request<McodeModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/mcode-models`
        )
    }

    /**
     * Creates MiniMax Code's autonomous goal for the session.
     *
     * The agent starts executing the objective as soon as the goal exists, so
     * this is not a request it reviews later.
     */
    async createMcodeGoal(
        sessionId: string,
        objective: string,
        tokenBudget?: number | null
    ): Promise<McodeGoalResponse> {
        return await this.request<McodeGoalResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/mcode/goal`,
            {
                method: 'POST',
                body: JSON.stringify({
                    objective,
                    ...(tokenBudget === undefined ? {} : { tokenBudget })
                })
            }
        )
    }

    /** Patches the goal's objective, status or token budget. */
    async patchMcodeGoal(
        sessionId: string,
        patch: { status?: string; objective?: string; tokenBudget?: number | null }
    ): Promise<McodeGoalResponse> {
        return await this.request<McodeGoalResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/mcode/goal`,
            { method: 'PATCH', body: JSON.stringify(patch) }
        )
    }

    /** Clears the session's goal. */
    async clearMcodeGoal(sessionId: string): Promise<McodeGoalClearResponse> {
        return await this.request<McodeGoalClearResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/mcode/goal`,
            { method: 'DELETE' }
        )
    }

    /** Stops the session's delegated sessions (its subagents). */
    async stopMcodeDelegation(sessionId: string): Promise<McodeDelegationStopResponse> {
        return await this.request<McodeDelegationStopResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/mcode/delegation/stop`,
            { method: 'POST' }
        )
    }

    async getSessionGrokModels(sessionId: string): Promise<GrokModelsResponse> {
        return await this.request<GrokModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/grok-models`
        )
    }

    async getSessionCopilotModels(sessionId: string): Promise<CopilotModelsResponse> {
        return await this.request<CopilotModelsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/copilot-models`
        )
    }

    async setCopilotAgentMode(sessionId: string, mode: CopilotAgentMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/copilot-agent-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async getSessionGrokReasoningEffortOptions(sessionId: string): Promise<GrokReasoningEffortResponse> {
        return await this.request<GrokReasoningEffortResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/grok-reasoning-effort-options`
        )
    }

    async getSlashCommands(sessionId: string): Promise<SlashCommandsResponse> {
        return await this.request<SlashCommandsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`
        )
    }

    async getSkills(sessionId: string): Promise<SkillsResponse> {
        return await this.request<SkillsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/skills`
        )
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name })
        })
    }

    async suggestSessionTitle(sessionId: string): Promise<SessionTitleSuggestionResponse> {
        return await this.request<SessionTitleSuggestionResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/title-suggestion`,
            { method: 'POST' }
        )
    }

    async updateSessionSummary(sessionId: string, text: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/summary`, {
            method: 'PATCH',
            body: JSON.stringify({ text })
        })
    }

    async setSessionPinMode(sessionId: string, mode: 'none' | 'project' | 'global'): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
            method: 'PUT',
            body: JSON.stringify({ mode })
        })
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE'
        })
    }

    /*
     * Scratchlist v2 (tiann/hapi#893).
     *
     * The hub is the durable store; localStorage is demoted to an
     * offline cache. Mutations return the canonical entry so optimistic
     * updates can reconcile with the hub-stamped `updatedAt`.
     */

    async getScratchlist(sessionId: string): Promise<{
        entries: Array<{
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }>
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist`
        )
    }

    async uploadScratchlistAttachment(
        sessionId: string,
        filename: string,
        content: string,
        mimeType: string
    ): Promise<{
        success: boolean
        attachment?: import('@hapi/protocol').ScratchlistAttachmentMetadata
        error?: string
        code?: string
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/upload`,
            {
                method: 'POST',
                body: JSON.stringify({ filename, content, mimeType })
            }
        )
    }

    async fetchScratchlistAttachmentBlob(sessionId: string, attachmentId: string): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = liveToken ?? this.token
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const response = await fetchWithRetry(
            this.buildUrl(
                `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/attachments/${encodeURIComponent(attachmentId)}`
            ),
            { headers }
        )
        if (!response.ok) {
            throw new ApiError(`Failed to fetch scratchlist attachment (${response.status})`, response.status)
        }
        return await response.blob()
    }

    async deleteScratchlistAttachment(sessionId: string, attachmentId: string): Promise<void> {
        await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/attachments/${encodeURIComponent(attachmentId)}`,
            { method: 'DELETE' }
        )
    }

    async createScratchlistEntry(
        sessionId: string,
        body: {
            text: string
            entryId?: string
            createdAt?: number
            attachments?: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    ): Promise<{
        entry: {
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist`,
            {
                method: 'POST',
                body: JSON.stringify(body)
            }
        )
    }

    async updateScratchlistEntry(
        sessionId: string,
        entryId: string,
        text: string
    ): Promise<{
        entry: {
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/${encodeURIComponent(entryId)}`,
            {
                method: 'PUT',
                body: JSON.stringify({ text })
            }
        )
    }

    async deleteScratchlistEntry(sessionId: string, entryId: string): Promise<void> {
        await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/scratchlist/${encodeURIComponent(entryId)}`,
            { method: 'DELETE' }
        )
    }

    async fetchVoiceToken(options?: { customAgentId?: string; customApiKey?: string; voiceId?: string }): Promise<{
        allowed: boolean
        token?: string
        agentId?: string
        error?: string
    }> {
        return await this.request('/api/voice/token', {
            method: 'POST',
            body: JSON.stringify(options || {})
        })
    }

    async fetchVoices(): Promise<{ voices: Array<{ id: string; name: string; previewUrl: string; category: string }> }> {
        return await this.request('/api/voice/voices')
    }

    async sendVoiceTelemetry(event: {
        stage: string
        message: string
        sessionId?: string
        voiceId?: string
        language?: string
        details?: Record<string, unknown>
    }): Promise<void> {
        await this.request('/api/voice/telemetry', {
            method: 'POST',
            body: JSON.stringify(event)
        })
    }

    /** Return the current auth token (for WebSocket query-param auth). */
    getAuthToken(): string | null {
        return this.getToken ? this.getToken() : this.token
    }

    async fetchVoiceBackend(): Promise<{ backend: string | null; backends: string[] }> {
        return await this.request('/api/voice/backend')
    }

    async fetchTranscriptionProviders(): Promise<{ providers: TranscriptionProviderInfo[] }> {
        return await this.request('/api/voice/transcription/providers')
    }

    async fetchTranscriptionCredentials(): Promise<TranscriptionCredentialStatus> {
        return await this.request('/api/voice/transcription/credentials')
    }

    async updateTranscriptionCredentials(
        update: TranscriptionCredentialsUpdate
    ): Promise<TranscriptionCredentialStatus> {
        return await this.request('/api/voice/transcription/credentials', {
            method: 'PUT',
            body: JSON.stringify(update),
        })
    }

    async transcribeVoice(options: {
        file: File
        provider: TranscriptionProvider
        mode: TranscriptionMode
        language?: string
    }): Promise<{ text: string; language?: string }> {
        const form = new FormData()
        form.set('file', options.file)
        form.set('provider', options.provider)
        form.set('mode', options.mode)
        if (options.language) form.set('language', options.language)
        return await this.request('/api/voice/transcription', { method: 'POST', body: form })
    }

    async fetchRealtimeTranscriptionToken(
        provider: 'openai' | 'elevenlabs' | 'deepgram',
        language?: string,
        signal?: AbortSignal
    ): Promise<{ token: string }> {
        return await this.request('/api/voice/transcription/realtime-token', {
            method: 'POST',
            signal,
            body: JSON.stringify({ provider, language })
        })
    }

    async fetchQwenToken(): Promise<{
        allowed: boolean
        wsUrl?: string
        error?: string
    }> {
        return await this.request('/api/voice/qwen-token', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async fetchGeminiToken(): Promise<{
        allowed: boolean
        apiKey?: string
        wsUrl?: string
        baseUrl?: string
        error?: string
    }> {
        return await this.request('/api/voice/gemini-token', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }
}
