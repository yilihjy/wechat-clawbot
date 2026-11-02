/**
 * Command ledger (D28) — one structured line per WeChat command, per day.
 *
 * Why a ledger at all: `#任务状态` answers "what is running *now*", but the
 * questions that actually come up on a phone are retrospective — "what did I
 * file this morning", "did that link go in", "undo the last one". Neither the
 * session log (it holds conversation, not commands) nor the workbench (it never
 * sees the ones that failed) can answer those.
 *
 * What is stored is deliberately narrow: the command name, its **arguments**
 * (a URL, an index), the result, and what it would take to undo it. Never the
 * message text the user typed, never the page body that was captured. That
 * keeps a 90-day archive from turning into a second copy of the conversation.
 *
 * The reader is the timeline page (D32) and the daily report (D33); both are
 * pure functions over the entries this module returns, so a corrupt line is a
 * skipped line, never a crash (Q8).
 */
import fs from "node:fs";
import path from "node:path";

import { logger } from "./ilink/util/logger.js";

/** How long entries are kept (D28). Deleted by `prune()`, oldest first. */
export const LEDGER_RETENTION_DAYS = 90;

/** How a command ended, in the three shapes the timeline colours. */
export type LedgerResult = "ok" | "failed" | "noop";

/** What it would take to undo one entry (D30). */
export type LedgerUndo =
  | {
      readonly kind: "capture";
      readonly captureId: string;
      readonly url: string;
      readonly title: string | null;
    }
  | { readonly kind: "relay-bind"; readonly sessionId: string }
  | {
      readonly kind: "relay-release";
      readonly previous: { readonly sessionId: string; readonly title: string } | null;
    };

/** One entry before the ledger stamps it with a time, a mode, and a peer. */
export interface LedgerDraft {
  /** The command word without the `#` ("入库", "接管", "任务状态"). */
  readonly command: string;
  /** Arguments only — never the message the user typed around them. */
  readonly args?: Record<string, unknown>;
  readonly result: LedgerResult;
  /** One short line a phone can read; this is what the timeline prints. */
  readonly summary: string;
  /** Absent/`null` when there is nothing to undo. */
  readonly undo?: LedgerUndo | null;
}

/** One stored entry. `ts` is both the time and the entry's identity. */
export interface LedgerEntry extends LedgerDraft {
  readonly ts: number;
  /** Which mode the command ran in. */
  readonly mode: "agent" | "relay";
  /** The WeChat peer that typed it. */
  readonly peer: string;
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

/** `YYYY-MM-DD` in local time — the file a moment belongs to. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Millisecond start of a `YYYY-MM-DD` day in local time, or null when it is not one. */
export function parseDayKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(key);
  if (match === null) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return null;
  // Reject 2026-02-31 and friends: the constructor rolls them over.
  if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return date.getTime();
}

/** How many days back a day key is, from `now` (0 = today). */
export function daysAgo(key: string, now: number): number {
  const start = parseDayKey(key);
  if (start === null) return Number.POSITIVE_INFINITY;
  const today = parseDayKey(dayKey(now));
  if (today === null) return Number.POSITIVE_INFINITY;
  return Math.round((today - start) / 86_400_000);
}

/** The entry a `撤销` record points at, or null when it points at nothing. */
export function undoneTarget(entry: LedgerEntry): number | null {
  if (entry.command !== "撤销") return null;
  const target = entry.args?.["target"];
  return typeof target === "number" && Number.isFinite(target) ? target : null;
}

/**
 * The command ledger, one JSONL file per day.
 *
 * Every method is best-effort: a full disk or a corrupt line must never take
 * the bridge down, because a command that already had its side effect should
 * still answer the user even if it could not be written down.
 */
export class CommandLedger {
  private readonly dir: string;
  private readonly now: () => number;
  private prunedOn = "";

  constructor(options: { dir: string; now?: () => number }) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
  }

  /** The directory the day files live in. */
  get directory(): string {
    return this.dir;
  }

  /** File one command. Returns the stamped entry even when writing failed. */
  append(draft: LedgerDraft, context: { mode?: "agent" | "relay"; peer?: string } = {}): LedgerEntry {
    const now = this.now();
    const entry: LedgerEntry = {
      ...draft,
      args: draft.args ?? {},
      undo: draft.undo ?? null,
      ts: now,
      mode: context.mode === "relay" ? "relay" : "agent",
      peer: context.peer ?? "",
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, `${dayKey(now)}.jsonl`), `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (err) {
      logger.warn(`ledger: could not write ${dayKey(now)}: ${String(err).slice(0, 160)}`);
    }
    this.pruneOnce();
    return entry;
  }

  /** Every entry of one day, plus how many lines could not be read (Q8). */
  readDay(day: string): { entries: LedgerEntry[]; skipped: number } {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.dir, `${day}.jsonl`), "utf8");
    } catch {
      return { entries: [], skipped: 0 };
    }
    const entries: LedgerEntry[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = parseEntry(line);
      if (parsed === null) skipped += 1;
      else entries.push(parsed);
    }
    return { entries, skipped };
  }

  /** The days that have a file, newest first. */
  days(limit = 30): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => DAY_FILE.test(name))
      .map((name) => name.slice(0, -".jsonl".length))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, limit);
  }

  /** The last `limit` entries across recent days, oldest first (a chat-like tail). */
  recent(limit = 20): LedgerEntry[] {
    const collected: LedgerEntry[] = [];
    for (const day of this.days(30)) {
      const { entries } = this.readDay(day);
      collected.unshift(...entries);
      if (collected.length >= limit) break;
    }
    return collected.slice(-limit);
  }

  /**
   * Entries that can still be undone, newest first.
   *
   * "Still" matters: an entry already pointed at by a `撤销` record is not
   * offered again — undoing a capture twice would just reach the workbench's
   * idempotent branch and tell the user nothing new.
   */
  undoable(limit = 5): LedgerEntry[] {
    const entries = this.recent(400);
    const undone = new Set<number>();
    for (const entry of entries) {
      const target = undoneTarget(entry);
      if (target !== null) undone.add(target);
    }
    return entries
      .filter((entry) => entry.undo !== undefined && entry.undo !== null && !undone.has(entry.ts))
      .reverse()
      .slice(0, limit);
  }

  /** One entry by its timestamp, across the recent days. */
  find(ts: number): LedgerEntry | undefined {
    return this.recent(400).find((entry) => entry.ts === ts);
  }

  /** Delete day files older than the retention window. Returns what was removed. */
  prune(): string[] {
    const removed: string[] = [];
    const now = this.now();
    for (const day of this.days(1000)) {
      if (daysAgo(day, now) <= LEDGER_RETENTION_DAYS) continue;
      try {
        fs.unlinkSync(path.join(this.dir, `${day}.jsonl`));
        removed.push(day);
      } catch (err) {
        logger.warn(`ledger: could not remove ${day}: ${String(err).slice(0, 120)}`);
      }
    }
    return removed;
  }

  /** Prune at most once a day: the append path runs on every command. */
  private pruneOnce(): void {
    const today = dayKey(this.now());
    if (this.prunedOn === today) return;
    this.prunedOn = today;
    this.prune();
  }
}

/** Parse one JSONL line; null when it is not a usable entry (half-written, unknown version). */
export function parseEntry(line: string): LedgerEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row["ts"] !== "number" || typeof row["command"] !== "string") return null;
  const result = row["result"];
  if (result !== "ok" && result !== "failed" && result !== "noop") return null;
  return {
    ts: row["ts"],
    command: row["command"],
    args: typeof row["args"] === "object" && row["args"] !== null ? (row["args"] as Record<string, unknown>) : {},
    result,
    summary: typeof row["summary"] === "string" ? row["summary"] : "",
    undo: isUndo(row["undo"]) ? row["undo"] : null,
    mode: row["mode"] === "relay" ? "relay" : "agent",
    peer: typeof row["peer"] === "string" ? row["peer"] : "",
  };
}

/** Structural check for a stored undo descriptor. */
function isUndo(value: unknown): value is LedgerUndo {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "capture") return typeof (value as { captureId?: unknown }).captureId === "string";
  if (kind === "relay-bind") return typeof (value as { sessionId?: unknown }).sessionId === "string";
  if (kind === "relay-release") return "previous" in value;
  return false;
}
