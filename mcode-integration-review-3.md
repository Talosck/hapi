# mcode ↔ HAPI 四次复审（2026-10-22）

> 前两篇：`mcode-integration-review.md`（首轮 + 实施审计）、`mcode-integration-review-2.md`（二次复审）。
> 本文只写**前两篇没覆盖、且到今天还没修**的部分，全部结论都回查到当前源码行号。
>
> 方法：读当前代码 + 直接探测本机运行中的 agent（`@minimax-ai/code` 0.5.9，PID 361089）与它自己的
> `~/.minimax/v2/sqlite/runtime-state.sqlite`；拒绝分类表从 agent 产物 `chunks/chunk-QEPCDCRA.js`
> 里反查出来。`cli/src/mcode` 全量测试 **267 passed** —— 说明下面几条是**设计缺口**，不是回归。
> 子代理结论一律由我复核后才写入。
>
> **本文同时是实施记录**：第一轮（Web 端 17 项）、第二轮（A1/A2）、第三轮（A3）、
> 第四轮（A4/A4-b，投递链路最后一段）都已做完并全量验证，记录在文末。

---

## 一句话结论

**投递链路的"最后一公里"仍有三个洞，都属于"消息会在用户看不见的地方消失"这一类**：

1. agent 的拒绝种类有 14 种，HAPI 只认 3 种 —— 剩下 11 种会被当成"真失败"，消息**已 ack 但被丢弃**；
2. 轮次租约只读不判断过期、也不判断属主进程是否还活着 —— agent 崩了以后**永远解不开锁**；
3. ACP 传输层没有"agent 已死"的信号，也没有复活路径 —— 一个 session 只能靠用户手工重建。

下面按优先级给证据链。

---

## P0 — 会丢消息 / 会永久卡死

### A1. agent 拒绝种类有 14 种，HAPI 只认 3 种，其余的消息**已经 ack 却被丢掉**

**证据链**

| 环节 | 位置 | 事实 |
|---|---|---|
| HAPI 分类器 | `cli/src/mcode/mcodeRemoteLauncher.ts:106-117` | `classifyMcodeRefusal()` 只匹配 3 段英文：`session already has an active turn` / `session compaction is active` / `session conversation is being changed` |
| agent 拒绝表 | agent 产物 `chunks/chunk-QEPCDCRA.js`（`Ubn` / `_In` / `yIn` / `NI`） | 409 家族共 14 个 key：`local_session_busy`、`local_session_has_queued_messages`、`local_session_queue_paused`、`local_turn_ingress_conflict`、`local_turn_duplicate`、`local_session_deleting`、`local_session_compacting`、`local_session_mutating`、`local_turn_continuation_unavailable`、`local_turn_waiting_for_user`、`local_plan_lifecycle_active`、`local_plan_questionnaire_active`、`local_plan_entry_disabled`、`local_plan_mode_conflict` |
| ack 时机 | `cli/src/mcode/mcodeRemoteLauncher.ts:561` → `cli/src/agent/backends/acp/AcpSdkBackend.ts:848` | `onPromptSent` 在**请求写出**时就触发（不是拿到响应时），`acknowledgeBatch()` 立刻把 localIds 交给 hub 标记为已投递 |
| 失败分支 | `cli/src/mcode/mcodeRemoteLauncher.ts:571-605` | 只有 `refusal !== null` 才 `requeueRefusedBatch()`；否则只发一条 `MiniMax Code prompt failed: …` 事件，**批次不回队** |

**症状**：命中未识别的拒绝（例如 agent 自己队列里还有消息 → `local_session_has_queued_messages`；准入竞争 → `local_turn_ingress_conflict`；重试命中已受理的轮次 → `local_turn_duplicate`）时，用户的消息在 web 里显示为"已投递"，hub 也认为已消费，但 agent 从未收到它 —— 消息凭空消失，只留下一行英文报错。

现有测试把这个行为当成设计意图固化了：`cli/src/mcode/mcodeRemoteLauncher.test.ts:1644-1650`
（"A real failure is reported as it was - only the busy refusal is treated as 'try again later'"）。
问题在于：agent 那 14 种里**大部分不是真失败，而是"现在不行，等一下"**。

**修法（两段）**

1. 把拒绝分类改成**表驱动**：agent 侧 14 个 key 映射到 HAPI 的 `busy` / `compacting` / `mutating` / `queued` / `duplicate` / `terminal` 六个语义，只有 `terminal`（`local_session_not_found`、`local_turn_invalid_input`、model-invalid）才允许丢消息，其余一律回队重试。
2. **默认不回队改成默认回队**：无法识别的错误先按"稍后重试"处理（有上限），而不是先丢。真失败可以由 `terminal` 白名单显式列出。

**注意**：现在只能靠英文文案匹配，是因为 agent 的 ACP 层把 `AppError` 的稳定字段丢掉了 ——
agent 产物里 `var V=class extends Error{status;key;retryable;…}`（`chunk-QEPCDCRA.js`）带 `key`/`status`/`retryable`，
但 ACP 错误出口只回 `internalError({details: <英文文案>})`（`run-acp-command-SBE5PYAH.js`）。
HAPI 自己也丢了 `error.code` / `error.data`：`cli/src/agent/backends/acp/AcpStdioTransport.ts:563` 只 `new Error(acpErrorMessage(...))`。

> **建议**：在 transport 层把原始 payload 挂到 Error 上（`error.data` / `error.code`），
> 并推动 agent 在 `data` 里带上 `code`（如 `local_session_busy`）。分类优先用机器码，文案只做兜底 ——
> 现在整个集成"离 agent 改一句话就再炸一次"只差一步。

---

### A2. 轮次租约只判断"行在不在"，不判断"过期了没"和"属主还活着没" —— agent 崩了以后锁永远解不开

**证据链**

| 环节 | 位置 | 事实 |
|---|---|---|
| HAPI 读租约 | `cli/src/mcode/utils/mcodeTurnLease.ts:74-88` | 读到行就返回 `{status:'held'}`；`expiresAtMs` 读出来了（`:79`）**但从没和 `Date.now()` 比较过** |
| 租约行结构 | 本机 `runtime-state.sqlite` 的 `local_runtime_session_locks` | `session_id / owner_id / owner_kind / acquired_at_ms / expires_at_ms` |
| 属主 id | 同上（实测本会话三行） | `owner_id = "turn-lease:<pid>:<uuid>.<uuid>"`，`owner_kind='turn'` |
| 属主是谁 | `/proc/361089/cmdline` | `minimax-code` —— 就是本会话的 agent 进程 |
| 租约时长 | 实测 `expires_at_ms - acquired_at_ms` | ≈ **32–33 分钟**（会随持有者续租） |
| agent 自己的回收逻辑 | agent 产物 `chunk-QEPCDCRA.js`（`isLeaseOwnerAlive` → `isProcessAlive(r.pid)`） | agent 判断锁属主是否还活着，靠的是 **pid 存活**，不是行是否存在 |
| HAPI 等待点 | `cli/src/mcode/mcodeRemoteLauncher.ts:808-840`（`waitForAgentTurn`） | 轮询到 `held` 就一直等，**没有超时、没有属主存活检查** |

**症状**：agent 在轮次中途被 kill（OOM / 用户关了它自己的 TUI / 机器休眠）：

- 锁行留在 sqlite 里没人删（HAPI 只读不写）；
- HAPI 的门禁永远读到 `held` → `waitForAgentTurn` 无限等待 → **用户的消息永远不投递**；
- 由于 HAPI 不看 `expires_at_ms`，连"33 分钟后自动过期"这条退路都没有。

**修法**

1. `expiresAtMs <= Date.now()` → 视为 `free`（一行判断）；
2. 从 `owner_id` 解析出 pid，`process.kill(pid, 0)` 判存活 → 属主已死就**主动报"agent 进程没了"并触发重启**（和 agent 自己的 `isProcessAlive` 语义对齐）；
3. 两层都判完仍为 `held`，才继续等。

---

## P1 — 恢复能力与契约

### A3. ACP 传输层没有"agent 已死"的信号，mcode 也没有用现成的复活循环

| 环节 | 位置 | 事实 |
|---|---|---|
| transport 关闭 | `cli/src/agent/backends/acp/AcpStdioTransport.ts:295-296, 413, 571-590` | 进程退出后 `closed=true`，后续 `sendRequest` 直接抛 `ACP transport is closed` |
| backend 无感知 | `cli/src/agent/backends/acp/AcpSdkBackend.ts` | 对外**没有** "closed / dead" 状态位，launcher 无法区分"agent 死了"和"这次调用失败了" |
| mcode 不复活 | `cli/src/mcode/mcodeRemoteLauncher.ts` | 直接 `start()`，**没用** `RemoteLauncherBase.runRespawnLoop`（`cli/src/modules/common/remote/RemoteLauncherBase.ts:66`，PTY 系 flavor 用它） |
| 死后的表现 | 同上 | 之后每条消息都失败成 `MiniMax Code prompt failed: ACP transport is closed`，session 不再恢复，只能手工重建 |

**修法**：给 ACP backend 暴露 `isClosed()/onClose()`；mcode 走 respawn 循环（重起 agent + `session/load` 原 native session id），
或至少在 transport 关闭时**带着明确原因结束 session**，别让用户对着一个"活着但什么都做不了"的 session。

### A4. prompt 路径没有 steer 路径那套"结果不可判定"处理

| 环节 | 位置 | 事实 |
|---|---|---|
| transport 会标记不可判定 | `cli/src/agent/backends/acp/AcpStdioTransport.ts:594-601` | 进程死亡时未决请求按 `markAcpIndeterminate` 处理 |
| steer 路径处理了 | `cli/src/mcode/mcodeRemoteLauncher.ts:1200, 1225-1237` | `markReservationIndeterminate()` + `emitSteerIndeterminate()` |
| prompt 路径没处理 | `cli/src/mcode/mcodeRemoteLauncher.ts:571-605` | agent 在轮次中途死掉 → 报成 `prompt failed` 并丢消息，尽管 agent 可能已经消费了它 |

**修法**：prompt 路径对齐 steer 路径：标 indeterminate、不进 ack 集合、对用户说"结果未知"而不是"失败"。

### A5. 原生端（iOS/Android）几乎看不到 mcode：三类静默事件 + 两类能力位 + 一整块 REST 契约缺失

> 以下五条由子代理产出，我逐条回查过源码，均为**已核实**。

| # | 问题 | 证据 |
|---|---|---|
| C1 | **原生端"发送并插入当前轮次"是静默空操作**。hub 只对 pi 认 `deliveryMode:'steer'`，其余一律降级成 `queue`；但 iOS/Android 仍在发 steer，且闸门只看 `thinking && active`，与 flavor 无关 → 对 mcode（含 Claude/Gemini）都是"排队到轮次结束才送达"，且**不报错**。web 已经改成只对排队行 steer（`web/src/lib/messageDelivery.ts:31-33`） | `hub/src/sync/messageService.ts:118-128`；`ios/Packages/HapiKit/Sources/HapiKit/…/ChatInteractor.swift:183,232`；`android/…/ChatViewModel.kt:498,958` |
| C2 | **`subagent-snapshot` 泄漏进原生聊天记录**（web 过滤了）。mcode 每次委派快照都会在原生端渲染成一条原始 agent 事件 | web 过滤：`web/src/chat/reducer.ts:100`；原生未过滤：`ios/Packages/HapiKit/Sources/HapiProtocol/Chat/Reducer.swift:36-58`、`android/core/protocol/src/main/kotlin/app/hapi/protocol/chat/Reducer.kt:51-71` |
| C3 | **`agentState.steeringActive` 与 `metadata.capabilities.mcodeExtensions` 在原生端和契约里都不存在** → 原生端既不知道何时能 steer，也不知道这个会话支不支持 goal/delegation | shared 有：`shared/src/schemas.ts:248`、`:67`；原生 grep `steeringActive` / `mcodeExtensions` **零命中**；`docs/api/client-contract/**` 同样零命中 |
| C4 | **mcode 的 goal / delegation / apps 这整块 REST 契约没写进 client contract**（只有 `/mcode-models` 被记了）。原生端是照契约实现的 → 这块 UI 做不出来 | 路由在 `hub/src/web/routes/sessions.ts:1549,1574,1601,1624,1642`；`docs/api/client-contract/rest.md` 里 grep "goal" **零命中** |
| C5 | **mcode 权限模式在本地 TUI 拥有会话时必然 409**，但契约没写、原生端也没闸门 → 用户在原生端选权限模式会报错再弹回 | `hub/src/web/routes/sessions.ts:608-613`；契约 `docs/api/client-contract/rest.md:104` 未提；web 只对 mcode 的模型切换做了 `!controlledByUser` 闸门（`web/src/components/SessionChat.tsx:2291-2299`），权限模式没有 |

### A5-b. web 丢掉 delegation stop 回执 → 部分停掉被显示成"完全成功"

- 回执类型本来就是为了这个：`cli/src/mcode/utils/mcodeExtensions.ts:402-408` 写明"the web shows that split so a failed stop is not mistaken for a successful one"，
  载荷带 `stoppedSessionIds` / `activeSessionIds` / `failedSessionIds`（`shared/src/apiTypes.ts:930-937`）。
- 但 web 只看 `result.success`，`result.receipt` 整个丢掉：`web/src/components/SessionStatusPanel.tsx:291-305`；
  `web/src/types/api.ts:42` 甚至把 `McodeDelegationStopReceipt` 又导出了一次，全项目**没有组件引用它**。

**症状**：agent 停了 5 个子代理里的 2 个、另外 3 个还活着 → 面板显示干净的"成功"，没有列表，用户以为全停了，子代理继续跑，
而面板要等 agent 重新广播树才会刷新。

**修法**：把 `receipt.failedSessionIds` / `receipt.activeSessionIds` 渲染成"停掉 N / 还剩 M 个在跑"，非空即视为部分失败。

---

## P2 — 体验 / 效率

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| A6 | **轮次租约门禁在"用户根本没发消息"时也在轮询**：门禁排在取消息之前（`mcodeRemoteLauncher.ts:430` vs `:434`），agent 忙的整段时间里每 400ms 读一次 sqlite（≈2.5 次/秒） | `cli/src/mcode/mcodeRemoteLauncher.ts:808-840` | 只在队列非空时才轮询；间隔退避 400ms → 1.6s |
| A7 | **`steeringActive` 在 agent 受理轮次之前就置真**：置位在 `:529`，真正发起 prompt 在 `:541` → 这个窗口里点 Steer 必然被 agent 拒（"Steering requires an admitted, active ACP prompt Turn"），消息弹回队列 | `cli/src/mcode/mcodeRemoteLauncher.ts:529` vs `:541`；`:1225-1237` 的错误分支 | 改成 agent 首个 turn update / prompt 被受理时再置位 |
| A8 | **Steer 能力位仍然没有**（旧 B1 未修）：CLI 只投影 6 个能力位，没有 steer；web 的闸门只看 flavor → 不广播 steer 的构建上 Steer 是死按钮 | `cli/src/mcode/utils/mcodeExtensions.ts:93-108`；`shared/src/schemas.ts:46-59` | 加 `steer` 位（shared + CLI 投影 + web 闸门三处同改） |
| A9 | **原生端没有任何 mcode 模型/effort/apps 目录**，也**没有一条覆盖 mcode 事件的 fixture** → 上面 C2 那类问题没有回归网 | `shared/src/flavors.ts:17` 给 mcode 开了 `ModelChange`+`Effort`；`shared/fixtures/chat/` 只有 codex goal 用例 | 加 mcode 用例族并 `bun run gen:fixtures` |
| D1 | **goal 创建失败会把用户刚打的 objective 和预算一起清空**：表单先 `await run(...)`（`run` 吞掉错误、只 setError），然后**无条件**清空并收起表单 | `web/src/components/SessionStatusPanel.tsx:89-123` | 让 `run` 返回成功与否，只在成功时清空/收起；失败保留草稿 |
| D2 | **hub 把 goal 创建的每一次校验失败都说成"A goal needs an objective"**：Zod 的 issue 被丢掉，`tokenBudget: 1.5`（`z.number().int()`）也说目标缺失 → 用户改错字段；PATCH 同样（"Invalid goal update"，把 schema 自己写的"A goal update needs at least one field"盖掉了） | `hub/src/web/routes/sessions.ts:1583-1586`、`:1610-1613`；`shared/src/apiTypes.ts:965,1022-1025` | 用 `parsed.error.issues` 生成文案，区分"缺目标"和"预算非法" |
| D3 | **`/sessions/:id/mcode-models` 返回的是"探测会话"的模型，不是这个 session 的模型**，而且每次失败都重新 spawn 一个 `mcode acp` 进程 | handler：`cli/src/modules/common/handlers/mcodeModels.ts:33-46` → `listMcodeModelsForCwd(getCwd())` → `runMcodeProbe`（`cli/src/modules/common/mcodeModels.ts:221-294`）；只缓存成功结果（`:337-345`）；路由：`hub/src/web/routes/sessions.ts:1549-1565` | 用 `session/new` 响应里已有的 config options 发布实时目录；失败结果按短 TTL 负缓存 |
| D4 | **hub 把可 steer 的 flavor 列表硬编码进用户可见的报错文案**（与 `shared/src/modes.ts:220` 重复一份） | `hub/src/sync/syncEngine.ts:1109` | 从 shared 常量派生文案 |
| D5 | **goal 时间戳在 shared 里没有单位约定，两条路径单位还不同**：事件路径 ms→s（`mcodeExtensions.ts:381-392`），REST 路径保留 agent 的 ms（`mcodeExtensionControl.ts:228-232` → `parseMcodeGoalState`）→ 同名字段两种单位 | `shared/src/apiTypes.ts:913-927`、`shared/src/schemas.ts:332-341` | 两个类型都写明单位，REST 侧统一成秒（与旧 B2/B8 一起收） |

---

## P3 — 清理

- `web/src/api/client.ts:1030-1038`：goal patch 的 `status` 类型写成裸 `string`，绕过了 `McodeGoalPatchRequestSchema['status']`（`shared/src/apiTypes.ts:1013-1025`）。
- 没有共享的 session-event union：事件词表在三处各写一份（`cli/src/api/apiSession.ts` / `web/src/chat/types.ts` / 原生 port），已经漂移（`permission-mode-changed` 只在 `web/src/chat/presentation.ts:234` 出现，web 的 union 里没有）。
- `McodeGoalResponse` / `McodeAppsResponse` 是纯 TS 类型、没有 Zod schema → hub 把 CLI 的负载原样转发，不做校验。

---

## 前两篇遗留、至今未修的条目（状态复核）

| 编号 | 问题 | 现状 |
|---|---|---|
| B1 | steer 能力位缺失 | **未修**（见 A8） |
| B2 | goal 卡片时间戳单位（毫秒 vs 秒） | **未修**：`web/src/components/ToolCard/goalTools.ts:49` 直接把 `created_at` 拷进 `createdAt` |
| B3 | 面板把原始 HTTP 响应体当错误文案 | **未修**：无 `apiErrorMessage` 之类的 helper |
| B4 | 切模型失败静默 | **未修** |
| B8 | REST goal 响应 snake_case vs 事件 camelCase | **未修** |
| B11 | `thread-goal-cleared` 不带 threadId，web 无条件丢 goal | **未修**：`cli/src/mcode/mcodeRemoteLauncher.ts:918,1312,1638` |
| B12–B21 | 连接器/app 状态、模型目录刷新、goal 表单、消息窗口派生目标树等 | **未修** |
| B23/B26/B27 | `displayedLocalIds` 无上限、modelId 含 `#` 不可逆、真实时钟测试 | **未修** |

---

## 已核实为误报（记下来免得再查一遍）

- **"apps 探测只在机器 daemon 上有，session 侧没有兜底"** —— 不成立。`registerCommonHandlers`（内含 `registerMcodeAppHandlers`，
  `cli/src/modules/common/registerCommonHandlers.ts:35`）在 **machine 与 session 两侧都注册**（`cli/src/api/apiMachine.ts:131`、
  `cli/src/api/apiSession.ts:320`）；而且 runner 自己就建了机器 scope 的 socket（`cli/src/runner/run.ts:1672-1682`），
  `setRPCHandlers` 只是**追加** handler（`cli/src/api/apiMachine.ts:405-406`），不会覆盖掉。
  只要 runner 在跑，机器 scope 就在，hub 的 `/api/machines/:id/mcode-apps` 不会因为"没有机器 daemon"而 500。

---

## 本轮实施记录（Web 端，2026-10-22）

按"先把 Web 端全部解决"的要求做完。**iOS / Android 与 client-contract 的原生部分按要求未动**。

### 已修（Web 可见）

| 编号 | 修法 | 位置 |
|---|---|---|
| A8 | 新增 `steer` 能力位：shared schema → CLI 投影 → CLI 只在 agent 广播了 `mcode/session/steer` 时才置 `steeringActive` → web 闸门读能力位（**旧 CLI 说不了话时保持原行为**，只有明确 `false` 才关掉） | `shared/src/schemas.ts`、`cli/src/mcode/utils/mcodeExtensions.ts`、`cli/src/mcode/mcodeRemoteLauncher.ts`、`web/src/components/SessionChat.tsx` |
| A5-b | 停子代理的**回执不再被丢掉**：面板渲染"停掉 N / 还有 M 个在跑 / K 个没停掉" | `web/src/components/SessionStatusPanel.tsx` |
| B2 | goal 工具结果里的时间戳按**毫秒→秒**归一（agent 的库列名就是 `created_at_ms`） | `web/src/components/ToolCard/goalTools.ts` |
| B3 | 新增 `apiErrorMessage()`：面板不再显示 `HTTP 400 Bad Request: {"success":false,...}`；**连不是 JSON 答案的响应体（代理的 HTML 错误页）也不显示**，一律回退到调用方自己的话 | `web/src/api/client.ts`、`web/src/components/SessionStatusPanel.tsx` |
| B4 | 切模型失败弹 toast（原来只 `console.error`） | `web/src/components/SessionChat.tsx` |
| B11 | 清空目标事件**带 threadId**（CLI 三个发送点统一走一个 helper），web 按 threadId 精确删除，别删别线程的目标 | `cli/src/mcode/mcodeRemoteLauncher.ts`、`web/src/chat/reducer.ts` |
| B12 | 连接器的**登录状态**现在会渲染（未登录/已过期分别标色） | `web/src/components/SessionStatusPanel.tsx` |
| B13 | apps 探针失败时**状态面板不再整个消失**（面板正是报告失败的地方） | `web/src/components/SessionChat.tsx` |
| B14 | 预算框只收整数；表单关掉浏览器原生校验，改用**可本地化的**自己的校验 | `web/src/components/SessionStatusPanel.tsx` |
| B15 | mcode 模型目录加上**开限的发现轮询**（1s，最多 10 次），对齐 opencode 的做法 | `web/src/hooks/queries/useMcodeModelsForSession.ts` |
| B16 | 模型在 HAPI 之外被改时，**重新读一次目录/effort**（`modelOptionsInvalidationKey` 现在也管 mcode） | `web/src/components/SessionChat.tsx` |
| B17 | apps 列表**窗口聚焦时刷新** + 与机器端缓存同频的 5 分钟轮询 | `web/src/hooks/queries/useMcodeApps.ts` |
| B18 | 委派树改从**完整消息列表**读（分页翻历史不再丢），goal 本来就走的完整列表 | `web/src/chat/sessionStatus.ts`、`web/src/components/SessionChat.tsx` |
| B19 | 会话结束就**停掉 1 秒计时器**（结束的子代理不再一直涨耗时） | `web/src/components/SessionStatusPanel.tsx` |
| B20 | 三处硬编码英文 `Default` 全部本地化（会话页 mcode/grok、新建会话页、输入框 effort） | `web/src/components/SessionChat.tsx`、`web/src/components/NewSession/*`、`web/src/components/AssistantChat/HappyComposer.tsx` |
| B21 | 目标表单改成真正的 `<form>`，错误带 `role="alert"` | `web/src/components/SessionStatusPanel.tsx` |
| D1 | **目标创建失败不再清空用户写的 objective** | `web/src/components/SessionStatusPanel.tsx` |
| D2 | hub 不再把所有校验失败都说成"A goal needs an objective"，改为**指出失败的字段** | `hub/src/web/routes/sessions.ts` |

### 顺带修掉的两个真问题

- **steer 的拒绝顺序**：先问 agent 支不支持 steer，再问有没有在跑的轮次 —— 不支持 steer 的构建上，用户看到的是准确的原因。
- **一个本来就脆的测试**：`restores the probe handlers…` 用的是全文件共享计数器，前一个测试的 launcher 异步收尾就会把它撞成 2。改成**增量断言**（这次 launcher 有没有恢复过），不再依赖全局计数的绝对值。

### 复核为误报（没改）

- **D3「session 模型路由返回探测会话的模型」**：不成立。mcode launcher 自己就用活会话回答 `ListMcodeModels`（`mcodeRemoteLauncher.ts:1031-1051`，读 `getSessionModelsMetadata` + `getThoughtLevelConfigOption`），且它注册在通用探测 handler **之后**，同一个 scope 里覆盖掉它。只有"agent 还没连上"的那段时间才会落到探测答案。

### 验证

- `bun run typecheck`（cli / web / hub / relay）：全过。
- `bun run test:cli`：3314 passed / 11 skipped / 0 fail。
- `bun run test:hub`：1409 passed / 3 skipped / 0 fail。
- `bun run test:shared`：360 passed / 0 fail。
- `bun run test:web`：**3469 passed / 0 fail**（312 个文件）。新增 14 条回归用例：目标时间戳单位、按 threadId 清理目标、apiErrorMessage（含"非 JSON 响应体一律不显示"）、steer 能力位、hub 校验文案、面板的登录状态 / 部分停止 / 保留草稿 / 整数预算 / 表单提交。
- `bun run build:web`：生产构建通过（Vite + PWA precache 157 项）。

---

## 第二轮实施记录（投递链路，2026-10-22）

Web 端那一轮之后，接着把投递链路上���两条根因做了。

### A1 —— agent 的拒绝有 14 种，HAPI 只认 3 种

**改法**

1. **表驱动的分类**（`cli/src/mcode/mcodeRemoteLauncher.ts`）：把 agent 自己的全部拒绝文案收进一张表
   （`MCODE_REFUSAL_PATTERNS`），分成两类：
   - **"稍后"**（可重试，消息保留）：busy / compacting / mutating / queued / paused / conflict / waiting / unavailable / plan / duplicate；
   - **"永远不会"**（fatal，消息丢弃并报错）：session not found / session is being deleted / turn input is invalid / queue message is invalid。
2. **未识别的拒绝也不再丢消息**：以前"不认识 = 真失败 = 丢"，现在"不认识 = agent 还没准备好 = 保留并重试"。
   为此需要分清"agent 拒绝"和"传输层坏了"——见下面第 3 条。
3. **transport 保留 agent 自己的答复**：ACP transport 以前只把 `error.message` 交给上层，
   JSON-RPC 的 `code` / `data` 全部丢掉，于是上层无法判断"这是 agent 的拒绝"还是"管道断了"。
   现在把 `code` 和 `data` 挂在 Error 上（`cli/src/agent/backends/acp/AcpStdioTransport.ts`）：
   - 带 code 的错误 = agent 的答复 → 按文案分类，未知也算拒绝 → 保留消息；
   - 不带 code 的错误 = 传输层/代码问题 → 真失败 → 报错并丢弃（不会无限重试）。
4. **退避沿用已有的机制**：连续拒绝按 1s → 2s → 4s → … → 60s 退避，不会变成热循环；
   队列提示（queue-notice）的 reason 扩到 11 种，web 的类型同步跟上。

**验证**：4 条新回归用例（paused 保留消息 / 未知文案保留消息 / fatal 丢弃且不重试 / 传输层错误照旧报失败）。

### A2 —— 轮次租约不看过期、不看属主是否还活着

**改法**（`cli/src/mcode/utils/mcodeTurnLease.ts`）

- 读出来的 `expires_at_ms` **第一次被真正使用**：过期即视为空闲（agent 自己也按这个时间回收）。
- 从 `owner_id`（`turn-lease:<pid>:…`）解析出 **agent 进程的 pid**，`process.kill(pid, 0)` 判存活：
  属主进程已经不在了 → 锁是遗留物 → 视为空闲。
  agent 自己的判断也是 `isProcessAlive(pid)`，两边语义一致。
- 结果：agent 中途被杀之后，消息不再**永远**等下去；最坏情况是多发一次被拒绝的请求，
  而那也已经被 A1 的"拒绝即保留"兜住了。

**验证**：6 条新回归用例（过期 → 空闲 / 属主已死 → 空闲 / pid 解析 / 存活判定 / 原有语义不变）。

### 这一轮的验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck`（cli / web / hub / relay） | 全过 |
| `bun run test:cli` | **3325 passed / 11 skipped / 0 fail** |
| `bun run test:web` | **3470 passed / 0 fail** |
| `bun run test:hub` | **1409 passed / 3 skipped / 0 fail**（有一次偶发失败，随后连跑 4 次均通过；与本轮改动无关——hub 这边只动了目标校验文案） |
| `bun run test:shared` | **360 passed / 0 fail** |

### 还留在桌上的

- ~~**ack 的时机**~~：这一条在**第四轮**处理掉了（见下面）——
  ack 本来就落在"请求写上线路"（不是出队），第四轮补的是"被拒绝之后怎么算"：
  可重试的拒绝 → 退回 hub 的持久队列；轮次中途死掉 → 标 indeterminate，交给用户决定。
  只剩 ack 与 release 之间那条窄窗口（agent 回答拒绝要多久，就暴露多久）。
- **B8**：REST 的目标响应仍是 snake_case、事件路径是 camelCase。web 现在两边都不读那个响应，
  所以 Web 端没有症状；原生端要用的时候得先统一。

---

## 第三轮实施记录（agent 死了怎么办，2026-10-22）

### A3 —— agent 进程死了之后，session 自己回来

**改法**

1. **transport 报告 agent 走了，backend 自己记住**
   （`AcpStdioTransport.ts` 加 `isClosed()` 与 `onClose()` 通知，`AcpSdkBackend.ts` 记下这个状态并对外提供 `isClosed()`）。
   之所以让 backend 自己记一份而不是每次去问 transport：transport 是可以替换的实现，
   而"agent 还在吗"是每个调用方都要问的问题。
2. **把连接阶段抽成一个方法**（`connectAgent()`）：起 agent、initialize、解析扩展能力、
   注册监听、创建/加载 ACP session、应用权限模式与模型、注册 RPC handler、恢复 goal/委派状态。
   抽出来是为了**能再跑一遍**。
3. **重启**：agent 进程死了 → 消息**回到队列**（不丢）→ 重新起一个 agent → 用原生 session id
   `session/load` 把对话接回来（对话存在 agent 自己的 session store 里，新进程接得上）→
   重新应用权限模式/模型 → 恢复 goal 与委派树 → 发一条 `ready`。
   连续重启超过 3 次就结束这个 session 并说清楚原因（不转成重启循环）。
4. **顺手修掉一个 ack 的语义漏洞**：传输层已关闭时，`session/prompt` 根本没发出去，
   但 `onPromptSent` 仍然触发了 → hub 被告知"消息已交付"，而 agent 从没收到。
   现在 backend 在发送前先看 transport 是否还开着：**没发出去的消息不算交付**，它留在 hub 的队列里。

**验证**：2 条新回归用例（agent 死了 → 消息保住并送达 + 用户看到提示；agent 反复死 → 有界重启并结束 session）。

### 三轮做完之后的总验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck`（cli / web / hub / relay） | 全过 |
| `bun run test:cli` | **3327 passed / 11 skipped / 0 fail** |
| `bun run test:web` | **3470 passed / 0 fail** |
| `bun run test:hub` | **1409 passed / 3 skipped / 0 fail** |
| `bun run test:shared` | **360 passed / 0 fail** |

三轮共改了 36 个文件（+1422 / −127），未提交。第四轮之后一共 **45 个文件（+2057 / −146）**，仍未提交。

---

## 第四轮实施记录（消息不许凭空消失，2026-10-22）

这一轮处理的是**投递链路上最后一段**：消息被 agent 拒绝之后，到底还算不算"已交付"。

### 先纠正一个过期结论

前两篇写着"ack 的时机要挪到 agent 真的受理这一轮，改动太大先不做"。
这条**已经不成立了**：`b64dc834 fix(mcode): keep a waiting message queued until the agent takes it`
早就把 mcode 切到了 `acknowledgeMessagesOnDequeue: false`（`cli/src/mcode/session.ts:62`），
ack 落在 `onPromptSent`（请求写上线路的那一刻），而不是出队那一刻。
真正没解决的是**拒绝之后**的那一段。

### A4 —— 被拒绝的消息退回 hub 的持久队列

**根因**：`mcodeRemoteLauncher.ts` 在 `onPromptSent` 就 ack 给 hub。
但 agent 可以在那之后才回"我现在不接"（`Session already has an active Turn` /
`The session Queue is paused` / …）。这时 hub 那边已经是"已交付"，
而消息只活在 **runner 进程内**的重试队列里 —— runner 一死，消息就没了。
`paused` 这一类拒绝能挂很久（agent 自己的队列被暂停），所以这不是理论窗口。

**改法**：把"被拒绝"当成一个**明确的、不会误判**的信号告诉 hub。

1. **新的 CLI→hub 事件 `messages-released`**（`shared/src/socket.ts`）
   ——"这些消息 agent 根本没接"。
2. **hub 存储层**（`hub/src/store/messages.ts` 的 `releaseInvokedMessages`）：
   把 `invoked_at` 清掉、`delivery_state` 置回 `queued`。
   只动**真的被 ack 过**的行：没被 ack 的本来就在队列里，取消掉的行已经不存在了。
3. **hub handler**（`sessionHandlers.ts`）：落库成功后广播 `messages-requeued`，
   web 于是把这条消息从"已发送"改回"等待中"。
4. **CLI**（`mcodeRemoteLauncher.ts` 的 `releaseBatchToHub`）：
   在**可重试的拒绝**这条路径上把批次交回 hub。
   致命拒绝（`turn input is invalid` 这类 agent 永远不会接的）**不交回** —— 交回去就是无限循环。
5. **web**（`message-window-store.ts` 的 `markMessagesRequeued`）：
   被退回的行要**连 `invokedAt` 一起清掉**，否则它永远显示成"已发送"。

**为什么这样不会重复投递**：hub 每 2 秒（session-alive）会把未 ack 的行重放给 runner，
但 CLI 侧有 `IncomingMessageFilter`（按消息 id 去重、256 条 LRU、命中即刷新），
重放的那条会被丢掉；runner 自己手里那份才是真要发出去的。
下一个 runner（换了进程、过滤器是空的）才会真正拿到它 —— 这正是我们要的。

**还剩的窗口**：ack 和 release 之间 runner 崩掉（agent 回答拒绝要多久，就暴露多久）。
彻底消掉它要把 ack 挪到"agent 真的受理了这一轮"，
但那样整轮期间消息都会留在 hub 的排队浮条里（现在的体验是"一交给 agent 就消失"），
属于另一个取舍，没做。

### A4-b —— agent 轮次中途死掉：标 indeterminate，不自动重发

这是前文 **A4** 那一节的剩余部分（A3 只修好了"不丢消息"和"别报成 prompt failed"）。

**根因**：agent 是在**拿到消息之后**死的。它可能已经消费了这条消息（跑了工具、改了文件），
但没有任何东西能证明。原来的处理是自动重发 —— agent 可能把同一份工作做两遍。

**改法**：对齐 steer 路径已有的做法。

1. launcher 记录 `promptSent`（请求有没有真的写上线路）。
2. agent 死了时分两种：
   - **没发出去**（`promptSent` 为假）→ 消息退回队列 + 退回 hub + 重起 agent（不丢，且确定没被消费）；
   - **发出去了**（`promptSent` 为真）→ 消息**标 indeterminate**：
     hub 的行清掉 `invoked_at`、转成 `indeterminate`（不进自动重放），
     web 把它显示成"结果未知"，用户自己决定**重试**还是**丢弃**。
3. `hub/src/store/messages.ts` 的 `markMessagesIndeterminate` 原来要求 `invoked_at IS NULL`
   （只服务 steer），现在会**连 `invoked_at` 一起清** —— 普通消息被 ack 过也能转成 indeterminate。
4. web 的 `markMessagesIndeterminate` 同样要清掉已 ack 行的 `invokedAt`，
   否则它根本不会出现在排队浮条里，用户看不到"这条要你决定"。
5. CLI 侧新增通用的 `emitMessagesIndeterminate`，`emitSteerIndeterminate` 变成它的别名
   （事件名 `messages-indeterminate` 本来就是通用的，只有方法名带 steer）。

**为什么不再自动重发**：agent 可能已经执行了工具。重复执行比"多问用户一句"更危险。
这跟仓库里 codex 对 steer 的处理是同一条规则：**证不出来的结果不自动重投，交给用户**。

### 这一轮的验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck`（cli / web / hub / relay） | 全过 |
| `bun run test:cli` | **3330 passed / 11 skipped / 0 fail** |
| `bun run test:web` | **3474 passed / 0 fail** |
| `bun run test:hub` | **1418 passed / 3 skipped / 0 fail** |
| `bun run test:shared` | **360 passed / 0 fail** |

新增回归用例 13 条：hub 存储 7 条（退回 / 未 ack 不动 / 取消的不复活 / 幂等 / 门面 / 回滚 /
已 ack 转 indeterminate）、hub handler 2 条、CLI launcher 2 条（可重试拒绝退回 hub、致命拒绝不退回）、
CLI launcher 1 条（轮次中途死掉 → 标 indeterminate 且不自动重发）、
web 3 条（退回的行回到"等待中"、已 ack 的行转 indeterminate 后仍出现在排队浮条里、乐观行不被误伤）。

### 这一轮之后，投递链路上还剩什么
- **ack 与 release 之间的窄窗口**（见上）：要彻底消掉得把 ack 挪到"agent 真的受理了这一轮"，
  代价是整轮期间消息都留在排队浮条里。没做。
- **agent 自带队列 API**（`mcode/session/queue/enqueue`）没接：它最持久（agent 自己的库里），
  但队列只存文本 → **每轮的 model / effort / permissionMode 会丢**，而且与 TUI 共用一条队列。
  当成"agent 不在时的兜底"更合适，当成默认投递路径不合适。
- **原生端会跟 web 走得不一样**（本轮按用户要求没做原生端）：这一轮复用了两个**已有的** SSE 事件，
  没有新增事件、没有改事件结构，所以原生端不会崩；但两处语义变宽了 ——
  `messages-requeued` 现在也可能是"agent 拒了这一轮"（不只是"用户点了重试"），
  `messages-indeterminate` 现在也可能指一条普通消息（不只是 steer）。
  原生端按旧语义实现（清 indeterminate 标记、保留 invokedAt），
  在"被拒绝退回"这一种情况下会显示成"已发送"而 hub 其实还在队列里 —— 属于 C1–C5 那批原生端对齐的活。

---

## 第五轮实施记录（拒绝提示要说人话，2026-10-22）

### 队列提示本地化

**问题**：11 种拒绝理由的提示是 **CLI 里硬编码的英文**，web 直接显示
（`web/src/chat/presentation.ts` 的 queue-notice 分支 + `SystemMessage.tsx` 渲染系统消息正文）。
中文和俄文用户看到的是英文 —— 跟第一轮 B20（`Default` 没本地化）是同一类问题，
只是它藏在一条只有"agent 忙"时才会出现的路径里，平时看不见。

**改法**：理由本来就从 CLI 传过来了（`reason` 字段），所以**文案由客户端出**：

1. `web/src/chat/types.ts`：把 11 个理由从纯类型变成 `QUEUE_NOTICE_REASONS` 常量 + 派生类型，
   这样"每个理由都得有翻译"可以测。
2. `web/src/chat/presentation.ts`：`getEventPresentation(event, t?)` 多收一个翻译函数；
   找到 `queueNotice.<reason>` 就用本地化文案，**找不到就回退 CLI 的原文**
   （CLI 知道得比理由多，而且理由表在两边可能不同步）。
3. 三个渲染点都把 `t` 传进去：系统消息（`SystemMessage.tsx`）、
   工具消息里的 agent 事件（`ToolMessage.tsx`）、工具轨迹（`ToolCard/trace.tsx`）。
4. 三种语言各加 12 条文案（11 个理由 + 等待时长后缀）。
5. 英文文案**逐字对齐 CLI 现在的说法**（有一条测试盯着这件事），
   中文和俄文是重写，不是机翻。

**顺带补上的一个洞**：系统消息的正文是在消息构造时渲染好的（`assistant-runtime.ts`），
那时候没有语言上下文，所以中文用户在**系统消息这一条路径**上仍会看到英文 ——
现在组件里对 queue-notice 单独取一次本地化文案。

**验证**：新增回归 7 条（presentation 3 条：有翻译时用翻译 / 理由没翻译时回退 CLI 原文 /
没有翻译函数时回退原文；文案覆盖 2 条：每个理由三种语言都有、英文与 CLI 逐字一致；
组件 2 条：中文界面显示中文、未知理由保留 CLI 原文），
外加 `localeParity` 继续盯着三种语言的键一致。

| 检查 | 结果 |
|---|---|
| `bun run typecheck`（cli / web / hub / relay） | 全过 |
| `bun run test:web` | **3481 passed / 0 fail** |

---

## 建议的动手顺序

> 下面是**第一轮**排的顺序，前四项已经做完（第一轮做完 web 端 17 项，
> 第二、三、四轮做完 A1 / A2 / A3 / A4 / A4-b）。剩下的是还没动的。

1. ~~**A1**（拒绝分类表 + 默认回队）~~ —— 已做（第二轮）；
2. ~~**A2**（租约过期 + 属主存活）~~ —— 已做（第二轮）；
3. ~~**A3/A4**（transport 死亡信号 + prompt 路径的 indeterminate 处理）~~ —— 已做（第三、四轮）；
4. ~~**A5-b + D1/D2/D3**~~ —— 已做（第一轮，web 端）；
5. **A8 + C1–C5 + A9**（能力位 + 原生端/契约/fixture 补齐）—— 一次把"原生端看不见 mcode"整体解决；
   本轮按用户要求**没有做**（只做 Web 端）；
6. 其余 P2/P3 与旧条目按批次清理。
