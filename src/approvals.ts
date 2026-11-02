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
import { PendingRegistry } from "./pending.js";
import { isFresh, type ModeStore, type RelayBinding } from "./modes.js";
import { logger } from "./ilink/util/logger.js";

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

  constructor(deps: {
    config: ClawbotConfig;
    /** Returns the live bridge, or null while the monitor is not running. */
    getBridge: () => WechatBridge | null;
    pending: PendingRegistry;
    sendText: (to: string, text: string) => Promise<void>;
    /** Where the relayed conversations are (absent only in compositions without relay). */
    modes?: ModeStore;
  }) {
    this.config = deps.config;
    this.getBridge = deps.getBridge;
    this.pending = deps.pending;
    this.sendText = deps.sendText;
    this.modes = deps.modes;
  }

  /** Register the `approval/request` waterfall listener on the root context. */
  register(ctx: Context): void {
    ctx.on("approval/request", (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) =>
      this.answer(req, next),
    );
  }

  private async answer(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const bridge = this.getBridge();
    if (!bridge) return next();
    const isWechat = bridge.isWechatSession(req.agent.id);
    // >>> local: relay 的审批也走微信（D16）
    const route = approvalRoute({
      isWechat,
      ...(bridge.activeSender === undefined ? {} : { activeSender: bridge.activeSender }),
      relay: isWechat ? null : this.modes?.peerFor(req.agent.id) ?? null,
      now: Date.now(),
    });
    if (route.kind === "not-ours") return next();
    if (route.kind === "no-sender") {
      logger.warn(`approval: no active WeChat sender for agent ${req.agent.id}; failing closed`);
      return "unavailable";
    }
    const sender = route.sender;
    const heading = route.kind === "relay"
      ? `【DSH 权限请求 · ${route.title.trim() === "" ? "接管中的会话" : `《${route.title}》`}】`
      : "【DSH 权限请求】";

    const question =
      `${heading}\n` +
      `工具: ${req.toolName}\n` +
      `原因: ${req.reason ?? "(未提供)"}\n` +
      `请回复：#允许 / #拒绝`;
    // <<< local

    try {
      await this.sendText(sender, question);
      // Answering a prompt keeps the relay window open: the owner is on the phone.
      if (route.kind === "relay") this.modes?.touch(sender);
    } catch (err) {
      logger.error(`approval: failed to send question to ${sender}: ${String(err)}`);
      return "unavailable";
    }
    // The send can take seconds. If the turn was stopped meanwhile, the abort
    // already fired and a listener added now would never run — the entry would
    // then sit in the queue and swallow the owner's next message.
    if (req.signal?.aborted) return "cancelled";

    return new Promise<ApprovalOutcome>((resolveOutcome) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
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
        }
        settle("cancelled");
      };
      req.signal?.addEventListener("abort", () => withdraw("aborted"), { once: true });

      const timeoutMs = this.config.approvalTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(() => withdraw("timeout"), timeoutMs);
        // Do not hold the process open for a question nobody will answer.
        timer.unref?.();
      }
    });
  }
}
