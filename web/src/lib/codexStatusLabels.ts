/** Labels shared by SessionHeader and composer StatusBar for supported reasoning providers. */

export function formatCompactReasoningLabel(effort?: string | null): string {
    const normalized = effort?.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'default'
    return normalized
}

export function formatReasoningLabel(effort?: string | null, showLabel = true): string {
    const value = formatCompactReasoningLabel(effort)
    return showLabel ? `reasoning ${value}` : value
}

/**
 * Status metadata comes from different session fields by agent protocol:
 * Codex/OpenCode publish model reasoning effort, while Pi publishes effort.
 */
export function getReasoningEffortForFlavor(
    agentFlavor: string | null | undefined,
    modelReasoningEffort?: string | null,
    effort?: string | null
): string | null {
    if (agentFlavor === 'codex' || agentFlavor === 'opencode') {
        return modelReasoningEffort?.trim() || null
    }
    if (agentFlavor === 'pi' || agentFlavor === 'mcode') {
        return effort?.trim() || null
    }
    return null
}

export function shouldShowReasoningStatusLabel(
    agentFlavor: string | null | undefined,
    reasoningEffort?: string | null
): boolean {
    // Codex/OpenCode retain their existing explicit default label when unset.
    if (agentFlavor === 'codex' || agentFlavor === 'opencode') return true
    // Pi/mcode have no meaningful default; only show a real level.
    return (agentFlavor === 'pi' || agentFlavor === 'mcode') && Boolean(reasoningEffort?.trim())
}

/** Codex-only aliases retained for tool-card and thread call sites. */
export const formatCompactCodexReasoningLabel = formatCompactReasoningLabel
export const formatCodexReasoningLabel = formatReasoningLabel

export function shouldShowCodexReasoningLabel(agentFlavor: string | null | undefined): boolean {
    return agentFlavor === 'codex' || agentFlavor === 'opencode'
}
