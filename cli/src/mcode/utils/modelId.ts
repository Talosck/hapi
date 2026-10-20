/**
 * MiniMax Code identifies a model with two different encodings:
 *
 * - The ACP config option (`session/set_config_option` with configId `model`)
 *   uses the runtime wire id: `m:<provider>:<model>:v:<variant>`, e.g.
 *   `m:minimax:MiniMax-M3:v:thinking`.
 * - The CLI (`mcode --model`, `mcode exec --model`) uses the user-facing id:
 *   `provider/model` or `provider/model#variant`, e.g.
 *   `minimax/MiniMax-M3#thinking`.
 *
 * HAPI drives the agent over ACP, so the wire id is what the web model
 * catalog and the session metadata carry. The local TUI only understands the
 * user-facing id, so the launcher converts on the way out.
 */

const ACP_MODEL_ID_PATTERN = /^m:([^:]+):([^:]+):v:(.*)$/;

/**
 * Converts an ACP wire model id into the CLI-facing `provider/model` form.
 * Returns null when the id does not use the expected shape — the caller then
 * leaves the TUI on its own configured default instead of passing a value the
 * CLI would reject.
 */
export function acpModelIdToCliModelId(modelId: string | null | undefined): string | null {
    if (!modelId) return null;
    const trimmed = modelId.trim();
    const match = ACP_MODEL_ID_PATTERN.exec(trimmed);
    if (!match) return null;

    const [, provider, model, variant] = match;
    if (!provider || !model) return null;

    const base = `${provider}/${model}`;
    return variant ? `${base}#${variant}` : base;
}
