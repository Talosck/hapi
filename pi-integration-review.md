# Pi ↔ HAPI 复审：1.4.0 升级后的连接面（2026-10-23）

> 同系列：`mcode-integration-review.md` ~ `-6.md`（MCode 0.6.12）。
> 本文只写一件事：**Pi 升到 1.4.0 之后，HAPI 这条连接还能怎么优化**。
>
> Pi 1.4.0 的变化清单见 agent 自带的 `CHANGELOG.md`
> （`@earendil-works/pi-coding-agent`，本机 `~/.pi/agent/install/releases/1.4.0/`）。
> 本文不抄 changelog，只写**实测出来**的、跟 HAPI 连接面有关的部分。
>
> **本文是评估 + 实施记录**：第一遍是评估；后来 P0 那组（`clear_queue` +
> `disposition` + `agent_settled.aborted`）**已经改完并验证**，记录在第九节。
> 其余各节仍未实施。

---

## 一句话结论

**能优化，而且第一条是已经能复现的 bug：用户点了「中止」，Pi 队列里那条 steer 消息不会死，
会在下一轮原样冒出来，重新插进对话里。**

这不是猜测，是本机跑真 `pi --mode rpc` 探出来的：中止之后 `clear_queue` 还能把那条消息捞出来；
不捞的话，下一轮 prompt 会把它当成一条新的 user 消息注入上下文。

除此之外，Pi 1.4.0 的 **33 条 RPC 命令，HAPI 只用了 17 条**；
Pi 新加的 `queue_update` / `extension_error` 事件类型，**一条都没接**。

---

## 一、Pi 1.4.0 现在对外是什么面

### 1.1 版本落差

| | 版本 | 日期 |
|---|---|---|
| HAPI 代码里的基线 | **0.83**（`cli/src/pi/*.ts` 注释写的是 "Pi 0.83"） | 2026-07-29 |
| 本机实际安装 | **1.4.0**（`@earendil-works/pi-coding-agent`） | 2026-10-21 |

中间跨了 `0.84 → 0.99 → 1.0 → 1.4`。`0.x → 1.x` 是 major 级别的跨度，
按 AGENTS.md 的约定**不保留向后兼容**，所以下面这些差异都该直接对齐新契约。

### 1.2 命令覆盖：33 条里用了 17 条

Pi 1.4.0 的 `rpc-types.d.ts` 里一共 33 条命令。HAPI 的实际使用情况：

| 状态 | 命令 | HAPI 在哪用 |
|---|---|---|
| ✅ 用 | `prompt` `steer` `follow_up` `abort` `get_state` `set_model` `get_available_models` `set_thinking_level` `get_commands` `get_session_stats` `new_session` `switch_session` `fork` `clone` `get_fork_messages` `get_entries` `compact` | `cli/src/pi/types.ts:189`、`cli/src/pi/runPi.ts:1034` |
| ✅ 已接（2026-10-23） | `clear_queue` `bash` `abort_bash` `get_tree` `set_session_name` | §9 |
| ❌ 没用 | `set_steering_mode` `set_follow_up_mode` `set_auto_compaction` `set_auto_retry` `abort_retry` `get_available_thinking_levels` `cycle_model` `cycle_thinking_level` `export_html` `get_messages` `get_last_assistant_text` | — |

> 类型层面还有一处缺口：`compact` 运行时会发（`runPi.ts:1034`），但 `PiRpcCommand`
> 这个 union 里没有它（`types.ts:189`）。运行没事，改类型时会漏。**已补**。

### 1.3 事件覆盖

| Pi 1.4.0 事件 | HAPI 接了吗 |
|---|---|
| `agent_start` `agent_end` `agent_settled` `turn_start` `turn_end` `message_start` `message_update` `message_end` `tool_execution_*` | ✅ |
| `compaction_start` `compaction_end` `auto_compaction_*` `auto_retry_*` `summarization_retry_*` | ✅ |
| `entry_appended` `session_info_changed` | ✅ |
| **`extension_error`** | ✅ **已接**（§9.4.3） |
| **`bash_execution_update`** | ✅ **已接**（§9.4.1） |
| **`queue_update`** | ❌ **没有** |
| **`thinking_level_changed`** | ❌ **没有** |

---

## 二、P0：中止之后，steering 消息会诈尸（实测）

### 2.1 机制

Pi 1.4.0 自己维护一个内部队列（`_steeringMessages` / `_followUpMessages`）。
关键在于**两条路径的行为不一样**：

| Pi 的动作 | 会不会清空内部队列 |
|---|---|
| `abort` → `session.abort()` | ❌ **不会** |
| `clear_queue` → `session.clearQueue()` | ✅ 会 |

而 HAPI 这边：

| HAPI 的行为 | 位置 |
|---|---|
| 中止时只发 `{type:'abort'}` | `cli/src/pi/runPi.ts:1330-1335` |
| steer 一发出去就把 hub 队列里的这行标记成 consumed | `cli/src/pi/steerDispatcher.ts:128` |
| 从不发 `clear_queue` | 全仓库搜不到 |

也就是说：**HAPI 以为那条消息已经交出去了，Pi 其实还攥着。**

### 2.2 实测

本机 `pi --mode rpc`（1.4.0），跑一条长任务，中途 steer，然后 abort。
**第一次跑**（abort 之后补一次 `clear_queue`，看队列里还剩什么）：

```
[14] RPC steer   data={'disposition': 'queued'}
[20] RPC abort   data=None
[47] RPC clear_queue  data={'steering': ['IMPORTANT_ABC123 remember to use pnpm'], 'followUp': []}
```

`clear_queue` 在 abort **之后**还能捞出那条消息 —— 它活下来了。

**第二次跑**（这次**不**调 `clear_queue`，直接发下一轮 prompt）：

```
[21] RPC prompt data={'disposition': 'started'}
[26] message_start role=user  "Reply with exactly: SECOND_TURN_OK"
[29] message_start role=user  "IMPORTANT_ABC123 remember to use pnpm"   ← 诈尸了
```

用户视角：**我明明按了中止，怎么下一轮它又自己冒出来说「记得用 pnpm」。**

### 2.3 建议

1. **中止时补一次 `clear_queue`**，把 Pi 队列里被丢弃的消息取回来。
   Pi 会原样返回被丢弃的内容（`{steering: [...], followUp: [...]}`），
   HAPI 可以决定是**退回 hub 队列**（用户还能看到、还能重发）还是**作为一条本地消息提示**。
   建议退回 hub 队列 —— 跟 HAPI 别的 agent 的中止语义一致。
2. **用 `disposition` 区分 steer 的结果**。Pi 的 `prompt` / `steer` / `follow_up`
   响应都带 `data.disposition`，取值 `started` / `queued` / `handled`：
   - `queued` = Pi 只是收下了，**还没执行** → 此时不能把它标记成 consumed；
   - `started` = 已经开始跑了。

   HAPI 现在完全不读这个字段（`steerDispatcher.ts:128` 直接 `emitMessagesConsumed`）。
   改成按 `disposition` 决定，能顺带解决「hub 显示已消费、Pi 其实没动」的错位。

> 注意 `queue_update` 事件（§三）其实已经给了 Pi 队列的完整状态，
> 这条事件接上之后，§2.3 的 1 和 2 可以一起做，状态源统一到 Pi。

---

## 三、P1：`queue_update` 没接 —— HAPI 看不见 Pi 自己的队列

Pi 1.4.0 会主动广播内部队列的变化：

```json
{"type": "queue_update", "steering": ["..."], "followUp": []}
```

两个字段都是**当前队列的完整快照**。实测 steer 之后立刻收到：

```json
{"type": "queue_update", "steering": ["IMPORTANT_ABC123 remember to use pnpm"], "followUp": []}
```

HAPI 现在的状态模型里，**队列是 hub 自己维护的一套**（`session.ts` 的 FIFO + `pendingLocalIds`），
Pi 内部队列对 HAPI 是黑盒。两套队列各走各的，迟早对不上。

另外 `get_state` 的响应里已经有 `pendingMessageCount`（实测存在），HAPI 也没读。

**建议**：

- 接 `queue_update`，作为 Pi 队列的权威来源；
- 和 `get_state.pendingMessageCount` 一起，用来在 hub 侧显示「Pi 手里还有 N 条没执行」；
- 两套队列的关系在代码里写清楚：hub FIFO 负责「还没发出去的」，
  Pi 队列负责「发出去了但还没被 agent 吃掉的」。

---

## 四、P1：`agent_settled.aborted` 丢了

Pi 1.4.0 的 `agent_settled` 带 `aborted` 字段（源码 `agent-session.js:690`）：

```js
this._emit({ type: "agent_settled", aborted });
```

HAPI 的 schema（`cli/src/pi/schemas.ts:444`）只有 `type`，而且**没有 `.passthrough()`**：

```ts
export const PiAgentSettledEventSchema = z.object({
    type: z.literal('agent_settled'),
});
```

所以 HAPI 分不出「这一轮是正常收尾」还是「这一轮是被用户中止的」。
这在接了 §2 的 `clear_queue` 之后会直接需要 —— 只有知道是中止，才知道该不该清队列。

**建议**：schema 加 `aborted: z.boolean().optional()`，并在 `loop.ts:887` 的
`agent_settled` 分支里用上。

---

## 五、P2：`extension_error` 没接 —— Pi 扩展崩了没人知道

Pi 1.4.0 在扩展的 handler 抛异常时会广播（`rpc-mode.js:260`）：

```json
{"type": "extension_error", "extensionPath": "/path/to/extension.ts", "event": "tool_call", "error": "Error message"}
```

HAPI 的 `PiAgentEventSchema` 是 passthrough，所以这条事件**能进到 `loop.ts` 的 `handleEvent`**，
但没有任何分支处理它 → 静默丢弃。

用户视角：某个 Pi 扩展挂了（工具调用报错、UI 扩展异常），HAPI 这边什么现象都没有，
只会看到「工具没返回」或者干脆什么都不发生。

**建议**：把 `extension_error` 映射成一条 session status / 系统消息，
至少要让用户知道「是扩展炸了，不是 agent 不理你」。

---

## 六、P2：Pi 1.4.0 的新能力，一条没用上

按"值不值得做"排，不是按新不新排。

### 6.1 `bash` / `abort_bash` —— 最值钱的一个

Pi 1.4.0 支持直接跑 shell：

```json
{"type": "bash", "command": "ls -la"}
```

输出通过 `bash_execution_update` 流式回来：

```json
{"type": "bash_execution_update", "id": "req-1", "delta": "total 48\n"}
```

> **修正（2026-10-23，实施时发现）**：这一节最初写的是「HAPI 对 Pi 这条线完全没有终端能力」，
> 这是错的。HAPI **有**一个通用 `Bash` RPC（`cli/src/modules/common/handlers/bash.ts`，
> 所有 flavor 都在用），web 也**有**一整套 xterm 终端（`web/src/routes/sessions/terminal.tsx`）。
>
> 真正的差别在**输出去哪**：通用 Bash RPC 的输出只回到调用方，**agent 看不到**；
> Pi 的 `bash` 会把输出写进对话上下文（`bashExecution` 条目），下一次请求模型就能读到。
> 详见 §9.4.1。

**建议**：优先级最高。接入后 web 端就能有「跑一条命令看输出」，
而且 Pi 已经在跑同一个工作目录，天然对齐。

### 6.2 `set_steering_mode` / `set_follow_up_mode`

Pi 支持 `"all"` | `"one-at-a-time"` 两种模式（实测 `get_state` 里默认
`steeringMode: "one-at-a-time"`, `followUpMode: "one-at-a-time"`）。

HAPI 读得到 `steeringMode`（从 `get_state`），但**改不了**。steer 的语义在
HAPI 里是硬编码的「一条一条发」。

**建议**：暴露成会话级设置。注意 `one-at-a-time` 正是 §2 里那条诈尸 bug 的放大器 ——
一次只留一条在 Pi 队列里，用户连按几次中止就积了几条。

### 6.3 `get_available_thinking_levels`

Pi 有权威答案（实测本机当前模型返回 `["low","medium","high","xhigh","max"]`）。

HAPI 现在是**推导**的：从模型的 `thinkingLevelMap` 反推
（`web/src/components/AssistantChat/piThinkingLevelOptions.ts`）。
推导结果在实测里和权威答案一致（`off` / `minimal` 为 `null` → 被正确过滤掉），
所以**现在没 bug**。

**建议**：改成直接问 Pi。推导逻辑留着当兜底即可，少一处会和 Pi 漂移的地方。

### 6.4 `set_auto_compaction` / `set_auto_retry` / `abort_retry`

HAPI 对 Pi 的自动压缩有一堆自己的处理（`PI_COMPACT_TIMEOUT_MS`、
`auto_compaction_start/end` 事件、`compaction_retry` 宽限期）。
但**用户没法通过 HAPI 开关 Pi 自己的自动压缩**。

**建议**：把「自动压缩」做成 HAPI 侧一个显式开关，用 `set_auto_compaction` 落地，
而不是只靠事件感知。同理 `set_auto_retry` / `abort_retry` 让用户能手动掐掉 Pi 的自动重试。

### 6.5 `export_html` / `get_tree` / `get_messages` / `get_last_assistant_text` / `set_session_name`

| 命令 | 能补上什么 |
|---|---|
| `export_html` | 会话导出成 HTML。HAPI 现在的导出走自己的格式 |
| `get_tree` | Pi 的会话分支树。HAPI 有 `fork` / `clone` / `switch_session`，但**没有把树画出来** |
| `get_messages` | 直接拿结构化消息。HAPI 现在靠 `get_entries` + 自己解析 |
| `get_last_assistant_text` | 一行拿到最后一条回复，做「继续」类操作很省事 |
| `set_session_name` | Pi 原生改会话名。HAPI 现在用自己的 `titleExtension` 造标题 |

**建议**：`get_tree` 优先级相对高（配合已有的 fork 能力，UI 上能直接呈现分支）；
`export_html` 和 `set_session_name` 属于锦上添花。

### 6.6 `cycle_model` / `cycle_thinking_level` / `new_session.parentSession`

- `cycle_model` / `cycle_thinking_level`：Pi 的「下一个模型 / 下一个思考等级」快捷切换。
  HAPI 的 web 端本来就有下拉框，价值不大。
- `new_session` 的 `parentSession` 参数：可以从某个父会话开新会话。
  HAPI 现在的 `new_session` 是裸的（`types.ts:195`），fork 走的是 `fork` + `clone`。
  **建议**：以后要做「从这条消息开新会话」，直接用 `parentSession`，比 `fork` 语义更贴。

### 6.7 附带发现：发图之前没看模型支不支持图片

Pi 1.4.0 的 `get_state.model.input` 会写明这个模型收什么，例如实测当前模型是
`["text","image"]`；纯文本模型就是 `["text"]`。HAPI 拿到了这个字段（`model` 是
passthrough），但**发图片之前没查过**。

Pi 自己会兜底（`pi-ai/dist/api/transform-messages.js`）：不支持图片的模型，
图片会被替换成占位文本 `(image omitted: model does not support images)`。

所以**不会崩**，但用户会遇到这种情况：附了图 → 提示发出去了 → 模型完全没看到图，
而且**全程没有任何提示**。

**建议**：发图前按 `model.input` 判断，不支持就明确告诉用户「当前模型不支持图片」，
而不是让 Pi 悄悄吞掉。这个检查 HAPI 现有数据就够做，不需要新命令。

---

## 七、已实测**没有**问题，不要动

这几条我逐个查过了，是干净的：

| 项 | 结论 |
|---|---|
| **行分隔** | Pi 1.4.0 严格 LF-only JSONL。HAPI 的 `JsonLineParser`（`cli/src/utils/jsonLineParser.ts:14`）按 `\n` 切并 `trim()`，兼容 ✅ |
| **思考等级枚举** | `PI_THINKING_LEVELS`（`shared/src/piThinkingLevel.ts:3`）已经是 `off/minimal/low/medium/high/xhigh/max`，和 Pi 1.4.0 的 `ThinkingLevel` **完全一致** ✅ |
| **等级可用性过滤** | web 端按 `thinkingLevelMap` 过滤，实测和 Pi 权威答案一致 ✅ |
| **设不支持的等级** | 实测 `set_thinking_level: "off"` / `"minimal"` 在当前模型下都返回 `success: true`，Pi 自己兜住了。所以 CLI 的 `--effort off` 不会炸 ✅ |
| **`setStatus` / `setWidget` 不回响应** | Pi 这两个是 fire-and-forget（`rpc-mode.js:101-129`，只 `output()` 不等响应），HAPI 丢掉它们**不会**让 Pi 卡住 ✅ 但见下 |
| **`entry_appended`** | 已接（`loop.ts:763`），且有 `get_entries` 兜底 ✅ |
| **fork / clone / switch_session / 历史** | 能力探测齐全（`conversationHistory.ts`），实现完整 ✅ |
| **`@file` 附件** | Pi 1.4.0 **仍然**拒绝 RPC 模式下的 `@file` 命令行参数（`main.js:527`："@file arguments are not supported in RPC mode"）。实测 prompt 正文里的 `@/abs/path` 会原样透传成普通文本，不会被展开 ✅ 所以 HAPI 把它转成 `Attached file: "<path>"` 让模型用 read 工具自己去读（`runPi.ts:115-120`）这个绕法**到 1.4.0 依然成立**，不用改 |

### 一个"不是 bug 但可以更好"的点

`extensionUiHandler.ts:166-169` 把 `setStatus` / `setWidget` / `set_editor_text` 三个
extension UI 方法**直接丢掉了**，只留一行 debug 日志。

本机就有个现成的例子：装着的 Pi 扩展 `pi-goal-x`
（`~/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal-state.ts:573`）
用 `ctx.ui.setStatus("goal", ...)` 和 `ctx.ui.setWidget(...)` 维护 goal 状态。
实测 `pi --mode rpc` 启动时就在发这两个请求：

```json
{"type":"extension_ui_request","id":"...","method":"setStatus","statusKey":"goal"}
{"type":"extension_ui_request","id":"...","method":"setWidget","widgetKey":"goal"}
```

也就是说 **Pi 扩展自己维护的状态（比如 goal 进度），HAPI 现在完全看不到** ——
用户在 Pi 的 TUI 里能看到 goal，接到 HAPI 上就没了。

不改也不会坏。但如果想让 web 端显示扩展状态，这三个事件是现成的入口。

---

## 八、建议的落地顺序

| 优先级 | 事项 | 依据 |
|---|---|---|
| **P0** | 中止时补 `clear_queue`，并按 `disposition` 决定要不要标记 consumed | §2，实测可复现的用户可见 bug |
| **P0** | `PiAgentSettledEventSchema` 补 `aborted` | §4，是上一条的前置 |
| **P1** | 接 `queue_update` + 读 `get_state.pendingMessageCount` | §3，两套队列对不上的根因 |
| **P2** | 接 `extension_error`，映射成用户可见消息 | §5 |
| **P2** | 接 `bash` / `abort_bash` + `bash_execution_update` | §6.1，能力增量最大 |
| **P2** | `set_steering_mode` / `set_follow_up_mode` | §6.2，和 P0 一起做更完整 |
| **P3** | `set_auto_compaction` / `set_auto_retry` / `abort_retry` | §6.4 |
| **P3** | `get_tree` 配合已有 fork 做分支 UI | §6.5 |
| **P3** | `get_available_thinking_levels` 替换推导逻辑 | §6.3 |
| **P3** | `export_html` / `set_session_name` / `get_messages` / `get_last_assistant_text` | §6.5 |
| **P3** | 发图前按 `model.input` 判断模型支不支持图片 | §6.7 |
| **P4** | `cycle_model` / `cycle_thinking_level` / `new_session.parentSession` | §6.6 |
| **P4** | 暴露 `setStatus` / `setWidget` 给 web | §七，本机 `pi-goal-x` 的 goal 状态就靠它 |

另外顺手补一处类型缺口：`PiRpcCommand`（`types.ts:189`）缺 `compact`，
运行时却在发（`runPi.ts:1034`）。

---

## 附：本文的取证方式

```bash
# Pi 1.4.0 的权威 RPC 契约（跟着本机安装走）
~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/
  ├── dist/modes/rpc/rpc-types.d.ts      # 命令 + 响应类型
  ├── docs/rpc.md                         # 协议总览
  ├── docs/rpc-commands.md                # 命令语义（含 disposition）
  ├── docs/json.md                        # 事件流
  └── docs/rpc-extension-ui.md            # extension UI 子协议

# 实测（真起 pi --mode rpc，发 JSON 行）
cd /tmp/piprobe && { echo '{"id":"s1","type":"get_state"}'; sleep 3; ...; } | pi --mode rpc --no-session
```

本文所有"实测"结论都来自上面这条命令的真实输出，不是读文档推断的。

---

## 九、实施记录：P0 那组 + 能力提升那组都改完了（2026-10-23）

第二节那条 bug 已经修掉并验证；能力提升那批（§9.4）也做完了。
这一节写**改了什么**和**怎么验证的**。

### 9.1 改了什么

| 改动 | 位置 |
|---|---|
| `PiRpcCommand` 补 `clear_queue`、补上一直在发但没进类型的 `compact` | `cli/src/pi/types.ts:189` |
| `PiAgentSettledEvent` / `PiAgentSettledEventSchema` 补 `aborted` | `cli/src/pi/types.ts`、`cli/src/pi/schemas.ts:444` |
| 新增 `PiClearQueueResultSchema`、`PiInputDispositionSchema`、`readPiDisposition()` | `cli/src/pi/schemas.ts` |
| `PiSession` 加「已发 steer 账本」+ `resolveDroppedSteers()` + `recordPromptDispatch()` / `consumePromptDispatch()` | `cli/src/pi/session.ts` |
| 新增 `clearAbandonedQueue()`：清 Pi 队列、把丢掉的 steer 映射回 HAPI 的行、撤掉历史登记、给用户一条提示 | `cli/src/pi/loop.ts` |
| `agent_settled` 带 `aborted: true` 时也清一次队列（兜底，覆盖 Pi 自己中止的情况） | `cli/src/pi/loop.ts` |
| 中止路径在**还持有 runtime mutation 锁的时候**清队列 —— 下一轮 prompt 必须等队列清干净才能开始 | `cli/src/pi/runPi.ts` |
| steer 响应读 `disposition`：`queued` 记进账本，`handled` 判定为 Pi 扩展已消费、撤掉历史登记 | `cli/src/pi/steerDispatcher.ts` |
| prompt 响应读 `disposition`：`queued` 转成 steer 记账，`handled` 撤掉历史登记 | `cli/src/pi/loop.ts` |

### 9.2 语义选择：丢掉的 steer 是「丢弃」，不是「退回队列」

Pi 的 `abort` 停掉的是**当前这一轮**。一条 steer 的作用对象就是这一轮，
这一轮没了，这条 steer 也就没有作用对象了。所以中止时它是**被丢弃**，不是被退回。

这跟 HAPI 既有的一致：中止掉的 prompt 也是 `emitMessagesConsumed` 掉的，不是重发的。

用户这边不会静默丢消息 —— HAPI 会发一条 session 消息说清楚丢了哪几条：

```
Pi discarded 1 queued steer when the turn was aborted: remember to use pnpm
```

另外，被丢掉的 steer **从来没有产生过 native user entry**，所以它的历史登记必须撤掉
（`rejectPendingEntry`），否则下一轮的 user entry 会错配到这条消息上。

### 9.3 验证

**单测**（`cli/src/pi/runPi.test.ts` 新增 `Pi abandoned steering queue` 一组 5 条 +
`cli/src/pi/session.test.ts` 新增 8 条账本/disposition 单测，合计新增 13 条）：

| 用例 | 断言 |
|---|---|
| 中止时清 Pi 队列 | 发出 `clear_queue`；用户收到「丢弃了哪条 steer」的提示 |
| 下一轮必须等队列清干净 | `clear_queue` 没回之前，下一条 prompt **不许**发出去 |
| `agent_settled {aborted:true}` 兜底 | 只在 aborted 时清；正常 settle 不清 |
| `disposition: 'handled'` | 不记进账本（Pi 没排队），中止时也不会被当成丢弃项报出来 |
| 账本匹配 | 同一段文本 steer 多次，丢弃的是**最新**那一条（Pi 按 FIFO 投递） |

**反向验证**：把 `clearAbandonedQueue()` 的两处调用临时注释掉，5 条里有 4 条立刻失败
（第 5 条是「正常 settle 不清队列」的反向对照，本来就该两边都过）。

**真机验证**：拿本机真的 Pi 1.4.0 跑同一组序列。

| | 第二轮有没有被注入那条 steer |
|---|---|
| 只 `abort`（改之前的 HAPI 行为） | **会**（`message_start` 里出现 `IMPORTANT_ABC123 remember to use pnpm`） |
| `abort` + `clear_queue`（改之后的 HAPI 行为） | **不会** |

**回归**：`bun run typecheck:cli` 通过；`bun run test:cli -- --run src/pi` 274 条全过；
`bun run test:cli`（全 cli 包）3474 条全过。

**对旧 Pi 的兼容**：Pi 对不认识的命令是**立刻报错**的（实测：`Unknown command: xxx`），
不是挂住。所以 Pi 0.83（没有 `clear_queue`）上这个调用会快速失败、被 catch 掉，
中止流程照常走完 —— 只是旧 Pi 上的「诈尸」问题依然存在，因为那条命令它就没有。
`clear_queue` 的 RPC 超时设成 2s：Pi 正常时是毫秒级往返，
万一 Pi 半死不活也不会把中止流程拖死。

### 9.4 能力提升那组也做完了（2026-10-23）

P0 修完之后，接着把「能力大幅度提升」那批做了。**全部走 CLI 侧，web 零改动** ——
因为 web 已经会渲染 `Bash` 卡片，HAPI 只要把消息转成它认识的形状就行。

#### 9.4.1 `/bash` —— 跑命令，输出进对话上下文

Pi 的 `bash` RPC 和 HAPI 原有的通用 `Bash` RPC **不是一回事**，这是这次的关键：

| | HAPI 通用 `Bash` RPC（`cli/src/modules/common/handlers/bash.ts`） | Pi 的 `bash` RPC |
|---|---|---|
| 谁跑 | CLI 直接 `child_process.exec` | Pi 在 **agent 自己的运行时**里跑（自己的 cwd / 环境 / 权限模型） |
| 输出去哪 | 只回到调用方 | **进对话上下文**，下一次请求时模型能看到 |
| 存哪 | 不存 | 存进 Pi session，条目 role 是 `bashExecution` |
| 流式 | 不流 | `bash_execution_update` 边跑边出 |
| 能中断 | 靠 timeout 杀 | `abort_bash` |

「输出进上下文」是那个真正值钱的地方：你在手机上敲 `/bash git status`，
agent 下一轮就知道仓库是什么状态。

实现走的是 HAPI 已有的 slash command 通道，所以 web 端**一行都没改**：

- `cli/src/pi/specialCommands.ts` — `/bash <command>` 解析（`/bash` 空命令给用法提示）
- `cli/src/pi/runPi.ts` — `handlePiSpecialCommand` 的 `bash` 分支：发 Pi RPC、渲染卡片、报错可见
- `cli/src/pi/loop.ts` — `PiRpcResolver.sendAndWaitWithId()`：把 RPC id 交出去，
  Pi 的流式 chunk 会重复这个 id，靠它把输出归到对应的命令
- `cli/src/pi/session.ts` — 在跑的 bash 命令登记表（id → 命令文本）
- `cli/src/pi/loop.ts` — 收到 `bash_execution_update` 就渲染成进行中的 `Bash` 卡片
- `cli/src/pi/runPi.ts` — 中止时如果还有 bash 在跑，补发 `abort_bash`
  （turn 的 abort 管不到 shell 命令，不补它就会在后台自己跑完）

这里有两个坑，都踩过：

1. **`abort_bash` 的超时不能用中止前的 `remainingMs`** —— 中止 RPC 自己已经吃掉了一部分
   deadline，拿旧值算出来可能是负数，负数超时会让这个 RPC **在发出去之前就超时**。
   改成中止之后重新算剩余时间。
2. **会话不在 streaming 时中止会直接短路**（`hadNativeWork` 为 false → 什么都不发），
   但这时候可能正有 bash 在跑。所以 `hadNativeWork` 现在也算上「有 bash 在跑」。

web 端能直接渲染，是因为 HAPI 的卡片协议本来就有 `Bash`：
`web/src/chat/toolGroups.ts:120` 把 `Bash` 归到 command 组，
所以 CLI 只要发 `{type:'tool-call', name:'Bash'}` + `{type:'tool-call-result'}` 就行。

真机验证（Pi 1.4.0）：

```
UPDATE id= b1 delta= 'SECRET_MARKER_42\n'
ENTRY type= message role= bashExecution cmd= echo SECRET_MARKER_42 out= 'SECRET_MARKER_42\n'
```

输出确实以 `bashExecution` 条目落进了 session，按 Pi 的规则会在下一次请求前
转成 user 角色文本喂给模型。

#### 9.4.2 `/tree` 和 `/name` —— 两个「终端独占」的死胡同变成真功能

`PI_TERMINAL_ONLY_COMMANDS` 原本把 `tree` 和 `name` 列为「只能在 Pi TUI 里跑」，
用户在 web 里敲 `/tree` 只会得到一句「不支持」。但 Pi 1.4.0 **两条都有 RPC**：

| 命令 | Pi RPC | 现在 |
|---|---|---|
| `/tree` | `get_tree` | 打印会话条目树（rewind / fork 出来的分支一目了然） |
| `/name <name>` | `set_session_name` | 改会话名（`get_state` 的 `sessionName` 会跟着变） |

树是纯文本渲染的（`cli/src/pi/sessionTree.ts`），因为 web 没有树视图，
而 `/tree` 的意义就是让人看清当前会话在哪个分支上。

真机验证：`get_tree` 返回的树是
`model_change → thinking_level_change → system → user → assistant`，
`set_session_name` 之后 `get_state` 确实报 `sessionName: my-feature`。

#### 9.4.3 `extension_error` —— Pi 扩展崩了不再悄无声息

Pi 在扩展 handler 抛异常时会广播 `extension_error`。HAPI 之前静默丢弃，
现象是「工具一直不返回」但没有任何提示。现在映射成一条可见消息：

```
⚠️ Pi extension error (/home/user/.pi/agent/npm/node_modules/pi-goal-x/...): boom
```

#### 9.4.4 发图前先看模型支不支持

Pi 的 `get_state.model.input` 会写明当前模型收什么（`["text","image"]`）。
Pi 自己是会兜底的 —— 不支持图片的模型，它把图片换成占位文本
`(image omitted: model does not support images)`。

**所以不会崩，但用户以为图发出去了、模型其实压根没看到，全程零提示。**
现在 HAPI 在发图前先查这个字段，不支持就明确告诉用户。

#### 9.4.5 这批的验证

| 项 | 结果 |
|---|---|
| 新增单测 | 15 条（runPi 8 + specialCommands 2 + sessionTree 5） |
| Pi 测试套件 | 289 条全过（P0 那轮之后是 274） |
| 真机 Pi 1.4.0 | `bash` / `get_tree` / `set_session_name` 三条都实测通过 |

### 9.5 还没做的

`queue_update` 事件、`set_steering_mode` / `set_follow_up_mode`、
`set_auto_compaction` / `set_auto_retry` / `abort_retry`、
`get_available_thinking_levels`、`export_html`、`get_messages`、
`get_last_assistant_text`、`cycle_model` / `cycle_thinking_level`。

这几条要么需要 web 侧加设置入口，要么价值一般，按第八节的顺序慢慢来。

另外发现一条**既有的测试脆弱点**（不是这次改的）：
`cli/src/pi/runPi.test.ts` 里 `executes /compact via Pi RPC` 这个用例
单独跑（用 `-t` 过滤）会失败 —— 它依赖同一个文件里更早的用例给会话设置过 model，
否则 `getKeepAliveRuntime()` 返回 undefined，`expect.anything()` 匹配不上。
整文件跑是绿的。

---

## 十、提交前的自查（2026-10-23）

改动写完之后做了一轮自查（自己过一遍 diff + 一个独立 reviewer 过一遍），
发现并修掉了下面这些。**这些坑都不是理论上的，是真会出问题的。**

### 10.1 高危：steer 账本按文本匹配，对上了「Pi 改写过的文本」就失效

第一版实现是拿 `clear_queue` 回来的文本去匹配 HAPI 自己记的文本。
问题在于 **Pi 在入队之前会改写文本**：

```js
// Pi 1.4.0 agent-session.js _queueUserInput()
let expandedText = this._expandSkillCommand(processedInput.text);
expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
if (behavior === "steer") await this._queueSteer(expandedText, processedInput.images);
```

skill 命令和 prompt 模板都会被展开，所以 **Pi 报回来的文本 ≠ HAPI 发出去的文本**。
文本匹配不上 → 拿不到 localId → `rejectPendingEntry` 没撤掉 →
历史 FIFO 错位，下一轮的 user entry 会挂到上一条 steer 上。

**改成按位置匹配**：Pi 是 FIFO 投递的，它还攥着的那几条就是 HAPI 最近发的那几条，
所以 `clear_queue` 返回 N 条，就取账本的**最后 N 条**。跟文本长什么样无关。

顺带修了两处会让「后缀」这个前提不成立的地方：

- **steer dispatcher 被中止时**：原来 `if (this.stopped) return` 在记账之前，
  于是 Pi 收了消息、HAPI 却没记账 → 账本比 Pi 的队列短一截 → 位置全错。
  现在记账挪到 stopped 判断之前。
- **native session 换身份时**（fork / clone / rewind）：新 session 的队列是空的，
  旧账本不再对应，所以身份一变就清空。

### 10.2 高危：清队列失败被静默吞掉，等于 P0 修复没生效

`clear_queue` 失败（Pi 半死不活、旧 Pi 没这条命令）时原来只写了一条 debug 日志。
但失败的后果是 **Pi 还攥着那条 steer，会在下一轮诈尸** —— 跟没修一样。
现在失败会明确告诉用户。

### 10.3 中危：图片能力检查其实是空转的

`applyNativeRuntimeState` 只在 fork / clone / rewind 恢复那条路上跑；
正常启动走的是 `applyGetState`，而它**没有把 `model.input` 带过去**。
所以 `currentModelSupportsImages` 永远是 `undefined`，那条提示从来没触发过。
现在 `applyGetState` 也带上 `model.input`。

### 10.4 中危：实时预览只剩最后一个 chunk

web 的 reducer 是 `existing.tool.result = seed.progress` —— **每次更新整体替换**。
而 HAPI 转发的是 Pi 的单个 chunk，所以卡片上只会看到最后一段输出。

改成：HAPI 累积已收到的输出，每次发的是**累积快照**。
但每次都发累积值是 O(n²)，所以加了节流：累积够 4KB 才刷新一次预览，
预览本身超过 32KB 就停（最终卡片里仍然是 Pi 自己截断过的完整结果）。

顺带发现 Pi 的 `bash_execution_update` 流**本身没有上限**（只有最终结果被截断），
所以这个预览上限是必须的，否则一个 `yes` 就能把 hub 冲垮。

### 10.5 其他

| 问题 | 处理 |
|---|---|
| `/name` 不带参数会提示「终端独占命令」，但 `/help` 里又列着它，自相矛盾 | 改成 `⚠️ Usage: /name <name>` |
| `/tree` 渲染没标出当前在哪个分支上，而「看清分支」正是它的意义 | 叶子节点标 `← current` |
| `bash_execution_update` 的 id 在 schema 里是必填，但 Pi 文档说它可以没有 | 改成可选 |
| 预览上限变量名叫 `_BYTES` 其实数的是字符 | 改名 `_CHARS` |

### 10.6 一条**没有**采纳的建议

reviewer 建议 `/bash` 也去拿 runtime mutation 锁。**这个没采纳**，因为中止路径
也要拿同一把锁 —— bash 要是持着锁不放（最长 120 秒），中止就得等锁，
反而会把「中止」这件事本身拖死。bash 期间 prompt 泵本来就是关着的
（`piSpecialCommandInFlight`），所以不持锁是安全的。

### 10.7 验证

| 项 | 结果 |
|---|---|
| Pi 测试套件 | 293 → 297 条全过（这轮又补了 4 条针对性单测） |
| cli / web / hub / shared 全套 | 全过 |
| typecheck | cli / web / hub / relay 全过 |
