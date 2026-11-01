/**
 * Deterministic command layer.
 *
 * A message that is **exactly** a command is answered here, before it can reach
 * the agent and before a pending approval can consume it (a read-only command
 * must never be eaten as an approval answer). Everything else — including a `#`
 * that names no command — takes the normal path, so the agent never sees a
 * message we meant as a command.
 *
 * Conventions (D7–D9 in `docs/wechat-bridge-plan.md`):
 * - `#` prefix, whole-message match; trailing punctuation is ignored.
 * - Unknown `#…` answers with the command list instead of going to the agent.
 * - `> ` escapes: the marker is stripped and the rest goes to the agent verbatim,
 *   which is how a literal command name is still sayable.
 */
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";

import { captureReceipt, type CaptureResult } from "./capture.js";
import { listDshSessions, readDshSession, type DshSessionRow } from "./dsh-sessions.js";
import { describeBinding, remainingText, type ModeStore } from "./modes.js";

/** Trailing punctuation that a phone keyboard adds and a command must ignore. */
const TRAILING_PUNCTUATION = /[\s。！？!?.,，、；;：:]+$/u;

/** How many finished sessions the overview lists. */
const RECENT_LIMIT = 5;

/** One entry of the help table, in the order it is printed. */
const HELP: ReadonlyArray<readonly [name: string, summary: string]> = [
  ["#任务状态", "在跑的会话与最近结束的"],
  ["#任务状态 N", "展开第 N 个"],
  ["#当前模式", "我现在的模式、会话与工作区"],
  ["#接管 N", "让第 N 个会话临时变成微信的前端"],
  ["#交还", "结束接管，回到专属 agent"],
  ["#入库 <链接>", "把一条链接存进工作台收件箱"],
  ["#帮助", "这张清单"],
];

/** What a piece of inbound text turned into. */
export type Routed =
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly raw: string }
  | { readonly kind: "escape"; readonly text: string }
  | { readonly kind: "command"; readonly name: string; readonly arg: string };

/** Trim and drop the punctuation a phone keyboard appends. */
export function normalizeCommandText(raw: string): string {
  return raw.trim().replace(TRAILING_PUNCTUATION, "").trim();
}

/**
 * Classify one inbound text as a command, an escape, or ordinary text.
 *
 * @param plainText - the message text without quote context, or null when the
 *   message carries no text at all.
 */
export function routeInboundCommand(plainText: string | null): Routed {
  if (plainText === null) return { kind: "none" };
  const trimmed = plainText.trimStart();
  if (trimmed.startsWith(">")) return { kind: "escape", text: trimmed.replace(/^>\s?/u, "") };
  if (!trimmed.startsWith("#")) return { kind: "none" };

  const text = normalizeCommandText(trimmed);
  const match = /^#(\S+)(?:\s+(.*))?$/u.exec(text);
  if (match === null) return { kind: "unknown", raw: text };

  const name = match[1] ?? "";
  const arg = (match[2] ?? "").trim();
  const known = HELP.some(([candidate]) => candidate.slice(1).split(/\s+/u)[0] === name);
  if (!known) return { kind: "unknown", raw: text };
  return { kind: "command", name, arg };
}

/** Strip the escape marker from an ordinary message body. */
export function stripEscape(body: string): string {
  return body.replace(/^\s*>\s?/u, "");
}

/** The reply for a `#` that names nothing. */
export function unknownCommandReply(raw: string): string {
  const name = raw.replace(/^#/u, "").split(/\s+/u)[0] ?? "";
  return `没有 \`#${name}\` 这条命令。\n\n${helpText()}`;
}

/** The command list. */
export function helpText(): string {
  const lines = HELP.map(([name, summary]) => `${name} — ${summary}`);
  return [
    "命令（整条消息正好是命令才生效）：",
    ...lines,
    "",
    "直接发一条链接（或微信的链接卡片）也会进收件箱。",
    "想对 agent 说字面的 #xxx，前面加 > ：",
    "> #任务状态",
  ].join("\n");
}

/** What the handlers need beyond the message itself. */
export interface CommandDeps {
  /** Root context, for the session services the overview reads. */
  readonly ctx: Context;
  /** The WeChat session's id (shown by `#当前模式`, excluded from lists). */
  readonly sessionId: string;
  /** Working directory the agent uses, when configured. */
  readonly cwd?: string;
  /** File one URL into the workbench inbox. */
  readonly capture?: (url: string) => Promise<CaptureResult>;
  /** Whether the capture path has a token to work with. */
  readonly captureReady?: boolean;
  /** Workbench address, shown by `#当前模式`. */
  readonly captureBaseUrl?: string;
  /** Per-peer mode (relay). */
  readonly modes?: ModeStore;
  /** The peer this message came from: mode is per peer. */
  readonly peer?: string;
  /** Clock override for tests. */
  readonly now?: () => number;
}

/** `#当前模式` — what this bot currently is. */
export function modeText(deps: CommandDeps): string {
  const cwd = deps.cwd ?? process.cwd();
  const now = (deps.now ?? Date.now)();
  const lookup = deps.modes === undefined || deps.peer === undefined
    ? { binding: null, expired: null }
    : deps.modes.lookup(deps.peer);
  const mode = lookup.binding === null
    ? "模式：专属 agent"
    : `模式：接管中 ${describeBinding(lookup.binding, now)}`;
  const capture = deps.captureReady === true
    ? `采集：开（${deps.captureBaseUrl ?? "工作台"}，链接直接发给我）`
    : "采集：关（设置里打开 captureEnabled 并填 token）";
  const lines = [mode, `会话：${deps.sessionId}`, `工作区：${shortPath(cwd)}`, "模型：跟随会话自己的选择", capture];
  if (lookup.expired !== null) {
    const title = lookup.expired.title.trim() === "" ? lookup.expired.sessionId.slice(0, 8) : lookup.expired.title;
    lines.push("", `（之前的接管《${title}》因久无消息已自动交还）`);
  }
  return lines.join("\n");
}

/** Run one matched command and return the reply text. */
export async function runCommand(routed: Routed, deps: CommandDeps): Promise<string> {
  if (routed.kind !== "command") return "";
  switch (routed.name) {
    case "帮助":
      return helpText();
    case "当前模式":
      return modeText(deps);
    case "任务状态":
      return renderStatus(deps, routed.arg);
    case "接管":
      return takeOver(deps, routed.arg);
    case "交还":
      return handBack(deps);
    case "入库":
      return fileLink(deps, routed.arg);
    default:
      return unknownCommandReply(`#${routed.name}`);
  }
}

/** `#接管 N` — point WeChat at one of the listed conversations (D2/D19). */
async function takeOver(deps: CommandDeps, arg: string): Promise<string> {
  if (deps.modes === undefined || deps.peer === undefined) return "接管功能没接上（缺少模式存储）。";
  const index = Number.parseInt(arg, 10);
  if (!Number.isInteger(index)) return "用法：#接管 N（N 是「#任务状态」里的编号）";
  const numbered = await numberedSessions(deps);
  if (numbered === undefined) return "读不到会话列表（宿主没有 sessionQuery 服务）。";
  if (index < 1 || index > numbered.length) return `没有第 ${index} 个。发「#任务状态」看当前列表。`;
  const row = numbered[index - 1]!;
  const title = titleOf(row);
  const binding = deps.modes.bind(deps.peer, { sessionId: row.id, title });
  return [
    `已接管 ${index}. ${title}`,
    `id: ${row.id}`,
    "",
    "接下来发的消息直接进这个会话；我的回复会以 [标题] 开头。",
    `${remainingText(binding, (deps.now ?? Date.now)())}没消息就自动交还。「#交还」立刻结束。`,
  ].join("\n");
}

/** `#交还` — back to the dedicated agent (D2). */
function handBack(deps: CommandDeps): string {
  if (deps.modes === undefined || deps.peer === undefined) return "接管功能没接上（缺少模式存储）。";
  const dropped = deps.modes.release(deps.peer);
  if (dropped === null) return "现在没在接管，消息都给专属 agent。";
  const title = dropped.title.trim() === "" ? dropped.sessionId.slice(0, 8) : dropped.title;
  return `已交还《${title}》，回到专属 agent。`;
}

/** `#入库 <url>` — the command form of the capture fast path (D21). */
async function fileLink(deps: CommandDeps, arg: string): Promise<string> {
  if (deps.capture === undefined || deps.captureReady !== true) {
    return "采集没配置好：设置里打开 captureEnabled，并填上工作台的 capture token。";
  }
  if (arg === "") return "用法：#入库 <链接>（整条链接，http/https 开头）";
  if (!/^https?:\/\//u.test(arg)) return "这不像链接。用法：#入库 https://…";
  return captureReceipt(await deps.capture(arg));
}

/** `#任务状态` / `#任务状态 N`. */
export async function renderStatus(deps: CommandDeps, arg = ""): Promise<string> {
  const listed = await listDshSessions(deps.ctx).catch(() => undefined);
  if (listed === undefined) return "读不到会话列表（宿主没有 sessionQuery 服务）。";

  const rows = listed.rows.filter((row) => row.id !== deps.sessionId);
  const running = rows.filter((row) => row.running).sort((a, b) => b.createdAt - a.createdAt);
  const recent = rows
    .filter((row) => !row.running)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_LIMIT);
  const numbered = [...running, ...recent];

  if (arg !== "") {
    const index = Number.parseInt(arg, 10);
    if (!Number.isInteger(index) || index < 1 || index > numbered.length) {
      return `没有第 ${arg} 个。发「#任务状态」看当前列表。`;
    }
    return expand(deps, numbered[index - 1]!, index);
  }

  const lines: string[] = [`在跑 ${running.length} 个`];
  if (running.length === 0) lines.push("（没有正在跑的）");
  running.forEach((row, i) => lines.push(`${i + 1}. ${describe(row)}`));

  lines.push("", `最近结束 ${recent.length} 个`);
  if (recent.length === 0) lines.push("（没有）");
  recent.forEach((row, i) => lines.push(`${running.length + i + 1}. ${describe(row)}`));

  lines.push("", `共 ${rows.length} 个会话${listed.degraded === undefined ? "" : "（只看到在内存里的）"}`);
  if (numbered.length > 0) lines.push("", "#任务状态 1 展开第 1 个 · #接管 1 让第 1 个接管微信");
  return lines.join("\n");
}

/** The numbered list `#任务状态` shows and `#接管 N` indexes into (D42: one numbering). */
async function numberedSessions(deps: CommandDeps): Promise<DshSessionRow[] | undefined> {
  const listed = await listDshSessions(deps.ctx).catch(() => undefined);
  if (listed === undefined) return undefined;
  const rows = listed.rows.filter((row) => row.id !== deps.sessionId);
  const running = rows.filter((row) => row.running).sort((a, b) => b.createdAt - a.createdAt);
  const recent = rows
    .filter((row) => !row.running)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_LIMIT);
  return [...running, ...recent];
}

/** The title a session is listed under; the id prefix when it has none. */
function titleOf(row: DshSessionRow): string {
  const title = row.title?.trim();
  return title === undefined || title === "" ? row.id.slice(0, 8) : title;
}

/** One line for the overview: title, workspace, and when it started. */
function describe(row: DshSessionRow): string {
  const where = row.cwd === undefined ? "" : ` · ${path.basename(row.cwd)}`;
  const when = Number.isFinite(row.createdAt) ? ` · 自 ${clock(row.createdAt)}` : "";
  const live = row.running ? "（在跑）" : "";
  return `${titleOf(row)}${where}${when}${live}`;
}

/** `#任务状态 N` — the session's last few messages. */
async function expand(deps: CommandDeps, row: DshSessionRow, index: number): Promise<string> {
  const messages = await readDshSession(deps.ctx, row.id).catch(() => undefined);
  const head = [`${index}. ${describe(row)}`, `id: ${row.id}`];
  if (messages === undefined) return [...head, "", "读不到这个会话的内容。"].join("\n");
  const tail = messages.slice(-5);
  if (tail.length === 0) return [...head, "", "这个会话还没有文字消息。"].join("\n");
  const body = tail.map((m) => `[${clock(m.at)}] ${m.role === "user" ? "用户" : "DSH"}：${truncate(m.text, 160)}`);
  return [...head, "", ...body].join("\n");
}

/** `HH:MM` in local time. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Keep one message short enough to read on a phone. */
function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** `~/workspace` instead of `/Users/someone/workspace`. */
function shortPath(full: string): string {
  const home = process.env.HOME;
  return home !== undefined && full.startsWith(home) ? `~${full.slice(home.length)}` : full;
}
