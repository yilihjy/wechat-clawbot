# 微信桥：设计决策记录

> 本文只记录**已定**的决定与实际测到的事实；未定项集中在 §4，先讨论、再落成代码。
> 编号稳定，后续讨论请引用 `D7` / `Q3` / `F2` 这样的编号。
>
> 仓库分工：
> - **`wechat-clawbot`（本仓库）**：微信 ⇄ DSH 的桥，本方案的宿主。
> - **`dsh-auto-review`**：`@deepseek-ai/dsh-experimental-auto-review` 的分叉，加回复通道白名单。
> - **`global-seo`**：工作台（采集收件箱 / 知识库），只提供 HTTP 接口，桥调用它。

最后更新：2026-11-02

---

## 1. 形态与分工

### D1 微信端默认是「专属 agent」

微信消息默认进入**一个专属 DSH 会话**（`wechat-main`），不是接管你正在用的会话。它有自己的上下文、记忆与工作目录，你在桌面端也能打开同一会话继续。

### D2 relay 模式：微信临时变成「会话前端」

`#接管 N` 之后，微信消息直接进入被接管的**真实会话**，回复以 `[会话标题]` 前缀镜像回来；`#交还` 切回专属 agent。两种模型并存，靠命令切换。

### D3 完整的消息管道

```
微信消息
  ├─ ① 准入        allowFrom（只认扫码人）
  ├─ ② 归一        取正文 / 去引用前缀 / 收集媒体
  ├─ ③ 命令路由    【确定性，无模型】# 前缀 + 整条精确匹配
  │      ├─ 命中 → 执行处理器 → 回执
  │      └─ 未命中 → ④
  └─ ④ 默认处理器  按当前模式分派 → 专属 agent / 被接管的会话
```

命令路由必须排在「待答审批消费」**之前**，否则审批挂起时 `#任务状态` 会被当成答复吃掉。

### D4 工作区与提示词

- 专属 agent 的 `cwd = ~/workspace`（当前实测是 `~/.dsh/profiles/desktop`，待改，见 Q1）。
- AGENTS.md / CLAUDE.md 注入**保留**（`workspaceInstructions` 开着）。

### D5 模型：桥镜像会话的选择

会话**自己拥有**模型：界面上切换 → 写 `model/selection` → 桥把这个值镜像进它安装的选择引用
→ 下一次请求头跟进 → 审查（若开）也随之走同一条路由。

桥仍然安装一个初始值（否则系统提示词的 `{{model}}` 取不到值，整轮直接报错），
但那个值不再"锁死"：之后每次 `model/selection` 都会覆盖它。

**例外**：`config.model` 显式配置时是钉死的（此时 UI 切换无效，属于设计）。

走 **DeepSeek 官方 key**（`deepseek-official/deepseek-flash`，1M 上下文，支持图片）。

### D6 会话膨胀

保留上游的空闲压缩（`idleCompaction`：空闲 10 分钟且上下文达 85% 触发宿主 `/compact`）；`#新会话` 作手动逃生口。

---

## 2. 命令层

### D7 `#` 前缀 + 整条精确匹配

- 前缀 `#`（不用 `/`：DSH 自己也用 `/`，叠加会分不清哪层）。
- 匹配规则：`^<命令词>(\s+参数)?$`，先归一（去首尾空白、去句末标点）。
- 词表**按长度倒序**匹配（否则「任务」会吃掉「任务状态」）。

### D8 未知命令

`#` 开头但不在表里 → 回帮助，**不下发给 agent**。让"打错命令"有确定结果。

### D9 逃逸

`> ` 开头：剥掉前缀，原文送 agent（用于说出字面的 `#任务状态`）。

### D10 命令表

`✅` = 已实现；其余是排在后面、还没动手的（**只有已实现的名字会被认成命令**，
打错的名字回帮助，不会下发给 agent）。

| 命令 | 作用 | 状态 |
|---|---|---|
| `#任务状态` | 概览：在跑 + 最近完成 | ✅ |
| `#任务状态 N` | 展开第 N 条 | ✅ |
| `#接管 N` | 进入 relay，绑定第 N 个会话（编号与 `#任务状态` 同一套） | ✅ |
| `#交还` | 回专属 agent | ✅ |
| `#当前模式` | 报告模式、会话、工作区、采集开关 | ✅ |
| `#入库 <url>` | 强制投递到工作台收件箱 | ✅ |
| `#帮助` | 清单 | ✅ |
| `#会话列表` | 可接管的会话（`#任务状态` 已经把这件事做了，暂不单列） | ✗ |
| `#新会话` | 新建并接管 | ✗ |
| `#停一下` | 打断当前回合 | ✗ |
| `#允许` / `#拒绝` | 答复待批审批（D12 的前置） | ✗ |
| `#模型` | 列模型 / 切换 | ✗ |

### D11 只读命令优先

只读命令（`#任务状态` / `#当前模式` / `#帮助`）**永不被**待答审批吞掉。

### D12 审批只能用显式命令

待答审批只接受 `#允许` / `#拒绝`；其它文本一律当新消息，pending 保留。
（上游行为是"非答复即拒绝并吞掉该条消息"，已确认要改。）

### D13 写命令与 pending 共存

有 pending 时，写命令（`#接管` / `#交还` / `#入库`）只提示、**不阻断**。

### D14 `#停一下` 的语义

- agent 模式：直接停。
- relay 模式：二次确认（回「停」才真停），因为可能打断你在桌面上跑的长任务。
- 有审批卡时：卡片属于被取消的回合，会一并作废（技术上无法"留着卡"，见 F4）。

---

## 3. 模式、采集、账本、输出

### D15 relay 的回复

按 `turn/end` **聚合，一个回合一条**，带 `[会话标题]` 前缀。

### D16 relay 的审批

被接管会话的审批也推到微信（扩展现有 `ApprovalRelay`）。

### D17 relay 期间 agent 的任务

不打断；完成照常推送。relay 只决定**新消息**去哪。

### D18 relay 的来话包装

微信来话包成「用户在微信里说：…」，让桌面端一眼看出不是自己敲的。

### D19 模式状态

按对话存（`conversationKey`），持久化 `modes.json`，重启恢复；启动时校验会话存活，失效则回 agent 并告知。

### D20 relay 自动过期

30 分钟无消息 → 自动回 agent。

### D21 采集的三种入口

`#入库 <url>`、裸 URL（整条就是链接）、图片 + `#入库`。

### D22 `[链接]` 卡片自动入库

分享来的卡片到达时是 `[链接] 标题+长链` 的**文本**，直接快路径入库，不限于公众号。

### D23 快路径优先于模式

纯链接 / 卡片 / 图片不进 agent（省 token、秒回），无论当前处于哪种模式。

### D24 URL 归一

- 长链（`__biz/mid/idx/sn` 齐全）→ 直接归一。
- 短链 → 抓落地页，**取第一个非空**的 `var biz/mid/idx/sn`，再合成长链。
- 标题取 `og:title`（`<title>` 为空）；正文取 `#js_content`。

### D25 采集失败的三类回执

| 情况 | 行为 |
|---|---|
| 抓不到（412 / 验证壳 / 超时） | **不建条目**，只回执；链接留在账本里可重试 |
| 正文过短（< 200 字） | 仍入库，回执标注「正文偏短」 |
| 重复（canonical_url + 内容哈希命中） | 回执带已有条目编号，不新建 |

### D26 不支持的入站形态

转发来的聊天记录 `zip`、引用回复（`ref_msg` 只有 id 没有内容）→ 明确回执，不静默丢弃。

### D27 入站图片直接复用

插件已把入站图片解密落盘到 `~/.dsh/clawbot/inbound/<ts>-<hash>.jpg`（0600），采集直接引用该文件，**不再自己下 CDN 解密**。

### D28 命令账本

- 每条命令一条结构化记录：`ts / command / args / result / undo / mode`。
- **只存参数与结果，不存消息原文**。
- 按日分文件 `state/ledger/YYYY-MM-DD.jsonl`，保留 90 天。

### D29 命令注入

只对**有副作用**的命令向 agent 注入一行（如 `[命令] 16:32 #入库 → 已进收件箱《…》（capture a3f，可撤销）`）；只读命令不注入。
时机：agent 空闲立即注入，正在跑则等 `turn/end`。

### D30 撤销

- `command_ledger` + `undo_command` 两个工具。
- 只有一条候选且类型匹配 → 直接撤并告知；多条候选 → 列出编号问。
- 撤销边界：`#入库`（未 accept）可撤 → 走工作台 reject；已 accept 不可撤；`#接管`/`#交还` 可撤；`#新会话` 不可撤；`#停一下` 不可撤。
- **前提**：工作台需要一条 extension 侧 reject 端点（现有 `/captures/:id/reject` 是 `requireUser`），单独开一个 OpenSpec 变更。

### D31 长回复的分段

| 长度 | 行为 |
|---|---|
| ≤1200 字符 | 一条 |
| 1200–5000 | 按段落拆，最多 3 条，标「（n/m）」 |
| >5000 | 落成 `.md` 文件发过去，正文给一句「全文见附件」 |

### D32 时间线页面

插件自带的 HTML 页面（`/plugins/wechat/timeline`），**只认本机来源**（loopback + Host 校验），浏览器直接打开；按日切换，分「做了 / 失败 / 值得注意」，失败项可重试。

### D33 日报

**不推微信**。页面按日期渲染时顺手生成 `reports/YYYY-MM-DD.md`，不做定时任务。

### D34 页面数据边界

v1 不写入工作台，桥自己留 90 天。

---

## 4. 工程约定

### D35 仓库与同步

- 桥的 fork 在 **`~/workspace/wechat-clawbot`**（独立仓库，不进 `global-seo`）。
- **直接在 `main` 上开发**（安装路径指向工作树，避免切分支后跑到上游代码）。同步规则：
  1. **只用 rebase**：`git fetch upstream --tags && git rebase upstream/main`；
  2. **不用 GitHub 的 "Sync fork"**（它做 merge，历史变脏）；
  3. rebase 前打备份分支 `backup-YYYYMMDD`；
  4. 提交**按主题拆**（`local: capture` / `local: commands` / `local: relay` …），不压成一个巨型提交。
- `UPSTREAM.md` 记录上游 tag / commit 与本仓库改动清单。

### D36 不删上游代码，只加开关

本仓库的改动定为"新增文件 + 注入点小改"，注入点用 `// >>> local` / `// <<< local` 包围，便于冲突定位。
目前唯一必须新增的开关是 `claudePeer`（上游无条件注册 3 个工具）。

### D37 测试

- 纯函数单测（命令解析、URL 解析、四元组抽取、payload 构造、分段器、账本）留在本仓库，**不进 `global-seo` 的 CI**。
- 真机冒烟测试最后与维护者一起验收。

### D38 单轮询者

同一个 ClawBot 绑定同一时刻只能有一个轮询者；探针与插件互斥。

### D39 凭证

凭证目录 `~/.dsh/clawbot`（`accounts/` + `openclaw-weixin/accounts/`），0600，不进仓库。
探针阶段的绑定可直接沿用，无需重新扫码。

### D40 日志

结构日志默认写；消息全文只在 debug 开关下写（本机暂不脱敏，开关预留）。

### D42 `#任务状态` 的输出格式

编号**跨两条列表连续**（这样 `#任务状态 3` 和 `#接管 3` 指同一个会话），失败项带「失败」字样：

```
在跑 2 个
1. 信源模块重构 · global-seo · 12m04s
   最近工具: bash · 最后一句: 现在跑测试…
2. 音乐站脚手架 · auto-project · 3m11s
   最近工具: edit

最近结束
3. 微信桥调研 · 18:40 完成 · 6m12s
4. 旅行站配图 · 18:02 失败 · 2m33s

#任务状态 1 展开 · #接管 1 接管
```

### D43 agent 的自我认知提示词（五段）

1. **我是谁**：微信里那个 agent，工作在 `~/workspace`；主要项目在 `~/workspace/global-seo` 等。
2. **我能看到什么**：`list_dsh_sessions` / `read_dsh_session` 是会话的**权威视图**，不要自己去翻 `~/.dsh/sessions` 或 zstd 文件。
3. **什么时候该接管**：需要**持续对话**才用 `take_over_session`；只是"看一眼"用 `read_dsh_session`。
4. **回复规矩**：走 `send_wechat_text`；短、分条、不复述用户的话。
5. **危险动作**：改仓库前先读该仓库的 `AGENTS.md`。

### D44 审批超时

`approvalTimeoutMs` 设为 **30 分钟**：超时撤卡并回一句「审批超时，这一轮已停」。
（上游默认 0 = 永不超时，会让一个回合无限挂着。）

### D41 自动审查：三层门禁

由 `dsh-auto-review`（官方包的本地分叉）审，**不注册任何 preset**：

1. **会话**：`reviewSessions`（本部署 `[wechat-main]`）——其他会话零影响；
2. **档位开关**：`reviewPreset: wechat-auto` —— 权限选择器选中它 = 审查开，换成任何别的档位 = 关；
3. **provider 闸门**：`reviewProviders: [deepseek-official]` —— 不在名单里的 provider 直接跳过审查
   （`opencode-go` 的网关要求 `x-opencode-session`，评审请求必 400；fail-closed 会把整个工具层打死）。

`replyTools`（`send_wechat_text` / `send_wechat_file`）跳过审查。卸载时不改任何会话的权限旋钮。

---

### D45 采集一律先入 pending

`#入库` / 裸链接 / `[链接]` 卡片都发 `POST /api/v1/extension/captures`，**不传 `mode`**
（= pending），不在桥里做 accept：收件箱是给人看的，而且 D30 的"未 accept 可撤"要成立。
正文过短（< 200 字）也照样入 pending，只是回执里注明「正文偏短」。

### D46 relay 期间的审批也走微信（只在你刚用过手机时）

被接管会话的 `approval/request` 现在也推到微信，提示里带《标题》（`approvalRoute()` 是纯函数，
`test/approvals.mjs` 覆盖每种组合）。

但**不是整个 30 分钟都抢**：判断用 `peerFor(session)` + **5 分钟新鲜度**（`RELAY_FRESH_MS`）。
手机最近 5 分钟用过这个绑定 → 微信答；超过 5 分钟 → `next()` 交回桌面。

理由：接管窗口是 30 分钟，人却可能早就坐回桌面了。把桌面正在看的审批抢到手机上，
会让那个回合在两边都等着（`approvalTimeoutMs` 默认还是 0，永不超时）。
专用微信会话的审批行为完全不变，包括"没有 activeSender 就 fail closed"——
那条不能改成 `next()`，否则微信会话会在桌面上弹窗。

答审批仍然用**纯文本**（同意 / 拒绝），不是 `#允许` / `#拒绝`——D12 还没做。

### D47 relay 的回复走同一条文件通道

D31 的分段规则在 relay 上照旧，但 >5000 字改走 `sendFileTo`（与 `send_wechat_file` 同一条
压缩/CDN 检查），发 `reply.md` + 一句「全文见附件」。没有账号时退化成三段 + 「已截断」。

### D48 游标改成"处理完再落盘"

上游是「先存游标、再逐条处理」，崩溃在批次中间会**永久跳过**剩下的消息。
本分叉改为处理完这一批再落盘（至少一次投递），并用 `sync-buf.json.seen.json`
记住最近 500 条已处理的消息 id（`client_id`，没有则 `seq:`；**不用 `message_id`**，
它超过 2^53 会取整）。崩溃后最多重放一批，重放的那批会被已见集合挡住，不会重复回复。
被 abort 打断的批次**不推进游标**。

## 5. 实测事实（证据，勿改）

### F1 协议与消息形态

| 入站 | item type | 形态 |
|---|---|---|
| 纯文本 | 1 | `text_item.text` |
| 分享文章卡片 | **1（文本）** | `[链接] <标题><长链>`，标题与 URL **无分隔符**；带 `chksm/mpshare/scene/srcid/sharer_shareinfo/#rd` |
| 复制链接 | 1 | 短链 `https://mp.weixin.qq.com/s/<id>` |
| 图片 | 2 | `image_item.aeskey`(hex) + `media.full_url` + `mid_size/thumb_*` |
| 文件 | 4 | `file_item.file_name/md5/len`（**`len` 可能是字符串也可能是数字**）+ `media.full_url` |
| 语音 | 3 | 带腾讯转写 `voice_item.text`；speex / 16 kHz / 16 bit |
| 转发 | 4 | `聊天记录_<日期>.zip`，内含 GBK 文件名的 txt |
| 引用 | 1 + `ref_msg` | 只有 `msg_id` 与时间戳，`type: 0`，**没有内容** |

- 信封 `message_id` 超过 2^53，JSON 解析会丢精度（实测真值 `…56616` 被解析成 `…56000`）→ **去重/引用一律用 item 的 `msg_id`（字符串）或 `client_id`**。
- 媒体下载：`media.full_url` 免认证直下 → `media.aes_key` 是 **base64(十六进制字符串)**，再 hex 解码才是 16 字节密钥（`image_item.aeskey` 本身即 hex）→ AES-128-ECB；md5 与 `file_item.md5` 对得上。
- 主动发送必须有 `context_token`，否则服务端静默丢弃（库会抛错）。
- 分享卡片的 URL 抓取：长链页面首次出现的 `var biz/mid/idx/sn` **是空串**，真值在后面；短链页面首次即非空 → 必须"取第一个非空"。

### F2 传输层归属

`ctx.on('session/event', …)` 在根上下文注册，接收**所有会话**的事件（Cordis 子上下文原型继承共享同一张 hook 表；session store 用 `emitCtx: this.ctx` 发事件）。→ relay 不需要 `sessionController`，换过滤器即可。

### F3 自动审查故障的真实原因（2026-11-01 复现两次）

官方 `auto` 档下，审查请求走**会话的 provider**；若落到 `opencode-go`，因缺少 `x-opencode-session` 头返回 400 `MissingSessionID`，而 auto-review 是 fail-closed → **所有工具都不执行**，连 `send_wechat_text` 也失败（agent 变哑巴）。

### F4 官方的发送判定

官方 `auto` 把 `send_wechat_text` 判为 medium（"non-sensitive external send"），只有在当前用户消息**明确授权**时才放行；纯发图/无指令时 → 拒绝 → 转人工审批（实测等待 10–111 秒）。

### F5 审批卡与回合绑定

审批请求挂在发起它那一回合的 `AbortSignal` 上，回合被取消 → 卡片作废（`settle('cancelled')`）。所以"停回合但留卡"在现有架构下不成立。

### F6 插件的本地状态

`~/.dsh/clawbot/` 下有 `accounts/`、`openclaw-weixin/accounts/`（游标）、`inbound/`（解密后的入站媒体）、`memory.md`、`mcp-token`、`sessions/wechat-main.json`（会话创建标记）。

### F8 模型路由的真正来源

审核请求的路由取自 **`session.requestHeader()`**（`src/index.ts:372`，再传给 `ctx.llm.stream`）。
而会话自己的"当前模型"也是从同一处折叠出来的（`model/selection` → `pending`，`request/header` → `lastUsed`，
`current() = pending ?? lastUsed`）。

所以：界面点选只写 `pending`；**只有真的发出去的那次请求才会推进 `lastUsed` 与请求头**。
若插件另外安装了 `ModelSelectionRef` 覆盖（旧行为），请求头永远不会推进，审核就一直用旧路由 → 持续 400。

### F9 两个组合的实测（2026-11-01 22:50–23:00）

| 组合 | 结果 |
|---|---|
| 官方 key + 审查开（`wechat-auto` 档） | `request/header` = `deepseek-official/deepseek-flash`；13 次工具调用零 400，回复免审 |
| opencode-go + 审查关（`danger-full-access` 档） | `request/header` 在 22:55:40 **随 UI 切换推进**到 `opencode-go/deepseek-v4.1-flash`；20+ 次工具调用零 400 |

结论：
- **镜像修复成立**——`model/selection` 能推进请求头（修复前 22:17 那次一动不动）；
- **档位开关成立**——换档位即开/关审查；
- **provider 闸门成立**——opencode 下审查自动跳过，不会把工具层打死。

代价：opencode 这条路由**无法被审查**（网关要求 `x-opencode-session`，评审是独立请求），
等上游修好 header 透传前，它就是"无审查的全权模式"。

### F10 命令层生效的判据（2026-11-02 00:14 实测）

命令的答复**不经过 agent**，所以证据是"入站有、会话没有"：

```
inbound-raw.jsonl     00:14:16 seq=52 text='#帮助'
                      00:14:43 seq=53 text='#当前模式 '

会话日志              00:13:59 turn/end  ←「在线吗」结束
                      00:15:23 turn/start ←「很好，告诉那个对话…」开始
                      （中间两条命令：没有 turn、没有 tool/call）
```

对照生效前：23:43:10 的 `#帮助` 曾经创建过一个 turn，并让 agent 用 bash 找了十几次。
所以"命令走后没有 turn"就是命令层接管的硬判据。

### F11 采集链路实测（2026-11-02 00:34）

拿用户自己发过来的那张公众号卡片（`inbound-raw.jsonl` 里的真实长链）跑 `captureUrl`，
对面是一个本地回声服务器（记录收到的 multipart）：

```
页面      HTTP 200，3,583,452 字节（含 script/style）
抽取      标题 = og:title；正文 3,342 字；html 去 script/style 后 86,303 字节（< 4 MB 上限）
归一      og:url → 只留 __biz/mid/idx/sn，chksm 等全部丢掉
请求      POST /api/v1/extension/captures，Bearer，multipart 里 payload 可解析，
          accountKind=wechat，**没有 mode 字段**（pending）
```

也就是说：公众号文章在**服务端**就能抓（不需要浏览器），手机 UA 足够；
`chksm` 那类参数必须丢掉，否则同一篇文章会被当成新链接。

### F7 本机版本

DSH `0.2.1-rc.5`（检查兼容性时用 `includePrerelease`，所以 `0.2.1-rc.x` 满足 `^0.2.1-rc.1`）；`@deepseek-ai/dsh-experimental-auto-review` 分叉自 tag `dsh-v0.2.1-rc.5`。

---

## 5.1 进展（2026-11-01）

**已落地并实机验证**

| 项 | 位置 |
|---|---|
| 桥的分叉（上游 + 19 行模型镜像 + 本文件） | `~/workspace/wechat-clawbot`，`main` |
| 审核的分叉（按会话 + 档位开关 + provider 闸门 + 回复白名单） | `~/workspace/dsh-auto-review` |
| profile 配置 | `clawbot`（cwd/provider/model）、`permission.presets.wechat-auto`（显示「微信自动审查」）、`auto-review-wechat` |
| 凭证迁移（复用探针绑定，未重扫码） | `~/.dsh/clawbot/{accounts,openclaw-weixin}` |
| 两种组合实测（见 F9） | 官方 key + 审查开；opencode + 审查关 |
| 入站形态全测（见 F1） | 文本 / 卡片 / 短链 / 长链 / 图片 / 文件 / 语音 / 引用 / 转发 / 连发 |
| 媒体解密链路 | `full_url` → base64(hex) 密钥 → AES-128-ECB，md5 校验 |
| **命令层 v1 已上线**（`#帮助` / `#当前模式` / `#任务状态`、`>` 逃逸、未知命令回帮助） | `src/commands.ts` + `inbound.ts` 的钩子（插在 pending 消费之前）+ `test/commands.mjs`（23 条断言）。2026-11-02 00:13 重启后生效 |
| **采集快路径**（`#入库` / 裸链接 / `[链接]` 卡片；token 是配置项） | `src/capture.ts` + `test/capture.mjs`（69 条断言）；配置 `captureEnabled` / `captureBaseUrl` / `captureToken`（三个都是热字段）。**未上线**，等重启 |
| **relay**（`#接管 N` / `#交还`，30 分钟自动交还，按回合镜像，审批也转发） | `src/modes.ts`（模式持久化）+ `src/relay.ts`（镜像与分段）+ `src/approvals.ts`（按会话路由，5 分钟新鲜度）+ 三个测试文件（86 条断言）。**未上线**，等重启 |
| **两个债已修**（游标、入站原文日志） | `src/monitor.ts`（处理完再落盘 + 已见集合）、`src/inbound.ts`（原文日志只在 debug 落盘，即上游 PR #4） |
| 账本 / 时间线 / 日报 | **未实现**（决策已定，见 §3） |
| 账本 / 时间线 / 日报 | **未实现**（决策已定，见 §3） |

**上游 PR**

- `#2` `fix(model): follow a model picked in the web UI when nothing is pinned`（19 行，分支 `pr/model-follow-ui`）；
- `#3` `feat(config): add a claudePeer switch for the Claude Code tools`（+24/−5，`pr/claude-peer-switch`）；
- `#4` `fix(inbound): only dump raw inbound messages at debug level`（+24/−16，`pr/inbound-raw-log-switch`）——
  **本分叉已经吃进来**（`inbound.ts` 的 `// >>> local` 块），上游接受后 rebase 会自动去掉；
- `#5` `fix(config): resolve cwd and make the effective directory visible`（+17/−1，`pr/cwd-validation`）。

#2 的 19 行本地改动同样已经合进 `main`，若被接受，rebase 后 fork 的源码 diff 会自然归零。

**待提的上游候选**

1. `claudePeer` 缺开关 —— **已提**（PR #3）；
2. 入站原文日志无开关 —— **已提**（PR #4），分叉里也已经吃进来；
3. 游标先落盘再处理 —— **本地已修**（D48），还差一个 issue + PR。上游那版要连
   "已见集合" 一起提，否则把至少一次投递换成了重复回复，等于换个坑；
4. `approvalTimeoutMs` 默认 0（永不超时）—— 还没动。

## 6. 未定（讨论中）

| 编号 | 议题 | 影响面 |
|---|---|---|
| Q1 | 现有 `wechat-main` 会话的 `cwd` 怎么迁移（配置只对新建会话生效） | 中 |
| Q3 | `#模型` 的模型清单来源（只列 deepseek-official 还是全部） | 小 |
| Q5 | 要不要造一个"该被拦"的反例，验证审查真的会拒绝 | 中 |
| Q6 | 时间线页面的版式：要不要按会话分组 / 搜索 | 小 |
| ~~Q7~~ | relay 期间收到链接记在哪 | 已由 D23 回答：链接一律走采集快路径，两个会话都不进 |
| Q8 | 账本损坏容忍（半行 / 并发写） | 小 |
| Q9 | DSH 升级后 fork 怎么跟（tag 对齐 + diff 脚本） | 中 |
| Q11 | 采集要不要带 `siteKey`（现在不带，accept 时由人在工作台选） | 小 |

### 本轮结论：以下原本挂在 §6 的已拍板

| 原编号 | 结论 | 落到哪 |
|---|---|---|
| Q2 | `#任务状态` 用"编号跨两条列表连续 + 失败项标注"的纯文本模板 | D42 |
| Q4 | 补五段自我认知提示词（我是谁 / 我能看什么 / 何时接管 / 回复规矩 / 危险动作） | D43 |
| Q10 | 审批超时 30 分钟（撤卡 + 回一句「审批超时，这一轮已停」） | D44 |

## 7. 已知技术债

1. `cordis.patch.yml` 可能被 GUI 重写，`wechat-auto` 那行会丢（有 `# >>> local` 标记与备份兜底）。
2. `wechat-auto` 与官方 `auto` 的旋钮完全相同，靠"存档身份"区分；手动拧 sandbox/approval 旋钮会退化到"表里第一个匹配项"。
3. ~~上游两个 bug：游标先落盘后处理、入站原文无条件写盘~~ —— **已修**（D48；PR #4 的开关已吃进分叉）。
   代价：`monitor.ts` 与 `inbound.ts` 各有一段 `// >>> local`，rebase 时要留意上游是否自己修了同样的事。
4. `wechat-main` 的归档/删除只能走 GUI。

## 9. 下一步（排序）

| 顺序 | 事情 | 状态 |
|---|---|---|
| **1** | 命令层最小闭环：`#帮助` / `#当前模式` / `#任务状态` + 路由骨架 | ✅ 已上线（00:13 重启后生效，F10） |
| **2** | 采集快路径：`#入库` / 裸 URL / `[链接]` 卡片 | ✅ 代码完成、离线验证（69 条断言）＋真实文章链路实测（F11）；**要重启才上线** |
| **3** | 两个债：游标先落盘、入站原文日志 | ✅ 已修（D48），**要重启才生效** |
| **4** | relay：`#接管 N` / `#交还` / 30 分钟自动交还 / 按回合镜像 / 审批转发 | ✅ 代码完成、离线验证（86 条断言）；**要重启才上线** |

### 上线这一步（要人做）

本次改动全在插件里，**不重启不会生效**（命令层当时也是这样验证的）。
重启后按这个顺序验收：

1. `#帮助` —— 应该多出 `#接管 N` / `#交还` / `#入库 <链接>` 三行（命令表是活的判据，不用等模型）；
2. `#任务状态` —— 记下编号，然后 `#接管 1`，看回执里的《标题》与剩余分钟；
3. 在桌面端那个被接管的会话里发一句「你好」，微信应收到 `[标题] …`（一个回合一条）；
4. 发 `#交还`，再发一句话，应该回到专属 agent；
5. 采集要先把 token 填进设置（下一条）。

### 采集上线前要做的一件事

`captureToken` 现在还是空。工作台页面「信源 → 浏览器插件」生成配对码 → 换 token →
填进 `clawbot` 那一行的 `captureToken`（`captureBaseUrl` 默认 `http://127.0.0.1:4310`，
`captureEnabled` 打开）。三个字段都是热字段，填完下一条消息就生效，不用再重启。

**现在不做**：时间线页面、日报、命令账本与撤销。
它们要么"用久了才需要"，要么依赖别的东西（撤销要工作台先开一个 extension 侧的 reject 端点）。

### 开工前要确认的一件小事

`wechat-main` 这个会话是"已存在"的：它的 `cwd` 在创建时固化为 `~/.dsh/profiles/desktop`，
新配置只对**新建**会话生效。要么在 GUI 里归档/删除它，要么等 `#新会话`，Q1 待定。
