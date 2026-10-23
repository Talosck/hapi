# mcode ↔ HAPI 七次复审：0.6.12 升级后的连接面（2026-10-23）

> 前六篇：`mcode-integration-review.md`（首轮 + 实施审计）、`-2.md`、`-3.md`（投递链路）、
> `-4.md`（后台任务计数）、`-5.md`（连接、重连与"客户端说的和 agent 做的不一样"）。
> 本文只写一件事：**MCode 升到 0.6.12 之后，HAPI 这条连接还能怎么优化**。
>
> 0.6.12 的变化清单见 agent 自带的 `CHANGELOG.md`（`@minimax-ai/code`），
> 本文不抄 changelog，只写**实测出来**的、跟 HAPI 连接面有关的部分。
>
> **本文同时是实施记录**：第 2 节那条已经修完并全量验证，记录在第三节。

---

## 一句话结论

**能优化，而且第一条就在脚下：HAPI 每次重连，都让 agent 把整段对话重播一遍给自己看，
然后自己丢掉。0.6.12 的 agent 已经支持 `session/resume` —— 同样的参数、不重播。**

本机实测（就用这条会话本身，它是本机最长的会话之一）：

| 重连方式 | 回来的通知 | 传输量 | 耗时 |
|---|---|---|---|
| `session/load`（HAPI 现在用的） | 164 条 | **718.4 KiB** | 4.6 s |
| `session/resume`（0.6.12 支持） | 3 条 | **52.7 KiB** | 3.1 s |

少 13.6 倍的字节、1.5 秒，而且少一整条"重播的东西会不会漏进聊天记录"的隐患面。

除此之外，0.6.12 还给了 agent **自己的队列**、**图片输入**、**跨 SSH 的 app-server**，
但都还不能直接吃，本文第四节逐条写清楚它们各自差在哪一环。

---

## 一、0.6.12 的 agent 现在对外是什么面

### 1.1 握手时 agent 主动广播的能力

`mcode acp` 的 `initialize` 结果（实测，非文档）：

```jsonc
{
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": { "list": true, "fork": true, "resume": true, "close": true }
  }
}
```

`_meta['minimax-code/extensions']` 里另有一组扩展方法/通知，HAPI 现在只认得其中四个：

| 扩展 | HAPI 用了吗 |
|---|---|
| `mcode/session/steer` | ✅ 用着（`mcodeExtensions.ts:42`） |
| `mcode/session/goal/*`、`mcode/session/delegation/*` | ✅ 用着 |
| `mcode/session/queue/{enqueue,list,update,delete,steer}` + `queue_update` 通知 | ❌ 没用 |
| `mcode/session/activate` + `current_session_update` 通知 | ❌ 没用 |

### 1.2 四个新接口的实测契约

全部用 `mcode acp` 起真 agent 探出来，参数名以 agent 的报错为准：

| 调用 | 入参 | 返回 |
|---|---|---|
| `mcode/session/queue/enqueue` | `{sessionId, text}` | `{itemId, status, position}` |
| `mcode/session/queue/list` | `{sessionId}` | `{items: [{itemId, status, source, content, attachments, modelInfo, createdAt}]}` |
| `mcode/session/queue/update` | `{sessionId, itemId, text}` | `{item}` |
| `mcode/session/queue/delete` | `{sessionId, itemId}` | — |
| `mcode/session/queue/steer` | `{sessionId, itemId}` | `{queueItemId, turnId}` |
| `mcode/session/activate` / `session/activate` | `{sessionId}` | `{sessionId}`，并广播 `current_session_update {sessionId}` |

`queue/enqueue` **只吃 text**，不接受附件 —— agent 自己的队列项结构里虽有 `attachments`
字段，但 ACP 这条口子没开。

---

## 二、本轮发现并已修

三处独立的修复：连接面本身的浪费（2.1 + 2.2）、0.6.12 升级**打断**的一处功能
（2.3 + 2.4）、以及一处交付格式的错配（2.5）。

### 2.1 【高】`session/load` 让 agent 把整段对话重播给 HAPI，HAPI 再丢掉

**现象.** HAPI 重连（agent 死过、runner 重启、CLI 重新连）时，走的是
`backend.loadSession()`（`mcodeRemoteLauncher.ts:639`）。这个调用会让 agent
把"它记得的整段对话"以 `session/update` 的形式推回来：用户消息、**agent 的思考
chunk**、agent 的答案，一个不落。

**取证.** `cli/src/agent/backends/acp/AcpSdkBackend.ts:588` 起那段注释自己就写了这件事：

> The agent replays the conversation it remembers. That replay is history: it must not
> reach the transcript...

也就是说，HAPI 装了一个临时 handler，**只**从重播里捡 `tool_call`/`tool_result`，
其余全部倒掉。实测代价（本机长会话）：

```
session/load   -> 164 notifications, 718.4 KiB, 4595 ms
session/resume ->   3 notifications,  52.7 KiB, 3104 ms
```

**为什么是问题.** 三层：

1. **纯浪费** —— 几百 KiB 的 JSON 走一遍 stdio、过一遍完整的 ACP 消息解析器
   （分块、去重、状态机），然后丢掉；
2. **延迟** —— 长会话上多出来的是秒级；
3. **隐患面** —— "重播的东西不能漏进聊天记录"这条规则，现在靠一个临时 handler
   守着。这类"漏一条"的洞，HAPI 这半年已经修过好几轮（`review-3`、`review-5`），
   能少一条重播路径就少一条。

**修.** 0.6.12 的 agent 支持 `session/resume`：入参与 `session/load` 完全一样
（`{sessionId, cwd, mcpServers}`），**不重播**，而且上下文还在 —— 实测 agent
resume 之后仍然记得前一轮说过"banana"，回的是 "banana"。

所以：

- `AcpSdkBackend.supportsSessionResume()`（`AcpSdkBackend.ts:397`）读
  `agentCapabilities.sessionCapabilities.resume`（布尔或空对象都算数，跟
  `supportsSessionFork()` 一个写法）；
- `AcpSdkBackend.resumeSession()`（`AcpSdkBackend.ts:653`）发 `session/resume`，
  不装重播 handler；
- `mcodeRemoteLauncher.connectAgent()`（`mcodeRemoteLauncher.ts:622`）：agent 说自己
  能 resume 就走 resume，不能就退回 `session/load` —— 老 agent 行为一点没变。

### 2.2 【中】重播里唯一有用的东西：agent 自己跑的那几轮

**问题.** `session/load` 的重播不是全无用处。HAPI 拿它来对账后台任务账本
（`mcodeRemoteLauncher.ts:648` 的 `onHistory`）：agent 在 HAPI 没看着的时候
自己起了个后台任务、或者读了一个已经跑完的任务，这些只存在于重播里。
丢了重播，账本就少了这一段。

**修.** 那些工具调用并不只在重播里 —— **agent 自己也把会话写盘了**：
`<sessionDir>/messages.jsonl`，一行一个 JSON，assistant 的消息里带 `toolCall` 块，
工具结果是一条独立消息。实测形状与 ACP 侧逐字对得上：

| 磁盘（`messages.jsonl`） | ACP 重播 |
|---|---|
| `{type:'toolCall', id, name, arguments}` | `{toolCallId, name, rawInput}` |
| `{role:'toolResult', toolCallId, content, details}` | `rawOutput = {content, details}` |

所以新增 `cli/src/mcode/utils/mcodeSessionTranscript.ts`：直接读那份 transcript，
取出工具调用与工具结果，喂给同一个 `backgroundTasks.reconcile()`。重连的路径上，
**整段对话不再过网络，账本照样准**。

对账用的 transcript 路径由既有的 `findMcodeMessagesPath()`（`mcodeUsage.ts:128`）解析，
文件名常量收敛到 `MCODE_TRANSCRIPT_FILE`，两处不再各写一份。

读不到 transcript 的时候账本留空 —— 这是安全的方向：宁可少算，不能把一个已经
结束的活儿算成还在跑。

### 2.3 【高】0.6.12 换了 broker 的目录布局，HAPI 找不到它，连接器应用读不出来

**现象.** 面板上写着：

> No MiniMax Code host is running, so the connected apps cannot be read.

而 agent 就在那儿跑着。这是 0.6.12 升级**打断**的，不是原来就坏的。

**根因.** 连接器工具（`mcode-tools`）只在 shared-broker 模式下签请求，签发租约的
broker 属于运行中的 MiniMax Code host。HAPI 找 broker 的方式是扫临时目录，找
`mcode-tools-tui-<pid>-*/run/mcode-auth-lease-v1.sock` —— **那是旧版的布局**。

0.6.12 把 broker 搬进了数据目录（从 agent 包的实现里读出来的）：

```
<dataDir>/run/mcode-auth-lease-v1.sock        共享实例
<dataDir>/run/mt-XXXXXX/mcode-auth-lease-v1.sock   每个 host 一个实例
```

本机实测（`ss -xlp`）：

```
u_str LISTEN ... /home/talos/.minimax/run/mt-9FhG4D/mcode-auth-lease-v1.sock
    users:(("minimax-code",pid=2202331,fd=22))
```

agent 确实起了 broker，就在新布局里；而旧布局那 21 个目录**全是死 pid**（都是升级前
留下的 TUI 目录）。于是两个来源都空 —— 按 pid 精确找（`mcode-tools-tui-<agentPid>-*`）
找不到，扫目录也扫不到 —— 就落到那句兜底文案上。

**修.**

- `discoverMcodeConnectorBrokers()` 增加数据目录这一路：共享实例 + `mt-*` 实例；
- 新布局的目录名里没有 pid，所以"谁还活着"由 **socket 的持有进程**回答：
  Linux 下 `/proc/net/unix` 给出 socket 的 inode，`/proc/<pid>/fd` 给出谁持有它；
- `findMcodeConnectorBrokerForPid()` 也走这条路，于是"问自己那个 agent"依然成立 ——
  实测按 pid 2202331 精确命中了 `mt-9FhG4D`；
- 旧布局继续认，老 agent 不受影响。

**验证.** 对着真机器跑：读到了 2 个 provider（`matrix` 13 个工具、
`email_workbench_credentials` 2 个工具），auth 状态 `authenticated`，没有错误。

### 2.4 【中】同一个根因也吃掉了额度读数

`mcodeTokenPlanQuota.ts` 用的是同一个 `preferredMcodeConnectorBrokers()`，所以五小时
额度的那个浮层也读不到，报的是同一句话的另一个版本（"No MiniMax Code host is running
on this machine"）。修了 2.3 之后它自己就好了 —— 实测读到
`{"remainingPercent":100,"resetAtMs":...}`。

### 2.5 【中】agent 写的交付标记，HAPI 不认，原样进了聊天

**现象.** 聊天里出现一坨原始标记：

```
<deliver-assets>
  <media type="text" src="/home/talos/coding/hapi/mcode-integration-review-6.md" title="..." />
</deliver-assets>
```

**那是什么.** MiniMax Code 的 runtime 让 agent 在最终答复里用 `<deliver-assets>` 声明
"我交付了这些文件"——**MiniMax Code 自己的应用**（TUI、桌面端）认这个标记，会渲染成
文件卡片。HAPI 的客户端不认，于是它就当普通文本显示出来，而且会留在聊天记录里。

**为什么不能就这么放着.** HAPI 自己已经有交付通道了：`display_image` / `display_video` /
`display_media` 三个 MCP 工具（`buildHapiMcpBridge.ts:99`），agent 调了，用户就能拿到
文件卡片。而 agent 之所以没用它，是因为 runtime 的系统提示让它用另一种写法。

**修.**

1. **CLI 侧剥离 + 改写成 HAPI 的文件引用**（`mcodeRemoteLauncher.ts` 的
   `emitAgentMessage`）：答复里的交付块被取出来，块里的文件改写成一行**文件引用**：

   ```
   Delivered: `mcode-integration-review-6.md`, `docs/chart.png`
   ```

   块本身不进协议 —— 所以 web、转录、复制文本、PWA、native app 全都干净了。
   只有"确实声明了文件"的块才被剥离：agent 只是**谈论**这个标记时（比如用户问
   "`<deliver-assets>` 是什么意思"），文本原样保留。

   **为什么是"相对路径 + 反引号"**：HAPI 的客户端本来就会把文件路径变成可点链接，
   但两端的规则一致 —— **相对路径**且扩展名在白名单里才会被链接，绝对路径不会
   （`web/src/lib/remark-file-path-links.ts:120` 和 iOS 的 `shouldLinkPath` 同规则）。
   所以 CLI 给的是**相对会话工作目录**的路径，写在行内代码里（web 的
   `linkInlineCodeNode` 与 iOS 的 `filePathLink(forInlineCode:)` 都会把它变成链接），
   点一下就进 HAPI 的文件查看器（`/sessions/<id>/file`）。
   工作目录**之外**的文件给不了相对路径，就保持纯路径文本 —— 那种链接点开必然是
   死的。
2. **工具描述里说明白**（`displayImagePrompt.ts`）：MCP 的工具描述是唯一能到达
   MiniMax Code 模型的通道（见 `58b759ec4` 那个教训：提示词写在工具描述里才管用），
   所以加了一句"这个 host 用卡片交付文件，答复里的 `<deliver-assets>` 块不被识别"。

**没有做的**：CLI **不**替 agent 把文件读出来塞进聊天。`display_media` 走的是用户
批准（`approval_mode: 'prompt'`），自动读文件会把这道闸绕过去。所以这里只报路径。

---

## 三、实施记录

### 3.1 改动文件

| 文件 | 改动 |
|---|---|
| `cli/src/agent/backends/acp/AcpSdkBackend.ts` | 新增 `supportsSessionResume()`、`resumeSession()` |
| `cli/src/mcode/utils/mcodeSessionTranscript.ts` | **新增**：读 agent 落盘 transcript 的工具调用/结果 |
| `cli/src/mcode/utils/mcodeSessionTranscript.test.ts` | **新增**：解析器单测（9 例） |
| `cli/src/mcode/mcodeRemoteLauncher.ts` | 重连优先走 `session/resume`；账本改从 transcript 对账 |
| `cli/src/mcode/utils/mcodeUsage.ts` | transcript 文件名收敛为 `MCODE_TRANSCRIPT_FILE` |
| `cli/src/agent/backends/acp/AcpSdkBackend.test.ts` | resume 能力判定与调用（3 例） |
| `cli/src/mcode/mcodeRemoteLauncher.test.ts` | resume/load 的选择、transcript 对账（4 例）；交付块剥离（2 例） |
| `cli/src/mcode/utils/mcodeConnectorTools.ts` | broker 发现：认 0.6.12 的数据目录布局，按 socket 持有者认 host |
| `cli/src/mcode/utils/mcodeConnectorTools.test.ts` | 新布局的发现、存活过滤、按 pid 精确命中（4 例） |
| `cli/src/mcode/utils/mcodeDeliverables.ts` | **新增**：解析并剥离 agent 的交付块 |
| `cli/src/mcode/utils/mcodeDeliverables.test.ts` | **新增**：交付块解析单测（11 例） |
| `cli/src/modules/common/displayImagePrompt.ts` | 工具描述里说明白"卡片才是交付方式" |

### 3.2 钉住的行为

- agent 说自己能 resume → 走 `session/resume`，**不**走 `session/load`；
- agent 说自己不能 → 退回 `session/load`，老行为不变；
- resume 之后账本照旧从 transcript 对账；
- transcript 读不到 → 账本为空，不猜；
- 数据目录里的 broker 按 socket 持有者过滤，崩掉的 host 留下的实例不算；
- 按 pid 找 broker，新旧两种布局都精确命中；
- agent 的交付块不进协议，文件改写成相对工作目录的路径引用；
- agent 只是谈论这个标记时，文本原样保留。

### 3.3 验证

```
bun run --cwd cli typecheck                     # 通过
bun run --cwd cli test src/mcode/utils/mcodeSessionTranscript.test.ts   # 9 passed
bun run --cwd cli test src/agent/backends/acp/AcpSdkBackend.test.ts     # 59 passed
bun run --cwd cli test src/mcode/mcodeRemoteLauncher.test.ts            # 83 passed
bun run --cwd cli test src/mcode/utils/mcodeConnectorTools.test.ts       # 41 passed
bun run --cwd cli test src/mcode/utils/mcodeTokenPlanQuota.test.ts       # 8 passed
bun run --cwd cli test src/mcode/utils/mcodeDeliverables.test.ts          # 11 passed
bun run --cwd cli test src/modules/common/displayImagePrompt.test.ts      # 3 passed
bun run test:cli                                # 全量：285 文件 / 3439 测试
```

**对着真 agent 跑的实测**（不是 mock）：

- `supportsSessionResume()` 对 0.6.12 的真握手返回 `true` ——
  0.6.12 的 agent 广播的是 `sessionCapabilities: {list:{},fork:{},resume:{},close:{}}`，
  能力是**空对象**而不是布尔，所以判定必须两种都认；
- `resumeSession()` 对真 agent 返回同一个 session id；
- **跨进程**：进程 A 建的会话，进程 A 被杀掉，进程 B 用 `session/resume` 接住，
  再问"我让你记的哪个词"，答 "banana" —— 上下文还在（这正是 agent 死掉后被拉起来
  那个场景）；
- 经 HAPI 自己的 `AcpSdkBackend` 走一遍同样流程，答案一样回来
  （`{"type":"text","text":"bana…"}` + `turn_complete`）；
- broker 那条：对真机器跑 `listMcodeConnectorApps()`，读到 2 个 provider
  （`matrix` 13 个工具、`email_workbench_credentials` 2 个工具），auth
  `authenticated`，没有错误；按 agent 的 pid 2202331 精确命中它自己的那一个 broker
  （`mt-9FhG4D`）；额度读数也从"没有 host"变成
  `{"remainingPercent":100,"resetAtMs":…}`。

---

## 四、0.6.12 还给了什么，为什么这次没直接用

### 4.1 agent 自己的队列（持久、幂等、有推送）

0.6.12 的 agent 有自己的消息队列，落在它自己的 SQLite 里
（`local_runtime_queue_items`，带 `client_request_id` / `dedupe_key` / `claim_lease`），
并且用 `mcode/session/queue_update` 通知实时推送队列状态。

**HAPI 今天的做法**是另一套：agent 忙的时候，它会**拒绝**这一轮（"Session already has
an active Turn"），HAPI 收到这个拒绝后，把这批消息退回 hub、释放租约、按 1s→2s→4s→
…→60s 的退避重试（`mcodeRemoteLauncher.ts` 的 `MCODE_BUSY_RETRY_BASE_MS` 一族）。

**为什么这次没直接换成 agent 的队列**：实测下来，**队列里那条消息跑完之后，答案不会
回到 ACP 客户端**。agent 确实把它当一轮跑了（用量涨了、标题也照那条消息推出来了），
但 `session/update` 里**没有** `agent_message_chunk`；答案只写在磁盘那份 transcript 里。

也就是说，直接用 agent 的队列 = 用户在 web 上发一条消息，等 agent 干完了，**界面上一片
安静**。要能用，就得再补一条"从 transcript 把答案读回来"的链路 —— 那是另一个量级的改动，
而且会牵扯到"这一轮到底算谁的"。

**可行的顺序**（建议，不建议这轮就做）：

1. 先把 HAPI 自己的队列改成 agent 的队列（持久 + 幂等 + 推送），**答案仍然走
   `session/prompt`** —— 也就是只把"等 agent 空闲"从轮询换成 agent 的队列；
2. 再单独解决"队列这一轮的答案怎么回给客户端"。

### 4.2 `session/activate` 与 `current_session_update`

agent 的运行时只有**一个**"当前会话"。`session/activate` 会把自己设成当前会话，
并广播 `current_session_update`；当前会话的连接断开时，广播的是
`current_session_update {sessionId: null}`。

**实测：HAPI 不理它也没事。** 对非当前会话发 `session/prompt` 是正常工作的
（`stopReason: end_turn`），队列也是按 session 存的，跟"当前会话"无关。
所以这**不是 bug**，只是一个可以拿来用的诊断信号：本地 TUI 和 HAPI 共享同一个运行时，
用户可能在终端里另开了一个会话。

### 4.3 ACP 图片输入

0.6.12 起 ACP 的 prompt 接受图片（PNG / JPEG / WebP / GIF），agent 也会在
`session/load` 时重放图片附件。agent 侧已经就绪（`promptCapabilities.image: true`）。

**HAPI 这边还没有**：`cli/src/agent/types.ts:21` 的 `PromptContent` 只有 `text` 一种。
要接就得动协议、web 的上传、hub 的存储、CLI 的 prompt 组装 —— 是一整条产品线，
不是连接面的小修。

### 4.4 `mcode app-server`（跨 SSH）

0.6.12 新增了独立的 app-server，可以经 SSH 连远端 Runtime，带断线重连、鉴权状态和
版本升级。HAPI 现在的远程是"自己在远端起 `mcode acp`"，换成 app-server 是一次连接
形态的替换，得先想清楚它跟 HAPI 现有的远程/本地两种模式怎么共存。

### 4.5 0.6.12 changelog 里跟连接面无关但值得知道的

- 退役的官方模型会自动切到当前默认模型，而不是失败；
- `config.yaml` 新增 `permission.nativeDelete`；
- 本地插件可以自己声明 subagent。

---

## 五、这轮没做的（留着的）

- agent 原生队列当投递通道（4.1，差"答案回传"那一环）；
- ACP 图片输入（4.3，差协议与前端那一整条线）；
- `mcode app-server` 作为第四种连接形态（4.4，差形态取舍）；
- `current_session_update` 的诊断用途（4.2，有价值但不是 bug，先不动）；
- **扩展客户端的可链接扩展名白名单**（见下）。

### 5.1 交付文件只在白名单里的扩展名才会变成链接

2.5 那条修完，交付的文件路径会出现在聊天里，但**会不会变成可点的链接**，由客户端
决定：web 的 `shouldLinkPath()`（`web/src/lib/remark-file-path-links.ts:116`）和 iOS 的
`shouldLinkPath`（`ios/.../MarkdownTransforms.swift:467`）都要求

1. 是**相对路径**（这条 CLI 已经保证了），并且
2. 扩展名在 `COMMON_FILE_EXTENSIONS` 白名单里。

白名单里有 `md / txt / json / png / jpg / webp / svg / csv / …`，但**没有 `pdf`、
`zip`、`mp4`、`webm`** —— 两份白名单目前完全一样，都是 64 个扩展名（源码/文档/配置
那一类）。

所以交付一个 `report.pdf`、`bundle.zip` 或 `demo.mp4` 时，用户能看到路径，但那行
**不是链接** —— 点不了。

要修就得同时改 web 和 iOS 两份白名单（两边要一致，否则同一个文件在两端行为不同），
而这两份是**客户端**的改动，跟 MCode 无关 —— 所以留到客户端那轮一起做更合适。

---

## 六、复现本文所有结论的办法

```bash
# 起一个真的 agent，握手看它广播什么
mcode acp   # 然后发 initialize，看 agentCapabilities

# 看 agent 自己的队列长什么样
sqlite3 ~/.minimax/v2/sqlite/runtime-state.sqlite \
  "select session_id,item_id,status,source from local_runtime_queue_items order by rowid desc limit 5;"

# 看一个会话在磁盘上留下了什么
ls ~/.minimax/v2/sessions/2026/10/23/*/messages.jsonl
```
