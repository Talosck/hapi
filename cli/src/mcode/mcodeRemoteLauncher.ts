import React from 'react';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { McodeDisplay } from '@/ui/ink/McodeDisplay';
import type { McodeSession } from './session';
import type { PermissionMode } from './types';
import { createMcodeBackend } from './utils/mcodeBackend';
import { McodePermissionHandler } from './utils/permissionHandler';
import { applyMcodePermissionMode } from './utils/permissionModes';

class McodeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: McodeSession;
    private readonly model?: string;
    private backend: ReturnType<typeof createMcodeBackend> | null = null;
    private permissionHandler: McodePermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private appliedPermissionMode: PermissionMode | null = null;
    private hasAppliedPermissionMode = false;

    constructor(session: McodeSession, opts: { model?: string }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.model = opts.model;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(McodeDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'mcode' }
        });
        this.happyServer = happyServer;

        const backend = createMcodeBackend();
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            logger.debug('[mcode-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        const acpMcpServers = toAcpMcpServers(mcpServers);
        let acpSessionId: string;
        if (session.sessionId) {
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: session.sessionId,
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
            } catch (error) {
                logger.warn('[mcode-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'MiniMax Code resume failed; starting a new session.'
                });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
            }
        } else {
            acpSessionId = await backend.newSession({
                cwd: session.path,
                mcpServers: acpMcpServers
            });
        }
        session.onSessionFound(acpSessionId);

        this.permissionHandler = new McodePermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );

        // The permission policy is a per-process config option and the plan
        // mode is an ACP session mode; both have to be applied before the
        // first turn so the agent never runs with a policy the user did not
        // pick.
        await this.applyPermissionMode(acpSessionId, session.getPermissionMode() as PermissionMode | undefined);

        const effectiveModel = await this.applyInitialModel(acpSessionId, this.model);
        this.currentBackendModel = effectiveModel;
        this.defaultBackendModel = effectiveModel;
        if (effectiveModel) {
            this.displayModel = effectiveModel;
            messageBuffer.addMessage(`[MODEL:${effectiveModel}]`, 'system');
        }
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode | undefined, effectiveModel ?? undefined);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal);
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            // `null` means "back to the agent default" (the model the session
            // was created with); `undefined` means "no explicit choice".
            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;
            if (requestedModel && requestedModel !== this.currentBackendModel) {
                try {
                    await backend.setModel(acpSessionId, requestedModel, { flavor: 'mcode' });
                    this.currentBackendModel = requestedModel;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn('[mcode-remote] Inline model switch failed', error);
                    session.sendSessionEvent({
                        type: 'message',
                        message: `Failed to switch model to ${requestedModel}: ${message}`
                    });
                    batch.mode.model = this.currentBackendModel ?? undefined;
                }
            }

            await this.applyPermissionMode(acpSessionId, batch.mode.permissionMode);

            this.applyDisplayMode(batch.mode.permissionMode, batch.mode.model ?? undefined);
            messageBuffer.addMessage(batch.message, 'user');

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn('[mcode-remote] prompt failed', { message: errorMessage });
                session.sendSessionEvent({
                    type: 'message',
                    message: `MiniMax Code prompt failed: ${errorMessage}`
                });
                messageBuffer.addMessage(`MiniMax Code prompt failed: ${errorMessage}`, 'status');
            } finally {
                session.onThinkingChange(false);
                await this.permissionHandler?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.permissionHandler) {
            await this.permissionHandler.cancelAll('Session ended');
            this.permissionHandler = null;
        }

        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }
    }

    private async applyPermissionMode(sessionId: string, mode: PermissionMode | undefined): Promise<void> {
        if (!this.backend) return;
        if (this.hasAppliedPermissionMode && this.appliedPermissionMode === mode) return;
        try {
            await applyMcodePermissionMode(this.backend, sessionId, mode);
            this.appliedPermissionMode = mode ?? null;
            this.hasAppliedPermissionMode = true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('[mcode-remote] Failed to apply permission mode', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to apply MiniMax Code permission mode: ${message}`
            });
        }
    }

    private async applyInitialModel(sessionId: string, model: string | undefined): Promise<string | null> {
        if (!this.backend) return null;

        const catalogModel = this.backend.getSessionModelsMetadata(sessionId)?.currentModelId ?? null;

        if (!model) {
            return catalogModel;
        }

        try {
            await this.backend.setModel(sessionId, model, { flavor: 'mcode' });
            return model;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('[mcode-remote] Failed to apply model', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch model to ${model}: ${message}. Using the agent default.`
            });
            return catalogModel;
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentBackendModel);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                if (!message.live) {
                    this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
                }
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            case 'usage':
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined, model?: string): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
        if (model && model !== this.displayModel) {
            this.displayModel = model;
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
        }
    }

    private async handleAbort(): Promise<void> {
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            await backend.cancelPrompt(this.session.sessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' });
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }));
}

export async function mcodeRemoteLauncher(
    session: McodeSession,
    opts: { model?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new McodeRemoteLauncher(session, opts);
    return launcher.launch();
}
