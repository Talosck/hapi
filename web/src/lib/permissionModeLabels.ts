import { getPermissionModeLabel, type PermissionMode } from '@hapi/protocol'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The label of a permission mode, in the words of the agent that runs it.
 *
 * MiniMax Code calls its modes Ask, Auto and Full access. "Yolo" is the
 * wording of another agent: a user who reads "Yolo" in HAPI and "Ask" in the
 * agent's own window has to work out that both mean the same thing.
 *
 * The other agents keep their own labels - the shared catalog is not changed
 * for one agent's sake.
 */
export function permissionModeLabelForAgent(args: {
    mode: PermissionMode
    agent?: string | null
    t: Translate
}): string {
    if (args.agent === 'mcode') {
        switch (args.mode) {
            case 'default':
                return args.t('permissionMode.ask')
            case 'auto':
                return args.t('permissionMode.auto')
            case 'bypassPermissions':
                return args.t('permissionMode.fullAccess')
            case 'plan':
                return args.t('permissionMode.plan')
        }
    }
    return getPermissionModeLabel(args.mode)
}
