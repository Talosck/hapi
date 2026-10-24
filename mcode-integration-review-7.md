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
它当场验出三条只有真机才看得见的东西——一条是 **agent 自己的模型目录里躺着一个它切不进去的模型**，
一条是 **切到"按开关思考"的模型之后，HAPI 手里那份 effort 变成了陈旧值**，
还有一条是 **fork 之后 agent 会把 fork 的 delegation 树也发过来，把 web 上的子代理面板清空了**。
后两条已修，第三条是上游缺陷、HAPI 如实转述。

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

一条测试串起十七段（十六条测试），跑一轮约 165 秒。分六组：

**聊天面**

1. **会话起来** —— launcher 报上来的原生 session id 是真 agent 给的
2. **prompt → 真回答** —— 而且 agent 自己的 transcript 里也有同一个回答
3. **工具调用 → 卡片** —— agent 的 `bash` 工具变成一张 `Bash` 卡片，卡片里是真实输出
4. **中止 → 轮次真停** —— 被中止的那个工具调用**永远没有结果**，会话还活着，下一轮照常回答
5. **标题** —— agent 自己起的名字到了 hub
6. **用量** —— 真实 token 数

**配置面**

7. **模型目录** —— agent 给了哪些模型、当前是哪个、effort 有哪些档位；每一个 id HAPI 都要能解码
8. **斜杠命令目录** —— agent 自己发布的那几个（`help`、`model`……）
9. **effort 切换** —— 切完 agent 发布的 effort 真的变了，hub 也被告知了
10. **权限模式切换** —— agent 真的按新模式跑，hub 不会继续 advertise 旧模式
11. **换模型** —— 切过去之后，agent 自己的调用记录里写的就是新模型

**会话面**

12. **fork 会话** —— agent 的 `session/fork` 真能 fork 出一个新的原生会话

**扩展面（ACP 扩展方法）**

13. **goal** —— 建、改状态、清空，走 `mcode/session/goal/*`
14. **delegation 树** —— agent 发布的子代理快照到了 hub，`mcode/session/delegation/stop` 也答得上来
15. **steer** —— 把排在队列里的消息塞进**正在跑的那一轮**（`mcode/session/steer`），
    地面真相是：那条消息出现在 agent 自己的 transcript 里

**子代理面**

16. **agent 真派了子代理** —— 让 agent 自己去用 `task` 工具，它真拉起一个子会话，
    树上真有成员（id、父会话、agent 名、状态），而且树**一旦有成员就不会再变回空**

**问卷面**

17. **agent 反问用户** —— agent 自己用 `ask_user` 提问，hub 收到一个待答请求；
    用户答了之后，答案变成**下一轮**用户消息，agent 接着跑完

其中 **steer**、**fork**、**子代理** 和 **问卷** 这四条是整套 e2e 里最值钱的：
它们要的是「agent 真的在跑那一轮」「agent 真的 fork 得出来」「agent 真的会自己派子代理」
「agent 真的会自己停下来问人」，mock 后端永远给不出这个。

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
    // hub 就不会继续 advertise 一个新模型给不了的档位。
    this.currentBackendEffort = null;
    this.opts.onEffortRollback?.(null);
}
const requestedEffort = batch.mode.effort === null ? this.defaultBackendEffort : batch.mode.effort;
if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
    if (!effortOptionAfterModel) {
        // 这个模型没有档位，没有东西可设。
        // 用户自己挑的那个要告诉他落不了地；旧模型的默认值直接丢掉。
        if (batch.mode.effort !== null) {
            session.sendSessionEvent({ type: 'message', message: `MiniMax Code's current model has no thinking-effort levels, so the thinking effort cannot be set to ${requestedEffort}.` });
        }
        batch.mode.effort = null;
        this.currentBackendEffort = null;
        this.opts.onEffortRollback?.(null);
    } else {
        // 原来的路径
    }
}
```

这里有个第二轮 e2e 才暴露的分寸：**用户自己挑的 effort 不能被静默吞掉**。
第一版修复把「模型没有档位」这件事一律当跳过处理，结果用户在 toggle 型模型上
挑 effort，界面显示切了、agent 那边什么都没有。改法是分成两种：

- **旧模型的默认档位** —— 直接丢掉（它属于上一个模型，不该被搬过来）
- **用户这一轮明确挑的档位** —— 明确告诉他落不了地，而不是假装切了

回归测试在 `cli/src/mcode/mcodeRemoteLauncher.test.ts`：
「drops the thinking effort when the new model has no effort levels」、
「tells the user that a model without effort levels cannot take one」。

### 2.3 fork 之后，agent 会把 fork 的 delegation 树也发过来（**已修**）

这条是加「agent 真派子代理」那条测试时才撞上的，而且**撞得很隐蔽**：测试是过的
（「有一棵树带成员」成立），但日志里树的形状不对。

e2e 的日志长这样，一棵树和一棵空树**成对出现**：

```
sessionEvent {"type":"subagent-snapshot","members":[{"id":"mvs_2dfd…","parentId":"mvs_12ff…","title":"Echo test reply","detail":"mavis","status":"completed",…}]}
sessionEvent {"type":"subagent-snapshot","members":[]}
sessionEvent {"type":"subagent-snapshot","members":[{"id":"mvs_2dfd…",…}]}
sessionEvent {"type":"subagent-snapshot","members":[]}
```

web 那边取的是**最后一条** `subagent-snapshot`，所以用户看到的子代理面板会被反复清空。

拿真 `mcode acp` 单独探了一遍才看清是谁发的那棵空树。**不开 fork** 的时候，
agent 只发自己那棵树；**开了 fork** 之后，它给**两个**会话各发一棵：

```
[DELEGATION] root=mvs_19a87516dbb6415e9d0038aad9dbd015 members=[{id:mvs_dd83…, status:completed}]   ← 本会话
[DELEGATION] root=mvs_930f6ec62b1c49469496da7993b59db8 members=[]                                  ← fork 出来的那棵
[DELEGATION] root=mvs_19a87516dbb6415e9d0038aad9dbd015 members=[{id:mvs_dd83…, status:running}]
[DELEGATION] root=mvs_930f6ec62b1c49469496da7993b59db8 members=[]                                  ← 还是它
```

注意 `rootSessionId` 这个字段**本来就在**（`McodeDelegationSnapshot.rootSessionId`），
HAPI 只是没用它——`handleDelegationUpdate` 收到什么树就转什么树。

**改法**（`cli/src/mcode/mcodeRemoteLauncher.ts`）：只转**根是本会话**的那棵树。

```ts
// The agent publishes the tree of every session it knows about. After
// a fork the fork's own (empty) tree arrives next to the one of this
// session, and forwarding it would clear the panel the user is
// watching. Only the tree rooted at this session is its state.
if (snapshot.rootSessionId !== this.acpSessionId) {
    return;
}
```

回归测试：「ignores the delegation tree of another session」。

e2e 那条断言也跟着改了。第一版只问「有没有一棵带成员的树」——那是**运气**：
轮询正好撞上带成员那一条就过了，摘掉修复重跑一遍居然还是绿的。改成
**一旦有成员，就不能再变回空**：

```ts
const withMembers = snapshots.filter((event) => (event.members?.length ?? 0) > 0);
expect(withMembers.length).toBeGreaterThan(0);
const lastWithMembers = snapshots.lastIndexOf(withMembers[withMembers.length - 1]!);
expect(snapshots.slice(lastWithMembers).every((event) => (event.members?.length ?? 0) > 0)).toBe(true);
```

而且断言得等**这一轮跑完**再看：agent 每变一次状态发一棵树，读到一半看起来是正常的。

摘掉修复跑一次是红的（`expected false to be true`），装回去是绿的。

### 2.4 顺带确认的几件事（前几篇的结论在真机上成立）

| 事情 | 真机结果 |
|---|---|
| agent 的工具名 | 是 `bash`（小写），HAPI 归一成 `Bash`，web 的卡片认这个名 —— 跟 Pi 那边的教训一样 |
| `session/cancel` | 干净地回 `{"stopReason":"cancelled"}`，被中止的工具调用**永远没有结果** |
| 两层拒绝 | ACP 层 `-32602` "A prompt is already active for this session."；runtime 层 `-32603` "Session already has an active Turn" —— 跟第二轮记的一致，分类器只认后者，前者落进 unknown（可重试） |
| agent 自己的标题 | 在**它派生标题的那一轮结束之后**才发过来，HAPI 收到的是 `summary` 事件 |
| agent 的工具清单 | `llm-call.json` 里写着：`bash`、`task`（派子代理）、`ask_user`（反问）、`task_output`、`update_goal`/`get_goal`、`website_deploy`…… HAPI 接的每条链路背后都真有 agent 的一个工具 |
| `ask_user` 怎么问 | agent 走 ACP 的 `elicitation/create`；HAPI 把它归一成 `ask_user_question` 请求发给 hub，用户答完走的是**权限那条通道**（`permission` RPC），答案再作为下一轮用户消息回灌 |
| 子代理是什么 | agent 用 `task` 拉起来的是 **`mavis`** 子会话，树上带 id、父会话、agent 名（`detail`）、`running`/`completed` 状态和起止时间 |

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

**五、Vitest 跑在 Node 上，`bun:sqlite` 用不了。**
`bun run test` 跑 vitest 时走的是 Node，不是 Bun，于是
`cli/src/mcode/utils/mcodeRuntimeIndex.ts` 里那句 `await import('bun:sqlite')`
在 e2e 里永远是 `ERR_MODULE_NOT_FOUND`，日志上一行「Runtime index unavailable」。
生产不受影响（CLI 本来就跑在 Bun 上，`bun:sqlite` 能开，agent 那个
`~/.minimax/v2/sqlite/runtime-state.sqlite` 也确实读得到）——但这意味着
**runtime index 那条路这套 e2e 覆盖不了**，只能另想办法。

**六、e2e 的断言不能靠「轮询撞上了」。**
delegation 那条测试第一版断言的是「有没有一棵带成员的树」，而 agent 的树是一来一回
（一棵带成员、一棵空树）发的，轮询正好撞上带成员那一条就过了——**摘掉修复重跑一遍
居然还是绿的**。教训是两条：断言得是**性质**而不是**快照**（「一旦有成员就不能再变回空」），
而且得等**这一轮真的跑完**再看（agent 每变一次状态发一棵树，读到一半看起来是正常的）。

---

## 四、还没进 e2e 的部分

这套 e2e 换掉的是 **hub**，agent 那头是真的。所以没进来的东西分三类：
**要真 hub 的**、**要 agent 自发行为的**、**根本不在 ACP 面上、得另做替身的**。

### 4.1 要真 hub 的

| 东西 | 为什么进不来 |
|---|---|
| `ListMcodeApps`（`cli/src/modules/common/handlers/mcodeApps.ts`） | handler 在 hub 侧，读的是**本机的 connector broker**，不是 agent 的 ACP 面 |
| 5 小时配额（`cli/src/mcode/utils/mcodeTokenPlanQuota.ts`） | 配额是**宿主账号**的额度，走 broker 的租约协议（4 字节长度前缀的帧、60 秒租约），要一个真的 broker 才答得上来 |
| 会话树 / 恢复 / 重连（`mcodeSessionDirs.ts`、`mcodeRuntimeIndex.ts`、`mcodeSessionTranscript.ts`、`commands/resume.ts`） | 都跨进程：e2e 每条用例起一个全新 agent 进程，没有「上一轮留下什么」；runtime index 还因为上面那条坑读不到 |
| `ListMcodeModelsForCwd`（`cli/src/modules/common/handlers/mcodeModels.ts`） | 会另外 spawn 一个 mcode 探针进程，是 hub 侧的事 |

### 4.2 要 agent 自发行为的

这些不能靠 HAPI 触发，只能**请** agent 这么做——所以每一条都得靠提示词，而提示词不是契约：

| 东西 | 怎么才能真的发生 |
|---|---|
| 工具审批（`permissionHandler.ts`） | agent 得撞上一个真需要审批的工具。e2e 里用的 `bash` 在 `auto` 模式下直接过 |
| 后台任务计数（`backgroundTaskAggregator.ts`） | agent 得自己用 `run_in_background` 拉起后台任务、再用 `task_output` 轮询——这是它的选择 |
| deliverables（`mcodeDeliverables.ts`） | agent 得在会话末尾真的产出交付物 |
| runtime 层拒绝（`-32603` "Session already has an active Turn"） | 要 agent 手上持有**不是 HAPI 发起的那一轮**（原生队列、后台任务、第二个客户端）。HAPI 自己走 `queue/enqueue`，所以这条拒绝在 e2e 里造不出来 |

### 4.3 不在 ACP 面上、得另做替身的

| 东西 | 面 |
|---|---|
| connector 工具（`mcodeConnectorTools.ts`） | MiniMax Code 的 connector broker（unix socket），不是 ACP |
| 认证状态（`mcodeAuthState.ts`） | 读 agent 的登录状态 |
| local 模式 TUI（`mcodeLocal.ts` / `mcodeLocalLauncher.ts`） | local 模式不走 hub，launcher 是另一套；这套 e2e 只覆盖 remote 那套 |

---

## 五、这轮的验证

| 项 | 结果 |
|---|---|
| 真机 e2e | **16 passed**，约 165 秒（`HAPI_RUN_MCODE_E2E=1`） |
| launcher 单元测试文件 | 84 → **87** 条全过（新增 3 条回归：2 条 effort + 1 条 delegation 树） |
| mcode 单元套件 | 381 → **384** 条全过（e2e 文件的 16 条默认跳过） |
| cli 全套 | **3520 passed / 28 skipped**，零失败；另一次跑出 3 条与 mcode 无关的既有偶发失败，见下 |
| web / hub / shared 全套 | 全过 |
| typecheck | cli / web / hub / relay 全过 |
| fixtures | `bun run gen:fixtures` 重新生成，**零漂移** |
| 回归有效性 | 把 delegation 的修复摘掉，e2e **当场变红**（`expected false to be true`）；装回去 16/16 绿 |

> 跑 cli 全套的时候撞到过三条**跟 mcode 无关**的偶发失败：
> `src/agy/headless/agyHeadlessDriver.test.ts` 的「cancels an ID-bearing retry during the backoff」、
> `src/codex/utils/codexTranscriptLocator.test.ts` 的「refuses fallback when fresh activity is ambiguous」、
> `src/claude/claudeRemoteLauncher.launchFailure.test.ts` 的 launch-failure 恢复那条。
> 前两条单独重跑是过的，第三条**把本次改动 stash 掉也一样挂**（5 秒超时）——
> 都是既有的偶发/环境问题，不在本次范围内，记在这里备查。
