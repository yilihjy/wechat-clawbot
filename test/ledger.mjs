#!/usr/bin/env node
/**
 * Offline checks for the command ledger (`src/ledger.ts`, D28).
 *
 * The ledger is the only record of what was typed on the phone, so the checks
 * are about the awkward cases rather than the happy path: a half-written line
 * (Q8), a day boundary, retention, and "already undone" — the three ways a
 * reader of this file would otherwise be told something untrue.
 *
 *   node test/ledger.mjs
 *
 * Exits non-zero when any check fails.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { CommandLedger, dayKey, daysAgo, parseDayKey, parseEntry, undoneTarget, LEDGER_RETENTION_DAYS } = await import(
  join(ROOT, "lib/ledger.js")
);

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}

const DIR = mkdtempSync(join(tmpdir(), "clawbot-ledger-"));

// ---------------------------------------------------------------- day keys

const day0 = new Date(2026, 10, 2, 16, 32).getTime();
check("dayKey is the local calendar day", dayKey(day0) === "2026-11-02", dayKey(day0));
check("parseDayKey round-trips", parseDayKey("2026-11-02") === new Date(2026, 10, 2).getTime());
check("parseDayKey rejects a rolled-over date", parseDayKey("2026-02-31") === null);
check("parseDayKey rejects junk", parseDayKey("yesterday") === null);
check("daysAgo counts calendar days", daysAgo("2026-10-30", day0) === 3, String(daysAgo("2026-10-30", day0)));
check("daysAgo of today is zero", daysAgo("2026-11-02", day0) === 0);

// ---------------------------------------------------------------- append + read

let clock = day0;
const ledger = new CommandLedger({ dir: DIR, now: () => clock });
const first = ledger.append({
  command: "入库",
  args: { url: "https://example.com/a", captureId: "cap-1" },
  result: "ok",
  summary: "入库《一篇》",
  undo: { kind: "capture", captureId: "cap-1", url: "https://example.com/a", title: "一篇" },
});
check("append stamps the time", first.ts === day0);
check("append defaults to agent mode", first.mode === "agent");
const day1 = ledger.readDay("2026-11-02");
check("the entry is on disk", day1.entries.length === 1, JSON.stringify(day1));
check("reading keeps the undo", day1.entries[0].undo?.kind === "capture");
check("reading keeps the arguments", day1.entries[0].args?.url === "https://example.com/a");
check("the file is a day file", readFileSync(join(DIR, "2026-11-02.jsonl"), "utf8").trim().startsWith("{"));

// ---------------------------------------------------------------- the awkward lines (Q8)

// A crash mid-write leaves a line without its closing brace.
writeFileSync(join(DIR, "2026-11-02.jsonl"), '{"half":', { flag: "a" });
const corrupt = ledger.readDay("2026-11-02");
check("a half-written line is skipped, not thrown", corrupt.entries.length === 1 && corrupt.skipped === 1, JSON.stringify(corrupt));
check("parseEntry rejects a line without a time", parseEntry('{"command":"x","result":"ok"}') === null);
check("parseEntry rejects an unknown result", parseEntry('{"ts":1,"command":"x","result":"maybe"}') === null);
const bare = parseEntry('{"ts":1,"command":"x","result":"ok"}');
check("parseEntry defaults a missing undo to null", bare !== null && bare.undo === null);

// ---------------------------------------------------------------- day boundary

clock = new Date(2026, 10, 3, 9, 5).getTime();
ledger.append({ command: "交还", result: "ok", summary: "交还了《工作》", undo: { kind: "relay-release", previous: { sessionId: "s-1", title: "工作" } } });
check("a new day is a new file", ledger.days().length === 2, ledger.days().join(","));
check("days are newest first", ledger.days()[0] === "2026-11-03", ledger.days().join(","));
check("yesterday is untouched", ledger.readDay("2026-11-02").entries.length === 1);

// ---------------------------------------------------------------- recent + undoable

const recent = ledger.recent(10);
check("recent covers days, oldest first", recent.length === 2 && recent[0].command === "入库", recent.map((e) => e.command).join(","));
check("recent honours its limit", ledger.recent(1).length === 1);
const undoable = ledger.undoable();
check("both entries are undoable", undoable.length === 2, String(undoable.length));
check("undoable is newest first", undoable[0].command === "交还", undoable.map((e) => e.command).join(","));

// A 撤销 record removes its target from the candidates but stays itself visible.
clock = new Date(2026, 10, 3, 9, 6).getTime();
const removed = ledger.append({
  command: "撤销",
  args: { target: undoable[0].ts, undone: "交还" },
  result: "ok",
  summary: "已重新接管《工作》",
  undo: null,
});
check("a 撤销 record points at its target", undoneTarget(removed) === undoable[0].ts);
const afterUndo = ledger.undoable();
check("an undone entry is not offered again", afterUndo.length === 1 && afterUndo[0].command === "入库", afterUndo.map((e) => e.command).join(","));
check("the 撤销 record is not itself undoable", afterUndo.every((e) => e.undo !== null));
check("find() reaches an entry by timestamp", ledger.find(first.ts)?.command === "入库");
check("find() misses an unknown timestamp", ledger.find(42) === undefined);

// ---------------------------------------------------------------- retention

const old = new Date(2026, 10, 3, 9, 6).getTime() - (LEDGER_RETENTION_DAYS + 5) * 86_400_000;
writeFileSync(join(DIR, `${dayKey(old)}.jsonl`), `${JSON.stringify({ ts: old, command: "帮助", result: "ok", summary: "很旧" })}\n`);
check("the old day is on disk before pruning", ledger.days().includes(dayKey(old)));
const pruned = ledger.prune();
check("prune drops a day past retention", pruned.includes(dayKey(old)), pruned.join(","));
check("prune leaves recent days alone", ledger.days().includes("2026-11-02") && ledger.days().includes("2026-11-03"));

// ---------------------------------------------------------------- best effort

const blocker = join(DIR, "blocker");
writeFileSync(blocker, "not a directory");
const broken = new CommandLedger({ dir: join(blocker, "ledger"), now: () => day0 });
const survived = broken.append({ command: "帮助", result: "ok", summary: "写不进去" });
check("a failed write still returns the entry", survived.command === "帮助" && survived.ts === day0);
check("a failed write reads back as empty", broken.readDay("2026-11-02").entries.length === 0);

rmSync(DIR, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`ledger: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`ledger: ${pass} passed, 0 failed`);
