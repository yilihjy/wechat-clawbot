/**
 * 「已收到，正在处理中…」— the receipt that says the message arrived (D51).
 *
 * Why this is the bridge's job and not the model's: the prompt already tells the
 * bot to confirm before a slow task, and that is exactly what does *not* happen
 * when the bot is slow or stuck — the two moments the receipt exists for. A
 * deterministic timer fires either way.
 *
 * Why delayed instead of immediate: a fast answer would then be two messages
 * ("已收到…" and the answer) for a question that took two seconds. Four seconds
 * is longer than a quick reply and shorter than "is it stuck?".
 *
 * One per burst: a person typing three messages in a row gets one receipt, not
 * three. Arming again only pushes the deadline.
 */

/** Default delay before the receipt goes out, in milliseconds. */
export const ACK_AFTER_MS = 4_000;

/** What the phone reads. The prefix (a relayed title) is added by the caller. */
export const ACK_TEXT = "已收到，正在处理中…";

/** One armed receipt. */
interface Armed {
  readonly dueAt: number;
  readonly ack: string;
}

/**
 * Armed receipts, keyed by peer.
 *
 * Pure: it never sends anything and never reads the clock on its own, so the
 * whole "when does the phone get a receipt" rule is testable without WeChat.
 */
export class AckQueue {
  private readonly armed = new Map<string, Armed>();
  private readonly delay: () => number;

  /** `afterMs` may be a getter: the delay is a live config field. */
  constructor(afterMs: number | (() => number) = ACK_AFTER_MS) {
    this.delay = typeof afterMs === "function" ? afterMs : () => afterMs;
  }

  /** Is a receipt waiting for this peer? */
  has(peer: string): boolean {
    return this.armed.has(peer);
  }

  /** How many receipts are pending (any peer). */
  get size(): number {
    return this.armed.size;
  }

  /**
   * Arm (or re-arm) the receipt for one peer.
   *
   * `prefix` is what a relayed answer carries (`[标题] `), so the receipt reads
   * like the rest of that conversation. A zero delay disarms instead of arming.
   */
  arm(peer: string, now: number, prefix = ""): void {
    const delay = Math.max(0, this.delay());
    if (delay === 0) {
      this.armed.delete(peer);
      return;
    }
    this.armed.set(peer, { dueAt: now + delay, ack: `${prefix}${ACK_TEXT}` });
  }

  /** The answer went out first: nothing to say. Returns whether anything was armed. */
  cancel(peer: string): boolean {
    return this.armed.delete(peer);
  }

  /** Take every receipt that is due, oldest first. */
  due(now: number): Array<{ peer: string; text: string }> {
    const ready: Array<{ peer: string; text: string; dueAt: number }> = [];
    for (const [peer, armed] of this.armed) {
      if (armed.dueAt <= now) ready.push({ peer, text: armed.ack, dueAt: armed.dueAt });
    }
    ready.sort((a, b) => a.dueAt - b.dueAt);
    for (const item of ready) this.armed.delete(item.peer);
    return ready.map(({ peer, text }) => ({ peer, text }));
  }

  /** Forget everything (a stop, a dispose). */
  clear(): void {
    this.armed.clear();
  }
}

/** How often the plugin should look for due receipts: fine-grained enough, cheap. */
export const ACK_TICK_MS = 1_000;
