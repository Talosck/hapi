import { logger } from '@/ui/logger';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { PermissionMode } from '../types';
import {
    MCODE_PERMISSION_CONFIG_CATEGORY,
    MCODE_PERMISSION_CONFIG_ID,
    MCODE_SESSION_MODE_DEFAULT,
    MCODE_SESSION_MODE_PLAN
} from './mcodeBackend';

/**
 * MiniMax Code splits its controls across two axes:
 * - the `permissionMode` config option (`default` / `auto` / `bypassPermissions`)
 * - the ACP session mode (`default` / `plan`)
 *
 * HAPI exposes one permission-mode axis, so `plan` maps onto the session mode
 * and leaves the tool permission policy on "Ask".
 */
export function mapMcodePermissionMode(mode: PermissionMode | undefined): {
    permissionOption: string;
    sessionMode: string;
} {
    switch (mode) {
        case 'plan':
            return { permissionOption: 'default', sessionMode: MCODE_SESSION_MODE_PLAN };
        case 'auto':
            return { permissionOption: 'auto', sessionMode: MCODE_SESSION_MODE_DEFAULT };
        case 'bypassPermissions':
            return { permissionOption: 'bypassPermissions', sessionMode: MCODE_SESSION_MODE_DEFAULT };
        default:
            return { permissionOption: 'default', sessionMode: MCODE_SESSION_MODE_DEFAULT };
    }
}

/**
 * Resolves the config option id that carries the tool permission policy.
 * MiniMax Code publishes it under the `_permission` category; the id is
 * `permissionMode` on every build seen so far, and is used as the fallback
 * for builds that do not publish the category.
 */
export function resolveMcodePermissionConfigId(backend: AcpSdkBackend, sessionId: string): string {
    return backend.getConfigOptionByCategory(sessionId, MCODE_PERMISSION_CONFIG_CATEGORY)?.id
        ?? MCODE_PERMISSION_CONFIG_ID;
}

/**
 * Applies a HAPI permission mode to the MiniMax Code session.
 *
 * The tool permission policy is applied through the ACP config option and the
 * plan mode through `session/set_mode`. Failures are surfaced to the caller so
 * the launcher can roll the session back to the previous mode instead of
 * silently running with a policy the user did not pick.
 */
export async function applyMcodePermissionMode(
    backend: AcpSdkBackend,
    sessionId: string,
    mode: PermissionMode | undefined
): Promise<void> {
    const { permissionOption, sessionMode } = mapMcodePermissionMode(mode);

    const configId = resolveMcodePermissionConfigId(backend, sessionId);
    await backend.setConfigOption(sessionId, configId, permissionOption);

    // `session/set_mode` carries the session mode (default / plan), not the
    // reasoning effort — see AcpSdkBackend.setSessionMode.
    await backend.setSessionMode(sessionId, sessionMode);
    logger.debug(`[mcode-remote] Applied permission mode ${mode} (option=${permissionOption}, sessionMode=${sessionMode})`);
}
