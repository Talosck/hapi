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

### B5. patch 目标状态里有一个 HAPI 自己拒绝的值 ✅ 已修（第 5 轮）

`shared/src/apiTypes.ts` 的 `McodeGoalPatchRequestSchema` 允许 `status: 'usageLimited'`，但 HAPI 自己的 CLI 明确拒绝：
`cli/src/mcode/mcodeRemoteLauncher.ts` → `MiniMax Code cannot be asked to enter the "usageLimited" goal status`。

**症状**：REST 返回 HTTP **200** + `{success:false}`，而不是 400。schema 说合法、管道说非法。

> **⚠️ 更正（本轮回查 agent 源码后）**：原文写的是「agent 的 patchable 集合没有它」——**这是错的**。
> agent 的 patch 归一化 `HRe` 用 `iKt = new Set(["active","paused","complete","blocked","budget_limited","usage_limited"])`
> 校验状态，**`usage_limited` 是接受的**（agent 源码 `chunk-QEPCDCRA.js`）。
> 挡它的是 **HAPI 自己的**映射表（当时在 `cli/src/mcode/utils/mcodeExtensions.ts`）。
> 结论不变（schema 与管道不一致），但**理由要改**：这是 HAPI 的契约决定，不是 agent 的拒绝 ——
> `usage_limited` 是 agent 从自己的用量计数派生出来的状态（provider 配额 / 限流），
> 不该由客户端伪造。把目标**移出**该状态（`active`）不受影响。

**附带**：shared 的测试把这个错误值钉住了 —— `shared/src/schemas.mcodeExtensions.test.ts`。修的时候要连测试一起改。

### B6. patch 允许空 patch ✅ 已修（第 5 轮）

`McodeGoalPatchRequestSchema.safeParse({}).success === true`，但 CLI 晚一步才拒（「A goal update needs at least one field」）。同样该在 schema 层用 `.refine()` 挡掉，让 hub 返 400。

> agent 自己的行为与修完的契约一致：patch 归一化 `HRe` 在没有任何改动时抛
> `400 "PATCH body must include status, objective, or token_budget."`。

### B7. `tokenBudget: null` 在 create 被丢弃、在 patch 被透传 ❌ 误报（第 5 轮更正）

- create：`cli/src/mcode/utils/mcodeExtensionControl.ts` —— `tokenBudget === null` 时**整个字段不发**。
- patch：同文件 —— `null` 原样发给 agent。

原判断：「不限额」在 create 时永远到不了 agent，两个动词语义不一致。

**回查 agent 源码后：两个动词语义其实是一致的，这是误报。**

| 动词 | agent 的归一化 | `null` 的含义 |
|---|---|---|
| create | `GRe`：`cKt(t)` 把「非数字 / 非正数」归一成 `null`，然后 `...s!==null?{tokenBudget:s}:{}` —— `null` **与省略完全等价**（字段都不出现） | 不限额 |
| patch | `HRe`：`t.tokenBudget!==void 0 && (r={...r, tokenBudget: t.tokenBudget>0?Math.floor(t.tokenBudget):null})` | `null` = 清掉额度 = 不限额 |

两边的终点都是「不限额」，所以 CLI 在 create 侧丢 `null` **没有丢信息**。
真正剩下的差异只有一处：HAPI 的 schema 要求 `tokenBudget` 是正整数（`0` 直接 400），
而 agent 会把 `0` 也归一成「无额度」。本轮保持 HAPI 侧的严格解释 ——
客户端传 `0` 会被明确拒绝，而不是悄悄变成「不限额」。

**本轮对 tokenBudget 的处理**：shared schema 保持「正整数或 null」，并在注释里写清 `null` 的含义
（create = 不限额，patch = 清空额度），没有改 create 侧的丢字段行为 —— 因为丢不丢是等价的。

### B8. REST 目标响应是 snake_case，事件路径是 camelCase

`shared/src/apiTypes.ts:938-942` 的 `McodeGoalState.status` 直接带 agent 的 `budget_limited`；而事件路径经过 `shared/src/mcodeGoalStatus.ts` 翻译成 `budgetLimited`。web 今天只读 `success` 所以没炸，但 native / 第三方客户端会拿到未翻译的值。**建议**：REST 也返回 `ThreadGoal` 形状。

### B9. goal 状态枚举一共有 5 份 ✅ 已修（第 5 轮，词表部分）

- `shared/src/schemas.ts`（`ThreadGoalStatusSchema`）—— canonical
- `shared/src/mcodeGoalStatus.ts`（agent → HAPI 映射）—— canonical
- `shared/src/apiTypes.ts`（patch 枚举，含 B5 的错值）—— ✅ 已并入 `mcodeGoalStatus.ts`
- `web/src/chat/normalizeAgent.ts`（web 内联复制）—— ✅ 已改成直接用 shared 的 `ThreadGoalStatusSchema`
- `web/src/components/ToolCard/views/GoalView.tsx` + `web/src/chat/presentation.ts`（状态 → 文案/色调）—— **保持独立**（这是展示映射，不是词表）

另外还有两份**没进这张表**的重复，这一轮一起收了：

- `cli/src/mcode/utils/mcodeExtensions.ts` 的 `MCODE_GOAL_PATCH_STATUSES` + `HAPI_TO_MCODE_GOAL_STATUS` —— ✅ 已删，改用 shared 的映射
- shared 里 patch 枚举与 CLI 映射各写一份 —— ✅ 现在都由 `shared/src/mcodeGoalStatus.ts` 的
  `MCODE_GOAL_PATCHABLE_STATUSES` + `HAPI_TO_MCODE_GOAL_STATUS` 一处生成（`satisfies` 保证两者同步）

加一个状态现在要改的地方：从 5 处降到 2 处（canonical 词表 + 展示映射）。
漏一处的后果没变（`web/src/chat/normalizeAgent.ts` 解析失败直接丢事件），但 web 那份已经不会再漏了。

### B10. steering 白名单有两份不同源的列表 ✅ 已修（第 5 轮）

`shared/src/modes.ts` 定义了 `STEERING_SUPPORTED_FLAVORS = ['codex','cursor','pi','mcode']`，但 `isSteeringSupportedForSession()` **硬编码**了 `'codex' | 'pi' | 'mcode'`。生产代码读的是后者 → 往常量里加 flavor 不会生效。

现在 session 闸门从常量派生（`STEERING_UNCONDITIONAL_FLAVORS`），
`cursor` 的 legacy 特判（stream-json 不能 steer）原样保留。行为逐条对齐过，没变。

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

> **进度（第 5 轮）**：第 3 项的 **B5 / B6** 已做（**B7 是误报**，见上面 B7 的更正）；
> 第 4 项的 **B9（词表部分）/ B10** 已做。
> **B8**（REST 目标响应仍是 snake_case）没做 —— 它要改的是 hub 的响应形状，影响 native / 第三方客户端，属于「改一次省半年」里换契约的那半，单独做。

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

---

# 追加：根因层——让 HAPI 看得见 agent 的真实占用（2026-10-22 晚，第 3 轮）

上一轮把"忙碌拒绝"从**用户可见的故障**降级成了**可见的等待**（提示 + 浮条 + 拦截重发），
但根因还在：HAPI 仍然**看不见** runtime 自开的那一轮，只能盲发 → 被拒 → 退避 → 重试。
这一轮动的就是这一层。

## 两个选项，先用事实否掉一个

上一轮留的题目是二选一：**（a）让 agent 侧暴露 busy 状态**，还是
**（b）改用 agent 自己的 queue**（`mcode/session/queue/enqueue`）。
本机实测（agent 0.5.9，探针 `/tmp/probe-mcode-acp.ts`、`/tmp/probe-mcode-queue.ts`、
`/tmp/probe-mcode-output.ts`）的结论是：**（b）不能用**。

agent 在 initialize 里广播的扩展面共 15 个方法 / 4 个通知：

```
session/activate, mcode/session/activate, mcode/session/steer,
mcode/session/queue/{list,enqueue,update,delete,steer},
mcode/session/goal/{get,create,patch,clear},
mcode/session/delegation/{get,stop}
mcode/session/{current_session_update,queue_update,goal_update,delegation_update}
```

**（a）ACP 协议面无路可走**：上面这份清单里**没有任何一个"当前是否有 turn 在跑"的读取方法**。
`mcode/session/current_session_update` 的 payload 只有 `{sessionId}`。
但 agent **确实**暴露了 busy 状态——只是不在协议面上，而在它自己的运行时索引里（见下）。

**（b）能用，但要用它交付消息，HAPI 会丢掉 agent 的输出和 Steer**：

| 实测 | 结果 |
|---|---|
| `queue/enqueue` 会不会被拒 | 不会。永远返回 `{itemId, status:'queued', position}` |
| 空闲时 enqueue | **直接开一轮**（随后 `session/prompt` 被拒 `Session already has an active Turn`） |
| 忙时 enqueue | 挂起，`queue/list` 里可见 `status:'queued'`, `source:'api'` |
| **enqueue 开的那一轮，输出会回传给 ACP 客户端吗** | **不会**。盯满 150 秒，0 条 `agent_message_chunk`；那一轮确实跑了（`usage_update` 用了 16043 token），但输出没回传 |
| **enqueue 开的那一轮能被 steer 吗** | **不能**。`mcode/session/steer` 报 `Steering requires an admitted, active ACP prompt Turn for this Session.` |

原因在 agent 源码里：ACP 的 `session/prompt` 处理器只把**它自己发起的这一轮**的 runtime 事件
投影成 `session/update`（`run-acp-command-*.js` 的 `onSessionEvent` + `ir` 投影器）。
`queue/enqueue` 走的是 `runtime.enqueueMessage()`，那一轮的输出没有 ACP 客户端在听。

所以 **（b）等于拿"看得见回复"换"不丢消息"**——而"看得见回复"是这个产品的命门。**（b）否掉。**

## 根因其实是"等待方式不对称"

agent 源码里两处实现放在一起看，问题就清楚了：

- **runtime 自己开的那一轮**（`turn_task_delivery_*`，回填后台子代理结果）走
  `conversation.ingress.steer(...)`，**被占用的租约挡回来时它是"重试"**——它会等。
- **HAPI 的 `session/prompt`** 走同一条 ingress，**被挡回来时它是"失败"**——它不吃。

同一个租约，一边等一边不等。HAPI 等不到，就只能自己猜一个退避节奏，
于是 32 次拒绝、269 秒延迟。

## 租约在哪：agent 自己就在用它

MiniMax Code 给每个 native session 一把**轮次租约**，落在
`~/.minimax/v2/sqlite/runtime-state.sqlite`：

```sql
CREATE TABLE local_runtime_session_locks (
    session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,     -- turn-lease:<pid>:<uuid>.<uuid>
    owner_kind TEXT NOT NULL,    -- 'turn'
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
)
```

这正是 agent 自己判断"这个 session 能不能接一轮"的那把锁——**agent 侧本来就暴露了 busy 状态，
只是不在 ACP 协议面上，而在它自己的运行时索引里**。而这个库 HAPI **已经在读**
（`mcodeSessionDirs.ts` 用它定位会话目录），不引入新的依赖面。

实测（`/tmp/probe-mcode-lease.ts`，250ms 轮询）：

```
--- lease BEFORE any turn ---   null
--- starting a long turn ---    +252ms  LEASE: owner=turn-lease:53303:… kind=turn
                               +8515ms LEASE: null        ← 轮次结束，租约消失
```

**这就是需要的 busy 信号**：精确、无歧义、还带持有者 pid 和持有时长。
读它是一次本地文件读，没有 agent 往返，不写任何东西。

**忙的时候被拒的不止 `session/prompt`**：实测 `session/set_config_option` 在同一时刻也报
`-32602 Invalid params`。HAPI 的模型 / 思考档 / 权限模式切换都在发 prompt 之前，
所以"先切换再发送"会在每次等待时刷出一条"切换失败"。门控因此排在所有 ACP 往返**之前**。

顺带记一条分层：**有两层拒绝，文本不同**——
ACP 层 `A prompt is already active for this session.`（-32602，HAPI 自己并发发 prompt 时），
runtime 层 `Session already has an active Turn. Use queue send …`（-32603，agent 有别的轮次时）。
上一轮的分类器只认后者。

## 这一轮改了什么

| # | 改动 | 位置 |
|---|---|---|
| 1 | 新增 agent 运行时索引的只读句柄（`mcodeSessionDirs` 与新读者共用一个连接） | `cli/src/mcode/utils/mcodeRuntimeIndex.ts`（新） |
| 2 | 新增轮次租约读取器：`free` / `held` / `unknown` 三态 | `cli/src/mcode/utils/mcodeTurnLease.ts`（新） |
| 3 | **发送前先读租约**：租约被占就不发，等到释放才发——这一轮**第一次就被受理**，不再"拒绝 → 重试" | `cli/src/mcode/mcodeRemoteLauncher.ts` |
| 3b | **门控排在所有 ACP 往返之前**：agent 忙的时候 `session/set_config_option` 也被拒（实测 `-32602`），排在后面的话每次等待都会伴随一次"切换模型失败" | 同上 |
| 4 | 拒绝后的重试改为**等租约释放**（退避保留为地板，因为 compaction / mutating 不是租约问题） | 同上 |
| 5 | 忙碌提示按"一次忙碌期一条"发布；`waitingForAgent` 在等租约期间就置位（不再等被拒之后） | 同上 |
| 6 | abort 落在"等租约"窗口里时，**不丢消息**：照旧发出去再在请求后面紧跟一个 cancel | 同上 |
| 7 | abort 之后的拒绝不再额外报一条 "prompt failed"（abort 已经报过了） | 同上 |

**降级是硬要求**：租约表读不到（agent 版本没有这张表、文件被锁、数据目录不对）时状态是
`unknown`，而 `unknown` **永远不拦投递**——行为退回改动前的样子，不会把会话卡死。
`mcodeSessionDirs.ts` 同步改用共享句柄，行为不变。

## 还没做的（明确留着）

- **延迟 ack**：消息在等待期间仍然只活在 CLI 进程内存里（hub 侧早已 ack）。要彻底不丢，
  得把 ack 推迟到"agent 受理轮次"之后（`agy` flavor 已经是这个模型）。这会动投递语义
  （hub 排队浮条、取消、seq 回填），仍是独立立项。
- **native 对齐**、**非 web 客户端的重复拦截**：同上一轮，未动。

---

# 追加：延迟确认——消息在 agent 接手前不再算"已投递"（2026-10-22 晚，第 4 轮）

上一轮把"等 agent"这件事做对了：HAPI 知道 agent 忙，会等租约释放再发。
但还有一个洞：**等待期间那条消息只活在 runner 的内存里**——hub 侧早在消息离开
队列时就被 ack 了。runner 在等待期间挂掉，消息就没了。

## 机制是现成的，mcode 是第二个使用者

| 环节 | 现状 | 位置 |
|---|---|---|
| CLI 侧开关 | `acknowledgeMessagesOnDequeue: false` → 队列出队不再自动 ack | `cli/src/agent/sessionBase.ts:77` |
| 先例 | `agy` flavor 用的就是这套（手动 `emitMessagesConsumed`） | `cli/src/agy/session.ts:58` |
| hub 重放 | 未 ack 的即时消息在 CLI 每次 `session-alive` 时重放给 CLI | `hub/src/sync/messageService.ts:979` |
| CLI 去重 | 按消息 id 的 LRU 去重，重复的重放会被丢掉 | `cli/src/api/apiSession.ts`（`IncomingMessageFilter`） |
| 排队浮条 | 未 ack 的行（`invoked_at IS NULL`）就是浮条里的"排队中"，**不在聊天线程里** | `web/src/lib/messages.ts:21`、`web/src/components/SessionChat.tsx:1425` |
| 取消 | 浮条的取消会问 CLI 要不要丢掉队列里的那条 | `hub/src/sync/messageService.ts:780` |

所以这不是新机制，是把 `agy` 已经证明过的东西搬到 mcode 上。

## 三个设计决定

**1. 等租约的位置前移到"取消息之前"。**
如果等租约在取消息之后，消息就在 launcher 手里了：hub 那边是未 ack（会进浮条、可以取消），
但 CLI 那边不在队列里了，取消按钮按下去没反应——比没有按钮更糟。
把等待放到取消息之前，等待期间那条消息**仍然在 CLI 的队列里**：取消按钮有效，hub 侧也还留着它。

**2. ack 的时点是"交给 agent 的那一刻"**（`session/prompt` 请求写出去时），不是取队列时。
从这一刻起 runner 负责把它送到（被拒了会自己重新入队），hub 可以把它算作已投递。
refusal 那条路仍然是"已 ack + 进程内重入队"，和改动前一致，没有回退。

**3. abort 时要把被丢掉的待发消息 ack 掉。**
abort 会清空队列（`queue.reset()`）。不清的话那些行在 hub 里还是未 ack 状态，
下一个 runner 会拿到它们，把用户刚停掉的消息再投一遍。`MessageQueue2.pendingLocalIds()`
就是为这件事准备的（"Lets a caller reconcile them with the hub before a reset()"）。

## 改了什么

| # | 改动 | 位置 |
|---|---|---|
| 1 | mcode 会话改为延迟确认 | `cli/src/mcode/session.ts` |
| 2 | 等租约前移到取消息之前；等待期间消息留在队列里 | `cli/src/mcode/mcodeRemoteLauncher.ts` |
| 3 | prompt 写出时 ack 这一批消息 | 同上 |
| 4 | abort 时 ack 被清空的待发消息 | 同上 |

**投递契约的变化（就是上一轮说的"hub 排队浮条、取消、seq 回填"）**：
一条还在等 agent 的 mcode 消息，现在会出现在 web 的排队浮条里（可取消、可编辑），
而不是直接躺在聊天线程里被当成"已投递"。agent 接手的那一刻它才进线程。
这是 hub 早就支持的状态，不是新状态。

## 还没做的 / 已知边界

- **graceful 退出仍会丢**：runner 正常退出时 hub 会把没 ack 的行一次 stamp 掉
  （`sweepImmediateQueuedOnSessionEnd`），这是 hub 早就有的行为，agy 也一样。
  这次保护的是"runner 挂掉"。
- **local flavor 的 abort**：`BaseLocalLauncher.doAbort` 也会 `queue.reset()`，
  但那里没有 ack 掉待发消息。local 模式收到消息会立刻切到 remote，所以窗口极小。
- **refusal 之后仍是进程内重入队**：被拒的消息已经 ack 了，runner 挂掉仍会丢。
  这条路现在很少走到（租约门控挡住了大部分），但没有根治。
- **native 端**：`queue-notice` 与排队浮条都还没有 native 的原生呈现。

---

# 追加：收紧 shared 契约（B5 / B6 / B9 / B10，第 5 轮）

这一轮按上面「建议的动手顺序」的第 3、4 项做：**shared 契约收紧**。
改动不碰投递语义，只碰「客户端问什么、hub 答什么、CLI 怎么翻译」这一层。

## 一句话说清这轮改了什么

**同一个词，现在只有一处说了算。** 目标状态的可设置集合、HAPI 拼写到 agent 拼写的映射、
steering 白名单，都从「各自写一份」改成「一处定义、其余引用」。

## 改了什么

| # | 改动 | 位置 |
|---|---|---|
| 1 | patch 请求的 status 枚举收窄到可设置的那 5 个（去掉 `usageLimited`） | `shared/src/apiTypes.ts` |
| 2 | patch 请求加 `.refine()`：至少要有一个字段，空 patch 直接 400 | 同上 |
| 3 | 可设置状态集合 + HAPI→agent 映射收进协议包，用 `satisfies` 保证两者同步 | `shared/src/mcodeGoalStatus.ts` |
| 4 | CLI 删掉自己那份映射与状态表，改用协议包的 | `cli/src/mcode/utils/mcodeExtensions.ts` |
| 5 | `ThreadGoalStatusSchema` 作为**值**导出（之前只导出了类型） | `shared/src/index.ts` |
| 6 | web 的目标状态内联列表换成协议包的 schema | `web/src/chat/normalizeAgent.ts` |
| 7 | steering 的 session 闸门从 `STEERING_SUPPORTED_FLAVORS` 派生 | `shared/src/modes.ts` |

## 三处「收紧」的语义

**① `usageLimited` 不再是可设置状态。**
它是 agent 从自己的用量计数（provider 配额 / 限流）派生出来的状态，客户端不该伪造。
现在 REST 直接回 **400**（`Invalid goal update`），而不是像以前那样回 **200 + `{success:false}`**。
把目标**移出**该状态（`active`）不受影响。

> **口径更正**：复审原文说「agent 拒绝这个值」。回查 agent 源码后确认不是 ——
> agent 的 patch 归一化 `HRe` 用 `iKt = new Set([... , "usage_limited"])` 校验，**它是接受的**。
> 挡它的是 HAPI 自己的 CLI 映射表。所以这条是 **HAPI 的契约决定**，不是 agent 的拒绝。
> 详见上面 B5 的更正。

**② 空 patch 现在是 400。**
以前 schema 放行、CLI 晚一步拒（200 + `{success:false}`）。agent 自己也是 400
（`PATCH body must include status, objective, or token_budget.`），现在契约与它对齐。

**③ `tokenBudget: null` 的语义写进了 schema 注释。**
create 时 `null` = 不限额，patch 时 `null` = 清空额度 —— 两边终点相同。
**这一条没有改代码**：原文说「create 丢 `null`、patch 透传 `null`，语义不一致」是**误报**，
agent 的归一化让两者等价。详见上面 B7 的更正。

## 「一处说了算」现在长什么样

```
shared/src/mcodeGoalStatus.ts
  MCODE_GOAL_STATUS_MAP          agent 拼写 → HAPI 拼写（报告方向）
  MCODE_GOAL_PATCHABLE_STATUSES  客户端可设置的状态（HAPI 拼写）  ← REST schema 用它
  HAPI_TO_MCODE_GOAL_STATUS      HAPI 拼写 → agent 拼写（设置方向）  ← CLI 用它
```

- REST schema 的枚举 = `MCODE_GOAL_PATCHABLE_STATUSES`（不再是手写的第二份）。
- `HAPI_TO_MCODE_GOAL_STATUS` 用 `satisfies Record<McodeGoalPatchableStatus, McodeGoalStatus>`
  标注 —— **少一个映射就是编译错误**，集合与映射不可能再各写各的。
- web 的目标状态判定 = 协议包导出的 `ThreadGoalStatusSchema`（之前是内联的 6 个字符串）。
- steering：`isSteeringSupportedForSession()` 从 `STEERING_SUPPORTED_FLAVORS` 派生，
  `cursor` 的 legacy 特判（stream-json 不能 steer）原样保留。

## 顺带删掉的一处重复

复审 B9 列了 5 份状态表，**漏了 CLI 那份**：`cli/src/mcode/utils/mcodeExtensions.ts` 里
还有一张 `MCODE_GOAL_PATCH_STATUSES` + 一张 `HAPI_TO_MCODE_GOAL_STATUS`。
现在这两张删了，CLI 直接用协议包的。对应的两个测试用例也搬到了
`shared/src/mcodeGoalStatus.test.ts`（跟着函数走，而不是留在原地）。

## 验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck`（cli/web/hub/relay） | ✅ 全绿 |
| `bun test`（shared） | ✅ 360 pass / 0 fail（新增 7 例） |
| `bun run test`（hub） | ✅ 1408 pass / 0 fail |
| `bun run test --run src/mcode`（cli） | ✅ 15 files / 267 pass / 0 fail（2 个用例搬到 shared） |
| `bun run test --run`（web） | ✅ 312 files / 3451 pass / 0 fail |
| agent 源码回查 | ✅ `GRe` / `HRe` / `cKt` / `iKt` 逐条核对（B5、B7 的证据） |

## 这轮没做的（明确留着）

- **B8**（REST 目标响应仍是 snake_case，事件路径是 camelCase）—— 要改的是 hub 的**响应形状**，
  native / 第三方客户端会跟着变，属于换契约那一半，单独做。
- **B11**（清空目标事件不带 threadId，web 无脑全删）—— 要同时动 CLI 的三个发送点和 web 的 reducer。
- **B1 / B2 / B3 / B4**（用户直接可见的那批）—— 没动，仍按原顺序排在前面。
- **P2 整表**（B12–B21）—— 没动。
- **B14**（预算框允许小数）—— 本轮的 `.refine()` 只挡空 patch；小数仍由 schema 的 `.int()` 挡，
  但 **web 那边仍然允许输入小数**，报错文案还是「A goal needs an objective」，等 B3 一起改。
