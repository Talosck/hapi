# mcode ↔ HAPI 五次复审：后台任务计数（2026-10-22）

> 前四篇：`mcode-integration-review.md`（首轮 + 实施审计）、`-2.md`（二次复审）、
> `-3.md`（三次复审，投递链路）。本文只写**后台任务**这一条线的问题，全部结论都回查到源码行号，
> agent 侧结论都来自**直接探测本机运行中的 agent**（`@minimax-ai/code` 0.5.9）。
>
> **本文同时是实施记录**：本轮的问题已全部修完并全量验证，记录在文末。

---

## 一句话结论

**Web 上那句「7 个终端运行中 · 无法确定具体命令」是错的：当时后台一个任务都没在跑。**

7 这个数不是"猜"的，是 HAPI 自己算出来的一个**增量计数器**永远减不下来的残留值；
而"无法确定具体命令"是因为 HAPI **从来没有一个后台任务表** —— 它只是从工具流里猜哪些调用是后台任务。

根因不在 UI，在**协议层**：MiniMax Code 把后台任务的"完成"这件事**完全不通过 ACP 告诉客户端**，
所以任何"客户端自己数任务"的方案都必然漂移。本轮的做法是：**HAPI 只报它能证明的东西**，
并且把计数从**增量**改成**绝对值**，从根上让漂移不再可能。

---

## 一、现象与取证

### 1.1 用户看到的

```
后台终端
7 个终端运行中 · 无法确定具体命令
```

状态栏同时显示 `7 background tasks running`。

### 1.2 agent 自己的账本说：0 个在跑

agent 把后台任务记在 `~/.minimax/v2/sqlite/runtime-state.sqlite` 的
`local_runtime_background_tasks` 表里。本会话（`mvs_a32d47bf9ee74bbabaa0bad6d1bf5920`）的分布：

| status | 数量 |
|---|---|
| succeeded | 385 |
| failed | 6 |
| canceled | 1 |
| running | 1（当时正在跑的那次查询本身） |

**6 failed + 1 canceled = 7**，正好等于 HAPI 显示的数字。也就是说 HAPI 数的这 7 个
**全是早就结束的任务**，而且是在它们结束之后还被继续数着。

### 1.3 HAPI 的 7 是怎么来的

链路（改动前的代码）：

| 环节 | 位置 | 事实 |
|---|---|---|
| CLI 聚合器 | `cli/src/mcode/utils/backgroundTaskAggregator.ts`（旧版 `takeBackgroundTaskDelta()`） | 返回 `{started, completed}` **增量** |
| CLI→hub | `cli/src/api/apiSession.ts`（旧 `sendBackgroundTaskDelta()`） → `shared/src/socket.ts:281` `'background-task'` 事件 | 把增量发给 hub |
| hub | `hub/src/sync/sessionCache.ts`（旧 `applyBackgroundTaskDelta()`） | `next = max(0, prev + started - completed)`，**累加** |
| web 面板 | `web/src/chat/sessionStatus.ts` | 用 `session.backgroundTaskCount` 切工具流里猜出来的终端 |
| web 状态栏 | `web/src/components/AssistantChat/StatusBar.tsx:103`（旧） | 硬编码英文 `${count} background task(s) running` |

**增量计数器必须两头都对得上**：每一次 started 要加一次，每一次 completed 要减一次。
只要有 **一次 completed 没被 HAPI 看见**，这个数就永远多 1。

### 1.4 为什么 completed 会被漏掉 —— 这是本轮最关键的发现

我直接抓了 agent 的 ACP 报文（`mcode acp`，JSON-RPC over stdio），跑了两种场景：

**场景 A：任务在回合内结束**（agent 在同一轮里 poll 了它）

```
→ session/prompt "Start this command in the background: sleep 4 && echo hello..."
← session/update  tool_call        {name:"bash", rawInput:{command,run_in_background:true}}
← session/update  tool_call_update {status:"in_progress"}
← session/update  tool_call_update {status:"completed", rawOutput:{details:{status:"started",task_id:"bg_…"}}}
← session/update  tool_call        {name:"task_output", rawInput:{task_id:"bg_…"}}
← session/update  tool_call_update {status:"completed", rawOutput:{details:{status:"succeeded",task_id:"bg_…"}}}
```

→ HAPI 看得见终态，计数能归零。**这条路没问题。**

**场景 B：任务在回合结束后才结束**（agent 不 poll，自己续跑一轮）

```
← session/update  tool_call_update {status:"completed", rawOutput:{details:{status:"started",task_id:"bg_…"}}}
← session/prompt 响应 {stopReason:"end_turn"}          ← 轮次结束，HAPI 的 prompt 请求已返回
   … 20 秒后任务结束 …
← session/update  session_info_update                   ← 只有会话状态类通知
← session/update  usage_update                         ← 只有用量类通知
```

→ **agent 续跑的那一轮，HAPI 一个字都收不到。**

我把 agent 产物翻了一遍确认这不是我抓漏了：

| 事实 | 位置 | 证据 |
|---|---|---|
| 完成后��知是**内部 steer**，且 `hideUserMessage: true` | agent `chunks/chunk-QEPCDCRA.js` 的 `WZ()` | 构造 `<background-task-finished>…<task task_id=… status=…/></background-task-finished>`，再 `conversation.ingress.steer({source:"background-task", hideUserMessage:true})` |
| `hideUserMessage:true` 的消息**不是** user 消息 | 同上 `svr()` / `ivr()` | `svr(e)` 返回 false → 不生成 `userMessageId` → 不会被 `ir.project` 当成 user 消息投影 |
| `user_message_chunk` **只在回放历史时发** | agent `chunks/run-acp-command-SBE5PYAH.js` 的 `lS()` | `lS` 只在 `session/load` 里被调用（`:428611`）；实时回合走 `ir.project`，而 `ir.projectMessage` 对 `role!=="assistant"` 直接返回 `[]` |
| ACP 适配器**没有**任何后台任务接口 | 同上 | `onRequest`/`onNotification` 全量清单：`mcode/session/activate`、`mcode/session/steer`、`mcode/session/queue/*`、`mcode/session/goal/*`、`mcode/session/delegation/*` —— **没有 task-list** |
| ACP 适配器**没有**后台任务通知 | 同上 | `notify("mcode/session/…")` 只有 `current_session_update` / `delegation_update` / `goal_update` / `queue_update` |

agent 自己的账本里能看到这件事确实发生：

```sql
-- ~/.minimax/v2/sqlite/runtime-state.sqlite
select turn_id, source, client_request_id, status
from local_runtime_turn_ingress
where session_id='mvs_26324f20b2bd4f85a50f16434e4e8924';
```

```
turn_task_delivery_239ae8f0… | source=turn | client_request_id=bg_236791e9-… | completed
```

`client_request_id` 就是那个后台任务 id —— agent 确实为它开了一轮，
**但那一轮没有绑在任何 `session/prompt` 请求上，所以不会被流给客户端**。

### 1.5 "无法确定具体命令"也是真的

`web/src/chat/sessionStatus.ts`（改动前）只会从工具流里认两种 Claude Code 文本：

```ts
const BACKGROUND_START_RE = /Command running in background with ID:\s*([^\s<]+)/
const TASK_ID_RE = /<task-id>\s*([^<]+?)\s*<\/task-id>/
```

mcode 的格式完全不同（实测报文）：

```
rawOutput: { details: { status: "started", task_id: "bg_62208582-…" },
             content: [{ type:"text", text:"<bash_background task_id=\"bg_62208582-…\">…" }] }
```

两条正则一条都不匹配 → **命令永远猜不出来**。

---

## 二、修法

### 2.1 设计原则

1. **只报能证明的东西**：HAPI 没有证据说任务还活着，就不把它算作在跑。
   （沿用前几轮已确立的"宁可少报不假报"。）
2. **计数用绝对值**：报的是"现在有哪些后台任务在跑"这个**列表**，
   列表长度就是计数 —— 结构上不可能漂移。
3. **一条链路**：命令、状态、计数来自同一份账本，不再有"面板一套、状态栏另一套"。

### 2.2 CLI：任务账本（`cli/src/mcode/utils/backgroundTaskAggregator.ts`）

| 能力 | 位置 | 说明 |
|---|---|---|
| 账本 | `BackgroundTaskRecord`（`:90`）、`records` 表 | `id` / `command` / `cwd` / `startedAt` |
| 计数 | `snapshot()` 的长度 | **账本大小**，不是累加的计数器 |
| 快照 | `snapshot()`（`:336`） | 账本内容 |
| 启动即入账 | `handleToolResult()` | 认到 `details.task_id` + `details.status ∈ 启动态` → 入账，命令取工具入参的 `command`（没有就取 `description`），目录取工具入参的 `cwd`，没有就用会话目录 |
| 终态即出账 | `handleControlResult()` | agent 报 `status ∈ {succeeded,failed,canceled,…}` → 出账 |
| 失联即出账 | `flushPromptEnd()`（`:391`）+ `UNTRACKED_AFTER_TURNS = 2`（`:82`） | agent **连续 2 个回合没再问过**这个任务 → 没有任何证据说它还活着 → 出账 |
| 回放对账 | `reconcile()`（`:367`） | 见 2.3 |

### 2.3 回放对账：唯一能拿到真相的入口

既然 agent 不会实时告诉客户端"任务结束了"，那**它自己回放历史的时候**会。
实测 `session/load` 的回放里带着上一轮续跑的工具调用：

```json
{"sessionUpdate":"tool_call","toolCallId":"call_01a1642b…","title":"task_output",
 "name":"task_output","status":"completed","rawInput":{"task_id":"bg_1cf89893-…"},
 "rawOutput":{"details":{"task_id":"bg_1cf89893-…","status":"succeeded", …}}}
```

于是：

* `AcpSdkBackend.loadSession()`（`cli/src/agent/backends/acp/AcpSdkBackend.ts:550-601`）
  在加载期间挂一个**只读回放**的 handler，把回放交给调用方（`onHistory`），加载完复原。
  回放**不进时间线**（那是历史，聊天记录里已经有了）。
  这个 handler 只收工具类消息、并且**不注册图片**
  （`registerImages: false`）—— 否则回放会把这一轮早就注册过的图片再注册一遍，
  把原来的挤掉（内存里的图片库有上限，会淘汰最旧的）。
* `mcodeRemoteLauncher`（`cli/src/mcode/mcodeRemoteLauncher.ts:539`）把回放喂给
  `backgroundTasks.reconcile()`：**先把 agent 的原始工具名归一化**
  （回放里是 `bash` / `task_output`，账本认的是 `Bash` / `task_output`），
  再让账本处理：终态把任务划掉，没终态的留下并进入"连续 2 回合没被问就出账"的规则。

> 顺带修了一个真 bug：`AcpMessageHandler.handleToolCall` 以前**完全忽略 `rawOutput`**，
> 所以"一次更新就带结果的工具调用"（正是回放的形式）结果会被丢掉，工具永远不结束。
> 现在补上了（`cli/src/agent/backends/acp/AcpMessageHandler.ts:837`）。
> 这条对所有 agent 都生效，属于修正确行为而不是加特例。

### 2.4 传输：账本作为 session event

| 环节 | 位置 | 变化 |
|---|---|---|
| 协议 | `shared/src/schemas.ts:382` `BackgroundTaskRecordSchema` | 新增；`shared/src/types.ts` 导出类型 |
| CLI | `cli/src/api/apiSession.ts` `sendSessionEvent({type:'background-task-snapshot', tasks})` | 仿 `subagent-snapshot`，作为会话事件发；且列入 `LOSSLESS_SESSION_EVENT_TYPES`（快照被丢一次，计数就会一直是旧的） |
| CLI | `cli/src/mcode/mcodeRemoteLauncher.ts:1868` `reportBackgroundTasks()` | 只在账本**变了**时发（避免刷屏） |
| hub | `hub/src/sync/backgroundTasks.ts:14` `extractBackgroundTaskSnapshot()` | 解析出 `{running: 列表长度}` |
| hub | `hub/src/sync/sessionCache.ts:575` `setBackgroundTaskCount()` | **绝对值**写入 `session.backgroundTaskCount`，并广播 `session-updated` |
| 旧链路 | `shared/src/socket.ts` `'background-task'` 事件 | **删除**。它只服务 mcode，现在没有增量可发了 |

### 2.5 Web

| 位置 | 变化 |
|---|---|
| `web/src/chat/sessionStatus.ts:198` `latestBackgroundTaskSnapshot()` | 从消息里读最新的账本快照 |
| `web/src/chat/sessionStatus.ts:362` | 有账本就用账本渲染终端列表；没有才回退到"从工具流猜"的老路（Claude Code 兼容） |
| `web/src/chat/reducer.ts` | `background-task-snapshot` 归入静默状态事件，不进时间线 |
| `web/src/components/AssistantChat/StatusBar.tsx:105` | 硬编码英文换成 `session.status.backgroundTasks.count.one/other`（en / zh-CN / ru） |
| `web/src/chat/presentation.ts` | 会话导出里这个事件有一行人类可读的标题，不再是一坨 JSON |

于是面板从

```
7 个终端运行中 · 无法确定具体命令
```

变成

```
后台终端
npm run dev
/home/talos/proj · 2 分 13 秒
```

状态栏变成 `1 个后台任务运行中` / `1 background task running`。

---

## 三、残留限制（必须说清楚）

1. **agent 没有任务列表接口**，所以 HAPI 无法主动查询真相。
   一次"回合外结束"的任务，HAPI 要等到 (a) 连续 2 个回合没再被问过，或 (b) 一次 `session/load` 回放，
   才知道它不再跑。**在这之前它会被算作在跑** —— 这是"宁可多报一次也不要漏报"的一侧，
   因为少报会让用户以为任务已经结束。
2. **CLI 进程重启后账本为空**，正在跑的任务要等下一次回放才能重新入账。
3. **原生端（iOS/Android）尚未适配** `background-task-snapshot`：它们会收到这个事件但没有渲染，
   面板里的后台任务列表只有 Web 有。按约定本轮不动原生端。
4. Claude Code 的老路径（hub 从消息里解析 `Command running in background with ID:`）**保持原样**，
   它仍然是增量语义。两种 agent 不会同时驱动一个 session，所以不会互相覆盖。

---

## 四、实施记录

### 4.1 改动文件

**CLI**
- `cli/src/mcode/utils/backgroundTaskAggregator.ts` —— 任务账本、绝对计数、回放对账
- `cli/src/mcode/utils/backgroundTaskAggregator.test.ts` —— 重写（28 个用例，其中一个直接喂
  **从 `mcode acp` 抓下来的真实报文**，把"账本认得 agent 的真实格式"钉住）
- `cli/src/mcode/mcodeRemoteLauncher.ts` —— 账本上报、加载时对账
- `cli/src/mcode/mcodeRemoteLauncher.test.ts` —— 断言改成快照；新增"回放对账"用例
- `cli/src/mcode/session.ts` —— 下线 `sendBackgroundTaskDelta`
- `cli/src/api/apiSession.ts` —— 新增 `background-task-snapshot` 事件、下线增量发送
- `cli/src/api/apiSession.test.ts` —— 改为断言事件
- `cli/src/agent/backends/acp/AcpSdkBackend.ts` —— `session/load` 回放交给调用方
- `cli/src/agent/backends/acp/AcpSdkBackend.test.ts` —— 新增回放用例
- `cli/src/agent/backends/acp/AcpMessageHandler.ts` —— 一次更新带结果的工具调用不再丢结果

**Shared**
- `shared/src/schemas.ts` / `shared/src/types.ts` —— `BackgroundTaskRecord`
- `shared/src/socket.ts` —— 删除 `'background-task'` 事件

**Hub**
- `hub/src/sync/backgroundTasks.ts` —— `extractBackgroundTaskSnapshot()`
- `hub/src/sync/backgroundTasks.test.ts` —— 新增
- `hub/src/sync/sessionCache.ts` —— `setBackgroundTaskCount()`
- `hub/src/sync/syncEngine.ts` —— `handleBackgroundTaskCount()`
- `hub/src/socket/handlers/cli/sessionHandlers.ts` —— 收快照、下线 socket 事件
- `hub/src/socket/handlers/cli/sessionHandlers.test.ts` —— 改为断言快照
- `hub/src/socket/handlers/cli/index.ts`、`hub/src/socket/server.ts`、`hub/src/startHub.ts` —— 依赖透传

**Web**
- `web/src/chat/types.ts` —— 事件类型
- `web/src/chat/reducer.ts` —— 静默状态事件
- `web/src/chat/sessionStatus.ts` —— 读账本、渲染
- `web/src/chat/sessionStatus.test.ts` —— 新增 6 个用例
- `web/src/components/AssistantChat/StatusBar.tsx` —— 本地化
- `web/src/lib/locales/{en,zh-CN,ru}.ts` —— 文案
- `web/src/types/api.ts` —— 类型导出

**文档**
- `docs/api/client-contract/messages.md` —— 新事件
- `docs/api/client-contract/sse.md` —— `backgroundTaskCount` 是绝对值

### 4.2 验证

- `bun typecheck`（cli / web / hub / relay）—— 全过
- `bun run test:cli` —— **3339 passed / 11 skipped**
- `bun run test:web` —— **3486 passed**
- `bun run test:hub` —— **1422 pass / 3 skip**
- `bun run test:shared` —— **360 pass**；`bun run test:relay` —— **118 pass**
- 端到端取证：直接用 `mcode acp` 抓了"回合内结束"和"回合外结束"两种真实报文，
  以及 `session/load` 的回放报文（本文第一节的表格都是实测原文）；
  聚合器里有一个用例直接喂**抓下来的真实报文**，把"账本认得 agent 的真实格式"钉住

### 4.3 一并修掉的真 bug

* `AcpMessageHandler.handleToolCall` 忽略 `rawOutput` —— 一次更新带结果的工具调用丢结果（2.3 节）。
* `StatusBar` 的后台任务计数是硬编码英文，没走 i18n（2.5 节）。
