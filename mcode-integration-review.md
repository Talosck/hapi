# MiniMax Code (mcode) ↔ HAPI 集成评估

**评估对象**：`mcode` v0.5.9 (`@minimax-ai/code`) ↔ HAPI 仓库 `/home/talos/coding/hapi`
**评估日期**：2026-10-21
**结论**：集成质量高，未发现硬性对接 Bug；主要问题是 **能力缺口**（mcode 提供但 HAPI 未接入的扩展方法）与 **若干可优化点**。

> **实施状态（2026-10-21）**：本报告的 **P0** 与 **P1** 已实现并验证，详见 [§7 实施记录](#7-实施记录)。
> **P2**（Connector/App 可视化、模型探针开销）未实施，仍为建议。

---

## 0. 结论摘要

| 维度 | 评价 | 说明 |
|---|---|---|
| 协议契合度 | ✅ 优秀 | HAPI 发出的 `initialize` 能力声明与 mcode 实际实现逐项吻合；扩展方法名、config option id、模型 id 编码全部对得上 |
| 对接 Bug | ✅ 未发现 | 12 项重点怀疑全部实测排除（含 2 个初判为 bug 的误报） |
| 能力覆盖 | ⚠️ 部分接入 | **已接入**：`goal/{get,create,patch,clear}`、`delegation/{get,stop}`（P1）；**仍未接入**：`steer`、`queue/*` |
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
| `model` | `model` | `m:<provider>:<model>:u` 或 `m:<provider>:<model>:v:<variant>` | session |
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
| **G3** | `mcode/session/steer` | ❌ 未使用 | 无法在 agent 执行中途插入指令 |
| **G4** | `mcode/session/queue/{list,enqueue,update,delete,steer}` | ❌ 未使用，HAPI 自建客户端队列 | 无原生队列的 steer/delete 语义 |
| **G5** | `mcode/session/current_session_update`、`queue_update` | ❌ 通知被丢弃 | 丢失 session 切换/队列状态信号 |
| **G6** | `session/fork`、`session/resume`（`sessionCapabilities` 已声明） | ❌ 未使用 | 无法 fork 会话 |
| **G7** | Connector / App 工具 | ⚠️ 会话内可用（经 Bash），但 Web 端**完全不可见** | 用户无法发现可用 App、无 App 选择器、无资产上传入口 |
| **G8** | `promptCapabilities.image: false` | ⚠️ HAPI 附件按文本 `@path` 注入 | 行为正确，但 UI 未提示"图片不可用" |

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

### ❌ P2 — Connector / App 工具可视化

这是**产品层面最大的落差**。mcode 的整套 App 生态（Lark / Matrix / 邮件等 14 个 Connector）在 HAPI Web 端完全不可见：

- 会话内**能用**（agent 自行通过 Bash + skill 调用）
- 但用户**不知道存在**，也无法在 UI 里选择 App、查看已连接状态、上传资产（`mcode-tools upload-temp-url` / `get-asset-url` 无人调用）

建议在 Web 端加一个只读的"可用 App"面板：调用 `mcode-tools connector tools` 展示已连接 App 与工具清单（注意：需在 CLI 侧代理执行，因为 `mcode-tools` 依赖 mcode 进程环境）。

### ❌ P2 — 模型探针开销

`listMcodeModelsForCwd` 每次缓存失效都会**完整 spawn 一个 `mcode acp` 进程**（约 2-3 秒启动开销）才能拿到模型目录。缓存 TTL 5 分钟、web staleTime 60 秒，意味着每台机器约每 5 分钟拉起一次完整 agent 进程。

可选优化：
- 延长 probe 缓存 TTL（当前 5 分钟偏短，模型列表变动极少）
- 复用常驻 mcode 进程而非每次新建
- 走 `session/new` 而非 `session/load` 的轻量路径（探测目录本身不需要加载历史会话）

### ⚠️ P2 — 协议健壮性

- ✅ 扩展通知名改为动态订阅（见 P0，已完成）
- ❌ `promptCapabilities.image: false` 可在 Web 端提示"mcode 不支持图片输入"，避免用户上传后被静默忽略

### ❌ P3 — 会话 fork

`sessionCapabilities` 已声明 `fork`，但 HAPI 未使用。对"从某条消息分叉出新会话"这类需求有直接价值。

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

### 实施期联调脚本（**已进入仓库**）

`cli/scripts/verify-mcode-extensions.ts` —— 走 CLI 自己的 `AcpSdkBackend` + `McodeExtensionControl`，对真实 mcode 0.5.9 跑通 P0/P1 全链路。

```
cd cli && bun run verify:mcode-extensions
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
