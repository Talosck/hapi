/**
 * MiniMax Code identifies a model with two different encodings:
 *
 * - The ACP config option (`session/set_config_option` with configId `model`)
 *   uses the runtime wire id:
 *   - `m:<provider>:<model>:v:<variant>` for a variant model
 *   - `m:<provider>:<model>:v:` for a model without a variant
 *
 *   Provider, model and variant are URI-encoded; an empty variant (`...:v:`)
 *   is valid and is how the agent publishes a model without a variant. The
 *   `u` form (`m:<provider>:<model>:u`) is accepted by the agent's decoder
 *   but never published by it.
 *   Examples: `m:minimax:MiniMax-M3:v:`, `m:minimax:MiniMax-M3:v:thinking`.
 * - The CLI (`mcode --model`, `mcode exec --model`) uses the user-facing id:
 *   `provider/model` or `provider/model#variant`, e.g.
 *   `minimax/MiniMax-M3#thinking`.
 *
 * HAPI drives the agent over ACP, so the wire id is what the web model catalog
 * and the session metadata carry. The local TUI only understands the
 * user-facing id, so the launcher converts on the way out — and a model the
 * user names the CLI way is converted on the way in.
 */

const ACP_MODEL_ID_PATTERN = /^m:([^:]+):([^:]+):([uv])(?::([^:]*))?$/;

function decodeModelIdSegment(value: string): string | null {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

/**
 * Converts an ACP wire model id into the CLI-facing `provider/model` form.
 * Returns null when the id does not use the expected shape, or when a decoded
 * segment cannot be represented in the CLI syntax (a provider containing `/`,
 * or a model/variant containing `#`) — the caller then leaves the TUI on its
 * own configured default instead of passing a value the CLI would reject.
 */
export function acpModelIdToCliModelId(modelId: string | null | undefined): string | null {
    if (!modelId) return null;
    const trimmed = modelId.trim();
    const match = ACP_MODEL_ID_PATTERN.exec(trimmed);
    if (!match) return null;

    const [, rawProvider, rawModel, format, rawVariant] = match;
    if (!rawProvider || !rawModel) return null;
    // `u` carries no variant suffix; `v` always has one (which may be empty).
    if (format === 'u' && rawVariant !== undefined) return null;
    if (format === 'v' && rawVariant === undefined) return null;

    const provider = decodeModelIdSegment(rawProvider);
    const model = decodeModelIdSegment(rawModel);
    if (!provider || !model) return null;

    // The CLI grammar is `provider/model[#variant]`, parsed at the first `/`
    // and the last `#`. These characters cannot be escaped there.
    if (provider.includes('/')) return null;
    if (model.includes('#')) return null;

    const base = `${provider}/${model}`;
    if (format === 'u') return base;

    const variant = decodeModelIdSegment(rawVariant ?? '');
    if (variant === null || variant.includes('#')) return null;
    return variant ? `${base}#${variant}` : base;
}

/**
 * The parts of a CLI-facing model id: `provider/model[#variant]`.
 * Returns null when the id does not use that shape.
 */
export function parseCliModelId(modelId: string | null | undefined): {
    provider: string;
    model: string;
    variant: string | null;
} | null {
    if (!modelId) return null;
    const trimmed = modelId.trim();
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) return null;

    const provider = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1);
    if (!provider || !rest) return null;

    const hash = rest.lastIndexOf('#');
    const model = hash === -1 ? rest : rest.slice(0, hash);
    const variant = hash === -1 ? null : rest.slice(hash + 1);
    if (!model) return null;
    if (variant !== null && variant.length === 0) return null;

    return { provider, model, variant };
}

/** True when the id is a CLI-facing model id (`provider/model[#variant]`). */
export function isCliModelId(modelId: string | null | undefined): boolean {
    return parseCliModelId(modelId) !== null;
}

/**
 * Converts a CLI-facing model id into the ACP wire id.
 *
 * A model without a variant becomes the empty variant form (`...:v:`), which
 * is how the agent publishes it; the agent rejects the `u` form for its own
 * catalog. A model the agent does not publish is still converted, so the
 * agent can reject it with its own message.
 */
export function cliModelIdToAcpModelId(modelId: string | null | undefined): string | null {
    const parsed = parseCliModelId(modelId);
    if (!parsed) return null;
    const provider = encodeURIComponent(parsed.provider);
    const model = encodeURIComponent(parsed.model);
    const variant = encodeURIComponent(parsed.variant ?? '');
    return `m:${provider}:${model}:v:${variant}`;
}

/**
 * A readable label for a wire model id: the model name plus its variant.
 * Returns null for anything that is not a MiniMax Code model id.
 */
export function formatMcodeModelLabel(modelId: string | null | undefined): string | null {
    const cliModelId = acpModelIdToCliModelId(modelId);
    if (!cliModelId) return null;
    const parsed = parseCliModelId(cliModelId);
    if (!parsed) return null;
    return parsed.variant ? `${parsed.model} · ${parsed.variant}` : parsed.model;
}
