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

if (failures.length > 0) {
  console.error(`approvals: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`approvals: ${pass} passed, 0 failed`);
