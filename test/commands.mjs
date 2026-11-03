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
const { renderStatus, resolveWorkspacePath } = await import(join(ROOT, "lib/commands.js"));
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
// ---------------------------------------------------------------- the newer commands (D12/D14/D30, Q1/Q3)

const { StopConfirms } = await import(join(ROOT, "lib/stop.js"));

// A host that can create, cancel and re-model conversations.
const controlCtx = (controller) => ({
  agents: { list: () => [] },
  get: (name) => (name === "sessionController" ? controller : undefined),
});

// #停一下, agent mode: the turn this chat just started, so it stops at once.
let cancelled = null;
const stopAgent = await run("#停一下", {
  ctx: controlCtx({ resolveAgent: async () => ({}), cancel: (req) => { cancelled = req; return { accepted: true }; } }),
});
check("#停一下 cancels the WeChat session's own turn", cancelled?.sessionId === "wechat-main");
check("#停一下 says it stopped", stopAgent.includes("已停"), stopAgent);

// #停一下, relay mode: the turn belongs to someone else's conversation, so it asks.
store.release("wxid_me");
store.bind("wxid_me", { sessionId: "session-alpha", title: "重构导入流程" });
const stops = new StopConfirms();
cancelled = null;
const asked = await run("#停一下", {
  stop: stops,
  ctx: controlCtx({ resolveAgent: async () => ({}), cancel: (req) => { cancelled = req; return { accepted: true }; } }),
});
check("#停一下 during a relay asks first", asked.includes("回「停」才停"), asked);
check("#停一下 during a relay cancels nothing yet", cancelled === null);
check("#停一下 during a relay records the target", stops.pending("wxid_me", 1_000_000)?.sessionId === "session-alpha");
store.release("wxid_me");

// #新会话 creates in the configured workspace and takes it over (Q1).
let createdWith = "unset";
const newSessionReply = await run("#新会话", {
  cwd: "/Users/someone/workspace/global-seo",
  ctx: controlCtx({
    resolveAgent: async () => ({}),
    create: async (request) => { createdWith = request.cwd; return { sessionId: "session-new" }; },
  }),
});
check("#新会话 creates with the configured cwd", createdWith === "/Users/someone/workspace/global-seo", String(createdWith));
check("#新会话 takes the new conversation over", store.lookup("wxid_me").binding?.sessionId === "session-new");
check("#新会话 reports the workspace", newSessionReply.includes("global-seo"), newSessionReply);
check("#新会话 notes that the agent will not see those messages", notes.at(-1)?.includes("看不到"), notes.at(-1));
store.release("wxid_me");

// A host without create must say so, not pretend.
const noCreate = await run("#新会话", { cwd: "/tmp/x", ctx: controlCtx({ resolveAgent: async () => ({}) }) });
check("#新会话 without a controller explains itself", noCreate.includes("不能从外部新建"), noCreate);

// #模型 lists the routable catalogue, numbered, with the deployment default marked (Q3).
let picked = null;
const catalogCtx = controlCtx({
  resolveAgent: async () => ({}),
  modelCatalog: async () => ({
    default: { provider: "deepseek-official", model: "deepseek-v4.1-flash" },
    groups: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          { id: "deepseek-v4.1-flash", name: "V4.1 Flash", reasoning: { defaultEffort: "low" } },
          { id: "deepseek-v4.1-pro", name: "V4.1 Pro" },
        ],
      },
      { id: "siliconflow", name: "硅基流动", models: [{ id: "qwen3", name: "Qwen3" }] },
    ],
  }),
  selectModel: async (request) => { picked = request; return { selected: {} }; },
});
const listed = await run("#模型", { ctx: catalogCtx });
check("#模型 says how many there are", listed.includes("可用模型 3 个"), listed);
check("#模型 groups by provider", listed.includes("DeepSeek") && listed.includes("硅基流动"), listed);
check("#模型 numbers them across groups", / 3\. Qwen3/u.test(listed), listed);
check("#模型 marks the deployment default", listed.includes("V4.1 Flash（默认）"), listed);

picked = null;
const switched = await run("#模型 2", { ctx: catalogCtx });
check("#模型 N selects the numbered model", picked?.model === "deepseek-v4.1-pro", JSON.stringify(picked));
check("#模型 N keeps the provider", picked?.provider === "deepseek-official", JSON.stringify(picked));
check("#模型 N names what it picked", switched.includes("V4.1 Pro"), switched);

picked = null;
const lowEffort = await run("#模型 1", { ctx: catalogCtx });
check("#模型 N carries the model's default reasoning effort", picked?.reasoningEffort === "low", JSON.stringify(picked));
check("#模型 N says the effort", lowEffort.includes("推理 low"), lowEffort);
check("#模型 99 is refused", (await run("#模型 99", { ctx: catalogCtx })).includes("没有第 99 个"));

// While relaying, #模型 switches THAT conversation, not the WeChat one.
store.bind("wxid_me", { sessionId: "session-alpha", title: "重构导入流程" });
picked = null;
const switchingRelay = await run("#模型 2", { ctx: catalogCtx });
check("#模型 during a relay switches the relayed conversation", picked?.sessionId === "session-alpha", JSON.stringify(picked));
check("#模型 during a relay says so", switchingRelay.includes("接管中"), switchingRelay);
store.release("wxid_me");

// A host without the service says so instead of an empty list.
check("#模型 without a catalogue explains itself", (await run("#模型", { ctx: fakeCtx })).includes("读不到模型清单"));

// #允许 / #拒绝 answer the pending approval and let the approval path print its own receipt.
let decisions = [];
const answered = await run("#允许", { approve: (d) => { decisions.push(d); return "answered"; } });
check("#允许 answers yes", decisions.length === 1 && decisions[0] === "yes");
check("#允许 stays silent (the approval path says 已批准)", answered === "");
const refused = await run("#拒绝", { approve: () => "answered" });
check("#拒绝 stays silent too", refused === "");
check("#允许 with nothing pending says so", (await run("#允许", { approve: () => "none" })).includes("没有待批的权限请求"));
check("#允许 while a question waits does not answer it", (await run("#允许", { approve: () => "question" })).includes("不是权限请求"));

// A mirror the relay still owes must not survive the binding it belonged to
// (2026-11-03 00:04: an answer was mirrored after #交还).
{
  const forgotten = [];
  const forget = (sessionId) => forgotten.push(sessionId);
  store.release("wxid_me");
  store.bind("wxid_me", { sessionId: "session-alpha", title: "重构导入流程" });
  await run("#交还", { forgetMirror: forget });
  check("#交还 forgets the mirror owed for that conversation", forgotten.includes("session-alpha"), forgotten.join(","));

  forgotten.length = 0;
  // #接管 1 is 重构导入流程 (session-alpha), so binding to a different one first
  // is what makes "the previous mirror" observable.
  store.bind("wxid_me", { sessionId: "session-beta", title: "写周报" });
  await run("#接管 1", { forgetMirror: forget });
  check("#接管 forgets the previous conversation's mirror", forgotten.includes("session-beta"), forgotten.join(","));
  store.release("wxid_me");

  forgotten.length = 0;
  store.bind("wxid_me", { sessionId: "session-beta", title: "写周报" });
  await run("#新会话", {
    cwd: "/tmp/x",
    forgetMirror: forget,
    ctx: controlCtx({ resolveAgent: async () => ({}), create: async () => ({ sessionId: "session-new" }) }),
  });
  check("#新会话 forgets the previous conversation's mirror", forgotten.includes("session-beta"), forgotten.join(","));
  store.release("wxid_me");
}

// ---------------------------------------------------------------- workspaces (D50)

{
  // #工作区 lists the desktop's workspaces, numbered for #新会话 N.
  const workspaceCtx = {
    agents: { list: () => [] },
    get: (name) =>
      name === "workspaceRegistry"
        ? {
            list: () => [
              { id: "ws-1", title: "global-seo", path: "/Users/someone/workspace/global-seo" },
              { id: "ws-2", title: "wechat-clawbot", path: "/Users/someone/workspace/wechat-clawbot" },
            ],
          }
        : name === "sessionController"
          ? { resolveAgent: async () => ({}) }
          : undefined,
  };
  const listedWorkspaces = await run("#工作区", { ctx: workspaceCtx });
  check("#工作区 numbers the workspaces", /1\. global-seo/u.test(listedWorkspaces) && /2\. wechat-clawbot/u.test(listedWorkspaces), listedWorkspaces);
  check("#工作区 points at #新会话 N", listedWorkspaces.includes("#新会话 N"), listedWorkspaces);

  let createdWith = null;
  const managerCtx = {
    agents: { list: () => [] },
    get: (name) =>
      name === "workspaceRegistry"
        ? { list: () => [{ id: "ws-1", title: "global-seo", path: "/tmp/global-seo" }] }
        : name === "sessionController"
          ? { resolveAgent: async () => ({}), create: async (request) => { createdWith = request; return { sessionId: "session-ws" }; } }
          : undefined,
  };
  store.release("wxid_me");
  const createdReply = await run("#新会话 1", { ctx: managerCtx, cwd: "/tmp/elsewhere" });
  check("#新会话 N creates inside that workspace", createdWith?.workspaceId === "ws-1", JSON.stringify(createdWith));
  check("#新会话 N does not pass a cwd", createdWith?.cwd === undefined, JSON.stringify(createdWith));
  check("#新会话 N takes it over", store.lookup("wxid_me").binding?.sessionId === "session-ws");
  check("#新会话 N names the workspace", createdReply.includes("global-seo"), createdReply);
  check("#新会话 9 is refused", (await run("#新会话 9", { ctx: managerCtx })).includes("没有第 9 个"));
  store.release("wxid_me");

  // A path form, inside the configured roots only.
  const { mkdtempSync: mkTmp, mkdirSync: mkDir, writeFileSync: writeTmp, rmSync: rmTmp } = await import("node:fs");
  const { tmpdir: tmpOs, homedir: homeOs } = await import("node:os");
  const root = mkTmp(join(tmpOs(), "clawbot-ws-"));
  const project = join(root, "project-a");
  mkDir(project);
  writeTmp(join(root, "a-file"), "x");

  createdWith = null;
  const pathReply = await run(`#新会话 ${project}`, {
    ctx: managerCtx,
    workspaceRoots: [root],
  });
  check("#新会话 <路径> passes that directory", createdWith?.cwd === project, JSON.stringify(createdWith));
  check("#新会话 <路径> reports the directory", pathReply.includes("project-a"), pathReply);
  store.release("wxid_me");

  const outside = await run(`#新会话 ${tmpOs()}`, { ctx: managerCtx, workspaceRoots: [root] });
  check("a path outside the roots is refused", outside.includes("只能在这些目录下开"), outside);
  const noRoots = await run(`#新会话 ${project}`, { ctx: managerCtx, workspaceRoots: [] });
  check("no roots means no path form", noRoots.includes("没有配置 workspaceRoots"), noRoots);
  const missing = await run(`#新会话 ${join(root, "does-not-exist")}`, { ctx: managerCtx, workspaceRoots: [root] });
  check("a missing directory is refused", missing.includes("没有这个目录"), missing);

  // The resolver itself: ~ expansion, absolute-only, files vs directories.
  check("a directory inside the root resolves", resolveWorkspacePath(root, [root]).ok === true);
  check("a file is refused", resolveWorkspacePath(join(root, "a-file"), [root]).ok === false);
  check("a relative path is refused", resolveWorkspacePath("relative/dir", [root]).ok === false);
  const outsideRoot = resolveWorkspacePath(tmpOs(), [root]);
  check("another directory is refused", outsideRoot.ok === false && outsideRoot.message.includes("只能在这些目录下开"));
  const tilde = resolveWorkspacePath("~", ["~"]);
  check("~ expands to the home directory", tilde.ok === true && tilde.path === homeOs(), JSON.stringify(tilde));
  rmTmp(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the ledger (D28)

const recorded = [];
const recordInto = (extra = {}) => ({ record: (draft) => recorded.push(draft), ...extra });

recorded.length = 0;
await run("#帮助", recordInto());
check("a read-only command is recorded too", recorded.length === 1 && recorded[0].command === "帮助", JSON.stringify(recorded));
check("a read-only command has no undo", recorded[0].undo === undefined || recorded[0].undo === null);

recorded.length = 0;
await run("#入库 https://mp.weixin.qq.com/s/Ledger", recordInto({ capture: async () => filed, captureReady: true }));
const captureRecord = recorded.find((e) => e.command === "入库");
check("a filed link is recorded with its capture id", captureRecord?.args?.captureId === filed.id, JSON.stringify(recorded));
check("a filed link can be undone", captureRecord?.undo?.kind === "capture" && captureRecord.undo.captureId === filed.id);
check("the record keeps the title for the receipt", captureRecord?.undo?.title === "标题");

recorded.length = 0;
await run("#入库 https://example.com/bad", recordInto({ capture: async () => ({ ok: false, kind: "fetch", message: "抓不到正文", url: "u" }), captureReady: true }));
check("a failed capture is recorded as failed", recorded[0]?.result === "failed", JSON.stringify(recorded));
check("a failed capture has no undo", recorded[0]?.undo === undefined);

recorded.length = 0;
store.bind("wxid_me", { sessionId: "session-alpha", title: "重构导入流程" });
await run("#交还", recordInto());
check("#交还 can be undone by taking it over again", recorded[0]?.undo?.kind === "relay-release" && recorded[0].undo.previous.sessionId === "session-alpha", JSON.stringify(recorded));

recorded.length = 0;
await run("#交还", recordInto());
check("#交还 with nothing bound is recorded as a no-op", recorded[0]?.result === "noop", JSON.stringify(recorded));

rmSync(DIR, { recursive: true, force: true });

console.log(`commands: ${pass} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
