import chalk from 'chalk';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { initializeToken } from '@/ui/tokenInit';
import { maybeAutoStartServer } from '@/utils/autoStartServer';
import type { CommandDefinition } from './types';
import { MCODE_PERMISSION_MODES } from '@hapi/protocol/modes';
import type { McodePermissionMode } from '@hapi/protocol/types';

export type ParsedMcodeCommandOptions = {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: McodePermissionMode
    model?: string
    resumeSessionId?: string
    existingSessionId?: string
    /** Fresh-spawn reserved hub id (`--hapi-session-id`); not reopen. */
    reservedSessionId?: string;
};

/** Pure argv parser for `hapi mcode` — exported for unit tests. */
export function parseMcodeCommandOptions(commandArgs: string[]): ParsedMcodeCommandOptions {
    const options: ParsedMcodeCommandOptions = {};
    let hasExplicitPermissionMode = false;

    for (let i = 0; i < commandArgs.length; i++) {
        const arg = commandArgs[i];
        if (arg === '--started-by') {
            options.startedBy = commandArgs[++i] as 'runner' | 'terminal';
        } else if (arg === '--hapi-starting-mode') {
            const value = commandArgs[++i];
            if (value === 'local' || value === 'remote') {
                options.startingMode = value;
            } else {
                throw new Error('Invalid --hapi-starting-mode (expected local or remote)');
            }
        } else if (arg === '--hapi-session-id') {
            // Adopt-stub: create bootstrap with reserved id (not reopen).
            const sessionId = commandArgs[++i];
            if (!sessionId) {
                throw new Error('Missing --hapi-session-id value');
            }
            options.reservedSessionId = sessionId;
        } else if (arg === '--existing-session-id') {
            const sessionId = commandArgs[++i];
            if (!sessionId) {
                throw new Error('Missing --existing-session-id value');
            }
            options.existingSessionId = sessionId;
        } else if (arg === '--permission-mode') {
            const mode = commandArgs[++i];
            if (!mode || !(MCODE_PERMISSION_MODES as readonly string[]).includes(mode)) {
                throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`);
            }
            options.permissionMode = mode as McodePermissionMode;
            hasExplicitPermissionMode = true;
        } else if (arg === '--yolo' && !hasExplicitPermissionMode) {
            // MiniMax Code calls full access "bypassPermissions".
            options.permissionMode = 'bypassPermissions';
            hasExplicitPermissionMode = true;
        } else if (arg === '--plan' && !hasExplicitPermissionMode) {
            options.permissionMode = 'plan';
            hasExplicitPermissionMode = true;
        } else if (arg === '--resume') {
            const sessionId = commandArgs[++i];
            if (!sessionId) {
                throw new Error('Missing --resume value');
            }
            options.resumeSessionId = sessionId;
        } else if (arg === '--model') {
            const model = commandArgs[++i];
            if (!model) {
                throw new Error('Missing --model value');
            }
            options.model = model;
        }
    }

    return options;
}

export const mcodeCommand: CommandDefinition = {
    name: 'mcode',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseMcodeCommandOptions(commandArgs);

            await initializeToken();
            await maybeAutoStartServer();
            await authAndSetupMachineIfNeeded();

            const { runMcode } = await import('@/mcode/runMcode');
            await runMcode(options);
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
            if (process.env.DEBUG) {
                console.error(error);
            }
            process.exit(1);
        }
    }
};
