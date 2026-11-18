/**
 * Approval relay: forwards `approval/request` questions for WeChat-owned
 * agents into WeChat and maps the user's reply back to an approval outcome.
 *
 * Follows the ACP-bridge pattern: the listener only answers requests whose
 * agent belongs to the WeChat session and delegates everything else with
 * `next()`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";

import type { ClawbotConfig } from "./config.js";
import type { WechatBridge } from "./bridge.js";
import type { CommandLedger } from "./ledger.js";
import { PendingRegistry } from "./pending.js";
import { isFresh, type ModeStore, type RelayBinding } from "./modes.js";
import { classifyReadOnly, ruleLabel, type ReadOnlyVerdict } from "./read-only.js";
import { logger } from "./ilink/util/logger.js";

/** Name cordis keeps on the stored wrapper; it is how the mount finds its own entry. */
const APPROVAL_HANDLER_NAME = "wechatClawbotApprovalRelay";

// NOTE: no \b word boundaries here — JS \b does not match CJK text, so
// "同意" would never match a pattern like /^同意\b/.
const YES_RE = /^(同意|允许|批准|确认|可以|好的?|是|yes|y|ok|allow|approve)$/i;
const NO_RE = /^(拒绝|不同意|不允许|不行|不要|否|no|n|reject|deny)$/i;

function parseApprovalReply(text: string): "yes" | "no" {
  // Trim and strip trailing punctuation before matching.
  const trimmed = text.trim().replace(/[\s，。！!？?,.、；;：:]+$/g, "");
  if (YES_RE.test(trimmed)) return "yes";
  if (NO_RE.test(trimmed)) return "no";
  // Anything else is treated as a rejection (fail closed).
  return "no";
}

/**
 * Does this message look like someone answering an approval, only without the
 * `#`? (D12)
 *
 * Used for a nudge, never for an answer: a bare "同意" that reached the agent
 * would be a message the user did not mean to send, while dropping it silently
 * would leave them staring at a question they think they answered.
 */
export function looksLikeApprovalWord(text: string): boolean {
  const trimmed = text.trim().replace(/[\s，。！!？?,.、；;：:]+$/g, "");
  return YES_RE.test(trimmed) || NO_RE.test(trimmed);
}

/**
 * Where one permission request should be asked.
 *
 * - `wechat` — the dedicated WeChat session, answered on the phone.
 * - `relay` — a real conversation that is currently being driven from the phone.
 * - `no-sender` — ours, but there is nobody to ask (the WeChat session has no
 *   active sender). Failing closed is deliberate: a phone-owned session must not
 *   pop a dialog on the desktop.
 * - `not-ours` — delegate to the next listener (the desktop's own UI).
 *
 * A relayed conversation only intercepts the prompt while the phone is actively
 * using it: after a few minutes of silence the owner is presumably back at the
 * desktop, and taking the prompt away would strand the turn on the phone.
 */
export type ApprovalRoute =
  | { readonly kind: "wechat"; readonly sender: string }
  | { readonly kind: "relay"; readonly sender: string; readonly title: string }
  | { readonly kind: "no-sender" }
  | { readonly kind: "not-ours" };

/** Decide who answers one approval request. Pure: time and state are passed in. */
export function approvalRoute(input: {
  /** Is the requesting agent the WeChat session? */
  readonly isWechat: boolean;
  /** The WeChat recipient of the current activity, if any. */
  readonly activeSender?: string | undefined;
  /** The peer relaying into this conversation, when there is one. */
  readonly relay?: { readonly peer: string; readonly binding: RelayBinding } | null;
  readonly now: number;
  readonly freshMs?: number;
}): ApprovalRoute {
  if (input.isWechat) {
    return input.activeSender === undefined
      ? { kind: "no-sender" }
      : { kind: "wechat", sender: input.activeSender };
  }
  const relay = input.relay;
  if (relay === null || relay === undefined) return { kind: "not-ours" };
  const fresh = input.freshMs === undefined
    ? isFresh(relay.binding, input.now)
    : isFresh(relay.binding, input.now, input.freshMs);
  if (!fresh) return { kind: "not-ours" };
  return { kind: "relay", sender: relay.peer, title: relay.binding.title };
}

export class ApprovalRelay {
  private readonly config: ClawbotConfig;
  private readonly getBridge: () => WechatBridge | null;
  private readonly pending: PendingRegistry;
  private readonly sendText: (to: string, text: string) => Promise<void>;
  private readonly modes: ModeStore | undefined;
  private readonly ledger: CommandLedger | undefined;
  private readonly wasStoppedRecently: ((sessionId: string) => boolean) | undefined;
  private readonly reminderMs: () => number;
  private readonly getOwnerId: (() => string | undefined) | undefined;
  /** Where an approval's tool-call arguments come from (D55). */
  private readonly lookupCommand: ((sessionId: string, callId: string) => string | undefined) | undefined;
  /** The listener we registered, kept so the mount can be verified and re-attached. */
  private handler: ((req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>) | undefined;
  /** The context the listener belongs to; mount introspection reads its event hooks. */
  private registeredCtx: Context | undefined;
  /** Disposer of the current listener registration, when the host returned one. */
  private disposeListener: (() => boolean) | undefined;
  /** Whether the last attach() call went through (the host's own table is read live). */
  private mounted = false;
  /** When the last `approval/request` reached this relay (2026-11-08 diagnosis). */
  private lastRequestAt: number | undefined;
  /** How many approvals this relay has seen since the plugin started. */
  private requestsSeen = 0;
  /** How many approvals were answered by the read-only rule instead of a card (D55). */
  private autoAllowed = 0;
  /** The last auto-allowed request, for `#审批策略`. */
  private lastAutoAllow: { summary: string; at: number } | undefined;
  /** The last request the read-only rule declined, and why (D55 diagnostics). */
  private lastDeclined: { tool: string; why: string; at: number } | undefined;

  constructor(deps: {
    config: ClawbotConfig;
    /** Returns the live bridge, or null while the monitor is not running. */
    getBridge: () => WechatBridge | null;
    pending: PendingRegistry;
    sendText: (to: string, text: string) => Promise<void>;
    /** Where the relayed conversations are (absent only in compositions without relay). */
    modes?: ModeStore;
    /** The command ledger: every approval is recorded there (D49). */
    ledger?: CommandLedger;
    /** Whether that session was stopped by `#停一下` a moment ago (suppresses the "handled on the desktop" line). */
    wasStoppedRecently?: (sessionId: string) => boolean;
    /** Live read of the reminder delay, so a settings change needs no restart. */
    reminderMs?: () => number;
    /**
     * The bound owner's WeChat id (`account.userId`).
     *
     * The fallback recipient when no turn is active: an approval that belongs to
     * the phone must reach the phone even if we cannot tell who is typing right
     * now — the owner is the only human this deployment talks to.
     */
    getOwnerId?: () => string | undefined;
    /**
     * The raw `command` of the tool call an approval is about (D55).
     *
     * The approval event carries a `callId`, not the arguments; the read-only
     * rule needs the command, so the plugin keeps the last few `tool/call`
     * events and this is how they are looked up.
     */
    lookupCommand?: (sessionId: string, callId: string) => string | undefined;
  }) {
    this.config = deps.config;
    this.getBridge = deps.getBridge;
    this.pending = deps.pending;
    this.sendText = deps.sendText;
    this.modes = deps.modes;
    this.ledger = deps.ledger;
    this.wasStoppedRecently = deps.wasStoppedRecently;
    this.reminderMs = deps.reminderMs ?? (() => 0);
    this.getOwnerId = deps.getOwnerId;
    this.lookupCommand = deps.lookupCommand;
  }

  /**
   * Mount the relay and prove it landed.
   *
   * The 2026-11-08 incident: a turn waited on a desktop approval while WeChat
   * heard nothing, and the ledger had no line at all — the listener never ran.
   * So mounting is now a thing the plugin checks and writes down, not a thing
   * it assumes.
   *
   * @param ctx - root context the listener belongs to.
   */
  start(ctx: Context): void {
    this.registeredCtx = ctx;
    this.handler ??= this.makeHandler();
    this.attach();
    const status = this.verifyMount();
    if (status.mounted) {
      const where = status.position === null ? "" : `，第 ${status.position + 1}/${status.total} 位`;
      logger.info(`approval: listener mounted (prepend${where})`);
      this.record("ok", `审批监听已挂载（prepend${where}）`, { stage: "mount", ...status });
      return;
    }
    logger.error("approval: listener is not mounted; approvals would stay on the desktop");
    this.record("failed", "审批监听没挂上（重挂也没成功），审批只会留在桌面", { stage: "mount", ...status });
    const to = this.getOwnerId?.() ?? this.getBridge()?.activeSender;
    if (to !== undefined) {
      void this.sendText(
        to,
        "【DSH 审批】审批监听没挂上，微信里收不到审批卡片。请重启 DSH，或在插件页把 wechat-clawbot 停用再启用。",
      ).catch(() => {});
    }
  }

  /**
   * Register the `approval/request` waterfall listener.
   *
   * Prepended on purpose. The host forwards the same waterfall to the desktop
   * UI, and that listener is registered by an earlier bundle: answering there
   * ends the chain before this relay ever sees the request. A phone-owned
   * session must ask the phone first — this is the plugin's own D53 rule — so
   * the relay sits in front and delegates with `next()` for everything it does
   * not own.
   *
   * @param ctx - root context the listener belongs to.
   */
  register(ctx: Context): void {
    this.registeredCtx = ctx;
    this.handler ??= this.makeHandler();
    this.attach();
  }

  /**
   * Build the listener with a name cordis keeps.
   *
   * cordis stores a wrapper, not the function handed to `on()`, so `===` can
   * never find this relay's own entry — that identity check reported "not
   * mounted" on a working relay (ledger 2026-11-09 → 2026-11-10, and a fresh
   * 0.2.2-rc.2 boot). The wrapper does keep the callback's `name` on both 4.0.4
   * and 4.1.0, so the name is what makes the entry findable.
   */
  private makeHandler(): (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
    const handler = (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> =>
      this.answer(req, next);
    Object.defineProperty(handler, "name", { value: APPROVAL_HANDLER_NAME });
    return handler;
  }

  /**
   * Add the listener to the context, replacing a stale registration.
   *
   * `on()` throwing is not the only way a mount fails: a registration can land
   * on a table that is disposed a moment later, and the 2026-11-08 miss was
   * exactly a listener nobody could find. So the table is read back right after
   * registering, and an unreadable table stays *unproven* rather than failed.
   */
  private attach(): void {
    const ctx = this.registeredCtx;
    const handler = this.handler;
    if (ctx === undefined || handler === undefined) return;
    try {
      const dispose = ctx.on("approval/request", handler, { prepend: true });
      this.disposeListener = typeof dispose === "function" ? dispose as () => boolean : undefined;
      this.mounted = typeof dispose === "function";
      const mount = this.readMount();
      if (mount.introspected && mount.position === null) {
        logger.error(`approval: the listener did not land in the chain (${mount.total} hooks, none ours)`);
      }
    } catch (err) {
      this.mounted = false;
      logger.error(`approval: could not register the listener: ${String(err)}`);
    }
  }

  /**
   * Find this relay's own entry in the host's `approval/request` hook table.
   *
   * cordis stores a wrapper around the callback, so `hook.callback === handler`
   * is false on 4.0.4 and 4.1.0 alike; the wrapper keeps the callback's `name`,
   * which is why {@link makeHandler} names it. `introspected` is false when the
   * host no longer exposes the table at all.
   */
  private readMount(): { introspected: boolean; position: number | null; total: number } {
    const hooks = (this.registeredCtx as unknown as {
      events?: { _hooks?: Record<string, Array<{ callback?: { name?: unknown } }>> };
    } | undefined)?.events?._hooks?.["approval/request"];
    if (!Array.isArray(hooks)) return { introspected: false, position: null, total: 0 };
    const index = hooks.findIndex((hook) =>
      hook.callback === this.handler || hook.callback?.name === APPROVAL_HANDLER_NAME);
    return { introspected: true, position: index >= 0 ? index : null, total: hooks.length };
  }

  /** Drop the current registration, if the host gave us a disposer. */
  private detach(): void {
    try {
      this.disposeListener?.();
    } catch {
      // A disposer that throws has nothing left to remove.
    }
    this.disposeListener = undefined;
    this.mounted = false;
  }

  /**
   * Read where this relay's listener sits in the host's waterfall.
   *
   * `_hooks` is cordis's private registry, read live through {@link readMount}:
   * the position is this relay's real index in the chain, not a guess. When a
   * host version has no such table, the attach bookkeeping is all that can be
   * reported and `introspected` says so.
   */
  mountStatus(): { mounted: boolean; introspected: boolean; position: number | null; total: number } {
    const mount = this.readMount();
    if (!mount.introspected) return { mounted: this.mounted, introspected: false, position: null, total: 0 };
    return { mounted: mount.position !== null, ...mount };
  }

  /** Re-attach once when the listener is gone, then report the state. */
  verifyMount(): { mounted: boolean; introspected: boolean; position: number | null; total: number } {
    let status = this.mountStatus();
    if (status.mounted) return status;
    this.detach();
    this.attach();
    status = this.mountStatus();
    return status;
  }

  private async answer(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    this.lastRequestAt = Date.now();
    this.requestsSeen += 1;
    // Routing must not depend on the bridge object (D53). `#审批自检` and the
    // 2026-11-04 incident both come down to the same thing: the bridge is a
    // *mount*, and between mounts `getBridge()` is null while a tool call is
    // still running and still needs an answer. Judging "is this the WeChat
    // session" from the configured id, and falling back to the bound owner as
    // the recipient, is what keeps those approvals on the phone.
    const bridge = this.getBridge();
    const agentId = String(req.agent.id);
    const isWechat = agentId === this.config.sessionId;
    const owner = this.getOwnerId?.();
    const activeSender = bridge?.activeSender ?? owner;
    // >>> local: relay 的审批也走微信（D16）
    const route = approvalRoute({
      isWechat,
      ...(activeSender === undefined ? {} : { activeSender }),
      relay: isWechat ? null : this.modes?.peerFor(agentId) ?? null,
      now: Date.now(),
    });
    const diag = {
      agent: agentId.slice(-8),
      bridgeMounted: bridge !== null,
      owner: owner === undefined ? null : "bound",
    };
    if (route.kind === "not-ours") {
      // Not ours is a real answer, not a reason to stay quiet: the owner sees a
      // card on the desktop and needs to know why it never reached the phone.
      const relay = this.modes?.peerFor(agentId) ?? null;
      this.record("noop", `没接：审批来自 ${diag.agent}，${relay === null ? "不是微信会话，也没在接管中" : "接管的窗口已过期"} → 留给桌面`, {
        ...diag,
        stage: "not-ours",
        tool: req.toolName,
        relayBinding: relay !== null,
      });
      logger.info(`approval: not ours (agent=${agentId}); left to the desktop UI`);
      return next();
    }
    if (route.kind === "no-sender") {
      // No active sender AND no bound account: there is nobody on WeChat to ask.
      // Record why, then hand the request on — since 2026-11-08 this listener is
      // prepended, so swallowing it here would deny the tool without asking
      // anyone anywhere; the desktop can still show its card.
      this.record("failed", `没接：${diag.agent} 的审批找不到收件人（没有 activeSender，也没有绑定账号）→ 交给桌面`, {
        ...diag,
        stage: "no-sender",
        tool: req.toolName,
      });
      logger.warn(`approval: no recipient for agent ${agentId}; leaving it to the next answerer`);
      return next();
    }
    const sender = route.sender;
    const routeKind = route.kind === "relay" ? "relay" : "wechat";
    const who = route.kind === "relay" ? `《${route.title.trim() || "接管中的会话"}》` : "微信会话";
    // D55: read-only production DB / docker reads are allowed by default. The
    // rule is proved from the command text (see src/read-only.ts), never from
    // "it looks harmless"; anything it cannot prove still becomes a card.
    const auto = this.autoAllow(req, routeKind, sender, diag);
    if (auto !== null) return auto;

    const heading = route.kind === "relay"
      ? `【DSH 权限请求 · ${route.title.trim() === "" ? "接管中的会话" : `《${route.title}》`}】`
      : "【DSH 权限请求】";

    const question =
      `${heading}\n` +
      `工具: ${req.toolName}\n` +
      `原因: ${req.reason ?? "(未提供)"}\n` +
      `请回复：#允许 / #拒绝`;
    // <<< local

    const sendFailure = await this.sendCard(sender, question);
    if (sendFailure !== null) {
      // 2026-11-08: a card that never left used to fail closed in silence — the
      // phone had no idea a turn was waiting. Retry once (inside sendCard), put
      // the reason in the ledger, try one short line on WeChat, and let the next
      // answerer (the desktop) ask instead of swallowing the request.
      logger.error(`approval: failed to send question to ${sender}: ${sendFailure}`);
      this.record("failed", `没能把审批发到微信（重试一次也没成功）：${sendFailure}`, {
        ...diag,
        tool: req.toolName,
        route: routeKind,
        stage: "send-failed",
      });
      void this.sendText(
        sender,
        `有审批请求没发到手机（${sendFailure.slice(0, 40)}），这一轮交给电脑上处理。`,
      ).catch(() => {});
      return next();
    }
    // Answering a prompt keeps the relay window open: the owner is on the phone.
    if (route.kind === "relay") this.modes?.touch(sender);
    // D49: the card is one text message in a chat stream; record that it went
    // out, so "did I get a card?" stops being a question nobody can answer.
    this.record("ok", `发出审批（${who}）：${req.toolName}${diag.bridgeMounted ? "" : "（监听未挂载，按会话兜底发出）"}`, {
      ...diag,
      tool: req.toolName,
      route: routeKind,
      stage: "sent",
    });
    // The send can take seconds. If the turn was stopped meanwhile, the abort
    // already fired and a listener added now would never run — the entry would
    // then sit in the queue and swallow the owner's next message.
    if (req.signal?.aborted) return "cancelled";

    const askedAt = Date.now();
    return new Promise<ApprovalOutcome>((resolveOutcome) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reminder: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (reminder !== undefined) clearTimeout(reminder);
        resolveOutcome(outcome);
      };

      const answer: { tag: string; sender: string; resolve: (reply: string | null) => void } = {
        tag: "approval",
        sender,
        resolve: (reply) => {
          // Already withdrawn: no stray 已批准/已拒绝 for a request that is gone.
          if (settled) return;
          if (reply === null) {
            settle("cancelled");
            return;
          }
          const decision = parseApprovalReply(reply);
          void this.sendText(sender, decision === "yes" ? "已批准。" : "已拒绝。").catch(() => {});
          this.record("ok", `已在微信${decision === "yes" ? "批准" : "拒绝"}：${req.toolName}`, {
            tool: req.toolName,
            route: routeKind,
            stage: "answered",
            decision,
            waitedMs: Date.now() - askedAt,
          });
          settle(decision === "yes" ? "allowed-once" : "rejected");
        },
      };
      this.pending.push(answer);

      // Withdraw the question when the requesting turn is aborted or it times
      // out. Leaving the entry queued would make the sender's next WeChat
      // message answer a request nobody is waiting on — and eat that message.
      //
      // The two reasons are not the same for the user: an abort means the turn
      // was stopped (saying anything would be noise), while a timeout means the
      // bot waited for an answer that never came — silence there looks like the
      // bot hung, so D44 gives it a line.
      const withdraw = (reason: "aborted" | "timeout"): void => {
        if (settled) return;
        this.pending.remove(answer);
        if (reason === "timeout") {
          void this.sendText(sender, "审批超时，这一轮已停。").catch(() => {});
          this.record("noop", `没人答，超时作废：${req.toolName}`, {
            tool: req.toolName,
            route: routeKind,
            stage: "timeout",
            waitedMs: Date.now() - askedAt,
          });
        } else {
          // The turn was aborted. Two very different things land here: the owner
          // stopped it with `#停一下` (already answered on the phone — say
          // nothing), or it was handled on the desktop (the phone otherwise
          // never learns that the waiting is over). D49 records which, and only
          // the desktop case gets a line.
          const stopped = this.wasStoppedRecently?.(String(req.agent.id)) === true;
          this.record("noop", stopped ? `这一轮被 #停一下 停了：${req.toolName}` : `在电脑上处理掉了：${req.toolName}`, {
            tool: req.toolName,
            route: routeKind,
            stage: stopped ? "stopped" : "elsewhere",
            waitedMs: Date.now() - askedAt,
          });
          if (!stopped) {
            void this.sendText(sender, "这条审批已经在电脑上处理了。").catch(() => {});
          }
        }
        settle("cancelled");
      };
      req.signal?.addEventListener("abort", () => withdraw("aborted"), { once: true });

      // D49: one nudge. A card scrolled past is indistinguishable from a card
      // never sent — and the turn waits up to `approvalTimeoutMs` either way.
      const reminderMs = this.reminderMs();
      if (reminderMs > 0) {
        reminder = setTimeout(() => {
          if (settled) return;
          void this.sendText(sender, `还在等：#允许 / #拒绝（${req.toolName}）`).catch(() => {});
          this.record("noop", `补了一次提醒：${req.toolName}`, {
            tool: req.toolName,
            route: routeKind,
            stage: "reminded",
            waitedMs: Date.now() - askedAt,
          });
        }, reminderMs);
        reminder.unref?.();
      }

      const timeoutMs = this.config.approvalTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(() => withdraw("timeout"), timeoutMs);
        // Do not hold the process open for a question nobody will answer.
        timer.unref?.();
      }
    });
  }

  /**
   * Answer a read-only production request without the phone (D55).
   *
   * The ledger says most cards were the same thing: `docker exec
   * workbench-workbench-1 node -e "…DatabaseSync('/data/workbench.db',
   * { readOnly: true })…"` and `docker ps / logs / inspect`. Answering those by
   * hand is friction, not judgement — but "answer by itself" must mean
   * *provably* read-only, so this only fires when {@link classifyReadOnly} can
   * prove every segment of the command, and fails back to the card otherwise.
   *
   * Every grant is one-shot, written to the ledger with the command, and said
   * out loud on WeChat: silent automation would trade friction for blindness.
   *
   * @param req - the approval request.
   * @param routeKind - where it came from (both are the phone).
   * @param sender - the WeChat recipient.
   * @param diag - the routing diagnostics already collected.
   * @returns the outcome to use, or null to ask the phone as before.
   */
  private autoAllow(
    req: ApprovalRequest,
    routeKind: "wechat" | "relay",
    sender: string,
    diag: Record<string, unknown>,
  ): "allowed-once" | "cancelled" | null {
    if (this.config.autoAllowReadOnly === false) return null;
    if (req.toolName !== "bash") return null;
    const callId = req.callId;
    if (callId === undefined) return null;
    const command = this.lookupCommand?.(String(req.agent.id), String(callId));
    if (command === undefined) {
      // The arguments are not known, so nothing is proved. This is the honest
      // answer, and it is why the tool-call index exists at all.
      this.lastDeclined = { tool: req.toolName, why: "拿不到这条 tool/call 的参数", at: Date.now() };
      return null;
    }
    const verdict: ReadOnlyVerdict = classifyReadOnly(command, {
      containers: this.config.prodContainers ?? [],
      volumes: this.config.prodVolumes ?? [],
    });
    if (!verdict.allow || verdict.rule === undefined) {
      this.lastDeclined = { tool: req.toolName, why: verdict.why, at: Date.now() };
      return null;
    }
    this.autoAllowed += 1;
    this.lastAutoAllow = { summary: verdict.summary ?? verdict.rule, at: Date.now() };
    const label = ruleLabel(verdict.rule);
    const compact = command.replace(/\s+/g, " ").trim().slice(0, 300);
    const via = req.reason?.startsWith("Auto review denied")
      ? "auto-review"
      : /^escalate sandbox/i.test(req.reason ?? "")
        ? "escalation"
        : "direct";
    this.record("ok", `自动放行（${label}）：${verdict.summary ?? ""}`, {
      ...diag,
      tool: req.toolName,
      route: routeKind,
      stage: "auto-allowed",
      rule: verdict.rule,
      via,
      command: compact,
      ...(verdict.targets === undefined ? {} : { targets: verdict.targets.join(",") }),
    });
    logger.info(`approval: auto-allowed (${verdict.rule}) ${compact.slice(0, 120)}`);
    if (req.signal?.aborted) return "cancelled";
    if (this.config.autoAllowNotice !== false) {
      void this.sendText(sender, `已自动允许（${label}）：${verdict.summary ?? ""}`).catch(() => {});
    }
    return "allowed-once";
  }

  /**
   * `#审批策略` — what the read-only rule would do right now (D55).
   *
   * The auto-allow is only trustworthy if the owner can see its boundaries
   * without reading the source, so this prints the allowlist, what has been
   * granted this run, and — more useful than either — the last request the rule
   * declined and why.
   */
  policyText(): string {
    const on = this.config.autoAllowReadOnly !== false;
    const containers = this.config.prodContainers ?? [];
    const volumes = this.config.prodVolumes ?? [];
    const lines = [
      "【审批策略】",
      `只读自动放行：${on ? "开" : "关"}`,
      `生产容器：${containers.length === 0 ? "（空）" : containers.join("、")}`,
      `生产卷：${volumes.length === 0 ? "（空）" : volumes.join("、")}`,
      `本次已放行：${this.autoAllowed} 次`,
    ];
    if (this.lastAutoAllow !== undefined) {
      lines.push(`最近一次放行：${this.lastAutoAllow.summary}`);
    }
    if (this.lastDeclined !== undefined) {
      lines.push(`最近一次没放行：${this.lastDeclined.tool} — ${this.lastDeclined.why}`);
    }
    lines.push("", "放行范围：docker ps/logs/inspect 一类只读子命令；白名单容器里的 node 只读贴库、只读子命令；白名单卷的 docker run --rm 且 :ro。其余照旧发卡片。");
    return lines.join("\n");
  }

  /**
   * Send one approval message, retrying once.
   *
   * WeChat refusals are usually transient (rate limit, a hiccup on the CDN), so
   * one retry turns most of them into a delivered card. The caller records the
   * final failure, because a card nobody saw must not look like one that was
   * answered.
   *
   * @param sender - WeChat recipient.
   * @param text - the card body.
   * @returns null when it went out, otherwise the failure text.
   */
  private async sendCard(sender: string, text: string): Promise<string | null> {
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.sendText(sender, text);
        return null;
      } catch (err) {
        last = err;
        if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    return String((last as { message?: unknown } | undefined)?.message ?? last).slice(0, 120);
  }

  /**
   * `#审批自检` — prove this chain end to end, on the spot (D53).
   *
   * Answers the three questions a silent miss raises: is the listener mounted,
   * who would receive the card, and can the card actually leave. It sends a real
   * message to the same recipient the next approval would use, so a green result
   * means the phone saw a card — not that a code path "should" work.
   */
  async selfCheck(): Promise<string> {
    const started = Date.now();
    const bridge = this.getBridge();
    const owner = this.getOwnerId?.();
    const activeSender = bridge?.activeSender ?? owner;
    const route = approvalRoute({
      isWechat: true,
      ...(activeSender === undefined ? {} : { activeSender }),
      relay: null,
      now: Date.now(),
    });
    const recipient = route.kind === "wechat" || route.kind === "relay"
      ? route.sender
      : "没有（既没有 activeSender，也没有绑定账号）";
    // The two questions the 2026-11-08 miss could not answer: is the waterfall
    // listener still in the chain, and when did an approval last reach it?
    const mount = this.verifyMount();
    const ageMs = this.lastRequestAt === undefined ? null : Date.now() - this.lastRequestAt;
    const mountText = mount.mounted
      ? `已挂载（prepend${mount.position === null ? "" : `，第 ${mount.position + 1}/${mount.total} 位`}）`
      : "没挂上（重挂也没成功，审批只会留在桌面）";
    const ageText = ageMs === null
      ? "本次启动以来没有"
      : `${ageMs < 1000 ? "刚刚" : `${Math.round(ageMs / 1000)} 秒前`}（共 ${this.requestsSeen} 次）`;
    const lines = [
      "【审批自检】",
      `监听：${mountText}`,
      `最近一次 approval/request：${ageText}`,
      `桥接：${bridge === null ? "未挂载（按会话 id + 绑定账号兜底）" : "已挂载"}`,
      `微信会话：${this.config.sessionId.slice(-8)}`,
      `收件人：${recipient}`,
      `路由结论：${route.kind === "wechat" ? "审批会发到手机" : "审批会留在桌面"}`,
      `只读自动放行：${this.config.autoAllowReadOnly === false ? "关" : `开（本次已放行 ${this.autoAllowed} 次）`}`,
      `超时：${this.config.approvalTimeoutMs === 0 ? "一直等" : `${Math.round(this.config.approvalTimeoutMs / 60000)} 分钟`}`,
    ];
    if (route.kind !== "wechat") {
      this.record("failed", "审批自检：这条链路到不了手机", { stage: "self-check", route: route.kind });
      lines.push("", "结论：不通。上面两行就是原因（先看账号绑没绑）。");
      return lines.join("\n");
    }
    try {
      await this.sendText(
        route.sender,
        "【DSH 审批自检】\n这条只是测试，不会执行任何操作。\n看到它就说明：审批卡片能发到这个手机。\n真实审批会带「工具 / 原因 / #允许 / #拒绝」三行。",
      );
      this.record("ok", "审批自检：测试卡片已发到手机", { stage: "self-check", route: "wechat", bridgeMounted: bridge !== null });
      lines.push("", "刚发了一张测试卡片 —— 手机上看到它就说明链路通。", "账本：已记录（这次自检可查）");
    } catch (err) {
      const detail = String((err as Error)?.message ?? err).slice(0, 120);
      this.record("failed", `审批自检：卡片发不出去（${detail}）`, { stage: "self-check", route: "wechat" });
      lines.push("", `结论：卡片发不出去 —— ${detail}`);
    }
    lines.push(`（耗时 ${Date.now() - started} ms）`);
    return lines.join("\n");
  }

  /**
   * File one step of an approval's life in the command ledger (D49).
   *
   * An approval is not a command, but it is the one interaction whose delivery
   * the owner cannot verify by looking at the chat: "did the card arrive, was
   * it ever answered, did the desktop eat it?" needs a record or it stays a
   * guess. Never throws: a full disk must not block an approval.
   */
  private record(
    result: "ok" | "noop" | "failed",
    summary: string,
    args: Record<string, unknown>,
  ): void {
    try {
      this.ledger?.append({ command: "审批", args, result, summary }, { mode: "agent", peer: "" });
    } catch {
      // ignore: the approval itself matters more than its record
    }
  }
}
