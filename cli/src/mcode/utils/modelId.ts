/**
 * MiniMax Code identifies a model with two different encodings:
 *
 * - The ACP config option (`session/set_config_option` with configId `model`)
 *   uses the runtime wire id:
 *   - `m:<provider>:<model>:u` for a model without a variant
 *   - `m:<provider>:<model>:v:<variant>` for a variant model
 *
 *   Provider, model, and variant are URI-encoded; an empty variant (`...:v:`)
 *   is valid. Examples: `m:minimax:MiniMax-M3:u`,
 *   `m:minimax:MiniMax-M3:v:thinking`.
 * - The CLI (`mcode --model`, `mcode exec --model`) uses the user-facing id:
 *   `provider/model` or `provider/model#variant`, e.g.
 *   `minimax/MiniMax-M3#thinking`.
 *
 * HAPI drives the agent over ACP, so the wire id is what the web model
 * catalog and the session metadata carry. The local TUI only understands the
 * user-facing id, so the launcher converts on the way out.
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
