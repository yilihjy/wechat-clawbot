#!/usr/bin/env node
/**
 * Offline checks for relay mode (`src/relay.ts`).
 *
 * The rules that matter are all pure: one WeChat message per turn (not per
 * step), the `[标题]` prefix, the three length buckets of D31, and — most
 * importantly — never mirroring a conversation nobody asked us to relay.
 *
 *   node test/relay.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const {
  RelayService,
  planReply,
  wrapInbound,
  replyPrefix,
  assistantText,
  REPLY_LIMIT,
  REPLY_MAX_PARTS,
  REPLY_FILE_ABOVE,
} = await import(join(ROOT, "lib/relay.js"));

let pass = 0;
const failures = [];
/** Let the fire-and-forget mirror finish before asserting on what was sent. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}
function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- formatting

check("wrapInbound names the source", wrapInbound("帮我看看").startsWith("用户在微信里说："));
check("wrapInbound keeps the text", wrapInbound("帮我看看").endsWith("帮我看看"));
equal("replyPrefix", replyPrefix("重构导入流程"), "[重构导入流程] ");
equal("replyPrefix never prints brackets around nothing", replyPrefix("  "), "[会话] ");

equal("assistantText reads the v4 shape", assistantText({ message: { content: [{ type: "text", text: "答案" }] } }), "答案");
equal("assistantText joins blocks", assistantText({ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }), "ab");
equal("assistantText ignores non-text blocks", assistantText({ message: { content: [{ type: "reasoning", text: "想" }, { type: "text", text: "说" }] } }), "说");
equal("assistantText tolerates a missing body", assistantText(undefined), "");

// ---------------------------------------------------------------- D31 buckets

equal("a short answer is one message", planReply("短").parts, ["短"]);
equal("the limit itself is still one message", planReply("字".repeat(REPLY_LIMIT)).parts.length, 1);
check("just over the limit splits", planReply("字".repeat(REPLY_LIMIT + 1)).parts.length > 1);

const paragraphs = Array.from({ length: 12 }, (_, i) => `第 ${i} 段${"内容".repeat(80)}`).join("\n\n");
const split = planReply(paragraphs);
check("a long answer splits into at most the maximum", split.kind === "parts" && split.parts.length > 1 && split.parts.length <= REPLY_MAX_PARTS, JSON.stringify(split.parts?.length));
check("every split part is non-empty", split.kind === "parts" && split.parts.every((part) => part.trim() !== ""));
check("splitting keeps every character", split.kind === "parts" && split.parts.join("").replace(/\s/gu, "").length === paragraphs.replace(/\s/gu, "").length);

const enormous = "字".repeat(REPLY_FILE_ABOVE + 1);
equal("an oversized answer becomes a file", planReply(enormous), { kind: "file", text: enormous });
check("exactly at the file threshold is still text", planReply("字".repeat(REPLY_FILE_ABOVE)).kind === "parts");
equal("an empty answer is no parts", planReply("   "), { kind: "parts", parts: [] });
check("one enormous paragraph is cut", planReply(`x${"字".repeat(REPLY_LIMIT * 2)}`).parts.length <= REPLY_MAX_PARTS);

// ---------------------------------------------------------------- the service

function harness(options = {}) {
  const sent = [];
  const delivered = [];
  const files = [];
  let clock = 1_000_000;
  const relay = new RelayService({
    sendText: async (to, text) => {
      sent.push({ to, text });
    },
    deliver: async (sessionId, text) => {
      delivered.push({ sessionId, text });
      return { ok: true };
    },
    ...(options.sendFile === false
      ? {}
      : {
          sendFile: async (to, name, text) => {
            files.push({ to, name, text });
          },
        }),
    // Bindings are checked at flush time: a hand-back can happen mid-turn.
    ...(options.bound === undefined ? {} : { isStillBound: options.bound }),
    now: () => clock,
  });
  return { relay, sent, delivered, files, advance: (ms) => { clock += ms; }, now: () => clock, setBound: (fn) => { options.bound = fn; } };
}

const BINDING = { sessionId: "session-alpha", title: "重构导入流程" };

// One turn, two assistant messages -> one WeChat message.
let h = harness();
const result = await h.relay.relay("wxid_me", BINDING, "帮我把导入改一下");
check("delivery succeeded", result.ok === true);
equal("delivered into the bound session", h.delivered[0].sessionId, "session-alpha");
check("delivered text is wrapped", h.delivered[0].text.includes("用户在微信里说："));
check("a mirror is owed", h.relay.isExpecting("session-alpha"));

h.relay.onSessionEvent("session-alpha", { type: "step/start", data: {} });
h.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "改好了。" }] } } });
h.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "另外补了测试。" }] } } });
check("nothing is sent before turn/end", h.sent.length === 0);
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
await flush();
equal("one WeChat message per turn", h.sent.length, 1);
equal("the mirror carries the title prefix", h.sent[0].text, "[重构导入流程] 改好了。\n\n另外补了测试。");
check("the mirror goes to the peer", h.sent[0].to === "wxid_me");
check("the expectation is cleared", !h.relay.isExpecting("session-alpha"));
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
check("a later turn is not mirrored", h.sent.length === 1);

// #交还 while the turn is still running: the answer is not owed any more.
// (2026-11-03 00:04 — the long "404" answer was mirrored after a hand-back.)
{
  let bound = true;
  const h2 = harness({ bound: () => bound });
  await h2.relay.relay("wxid_me", BINDING, "帮我查一下");
  h2.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "查到了。" }] } } });
  bound = false; // the owner sent #交还
  h2.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
  await flush();
  equal("an answer after a hand-back is not mirrored", h2.sent.length, 0);
  check("and the expectation is gone", !h2.relay.isExpecting("session-alpha"));
}

// forget() is what #交还 calls: nothing stays owed for that conversation.
{
  const h3 = harness();
  await h3.relay.relay("wxid_me", BINDING, "在吗");
  h3.relay.forget("session-alpha");
  check("forget drops the expectation", !h3.relay.isExpecting("session-alpha"));
  h3.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "在" }] } } });
  h3.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
  await flush();
  equal("a forgotten session sends nothing", h3.sent.length, 0);
}

// #停一下 already said "已停《…》"; the cancelled turn must not answer too.
{
  const h4 = harness();
  await h4.relay.relay("wxid_me", BINDING, "数数");
  h4.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "1 2 3" }] } } });
  h4.relay.onSessionEvent("session-alpha", { type: "turn/end", data: { reason: { kind: "aborted" } } });
  await flush();
  equal("a stopped turn is not mirrored", h4.sent.length, 0);
  const done = harness();
  await done.relay.relay("wxid_me", BINDING, "数数");
  done.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "1 2 3" }] } } });
  done.relay.onSessionEvent("session-alpha", { type: "turn/end", data: { reason: { kind: "completed" } } });
  await flush();
  equal("a completed turn is mirrored", done.sent.length, 1);
  check("the completed answer is the text", done.sent[0].text.includes("1 2 3"));
}

// A conversation the user drives on the desktop is never echoed.
h = harness();
h.relay.onSessionEvent("session-other", { type: "assistant/message", data: { message: { content: [{ type: "text", text: "别发" }] } } });
h.relay.onSessionEvent("session-other", { type: "turn/end", data: {} });
await flush();
equal("an unrelated session is ignored", h.sent.length, 0);

// A failed delivery starts no turn, so nothing is owed.
h = harness();
const failing = new RelayService({
  sendText: async () => {},
  deliver: async () => ({ ok: false, message: "会话没了" }),
  now: () => 1,
});
const failed = await failing.relay("wxid_me", BINDING, "在吗");
check("a failed delivery reports why", failed.ok === false && failed.message === "会话没了");
check("a failed delivery owes no mirror", !failing.isExpecting("session-alpha"));

// A tool-only turn still answers the phone.
h = harness();
await h.relay.relay("wxid_me", BINDING, "跑一下测试");
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
await flush();
equal("an empty turn says so", h.sent[0].text, "[重构导入流程] （这一轮没有文字回复）");

// Multi-part replies are numbered, prefix only on the first.
h = harness();
await h.relay.relay("wxid_me", BINDING, "写长一点");
h.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: paragraphs }] } } });
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
await flush();
check("a long answer is split", h.sent.length > 1 && h.sent.length <= REPLY_MAX_PARTS, `${h.sent.length}`);
check("only the first part carries the prefix", h.sent[0].text.startsWith("[重构导入流程] ") && !h.sent[1].text.startsWith("[重构导入流程]"));
check("parts are numbered", /（1\/\d）/u.test(h.sent[0].text) && /（2\/\d）/u.test(h.sent[1].text));

// Over the file threshold: an attachment plus one line of explanation.
h = harness();
await h.relay.relay("wxid_me", BINDING, "写超长");
h.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: enormous }] } } });
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
await flush();
equal("the file is sent", h.files.length, 1);
equal("the file is markdown", h.files[0].name, "reply.md");
check("the file carries the whole answer", h.files[0].text.length === enormous.length);
check("a note points at the attachment", h.sent.length === 1 && h.sent[0].text.includes("全文见附件"));

// Without a file channel the same answer is clipped and says so.
h = harness({ sendFile: false });
await h.relay.relay("wxid_me", BINDING, "写超长");
h.relay.onSessionEvent("session-alpha", { type: "assistant/message", data: { message: { content: [{ type: "text", text: enormous }] } } });
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
await flush();
check("without files it sends parts", h.sent.length > 0);
check("and admits the truncation", h.sent.at(-1).text.includes("已截断"));

// An expectation nobody ever answers must not leak into a much later turn.
h = harness();
await h.relay.relay("wxid_me", BINDING, "这个会卡住");
h.advance(60 * 60_000);
h.relay.onSessionEvent("session-alpha", { type: "turn/end", data: {} });
await flush();
equal("a stale expectation is dropped", h.sent.length, 0);
check("and forgotten", !h.relay.isExpecting("session-alpha"));

if (failures.length > 0) {
  console.error(`relay: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`relay: ${pass} passed, 0 failed`);
