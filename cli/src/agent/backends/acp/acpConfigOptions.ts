import { asString } from '@hapi/protocol';

/**
 * The ACP config options the model catalog and the thinking effort live in.
 *
 * MiniMax Code publishes both as `select` config options: the model under
 * the id/category `model`, the thinking effort under the id
 * `thinkingEffort` / the category `thought_level`. Other agents publish the
 * same axes under their own ids, so an option is matched by its id *or* its
 * category — the two spellings are alternatives, never a fixed pairing.
 *
 * The probe (`modules/common/mcodeModels.ts`) and the live ACP backend must
 * agree on this: when they did not, the create-session form and the running
 * session showed different catalogs for the same agent.
 */

export type AcpConfigOptionLike = {
    id?: unknown;
    category?: unknown;
    currentValue?: unknown;
    options?: unknown;
};

/** Config option id MiniMax Code uses for its model picker. */
export const ACP_MODEL_CONFIG_ID = 'model';
/** Config option category MiniMax Code publishes the model picker under. */
export const ACP_MODEL_CONFIG_CATEGORY = 'model';
/** Config option id MiniMax Code uses for its thinking effort. */
export const ACP_THINKING_EFFORT_CONFIG_ID = 'thinkingEffort';
/** Config option category MiniMax Code publishes the thinking effort under. */
export const ACP_THOUGHT_LEVEL_CATEGORY = 'thought_level';

function matches(option: AcpConfigOptionLike, id: string, category: string): boolean {
    return asString(option.id) === id || asString(option.category) === category;
}

/** The option that carries the model catalog, if the agent publishes one. */
export function findModelConfigOption<T extends AcpConfigOptionLike>(
    options: readonly T[] | undefined
): T | undefined {
    return options?.find((option) => matches(option, ACP_MODEL_CONFIG_ID, ACP_MODEL_CONFIG_CATEGORY));
}

/** The option that carries the thinking effort levels, if there is one. */
export function findThinkingEffortConfigOption<T extends AcpConfigOptionLike>(
    options: readonly T[] | undefined
): T | undefined {
    return options?.find((option) => matches(
        option,
        ACP_THINKING_EFFORT_CONFIG_ID,
        ACP_THOUGHT_LEVEL_CATEGORY
    ));
}
