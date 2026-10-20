import type { McodePermissionMode } from '@hapi/protocol/types';

export type PermissionMode = McodePermissionMode;

/**
 * MiniMax Code splits its controls across two axes:
 * - the `permissionMode` config option (`default` / `auto` / `bypassPermissions`)
 * - the ACP session mode (`default` / `plan`)
 *
 * HAPI exposes both through a single permission-mode axis, so `plan` is a
 * member of this flavor's mode set.
 */
export interface McodeMode {
    permissionMode: PermissionMode;
    /** `null` means "back to the agent default"; `undefined` means "no choice". */
    model?: string | null;
    /** ACP `thinkingEffort` value; `null` = agent default, `undefined` = no choice. */
    effort?: string | null;
}
