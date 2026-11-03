/**
 * `#停一下` in relay mode asks once before it really stops (D14).
 *
 * Why the second step exists only for relay: in agent mode the turn that gets
 * cancelled is the one this chat just started, and nobody minds. A relay turn
 * belongs to a conversation the owner may be watching on the desktop right
 * now — stopping it because a thumb slipped is expensive, and the answer is
 * already in flight somewhere else.
 *
 * The confirmation is a small in-memory window, not a queue entry: it must not
 * swallow the next message (an unrelated "停" that arrives late is just a
 * message), and a restart should not leave a gate that nobody remembers
 * opening. It expires on its own.
 */

/** How long a confirmation waits for the "停" that follows it. */
export const STOP_CONFIRM_MS = 5 * 60_000;

/** The conversation a stop would hit. */
export interface StopTarget {
  readonly sessionId: string;
  readonly title: string;
}

interface Window {
  readonly target: StopTarget;
  readonly until: number;
}

/** One confirmation per peer: a second `#停一下` replaces the first. */
export class StopConfirms {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;

  constructor(windowMs: number = STOP_CONFIRM_MS) {
    this.windowMs = windowMs;
  }

  /** Remember that this peer was asked whether to really stop. */
  request(peer: string, target: StopTarget, now: number): void {
    this.windows.set(peer, { target, until: now + this.windowMs });
  }

  /** The target waiting for a confirmation, or null — expired windows clear themselves. */
  pending(peer: string, now: number): StopTarget | null {
    const window = this.windows.get(peer);
    if (window === undefined) return null;
    if (now >= window.until) {
      this.windows.delete(peer);
      return null;
    }
    return window.target;
  }

  /** Drop the window (confirmed, or superseded by another message). */
  clear(peer: string): void {
    this.windows.delete(peer);
  }
}

/** Trailing punctuation a phone keyboard adds; kept local so this module imports nothing. */
const TRAILING_PUNCTUATION = /[\s。！？!?.,，、；;：:]+$/u;

/** Is this message the "停" that confirms a stop? */
export function isStopWord(text: string | null): boolean {
  if (text === null) return false;
  const word = text.trim().replace(TRAILING_PUNCTUATION, "").replace(/^#/u, "").trim();
  return /^(停|停下|停一下|stop)$/iu.test(word);
}

/** How long a completed `#停一下` keeps explaining the next abort. */
export const RECENT_STOP_MS = 10_000;

/**
 * Sessions stopped by `#停一下` a moment ago (D49).
 *
 * When an approval's turn is aborted, the phone deserves a line — unless the
 * owner is the one who stopped it, in which case "已停《…》" already said it and
 * a second message ("这条审批已经在电脑上处理了") would be a lie.
 */
export class RecentStops {
  private readonly noted = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs: number = RECENT_STOP_MS) {
    this.windowMs = windowMs;
  }

  /** Remember that this session was stopped just now. */
  note(sessionId: string, now: number): void {
    this.noted.set(sessionId, now);
  }

  /** Was it stopped within the window? Expired entries clear themselves. */
  has(sessionId: string, now: number): boolean {
    const at = this.noted.get(sessionId);
    if (at === undefined) return false;
    if (now - at > this.windowMs) {
      this.noted.delete(sessionId);
      return false;
    }
    return true;
  }
}
