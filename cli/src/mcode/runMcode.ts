import { logger } from '@/ui/logger';
import { mcodeLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { McodeSession } from './session';
import type { McodeMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { registerMcodeSessionModelHandlers } from '@/modules/common/handlers/mcodeModels';

export async function runMcode(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    /** Fresh-spawn reserved hub id from `--hapi-session-id` (create/getOrCreate). */
    reservedSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[mcode] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[mcode] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'mcode',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'mcode',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: opts.model,
            effort: opts.effort,
            reservedSessionId: opts.reservedSessionId
        });
    const { api, session } = bootstrap;

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<McodeMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort
    }));

    const sessionWrapperRef: { current: McodeSession | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let sessionModel: string | null = opts.model ?? null;
    let sessionEffort: string | null = opts.effort && opts.effort !== 'default' ? opts.effort : null;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'mcode',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);
    // Registered here as the local-mode fallback: the catalog is backend
    // independent, and a session in local mode must answer the web picker
    // before remote control is taken over. The remote launcher replaces this
    // handler with one that reads the live ACP session once it is ready.
    registerMcodeSessionModelHandlers(session.rpcHandlerManager, () => workingDirectory);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(sessionModel);
        sessionInstance.setEffort(sessionEffort);
        sessionInstance.pushKeepAlive();

        logger.debug(`[mcode] Synced session config for keepalive: permissionMode=${currentPermissionMode}, model=${sessionModel ?? 'agent default'}`);
    };

    // The remote launcher owns the ACP conversation, so it is the first place
    // that learns which model the native session actually runs and whether a
    // requested mode/model switch was accepted. Feed both back into the
    // keepalive; otherwise the hub keeps advertising rejected config.
    const applyDiscoveredModel = (model: string | null) => {
        sessionModel = model;
        syncSessionMode();
    };
    const applyRolledBackPermissionMode = (mode: PermissionMode) => {
        currentPermissionMode = mode;
        syncSessionMode();
    };
    const applyDiscoveredEffort = (effort: string | null) => {
        sessionEffort = effort;
        syncSessionMode();
    };

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        const mode: McodeMode = {
            permissionMode: currentPermissionMode,
            model: sessionModel,
            effort: sessionEffort
        };
        messageQueue.push(formattedText, mode, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[mcode] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    registerSessionConfigRpc<PermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'mcode',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'ignore',
        effortMode: 'nullable',
        onApply: (config) => {
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode;
            }
            if (config.model !== undefined) {
                sessionModel = config.model;
            }
            if (config.effort !== undefined) {
                sessionEffort = config.effort === 'default' ? null : config.effort;
            }
            syncSessionMode();
        }
    });

    let crashed = false;

    try {
        await mcodeLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined,
            effort: sessionEffort ?? undefined,
            resumeSessionId: opts.resumeSessionId,
            onModeChange: createModeChangeHandler(session),
            onConfigDiscovered: (config) => {
                applyDiscoveredModel(config.model);
                applyDiscoveredEffort(config.effort);
            },
            onModelRollback: (model) => applyDiscoveredModel(model),
            onEffortRollback: (effort) => applyDiscoveredEffort(effort),
            onPermissionModeRollback: (mode) => applyRolledBackPermissionMode(mode),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[mcode] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`);
            lifecycle.setSessionEndReason('error');
        } else if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
