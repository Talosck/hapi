# mcode ↔ HAPI 八次复审：真机 e2e（2026-10-24）

> 前七篇：`mcode-integration-review.md`（首轮 + 实施审计）、`-2.md`、`-3.md`（投递链路）、
> `-4.md`（后台任务计数）、`-5.md`（连接、重连与"客户端说的和 agent 做的不一样"）、
> `-6.md`（0.6.12 升级后的连接面）。
>
> 前七篇有一个共同的底色：**读 agent 的源码 + 用假的 ACP 后端**。它能证明 HAPI 这边的
> 逻辑自洽，证明不了 **agent 真的那么干**。第八篇补的就是这一层。

---

## 一句话结论

**补一个真机 e2e：`mcode acp` 是真进程、真的模型调用、真的会话文件，只有 hub 换成录影机替身。**
它当场验出两条只有真机才看得见的东西——一条是 **agent 自己的模型目录里躺着一个它切不进去的模型**，
一条是 **切到"按开关思考"的模型之后，HAPI 手里那份 effort 变成了陈旧值**。第二条已修。

---

## 一、这个 e2e 是什么

`cli/src/mcode/mcodeAgent.e2e.test.ts`。

**真 MiniMax Code + 假 hub**。`mcode acp` 是真进程，走真的 ACP，真的调模型，真的把会话写进
`~/.minimax/v2/sessions/<年>/<月>/<日>/<时间>-session_<base64url(id)>/`；只有 hub 被换成
一个录影机 session double——它把 launcher 发过来的每一条消息、每一条 session event 都记下来。

所以断言问的全是"**agent 到底干了什么**"，而不是"launcher 以为自己干了什么"。

它默认跳过，要真跑得开闸（跟仓库里既有的 `HAPI_RUN_SHARED_CODEX_TESTS` 一个写法，
不进 CI 的单元套件）：

```
HAPI_RUN_MCODE_E2E=1 bun run test:cli -- --run src/mcode/mcodeAgent.e2e.test.ts
```

### 1.1 地面真相

除了录影机，e2e 还直接去读 **agent 自己写的文件**：

| 文件 | 里面是什么 |
|---|---|
| `messages.jsonl` | 逐轮的对话，`{message_id, turn_id, message}` |
| `llm-call.json` | 最近一次模型调用的参数：`model`、`provider`、`api`、`thinkingLevel`、`tools` |
| `manifest.json` | 会话元信息 |

于是每条链路都有**两条独立的证据**：hub 收到的东西，和 agent 落盘的东西。

### 1.2 它覆盖的链路

一条测试串起六段，跑一轮约 70 秒：

1. **会话起来** —— launcher 报上来的原生 session id 是真 agent 给的
2. **prompt → 真回答** —— 而且 agent 自己的 transcript 里也有同一个回答
3. **工具调用 → 卡片** —— agent 的 `bash` 工具变成一张 `Bash` 卡片，卡片里是真实输出
4. **中止 → 轮次真停** —— 被中止的那个工具调用**永远没有结果**，会话还活着，下一轮照常回答
5. **标题** —— agent 自己起的名字到了 hub
6. **用量** —— 真实 token 数
7. **换模型** —— 切过去之后，agent 自己的调用记录里写的就是新模型

---

## 二、真机验出来的东西

### 2.1 agent 自己的目录里躺着一个它切不进去的模型（上游缺陷）

换模型那条链路第一次跑就红了：

```
[warn] [mcode-remote] Inline model switch failed {"code":-32603,"data":{"details":"Invalid model reasoning"}}
Failed to switch model to m:minimax:MiniMax-M3.1-Flash:v:: Invalid model reasoning
```

于是拿真 `mcode acp` 单独探了一遍，把四种 id 都试了一遍：

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | 切到 `M3.1-Flash:v:`（effort=max） | ✗ `Invalid model reasoning` |
| 2 | effort → default | ✓ |
| 3 | 再切 `M3.1-Flash:v:` | ✗ **仍然** `Invalid model reasoning` |
| 4 | 切到 `M3:v:thinking` | ✓ |
| 5 | effort → max | ✗ `Thinking effort is not advertised for the selected model: max` |
| 6 | 切到 `M3:v:` | ✓ |

**跟 effort 无关**——第 3 步 effort 已经是 default，还是拒。真正的规律在 agent 自己的模型目录里
（`~/.minimax/cache/models-dev-catalog.json`）：

- `MiniMax-M3.1-Flash`：`reasoning_options: [{type: 'effort', values: [low…max]}]` —— **只有档位，没有开关**
- `MiniMax-M3`：`reasoning_options: [{type: 'toggle'}]` —— **只有开关，没有档位**

所以 `…:v:`（空变体＝"不思考"）这个 id，**对只有 effort 的模型根本不存在**：M3.1-Flash 想"不思考"
是没有办法表达的，M3 想"不思考"才有意义（它本来就是开关）。

**而 agent 自己的选择器照样把这个 id 列出来了**——`session/new` 的 configOptions 里明明白白写着
`m:minimax:MiniMax-M3.1-Flash:v:`。**这是上游的缺陷，不是 HAPI 的**：HAPI 只是把 agent 给的目录
原样转给 web，用户点了，agent 拒了。

HAPI 这边的行为是对的：**拒绝 → 回滚 → 告知用户**（模型没变，配置跟 agent 实际状态同步回去）。
只是那句 `Invalid model reasoning` 对用户没什么解释力——这是上游措辞的问题，HAPI 只能原样转述。

### 2.2 切到"按开关思考"的模型之后，HAPI 手里那份 effort 变成了陈旧值（**已修**）

agent 的两个模型家族，**effort 的形态是不一样的**：

- effort 型（M3.1-Flash）：发布 `thinkingEffort` 选项，档位 `default|low|medium|high|xhigh|max`
- toggle 型（M3）：**根本不发布 `thinkingEffort` 选项**——它的思考是开/关，不是档位

实测（`session/set_config_option`）：

```
初始:  thinkingEffort: max [default|low|medium|high|xhigh|max]
A) 切 model=MiniMax-M3:v:thinking → OK
   （切完 agent 发布的 configOptions 里只剩 model，thinkingEffort 没了）
B) set thinkingEffort=default → ERROR "Thinking effort is not advertised for the selected model: default"
C) set thinkingEffort=max     → ERROR "Thinking effort is not advertised for the selected model: max"
D) 切回 MiniMax-M3.1-Flash:v:thinking → OK，thinkingEffort 回来了
```

HAPI 这边原来的写法是：切完模型，**读新模型的 effort 选项，读到就读，读不到就留着旧值**，
然后拿用户这轮要的 effort 去比——不一样才 apply。于是切到 toggle 型模型之后，
`currentBackendEffort` 还挂着旧模型的 `max`，而用户下一轮换一个 effort，它就会去要一个
**新模型根本没有的档位**，agent 拒，用户看到一条莫名其妙的
「Failed to switch thinking effort to max: …」。

**改法**（`cli/src/mcode/mcodeRemoteLauncher.ts`）：

```ts
const effortOptionAfterModel = backend.getThoughtLevelConfigOption(acpSessionId);
if (effortOptionAfterModel) {
    this.currentBackendEffort = /* 跟 agent 现在的值对齐 */;
} else if (modelSwitched) {
    // 新模型按开关思考，根本不发布 thinking-effort 选项。
    // 旧模型的 effort 已经不存在了：在这里丢掉，
    // 这一轮就不会去要一个新模型给不了的档位。
    this.currentBackendEffort = null;
    batch.mode.effort = null;
    this.opts.onEffortRollback?.(null);
}
// agent 没发布 effort 选项的时候，没有档位可以 apply。
if (effortOptionAfterModel && requestedEffort && requestedEffort !== this.currentBackendEffort) {
```

回归测试在 `cli/src/mcode/mcodeRemoteLauncher.test.ts`：
「drops the thinking effort when the new model has no effort levels」。

### 2.3 顺带确认的几件事（前几篇的结论在真机上成立）

| 事情 | 真机结果 |
|---|---|
| agent 的工具名 | 是 `bash`（小写），HAPI 归一成 `Bash`，web 的卡片认这个名 —— 跟 Pi 那边的教训一样 |
| `session/cancel` | 干净地回 `{"stopReason":"cancelled"}`，被中止的工具调用**永远没有结果** |
| 两层拒绝 | ACP 层 `-32602` "A prompt is already active for this session."；runtime 层 `-32603` "Session already has an active Turn" —— 跟第二轮记的一致，分类器只认后者，前者落进 unknown（可重试） |
| agent 自己的标题 | 在**它派生标题的那一轮结束之后**才发过来，HAPI 收到的是 `summary` 事件 |

---

## 三、这套 e2e 本身踩到的坑（记下来免得下次再踩）

**一、runner 的崩溃处理在 Vitest 里会自己咬自己。**
Vitest 把 `process.exit` 换成会抛异常的桩，于是 runner 的
`markCrash → cleanupAndExit → process.exit` 抛出去 → 被 `unhandledRejection` 接住 →
又进 `cleanupAndExit` → **无限循环**。第一轮跑完这个循环把日志写了 **309 MB**。
生产不受影响（真的 `process.exit` 就是退出），但 e2e 的收尾必须绕开：测试文件在模块级把
`process.exit` 换成空实现，收尾时还原。

**二、session double 少一个方法，整个 launcher 就死了。**
`releaseBatchToHub` 调 `session.client.emitMessagesReleased(localIds)`；double 里没有这个方法 →
TypeError → 从 catch 块里抛出去 → launcher 挂掉 → cleanup → agent 被 SIGKILL。
看起来像"HAPI 把 agent 杀了"，其实是**替身不完整**。写替身前最好把 launcher 对 client 的
调用全列出来（`grep -ohE "client\.[a-zA-Z]+" cli/src/mcode/*.ts`）。

**三、agent 落盘比 hub 收到消息慢。**
拿到答案就立刻读 `messages.jsonl`，读到的是空的——agent 是**先**把答案交给 hub、**后**写文件的。
地面真相的读法得轮询等文件追上来。

**四、ACP 的 config option 记的是裸模型名。**
`llm-call.json` 里是 `MiniMax-M3.1-Flash`，不是 `m:minimax:MiniMax-M3.1-Flash:v:thinking`；
要比对就得先把 wire id 解成 `provider/model#variant`（`acpModelIdToCliModelId`）再取模型名那一段。

---

## 四、这轮的验证

| 项 | 结果 |
|---|---|
| 真机 e2e | **6 passed**，约 67 秒（`HAPI_RUN_MCODE_E2E=1`） |
| launcher 单元测试文件 | 84 → **85** 条全过（新增 1 条回归测试） |
| mcode 单元套件 | 381 → **382** 条全过（e2e 文件的 6 条默认跳过） |
| cli / web / hub / shared 全套 | cli 3518 passed / 18 skipped、web 3559 passed、hub 1438 pass、shared 377 pass，全过 |
| typecheck | cli / web / hub / relay 全过 |
| fixtures | `bun run gen:fixtures` 重新生成，**零漂移** |
