#!/usr/bin/env node
/**
 * Offline checks for approval routing (`src/approvals.ts`).
 *
 * The decision is the risky part, not the plumbing: an approval sent to the
 * wrong place either strands a turn (nobody answers) or pops a desktop dialog
 * for a session the phone owns. So it is one pure function, checked here for
 * every combination.
 *
 *   node test/approvals.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const { approvalRoute } = await import(join(ROOT, "lib/approvals.js"));
const { RELAY_FRESH_MS } = await import(join(ROOT, "lib/modes.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}
function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = 1_000_000;
const binding = (over = {}) => ({ sessionId: "session-alpha", title: "重构导入流程", since: 0, lastAt: NOW, ...over });

// The dedicated WeChat session: answered on the phone, as before.
equal(
  "the WeChat session answers in WeChat",
  approvalRoute({ isWechat: true, activeSender: "wxid_me", relay: null, now: NOW }),
  { kind: "wechat", sender: "wxid_me" },
);

// ...but never by popping a desktop dialog when there is nobody to ask.
equal(
  "no sender on the WeChat session fails closed",
  approvalRoute({ isWechat: true, activeSender: undefined, relay: null, now: NOW }),
  { kind: "no-sender" },
);

// A relayed conversation the phone is actively using: ask on the phone.
equal(
  "a freshly used relay answers in WeChat",
  approvalRoute({ isWechat: false, relay: { peer: "wxid_me", binding: binding() }, now: NOW }),
  { kind: "relay", sender: "wxid_me", title: "重构导入流程" },
);

// The same binding, but the phone has been quiet: the desktop keeps its prompt.
equal(
  "a quiet relay leaves the prompt to the desktop",
  approvalRoute({
    isWechat: false,
    relay: { peer: "wxid_me", binding: binding({ lastAt: NOW - RELAY_FRESH_MS - 1 }) },
    now: NOW,
  }),
  { kind: "not-ours" },
);
equal(
  "the freshness boundary is exclusive",
  approvalRoute({
    isWechat: false,
    relay: { peer: "wxid_me", binding: binding({ lastAt: NOW - RELAY_FRESH_MS + 1 }) },
    now: NOW,
  }).kind,
  "relay",
);

// Someone else's conversation is someone else's problem.
equal(
  "an unrelated session is delegated",
  approvalRoute({ isWechat: false, relay: null, now: NOW }),
  { kind: "not-ours" },
);

// A relayed session with no title still says something sensible.
equal(
  "an untitled relay still routes",
  approvalRoute({ isWechat: false, relay: { peer: "wxid_me", binding: binding({ title: "  " }) }, now: NOW }),
  { kind: "relay", sender: "wxid_me", title: "  " },
);

// An explicitly shorter freshness window is honoured (the caller may tune it).
equal(
  "a custom freshness window is honoured",
  approvalRoute({
    isWechat: false,
    relay: { peer: "wxid_me", binding: binding({ lastAt: NOW - 1_000 }) },
    now: NOW,
    freshMs: 500,
  }),
  { kind: "not-ours" },
);

// The WeChat answer path is unaffected by relay state (a relay on another
// session must not stop the phone answering its own approvals).
equal(
  "relay state never affects the WeChat session",
  approvalRoute({ isWechat: true, activeSender: "wxid_me", relay: { peer: "wxid_me", binding: binding() }, now: NOW }),
  { kind: "wechat", sender: "wxid_me" },
);

// ---------------------------------------------------------------- the timeout (D44)

const { ApprovalRelay } = await import(join(ROOT, "lib/approvals.js"));
const { PendingRegistry } = await import(join(ROOT, "lib/pending.js"));
const { normalizeConfig } = await import(join(ROOT, "lib/config.js"));

// 30 minutes is the shipped default: an unanswered approval otherwise holds the
// turn — and a relayed conversation's turn on the desktop too.
equal("the default approval timeout is 30 minutes", normalizeConfig({}).approvalTimeoutMs, 30 * 60_000);
equal("an explicit 0 still means wait forever", normalizeConfig({ approvalTimeoutMs: 0 }).approvalTimeoutMs, 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The relay unrefs its timeout timer so it can never hold DSH open. In this
// harness nothing else does either, so keep the loop alive while we wait.
const keepAlive = setInterval(() => {}, 1_000);
function harness({ timeoutMs, sender = "wxid_me" }) {
  const pending = new PendingRegistry();
  const sent = [];
  const relay = new ApprovalRelay({
    config: { approvalTimeoutMs: timeoutMs },
    getBridge: () => ({ isWechatSession: () => true, activeSender: sender }),
    pending,
    sendText: async (_to, text) => {
      sent.push(text);
    },
  });
  return { pending, sent, relay };
}
const request = (signal) => ({ agent: { id: "a1" }, toolName: "bash", reason: "计时", signal });

// D12: the prompt has to name the commands, because those are the only answers
// the bridge takes now.
{
  const { pending, sent, relay } = harness({ timeoutMs: 50 });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(5);
  check("the question asks for #允许 / #拒绝", sent[0]?.includes("#允许") && sent[0]?.includes("#拒绝"), sent[0]);
  pending.popFor("wxid_me")?.resolve("拒绝");
  equal("a rejection still lands as rejected", await outcome, "rejected");
}

{
  const { looksLikeApprovalWord } = await import(join(ROOT, "lib/approvals.js"));
  for (const word of ["同意", "同意。", "拒绝", "允许", "批准", "yes", "no", "OK"]) {
    check(`${JSON.stringify(word)} looks like an answer`, looksLikeApprovalWord(word));
  }
  for (const word of ["", "同意了", "不要同意", "先别急", "帮我看看这个"]) {
    check(`${JSON.stringify(word)} is not an answer`, !looksLikeApprovalWord(word));
  }
}

// Nobody answers: the card is withdrawn and the phone is told why.
{
  const { pending, sent, relay } = harness({ timeoutMs: 20 });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(5); // `answer` sends the question first, then queues
  check("a timeout waits on the sender", pending.hasFor("wxid_me"));
  equal("a timed-out approval settles as cancelled", await outcome, "cancelled");
  check("the timed-out approval leaves the queue", !pending.hasFor("wxid_me"));
  check("the phone is told the turn stopped", sent.some((text) => text.includes("审批超时")), sent.join(" | "));
}

// Answered in time: no timeout line afterwards, one outcome.
{
  const { pending, sent, relay } = harness({ timeoutMs: 80 });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(5);
  pending.popFor("wxid_me")?.resolve("同意");
  equal("an answered approval settles the usual way", await outcome, "allowed-once");
  await sleep(120);
  check("no timeout line after an answer", !sent.some((text) => text.includes("审批超时")), sent.join(" | "));
}

// Aborted: silent. Saying "审批超时" for a turn the user stopped would be a lie.
{
  const { sent, relay } = harness({ timeoutMs: 5_000 });
  const stop = new AbortController();
  const outcome = relay.answer(request(stop.signal), async () => "allowed-once");
  await sleep(5);
  stop.abort();
  equal("an aborted approval settles as cancelled", await outcome, "cancelled");
  check("an abort says nothing", !sent.some((text) => text.includes("审批超时")), sent.join(" | "));
}

// Opting out still works: 0 never times out.
{
  const { pending, sent, relay } = harness({ timeoutMs: 0 });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(30);
  check("0 keeps waiting", pending.hasFor("wxid_me"));
  check("0 never sends a timeout line", !sent.some((text) => text.includes("审批超时")), sent.join(" | "));
  pending.popFor("wxid_me")?.resolve(null);
  equal("and can still be withdrawn by an abort", await outcome, "cancelled");
}

clearInterval(keepAlive);

if (failures.length > 0) {
  console.error(`approvals: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`approvals: ${pass} passed, 0 failed`);
