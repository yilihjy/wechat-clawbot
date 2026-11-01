# 微信桥：设计决策记录

> 本文只记录**已定**的决定与实际测到的事实；未定项集中在 §4，先讨论、再落成代码。
> 编号稳定，后续讨论请引用 `D7` / `Q3` / `F2` 这样的编号。
>
> 仓库分工：
> - **`wechat-clawbot`（本仓库）**：微信 ⇄ DSH 的桥，本方案的宿主。
> - **`dsh-auto-review`**：`@deepseek-ai/dsh-experimental-auto-review` 的分叉，加回复通道白名单。
> - **`global-seo`**：工作台（采集收件箱 / 知识库），只提供 HTTP 接口，桥调用它。

最后更新：2026-11-01

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

| 命令 | 作用 |
|---|---|
| `#任务状态` | 概览：在跑 + 最近完成 |
| `#任务状态 N` | 展开第 N 条 |
| `#会话列表` | 可接管的会话（编号 + 短 id） |
| `#接管 N` | 进入 relay，绑定该会话 |
| `#交还` | 回专属 agent |
| `#当前模式` | 报告模式与绑定 |
| `#新会话` | 新建并接管 |
| `#入库 <url>` | 强制投递到工作台收件箱 |
| `#停一下` | 打断当前回合 |
| `#帮助` | 清单 |
| `#允许` / `#拒绝` | 答复待批审批 |
| `#模型` | 列模型 / 切换 |

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

### D41 自动审查：三层门禁

由 `dsh-auto-review`（官方包的本地分叉）审，**不注册任何 preset**：

1. **会话**：`reviewSessions`（本部署 `[wechat-main]`）——其他会话零影响；
2. **档位开关**：`reviewPreset: wechat-auto` —— 权限选择器选中它 = 审查开，换成任何别的档位 = 关；
3. **provider 闸门**：`reviewProviders: [deepseek-official]` —— 不在名单里的 provider 直接跳过审查
   （`opencode-go` 的网关要求 `x-opencode-session`，评审请求必 400；fail-closed 会把整个工具层打死）。

`replyTools`（`send_wechat_text` / `send_wechat_file`）跳过审查。卸载时不改任何会话的权限旋钮。

---

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
| 命令层 / 采集 / 账本 / 时间线 | **均未实现**（决策已定，见 §2–§4） |

**上游 PR**

- `Alphainfix/wechat-clawbot#2` —— `fix(model): follow a model picked in the web UI when nothing is pinned`
  （19 行，只含这一个 hunk；分支 `pr/model-follow-ui`）。
  若被接受，`main` 上那 19 行本地改动会在 rebase 后自然消失，fork 的源码 diff 归零。

**待提的候选（尚未动手）**

1. `claudePeer` 缺开关（上游无条件注册 3 个工具，而 `codexPeer` / `macCalendar` / `mcpBridge` 都有开关）；
2. 入站原文日志无开关（`src/inbound.ts` 把每条消息正文写 `inbound-raw.jsonl`）；
3. 游标先落盘再处理（`src/monitor.ts:101`，崩溃会跳过整批；且写盘无 try/catch）；
4. `approvalTimeoutMs` 默认 0（永不超时）。

## 6. 未定（讨论中）

| 编号 | 议题 |
|---|---|
| Q1 | 把 `cwd` 改到 `~/workspace` 的具体时机（改配置 + 重启一次） |
| Q2 | `#任务状态` 的输出格式：编号怎么排、字段、长度 |
| Q3 | `#模型` 的模型清单来源（只列 deepseek-official 还是全部） |
| Q4 | agent 提示词：它该怎么描述"能看别的会话""何时该接管"，避免自己下盘挖 / 反问 |
| Q5 | 非回复工具被拦的体感：还没造过"该被拦"的反例，需不需要验证审查真的会拒 |
| Q6 | 时间线页面的版式：要不要按会话分组 / 搜索 |
| Q7 | relay 期间收到链接，账记在 agent 还是当前绑定会话 |
| Q8 | 账本损坏容忍（半行 / 并发写） |
| Q9 | DSH 升级后 fork 怎么跟（tag 对齐 + diff 脚本） |

## 7. 已知技术债

1. `cordis.patch.yml` 可能被 GUI 重写，`wechat-auto` 那行会丢（有 `# >>> local` 标记与备份兜底）。
2. `wechat-auto` 与官方 `auto` 的旋钮完全相同，靠"存档身份"区分；手动拧 sandbox/approval 旋钮会退化到"表里第一个匹配项"。
3. 上游两个 bug 未修：游标先落盘后处理（崩溃丢批）、入站原文无条件写盘。
4. `wechat-main` 的归档/删除只能走 GUI。
