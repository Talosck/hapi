import { getPermissionModeLabel, PERMISSION_MODE_FLAVOR_LABEL_KEYS, type PermissionMode } from '@hapi/protocol'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The label of a permission mode, in the words of the agent that runs it.
 *
 * MiniMax Code calls its modes Ask, Auto and Full access. "Yolo" is the
 * wording of another agent: a user who reads "Yolo" in HAPI and "Ask" in the
 * agent's own window has to work out that both mean the same thing.
 *
 * Which modes of which agent are called what is decided by the shared
 * catalog, not here: the web only translates the wording it is given. The
 * other agents keep their own labels - the shared catalog is not changed for
 * one agent's sake.
 */
export function permissionModeLabelForAgent(args: {
    mode: PermissionMode
    agent?: string | null
    t: Translate
}): string {
    const key = args.agent
        ? PERMISSION_MODE_FLAVOR_LABEL_KEYS[args.agent]?.[args.mode]
        : undefined;
    if (key) {
        return args.t(key);
    }
    // The shared catalog knows the wording of the agent that runs the mode,
    // but it holds the english text - the native clients print that, and the
    // web translates it. An agent that names its modes therefore goes through
    // the key above, and the rest keep the shared wording as it is.
    return getPermissionModeLabel(args.mode)
}
