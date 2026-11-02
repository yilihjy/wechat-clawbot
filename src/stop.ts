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
