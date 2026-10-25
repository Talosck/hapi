/**
 * MiniMax Code identifies a model with two different encodings:
 *
 * - The ACP config option (`session/set_config_option` with configId `model`)
 *   uses the runtime wire id:
 *   - `m:<provider>:<model>:v:<variant>`, where an empty variant
 *     (`m:minimax:MiniMax-M3:v:`) is how the agent publishes a model that has
 *     none. The `u` form (`m:<provider>:<model>:u`) is accepted by the
 *     agent's decoder but never published by it.
 *
 *   Provider, model, and variant are URI-encoded. Examples:
 *   `m:minimax:MiniMax-M3:v:`, `m:minimax:MiniMax-M3:v:thinking`.
 * - The CLI (`mcode --model`, `mcode exec --model`) uses the user-facing id:
 *   `provider/model` or `provider/model#variant`, e.g.
 *   `minimax/MiniMax-M3#thinking`.
 *
 * HAPI drives the agent over ACP, so the wire id is what the web model
 * catalog and the session metadata carry. The local TUI only understands the
 * user-facing id, so the launcher converts on the way out.
 *
 * The conversion lives in the shared protocol package: the web renders the
 * wire id in the session header and needs the same mapping.
 */
export {
    acpModelIdToCliModelId,
    cliModelIdToAcpModelId,
    formatMcodeModelLabel,
    isCliModelId,
    parseCliModelId
} from '@hapi/protocol';
