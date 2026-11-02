/**
 * The timeline page (D32) and the daily report (D33).
 *
 * A ledger nobody can read is a log file. This turns one day of entries into a
 * page you open in the browser — "what did I do", "what failed", "what needs a
 * second look" — and, on the way, writes the same day out as
 * `reports/YYYY-MM-DD.md` so the record survives a cleared history and can be
 * grepped.
 *
 * Read-only by design: the page takes no action at all. A retry button would be
 * a side-effecting endpoint reachable by any local page, and a form POST from
 * another site carries a loopback Host — `localRequest` alone does not stop it.
 * Retrying is a one-line reply on the phone (`#入库 <链接>`), which also means
 * the retry is a command in the ledger rather than a click nobody can audit.
 */
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";

import { dayKey, LEDGER_RETENTION_DAYS, parseDayKey, type CommandLedger, type LedgerEntry } from "./ledger.js";
import { logger } from "./ilink/util/logger.js";
import { localRequest } from "./secretary.js";

/** The one method this file uses on the host's web server — see models-route.ts. */
type WebServerLike = {
  register: (route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => () => void;
};

/** Which part of the page an entry belongs to. */
export type Section = "did" | "failed" | "notable" | "read";

/** Commands that only look at something. */
const READ_ONLY: ReadonlySet<string> = new Set(["任务状态", "当前模式", "帮助"]);

/**
 * The same command can be either: `#模型` alone only lists, `#模型 N` changes
 * the conversation. Both are recorded, so the page can tell them apart.
 */
export function isReadOnlyLook(entry: LedgerEntry): boolean {
  if (READ_ONLY.has(entry.command)) return true;
  return entry.command === "模型" && typeof entry.args?.["index"] !== "number";
}

/** `HH:MM` in local time. */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Where one entry goes on the page.
 *
 * `read` is separated rather than dropped: "I checked status five times" is
 * worth a count, and it keeps the interesting rows from being buried.
 */
export function classify(entry: LedgerEntry, undone: ReadonlySet<number> = new Set()): Section {
  if (undone.has(entry.ts)) return "notable";
  if (isReadOnlyLook(entry)) return "read";
  // A failure is a failure whatever the command is — including a 撤销 that the
  // workbench could not carry out.
  if (entry.result === "failed") return "failed";
  if (entry.command === "撤销") return "did";
  if (entry.result === "noop") return "notable";
  if (entry.args?.["duplicate"] === true) return "notable";
  if (entry.args?.["short"] === true) return "notable";
  return "did";
}

/** Group one day, newest first inside each section. */
export function groupDay(entries: readonly LedgerEntry[]): Record<Section, LedgerEntry[]> {
  const undone = new Set<number>();
  for (const entry of entries) {
    const target = entry.args?.["target"];
    if (entry.command === "撤销" && typeof target === "number" && entry.result === "ok") undone.add(target);
  }
  const groups: Record<Section, LedgerEntry[]> = { did: [], failed: [], notable: [], read: [] };
  for (const entry of [...entries].sort((a, b) => b.ts - a.ts)) groups[classify(entry, undone)].push(entry);
  return groups;
}

/** Escape text for HTML. The page has no other defence, and titles come from the web. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** One row: time, the command in its original spelling, and what happened. */
function row(entry: LedgerEntry, undone: ReadonlySet<number>): string {
  const undo = entry.undo === null || entry.undo === undefined
    ? ""
    : undone.has(entry.ts)
      ? '<span class="chip done">已撤销</span>'
      : '<span class="chip">可撤销</span>';
  const mode = entry.mode === "relay" ? '<span class="chip relay">接管中</span>' : "";
  const url = typeof entry.args?.["url"] === "string" ? entry.args["url"] : "";
  const link = url === "" ? "" : `<div class="url">${escapeHtml(url)}</div>`;
  return `<li><time>${clockOf(entry.ts)}</time><div class="body"><b>#${escapeHtml(entry.command)}</b> ${escapeHtml(entry.summary)}${link}</div><div class="chips">${mode}${undo}</div></li>`;
}

/** `2026-11-02` as the page's headline: `11 月 2 日 · 周日`. */
export function dayHeadline(day: string): string {
  const start = parseDayKey(day);
  if (start === null) return day;
  const d = new Date(start);
  const weekday = "日一二三四五六"[d.getDay()] ?? "";
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${weekday}`;
}

/** The day switcher: the last two weeks, newest first. */
function dayNav(days: readonly string[], current: string): string {
  const links = days.map((day) => {
    const active = day === current ? ' class="active"' : "";
    return `<a href="/plugins/clawbot/timeline?date=${day}"${active}>${day.slice(5)}</a>`;
  });
  return `<nav>${links.join("")}</nav>`;
}

/** Render the whole page. Pure: everything it shows is passed in. */
export function renderTimeline(input: {
  readonly day: string;
  readonly days: readonly string[];
  readonly entries: readonly LedgerEntry[];
  readonly skipped: number;
  readonly now: number;
}): string {
  const groups = groupDay(input.entries);
  const undone = new Set<number>();
  for (const entry of input.entries) {
    const target = entry.args?.["target"];
    if (entry.command === "撤销" && typeof target === "number" && entry.result === "ok") undone.add(target);
  }
  const section = (title: string, entries: LedgerEntry[], empty: string): string =>
    `<section><h2>${title} <small>${entries.length}</small></h2>${
      entries.length === 0 ? `<p class="empty">${empty}</p>` : `<ul>${entries.map((e) => row(e, undone)).join("")}</ul>`
    }</section>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.day)} · 微信 → DSH</title>
<style>
:root{color-scheme:light dark;--line:#d8d8d8;--dim:#6b6b6b;--bg:#fff;--fg:#111}
@media (prefers-color-scheme:dark){:root{--line:#3a3a3a;--dim:#9a9a9a;--bg:#151515;--fg:#eee}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:46rem;padding:1.2rem 1rem 4rem;background:var(--bg);color:var(--fg);
  font:15px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif}
header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}
h1{font-size:1.15rem;margin:0}
h2{font-size:.9rem;color:var(--dim);font-weight:600;margin:1.6rem 0 .5rem;text-transform:none}
h2 small{font-weight:400;opacity:.7}
nav{display:flex;gap:.3rem;flex-wrap:wrap;margin:1rem 0}
nav a{font-size:.8rem;padding:.25rem .5rem;border:1px solid var(--line);border-radius:.4rem;color:inherit;text-decoration:none}
nav a.active{background:var(--fg);color:var(--bg);border-color:var(--fg)}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:.6rem;align-items:flex-start;padding:.5rem 0;border-top:1px solid var(--line)}
time{font-variant-numeric:tabular-nums;color:var(--dim);font-size:.82rem;flex:0 0 3rem}
.body{flex:1;min-width:0;word-break:break-word}
.url{font-size:.75rem;color:var(--dim);overflow-wrap:anywhere;margin-top:.15rem}
.chips{display:flex;gap:.25rem;flex-wrap:wrap;justify-content:flex-end}
.chip{font-size:.68rem;padding:.05rem .35rem;border:1px solid var(--line);border-radius:.3rem;color:var(--dim);white-space:nowrap}
.chip.relay{border-style:dashed}
.chip.done{text-decoration:line-through;opacity:.6}
.empty{color:var(--dim);font-size:.85rem;margin:.2rem 0}
footer{margin-top:2rem;font-size:.78rem;color:var(--dim)}
a{color:inherit}
</style></head>
<body>
<header><h1>${escapeHtml(dayHeadline(input.day))}</h1>
<a href="/plugins/clawbot/timeline?date=${input.day}&format=md">日报 .md</a></header>
${dayNav(input.days, input.day)}
${section("做了", groups.did, "这一天没有动手的命令。")}
${section("失败", groups.failed, "没有失败。")}
${section("值得注意", groups.notable, "没有需要再看的。")}
${section("只是看了看", groups.read, "没有。")}
<footer>
${groups.read.length === 0 ? "" : `另有 ${groups.read.length} 次查看。`}
${input.skipped === 0 ? "" : `${input.skipped} 行读不出来（半行或格式变了），已跳过。`}
账本留 ${LEDGER_RETENTION_DAYS} 天。
</footer>
</body></html>`;
}

/** The day as markdown — the file D33 leaves behind. */
export function renderReport(input: {
  readonly day: string;
  readonly entries: readonly LedgerEntry[];
  readonly skipped: number;
  readonly generatedAt: number;
}): string {
  const groups = groupDay(input.entries);
  const lines: string[] = [`# ${input.day} · 微信 → DSH`, ""];
  lines.push(`- 做了 ${groups.did.length} 件`);
  if (groups.failed.length > 0) lines.push(`- 失败 ${groups.failed.length} 件`);
  if (groups.notable.length > 0) lines.push(`- 值得注意 ${groups.notable.length} 条`);
  if (groups.read.length > 0) lines.push(`- 查看 ${groups.read.length} 次`);
  if (groups.read.length === 0 && groups.failed.length === 0 && groups.notable.length === 0) lines.push("");
  const block = (title: string, entries: LedgerEntry[]): void => {
    if (entries.length === 0) return;
    lines.push("", `## ${title}`, "");
    for (const entry of entries) {
      const undo = entry.undo === null || entry.undo === undefined ? "" : " · 可撤销";
      const mode = entry.mode === "relay" ? " · 接管中" : "";
      lines.push(`- ${clockOf(entry.ts)} \`#${entry.command}\` ${entry.summary}${mode}${undo}`);
    }
  };
  block("做了", groups.did);
  block("失败", groups.failed);
  block("值得注意", groups.notable);
  if (input.skipped > 0) lines.push("", `（${input.skipped} 行读不出来，已跳过）`);
  lines.push("", `生成于 ${new Date(input.generatedAt).toISOString()}`);
  return `${lines.join("\n")}\n`;
}

/** Write the day's report next to the ledger, only when the content changed. */
export function writeReport(dir: string, day: string, markdown: string): string {
  const file = path.join(dir, `${day}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === markdown) return file;
    fs.writeFileSync(file, markdown, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn(`timeline: could not write ${file}: ${String(err).slice(0, 160)}`);
  }
  return file;
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Register `/plugins/clawbot/timeline`.
 *
 * Loopback + Host only (D32): the page is a record of what this machine did,
 * not a public page. It renders the day's report on the way out (D33), so the
 * file exists exactly for the days someone looked at.
 */
export function registerTimelineRoute(
  ctx: Context,
  deps: { ledger: CommandLedger; reportsDir: string; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  ctx.inject(["webServer"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;
    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: "/plugins/clawbot/timeline",
          handler(req: IncomingMessage, res: ServerResponse) {
            if (!localRequest(req)) {
              send(res, 403, "text/plain; charset=utf-8", "只给本机看。");
              return;
            }
            const url = new URL(req.url ?? "/", "http://localhost");
            const wanted = url.searchParams.get("date") ?? "";
            const today = dayKey(now());
            // An unknown date is not an error: you land on today.
            const day = parseDayKey(wanted) === null ? today : wanted;
            const { entries, skipped } = deps.ledger.readDay(day);
            const days = deps.ledger.days(14).includes(day) ? deps.ledger.days(14) : [day, ...deps.ledger.days(13)];
            const markdown = renderReport({ day, entries, skipped, generatedAt: now() });
            writeReport(deps.reportsDir, day, markdown);
            if (url.searchParams.get("format") === "md") {
              send(res, 200, "text/markdown; charset=utf-8", markdown);
              return;
            }
            send(res, 200, "text/html; charset=utf-8", renderTimeline({ day, days, entries, skipped, now: now() }));
          },
        }),
      "clawbot: timeline route",
    );
  });
}
