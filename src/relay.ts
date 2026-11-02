/**
 * Relay mode (D15–D18 in the plan): WeChat temporarily becomes the front end of
 * one real DSH conversation.
 *
 * Inbound: the message is wrapped as "用户在微信里说：…" so the desktop side can
 * tell it apart from something typed there, and delivered into the bound session.
 *
 * Outbound: replies are aggregated per turn — one WeChat message per turn, with
 * the conversation title in front — because the model may answer across several
 * steps and a phone should not receive one bubble per step.
 *
 * Approvals inside a relayed conversation are NOT forwarded yet (D16): the
 * approval relay is still bound to the WeChat session, so a relayed turn that
 * needs an approval will wait for the desktop. `#交还` gets you back.
 *
 * The session object is never touched directly: delivery and sending are
 * injected, so the routing and the formatting are testable offline.
 */
import { logger } from "./ilink/util/logger.js";

/** D31: one message up to this many characters. */
export const REPLY_LIMIT = 1_200;

/** D31: a long answer is split into at most this many messages. */
export const REPLY_MAX_PARTS = 3;

/** D31: beyond this the answer goes as an attachment instead. */
export const REPLY_FILE_ABOVE = 5_000;

/** A relayed turn that never ends (stopped driver, disposed agent) must not keep the mapping forever. */
const EXPECTATION_TTL_MS = 15 * 60_000;

/** D18: how a relayed message reads inside the real conversation. */
export function wrapInbound(text: string): string {
  return `用户在微信里说：\n${text}`;
}

/** Why a turn ended, as `turn/end` records it (DSH's `TurnEndReason.kind`). */
export function turnEndReason(data: unknown): string | undefined {
  const reason = (data as { reason?: { kind?: unknown } } | undefined)?.reason;
  return typeof reason?.kind === "string" ? reason.kind : undefined;
}

/** D15: the title prefix a mirrored answer carries. */
export function replyPrefix(title: string): string {
  return `[${title.trim() === "" ? "会话" : title.trim()}] `;
}

/** What to send for one answer. */
export type ReplyPlan =
  | { readonly kind: "parts"; readonly parts: readonly string[] }
  | { readonly kind: "file"; readonly text: string };

/**
 * Pack paragraphs into `parts` buckets of roughly equal size.
 *
 * The last bucket takes whatever is left, so a run of short paragraphs can never
 * produce more messages than asked for. A single paragraph longer than the
 * target stays whole — splitting it mid-sentence reads worse than a long bubble.
 */
function packParagraphs(paragraphs: readonly string[], parts: number, target: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (out.length >= parts - 1) {
      current = current === "" ? paragraph : `${current}\n\n${paragraph}`;
      continue;
    }
    const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (current !== "" && candidate.length > target) {
      out.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** D31: how one answer is delivered. */
export function planReply(
  text: string,
  options: { limit?: number; maxParts?: number; fileAbove?: number } = {},
): ReplyPlan {
  const limit = options.limit ?? REPLY_LIMIT;
  const maxParts = options.maxParts ?? REPLY_MAX_PARTS;
  const fileAbove = options.fileAbove ?? REPLY_FILE_ABOVE;
  const body = text.trim();
  if (body === "") return { kind: "parts", parts: [] };
  if (body.length > fileAbove) return { kind: "file", text: body };
  if (body.length <= limit) return { kind: "parts", parts: [body] };
  const count = Math.min(maxParts, Math.ceil(body.length / limit));
  const paragraphs = body.split(/\n{2,}/u);
  const parts = packParagraphs(paragraphs, count, Math.ceil(body.length / count));
  // A single paragraph can still overshoot badly; cut it where it hurts least.
  const clipped = parts.flatMap((part) => {
    const size = Math.ceil(body.length / count);
    if (part.length <= size) return [part];
    const chunks: string[] = [];
    for (let at = 0; at < part.length; at += size) chunks.push(part.slice(at, at + size));
    return chunks;
  });
  return { kind: "parts", parts: clipped.slice(0, maxParts) };
}

/** One relayed turn we are waiting to mirror. */
type Expectation = {
  readonly peer: string;
  readonly title: string;
  readonly at: number;
  readonly chunks: string[];
};

/** What delivering one relayed message produced. */
export type RelayResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** The parts of the world the relay needs. */
export interface RelayDeps {
  /** Send one WeChat text message. */
  sendText: (to: string, text: string) => Promise<void>;
  /** Put text into a DSH session (see `sendToDshSession`). */
  deliver: (sessionId: string, text: string) => Promise<RelayResult>;
  /** Send a long answer as a file; without it a long answer is clipped. */
  sendFile?: (to: string, name: string, text: string) => Promise<void>;
  /**
   * Is this conversation still the one bound to that peer?
   *
   * The answer decides whether an answer is still owed: `#交还` (or a rebind, or
   * the 30-minute expiry) can happen while the relayed turn is still running, and
   * an answer that arrives afterwards belongs to a conversation the phone has
   * already left. Without this check the owner gets a reply to something they
   * handed back — measured 2026-11-03 00:04, the long "404" answer was mirrored
   * after `#交还` at 00:00:16.
   */
  isStillBound?: (sessionId: string, peer: string) => boolean;
  now?: () => number;
}

/** Relay mode: deliver inbound text, mirror the turn that answers it. */
export class RelayService {
  private readonly expected = new Map<string, Expectation>();
  private readonly now: () => number;

  constructor(private readonly deps: RelayDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Deliver one message into the bound conversation. */
  async relay(peer: string, binding: { sessionId: string; title: string }, text: string): Promise<RelayResult> {
    const result = await this.deps.deliver(binding.sessionId, wrapInbound(text)).catch((err: unknown) => ({
      ok: false as const,
      message: String((err as Error)?.message ?? err),
    }));
    if (!result.ok) return result;
    // Only now is a mirror owed: a delivery that failed starts no turn.
    this.expected.set(binding.sessionId, {
      peer,
      title: binding.title,
      at: this.now(),
      chunks: [],
    });
    return { ok: true };
  }

  /** Whether a mirrored answer is owed for this session. */
  isExpecting(sessionId: string): boolean {
    return this.expected.has(sessionId);
  }

  /**
   * Feed one session event. `assistant/message` accumulates, `turn/end` flushes.
   * Sessions the relay is not waiting on are ignored, so a conversation the user
   * drives on the desktop never starts echoing into WeChat.
   */
  onSessionEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    const expectation = this.expected.get(sessionId);
    if (expectation === undefined) return;
    if (this.now() - expectation.at > EXPECTATION_TTL_MS) {
      this.expected.delete(sessionId);
      logger.warn(`relay: dropped a stale expectation for ${sessionId}`);
      return;
    }
    if (event.type === "assistant/message") {
      const text = assistantText(event.data);
      if (text !== "") expectation.chunks.push(text);
      return;
    }
    if (event.type !== "turn/end") return;

    this.expected.delete(sessionId);
    // A turn the owner stopped with `#停一下` was already acknowledged on the
    // phone ("已停《…》"). Mirroring it now would answer a question nobody asked.
    if (turnEndReason(event.data) === "aborted") {
      logger.info(`relay: ${sessionId} was stopped; nothing to mirror`);
      return;
    }
    // The binding is the reason an answer is owed. If it ended first, so did the
    // debt — the next turn in that conversation belongs to whoever drives it now.
    if (this.deps.isStillBound !== undefined && !this.deps.isStillBound(sessionId, expectation.peer)) {
      logger.info(`relay: ${sessionId} is no longer bound; its answer is not mirrored`);
      return;
    }
    void this.mirror(expectation);
  }

  /**
   * Forget what is owed for a session — a hand-back ended it, or another
   * conversation took its place.
   */
  forget(sessionId: string): void {
    if (this.expected.delete(sessionId)) logger.info(`relay: dropped the mirror owed for ${sessionId}`);
  }

  /** Send the accumulated answer (or say that there was none). */
  private async mirror(expectation: Expectation): Promise<void> {
    const text = expectation.chunks.join("\n\n").trim();
    const prefix = replyPrefix(expectation.title);
    if (text === "") {
      // Tool-only turns are normal ("跑完了，没别的"); saying nothing at all would
      // leave the phone wondering whether the message even arrived.
      await this.deps.sendText(expectation.peer, `${prefix}（这一轮没有文字回复）`).catch((err: unknown) => {
        logger.warn(`relay: could not mirror the empty answer: ${String(err)}`);
      });
      return;
    }
    const plan = planReply(text);
    try {
      if (plan.kind === "file") {
        if (this.deps.sendFile !== undefined) {
          await this.deps.sendFile(expectation.peer, "reply.md", plan.text);
          await this.deps.sendText(expectation.peer, `${prefix}全文见附件（${plan.text.length} 字）`);
          return;
        }
        // No file channel: send what a phone can take and say the rest is missing.
        const clipped = planReply(plan.text.slice(0, REPLY_FILE_ABOVE), {});
        const parts = clipped.kind === "parts" ? clipped.parts : [];
        await this.sendParts(expectation.peer, prefix, parts, "（太长，已截断）");
        return;
      }
      await this.sendParts(expectation.peer, prefix, plan.parts);
    } catch (err) {
      logger.warn(`relay: mirror failed: ${String(err)}`);
    }
  }

  /** Send the parts in order, numbering them when there is more than one. */
  private async sendParts(peer: string, prefix: string, parts: readonly string[], note = ""): Promise<void> {
    if (parts.length === 0) return;
    for (const [index, part] of parts.entries()) {
      const label = parts.length > 1 ? `（${index + 1}/${parts.length}）` : "";
      const head = index === 0 ? prefix : "";
      await this.deps.sendText(peer, `${head}${part}${label}${index === parts.length - 1 ? note : ""}`);
    }
  }
}

/** Text of one assistant message event, without touching the host's types. */
export function assistantText(data: unknown): string {
  const content = (data as { message?: { content?: readonly unknown[] } } | undefined)?.message?.content ?? [];
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}
