/**
 * Inbound WeChat message handling: allowlist check, pending-interaction
 * resolution, text/quote extraction, media download, and routing into the
 * DSH session. Quoted messages (微信"引用") are unpacked so the agent sees
 * what the user is referencing.
 */
import fs from "node:fs";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";

import type { MessageItem, WeixinMessage } from "./ilink/api/types.js";
import { MessageItemType } from "./ilink/api/types.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { downloadMediaFromItem } from "./inbound-media.js";
import { lookupQuoteMessage, recordQuoteMessage } from "./quote-history.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import type { ClawbotConfig } from "./config.js";
import type { WechatBridge } from "./bridge.js";
import { PendingRegistry } from "./pending.js";
import { loadContextToken, saveContextToken } from "./state.js";
import { logger } from "./ilink/util/logger.js";
import { routeInboundCommand, runCommand, stripEscape, unknownCommandReply, WRITE_COMMANDS } from "./commands.js";
import { captureLedgerDraft, captureReady, captureReceipt, captureUrl, detectCapture } from "./capture.js";
import { looksLikeApprovalWord } from "./approvals.js";
import { cancelDshSession } from "./dsh-sessions.js";
import type { CommandLedger, LedgerDraft } from "./ledger.js";
import type { ModeStore } from "./modes.js";
import type { RelayService } from "./relay.js";
import { isStopWord, type StopConfirms } from "./stop.js";

function isMediaItem(item: MessageItem | undefined): boolean {
  return (
    !!item &&
    (item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.VIDEO ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VOICE)
  );
}

/**
 * Rebuild the message body, unpacking quoted context (微信"引用").
 * Ported from @tencent-weixin/openclaw-weixin (MIT) bodyFromItemList:
 * a quoted message becomes `[引用: <title | quoted text>]\n<current text>`.
 */
function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Quoted media is passed separately (downloaded as media); only the
      // current text goes into the body here.
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // 语音消息：微信服务端自带转文字（voice_item.text），直接使用。
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

/** Raw plain text of an inbound message, WITHOUT quote context (for approval matching). */
function extractPlainText(msg: WeixinMessage): string | null {
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT) {
      const text = item.text_item?.text?.trim();
      if (text) return text;
    }
  }
  return null;
}

/** WeChat's own transcript of a voice message, if the message is one. */
function extractVoiceText(msg: WeixinMessage): string | null {
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.VOICE) {
      const text = item.voice_item?.text?.trim();
      if (text) return text;
    }
  }
  return null;
}

/** True when the message carries any item that is not plain text. */
export function hasNonTextItem(msg: WeixinMessage): boolean {
  return (msg.item_list ?? []).some((item) => item.type !== MessageItemType.TEXT);
}

/**
 * Resolve the quoted (引用) content of an inbound message. The wire only
 * carries the quoted message's id and creation time; the content comes from
 * the local quote-history registry, with a timestamp fallback over the
 * session log for messages that predate the registry (e.g. before restart).
 */
function buildQuotePrefix(msg: WeixinMessage, bridge: WechatBridge): string {
  for (const item of msg.item_list ?? []) {
    const ref = item.ref_msg;
    if (!ref) continue;
    const refMsgId = ref.message_item?.msg_id;
    if (refMsgId !== undefined) {
      const hit = lookupQuoteMessage(String(refMsgId));
      if (hit) {
        if (hit.imagePath) return `[引用: 用户引用了一张图片，已保存到 ${hit.imagePath}]`;
        if (hit.text) return `[引用: ${hit.text}]`;
      }
    }
    // Timestamp fallback: quoted messages older than the registry.
    const byTime = bridge.lookupQuoteByTime(ref.message_item?.create_time_ms);
    if (byTime) {
      if (byTime.imagePath) return `[引用: 用户引用了一张图片，已保存到 ${byTime.imagePath}]`;
      if (byTime.text) return `[引用: ${byTime.text}]`;
    }
    return "[引用: 用户引用了一条之前的消息，但引用内容未能获取]";
  }
  return "";
}

export class InboundRouter {
  private readonly config: ClawbotConfig;
  private readonly account: ResolvedWeixinAccount;
  private readonly bridge: WechatBridge;
  private readonly pending: PendingRegistry;
  private readonly sendText: (to: string, text: string) => Promise<void>;
  private readonly ctx: Context;
  private readonly modes?: ModeStore;
  private readonly relay?: RelayService;
  private readonly ledger?: CommandLedger;
  private readonly stop?: StopConfirms;

  constructor(deps: {
    config: ClawbotConfig;
    account: ResolvedWeixinAccount;
    bridge: WechatBridge;
    pending: PendingRegistry;
    sendText: (to: string, text: string) => Promise<void>;
    /** Root context, for the command layer's session queries. */
    ctx: Context;
    /** Per-peer mode; absent only in compositions that cannot relay. */
    modes?: ModeStore;
    /** Delivers relayed messages and mirrors their answers. */
    relay?: RelayService;
    /** Where every command is filed (D28). */
    ledger?: CommandLedger;
    /** The "回「停」才停" window (D14). */
    stop?: StopConfirms;
  }) {
    this.config = deps.config;
    this.account = deps.account;
    this.bridge = deps.bridge;
    this.pending = deps.pending;
    this.sendText = deps.sendText;
    this.ctx = deps.ctx;
    this.modes = deps.modes;
    this.relay = deps.relay;
    this.ledger = deps.ledger;
    this.stop = deps.stop;
  }

  /** Whether a sender may talk to the agent. */
  isAllowed(sender: string): boolean {
    if (this.config.allowFrom.length > 0) {
      return this.config.allowFrom.includes(sender);
    }
    // No explicit allowlist: only the user who scanned the QR code.
    return this.account.userId === sender;
  }

  /** Handle one inbound message from the monitor. */
  async handle(msg: WeixinMessage): Promise<void> {
    // Debug: record the raw item structure (types + ref fields) to a file so
    // quote handling can be diagnosed without access to the GUI terminal.
    // Rotates at 5MB, keeping 3 old files, to bound disk use and privacy.
    try {
      const rawPath = path.join(resolveStateDir(), "inbound-raw.jsonl");
      try {
        const st = fs.statSync(rawPath);
        if (st.size > 5 * 1024 * 1024) {
          fs.renameSync(rawPath, `${rawPath}.1`);
          for (let i = 2; i >= 1; i--) {
            const older = `${rawPath}.${i + 1}`;
            const newer = `${rawPath}.${i}`;
            if (fs.existsSync(older)) fs.renameSync(older, newer);
          }
          const drop = `${rawPath}.4`;
          if (fs.existsSync(drop)) fs.unlinkSync(drop);
        }
      } catch {
        // fresh file / stat race: proceed
      }
      // >>> local: 只在 debug 级别落盘（上游 PR #4）
      // 这个文件存的是每条入站消息的正文（含引用内容），属于诊断材料而不是
      // 运行时数据：默认部署不该在状态目录里长期积累一份明文聊天记录。
      // 上面的轮转保持无条件执行，旧的调试文件仍然有界。
      if (this.config.logLevel === "debug") {
        fs.appendFileSync(
          rawPath,
          JSON.stringify({
            t: Date.now(),
            seq: msg.seq,
            msgType: msg.message_type,
            msgId: msg.message_id,
            clientId: msg.client_id,
            items: (msg.item_list ?? []).map((i) => ({
              type: i.type,
              text: i.text_item?.text ?? null,
              hasRef: !!i.ref_msg,
              ref: i.ref_msg ?? null,
            })),
          }) + "\n",
        );
      }
      // <<< local
    } catch {
      // ignore logging failures
    }

    const sender = msg.from_user_id?.trim();
    if (!sender) {
      logger.debug("inbound: message without from_user_id ignored");
      return;
    }
    logger.info(`inbound: from=${sender} seq=${msg.seq ?? "?"} msgId=${msg.message_id ?? "?"}`);

    // Remember the context token so replies stay in the same WeChat thread.
    if (msg.context_token) {
      saveContextToken(this.account.accountId, sender, msg.context_token);
    }

    if (!this.isAllowed(sender)) {
      logger.warn(`inbound: sender ${sender} is not allowed; ignored`);
      return;
    }

    // Until it is handed to the bridge (an image may take seconds to download),
    // the bot's reply tools give it a moment to arrive (see coalesce.ts).
    this.bridge.noteIncoming(sender, 1);
    try {
      await this.route(msg, sender);
    } finally {
      this.bridge.noteIncoming(sender, -1);
    }
  }

  /** Everything after the sender is known and allowed. */
  private async route(msg: WeixinMessage, sender: string): Promise<void> {
    const plainText = extractPlainText(msg);
    let body = bodyFromItemList(msg.item_list);
    const quotePrefix = buildQuotePrefix(msg, this.bridge);

    // >>> local: `#停一下` 的二次确认（D14）
    // 接管中停的是别人的回合，所以先问一句。任何别的消息都会关掉这个窗口并照常
    // 走下面的路 —— 确认窗口绝不能吞掉一条真实的消息。
    const stopTarget = this.stop?.pending(sender, Date.now()) ?? null;
    if (stopTarget !== null) {
      this.stop?.clear(sender);
      if (isStopWord(plainText)) {
        const cancelled = cancelDshSession(this.ctx, stopTarget.sessionId);
        this.ledger?.append(
          {
            command: "停一下",
            args: { sessionId: stopTarget.sessionId },
            result: cancelled.ok ? "ok" : "failed",
            summary: cancelled.ok ? `停了《${stopTarget.title}》` : cancelled.message,
          },
          { mode: "relay", peer: sender },
        );
        const text = cancelled.ok
          ? `已停《${stopTarget.title || stopTarget.sessionId.replace(/^session-/u, "").slice(0, 8)}》。接管还在，下一条消息继续进那个会话。`
          : `停不了：${cancelled.message}`;
        await this.sendText(sender, text).catch(() => {});
        return;
      }
    }
    // <<< local

    // >>> local: 命令层（D7–D11）
    // 一整条消息正好是命令时在这里答复。位置必须在 pending 消费之前：
    // 只读命令不能被挂着的审批当成答复吃掉。未识别的 `#…` 也只回帮助，
    // 不下发给 agent —— 打错命令要有确定结果。
    const routed = routeInboundCommand(plainText);
    if (routed.kind === "unknown") {
      await this.sendText(sender, unknownCommandReply(routed.raw)).catch(() => {});
      return;
    }
    if (routed.kind === "command") {
      // Snapshot the mode BEFORE the command runs: `#交还` ends a relay, and the
      // ledger should say the command was typed while still relaying.
      const relaying = this.modes?.lookup(sender).binding != null;
      const record = (draft: LedgerDraft): void => {
        this.ledger?.append(draft, { mode: relaying ? "relay" : "agent", peer: sender });
      };
      const reply = await runCommand(routed, {
        ctx: this.ctx,
        sessionId: this.config.sessionId,
        peer: sender,
        ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
        ...(this.modes === undefined ? {} : { modes: this.modes }),
        capture: (url: string) => this.captureOne(url),
        captureReady: captureReady(this.config),
        captureBaseUrl: this.config.captureBaseUrl,
        // D29: only commands with a side effect get a line in the agent's context.
        note: (text: string) => this.bridge.noteCommand(text),
        record,
        ...(this.stop === undefined ? {} : { stop: this.stop }),
        approve: (decision: "yes" | "no") => this.answerApproval(sender, decision),
        forgetMirror: (sessionId: string) => this.relay?.forget(sessionId),
      }).catch((err: unknown) => `命令执行失败：${String((err as Error).message ?? err)}`);
      if (reply !== "") {
        // D13: a write command still runs while an approval is pending, but it
        // says so — otherwise the receipt looks like the approval was answered.
        const waiting = WRITE_COMMANDS.has(routed.name) && this.pending.hasFor(sender)
          ? "\n\n（还有一条权限请求在等你：#允许 / #拒绝）"
          : "";
        await this.sendText(sender, `${reply}${waiting}`).catch(() => {});
      }
      return;
    }
    // `>` 逃逸：剥掉标记，其余原样交给 agent。
    if (routed.kind === "escape") body = stripEscape(body);
    // <<< local

    // >>> local: 采集快路径（D21–D25）
    // 链接卡片与裸链接不进 agent：抓页面、进收件箱、回执，几秒内结束。
    // 位置在 pending 消费之前 —— 这跟命令层同理，一条链接不该被当成审批答复吃掉。
    // 采集没配置时保持旧行为（链接还是消息），不悄悄吞掉它。
    const target = detectCapture(plainText);
    if (target !== null && captureReady(this.config)) {
      const result = await this.captureOne(target.url);
      // A bare link is filed like `#入库` and is just as undoable — so it goes in
      // the ledger too (D28/D30). Without this line "撤销刚才那个链接" would find
      // nothing, which is the most common case of all.
      this.ledger?.append(captureLedgerDraft(result, target.url, "采集"), {
        mode: this.modes?.lookup(sender).binding === null ? "agent" : "relay",
        peer: sender,
      });
      await this.sendText(sender, captureReceipt(result)).catch(() => {});
      return;
    }
    // <<< local

    // A pending approval/question for this sender wins over a new turn.
    // A voice reply answers a question too (WeChat transcribes voice itself).
    //
    // Approvals and questions are not the same rule (D12): only `#允许` / `#拒绝`
    // answer a permission request. Anything else is a new message — the request
    // keeps waiting instead of being consumed by whatever the user happened to
    // be thinking about. A bare "同意" gets a nudge rather than being forwarded:
    // it is almost certainly an answer that forgot the `#`.
    const pending = this.pending.popFor(sender);
    if (pending) {
      const answer = plainText ?? extractVoiceText(msg);
      if (pending.tag === "approval") {
        this.pending.push(pending);
        if (answer !== null && looksLikeApprovalWord(answer)) {
          await this.sendText(sender, "权限请求还在等 —— 回 #允许 或 #拒绝。").catch(() => {});
          return;
        }
      } else if (answer !== null) {
        pending.resolve(answer);
        return;
      } else {
        // A photo or a file answers nothing: withdraw the question rather than
        // using the message up and throwing it away.
        pending.resolve(null);
      }
    }

    // Download inbound images/files (decrypt + persist), so the agent can
    // inspect them (e.g. with the dsh-vision tools). Also downloads media
    // the user QUOTED (引用) inside a text reply.
    let mediaNote = "";
    let firstImagePath: string | undefined;
    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.IMAGE || item.type === MessageItemType.FILE) {
        const media = await downloadMediaFromItem(item, {
          cdnBaseUrl: this.account.cdnBaseUrl,
          label: "inbound",
        });
        if (media.imagePath) {
          firstImagePath ??= media.imagePath;
          mediaNote +=
            // 图片本身会被 bridge 附到这条消息上(路由支持图片输入时)。路径仍然
            // 保留:他可能让你把同一张图发回去,而且路由万一不支持图片时,视觉
            // 工具还得靠这个路径。措辞对两种情况都成立,不需要按模型分叉。
            `\n（用户发送了一张图片，已保存到 ${media.imagePath}。）`;
        }
        if (media.filePath) {
          mediaNote += `\n（用户发送了一个文件，已保存到 ${media.filePath}。请查看内容并回应。）`;
        }
      }
    }

    // Quoted media: user quoted an image/file message and added text.
    const refMediaItem = msg.item_list?.find(
      (i) =>
        i.type === MessageItemType.TEXT &&
        i.ref_msg?.message_item &&
        isMediaItem(i.ref_msg.message_item),
    )?.ref_msg?.message_item;
    if (refMediaItem) {
      const media = await downloadMediaFromItem(refMediaItem, {
        cdnBaseUrl: this.account.cdnBaseUrl,
        label: "ref",
      });
      if (media.imagePath) {
        mediaNote +=
          `\n（用户引用的图片已保存到 ${media.imagePath}。）`;
      }
      if (media.filePath) {
        mediaNote += `\n（用户引用的文件已保存到 ${media.filePath}。请查看内容并回应。）`;
      }
    }

    if (!body && !mediaNote) {
      if (hasNonTextItem(msg)) {
        await this.sendText(
          sender,
          "[DSH] 收到视频消息，暂不支持处理。",
        ).catch(() => {});
      }
      return;
    }

    // Record this inbound message so future quotes of it can be resolved.
    if (msg.message_id !== undefined) {
      recordQuoteMessage({
        msgId: String(msg.message_id),
        text: plainText ?? (firstImagePath ? "（图片）" : ""),
        imagePath: firstImagePath,
        time: Date.now(),
      });
    }

    // Route into the shared WeChat session (fire-and-forget: the reply is
    // streamed back by the bridge when the turn completes).
    const content = [quotePrefix, body, mediaNote].filter(Boolean).join("\n");

    // >>> local: relay（D2/D15/D18–D20）
    // 接管中：这条消息进被接管的真实会话，回复由 relay 在 turn/end 时镜像回来。
    // 位置在媒体与引用处理之后 —— 图片路径与引用前缀对两种模式同样有用。
    const lookup = this.modes?.lookup(sender) ?? { binding: null, expired: null };
    if (lookup.binding !== null) {
      this.modes?.touch(sender);
      const sent = await this.relay?.relay(sender, lookup.binding, content);
      if (sent !== undefined && !sent.ok) {
        // 投递失败（会话没了 / 没有 sessionController）：说清楚，别让消息静默消失。
        await this.sendText(sender, `接管的目标会话投递失败：${sent.message}\n\n「#交还」回到专属 agent。`).catch(() => {});
      }
      return;
    }
    if (lookup.expired !== null) {
      const title = lookup.expired.title.trim() === "" ? lookup.expired.sessionId.slice(0, 8) : lookup.expired.title;
      await this.sendText(sender, `接管《${title}》因为久没消息已自动交还，这条交给专属 agent。`).catch(() => {});
    }
    // <<< local

    // firstImagePath 让 bridge 能把图片本身附上,而不只是给一个路径。
    await this.bridge.enqueueMessage(sender, content, firstImagePath);
  }

  /** Read one URL and file it (the capture fast path, shared with `#入库`). */
  private async captureOne(url: string) {
    return captureUrl(url, {
      enabled: this.config.captureEnabled,
      baseUrl: this.config.captureBaseUrl,
      token: this.config.captureToken,
    });
  }

  /**
   * Answer a pending approval from `#允许` / `#拒绝` (D12).
   *
   * The approval path prints its own receipt ("已批准。/已拒绝。"), so the
   * command itself says nothing when it lands. A question is left where it was:
   * "允许" is not an answer to "which file did you mean?".
   */
  private answerApproval(sender: string, decision: "yes" | "no"): "answered" | "question" | "none" {
    const pending = this.pending.popFor(sender);
    if (pending === undefined) return "none";
    if (pending.tag !== "approval") {
      this.pending.push(pending);
      return "question";
    }
    pending.resolve(decision === "yes" ? "同意" : "拒绝");
    return "answered";
  }

  /** Context token for an outbound message to a sender ("" when unknown). */
  contextTokenFor(sender: string): string {
    return loadContextToken(this.account.accountId, sender);
  }
}
