import { asString, isObject } from '@hapi/protocol';

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

/**
 * The model catalog an ACP response carries, and the model the session runs.
 *
 * Accepted shapes, in order: a top-level `availableModels` / `currentModelId`,
 * the same nested under `models`, and the model config option. The probe and
 * the live backend resolve this through this one function, so the
 * create-session form and a running session always show the same catalog for
 * the same agent.
 */
export function extractModelCatalog(response: unknown): {
    availableModels: unknown[] | null;
    currentModelId: string | null;
    /** The raw option list of the model config option, if the agent published one. */
    configModelOptions: unknown[] | null;
} {
    if (!isObject(response)) {
        return { availableModels: null, currentModelId: null, configModelOptions: null };
    }

    const nested = isObject(response.models) ? response.models : null;
    const configOptions = (Array.isArray(response.configOptions) ? response.configOptions : [])
        .filter((entry): entry is Record<string, unknown> => isObject(entry));
    const configModelOption = findModelConfigOption(configOptions);
    const configModelOptions = configModelOption
        ? (Array.isArray(configModelOption.options) ? configModelOption.options : [])
        : null;

    const availableModels = Array.isArray(response.availableModels)
        ? response.availableModels
        : Array.isArray(nested?.availableModels)
            ? nested.availableModels
            : configModelOptions;
    const currentModelId = asString(response.currentModelId)
        ?? asString(nested?.currentModelId)
        ?? asString(configModelOption?.currentValue)
        ?? null;

    return { availableModels, currentModelId, configModelOptions };
}
