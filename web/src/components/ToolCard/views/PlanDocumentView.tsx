import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject } from '@hapi/protocol'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

/**
 * Renders a plan the agent published as a document instead of a checklist.
 *
 * ACP `plan_update` carries a markdown document or a reference to a file on
 * disk; neither has a checklist equivalent, so the plan is rendered as the
 * document the agent produced.
 */
export function PlanDocumentView(props: ToolViewProps) {
    const input = props.block.tool.input
    if (!isObject(input)) return null
    const plan = typeof input.plan === 'string' ? input.plan : null
    if (!plan) return null

    if (input.format === 'file') {
        return (
            <div className="break-words text-sm text-[var(--app-hint)]">
                Plan document: <span className="font-mono">{plan}</span>
            </div>
        )
    }

    return <MarkdownRenderer content={plan} />
}
