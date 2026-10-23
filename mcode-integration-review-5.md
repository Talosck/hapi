# mcode ↔ HAPI 六次复审：连接、重连与"客户端说的和 agent 做的不一样"（2026-10-23）

> 前五篇：`mcode-integration-review.md`（首轮 + 实施审计）、`-2.md`（二次复审）、
> `-3.md`（三次复审，投递链路）、`-4.md`（五次复审，后台任务计数）。
> 本文只写**连接（connect）与重连（restart）**这一条线：agent 起来的那一刻、
> agent 死掉再被拉起来的那一刻，HAPI 说的和 agent 做的对不对得上。
> 全部结论都回查到源码行号。
>
> **本文同时是实施记录**：本轮的问题已全部修完并全量验证，记录在文末。

---

## 一句话结论

**能优化，而且优化的点全在"重连"上：agent 死一次，HAPI 就悄悄退回成"开新会话"的配置，
而界面还照旧显示着用户选的东西。**

具体是三件事叠在一起：

1. **权限策略是进程级的，重启后没人再下发一次** —— agent 进程换了，`permissionMode`
   这个 config option 就没了，HAPI 却因为"上次下发过"而跳过下发，于是会话跑在
   agent 自己的默认策略上，而 web 上还写着用户选的那个模式；
2. **模型和思考强度被"开新会话时的请求"覆盖** —— 用户中途换了模型，agent 一崩，
   HAPI 就把模型换回开场时那一个，hub 也跟着对外播报换回去；
3. **死掉的 agent 留下的审批卡片没人应答** —— 卡片还挂在 web 上，但背后的 handler
   已经被新 agent 的 handler 顶掉了。

外加两个"客户端以为自己在看 agent 真实状态"的洞：hub 会播报一个 agent 根本没接受的
权限模式（plan 被静默降级），web 的模型目录探测 10 次之后彻底放弃、再也不恢复。

---

## 一、连接链路地图

先把"连接"这件事拆开，后面每条问题都能定位到其中一格。

```
用户点"开始会话"
      │
      ▼
mcodeLocal.ts ──► spawnWithTerminalGuard()        本地 TUI：用户自己在终端里跑
      │                                            （切远程时切 'switch'）
      ▼
mcodeLoop() ──► mcodeRemoteLauncher()              远端：HAPI 自己开 agent
      │
      ▼
connectAgent()                                     ★ 本轮的问题都在这里
      ├── createMcodeBackend()                     新起一个 `mcode acp` 进程
      ├── backend.initialize()
      ├── backend.loadSession() / newSession()
      ├── applyPermissionMode()                    ← 2.1 重连后被跳过
      ├── applyInitialModel()                      ← 2.2 重连后被退回
      ├── applyInitialEffort()                     ← 2.4 档位读的是旧模型的
      ├── restoreGoalState() / restoreDelegationState()   ← 2.9 串行两次往返
      └── 注册 handler（模型目录 / slash 命令 / 提问 / 审批）

agent 死了 ──► catch ──► restartAgent() ──► connectAgent({ isRespawn: true })
                                            ↑ 2.3 旧 handler 没清理
                                            ↑ 2.5 重启计数每轮清零
```

---

## 二、本轮发现

### 2.1 【高】重连后工具权限策略不再下发，会话跑在 agent 的默认策略上

MiniMax Code 把两件事拆成两根轴（`cli/src/mcode/utils/permissionModes.ts:19-33`）：

| 轴 | 载体 | 作用域 |
|---|---|---|
| 工具权限策略（default / auto / bypassPermissions） | ACP config option | **进程级** |
| 会话模式（default / plan） | `session/set_mode` | 会话级 |

`applyMcodePermissionMode()` 的注释自己写得很清楚（`permissionModes.ts:96-108`）：
*"The tool permission policy lives on its own config option"*，而 config option 是
**进程级**的 —— 换进程就没了。

而 HAPI 侧的下发逻辑是：

```ts
// cli/src/mcode/mcodeRemoteLauncher.ts（旧）
if (this.hasAppliedPermissionMode && this.requestedPermissionMode === (mode ?? null)) return;
```

`hasAppliedPermissionMode` 是 launcher 自己的字段，**跨进程存活**。于是重连时：

| 时刻 | `hasAppliedPermissionMode` | 实际发生的事 |
|---|---|---|
| 首次连接 | false | 下发 `permissionMode` ✅ |
| 第 N 次回合 | true | 模式没变，跳过 ✅（正确，本来就没变） |
| **agent 死了，重连** | **true** | **模式没变，跳过 ❌（新进程根本没这个 config option）** |

结果：agent 进程换了，`permissionMode` 回到 agent 自带的默认值（Ask），
而 hub 侧 `hubPermissionMode` 没变、web 上仍然显示用户选的那个模式。

**用户在界面上看到的权限模式和 agent 实际执行的不是一回事** —— 这在"auto"（自动放行）
和"Ask"之间差别很大；在 "bypassPermissions" 和 Ask 之间更大。

**修法**：换进程就是"什么都没下发过"。`connectAgent()` 里新建后端之后把进程级状态清零：

```ts
// cli/src/mcode/mcodeRemoteLauncher.ts:522-528
this.hasAppliedPermissionMode = false;
this.requestedPermissionMode = null;
this.appliedPermissionMode = null;
```

`appliedPermissionMode` 也清成 `null`，这样万一下发失败要回滚，回滚的目标是
"新进程里真实存在的默认值"，而不是上一个进程的残留值。

### 2.2 【高】重连把用户中途换的模型换回去，hub 也跟着播报错值

```ts
// cli/src/mcode/mcodeRemoteLauncher.ts（旧）
const effectiveModel = await this.applyInitialModel(acpSessionId, this.opts.model);
const effectiveEffort = await this.applyInitialEffort(acpSessionId, this.opts.effort);
```

`this.opts.model` 是**开这个远端会话时**的请求值（`cli/src/mcode/loop.ts:123`），
之后用户中途换模型走的是另一条路（回合内的 `batch.mode.model`），
`this.opts.model` 不会跟着变。

于是重连时发生的是：

| 时刻 | agent 跑的模型 | HAPI 认为的模型 |
|---|---|---|
| 开会话 | M | M |
| 用户中途换成 F | F | **M**（`opts.model` 没变） |
| agent 崩了，重连 | F（`session/load` 恢复了它） | HAPI 又下发了一次 **M** ❌ |

而且 `this.defaultBackendModel = effectiveModel` 这一行会把"回落到 agent 默认模型"
的目标也一起改掉。

**修法**：重连时用"崩溃前生效的那个模型"，而不是"开场请求的那个模型"；HAPI 不知道时
才听 agent 的（`applyInitialModel(sessionId, undefined)` 返回 agent 播报的目录模型）：

```ts
// cli/src/mcode/mcodeRemoteLauncher.ts:662-690
const requestedModel = options.isRespawn
    ? (this.currentBackendModel ?? undefined)
    : this.opts.model;
```

思考强度同理（`requestedEffort`）。另外 `defaultBackendModel` / `defaultBackendEffort`
只在**首次**连接时写，重连不改 —— 它们的语义是"这个会话开起来时的默认"，
agent 崩了不该改这个语义。

### 2.3 【中】死掉的 agent 留下的审批卡片，没人应答

`connectAgent()` 会换掉 `this.questionHandler` / `this.permissionHandler`，
但**没有先把旧的关掉**。旧 handler 手里还攥着死掉那个进程发出的待审批请求，
而这些请求在客户端状态（`session.updateAgentState().requests`）里还挂着。

于是 web 上有一张审批卡片：

- 点"允许" → RPC 落到**新** handler → 新 handler 根本不知道这个 id → 请求被丢掉；
- 这张卡片要等下一轮回合结束时 `cancelAll()` 才会被清掉（而且清的是新 handler 的）。

顺带一个更硬的坑：`permissionAdapter.cancelAll()` 里
`await this.backend.respondToPermission(...)`（`cli/src/agent/permissionAdapter.ts:212`）
在**死掉的后端**上会抛异常，而这个异常在 `cancelAll` 的 for 循环里没有兜底 ——
抛出去就意味着后面的 `updateAgentState()` 清理**根本不会执行**，卡片永久留着。

**修法**（两处）：

1. `permissionAdapter.cancelAll()` 对每个应答单独兜底（`permissionAdapter.ts:219`）：
   agent 已经没了也要把请求从状态里摘掉；
2. `connectAgent()` 换 handler 之前先把旧的关掉（`mcodeRemoteLauncher.ts:516`、
   `discardDeadRequests()` 在 `:1444`）。

### 2.4 【中】连接期换模型后，思考强度档位读的是上一个模型的

主循环里处理得很细（`mcodeRemoteLauncher.ts:822`）：

```ts
// 换模型会改变 agent 广播的思考档位，换完要等它重新广播，
// 这时候读到的档位列表才属于新模型。
await this.backend?.waitForSessionUpdateQueue(500);
```

**连接路径上缺了这一步**：`applyInitialModel()` 紧接着 `applyInitialEffort()`，
后者读的是 `getThoughtLevelConfigOption()` 里那份缓存 —— 那份缓存来自
`session/new` 的应答，属于**切换前**的模型。

于是：新模型支持的档位被当成"没广播过"，报一句
`Thinking effort X is not advertised`，用户选了合法档位却被拒。

**修法**：连接期换完模型也等一次重新广播（`:680`）。

### 2.5 【中】"每轮成功就清零"让重启风暴没有上限

```ts
// 旧代码
this.agentRestarts = 0;   // 每跑完一轮成功的回合就清零
if (this.agentRestarts > MCODE_MAX_AGENT_RESTARTS) { 结束会话 }
```

这个计数器防的是"agent 起来就死"。但**答完一轮再死**的 agent（退出时段错误、
被 OOM killer 杀掉、退出时清理崩了）会把它清成 0，然后无限重启：

```
崩 → 重启(1) → 答完一轮 → 清零 → 崩 → 重启(1) → 答完一轮 → 清零 → ...
```

`MCODE_MAX_AGENT_RESTARTS` 永远碰不到，每一轮还新起一个 `mcode acp` 进程，
用户被 "MiniMax Code stopped; starting it again" 刷屏。

**修法**：除了"连续"计数，再加一个**滑动窗口**计数 —— 短时间内堆起来的重启是同一个
故障，不管中间隔了几轮：

```ts
// cli/src/mcode/mcodeRemoteLauncher.ts:447-453
const windowStart = Date.now() - MCODE_AGENT_RESTART_WINDOW_MS;   // 5 分钟
while (this.agentRestartTimes.length > 0 && this.agentRestartTimes[0] < windowStart) {
    this.agentRestartTimes.shift();
}
const tooManyInARow = this.agentRestarts > MCODE_MAX_AGENT_RESTARTS;
const tooManyInTheWindow = this.agentRestartTimes.length > MCODE_MAX_AGENT_RESTARTS;
```

两个条件任一命中就结束会话，文案区分"连续"和"这几分钟内"。

### 2.6 【中】hub 播报一个 agent 根本没接受的权限模式

`applyMcodePermissionMode()` 在 agent **不支持 `session/set_mode`** 时会返回
`mode: 'default'`（`permissionModes.ts:137-140`）—— 这是对的，plan 落在 session mode 上，
没有这个方法就没有 plan。

问题在调用方：`appliedPermissionMode` / `hubPermissionMode` 都更新成了 `'default'`，
但**没有通知 hub**。于是 `runMcode.ts` 里的 `currentPermissionMode` 还停在 `'plan'`，
keepalive 继续播报 `'plan'`，web 上显示"计划模式"，agent 实际跑的是 Ask。

**修法**：agent 实际跑的模式和用户要的不一致时，明确告诉 hub，并在会话里说一次
（`mcodeRemoteLauncher.ts:1485-1499`）：只说一次，不在每一轮重复。

### 2.7 【中】web 侧模型目录探测：10 次之后放弃，而且再也不恢复

```ts
// 旧代码
const MAX_MCODE_MODEL_DISCOVERY_POLLS = 10
if (!enabled || pollCount >= MAX_MCODE_MODEL_DISCOVERY_POLLS) return false
```

`pollCount` 是 `dataUpdateCount + errorUpdateCount`，**成功的空回答也算一次**。

agent 是启动时广播目录的，一个刚起来的会话会连续返回十几次空目录 —— 于是这十次
把预算吃光，探测停止。之后目录到了也不会再问，除非有别的东西让这个 query 失效。

**修法**：预算改成**时间**而不是次数（60 秒），空目录不再消耗预算里的"次数"，
另外加上 `refetchOnWindowFocus`，用户切回标签页时会再问一次
（`web/src/hooks/queries/useMcodeModelsForSession.ts`）。

### 2.8 【中】连接器应用列表：用户刚接上的 app，web 要等好几分钟才看得到

app 是在 HAPI 之外接的（`mcode-tools`），机器侧把目录缓存 5 分钟
（`cli/src/mcode/utils/mcodeConnectorTools.ts:60`）。web 侧 5 分钟轮询一次，
但 **web 的"回到标签页就刷新"打不穿机器的缓存** —— 机器还是拿旧答案。

CLI 侧其实已经有 `forceRefresh`（`mcodeConnectorTools.ts:469`），只是没往上传。

**修法**：把 `forceRefresh` 从 web 一路传到 CLI：

```
web/src/hooks/queries/useMcodeApps.ts
  → web/src/api/client.ts            ?forceRefresh=1
  → hub/src/web/routes/machines.ts    读 query 参数
  → hub/src/sync/{syncEngine,rpcGateway}.ts
  → cli/src/modules/common/handlers/mcodeApps.ts
  → listMcodeConnectorApps({ forceRefresh })
```

web 侧只在**第二次及以后**的读取才 force（第一次可能吃机器缓存），并留 15 秒的
缓冲，免得来回切标签页就把机器跑满了。

### 2.9 【低】探测目录按机器共享，web 却按目录问；恢复时还串成两次往返

- **目录 key**：`listMcodeModelsForCwd()` 的缓存 key 是常量
  `PROBE_CACHE_KEY = 'mcode-model-probe'`（`cli/src/modules/common/mcodeModels.ts:55`），
  注释写得很清楚：*"The catalog comes from the provider configuration, not from the
  workspace: the probe runs in a fixed directory, so every cwd shares one answer."*
  但 web 的 query key 里带着 cwd（`web/src/lib/query-keys.ts:37`），
  用户每敲一个目录就多问机器一次。**改成只按机器 key**。
- **恢复串行**：`restoreGoalState()` 和 `restoreDelegationState()` 互不相干，
  却是两次串行往返。**改成 `Promise.all`**，每次连接少一个往返。

### 2.10 【低】换后端时旧后端没有关

`connectAgent()` 直接把 `this.backend` 换成新的，旧的既没 `disconnect()` 也没丢干净。
正常情况下旧进程已经死了（这才走到重连），但**初始化失败**那条路会留下一个还活着的
`mcode acp` 子进程和它的定时器。

**修法**：换之前关掉，且**限时**（`closeBackend()`，`mcodeRemoteLauncher.ts:1420`）——
死掉的 agent 的 update 队列可能还堵着，无限期等下去会让重连永远不发生。

---

## 三、实施记录

### 3.1 改动文件

**CLI**
- `cli/src/mcode/mcodeRemoteLauncher.ts` —— 重连的状态一致性（本轮主体）：
  关旧后端、清进程级权限状态、模型/强度按"崩溃前生效值"恢复、
  连接期等 agent 重广播档位、goal+delegation 并行恢复、
  滑动窗口的重启计数、"agent 跑不了这个模式"的告知
- `cli/src/mcode/mcodeRemoteLauncher.test.ts` —— 新增 3 个回归用例（见 3.2）
- `cli/src/mcode/utils/backgroundTaskAggregator.ts` —— 认得出 `details.execution.status`
  （后台任务结束时的真正位置）
- `cli/src/mcode/utils/backgroundTaskAggregator.test.ts` —— 新增 1 个回归用例
- `cli/src/agent/permissionAdapter.ts` —— `cancelAll()` 对死掉的后端兜底，保证状态一定被清
- `cli/src/modules/common/handlers/mcodeApps.ts` —— 接受 `forceRefresh`

**Shared**
- `shared/src/apiTypes.ts` —— `McodeAppsRequest`

**Hub**
- `hub/src/sync/rpcGateway.ts`、`hub/src/sync/syncEngine.ts` —— 透传 `forceRefresh`
- `hub/src/web/routes/machines.ts` —— 读 `?forceRefresh=1`
- `hub/src/web/routes/machines.test.ts` —— 新增 1 个用例
- `hub/src/sync/backgroundTasks.ts` —— **删掉旧的"启动减完成"计数**
- `hub/src/sync/sessionCache.ts`、`hub/src/sync/syncEngine.ts`、
  `hub/src/socket/handlers/cli/{index,sessionHandlers}.ts`、`hub/src/socket/server.ts`、
  `hub/src/startHub.ts` —— 拆掉那条管线的全部接线
- `hub/src/socket/handlers/cli/sessionHandlers.test.ts` —— 新增 1 个用例：
  工具结果里写着"任务在跑"**不得**再让计数动一下
- `hub/src/sync/sessionCache.{applySessionPatch,expireInactive}.test.ts` —— 改用绝对计数

**Web**
- `web/src/hooks/queries/useMcodeModelsForSession.ts` —— 探测预算从"次数"改成"时间"，
  加 `refetchOnWindowFocus`
- `web/src/hooks/queries/useMcodeModelsForSession.test.tsx` —— 新增（7 个用例）
- `web/src/hooks/queries/useMcodeModelsForCwd.ts`、`web/src/lib/query-keys.ts` ——
  目录探测只按机器 key
- `web/src/hooks/queries/useMcodeApps.ts` —— 第二次及以后的读取 force 一次
- `web/src/hooks/queries/useMcodeApps.test.tsx` —— 新增（3 个用例）
- `web/src/api/client.ts` —— `getMachineMcodeApps(machineId, { forceRefresh })`

### 3.2 三个回归用例钉住的行为

| 用例 | 钉住什么 | 不修会怎样 |
|---|---|---|
| `applies the permission policy again when the agent is started again` | 重连后 `permissionMode` 至少下发两次 | 只下发一次 → agent 跑在默认策略上 |
| `keeps the model the user picked when the agent is started again` | 重连后 hub 播报的仍是 `m:fast` | 播报 `m:good` → 用户的模型被换回去 |
| `ends the session when the agent keeps dying after it answered a turn` | "答完一轮再死"也会结束会话 | 无限重启，永不结束 |

另外两个（第四节）：

| 用例 | 钉住什么 |
|---|---|
| `settles a task whose end is only reported under details.execution` | 后台任务结束时账本立刻把它摘掉 |
| `does not count a background task from the text of a tool result` | 工具结果里的字样不得再让计数动一下 |

### 3.3 验证

- `bun typecheck`（cli / web / hub / relay）—— 全过
- `bun run test:cli` —— **3385 passed / 11 skipped**
- `bun run test:web`、`bun run test:hub`、`bun run test:shared` —— 见本次提交记录

---

## 四、顺带修掉的另一条：后台任务的计数（接 review-4 那条线）

这一条不在"连接"这条线上，是用户看着面板上"1 个后台终端在跑 · 已经 12 分钟"时追出来的。
但它和本轮是同一个病根：**HAPI 告诉客户端的东西，和 agent 实际在做的事对不上。**

### 4.1 现象

面板上有一个后台终端在跑，计时器已经走了十几分钟。但那个命令其实早就跑完了
（`bun run test:web`，退出码 0，316 个测试文件全过）。

### 4.2 取证

把 agent 的运行时任务表和 CLI 发布给 hub 的清单对齐之后，时间线是清楚的：

| 时刻 | 事件 | CLI 的账本 | hub 显示 |
|---|---|---|---|
| 09:54:02 | `bg_413fa1da`（typecheck + hub/web 测试）启动 | 1 个 | 1 |
| 10:02:26 | 另一个任务被取消（`details.status = "canceled"`） | 1 个 | 1 |
| 10:08 | `bg_413fa1da` **实际结束**（退出码 0） | **还是 1 个** | 1 |

hub 侧也只有一个会话的 `backgroundTaskCount` 不是 0，就是这一个。

### 4.3 两个原因

**原因一：hub 里还留着旧的"启动减完成"计数。**
CLI 早就改成发布整份清单了（review-4），hub 却还在同一批消息上跑旧算法
（`hub/src/socket/handlers/cli/sessionHandlers.ts`：先 `extractBackgroundTaskDelta`，
再 `extractBackgroundTaskSnapshot`）。同一个数字有两个来源，后到的那个说了算，
而下一次清单不一定再来纠正它 —— 计数就会一直挂在 1 上。
**已删**：hub 只认 CLI 发布的清单，旧的那条路径整个拆掉。

**原因二（这次真正卡住的原因）：CLI 的账本没认出任务的结束。**
后台命令结束时，运行时把状态放在 `details.execution.status` 里
（`{ status: "succeeded", reason: "exited", exitCode: 0 }`），而不是顶层的 `details.status`。
聚合器只读顶层（`readString(details, ['status', 'state'])`），于是这条结束信号它没看见，
任务就一直留在账本里 —— 只能等"连续两轮不问就自动摘掉"那条兜底规则把它清掉。
**已修**：聚合器也读 `details.execution.status`。

### 4.4 一并说明

仓库里的修复**不影响正在跑的这次会话**：会话跑的是装好的 0.30.7 二进制
（`~/.npm-global/lib/node_modules/@twsxtd/hapi`），hub 也是同一个二进制。
要看到修好的行为，得等重新部署。

---

## 五、这轮没做的（留着的）

1. **每个模型的思考档位目录**。现在探测只返回"当前模型"的档位列表，创建表单会把它
   套到所有模型上（选了不支持的档位，agent 会拒）。要修就得在探测时逐个模型切一遍，
   成本是一次探测进程里 N 次 `set_model` —— 收益不值当，先记着。
2. **机器级 handler 注册在每个 session scope 里**。`ListMcodeApps` 这类机器级 RPC
   在每个会话作用域都注册了一份。功能上没错（后注册覆盖先注册），但作用域是虚的。
3. **apps 目录探测里的配额查询可能长时间挂住**。`listMcodeTokenPlanQuota()` 挂在
   broker 探测后面，浏览器一次请求可能等很久。目录和配额应该并发，而不是串行等。
4. **重连后的对话历史**。`session/load` 失败会回落到"开新会话"，用户会看到自己刚才
   说的那几轮凭空消失 —— 这是 agent 的语义，HAPI 只能如实转述，但值得在 UI 上区分
   "恢复失败"和"新会话"。
