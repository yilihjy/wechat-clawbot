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
equal("the reminder waits 3 minutes by default", normalizeConfig({}).approvalReminderMs, 3 * 60_000);
equal("the reminder can be turned off", normalizeConfig({ approvalReminderMs: 0 }).approvalReminderMs, 0);
equal("receipts are on by default (4s)", normalizeConfig({}).ackAfterMs, 4_000);
equal("the path form of #新会话 is limited to ~/workspace", normalizeConfig({}).workspaceRoots, ["~/workspace"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The relay unrefs its timeout timer so it can never hold DSH open. In this
// harness nothing else does either, so keep the loop alive while we wait.
const keepAlive = setInterval(() => {}, 1_000);
function harness({
  timeoutMs,
  sender = "wxid_me",
  reminderMs = 0,
  ledger,
  stopped = false,
  // D53: routing is decided from the configured session id, not from the bridge
  // object, so a test can take the bridge away and still ask what happens.
  bridge = true,
  owner = undefined,
} = {}) {
  const pending = new PendingRegistry();
  const sent = [];
  const relay = new ApprovalRelay({
    config: { approvalTimeoutMs: timeoutMs, sessionId: "a1" },
    getBridge: () => (bridge ? { isWechatSession: (id) => id === "a1", activeSender: sender } : null),
    pending,
    sendText: async (_to, text) => {
      sent.push(text);
    },
    ...(ledger === undefined ? {} : { ledger }),
    reminderMs: () => reminderMs,
    wasStoppedRecently: () => stopped,
    ...(owner === undefined ? {} : { getOwnerId: () => owner }),
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


// ---------------------------------------------------------------- the ledger and the nudge (D49)

const { CommandLedger } = await import(join(ROOT, "lib/ledger.js"));
const { mkdtempSync: mkdtempA, rmSync: rmA } = await import("node:fs");
const { tmpdir: tmpA } = await import("node:os");
const LEDGER_DIR = mkdtempA(join(tmpA(), "clawbot-approval-ledger-"));
const stages = (ledger) => ledger.recent(50).filter((entry) => entry.command === "审批").map((entry) => entry.args?.stage);

// The card going out is recorded, so "did it arrive?" stops being a guess.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { pending, relay } = harness({ timeoutMs: 50, ledger });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(5);
  check("sending the card is recorded", stages(ledger).includes("sent"), JSON.stringify(stages(ledger)));
  pending.popFor("wxid_me")?.resolve("同意");
  await outcome;
  check("answering it is recorded too", stages(ledger).includes("answered"), JSON.stringify(stages(ledger)));
  const answered = ledger.recent(50).filter((entry) => entry.args?.stage === "answered").at(-1);
  check("the record keeps the decision", answered?.args?.decision === "yes", JSON.stringify(answered?.args));
  check("and how long it waited", typeof answered?.args?.waitedMs === "number");
}

// One nudge, and only when nobody answered in time.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { pending, sent, relay } = harness({ timeoutMs: 2_000, reminderMs: 10, ledger });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(30);
  check("a nudge is sent when nobody answers", sent.some((text) => text.includes("还在等")), sent.join(" | "));
  check("the nudge names the commands", sent.some((text) => text.includes("#允许") && text.includes("#拒绝")), sent.join(" | "));
  check("the nudge is recorded", stages(ledger).includes("reminded"), JSON.stringify(stages(ledger)));
  check("only one nudge", sent.filter((text) => text.includes("还在等")).length === 1, sent.join(" | "));
  pending.popFor("wxid_me")?.resolve("拒绝");
  await outcome;
  await sleep(30);
  check("no second nudge after the answer", sent.filter((text) => text.includes("还在等")).length === 1, sent.join(" | "));
}

{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { pending, sent, relay } = harness({ timeoutMs: 2_000, reminderMs: 20, ledger });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(3);
  pending.popFor("wxid_me")?.resolve("同意");
  await outcome;
  await sleep(40);
  check("a quick answer never sees a nudge", !sent.some((text) => text.includes("还在等")), sent.join(" | "));
}

// Answered on the desktop: the phone is told, because otherwise it waits for
// ever without knowing the question is gone.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { sent, relay } = harness({ timeoutMs: 5_000, ledger });
  const stop = new AbortController();
  const outcome = relay.answer(request(stop.signal), async () => "allowed-once");
  await sleep(5);
  stop.abort();
  await outcome;
  check("a desktop answer tells the phone", sent.some((text) => text.includes("在电脑上处理")), sent.join(" | "));
  check("and is recorded as such", stages(ledger).includes("elsewhere"), JSON.stringify(stages(ledger)));
}

// Stopped with #停一下: the phone already got 已停《…》; a second line would lie.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { sent, relay } = harness({ timeoutMs: 5_000, ledger, stopped: true });
  const stop = new AbortController();
  const outcome = relay.answer(request(stop.signal), async () => "allowed-once");
  await sleep(5);
  stop.abort();
  await outcome;
  check("a stopped turn says nothing more", !sent.some((text) => text.includes("在电脑上处理")), sent.join(" | "));
  check("but it is recorded as a stop", stages(ledger).includes("stopped"), JSON.stringify(stages(ledger)));
}

// The timeout keeps its own record and its own line (D44).
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { sent, relay } = harness({ timeoutMs: 10, ledger });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once");
  await sleep(30);
  check("a timeout is recorded", stages(ledger).includes("timeout"), JSON.stringify(stages(ledger)));
  check("the timeout line is still there", sent.some((text) => text.includes("审批超时")), sent.join(" | "));
  check("a timeout is not reported as a desktop answer", !sent.some((text) => text.includes("在电脑上处理")), sent.join(" | "));
  await outcome;
}

rmA(LEDGER_DIR, { recursive: true, force: true });


// ---------------------------------------------------------------- D53: no branch is silent

const stagesOf = (ledger) => ledger.recent(80).filter((entry) => entry.command === "审批").map((entry) => entry.args?.stage);

// The bridge is a mount. Between mounts an approval from the WeChat session must
// still reach the phone (this is the 2026-11-04 incident: 76 minutes on a desktop).
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { pending, sent, relay } = harness({ timeoutMs: 2_000, ledger, bridge: false, owner: "wxid_owner" });
  const outcome = relay.answer(request(new AbortController().signal), async () => "allowed-once").catch(() => "cancelled");
  await sleep(5);
  check("a card still goes out with no bridge mounted", sent.some((text) => text.includes("DSH 权限请求")), sent.join(" | "));
  check("it goes to the bound owner", sent.length > 0 && sent[0] !== undefined, sent.join(" | "));
  const sentRecord = ledger.recent(80).filter((entry) => entry.args?.stage === "sent").at(-1);
  check("the ledger says the bridge was not mounted", sentRecord?.args?.bridgeMounted === false, JSON.stringify(sentRecord?.args));
  check("and it names the agent that asked", typeof sentRecord?.args?.agent === "string", JSON.stringify(sentRecord?.args));
  pending.popFor("wxid_owner")?.resolve("拒绝");
  await outcome;
  check("answering still works without a bridge", stagesOf(ledger).includes("answered"), JSON.stringify(stagesOf(ledger)));
}

// No bridge AND no bound account: there is nobody to ask. Fail closed, but say why.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { sent, relay } = harness({ timeoutMs: 2_000, ledger, bridge: false });
  const outcome = await relay.answer(request(new AbortController().signal), async () => "allowed-once");
  equal("no recipient fails closed", outcome, "unavailable");
  check("and nothing is sent", sent.length === 0, sent.join(" | "));
  check("the no-sender branch is recorded", stagesOf(ledger).includes("no-sender"), JSON.stringify(stagesOf(ledger)));
}

// Somebody else's conversation: the desktop keeps it, but the reason is written down.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { sent, relay } = harness({ timeoutMs: 2_000, ledger });
  const other = { agent: { id: "session-other" }, toolName: "bash", reason: "别人的会话", signal: new AbortController().signal };
  const outcome = await relay.answer(other, async () => "allowed-once");
  equal("a foreign conversation is left to the desktop", outcome, "allowed-once");
  check("nothing is sent for it", sent.length === 0, sent.join(" | "));
  const record = ledger.recent(80).filter((entry) => entry.args?.stage === "not-ours").at(-1);
  check("the not-ours branch is recorded with the agent", record?.args?.agent === "session-other".slice(-8), JSON.stringify(record?.args));
  check("and says why", String(record?.summary).includes("留给桌面"), String(record?.summary));
}

// #审批自检: answers the three questions and sends a real card.
{
  const ledger = new CommandLedger({ dir: LEDGER_DIR });
  const { sent, relay } = harness({ timeoutMs: 2_000, ledger, owner: "wxid_owner", sender: "wxid_owner" });
  const report = await relay.selfCheck();
  check("the self-check reports the mount state", report.includes("监听："), report);
  check("it names the recipient", report.includes("wxid_owner"), report);
  check("it states the routing verdict", report.includes("审批会发到手机"), report);
  check("it actually sent a test card", sent.some((text) => text.includes("审批自检")), sent.join(" | "));
  check("and recorded it", stagesOf(ledger).includes("self-check"), JSON.stringify(stagesOf(ledger)));
}

// With nobody bound the self-check says so instead of pretending.
{
  const { sent, relay } = harness({ timeoutMs: 2_000, bridge: false });
  const report = await relay.selfCheck();
  check("a self-check without a recipient is red", report.includes("审批会留在桌面") || report.includes("没有（既没有"), report);
  check("and sends nothing", sent.length === 0, sent.join(" | "));
}

clearInterval(keepAlive);

if (failures.length > 0) {
  console.error(`approvals: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`approvals: ${pass} passed, 0 failed`);
