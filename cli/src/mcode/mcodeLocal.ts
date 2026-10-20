import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { acpModelIdToCliModelId } from './utils/modelId';

export type McodeLocalOptions = {
    path: string;
    abort: AbortSignal;
    /** Native MiniMax Code session id to reopen (`mcode --session <id>`). */
    sessionId?: string | null;
    /** ACP wire model id (`m:provider:model:v:variant`). */
    model?: string;
};

export function buildMcodeLocalArgs(opts: { sessionId?: string | null; model?: string }): string[] {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('--session', opts.sessionId);
    }

    // The TUI only accepts `provider/model[#variant]`, so the ACP wire id has
    // to be translated first. An unrecognised id is dropped rather than
    // passed on — the CLI rejects unknown `--model` values outright.
    const cliModel = acpModelIdToCliModelId(opts.model);
    if (cliModel) {
        args.push('--model', cliModel);
    }

    return args;
}

export async function mcodeLocal(opts: McodeLocalOptions): Promise<void> {
    const args = buildMcodeLocalArgs(opts);

    logger.debug(`[McodeLocal] Spawning mcode with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command: getAgentLaunchCommand('mcode'),
        args,
        cwd: opts.path,
        env: process.env,
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'McodeLocal',
        spawnName: 'mcode',
        installHint: 'MiniMax Code CLI (npm install -g @minimax-ai/code)',
        includeCause: true,
        logExit: true
    });
}
