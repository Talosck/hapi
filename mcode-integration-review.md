# MiniMax Code (mcode) ↔ HAPI 集成评估

**评估对象**：`mcode` v0.5.9 (`@minimax-ai/code`) ↔ HAPI 仓库 `/home/talos/coding/hapi`
**评估日期**：2026-10-21
**结论**：集成质量高，未发现硬性对接 Bug；主要问题是 **能力缺口**（mcode 提供但 HAPI 未接入的扩展方法）与 **若干可优化点**。

> **实施状态（2026-10-21）**：本报告的 **P0** 与 **P1** 已实现并验证，详见 [§7 实施记录](#7-实施记录)。
> **P2**（Connector/App 可视化、模型探针开销）**也已实现**，见 [§8 P2 实施记录](#8-p2-实施记录)。
> P3（会话 fork）与"图片输入提示"未做——后者经实测证明是**错的建议**（见 §8.3）。

---

## 0. 结论摘要

| 维度 | 评价 | 说明 |
|---|---|---|
| 协议契合度 | ✅ 优秀 | HAPI 发出的 `initialize` 能力声明与 mcode 实际实现逐项吻合；扩展方法名、config option id、模型 id 编码全部对得上 |
| 对接 Bug | ✅ 未发现 | 12 项重点怀疑全部实测排除（含 2 个初判为 bug 的误报） |
| 能力覆盖 | ⚠️ 部分接入 | **已接入**：`goal/{get,create,patch,clear}`、`delegation/{get,stop}`（P1）；`session/fork` 整会话 fork（P3）；`mcode/session/steer` 轮次内注入（P4）；**明确不做**：agent 原生队列、`activate`、`session/resume`（理由见 §9.5） |
| 可维护性 | ✅ 良好 | 扩展点从 agent 自述的 `initialize` 响应中读取，非硬编码（P0 已落地） |
| 优化空间 | ⚠️ 中等 | 模型探针进程开销、Connector/App 工具未可视化（P2 未做） |

规模：CLI 侧 mcode 代码 4,338 行（+3,657 行测试，11 个测试文件）；web/shared/hub 侧相关 23,420 行；mcode 相关 commit 26 个。

---

## 1. 评估方法

不依赖文档，直接对真实 agent 探测：

1. **ACP 握手探测** — 向 `mcode acp` 发送 `initialize` / `session/new` / `session/load`，读取 agent 自述的能力集
2. **扩展方法探测** — 逐一调用 `mcode/session/{goal,delegation,queue,activate}/*`，确认哪些真实可用
3. **MCP 传输探测** — 挂载真实 MCP stdio server，验证工具是否注入
4. **斜杠命令探测** — 通过 `session/prompt` 发送 `/compact`，验证 agent 是否拦截
5. **生命周期探测** — 跨进程 resume、并发进程隔离、session 目录布局
6. **代码比对** — 通读 `cli/src/mcode/**`、共享 ACP 后端、`shared/src/modes.ts`、web 模型选择器

---

## 2. mcode 实际能力清单（实测）

### 2.1 ACP 表面

启动方式：`mcode acp`，JSON-RPC over stdio，换行分隔，**不接受任何额外参数**。

`initialize` 响应实测：

```jsonc
{
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },      // 注意：未声明 stdio，但实际可用
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} }
  },
  "_meta": {
    "minimax-code/extensions": {
      "version": 1,
      "methods": [
        "session/activate", "mcode/session/activate", "mcode/session/steer",
        "mcode/session/queue/list", "mcode/session/queue/enqueue",
        "mcode/session/queue/update", "mcode/session/queue/delete",
        "mcode/session/queue/steer",
        "mcode/session/goal/get", "mcode/session/goal/create",
        "mcode/session/goal/patch", "mcode/session/goal/clear",
        "mcode/session/delegation/get", "mcode/session/delegation/stop"
      ],
      "notifications": [
        "mcode/session/current_session_update", "mcode/session/queue_update",
        "mcode/session/goal_update", "mcode/session/delegation_update"
      ]
    }
  }
}
```

### 2.2 配置项（`session/new` 返回的 `configOptions`）

| id | category | 取值 | scope |
|---|---|---|---|
| `permissionMode` | `_permission` | `default` / `auto` / `bypassPermissions` | **process** |
| `model` | `model` | `m:<provider>:<model>:v:<variant>`（无变体时是空变体的 `m:<provider>:<model>:v:`） | session |
| `thinkingEffort` | `thought_level` | `default` / `low` / `medium` / `high` / `xhigh` / `max` | session |

会话模式（`modes`）：`default` / `plan`。`session/set_mode` **延迟到下一轮 prompt 生效**。

### 2.3 其他实测结论

- **斜杠命令会被 agent 拦截**：`session/prompt` 发送 `/compact` → 返回 `Compaction completed. Messages: 0 → 1, Tokens: 14,084 → 14,359`
- **MCP stdio 可用**：挂载真实 MCP server 后工具以 `mcp__<server>__<tool>` 注入并可正常调用；`env: []` 不影响子进程环境继承
- **扩展方法真实可用**：`goal/create`、`goal/get`、`delegation/get`、`queue/list`、`session/activate` 均返回成功
- **`goal/create` 会立即启动自主执行**：实测设置 1000 token 预算后，agent 在 21 秒内自主消耗 16,725 tokens 并转入 `budget_limited` 状态
- **session 存储布局**：`~/.minimax/v2/sessions/<y>/<m>/<d>/<HH-mm-ss-SSS>-session_<base64url(id)>/messages.jsonl`，索引在 `~/.minimax/v2/sqlite/runtime-state.sqlite`
- **跨进程 resume 保留完整历史**（`session/load`）
- **并发进程互不干扰**：两个 `mcode acp` 进程同时运行，各自 session 独立，无交叉通知
- **mcode 未实现**：`session/delete`、`logout`、`providers/*`、`nes/*`、`document/did*`、`mcp/message`
- **mcode 不会回调客户端的** `fs/*` 与 `terminal/*` 方法

### 2.4 Connector / App 工具（mcode-tools）

`mcode-tools` v0.0.6（`@minimax/mcode-tools`），嵌入在 mcode 包内 `embedded/mcode-tools/cli.mjs`，auth 模式 `shared-broker`（`@mavis/oauth-lease-protocol` v1）。

子命令：`connector tools|tool|call`、`auth status`、`get-asset-url`、`upload-temp-url`。

**关键特性**：Connector 工具**不通过 ACP 暴露、也不通过 MCP 暴露**。agent 只能通过 Bash 调 `mcode-tools` CLI + `mcode-tools-master` skill 来发现/调用它们。

实测：在 `mcode acp` 子进程中，agent 成功执行 `mcode-tools connector tools` 并拿到 14 个工具（Lark、Matrix、email_workbench 等）。

---

## 3. HAPI 覆盖情况对照

### 3.1 已正确接入（✅）

| 能力 | HAPI 实现位置 | 验证 |
|---|---|---|
| ACP 客户端 | `cli/src/agent/backends/acp/AcpSdkBackend.ts` (10,072 行) | ✅ |
| 能力声明 | `AcpSdkBackend.ts:268-272` | ✅ `fs:{false,false}`、`terminal:false` —— **保守且准确**（mcode 不回调这些） |
| 扩展 opt-in | `cli/src/mcode/utils/mcodeExtensions.ts` `MCODE_EXTENSION_CAPABILITY_META` | ✅ `{version:1, notifications:true}`，与 agent 期望一致，实测两个通知均正常下发 |
| 权限模式映射 | `utils/permissionModes.ts`、`shared/src/modes.ts` | ✅ `default`/`auto`/`bypassPermissions` ↔ HAPI 2 轴模型，双向映射 |
| 模型目录发现 | `modules/common/mcodeModels.ts` (308 行) | ✅ probe + live 双路，统一去重/排序 |
| 模型 id 编解码 | `shared/src/mcodeModelId.ts`、`utils/modelId.ts` | ✅ ACP wire id ↔ CLI user-facing id 双向转换 |
| Effort | `shared/src/slashCommands.ts`、`web/.../EffortField.tsx` | ✅ `thought_level` 分类驱动，非硬编码 |
| ask_user 桥接 | `utils/questionHandler.ts` (632 行) | ✅ elicitation 表单 → HAPI 问卷 |
| 委派树 / 线程目标 | `utils/mcodeExtensions.ts` | ✅ `delegation_update` + `goal_update` |
| 后台任务聚合 | `utils/backgroundTaskAggregator.ts` (487 行) | ✅ |
| 用量统计 | `utils/mcodeUsage.ts` (692 行) | ✅ 原生 transcript watcher + SQLite 索引回退 |
| 斜杠命令透传 | `AcpSdkBackend.ts:1560-1585` | ✅ 命令名册后写覆盖 → 含 skills 的完整名册生效 |
| 会话恢复 | `mcodeRemoteLauncher.ts:170-196` | ✅ `session/load` 失败自动降级 `session/new` |
| 本地↔远端接力 | `mcodeLocalLauncher.ts`、`runMcode.ts` | ✅ |
| 工具名归一 | `utils/toolCallNormalizer.ts` | ✅ `mcp__hapi__skill_lookup` 不被误改写 |

### 3.2 能力缺口（mcode 提供 → HAPI 未用）

> **G1 / G2 已由 P1 补齐**，下表反映实施后的状态。

| # | mcode 能力 | 现状 | 影响 |
|---|---|---|---|
| **G1** | `mcode/session/goal/get` `create` `patch` `clear` | ✅ **已接入**（P1） | — |
| **G2** | `mcode/session/delegation/get` `stop` | ✅ **已接入**（P1） | — |
| **G3** | `mcode/session/steer` | ✅ **已接入**（P4）：真·轮次内注入，与 codex 同级 | — |
| **G4** | `mcode/session/queue/{list,enqueue,update,delete,steer}` | ❌ **明确不做**：与 HAPI 自己的 hub 侧队列构成双份真相 | 放弃 agent 原生队列的编辑/删除语义，HAPI 队列已覆盖 |
| **G5** | `mcode/session/current_session_update`、`queue_update` | ❌ 不做：`current_session_update` 在"一进程一会话"下恒为回声；`queue_update` 依赖 G4 | — |
| **G6** | `session/fork`、`session/resume`（`sessionCapabilities` 已声明） | ⚠️ **fork 已接入**（P3，整会话 fork）；`session/resume` 未使用 | mcode 没有 message 级 fork，只能整会话分叉；resume 与 HAPI 现有 `session/load` 路径语义不同（不返回新 session id） |
| **G7** | Connector / App 工具 | ✅ **已接入**（P2）：Web 端可列出已连接 App 与授权状态 | — |
| **G8** | `promptCapabilities.image: false` | ✅ **不是限制**（实测） | mcode 不接受 image 内容块，但 HAPI 的附件走 `@path` 文本引用，agent 用自己的 `read`/`bash` 读图——实测能正确识别图片内容 |

---

## 4. 对接 Bug 审计

**未发现硬性 Bug。** 以下为审计过程中产生并被逐一实测排除的怀疑项，记录以避免重复排查：

| # | 怀疑 | 实测结论 |
|---|---|---|
| 1 | mcode `mcpCapabilities` 只声明 `http`/`sse`，HAPI 传 stdio MCP → 工具不可用 | ❌ 误报。stdio 实测可用，工具以 `mcp__hapi__*` 正常注入并可调用 |
| 2 | `toAcpMcpServers` 传 `env: []` 会清空子进程环境 | ❌ 误报。实测 `env: []` 下 MCP server 正常启动 |
| 3 | `cleanup()` 重复注册 RPC handler → 旧 handler 残留 | ❌ 误报。`RpcHandlerManager` 用 `Map.set`，后写覆盖；且 cleanup 中探针 handler 后注册，顺序正确 |
| 4 | HAPI 虚报 `fs`/`terminal` 能力但未实现对应方法 | ❌ 误报。HAPI 声明的是 `false`，未虚报 |
| 5 | `session/load` 响应不含 `sessionId` → 后续 prompt 全挂 | ❌ 误报。`AcpSdkBackend.ts:513` 有 `loadedSessionId ?? config.sessionId` 兜底 |
| 6 | 多进程共享 mcode runtime → session 串扰 | ❌ 误报。双进程实测完全隔离 |
| 7 | `permissionMode` 是 process scope，多会话互相污染 | ❌ 误报。HAPI 每会话独立进程 |
| 8 | `available_commands_update` 发两次，后者含 skills → 名册不全 | ❌ 误报。后写覆盖，完整名册生效 |
| 9 | `goal_update` payload 字段名与 HAPI 解析器不匹配 | ❌ 误报。实测字段完全一致 |
| 10 | 斜杠命令透传只是文本、agent 不识别 | ❌ 误报。`/compact` 实测被 agent 拦截并生效 |
| 11 | `mcpCapabilities` 无 `stdio` → HAPI 的 `skill_lookup` 失效 | ❌ 误报。skill_lookup 正常可用 |
| 12 | 双写 `this.requestedPermissionMode` 与 agent 上报模式冲突 | ❌ 误报。权限回环路径正确 |

### 4.1 唯一实质性健壮性问题

**扩展方法名硬编码**（`cli/src/mcode/utils/mcodeExtensions.ts`）

agent 在 `initialize` 的 `_meta["minimax-code/extensions"]` 中**自述**可用方法与通知列表，且 `goal/*` 整组受运行时 feature flag（`runtime.isGoalEnabled()`）控制——flag 关闭时 `goal_update` 根本不下发。

HAPI 此前：
- 硬编码 `'mcode/session/delegation_update'` / `'mcode/session/goal_update'` 两个通知名
- 未读取 agent 自述的 `methods` / `notifications` 数组

后果：mcode 改名或裁剪扩展时，HAPI 会**静默失效**——不报错、不降级，只是功能消失。其他部分（权限 id、模型 id、effort id）都已改为按 `category` 动态解析，扩展方法这块是唯一的例外。

> ✅ **已由 P0 修复**：见 §7.1。

---

## 5. 优化建议

> ✅ = 已实施并验证；❌ = 未实施。

### ✅ P0 — 扩展能力动态探测

读取 `initialize` 响应里的 `_meta["minimax-code/extensions"].methods` / `.notifications`，据此：

1. 只订阅实际可用的通知（避免对未启用扩展的无谓等待）
2. 为 `goal/*`、`delegation/stop`、`steer`、`queue/*` 等方法预留开关式接入路径
3. 至少做到"agent 不支持时优雅降级"而非静默无响应

### ✅ P1 — 目标（Goal）生命周期接入

`mcode/session/goal/*` 是 mcode 最有价值但 HAPI 此前完全未用的能力，且 **`goal/create` 会触发自主执行**（实测 21 秒消耗 16,725 tokens）。已实现：

- Web 端新增"创建目标"入口（目标描述 + token 预算）
- 接入 `goal/patch`（调整预算/状态）、`goal/clear`（中止）
- 接入 `goal/get` 做断线重连后的状态恢复（`goal_update` 是单向推送，CLI 重启后目标状态会丢）

### ✅ P1 — 委派中止

`mcode/session/delegation/stop` 让用户能在 Web 端点掉某个卡死的子 agent。此前 HAPI 只能看不能控，现已可中止；`delegation/get` 同样用于重启后的委派树恢复。

### ✅ P2 — Connector / App 工具可视化（已实施）

这是**产品层面最大的落差**。mcode 的整套 App 生态（Lark / Matrix / 邮件等 14 个 Connector）在 HAPI Web 端完全不可见：

- 会话内**能用**（agent 自行通过 Bash + skill 调用）
- 但用户**不知道存在**，也无法在 UI 里选择 App、查看已连接状态、上传资产（`mcode-tools upload-temp-url` / `get-asset-url` 无人调用）

已在 Web 端加只读"可用 App"面板：由 CLI 侧代理执行 `mcode-tools connector tools` / `auth`，展示已连接 App、工具清单与授权状态（Hub 路由 `GET /api/machines/:id/mcode-apps`）。详见 [§8.1](#81-connector--app-可视化)。

### ✅ P2 — 模型探针开销（已实施）

`listMcodeModelsForCwd` 每次缓存失效都会**完整 spawn 一个 `mcode acp` 进程**（约 2-3 秒启动开销）才能拿到模型目录。缓存 TTL 5 分钟、web staleTime 60 秒，意味着每台机器约每 5 分钟拉起一次完整 agent 进程。

已做的优化：探针 TTL 5 → 30 分钟 + 落盘缓存（`<HAPI_HOME>/mcode-model-probe/models.json`）。实测 `mcode provider list --json` 3.56s vs 完整 ACP 探针 5.17s——**进程 spawn 本身才是大头**，所以缓存是唯一有效的杠杆。详见 [§8.2](#82-模型探针开销)。

### ⚠️ P2 — 协议健壮性

- ✅ 扩展通知名改为动态订阅（见 P0，已完成）
- ✅ **`promptCapabilities.image: false` 不是用户限制**（实测推翻）：mcode 不接受 ACP 的 image 内容块，但 HAPI 的附件是以 `@path` 文本引用注入的，agent 会用自己的 `read`/`bash` 去读图。实测上传一张纯红 PNG，agent 用 python 解出 `[(255, 0, 0), 1024]` 并答"Red"。**原先建议的"提示用户 mcode 不支持图片"是错的，会误导用户**——不做。

### ✅ P3 — 会话 fork（已实施）

`sessionCapabilities` 已声明 `fork`，HAPI 未使用。对"从某条消息分叉出新会话"这类需求有直接价值。**实测发现 mcode 只能整会话 fork**（`session/fork` 的参数与 `session/load` 完全相同，没有 message 级变体），因此实施时只接"fork 当前会话"，并在 UI 上如实表达。详见 [§9 P3 实施记录](#9-p3-实施记录)。

---

## 6. 附：探测脚本

### 评估期探针（位于 `/tmp/`，仅用于评估，未进入仓库）

| 脚本 | 验证内容 |
|---|---|
| `mcode_acp_probe.mjs` | `initialize` 完整能力集、`session/new` configOptions |
| `mcode_meta_probe.mjs` | HAPI 的 `_meta` 扩展声明是否被 agent 接受 |
| `mcode_ext_probe.mjs` | `goal/create`、`goal/get`、`delegation/get`、`queue/list`、`session/activate` 可用性 |
| `mcode_schema_probe.mjs` | `goal/patch` / `goal/clear` / `delegation/stop` 的参数与返回形状 |
| `mcode_mcp_real_probe.mjs` | 真实 MCP stdio server 注入与调用（`env: []` 场景） |
| `mcode_slash_probe.mjs` | `/compact` 是否被 agent 拦截 |
| `mcode_two_procs.mjs` | 双进程 session 隔离 |
| `mcode_resume_probe.mjs` | 跨进程 `session/load` 历史保留 |
| `mcode_fork_probe.mjs` | `session/fork` 返回值与历史继承 |
| `mcode_fork_xproc.mjs` | 跨进程 fork/load（首次探针：轮次未结束导致 `message-boundary-not-found`） |
| `mcode_fork_idle.mjs` | **busy vs idle 的 fork 边界**、跨进程加载与历史继承 |

### 实施期联调脚本（**已进入仓库**）

`cli/scripts/verify-mcode-extensions.ts` —— 走 CLI 自己的 `AcpSdkBackend` + `McodeExtensionControl`，对真实 mcode 0.5.9 跑通 P0/P1 全链路。

```
cd cli && bun run verify:mcode-extensions
```

`cli/scripts/verify-mcode-fork.ts` —— 走 CLI 自己的 `AcpSdkBackend` + `McodeConversationHistory`，对真实 mcode 跑通 P3 全链路（能力探测 → 拒绝思考中 fork → 真实 fork → 新进程加载 fork 会话）。

```
cd cli && bun run verify:mcode-fork
```

`cli/scripts/verify-mcode-steer.ts` —— 走 CLI 自己的 `AcpSdkBackend` 与 launcher 完全相同的扩展调用，对真实 mcode 跑通 P4 全链路（无轮次时拒绝 → 轮次中 steer → agent 当场改口）。

```
cd cli && bun run verify:mcode-steer
```

---

## 7. 实施记录（P0 + P1）

P0 与 P1 已实现。改动横跨 `shared/` `cli/` `hub/` `web/` 四个包，共 24 个文件（+1765 / −51）。

### 7.1 P0 — 扩展能力动态探测

agent 在 `initialize` 响应的 `_meta["minimax-code/extensions"]` 中自述它支持的扩展方法与通知；mcode 用运行时 flag 裁剪 goal 整组方法。HAPI 现在读这份自述，不再假定方法存在。

| 改动 | 位置 |
|---|---|
| ACP 后端保留 agent 的 `_meta` 原文（后端保持 flavor 无关） | `cli/src/agent/backends/acp/AcpSdkBackend.ts` — `getInitializeMeta()` |
| 解析自述 → 方法/通知集合 | `cli/src/mcode/utils/mcodeExtensions.ts` — `parseMcodeExtensionSupport()` |
| 集合 → Web 可读的语义能力位 | 同上 — `toMcodeExtensionCapabilities()` |
| 通知按自述过滤，未自述的一律忽略 | `cli/src/mcode/mcodeRemoteLauncher.ts` — `supportsExtensionNotification()` |
| 能力位随会话 metadata 下发 | 同上 — `publishExtensionCapabilities()`；`shared/src/schemas.ts` — `SessionCapabilitiesSchema.mcodeExtensions` |

能力位语义：`goal` / `goalCreate` / `goalPatch` / `goalClear` / `delegation` / `delegationStop`。

### 7.2 P1 — 目标生命周期与委派中止

先从 mcode 包内反查出了每个方法的**精确线上格式**（参数、返回、错误语义），再据此实现：

| 方法 | 参数 | 返回 |
|---|---|---|
| `mcode/session/goal/get` | `{sessionId}` | `{goal \| null}` |
| `mcode/session/goal/create` | `{sessionId, objective, tokenBudget?}` | `{goal}` |
| `mcode/session/goal/patch` | `{sessionId, status?, objective?, tokenBudget?}` | `{goal}` |
| `mcode/session/goal/clear` | `{sessionId}` | `{cleared}` |
| `mcode/session/delegation/stop` | `{sessionId}` | `{receipt}` |

其中 `status` 可选值为 `active / paused / blocked / complete / budget_limited`（`usage_limited` 由 agent 自行推导，不可置入）；`tokenBudget` 为 `null` 表示不限额。

`mcode/session/delegation/get` 同为**状态恢复**接口，返回 `{snapshot}`，用于 CLI 重启后补回委派树。

实现落点：

- **CLI 扩展控制层** `cli/src/mcode/utils/mcodeExtensionControl.ts`（新）——每个调用都先查自述面，未广告的方法**根本不发起调用**，直接返回可读的 "not advertised"。
- **CLI 会话接线** `cli/src/mcode/mcodeRemoteLauncher.ts`——注册 4 个 RPC handler；创建/修改目标后把 agent 返回的目标转成会话事件；清理时把能力位置为"关"。
- **状态恢复** `restoreGoalState()` / `restoreDelegationState()`——目标和委派树都是单向推送，CLI 重启后 Web 会同时丢失两者；启动时主动 `goal/get` + `delegation/get` 各补齐一次。
- **协议** `shared/src/rpcMethods.ts`（4 个新方法）、`shared/src/apiTypes.ts`（请求/响应类型与 Zod schema）、`shared/src/schemas.ts`（能力位）。
- **Hub** `hub/src/sync/rpcGateway.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/sessions.ts`——`POST/PATCH/DELETE /sessions/:id/mcode/goal`、`POST /sessions/:id/mcode/delegation/stop`，均校验 flavor 为 `mcode`。
- **Web** `web/src/api/client.ts`、`web/src/components/SessionStatusPanel.tsx`、`web/src/components/SessionChat.tsx`——会话状态面板新增"设定目标 / 暂停 / 继续 / 清除目标"与"停止子 agent"，**只在 agent 广告了对应能力时出现**；三种语言补齐文案。

### 7.3 验证

| 检查 | 结果 |
|---|---|
| `bun typecheck`（cli/web/hub/relay） | ✅ exit 0 |
| `bun run test:cli` | ✅ **3246 passed / 0 failed**（+52 新增用例），275 文件通过 / 3 跳过 |
| `bun run test:web` | ✅ **3432 passed / 0 failed**（+8 新增用例），310 文件通过 |
| `bun run test:hub` | ✅ **1401 passed / 0 failed**（+5 新增路由用例） |
| `bun run test:shared` | ✅ **349 passed / 0 failed**（+5 新增用例） |
| `bun run test:relay` | ✅ 118 passed / 0 failed（未受影响） |
| **真实 agent 联调** `cli/scripts/verify-mcode-extensions.ts` | ✅ `goal/{get,create,patch,clear}`、`delegation/{get,stop}` 全部对真实 mcode 0.5.9 成功 |

联调脚本走的是**已发布的代码路径**（CLI 自己的 `AcpSdkBackend` + `McodeExtensionControl`），不是另写一份探针：

```
P0 capabilities: {"goal":true,"goalCreate":true,"goalPatch":true,"goalClear":true,"delegation":true,"delegationStop":true}
P1 goal/get before create: {"success":true,"goal":null}
P1 goal/create:            {"success":true,"goal":{"goalId":"tg_…","status":"active","tokenBudget":1000, …}}
P1 goal/get after create:  {"success":true,"goal":{"goalId":"tg_…", …}}
P1 goal/patch:             {"success":true,"goal":{"status":"paused","statusReason":"paused(user_requested)", …}}
P1 delegation/stop:        {"success":true,"receipt":{"rootStopped":true, …}}
P1 delegation/get:        {"schemaVersion":1,"rootSessionId":"mvs_…","members":[]}
P1 goal/clear:             {"success":true,"cleared":true}
P1 goal/get after clear:   {"success":true,"goal":null}
```

复现命令：`cd cli && bun run verify:mcode-extensions`

### 7.4 实现过程中发现并规避的坑

1. **状态位拼写两套**——HAPI 用 `budgetLimited`，agent 用 `budget_limited`。转换收口在 `toMcodeGoalPatchStatus()` 一处，且 `usageLimited` 明确拒绝（agent 无法被要求进入该状态）。
2. **metadata 合并不删键**——hub 合并 CLI 的 metadata 写入，删掉字段不会生效。清理时改为显式下发"全 false"能力位，而不是把键设为 `undefined`。
3. **`tokenBudget: null` 有歧义**——`null` 既可能是"不限额"，也可能是"没传"。读参时区分 `null` 与 `undefined`，避免把"未设置预算"误当成"不限额"发出去。
4. **目标创建会立即开跑**——`goal/create` 不是待审批请求，agent 立刻开始执行。Web 端在表单里显式提示，避免用户误以为是"保存一条待办"。
5. **空会话面板不渲染**——会话状态面板在没有目标/任务/子 agent 时返回 `null`，于是"设定目标"按钮永远不出现，用户无法创建第一个目标。改为：agent 广告了 `goal/create` 时面板强制可见（`buildSessionStatusData({ alwaysVisible })`）。

---

## 8. P2 实施记录

### 8.1 Connector / App 可视化

**问题**：mcode 的整套 App 生态（Lark / Matrix / 邮件等）在 HAPI Web 端完全不可见。会话里**能用**（agent 自己通过 Bash + `mcode-tools-master` skill 调用），但用户不知道存在。

**为什么不能走协议**：Connector 工具**既不在 ACP 表面、也不在 MCP 表面**——agent 只能通过 `mcode-tools` CLI + skill 触达。所以外部客户端无法从协议侧观测到它们。

**做法**：CLI 直接问 `mcode-tools` 要清单。

| 改动 | 位置 |
|---|---|
| 解析 `mcode-tools` 二进制：取 `mcode` 的**同级**（自定义 `HAPI_MCODE_PATH` 指向的那个安装，才共享同一份 auth lease），否则退回 PATH | `cli/src/mcode/utils/mcodeConnectorTools.ts` — `resolveMcodeToolsCommand()` |
| 调 `mcode-tools connector tools` + `mcode-tools auth status`，按 provider 归组 | 同上 — `listMcodeConnectorApps()` |
| 机器级 RPC | `shared/src/rpcMethods.ts` — `ListMcodeApps` |
| Hub 路由 | `hub/src/web/routes/machines.ts` — `GET /api/machines/:id/mcode-apps` |
| Web 查询 + 面板区块 | `web/src/hooks/queries/useMcodeApps.ts`、`web/src/components/SessionStatusPanel.tsx` |

**两个刻意的设计**：

1. **"没有 App" 和 "没查到 App" 必须区分**。CLI 读不到清单时返回 `error` 而不是空列表——否则用户会以为没连 App，而真相是 HAPI 没查到。
2. **`mcode-tools` 的路径跟随 `mcode`**。`HAPI_MCODE_PATH` 指向特定安装时，那个安装自带的 `mcode-tools` 才是共享同一份 oauth lease 的那个；用 PATH 上别的会读到不同的 auth 状态。

**读一次要两个进程 spawn**（`auth status` + `connector tools`），所以 CLI 侧加了 5 分钟缓存：

- **失败不缓存**——读不到就该下次再试，不能把"查不到"缓存成"没有"。
- **auth lease 过期就不给缓存**——租约没了说明连接状态可能变了，缓存的清单不再可信。

实测（真实 mcode 0.5.9 + 真实 `mcode-tools`）：

```
resolved command: mcode-tools
auth: {"status":"authenticated","authMode":"shared-broker","scope":"agent.default","expiresAt":1792606404164}
apps:
  - email_workbench_credentials (2 tools)
  - matrix (13 tools)
```

**Web 端两个落点**：

| 位置 | 作用 |
|---|---|
| **新建会话页**（模型选择器下方） | 用户决定要 agent 做什么的时候，先看到能触达哪些 App |
| **会话状态面板**（"已连接的应用"区块） | 会话运行中的上下文 |

### 8.2 模型探针开销

**实测数字**：`mcode provider list --json` 3.56s；完整 ACP 探针 5.17s（含 bun 启动）。**进程启动本身就是成本**，换命令省不下来——所以杠杆只有缓存。

**做法**：

| 改动 | 说明 |
|---|---|
| TTL 5 分钟 → **30 分钟** | 模型目录来自 provider 配置，几乎不变；原来每 5 分钟就要付一次进程启动 |
| 结果**落盘**到 HAPI home（`mcode-model-probe/models.json`） | runner 重启后第一次建会话也不用再付一次探针 |
| 原子写（临时文件 + rename） | 与已有的 probe session 文件同一套写法 |

**没有做的**：报告原先建议"探针走 `session/new` 而非 `session/load`"——**这条是错的**。mcode 没有 ACP delete，每次 `session/new` 都会在它的数据目录里永久留下一个会话；复用 `session/load` 正是为了避免会话堆积。已从建议中移除。

### 8.3 "图片输入提示"——实测推翻，不做

报告原先建议："`promptCapabilities.image: false` → Web 端提示用户 mcode 不支持图片"。

**实测证明这条是错的**：

```
TOOL >> read      → "Read image file [image/png]"
TOOL >> bash      → "[((255, 0, 0), 1024)]"
ANSWER: Red
```

`promptCapabilities.image: false` 的含义是 agent **不接受 ACP 的 image 内容块**。但 HAPI 的附件是以 `@path` **文本引用**注入的，agent 会用自己的 `read` / `bash` 去读图——实测上传一张纯红 PNG，agent 用 python 解出像素并答对。

所以这条提示会**误导**用户说 agent 看不了图。**不做。** 这是"先量再改"的另一个例子：能力位读错了方向就会变成假限制。

### 8.4 P2 验证

| 检查 | 结果 |
|---|---|
| `bun typecheck`（cli/web/hub/relay） | ✅ exit 0 |
| `bun run test:cli` | ✅ **3267 passed / 0 failed**（新增 21 个：16 connector + 5 探针缓存），280 文件 |
| `bun run test:web` | ✅ **3434 passed / 0 failed**（新增 2 个新建会话页用例），310 文件 |
| `bun run test:hub` | ✅ **1404 passed / 0 failed**（新增 3 个路由用例） |
| `bun run test:shared` | ✅ 349 passed / 0 failed（未受影响） |
| `bun run test:relay` | ✅ 118 passed / 0 failed（未受影响） |
| **真实 `mcode-tools` 联调** | ✅ 2 个 provider / 15 个工具，auth 状态正确读取 |
| **真实图片能力实测** | ✅ 纯红 PNG 经 `@path` → agent 解出 `(255,0,0)` 并答对，推翻"不支持图片"的建议 |

---

## 9. P3 实施记录（会话 fork）

### 9.1 先量：mcode 的 fork 到底怎么工作

写代码前先用真实 agent（0.5.9）测了三件事，结论**推翻了最初的假设**。

**（a）`session/fork` 的参数与 `session/load` 完全相同**（从 bundle `chunks/run-acp-command-SBE5PYAH.js` 反解 + 实测）：

```js
ed = z.object({ sessionId, cwd, additionalDirectories?, mcpServers?, _meta? })   // session/fork
td = z.object({ sessionId, cwd, additionalDirectories?, mcpServers?, _meta? })   // session/resume
Xl = z.object({ sessionId, cwd, additionalDirectories?, mcpServers?, _meta? })   // session/load
```

**没有 message 级参数** → mcode 只能整会话 fork，"从某条消息分叉"在 mcode 上不存在。

**（b）fork 只能发生在"已完成的 assistant 轮次边界"上，且要求会话 idle。** 实测：

| 时机 | 结果 |
|---|---|
| 轮次进行中 fork | ❌ `-32602 Invalid params: message-boundary-not-found` |
| 轮次结束后 fork | ✅ 返回 `{sessionId, modes, configOptions}` |

bundle 里的判定函数给出了规则（`chunk-QEPCDCRA.js`）：

```js
function RRn(t, e, r = !1) {                       // r = true 表示"当前边界"
  return t
    ? (t.assistant.role !== "assistant" || PRn(t)
        ? { canFork: !1, unavailableReason: "message-boundary-invalid" }
        : ARn(t)
          ? { canFork: !1, unavailableReason: "message-boundary-not-found" }
          : CRn(t, e, r)
            ? { canFork: !0 }
            : { canFork: !1, unavailableReason: "message-boundary-invalid" })
    : { canFork: !1, unavailableReason: "message-boundary-not-found" }
}
```

即：边界必须是 assistant 消息、可达，且（当前 fork 时）`isLatestConversationMessage && state === "idle"`。

**（c）fork 出的会话能被新进程加载，并继承历史**（跨进程实测）：

```
A session      >> mvs_8cda3681a6c74370a41e6347b83d3e3a
fork WHILE idle>> SUCCEEDED id=mvs_3cc0641bd1e84c5f8cf7035f2b0e1321
B load         >> OK
B inherits history >> true
B answer       >> FORK_XPROC_MAGIC_42
```

补充：`session/load` 的**响应里没有 sessionId**（和 `session/resume` 一样），HAPI 的 `AcpSdkBackend.loadSession` 靠 `loadedSessionId ?? config.sessionId` 兜底回到请求 id——所以子进程能绑定到 fork 出来的 id。

### 9.2 实施中发现的真问题：native id 的"发布时机"

最初的实现里，hub 会在建子会话时把 fork 出的 native id **预置**进子会话 metadata：

```ts
childMetadata.mcodeSessionId = rpcResult.nativeSessionId
```

同时 CLI 侧 `mcode/loop.ts` 会在 ACP 握手**之前**就把 `--resume` 带来的 id 上报给 hub（`session.onSessionFound(opts.resumeSessionId)`）。

结果：hub 里那个"等子会话绑定到确切 fork id"的守卫（`waitForExactNativeForkBound`）**是空的**——它读到的 `mcodeSessionId` 一开始就等于期望值，子会话其实还没加载任何东西。守卫会立刻返回"绑定成功"，而 mcode launcher 在 `session/load` 失败时**会回退到一个空白会话**——于是一个空线程看起来像一次成功的 fork。

同样的模式在 grok 分支上也是空的（既有代码，未在本次范围内改）。pi 分支靠 `session-ready` 事件补上了栅栏，mcode 没有这个事件。

**修法（两处一起改才有意义）：**

1. CLI：`mcode/loop.ts` 不再提前上报"请求的 id"；`mcodeSessionId` 只由 launcher 在 **ACP 会话真正建立后**发布，代表"agent 实际在跑的 native session"。`McodeSession` 构造时已经把 `sessionId` 设为 `opts.resumeSessionId`，launcher 照常用它去 `session/load`，不影响恢复。
2. Hub：不再预置子会话的 `mcodeSessionId`。

改完之后 `waitForExactNativeForkBound` 变成真检查：

| 子会话实际情况 | metadata | 守卫结果 |
|---|---|---|
| 还没建立 | 无 `mcodeSessionId` | 继续等 |
| 加载成功 | `mcodeSessionId` == fork id | ✅ 通过 |
| 加载失败回退空白会话 | `mcodeSessionId` == 另一个 id | ❌ 判失败 → 清理子会话并报错 |
| 子进程没起来 | 无 | 5s 后判失败 |

### 9.3 行为约定

| 场景 | 行为 |
|---|---|
| 思考中点 fork | CLI 侧直接拒绝：`MiniMax Code is still working on a turn; fork it once the turn ends`（hub 侧本来就有 `Session is busy` 闸门） |
| 请求"在某条消息处分叉" | 拒绝：`Historical fork is not supported for MiniMax Code`——不拿整会话 fork 冒充 |
| agent 内部报错 `message-boundary-not-found` | 转成可读提示：`MiniMax Code can only fork at the end of a finished turn` |
| agent 没有 `session/fork` | 能力位标记为不支持，之后不再调用该方法 |

Web 端**无需改动**：消息操作区的 fork/rewind 按钮本来就在 `thread.isRunning`（= `session.thinking`）时隐藏，所以"思考中不给 fork 入口"这条已经成立。

### 9.4 验证

| 检查 | 结果 |
|---|---|
| `bun typecheck`（cli/web/hub/relay） | ✅ exit 0 |
| `bun run test:cli` | ✅ **3282 passed / 0 failed**（新增 15 个：12 能力/行为 + 3 launcher 接线） |
| `bun run test:hub` | ✅ **1407 passed / 0 failed**（新增 3 个 fork 集成用例） |
| `bun run test:web` / `test:shared` / `test:relay` | ✅ 310 文件 / 349 / 118，0 failed |
| **真实 mcode 联调**（`cli && bun run verify:mcode-fork`） | ✅ 能力探测 → 拒绝思考中 fork → 拒绝历史 fork → 真实 fork → **新进程加载 fork 会话并答出 `FORK_VERIFY_MAGIC_77`** |

联调脚本 `cli/scripts/verify-mcode-fork.ts` 走的是 CLI 自己的 `AcpSdkBackend` + `McodeConversationHistory`，不是另写一套。

### 9.5 剩余扩展面的价值判断（逐项实测后决定做/不做）

agent 广播 15 个方法 / 4 个通知。P1 之后还剩 **9 方法 + 2 通知**。逐项实测结论：

| 剩余能力 | 实测行为 | 结论 |
|---|---|---|
| `mcode/session/steer` | 运行中的轮次里 steer 返回 `{turnId, mode:"steered"}`，指令当场落进该轮次 | ✅ **已实施（P4）** |
| `mcode/session/queue/{list,enqueue,update,delete,steer}` + `queue_update` | 全部可用，条目带 content/attachments/modelInfo/createdAt | ❌ **不做**（见下） |
| `session/activate` / `mcode/session/activate` + `current_session_update` | 可用，返回 `{sessionId}` 并推通知 | ❌ **不做**（见下） |
| `session/resume` | 可用，但**不返回 sessionId**（进程内重挂） | ❌ **不做**（见下） |

**为什么原生队列不做**：它是**第二个队列**。HAPI 的队列在 hub 侧（uninvoked 消息），web 的排队区 UI、编辑、取消、定时投递全部以它为准；让 mcode 改用 agent 自己的队列，等于在一个跨 flavor 的子系统上制造分叉或双份真相。而且实测它的语义不是通用"等待区"：空闲时 `enqueue` 会直接开一轮（随后 `session/prompt` 被拒：`Session already has an active Turn. Use queue send to deliver the message after it.`），只有排在活跃轮次后面时 `list` 才有内容。

**为什么 activate / current_session_update 不做**：HAPI 是**一个进程一个会话**，进程里永远只有一个 session，"当前会话"恒等于它自己，通知只会回声同样的 id。这是 mcode 自己 TUI 的多会话模型。

**为什么 resume 不做**：HAPI 每次新进程按 id 加载，走 `session/load`（已实测跨进程加载保留历史）；`session/resume` 适配"长驻进程托管多会话"，与 HAPI 的 runner 模型不合。

### 9.6 实施中修正的一处判断

最初把"steer"理解为"把排队消息提前投递"，实测发现 mcode 的 steer 是**真·轮次内注入**（和 codex 同级）：agent 正在数 1~40，被 steer 后当场改口输出 `STEER_ACK`。这比"下一轮才说"强得多，也就让 mcode 值得接——HAPI 的这条产品链路（排队消息上的 Steer 按钮 → `POST /messages/:id/steer` → `SteerQueuedMessage` RPC）本来就为 Pi/Codex/Cursor 而建，mcode 只是第四份实现。

---

## 10. P4 实施记录（steer）

### 10.1 接线

| 层 | 改动 |
|---|---|
| `shared/src/modes.ts` | `STEERING_SUPPORTED_FLAVORS` 增加 `mcode`；`isSteeringSupportedForSession` 对 mcode 放行 |
| `cli/src/mcode/mcodeRemoteLauncher.ts` | 注册 `SteerQueuedMessage` handler：`mcode/session/steer` 注入运行中的轮次；轮次在飞时发布 `agentState.steeringActive` |
| `hub/src/sync/syncEngine.ts` | 不支持 flavor 的拒绝文案补上 MiniMax Code |
| Web / iOS / Android | **无需改动**：web 用 `agentState.steeringActive`、native 用 `thinking && active`，都不按 flavor 白名单 gating，hub 侧统一判定 |

### 10.2 语义与失败处理

| 场景 | 行为 |
|---|---|
| 轮次在飞 + 消息在队列 | `takeByLocalId` 取走消息 → `mcode/session/steer` → agent 回 `mode:"steered"` → `commitReservation` + `emitMessagesConsumed([localId], {steered:true})` |
| 没有活跃轮次 | 直接拒绝：`MiniMax Code has no running turn to steer`（不发请求） |
| agent 拒绝（例如轮次在请求途中结束） | **消息放回队列**（`restoreReservation`），错误透出；正常循环会在轮次结束后投递它 |
| agent 未广播 `mcode/session/steer` | 拒绝：`MiniMax Code did not advertise the steer extension`——未广播的方法绝不调用（与 P0 同一条规则） |
| 请求被重试 | 带上 `clientRequestId`（= HAPI 的 localId）作为 agent 的幂等键 → 同一消息不会被注入两次 |

### 10.3 验证

| 检查 | 结果 |
|---|---|
| `bun typecheck`（cli/web/hub/relay） | ✅ exit 0 |
| `bun run test:cli` | ✅ 3286 passed / 0 failed（新增 4 个 steer 用例） |
| `bun run test:shared` | ✅ 349 passed / 0 failed（steer flavor 闸门断言） |
| `bun run test:hub` | ✅ 1408 passed / 0 failed（新增 1 个 mcode steer 集成用例） |
| `bun run test:web` / `test:relay` | ✅ 3438 / 118，0 failed |
| `bun run gen:fixtures` | ✅ 无漂移（native 契约未受影响） |
| **真实 mcode 联调**（`cli && bun run verify:mcode-steer`） | ✅ 无轮次时 agent 拒绝（`Steering requires an admitted, active ACP prompt Turn`）→ 轮次中 steer 返回 `{turnId, mode:"steered"}` → **agent 当场改口 `STEER_ACK`** |

联调脚本 `cli/scripts/verify-mcode-steer.ts` 发的是与 launcher **完全相同形状**的调用（含 `clientRequestId` 幂等键）。

---

## 11. 复审与修复记录（实施后审计）

P0–P4 落地之后，重新做了一次**实施后审计**：把实现逐条对着本机真实的 `@minimax-ai/code@0.5.9` 复核，代码里的每个假设都用实机探针验一遍，而不是只读代码。

方法上有三条纪律，后面几个结论都靠它才成立：

1. **凡是"看起来对"的都要探针证伪。** 用例：用量统计一度被怀疑读错了 transcript 结构（真实结构是 `entry.message.usage` 嵌套），实跑 HAPI 自己的 `parseMcodeUsageLine` 之后，79 条记录与 agent 自己的 `local_runtime_token_usage` 表**逐项一致**——那条怀疑是错的。
2. **子代理的"确认 bug"也要复核。** 深审分支报了 3 条，其中 2 条的**触发条件在 v0.5.9 上不成立**（见下），被实机数据推翻。
3. **修不动就降级为"潜在风险"并写清依据**，不写成 bug。

### 11.1 修掉的 bug

| 严重度 | 问题 | 症状 | 修复 |
|---|---|---|---|
| 高 | abort 落在「取队列 → 发起 prompt」之间 | 用户点了 Stop，agent 照样干活 | prompt 请求发出后紧跟一条 `session/cancel`（传输层保序，agent 先注册轮次再取消）→ 实测 `stopReason: cancelled`、零输出 |
| 高 | goal 工具卡状态用 snake_case 渲染 | 预算耗尽时徽章显示字面量 `budget_limited` | 状态映射上提到 shared 单点（`MCODE_GOAL_STATUS_MAP`），CLI 与 web 共用 |
| 高 | ru 语言包缺全部 14 个 `tool.goal.*` | 俄语界面里 goal 卡片整块英文 | 补齐；顺带补上 zh-CN 缺的 6 个 `newSession.agyModel.*`；新增 locale 键集对齐测试 |
| 中高 | `HAPI_MCODE_PATH` 是幽灵变量 | 多套安装时"已连接应用"读的是另一套的 oauth lease | `getAgentLaunchCommand` 真正读取它，同级 `mcode-tools` 解析随之可达 |
| 中高 | agent 退出后 `conversationHistory.forkCurrent` 仍为 true | 死 Fork 按钮，每次点都报 "MiniMax Code session is not ready" | `cleanup()` 时下线历史能力（pi flavor 早有同样处理） |
| 中 | 会话 inactive 时仍显示 goal 控件 | 点一下弹出原始 HTTP 409 JSON | inactive 时不提供控件；409 归类为可读文案 |
| 中 | steer 传输失败时把消息放回队列 | agent 可能已注入，hub 会重放 → 消息跑两遍 | 改为 indeterminate 持有（对齐 cursor/codex），并持久化 dispatching 态 |
| 中 | ACP 传输层丢弃 `error.data` | agent 的 "Unfinished thread goal already exists" 变成 "Internal error" | 保留 `error.data.details` |
| 中 | 连接器 auth 读取失败被缓存 | 面板显示 "unknown" 整个 TTL | 读取失败不写缓存 |
| 低 | agent 自行换模型后 hub 仍宣称旧模型 | 会话头显示的不是 agent 实际在跑的模型 | 监听 config options 更新并跟随 |
| 低 | fork 边界错误码只覆盖 2 种拼写 | 另两种拼写把协议码抛给用户 | 覆盖 agent 的全部拼写 |

### 11.2 被实机推翻的两条

| 分支结论 | 实测结果 | 处置 |
|---|---|---|
| 切模型后 effort 描述符陈旧 | agent 的 `config_option_update` **先于** `set_config_option` 响应送达，launcher 的等待缓解有效；且 v0.5.9 的 effort 档位与模型无关 | 降级为潜在风险 |
| agent 复述旧模式导致 hub 显示用户没选过的权限模式 | agent 复述的是**新**模式（`Yx()` 里 `a !== i` 才通知） | 不成立；但保留一条改进——`session/set_mode` 返回 `_meta["minimax-code/transition"]`（`next_prompt` / `settled`），HAPI 丢弃了它，模式实际是延迟生效的 |

### 11.3 复核后确认是好的（别去动）

扩展面宣告与文档完全一致（15 methods + 4 notifications）；权限模式双轴映射正确（agent 只接受 `default|auto|bypassPermissions`）；steer 回合生命周期对称置位；ask_user 问卷的 hint 在 `elicitation/create` 到达时消费；会话目录定位与 `runtime-state.sqlite` schema 吻合；`rewindToMessage: unsupported` 是对的（agent 的 ACP 面根本没有 rewind 方法）；用量统计与 agent 账本逐项一致；`session/prompt` 紧跟 `session/cancel` 确实能取消（实测 `stopReason: cancelled`）。

### 11.4 验证

| 检查 | 结果 |
|---|---|
| `bun typecheck`（cli/web/hub/relay） | ✅ exit 0 |
| `bun run test:cli` | ✅ 3293 passed / 0 failed（新增 7 个用例） |
| `bun run test:shared` | ✅ 353 passed / 0 failed |
| `bun run test:web` | ✅ 3442 passed / 0 failed（新增 locale 对齐用例） |
| `bun run test:hub` | ✅ 1411 passed / 0 failed |
| `bun run test:relay` | ✅ 118 passed / 0 failed |
| **真实 mcode 联调** | ✅ extensions / fork / steer 三个脚本全部通过 |
| **新增实机探针** | 扩展面、模型 id 编码、config options、模式延迟切换、goal 重复创建的错误形状、prompt+cancel 取消时序 |

## 12. "Session already has an active Turn" —— 定位与修复

### 12.1 现象

用户在 web 里发消息，聊天里冒出一条：

```
MiniMax Code prompt failed: Internal error: MiniMax Code Runtime failed: Session already has an active Turn. Use queue send to deliver the message after it.
```

用户必须把同样的话再发一遍才生效。

### 12.2 根因（实机证据链）

1. **agent 侧**：MiniMax Code 给每个 native session 一把"轮次租约"（`local_runtime_session_locks`，`owner_kind='turn'`，`owner_id='turn-lease:<pid>:<uuid>.<uuid>'`）。持有租约期间再来一个 `session/prompt`，直接被拒，并让调用方"之后用 queue send 补发"。
2. **时间线对齐**（`~/.hapi/logs/2026-10-22-07-59-30-pid-735953.log` + agent 的 `local_runtime_turn_ingress` 台账）：

   | UTC 时刻 | 事件 |
   |---|---|
   | 00:26:46.366 | 一个 `source: background-task` 的轮次开始（`client_request_id: bg_c8b63d6e-…`，即 HAPI 自己派出的后台子代理任务），占用同一 native session 的租约 |
   | 00:29:03.076 | 用户消息被取走 → `prompt failed: … active Turn`（**第 1 次拒绝**） |
   | 00:29:26.639 | 用户重发 → 再次 `prompt failed`（**第 2 次拒绝**） |
   | 00:29:29.920 | 后台轮次结束，租约释放 |
   | 00:29:43.582 | 用户第 3 次发送 → **4ms 后轮次就被接受** |

   也就是说：**refuse 的是"轮次还没结束"，不是消息本身**；后台子代理任务跑在同一 native session 上，前台消息撞进这个窗口就被拒。
3. **另一个触发条件**：两个存活的 ACP 客户端挂在同一个 native session 上（本地 TUI、第二个 runner）同样触发——已用两个 `mcode acp` 进程实机复现，错误串完全一致。
4. **同一族的另外两种拒绝**：agent 的错误映射里还有 `local_session_compacting`（"Session compaction is active"）和 `local_session_mutating`（"Session conversation is being changed"），都是 409、都会随 agent 做完手上的事而结束，属于同一类"临时拒绝 → 消息丢失"的缺陷，一并纳入修复。
5. **租约不是"卡死 30 分钟"**：`expires_at_ms = acquired + 30min` 只是上限；agent 另有运行时恢复循环（约 10s 一轮，靠 pid + 进程启动 token 判活）。实测持有者被 `SIGKILL` 后，session 分别在 **31s / 78s** 后恢复，远早于 30 分钟。
6. **被拒绝的 prompt 不进 transcript**：重试不会让消息在 agent 上下文里出现两次（实测 transcript 里只有 1 条 user + 1 条 assistant）。

### 12.3 修复

`cli/src/mcode/mcodeRemoteLauncher.ts`：把"临时拒绝"从**致命错误**改回**可重试状态**。

- 识别 agent 的三种 409 拒绝（`session already has an active turn` / `session compaction is active` / `session conversation is being changed`）→ 把被拒的批次**原样放回队列**（`unshift` 逆序恢复，保住 `isolate` 形态、每条消息的 localId，**并保住用户消息的先后顺序**）→ 退避重试（1s 起，按次数递增，10s 封顶）。
  - 这里跟 claude flavor 的既有做法对齐（`claudeRemoteLauncher` 在 SDK 调用失败时用 `queue.unshift()` 恢复在途批次）：如果改用"push 到队尾"，被拒的消息会被排在它后面那些消息的**后面**，用户读到的顺序就乱了。
- 关键是**消息不能再丢**：批次出队时就已经 ack（`onBatchConsumed`），失败不回滚等于用户的话凭空消失——这正是用户当时不得不重发两遍的原因。
- 用户提示改成可执行的话："MiniMax Code 正忙（它自己跑的任务，或另一个窗口占着这个 session），你的消息已保留，轮次一结束就发出去"，并在一分钟后升级为"仍然很忙"提示。原始 agent 错误串不再直接甩给用户（它指向一个用户够不到的机制）。
- 等待放在轮次清理**之后**：等待期间 agent 并没有在跑，会话不该显示成 busy（否则会给"Steer"按钮一个不存在的轮次）。

### 12.4 实机验证

| 检查 | 结果 |
|---|---|
| launcher 回归测试（新增 5 个用例） | ✅ 50 passed；**把实现还原到 HEAD 后两个用例失败**（`expected "vi.fn()" to be called 4 times, but got 1 times`）；把 `unshift` 换回 `push`，保序用例失败（`expected "second" to deeply equal "first"`） |
| 实机重试投递（A 占着轮次，B 用退避重试同一条消息） | ✅ 3 次拒绝后第 4 次被接受（9s），`stopReason: end_turn` |
| 实机去重（检查 native transcript） | ✅ 只有 1 条 user + 1 条 assistant，被拒的 prompt 零残留 |
| compaction / 会话变更两种拒绝 | ⚠️ 只做了单测（无法稳定触发实机 compaction）；依据是 agent 自己的 409 错误映射，两者与 busy 同族、同样会随 agent 收工而结束 |

### 12.5 已知限制（未修，说明依据）

重入队的消息只活在 CLI 进程内存里：hub 侧那条消息早已被 ack（`markMessagesInvoked` 只作用于 `invoked_at IS NULL` 的行），CLI 在等待期间被杀掉就会丢。彻底解决要把 ack 推迟到"agent 接受轮次"之后——`agy` flavor 已经是这个模型（`acknowledgeMessagesOnDequeue: false` + 手动 `emitMessagesConsumed`）——但那会改动 MiniMax Code **所有**消息的投递契约（hub 的排队浮条、取消语义、seq 回填都要跟着核），不属于本次修复范围，故留作后续项而不是顺手改掉。

