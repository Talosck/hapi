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
