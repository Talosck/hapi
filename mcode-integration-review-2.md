# mcode ↔ HAPI 二次复审（2026-10-22）

> 上一篇 `mcode-integration-review.md` 记录了 P0–P4 的实施与实施后审计。本文是对**当前代码**的独立二次复审，只写它没覆盖到的部分：功能性缺陷、契约不一致、体验问题。
>
> 方法：读代码 + 跑 `cli/src/mcode` 全量测试（251 passed）+ 对关键结论逐条回查源码行号。
> 子代理结论一律由我复核后才写入；标注「**需实机确认**」的是唯一没能在本机验证的假设。

---

## P0 — 功能性缺陷

### B1. 不支持 steer 的 mcode 构建上，Steer 按钮是死按钮

**证据链（全部回查过）**

| 环节 | 位置 | 事实 |
|---|---|---|
| 能力位词表 | `shared/src/schemas.ts:46-59` | `McodeExtensionCapabilitiesSchema` 只有 6 个布尔位，**没有 steer** |
| CLI 投影 | `cli/src/mcode/utils/mcodeExtensions.ts:93-108` | `toMcodeExtensionCapabilities()` 只投影 goal/goalCreate/goalPatch/goalClear/delegation/delegationStop |
| agent 自述 | `cli/src/mcode/utils/mcodeExtensions.ts:42` | agent **可能**广播 `mcode/session/steer`（runtime flag 可裁剪） |
| CLI 置位 | `cli/src/mcode/mcodeRemoteLauncher.ts:455` | `setSteeringActive(true)` **无条件**执行，与 steer 是否可用无关 |
| web 闸门 | `web/src/components/SessionChat.tsx:2134` | `isSteeringSupportedForSession(metadata)` 按 **flavor** 判定 → mcode 恒为 true |
| CLI 拒绝 | `cli/src/mcode/mcodeRemoteLauncher.ts:941-943` | 未广播 steer 时返回 `MiniMax Code did not advertise the steer extension` |
| 错误出口 | `web/src/components/AssistantChat/QueuedMessagesBar.tsx:393-397` | 原样 toast 这句英文 |

**症状**：agent 没广播 `mcode/session/steer` 的构建上，轮次运行时排队消息出现 Steer 按钮；点下去必然失败，弹一句英文原文。

**当前实际影响**：上一篇文档 §11.3 的实机结论是「扩展面宣告与文档完全一致（15 methods + 4 notifications）」，即**当前线上构建广播了 steer**，所以今天大多数用户看不到这个死按钮。它是**结构性**缺陷，不是当前正在发烫的 bug —— 但只要出现一个裁剪过 steer 的构建（或 agent 改了 runtime flag），就会立刻暴露：CLI 无条件置 `steeringActive`（`:455`）、web 只按 flavor 放行，两边都不看 agent 的自述。

**注意一个坑**：即使 CLI 现在就多发一个 `steer: true`，web 也看不到——hub 侧 `hub/src/sync/sessionCache.ts:190-191` 用 `MetadataSchema.safeParse()` 解析，Zod 对未知键是**剥离**而不是报错。所以这三处必须同一个改动里一起动：
`shared/src/schemas.ts` 加位 → `cli/src/mcode/utils/mcodeExtensions.ts` 投影 → `web/src/components/SessionChat.tsx` 改闸门。

**建议**：加 `steer` 能力位；CLI 只在 `supportsMethod(MCODE_METHOD_STEER)` 时置 `steeringActive`；web 的 `canSteer` 改成「flavor 支持 **且** 能力位为真」。顺带给 `McodeExtensionCapabilitiesSchema` 加 `.strict()`，让漏发的位**响亮地失败**而不是静默消失。

---

### B2. goal 卡片的时间戳单位错，日期显示在公元五万多年后

**证据**

- agent 用 **epoch 毫秒**：CLI 自己写明了 —— `cli/src/mcode/utils/mcodeExtensions.ts:374-390`「MiniMax Code counts in epoch milliseconds while HAPI counts in epoch seconds」，转换处 `createdAt: Math.floor(goal.createdAt / 1000)`。
- web 的 **tool-result 路径**原样透传：`web/src/components/ToolCard/goalTools.ts:44-52` 把 `created_at` / `updated_at` 直接拷进 `goal.createdAt`（毫秒）。
- web 的 **卡片渲染**按秒算：`web/src/components/ToolCard/views/GoalView.tsx:17-21` → `new Date(seconds * 1000)`，第 41-42 行用它渲染「创建 / 更新」。

**症状**：`new Date(1.76e15 * 1000)` → 公元 57742 年，`Number.isFinite` 通过，所以不会隐藏，只会显示一个荒谬的日期。

**⚠️ 需实机确认**：上面第 2 条假设「agent 的 tool result 与 extension state 用同一个单位（毫秒）」。CLI 的注释只覆盖了 extension state 那条路径。跑一次 `get_goal` 工具、看返回的 `created_at` 是 13 位还是 10 位即可定案。

**修法**：tool-result 路径按毫秒解析、按秒存（与 `toHapiThreadGoal` 统一），或者在 CLI 侧就把工具结果翻译成 HAPI 契约再下发。

---

### B3. goal 面板把原始 HTTP 响应体当错误文案显示

`web/src/components/SessionStatusPanel.tsx:97-105` 只特判了 `409 + session_inactive`，其余一律 `e.message`；而 `web/src/api/client.ts:226-228` 构造的 message 就是 `HTTP 400 Bad Request: {"success":false,"error":"…"}`。

**症状**：目标面板红字显示 `HTTP 400 Bad Request: {"success":false,"error":"A goal needs an objective"}`。

同族三处：
- `web/src/components/SessionStatusPanel.tsx:300-302`：「停止子代理」按钮**没有** 409 映射 → 会话刚结束时弹 `HTTP 409 Conflict: {"error":"Session is inactive",…}`。
- `web/src/components/SessionStatusPanel.tsx:95`：`result.error` 是 agent 原文（如「the agent does not advertise the goal extension」），聊天时间线已经清理过，目标面板没有。
- `hub/src/web/routes/sessions.ts:1583-1586`：create-goal 的**所有** schema 失败都报成「A goal needs an objective」，`tokenBudget: 1.5` 这种也报这句。

**修法**：抽一个 `apiErrorMessage(e, fallback)` 工具函数，三个面板共用；Hub 侧把 Zod 的 issue path 带上。

---

### B4. 切模型失败完全静默

`web/src/components/SessionChat.tsx:1680-1686`：

```ts
} catch (e) {
    haptic.notification('error')
    console.error('Failed to set model:', e)
}
```

只有触感 + 控制台，**没有任何用户可见文案**。而 mcode 的切换是会被 agent 拒绝的：`cli/src/agent/backends/acp/AcpSdkBackend.ts:588-591` 的注释写明「a build that publishes the model picker under another id would otherwise show the catalog fine and then reject every switch」，hub 也会把 agent 的原话带回来（409）。

**症状**：用户选了模型 → 选择器弹回原处 → 界面零解释。

**修法**：把 mutation 的 error 接到 composer 已有的错误横幅上；至少区分「agent 拒绝了」和「网络失败」。

---

## P1 — 契约不一致（不改就会持续长出新 bug）

### B5. patch 目标状态里有一个 agent 拒绝的值

`shared/src/apiTypes.ts:1001-1012` 的 `McodeGoalPatchRequestSchema` 允许 `status: 'usageLimited'`，但：

- agent 的 patchable 集合没有它：`cli/src/mcode/utils/mcodeExtensions.ts:395-405`（`usage_limited` 是运行时派生状态）。
- CLI 明确拒绝：`cli/src/mcode/mcodeRemoteLauncher.ts:1049-1054` → `MiniMax Code cannot be asked to enter the "usageLimited" goal status`。

**症状**：REST 返回 HTTP **200** + `{success:false}`，而不是 400。schema 说合法、agent 说非法。

**附带**：shared 的测试把这个错误值钉住了 —— `shared/src/schemas.mcodeExtensions.test.ts:60`。修的时候要连测试一起改。

### B6. patch 允许空 patch

`McodeGoalPatchRequestSchema.safeParse({}).success === true`，但 CLI 晚一步才拒（「A goal update needs at least one field」，`cli/src/mcode/mcodeRemoteLauncher.ts:1062-1064`）。同样该在 schema 层用 `.refine()` 挡掉，让 hub 返 400。

### B7. `tokenBudget: null` 在 create 被丢弃、在 patch 被透传

- create：`cli/src/mcode/utils/mcodeExtensionControl.ts:121-123` —— `tokenBudget === null` 时**整个字段不发**。
- patch：`cli/src/mcode/utils/mcodeExtensionControl.ts:143` —— `null` 原样发给 agent。

「不限额」在 create 时永远到不了 agent，两个动词语义不一致。
（这一条上一篇文档 §7.4 已经提过，**仍未修**。）

**建议**：统一编码 —— 推荐「省略 = 不限额，`null` 视为非法」，在 shared schema + 两个 CLI 调用点同时执行。

### B8. REST 目标响应是 snake_case，事件路径是 camelCase

`shared/src/apiTypes.ts:938-942` 的 `McodeGoalState.status` 直接带 agent 的 `budget_limited`；而事件路径经过 `shared/src/mcodeGoalStatus.ts` 翻译成 `budgetLimited`。web 今天只读 `success` 所以没炸，但 native / 第三方客户端会拿到未翻译的值。**建议**：REST 也返回 `ThreadGoal` 形状。

### B9. goal 状态枚举一共有 5 份

- `shared/src/schemas.ts:310-317`（`ThreadGoalStatusSchema`）
- `shared/src/mcodeGoalStatus.ts:17-24`（agent → HAPI 映射）
- `shared/src/apiTypes.ts:1002-1009`（patch 枚举，含 B5 的错值）
- `web/src/chat/normalizeAgent.ts:126-133`（web 内联复制）
- `web/src/components/ToolCard/views/GoalView.tsx:8-15` + `web/src/chat/presentation.ts:129-137`（状态 → 文案/色调）

加一个状态要改 5 处，漏一处就是「目标静默消失」（`web/src/chat/normalizeAgent.ts:39` 解析失败直接丢事件）。

### B10. steering 白名单有两份不同源的列表

`shared/src/modes.ts:220` 定义了 `STEERING_SUPPORTED_FLAVORS = ['codex','cursor','pi','mcode']`，但 `isSteeringSupportedForSession()`（同文件 `:238`）**硬编码**了 `'codex' | 'pi' | 'mcode'`。生产代码读的是后者 → 往常量里加 flavor 不会生效。建议从常量派生。

### B11. 清空目标事件不携带 threadId，web 收到就无脑丢目标

事件**类型**是带 threadId 的（`web/src/chat/types.ts:61`：`{ type: 'thread-goal-cleared'; threadId?: string }`），但：

- mcode 的三个发送点都不填：`cli/src/mcode/mcodeRemoteLauncher.ts:710`（本地 TUI 交接）、`:1076`（清空目标 RPC）、`:1402`（agent 的 goal_update 报 cleared）—— 全部是 `{ type: 'thread-goal-cleared' }`。
- web 收到任何 clear 事件都直接丢目标，根本不看 threadId：`web/src/chat/reducer.ts:73` → `if (event.type === 'thread-goal-cleared') return null`。

多线程 / 多 goal 场景下会误删别人的目标。**建议**：mcode 发送时带上 goal 的 threadId；web 按 id 删，没有 id 时才兜底全删。

---

## P2 — 体验与健壮性

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| B12 | 连接器的 auth 状态取到了却从不渲染 | `web/src/components/SessionStatusPanel.tsx:231-235`（props 里有 `auth`，body 里从没用过） | 未认证 / 过期的 connector 看起来完全正常，agent 调用时才炸 |
| B13 | apps 探针失败 → 整个状态面板消失 | `web/src/components/SessionChat.tsx:1525-1526`（`alwaysVisible` 只算 `goalCreate` 和 `apps.length`，没算 `error`） | 探针失败时连「连不上」的提示都看不到（提示在 `:238-242`，但面板整个不渲染） |
| B14 | 预算框允许小数，API 要求整数 | web `SessionStatusPanel.tsx:114-117`（只查 `> 0`）vs shared `apiTypes.ts:962-965`（`.int()`） | 输 `1.5` → 400 + 误导文案「A goal needs an objective」 |
| B15 | mcode 目录没有开限的发现轮询 | `web/src/hooks/queries/useMcodeModelsForSession.ts:19-30`（对比 opencode：每秒一次、封顶 10 次，`useOpencodeModels.ts:11-28`） | 新会话首次探测返回空目录时，选择器只剩「Default」，直到某次无关刷新 |
| B16 | 模型在 web 之外被改时，effort 档位不刷新 | opencode 有 `session.model` 变化的重置（`SessionChat.tsx:993-997`），mcode 没有 | agent 自行换模型 / 本地 TUI 换模型后，effort 下拉还是上一个模型的档位 |
| B17 | `useMcodeApps` 从不失效 | `web/src/hooks/queries/useMcodeApps.ts:38`（staleTime 60s，全仓无 invalidate） | 用户在 HAPI 之外授权 connector 后，列表和 auth 都是陈的 |
| B18 | 目标 / 委派树从消息窗口推导 | `web/src/chat/sessionStatus.ts:172-185`、`SessionChat.tsx:1513-1527` | 分页「历史」视图里目标可能落在窗口外 → 面板显示无目标 |
| B19 | 状态面板的 1 秒计时器可能活得比会话久 | `web/src/components/SessionStatusPanel.tsx:275-285`（子代理 `endedAt === null` 时一直走） | 异常结束时，dead 子代理的耗时一直涨 |
| B20 | 三处硬编码英文「Default」 | `SessionChat.tsx:1126`、`NewSession/mcodeModels.ts:52`、`AssistantChat/HappyComposer.tsx:1105` | `newSession.model.default` 这个 key 已存在（en/zh-CN/ru 都有），同一个页面上 effort 是「默认」、model 是「Default」 |
| B21 | 目标表单不是 `<form>` | `web/src/components/SessionStatusPanel.tsx:180-215` | 回车不提交、移动端不自动聚焦、错误没有 `role="alert"` |

---

## P3 — 小问题与清理

| # | 问题 | 位置 |
|---|---|---|
| B22 | 排版：`if` 挤在花括号同一行 | `cli/src/mcode/utils/mcodeExtensionControl.ts:199` |
| B23 | `displayedLocalIds` 无限增长（长会话内存） | `cli/src/mcode/mcodeRemoteLauncher.ts:185` |
| B24 | 模型 id 契约注释自相矛盾（`:u` vs `:v:`） | `cli/src/mcode/utils/modelId.ts:6-11` vs `shared/src/mcodeModelId.ts:5-13` |
| B25 | 模型 id 编解码对含 `#` 的 id 不互逆 | `shared/src/mcodeModelId.ts:26-64`（CLI 把编码结果直接发给 agent） |
| B26 | mcode 测试用真实退避时钟 | `cli/src/mcode/mcodeRemoteLauncher.test.ts` —— 「keeps the message through several refusals in a row」单个用例 6s，整套 12.6s；改假时钟可省 ~10s |
| B27 | `restoreReservation` 的顺序计算与 `unshift` 的负数 `enqueueOrder` 冲突 | `cli/src/utils/MessageQueue2.ts:397-414` vs `:236` —— steer 回滚与拒绝重排同时发生时，消息可能插错位置（共享队列，影响所有 flavor） |

---

## 已知但仍未修（上一篇 §12.5 已记录）

被 agent 拒绝后重入队的消息**只活在 CLI 进程内存**：hub 侧那条消息出队时就已经 ack（`onBatchConsumed`），CLI 在退避等待期间被杀掉 → 消息丢失。
彻底修要把 ack 推迟到「agent 接受轮次」之后（`agy` flavor 已经是这个模型：`acknowledgeMessagesOnDequeue: false` + 手动 `emitMessagesConsumed`），但那会改动 MiniMax Code **所有**消息的投递契约（hub 排队浮条、取消语义、seq 回填都要跟着核）。属于下一轮的重构，不是顺手能改的。

---

## 建议的动手顺序

1. **B1**（steer 能力位，三处一起改）+ **B3**（错误文案统一）—— 用户直接可见。
2. **B2**（先实机确认单位）+ **B4**（切模型静默）—— 用户直接可见。
3. **B5 / B6 / B7**（shared schema 三处收紧 + 改 shared 测试）—— 一次改动，避免后面继续长错。
4. **B8 / B9 / B10 / B11**（契约收敛）—— 属于「改一次省半年」。
5. **P2 整表**（B12–B21）—— 可以拆成独立 PR。

---

## 验证

| 检查 | 结果 |
|---|---|
| `bun run vitest run src/mcode`（cli） | ✅ 14 files / 251 tests passed |
| 关键结论回查源码行号 | ✅ 全部逐条核对；B2 的单位假设除外（标注需实机确认） |
| 未跑 | `bun typecheck`、hub/web/shared 全量测试（本轮为只读复审，未改代码） |

---

# 追加：忙碌拒绝的根因、复现与修复（2026-10-22 晚）

这一节记录的是**另一个**问题（与上面 B1–B27 无关），现场取证 + 受控复现 + 已实施修复。

## 现象

用户在 mcode 会话里发一条消息，等了很久没回音；期间冒出一句
"MiniMax Code is busy with another turn on this session …"，之后消息才姗姗来迟。
用户随后把同一段话又发了一遍，导致 agent 收到两遍。

## 根因

**MiniMax Code runtime 会自己开 turn（`turn_task_delivery_*`，用于回填后台子代理结果），
HAPI 看不见。** HAPI 只认自己的 `session/prompt` 何时 resolve，于是 runtime 一开工，
HAPI 就判定"会话空闲" → 投递 → agent 拒（`Session already has an active Turn`）→
重新入队 → 退避重试 → 循环。

取证（本机 `~/.hapi` 的 CLI 日志 + hub SQLite + agent 自己的 transcript 三方对齐）：

- 11:39:02 模型的回合结束（`stopReason: stop`），11:39:06 HAPI 的 prompt resolve → HAPI 转入等待。
- 11:49:08 runtime **自己**开了 `turn_task_delivery_be80691d4` 并工作到 11:53:27+。HAPI 全程无感。
- 11:53:43 用户发消息 → agent 拒 → HAPI 发提示 + 重新入队。
- 11:54:23 / 11:56:00 用户重发两次（因为 4.5 分钟里毫无反馈）。
- 11:53:43 → 11:58:32 共 **32 次拒绝**、**205 行 token_count 噪声**；3 条消息最后被拼成
  **同一个 prompt** 交给 agent → 同一段话喂了两遍。

## 受控复现（2026-10-22 12:39）

watcher 盯住 agent transcript 的新 turn + hub 的 `thinking=false`，在窗口内向本会话 POST
一条消息：

```
[12:39:17] runtime 自开 turn: turn_task_delivery_800d5721d523480b96467d1013a73b52
           hub thinking = false          ← HAPI 以为会话空闲
[12:39:23] POST /messages → 200
[12:39:24] session refused the turn {"reason":"busy",
           "message":"… Session already has an active Turn. Use queue send …"}
[12:39:25→28→31→36→41→47] Refused turn re-queued …（退避 1s→2s→3s→4s→5s→6s）
```

30 次拒绝、34 行落库（其中 31 行是 token_count 噪声）、消息最终在 **269 秒后**才投出去。
错误文本、退避节奏、重入队行为与线上事故逐字一致。

> 复现脚本：`/tmp/repro-busy-refusal.ts`（未入库）。

## 已实施的修复

| # | 改动 | 位置 |
|---|---|---|
| 1 | 拒绝提示从 `type:'message'`（agent 气泡）改为独立事件 `type:'queue-notice'`，带 `reason` / `waitingSeconds`；纳入无损事件集 | `cli/src/api/apiSession.ts`、`cli/src/mcode/mcodeRemoteLauncher.ts` |
| 2 | agent state 新增 `waitingForAgent` / `waitingSinceMs`，并在 agent 侧 turn 结束时清理 | `shared/src/schemas.ts`、`cli/src/mcode/mcodeRemoteLauncher.ts` |
| 3 | 退避改指数（1s→2s→4s…，上限 60s），原来封顶 10s | `cli/src/mcode/mcodeRemoteLauncher.ts` |
| 4 | 重复的**空** token_count 不再落库（原来每次拒绝写一行） | `cli/src/mcode/session.ts` |
| 5 | web 新增 `AgentWaitingNotice`：会话上方显示"代理正忙 · 已等 N 秒" | `web/src/components/AssistantChat/AgentWaitingNotice.tsx` |
| 6 | web 拦截重复发送：最后一条用户消息同文本且仍在等待 → 拒绝并 toast | `web/src/hooks/mutations/useSendMessage.ts`、`web/src/router.tsx` |
| 7 | 契约文档补 `queue-notice` 事件与 `waitingForAgent` 字段 | `docs/api/client-contract/messages.md` |

## 还没做的（下一轮，需要先定方向）

- **根因层**：HAPI 仍然看不见 runtime 自开的 turn。要么让 agent 侧暴露 busy 状态，要么改用
  agent 自己的 queue（`mcode/session/queue/enqueue`）—— 上一篇 §9 拒绝过后者，理由是"双份
  真相"，而这次事故恰恰说明 agent 的 queue 才是真相。改它会动投递语义（hub 排队浮条、取消、
  seq 回填），得单独立项。
- **native 对齐**：iOS / Android 的 `ChatTypes` 走 `default` 分支，未知事件不会崩，但
  `queue-notice` 会落到 generic 渲染；native 的"等待中"提示还没做。
- **非 web 客户端**：重复发送的拦截只在 web 客户端；telegram bot / MCP / native 仍可能把
  同一段话送两遍。
