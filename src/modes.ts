/**
 * Which conversation a WeChat message belongs to (D19/D20 in the plan).
 *
 * Two modes, per peer:
 * - `agent` — the dedicated WeChat session (the default; nothing is stored).
 * - `relay` — one real DSH conversation temporarily acts as the front end, so a
 *   message from the phone lands in the conversation you are working in.
 *
 * The binding is persisted in `modes.json` so a restart does not silently send
 * the next message to the wrong place, and it expires after 30 minutes of
 * silence so a forgotten `#接管` cannot keep hijacking messages tomorrow.
 *
 * Time and the file path are injected: the whole state machine is testable
 * without a session, a clock, or the real state directory.
 */
import fs from "node:fs";
import path from "node:path";

import { logger } from "./ilink/util/logger.js";

/** D20: silence longer than this drops the binding and lands messages back on the agent. */
export const RELAY_TTL_MS = 30 * 60_000;

/** One relay binding: which conversation, and when it was last used. */
export interface RelayBinding {
  readonly sessionId: string;
  readonly title: string;
  /** When `#接管` was accepted. */
  readonly since: number;
  /** Last message that went through the binding; the TTL counts from here. */
  readonly lastAt: number;
}

/** What the store knows about one peer. */
export interface ModeLookup {
  /** The live binding, or null when this peer talks to the agent. */
  readonly binding: RelayBinding | null;
  /** A binding that was just dropped for silence, so the caller can say so once. */
  readonly expired: RelayBinding | null;
}

type ModeFile = {
  version: 1;
  peers: Record<string, RelayBinding>;
};

/** Is this binding still inside its silence window? */
export function isRelayActive(binding: RelayBinding, now: number, ttlMs: number = RELAY_TTL_MS): boolean {
  return now - binding.lastAt < ttlMs;
}

/**
 * How recently the phone must have used the binding for it to be treated as
 * "you are on the phone right now" (the approval relay asks this).
 *
 * Without it, an approval would keep going to WeChat for the whole 30-minute
 * window even after the owner sat back down at the desktop.
 */
export const RELAY_FRESH_MS = 5 * 60_000;

/** Was this binding used in the last `windowMs`? */
export function isFresh(binding: RelayBinding, now: number, windowMs: number = RELAY_FRESH_MS): boolean {
  return now - binding.lastAt < windowMs;
}

/** Milliseconds left before the binding lapses (never negative). */
export function remainingMs(binding: RelayBinding, now: number, ttlMs: number = RELAY_TTL_MS): number {
  return Math.max(0, binding.lastAt + ttlMs - now);
}

/** Push the silence window forward: a message went through this binding. */
export function touchBinding(binding: RelayBinding, now: number): RelayBinding {
  return { ...binding, lastAt: now };
}

/** `还剩 12 分钟` — how a receipt explains the auto-expiry. */
export function remainingText(binding: RelayBinding, now: number, ttlMs: number = RELAY_TTL_MS): string {
  const left = remainingMs(binding, now, ttlMs);
  const minutes = Math.ceil(left / 60_000);
  return minutes <= 0 ? "已过期" : `还剩 ${minutes} 分钟`;
}

/** The one-line description `#当前模式` prints for a binding. */
/**
 * A session id short enough for a phone.
 *
 * Slicing the raw id gives "session-" for every conversation (they all start
 * with the same prefix), which is worse than useless in a receipt: it was the
 * title of a `#新会话` binding on 2026-11-03 until this existed.
 */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/u, "").slice(0, 8);
}

export function describeBinding(binding: RelayBinding, now: number, ttlMs: number = RELAY_TTL_MS): string {
  const title = binding.title.trim() === "" ? shortSessionId(binding.sessionId) : binding.title;
  return `《${title}》 · ${shortSessionId(binding.sessionId)} · ${remainingText(binding, now, ttlMs)}`;
}

/** Validate one stored binding; anything malformed is dropped rather than trusted. */
function parseBinding(value: unknown): RelayBinding | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  if (sessionId === "") return null;
  const since = typeof row.since === "number" && Number.isFinite(row.since) ? row.since : Date.now();
  const lastAt = typeof row.lastAt === "number" && Number.isFinite(row.lastAt) ? row.lastAt : since;
  return { sessionId, title: typeof row.title === "string" ? row.title : "", since, lastAt };
}

/**
 * Per-peer mode, written through to `modes.json`.
 *
 * The file is read once and then kept in memory; every write goes to a temporary
 * file and is renamed into place, so a crash mid-write leaves the previous state
 * rather than half a JSON document.
 */
export class ModeStore {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private peers: Record<string, RelayBinding> | null = null;

  constructor(file: string, options: { ttlMs?: number; now?: () => number } = {}) {
    this.file = file;
    this.ttlMs = options.ttlMs ?? RELAY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Every binding, live or stale, for the status text and startup validation. */
  all(): RelayBinding[] {
    return Object.values(this.load());
  }

  /**
   * The peer relaying into one conversation, if any.
   *
   * Used by the approval relay: a permission request belongs to a session, and
   * the question has to reach whoever is holding that conversation right now.
   * Stale bindings are not returned — a relay nobody has used for half an hour
   * must not intercept a prompt the desktop is about to show.
   */
  peerFor(sessionId: string): { peer: string; binding: RelayBinding } | null {
    const now = this.now();
    for (const [peer, binding] of Object.entries(this.load())) {
      if (binding.sessionId !== sessionId) continue;
      if (!isRelayActive(binding, now, this.ttlMs)) return null;
      return { peer, binding };
    }
    return null;
  }

  /** Look one peer up, dropping a binding that has been silent for too long. */
  lookup(peer: string): ModeLookup {
    const peers = this.load();
    const binding = peers[peer];
    if (binding === undefined) return { binding: null, expired: null };
    const now = this.now();
    if (isRelayActive(binding, now, this.ttlMs)) return { binding, expired: null };
    delete peers[peer];
    this.save(peers);
    logger.info(`modes: relay ${binding.sessionId} for ${peer} expired after silence`);
    return { binding: null, expired: binding };
  }

  /** Bind a peer to a conversation (`#接管`). */
  bind(peer: string, input: { sessionId: string; title: string }): RelayBinding {
    const peers = this.load();
    const now = this.now();
    const previous = peers[peer];
    const binding: RelayBinding = {
      sessionId: input.sessionId,
      title: input.title,
      // Rebinding the same conversation keeps the original start time.
      since: previous?.sessionId === input.sessionId ? previous.since : now,
      lastAt: now,
    };
    peers[peer] = binding;
    this.save(peers);
    return binding;
  }

  /** Drop a binding (`#交还`); true when there was one. */
  release(peer: string): RelayBinding | null {
    const peers = this.load();
    const binding = peers[peer];
    if (binding === undefined) return null;
    delete peers[peer];
    this.save(peers);
    return binding;
  }

  /** A message went through the binding: push the expiry out. */
  touch(peer: string): void {
    const peers = this.load();
    const binding = peers[peer];
    if (binding === undefined) return;
    peers[peer] = touchBinding(binding, this.now());
    this.save(peers);
  }

  /**
   * Startup check (D19): drop bindings whose conversation no longer exists.
   * Returns what was dropped so the caller can mention it instead of silently
   * switching behaviour under the user.
   */
  pruneMissing(exists: (sessionId: string) => boolean): RelayBinding[] {
    const peers = this.load();
    const dropped: RelayBinding[] = [];
    for (const [peer, binding] of Object.entries(peers)) {
      if (exists(binding.sessionId)) continue;
      delete peers[peer];
      dropped.push(binding);
    }
    if (dropped.length > 0) this.save(peers);
    return dropped;
  }

  private load(): Record<string, RelayBinding> {
    if (this.peers !== null) return this.peers;
    this.peers = {};
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ModeFile>;
      for (const [peer, value] of Object.entries(parsed.peers ?? {})) {
        const binding = parseBinding(value);
        if (binding !== null) this.peers[peer] = binding;
      }
    } catch {
      // Absent or unreadable: every peer starts on the agent, which is the safe side.
    }
    return this.peers;
  }

  private save(peers: Record<string, RelayBinding>): void {
    const data: ModeFile = { version: 1, peers };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.warn(`modes: could not persist ${this.file}: ${String(err)}`);
    }
  }
}
