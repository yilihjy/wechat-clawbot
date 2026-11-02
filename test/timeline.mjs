#!/usr/bin/env node
/**
 * Offline checks for the timeline page and the daily report (`src/timeline.ts`,
 * D32/D33).
 *
 * The page shows a page title that came from someone else's web server, so the
 * first thing checked is that a title cannot become markup. The second is that
 * the sections mean what they say: a failed command is not "done", a duplicate
 * capture is worth a look, and a status check is not "work".
 *
 *   node test/timeline.mjs
 *
 * Exits non-zero when any check fails.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { classify, dayHeadline, escapeHtml, groupDay, renderReport, renderTimeline, writeReport } = await import(
  join(ROOT, "lib/timeline.js")
);

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}

const at = (h, m = 0) => new Date(2026, 10, 2, h, m).getTime();
const entry = (over) => ({ ts: at(9), command: "入库", args: {}, result: "ok", summary: "", undo: null, mode: "agent", peer: "wxid", ...over });

// ---------------------------------------------------------------- escaping

check("a title cannot become markup", escapeHtml('<img src=x onerror="a">').includes("&lt;img"));
check("quotes are escaped", escapeHtml('"').includes("&quot;"));
check("ampersands are escaped once", escapeHtml("a & b") === "a &amp; b");

// ---------------------------------------------------------------- classification

check("a status check is not work", classify(entry({ command: "任务状态" })) === "read");
check("listing models is not work", classify(entry({ command: "模型" })) === "read");
check("switching models is work", classify(entry({ command: "模型", args: { index: 2 } })) === "did");
check("a successful capture is work", classify(entry({})) === "did");
check("a failed capture failed", classify(entry({ result: "failed", summary: "抓不到" })) === "failed");
check("a duplicate capture is worth a look", classify(entry({ args: { duplicate: true } })) === "notable");
check("a short page is worth a look", classify(entry({ args: { short: true } })) === "notable");
check("a command that did nothing is worth a look", classify(entry({ command: "交还", result: "noop" })) === "notable");
check("an undone entry is worth a look", classify(entry({}), new Set([at(9)])) === "notable");
check("the undo record itself is work", classify(entry({ command: "撤销" })) === "did");

const day = [
  entry({ ts: at(8), command: "任务状态" }),
  entry({ ts: at(9), command: "入库", summary: "入库《甲》" }),
  entry({ ts: at(10), command: "入库", summary: "抓不到", result: "failed" }),
  entry({ ts: at(11), command: "入库", result: "ok", args: { duplicate: true }, summary: "本来就有" }),
];
const groups = groupDay(day);
check("grouping keeps the read-only ones apart", groups.read.length === 1 && groups.did.length === 1);
check("grouping finds the failure", groups.failed.length === 1 && groups.failed[0].summary === "抓不到");
check("grouping finds the duplicate", groups.notable.length === 1);
check("grouping is newest first inside a section", groups.did[0].ts === at(9));

// ---------------------------------------------------------------- the page

const html = renderTimeline({
  day: "2026-11-02",
  days: ["2026-11-02", "2026-11-01"],
  entries: [
    ...day,
    entry({
      ts: at(12),
      command: "入库",
      summary: "<script>alert(1)</script>",
      args: { url: "https://e.example/a" },
      undo: { kind: "capture", captureId: "c-1", url: "https://e.example/a", title: "甲" },
    }),
    entry({ ts: at(13), command: "撤销", args: { target: at(12) }, summary: "撤掉了" }),
  ],
  skipped: 2,
  now: at(23),
});
check("the day is the headline", html.includes("11 月 2 日"));
check("a malicious summary is escaped", !html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;"));
check("the page shows the date switcher", html.includes('href="/plugins/clawbot/timeline?date=2026-11-01"'));
check("the page names the sections", html.includes("做了") && html.includes("失败") && html.includes("值得注意"));
check("an undone entry is marked", html.includes("已撤销"));
check("skipped lines are admitted", html.includes("2 行读不出来"));
check("the report is linked", html.includes("format=md"));
check("the URL is shown for a capture", html.includes("https://e.example/a"));
check("nothing is written to the page from a live socket", !html.includes("<iframe"));

// ---------------------------------------------------------------- the report

const md = renderReport({ day: "2026-11-02", entries: day, skipped: 1, generatedAt: at(23) });
check("the report has a title", md.startsWith("# 2026-11-02"));
check("the report counts", md.includes("做了 1 件"), md);
check("the report has the failure section", md.includes("## 失败"));
check("the report says the skipped line", md.includes("1 行读不出来"));
check("the report marks undo availability", md.includes("可撤销") === false);
const withUndo = renderReport({
  day: "2026-11-02",
  entries: [entry({ ts: at(9), command: "入库", summary: "入库《甲》", undo: { kind: "capture", captureId: "c", url: "u", title: "甲" } })],
  skipped: 0,
  generatedAt: at(9),
});
check("a capture with an undo says so", withUndo.includes("可撤销"), withUndo);

// ---------------------------------------------------------------- writing the report

const DIR = mkdtempSync(join(tmpdir(), "clawbot-report-"));
const file = writeReport(DIR, "2026-11-02", md);
check("the report is written", existsSync(file) && readFileSync(file, "utf8") === md, file);
const before = readFileSync(file, "utf8");
writeReport(DIR, "2026-11-02", md);
check("writing the same report again is a no-op", readFileSync(file, "utf8") === before);
writeReport(DIR, "2026-11-02", `${md}more`);
check("a changed report is rewritten", readFileSync(file, "utf8") === `${md}more`);
rmSync(DIR, { recursive: true, force: true });

// An unwritable directory must not throw: the page still has to render.
const blocked = join(tmpdir(), `clawbot-report-blocked-${process.pid}`);
writeFileSync(blocked, "file, not a directory");
const blockedFile = writeReport(join(blocked, "reports"), "2026-11-02", md);
check("a report that cannot be written does not throw", blockedFile.endsWith("2026-11-02.md"));
rmSync(blocked, { force: true });

check("the headline names the weekday", dayHeadline("2026-11-02").includes("周一"), dayHeadline("2026-11-02"));
check("an unparseable day is echoed", dayHeadline("nope") === "nope");

if (failures.length > 0) {
  console.error(`timeline: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`timeline: ${pass} passed, 0 failed`);
