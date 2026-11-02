#!/usr/bin/env node
/**
 * Offline checks for the command layer (`src/commands.ts`).
 *
 * The parser is the part that decides whether a message is a command at all, so
 * it is checked against the real inputs a phone produces: trailing punctuation,
 * stray spaces, a command name mentioned mid-sentence, and the `>` escape.
 * Nothing here needs WeChat, a model, or the network — it runs against `lib/`.
 *
 *   node test/commands.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const { normalizeCommandText, routeInboundCommand, stripEscape, unknownCommandReply, helpText, runCommand } = await import(
  join(ROOT, "lib/commands.js")
);
const { ModeStore } = await import(join(ROOT, "lib/modes.js"));
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");

let pass = 0;
const failures = [];
/** Record one check. */
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}
/** Assert the router's verdict for one input. */
function expectKind(input, kind, extra = {}) {
  const routed = routeInboundCommand(input);
  const ok = routed.kind === kind && Object.entries(extra).every(([key, value]) => routed[key] === value);
  check(`route ${JSON.stringify(input)} -> ${kind}`, ok, `got ${JSON.stringify(routed)}`);
}

// Trailing punctuation a phone keyboard adds must not defeat a command.
expectKind("#帮助", "command", { name: "帮助" });
expectKind("#帮助。", "command", { name: "帮助" });
expectKind("#任务状态！", "command", { name: "任务状态" });
expectKind("  #当前模式  ", "command", { name: "当前模式" });

// Arguments survive, and the name/argument split is by whitespace.
expectKind("#任务状态 2", "command", { name: "任务状态", arg: "2" });
expectKind("#任务状态  12 ", "command", { name: "任务状态", arg: "12" });

// Unknown names and a bare marker answer with help, never reach the agent.
expectKind("#切换", "unknown");
expectKind("#任务状态3", "unknown");
expectKind("# 帮助", "unknown");

// Only a message that IS a command counts: a mention mid-sentence is ordinary text.
expectKind("帮我看看 #任务状态 是什么", "none");
expectKind("普通消息", "none");
expectKind("", "none");
check("null text routes nowhere", routeInboundCommand(null).kind === "none");

// `>` escapes a literal command name for the agent.
expectKind("> #任务状态", "escape", { text: "#任务状态" });
expectKind(">帮助", "escape", { text: "帮助" });
check("stripEscape removes the marker", stripEscape("> 你好") === "你好" && stripEscape(">你好") === "你好");
check("stripEscape leaves ordinary text alone", stripEscape("你好") === "你好");

// Normalisation is shared by the parser and the tests above.
check("normalize drops trailing punctuation", normalizeCommandText("#帮助。") === "#帮助");
check("normalize keeps inner spaces", normalizeCommandText("  a  b  ") === "a  b");

// The user-facing copy names every implemented command.
const help = helpText();
for (const name of ["#任务状态", "#当前模式", "#帮助"]) {
  check(`help lists ${name}`, help.includes(name));
}
check("unknown reply names the command it did not find", unknownCommandReply("#切换").includes("#切换"));

// The agent's own prompt has to know these exist: without it, "接管那个会话"
// gets hallucinated instead of answered with the command that can do it.
const { buildWechatSystemPrompt } = await import(join(ROOT, "lib/prompt.js"));
const guidance = buildWechatSystemPrompt(false);
for (const name of ["#任务状态", "#接管 N", "#交还", "#入库"]) {
  check(`the agent prompt names ${name}`, guidance.includes(name));
}
check("the prompt says command messages never reach the agent", guidance.includes("到不了你这里"));

// ---------------------------------------------------------------- activity ordering

// A fake controller: the web sidebar's summaries, already activity-ordered.
const CONTROLLER_ITEMS = [
  { sessionId: "wechat-main", updatedAt: 9_000, running: false, blank: false, cwd: "/tmp/w" },
  { sessionId: "s-old-but-active", updatedAt: 8_000, running: true, blank: false, cwd: "/tmp/g", projections: { values: { title: "打通微信和DSH" } } },
  { sessionId: "s-newer-created", updatedAt: 3_000, running: false, blank: false, cwd: "/tmp/g", projections: { values: { title: "创建更晚但早就不用了" } } },
  { sessionId: "s-blank", updatedAt: 7_500, running: false, blank: true, cwd: "/tmp/g" },
  { sessionId: "s-subagent", updatedAt: 6_000, running: false, blank: false, origin: "subagent", projections: { values: { title: "子代理" } } },
];
const controllerCtx = {
  agents: { list: () => [] },
  get: (name) => (name === "sessionController" ? { resolveAgent: async () => ({}), list: async () => ({ items: CONTROLLER_ITEMS }) } : undefined),
};
const { renderStatus } = await import(join(ROOT, "lib/commands.js"));
const status = await renderStatus({ ctx: controllerCtx, sessionId: "wechat-main" });
check("the running conversation comes first", /1\. 打通微信和DSH/u.test(status), status);
check("a newer-but-idle conversation is ordered by activity, not creation", status.indexOf("创建更晚") > status.indexOf("打通微信和DSH"), status);
check("the WeChat session itself is never listed", !status.includes("wechat-main"));
check("blank sessions are hidden", !status.includes("s-blank"));
check("subagent sessions are hidden", !status.includes("子代理"), status);
check("the list counts what it shows", status.includes("共 2 个会话"), status);

// Relative stamps: what makes "used just now" visible on a phone.
const { relativeStamp } = await import(join(ROOT, "lib/commands.js"));
const NOW = new Date("2026-11-02T22:30:00").getTime();
check("just now", relativeStamp(NOW - 5_000, NOW) === "刚刚");
check("minutes", relativeStamp(NOW - 7 * 60_000, NOW) === "7 分钟前");
check("today", relativeStamp(new Date("2026-11-02T09:05:00").getTime(), NOW) === "今天 09:05");
check("yesterday", relativeStamp(new Date("2026-11-01T21:04:00").getTime(), NOW) === "昨天 21:04");
check("older years carry the year", relativeStamp(new Date("2025-12-31T08:00:00").getTime(), NOW).startsWith("2025-12-31"));
check("an unknown time is silent", relativeStamp(0, NOW) === "");

// ---------------------------------------------------------------- handlers (D29 notes)

// A fake host: two sessions, titles included. Only what `listDshSessions` reads.
const SESSIONS = [
  { id: "session-alpha", title: "重构导入流程", cwd: "/tmp/alpha", createdAt: 1000, running: true },
  { id: "session-beta", title: "写周报", cwd: "/tmp/beta", createdAt: 900, running: false },
];
const fakeCtx = {
  agents: { list: () => [] },
  get: (name) =>
    name === "sessionQuery"
      ? {
          listSessions: async () =>
            SESSIONS.map((s) => ({ header: { id: s.id, createdAt: s.createdAt, cwd: s.cwd }, live: true, persisted: true })),
          readTitleSnapshots: async () => SESSIONS.map((s) => ({ status: "fulfilled", value: { title: { title: s.title } } })),
        }
      : undefined,
};

const DIR = mkdtempSync(join(tmpdir(), "clawbot-commands-"));
const store = new ModeStore(join(DIR, "modes.json"), { now: () => 1000 });
const notes = [];
let clock = 1_000_000;
const deps = (extra = {}) => ({
  ctx: fakeCtx,
  sessionId: "wechat-main",
  peer: "wxid_me",
  modes: store,
  now: () => clock,
  note: (text) => notes.push(text),
  ...extra,
});
const run = async (text, extra = {}) => runCommand(routeInboundCommand(text), deps(extra));

// Read-only commands leave no trace in the agent's context.
notes.length = 0;
await run("#帮助");
await run("#任务状态");
await run("#当前模式");
check("read-only commands are not noted", notes.length === 0, notes.join(" | "));

// #接管 binds, numbers like #任务状态, and tells the agent where it went.
notes.length = 0;
const took = await run("#接管 1");
check("#接管 names the conversation", took.includes("重构导入流程"), took);
check("#接管 reports the remaining window", took.includes("还剩"), took);
check("#接管 binds the peer", store.lookup("wxid_me").binding?.sessionId === "session-alpha");
check("#接管 notes one line", notes.length === 1 && notes[0].includes("#接管 1"), notes.join(" | "));
check("the note says the agent will not see those messages", notes[0].includes("看不到"));

// The mode report follows the binding.
check("#当前模式 shows the takeover", (await run("#当前模式")).includes("接管中"));

// A number that is not in the list changes nothing and notes nothing.
notes.length = 0;
const missing = await run("#接管 99");
check("#接管 99 is refused", missing.includes("没有第 99 个"), missing);
check("#接管 99 notes nothing", notes.length === 0);

// #交还 drops the binding and says so, once.
notes.length = 0;
const handed = await run("#交还");
check("#交还 names what it released", handed.includes("重构导入流程"), handed);
check("#交还 clears the binding", store.lookup("wxid_me").binding === null);
check("#交还 notes one line", notes.length === 1 && notes[0].includes("#交还"), notes.join(" | "));
notes.length = 0;
check("#交还 with nothing bound is a no-op", (await run("#交还")).includes("没在接管") && notes.length === 0);

// #入库 notes only when something was actually filed.
const filed = { ok: true, id: "0f3c2b1a-1111", title: "标题", chars: 800, duplicate: false, short: false, status: "pending", url: "u" };
notes.length = 0;
const captured = await run("#入库 https://mp.weixin.qq.com/s/abc", { capture: async () => filed, captureReady: true });
check("#入库 files the link", captured.includes("已进收件箱"), captured);
check("#入库 notes the capture id", notes.length === 1 && notes[0].includes("capture 0f3c2b"), notes.join(" | "));
// A pasted title or a trailing comment must not stop the URL from being found.
let sawUrl;
const withTitle = await run("#入库 标题在前 https://mp.weixin.qq.com/s/Pasted 后面还跟了一句话", {
  capture: async (u) => { sawUrl = u; return filed; },
  captureReady: true,
});
check("#入库 finds the URL inside the argument", sawUrl === "https://mp.weixin.qq.com/s/Pasted", String(sawUrl));
check("#入库 still files it", withTitle.includes("已进收件箱"), withTitle);

notes.length = 0;
await run("#入库 https://example.com/x", { capture: async () => ({ ...filed, ok: false, kind: "fetch", message: "抓不到正文" }), captureReady: true });
check("a failed capture is not noted", notes.length === 0);
notes.length = 0;
const unready = await run("#入库 https://example.com/x", { capture: async () => filed, captureReady: false });
check("#入库 without a token explains the config", unready.includes("capture"), unready);
check("#入库 without a token notes nothing", notes.length === 0);
rmSync(DIR, { recursive: true, force: true });

console.log(`commands: ${pass} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
