# MiniMax Code (mcode): How HAPI Talks to the Agent

HAPI runs the official MiniMax Code CLI (`mcode`) locally and drives the same
conversation remotely over the Agent Client Protocol (`mcode acp`).

Source paths below are relative to `cli/` unless prefixed with another package.

## 1. The Pieces

| Path | What it owns |
|---|---|
| `src/mcode/runMcode.ts` | Starts a session: bootstraps it, wires the queue and the config RPC. |
| `src/mcode/mcodeRemoteLauncher.ts` | The remote session: connects the agent, runs the turns, registers the RPC surface. |
| `src/mcode/mcodeLocalLauncher.ts` | The local session: the agent's own TUI owns the conversation. |
| `src/mcode/loop.ts` | The turn loop. |
| `src/mcode/utils/mcodeExtensions.ts` | The agent's ACP extensions: goal, delegation, steer. |
| `src/mcode/utils/questionHandler.ts` | The agent's questionnaire (`ask_user`). |
| `src/mcode/utils/permissionModes.ts` | The mapping between HAPI's permission mode and the agent's two axes. |
| `src/mcode/utils/mcodeConnectorTools.ts` | The apps the agent can reach, through the install's broker. |
| `src/modules/common/mcodeModels.ts` | The model catalog, and the probe that reads it. |

## 2. The Two Permission Axes

MiniMax Code splits its controls across two axes, and HAPI shows one:

- the `permissionMode` config option: `default` / `auto` / `bypassPermissions`
- the ACP session mode: `default` / `plan`

HAPI exposes both through one permission-mode axis, so `plan` is a member of
the flavor's mode set (`MCODE_PERMISSION_MODES` in `shared/src/modes.ts`).
The CLI picks the axis: `plan` goes to the session mode, the other three go
to the config option.

The agent names its modes itself, so the wording differs from the catalog:
Ask, Auto, Full access, Plan. `PERMISSION_MODE_FLAVOR_LABELS` in
`shared/src/modes.ts` is where that is decided, for the web and the native
clients alike.

## 3. The Model Catalog

The agent publishes its catalog over ACP. HAPI reads it two ways:

- a running session reads the live connection (`registerAcpCommandHandlers`
  in the launcher), so the answer is the session's own catalog
- a session without a live agent, and the create-session form, read it
  through a probe: a short-lived `mcode acp` process in a fixed directory
  (`src/modules/common/mcodeModels.ts`)

The ids are ACP wire ids: `m:<provider>:<model>:v:<variant>`, where an empty
variant is how the agent publishes a model that has none. The conversion to
the CLI's `provider/model[#variant]` form lives in `shared/src/mcodeModelId.ts`.

## 4. The Extensions

The agent publishes three ACP extensions, and HAPI advertises them in
`clientCapabilities._meta["minimax-code/extensions"]`:

- `mcode/session/goal/*` — the goal of an autonomous run, shown in the
  session status panel and recorded in the chat as a goal card
- `mcode/session/delegation/*` — the tree of delegated sessions, shown in the
  session status panel
- `mcode/session/steer` — a queued message sent into the running turn

A build that does not advertise an extension is asked nothing: the controls
that need it are hidden rather than offered and refused.

## 5. The Turn

The agent gives every native session one turn lease, and a turn holds it for
its whole duration. The runtime also takes that lease for turns HAPI did not
start — a background task that finished has to be reported into the owner
session — so a `session/prompt` that arrives during one is refused.

HAPI waits for the lease before it sends a turn (`readMcodeTurnLease`), and
the wait comes before the message leaves the queue: a waiting message stays
cancellable and stays unacknowledged in the hub.

## 6. The End-to-End Suite

`src/mcode/mcodeAgent.e2e.test.ts` runs the real agent: the unit suite drives
a mocked ACP backend, so it proves the launcher logic but not that the agent
agrees with it. This file runs the real `mcode acp` process and replaces only
the hub, so every assertion is about what MiniMax Code actually did.

It needs the CLI on PATH, a working login (`mcode login`), and it makes real
model calls. It is opt-in:

```bash
cd cli && HAPI_RUN_MCODE_E2E=1 bunx vitest run src/mcode/mcodeAgent.e2e.test.ts
```

The run takes a couple of minutes. It is not part of `bun run test` and does
not run in CI: the account it needs is a personal one, and running it there
would mean keeping the account's credential in the repository's secrets.

## 7. Things That Are Not Obvious

- **The question card outlives the turn.** MiniMax Code ends the turn as soon
  as it raises the questionnaire, so the answer is the next turn. The card is
  therefore answerable across that boundary, and it is not a tool approval.
- **A refused turn is not lost.** The batch goes back into the queue with its
  local id, and the hub is told, so a runner that dies before the retry hands
  the message to the next runner.
- **The agent files its credential by path.** MiniMax Code keys the stored
  credential by the path of its own directory, so a credential that was signed
  in on one machine is not found on another.
