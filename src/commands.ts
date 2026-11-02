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

import { captureLedgerDraft, captureReceipt, firstUrl, type CaptureResult } from "./capture.js";
import {
  activityOf,
  cancelDshSession,
  createDshSession,
  listDshSessions,
  readDshSession,
  readModelCatalog,
  selectDshModel,
  type DshSessionRow,
  type ModelCatalogLike,
} from "./dsh-sessions.js";
import type { LedgerDraft } from "./ledger.js";
import { describeBinding, remainingText, shortSessionId, type ModeStore } from "./modes.js";
import type { StopConfirms } from "./stop.js";

/** Trailing punctuation that a phone keyboard adds and a command must ignore. */
const TRAILING_PUNCTUATION = /[\s。！？!?.,，、；;：:]+$/u;

/** How many finished sessions the overview lists. */
const RECENT_LIMIT = 5;

/** How many models `#模型` prints before it just counts the rest. */
const MODEL_LIMIT = 20;

/** Commands that change something. Read-only ones never get a line in the agent's context (D29). */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set(["接管", "交还", "入库", "新会话", "模型", "停一下"]);

/** One entry of the help table, in the order it is printed. */
const HELP: ReadonlyArray<readonly [name: string, summary: string]> = [
  ["#任务状态", "在跑的会话与最近活跃的"],
  ["#任务状态 N", "展开第 N 个"],
  ["#接管 N", "让第 N 个会话临时变成微信的前端"],
  ["#交还", "结束接管，回到专属 agent"],
  ["#新会话", "新建一个会话并直接接管"],
  ["#入库 <链接>", "把一条链接存进工作台收件箱"],
  ["#停一下", "打断当前回合（接管中会先问一句）"],
  ["#允许", "批准挂着的权限请求"],
  ["#拒绝", "拒绝挂着的权限请求"],
  ["#模型", "列出可用模型"],
  ["#模型 N", "把当前会话切到第 N 个模型"],
  ["#当前模式", "我现在的模式、会话与工作区"],
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
  /**
   * Record a state-changing command in the agent's own session (D29).
   *
   * Read-only commands are never noted: they leave nothing behind, and a line
   * per status check would just be noise in the context.
   */
  readonly note?: (text: string) => void;
  /** File every command in the ledger (D28); a missing ledger is not an error. */
  readonly record?: (draft: LedgerDraft) => void;
  /** The relay confirmation window `#停一下` opens (D14). */
  readonly stop?: StopConfirms;
  /** Answer a pending approval from a command (D12). */
  readonly approve?: (decision: "yes" | "no") => "answered" | "question" | "none";
  /** Drop a mirror the relay still owes for a conversation that lost its binding. */
  readonly forgetMirror?: (sessionId: string) => void;
}

/** File one command, if a ledger is wired up (D28). */
function record(deps: CommandDeps, draft: LedgerDraft): void {
  try {
    deps.record?.(draft);
  } catch {
    // The reply matters more than the record: a full disk must not eat the answer.
  }
}

/** `HH:MM`, for the one-line command record (D29). */
function clockText(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
      record(deps, { command: "帮助", result: "ok", summary: "看了命令清单" });
      return helpText();
    case "当前模式":
      record(deps, { command: "当前模式", result: "ok", summary: "看了当前模式" });
      return modeText(deps);
    case "任务状态":
      record(deps, {
        command: "任务状态",
        args: routed.arg === "" ? {} : { index: routed.arg },
        result: "ok",
        summary: routed.arg === "" ? "看了会话列表" : `看了第 ${routed.arg} 个`,
      });
      return renderStatus(deps, routed.arg);
    case "接管":
      return takeOver(deps, routed.arg);
    case "交还":
      return handBack(deps);
    case "入库":
      return fileLink(deps, routed.arg);
    case "停一下":
      return stopCommand(deps);
    case "新会话":
      return newSession(deps);
    case "模型":
      return modelCommand(deps, routed.arg);
    case "允许":
      return answerApproval(deps, "yes");
    case "拒绝":
      return answerApproval(deps, "no");
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
  // Rebinding ends whatever the previous conversation was owed: an answer still
  // in flight there belongs to a phone that has moved on.
  const previous = deps.modes.lookup(deps.peer).binding;
  if (previous !== null && previous.sessionId !== row.id) deps.forgetMirror?.(previous.sessionId);
  const binding = deps.modes.bind(deps.peer, { sessionId: row.id, title });
  // >>> local: D29 命令注入
  // 接管之后微信的消息不再进这个会话，所以它必须知道"我去哪了"，
  // 否则 #交还 回来时会凭空接话。
  deps.note?.(`[命令] ${clockText((deps.now ?? Date.now)())} #接管 ${index} → 《${title}》接管中；此后的微信消息进了那个会话，我这里看不到。`);
  // <<< local
  record(deps, {
    command: "接管",
    args: { index, sessionId: row.id },
    result: "ok",
    summary: `接管了《${title}》`,
    undo: { kind: "relay-bind", sessionId: row.id },
  });
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
  if (dropped === null) {
    record(deps, { command: "交还", result: "noop", summary: "本来就没在接管" });
    return "现在没在接管，消息都给专属 agent。";
  }
  deps.forgetMirror?.(dropped.sessionId);
  const title = dropped.title.trim() === "" ? shortSessionId(dropped.sessionId) : dropped.title;
  deps.note?.(`[命令] ${clockText((deps.now ?? Date.now)())} #交还 → 《${title}》已结束接管，消息回到这里。`);
  record(deps, {
    command: "交还",
    args: { sessionId: dropped.sessionId },
    result: "ok",
    summary: `交还了《${title}》`,
    // Undoing a hand-back means taking that conversation over again, so the
    // record carries what it was bound to.
    undo: { kind: "relay-release", previous: { sessionId: dropped.sessionId, title } },
  });
  return `已交还《${title}》，回到专属 agent。`;
}

/** `#入库 <url>` — the command form of the capture fast path (D21). */
async function fileLink(deps: CommandDeps, arg: string): Promise<string> {
  if (deps.capture === undefined || deps.captureReady !== true) {
    return "采集没配置好：设置里打开 captureEnabled，并填上工作台的 capture token。";
  }
  if (arg === "") return "用法：#入库 <链接>（整条链接，http/https 开头）";
  // The argument may have been pasted with a title in front of it, or a sentence
  // after it — take the first URL rather than insisting the whole thing be one.
  const url = firstUrl(arg) ?? arg;
  if (!/^https?:\/\//u.test(url)) return "这不像链接。用法：#入库 https://…";
  const result = await deps.capture(url);
  if (result.ok) {
    const title = result.title?.trim() || "(没有标题)";
    deps.note?.(
      `[命令] ${clockText((deps.now ?? Date.now)())} #入库 → 已进收件箱《${title}》（capture ${result.id.slice(0, 6).replace(/-/gu, "")}${result.duplicate ? "，本来就有" : ""}）`,
    );
  }
  // Only a pending capture can be taken back (D30); the workbench answers 409 for
  // one that was already accepted, and the undo says so.
  record(deps, captureLedgerDraft(result, url, "入库"));
  return captureReceipt(result);
}

/**
 * `#停一下` — stop the running turn (D14).
 *
 * In relay mode the turn belongs to a conversation the owner may be watching on
 * the desktop, so this only *asks*; the "停" that follows does the work. In
 * agent mode the turn is the one this chat just started and there is nothing to
 * protect.
 */
function stopCommand(deps: CommandDeps): string {
  const now = (deps.now ?? Date.now)();
  const lookup = deps.modes === undefined || deps.peer === undefined
    ? { binding: null }
    : deps.modes.lookup(deps.peer);
  if (lookup.binding !== null) {
    if (deps.stop === undefined) return "接管中停回合要先确认，但这里没有确认存储。";
    const title = lookup.binding.title.trim() === "" ? shortSessionId(lookup.binding.sessionId) : lookup.binding.title;
    deps.stop.request(deps.peer!, { sessionId: lookup.binding.sessionId, title }, now);
    record(deps, {
      command: "停一下",
      args: { sessionId: lookup.binding.sessionId },
      result: "noop",
      summary: `问了一句要不要停《${title}》`,
    });
    return `接管中：《${title}》。真的要停？回「停」才停，发别的就当我没问。`;
  }
  const cancelled = cancelDshSession(deps.ctx, deps.sessionId);
  if (!cancelled.ok) {
    record(deps, { command: "停一下", result: "failed", summary: cancelled.message });
    return `停不了：${cancelled.message}`;
  }
  record(deps, { command: "停一下", result: "ok", summary: "停了当前回合" });
  return "已停。下一条消息重新开始。";
}

/** `#新会话` — create a conversation and take it over in one step (Q1/D10). */
async function newSession(deps: CommandDeps): Promise<string> {
  if (deps.modes === undefined || deps.peer === undefined) return "接管功能没接上（缺少模式存储）。";
  const created = await createDshSession(deps.ctx, deps.cwd);
  if (!created.ok) {
    record(deps, { command: "新会话", result: "failed", summary: created.message });
    return `新建会话失败：${created.message}`;
  }
  // Title is unknown until the first message names it; relay falls back to the id.
  const previous = deps.modes.lookup(deps.peer).binding;
  if (previous !== null) deps.forgetMirror?.(previous.sessionId);
  deps.modes.bind(deps.peer, { sessionId: created.sessionId, title: "" });
  deps.note?.(
    `[命令] ${clockText((deps.now ?? Date.now)())} #新会话 → 新建并接管 ${created.sessionId}；此后的微信消息进了那个会话，我这里看不到。`,
  );
  record(deps, {
    command: "新会话",
    args: { sessionId: created.sessionId },
    result: "ok",
    summary: `新建并接管 ${shortSessionId(created.sessionId)}`,
    // A conversation that did not exist before has nothing to go back to.
    undo: null,
  });
  const where = deps.cwd === undefined ? "宿主默认（设置里填 cwd 才会变）" : shortPath(deps.cwd);
  return [
    "已新建会话并接管。",
    `id: ${created.sessionId}`,
    `工作区：${where}`,
    "",
    "发消息直接进这个会话；「#交还」回到专属 agent。",
  ].join("\n");
}

/** One routable model, flattened for a phone-readable index. */
type ModelChoice = { readonly provider: string; readonly providerName: string; readonly model: string; readonly label: string; readonly effort?: string };

/** Flatten the catalogue in the order `#模型 N` numbers it. */
export function modelChoices(catalog: ModelCatalogLike): ModelChoice[] {
  return catalog.groups.flatMap((group) =>
    group.models.map((model) => ({
      provider: group.id,
      providerName: group.name ?? group.id,
      model: model.id,
      label: model.name ?? model.id,
      ...(model.reasoning?.defaultEffort === undefined ? {} : { effort: model.reasoning.defaultEffort }),
    })),
  );
}

/**
 * `#模型` / `#模型 N` — list the routable models, or point this conversation at
 * one of them (Q3: all of them — the catalogue already excludes what is not
 * routable, and a list that hides providers is a list you cannot trust).
 */
async function modelCommand(deps: CommandDeps, arg: string): Promise<string> {
  const catalog = await readModelCatalog(deps.ctx);
  if (catalog === undefined) return "读不到模型清单（这个 DSH 没有 sessionController.modelCatalog）。";
  const choices = modelChoices(catalog);
  if (choices.length === 0) return "宿主没有报出任何可用模型。";

  const lookup = deps.modes === undefined || deps.peer === undefined
    ? { binding: null }
    : deps.modes.lookup(deps.peer);
  const target = lookup.binding?.sessionId ?? deps.sessionId;
  const where = lookup.binding === null
    ? ""
    : `（切的是接管中的《${lookup.binding.title.trim() === "" ? shortSessionId(lookup.binding.sessionId) : lookup.binding.title}》）`;

  if (arg === "") {
    const shown = choices.slice(0, MODEL_LIMIT);
    const lines = [`可用模型 ${choices.length} 个${where}：`];
    let provider = "";
    shown.forEach((choice, i) => {
      if (choice.providerName !== provider) {
        provider = choice.providerName;
        lines.push("", `${provider}`);
      }
      const current = catalog.default?.provider === choice.provider && catalog.default.model === choice.model ? "（默认）" : "";
      lines.push(`  ${i + 1}. ${choice.label}${current}`);
    });
    if (choices.length > shown.length) lines.push("", `（只列了前 ${shown.length} 个）`);
    lines.push("", "#模型 N 切过去。");
    record(deps, { command: "模型", result: "ok", summary: "看了模型清单" });
    return lines.join("\n");
  }

  const index = Number.parseInt(arg, 10);
  if (!Number.isInteger(index) || index < 1 || index > choices.length) {
    return `没有第 ${arg} 个。发「#模型」看清单。`;
  }
  const choice = choices[index - 1]!;
  const selected = await selectDshModel(deps.ctx, target, {
    provider: choice.provider,
    model: choice.model,
    ...(choice.effort === undefined ? {} : { reasoningEffort: choice.effort }),
  });
  if (!selected.ok) {
    record(deps, { command: "模型", args: { index }, result: "failed", summary: selected.message });
    return `切换失败：${selected.message}`;
  }
  record(deps, {
    command: "模型",
    args: { index, provider: choice.provider, model: choice.model },
    result: "ok",
    summary: `切到 ${choice.providerName} / ${choice.label}`,
  });
  const effort = choice.effort === undefined ? "" : ` · 推理 ${choice.effort}`;
  return `已切到 ${choice.providerName} / ${choice.label}${effort}${where}`;
}

/**
 * `#允许` / `#拒绝` — the only way to answer a pending approval (D12).
 *
 * The approval path prints its own "已批准。/已拒绝。" receipt, so a successful
 * answer returns no text here: two lines for one action is how a chat starts
 * feeling like a machine.
 */
function answerApproval(deps: CommandDeps, decision: "yes" | "no"): string {
  const name = decision === "yes" ? "允许" : "拒绝";
  const outcome = deps.approve?.(decision) ?? "none";
  if (outcome === "answered") {
    record(deps, { command: name, result: "ok", summary: decision === "yes" ? "批准了权限请求" : "拒绝了权限请求" });
    return "";
  }
  if (outcome === "question") {
    record(deps, { command: name, result: "noop", summary: "当时等的是提问，不是审批" });
    return "现在等的是提问，不是权限请求 —— 直接回复内容就行。";
  }
  record(deps, { command: name, result: "noop", summary: "没有待批的权限请求" });
  return "现在没有待批的权限请求。";
}

/** `#任务状态` / `#任务状态 N`. */
export async function renderStatus(deps: CommandDeps, arg = ""): Promise<string> {
  const listed = await listDshSessions(deps.ctx).catch(() => undefined);
  if (listed === undefined) return "读不到会话列表（宿主没有 sessionQuery 服务）。";

  const rows = listed.rows.filter((row) => row.id !== deps.sessionId && !row.blank && !row.subagent);
  const running = rows.filter((row) => row.running).sort((a, b) => activityOf(b) - activityOf(a));
  const recent = rows
    .filter((row) => !row.running)
    .sort((a, b) => activityOf(b) - activityOf(a))
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

  lines.push("", `最近活跃 ${recent.length} 个`);
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
  const rows = listed.rows.filter((row) => row.id !== deps.sessionId && !row.blank && !row.subagent);
  const running = rows.filter((row) => row.running).sort((a, b) => activityOf(b) - activityOf(a));
  const recent = rows
    .filter((row) => !row.running)
    .sort((a, b) => activityOf(b) - activityOf(a))
    .slice(0, RECENT_LIMIT);
  return [...running, ...recent];
}

/** The title a session is listed under; the id prefix when it has none. */
function titleOf(row: DshSessionRow): string {
  const title = row.title?.trim();
  return title === undefined || title === "" ? row.id.slice(0, 8) : title;
}

/**
 * How long ago, in the words a phone expects.
 *
 * "刚刚" and "3 分钟前" are what make an activity-ordered list legible: a
 * bare `17:04` reads as today when it may be five days old, which is exactly
 * how a conversation that is being used right now looks absent.
 */
export function relativeStamp(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const delta = now - ms;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  const then = new Date(ms);
  const today = new Date(now);
  const stamp = clock(ms);
  if (then.toDateString() === today.toDateString()) return `今天 ${stamp}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return `昨天 ${stamp}`;
  const month = String(then.getMonth() + 1).padStart(2, "0");
  const day = String(then.getDate()).padStart(2, "0");
  const year = then.getFullYear() === today.getFullYear() ? "" : `${then.getFullYear()}-`;
  return `${year}${month}-${day} ${stamp}`;
}

/** One line for the overview: title, workspace, and when it was last used. */
function describe(row: DshSessionRow): string {
  const where = row.cwd === undefined ? "" : ` · ${path.basename(row.cwd)}`;
  const when = relativeStamp(activityOf(row), Date.now());
  const stamp = when === "" ? "" : ` · ${when}`;
  const live = row.running ? "（在跑）" : "";
  return `${titleOf(row)}${where}${stamp}${live}`;
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
