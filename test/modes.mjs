#!/usr/bin/env node
/**
 * Offline checks for the per-peer mode store (`src/modes.ts`).
 *
 * What must not break silently: a `#接管` surviving a restart, the 30-minute
 * silence expiring exactly once (not on every message afterwards), a rebind of
 * the same conversation keeping its original start time, and a corrupt
 * `modes.json` sending messages to the agent rather than to nowhere.
 *
 *   node test/modes.mjs
 *
 * Exits non-zero when any check fails.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const { ModeStore, RELAY_TTL_MS, isRelayActive, isFresh, remainingMs, remainingText, describeBinding, shortSessionId } = await import(
  join(ROOT, "lib/modes.js")
);

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

const DIR = mkdtempSync(join(tmpdir(), "clawbot-modes-"));
const FILE = join(DIR, "modes.json");
let clock = 1_000_000;
const now = () => clock;
const store = new ModeStore(FILE, { now });
const PEER = "wxid_someone";

check("a fresh peer talks to the agent", store.lookup(PEER).binding === null);

// Bind, and prove it is on disk and survives a "restart".
const bound = store.bind(PEER, { sessionId: "session-alpha", title: "重构导入流程" });
equal("binding fields", [bound.sessionId, bound.title, bound.since, bound.lastAt], ["session-alpha", "重构导入流程", clock, clock]);
check("modes.json exists", readFileSync(FILE, "utf-8").includes("session-alpha"));
const reopened = new ModeStore(FILE, { now });
equal("a new instance reads it back", reopened.lookup(PEER).binding?.sessionId, "session-alpha");

// Rebinding the same conversation keeps `since` but moves `lastAt`.
clock += 60_000;
const rebound = store.bind(PEER, { sessionId: "session-alpha", title: "重构导入流程" });
check("rebind keeps the original start", rebound.since === bound.since && rebound.lastAt === clock);

// Rebinding a different conversation restarts both.
clock += 1_000;
const other = store.bind(PEER, { sessionId: "session-beta", title: "写周报" });
check("a different conversation restarts since", other.since === clock && other.sessionId === "session-beta");

// Silence expires the binding exactly once.
clock += RELAY_TTL_MS + 1;
const expired = store.lookup(PEER);
check("an idle binding expires", expired.binding === null && expired.expired?.sessionId === "session-beta");
check("it is not reported twice", store.lookup(PEER).expired === null);
check("and it is gone from disk", !readFileSync(FILE, "utf-8").includes("session-beta"));

// touch() only pushes an existing binding forward.
store.bind(PEER, { sessionId: "session-alpha", title: "重构导入流程" });
const before = store.lookup(PEER).binding.lastAt;
clock += 5 * 60_000;
store.touch(PEER);
equal("touch moves lastAt", store.lookup(PEER).binding.lastAt, clock);
check("touch extended the window", store.lookup(PEER).binding.lastAt > before);
store.touch("wxid_never_bound");
check("touch on an unknown peer is a no-op", Object.keys(JSON.parse(readFileSync(FILE, "utf-8")).peers).length === 1);

// Release.
check("release reports what it dropped", store.release(PEER)?.sessionId === "session-alpha");
check("release twice is null", store.release(PEER) === null);
check("release leaves the peer on the agent", store.lookup(PEER).binding === null);

// Startup validation (D19).
store.bind("wxid_a", { sessionId: "session-alive", title: "活着" });
store.bind("wxid_b", { sessionId: "session-gone", title: "删了" });
const dropped = store.pruneMissing((id) => id === "session-alive");
equal("pruneMissing drops only the dead one", dropped.map((b) => b.sessionId), ["session-gone"]);
check("the live binding is untouched", store.lookup("wxid_a").binding?.sessionId === "session-alive");

// Corrupt files must not make the bot unreachable.
writeFileSync(FILE, "{ this is not json", "utf-8");
const corrupt = new ModeStore(FILE, { now });
check("a corrupt file reads as 'everyone on the agent'", corrupt.lookup("wxid_a").binding === null);
corrupt.bind("wxid_a", { sessionId: "s", title: "" });
check("and the store recovers on the next write", readFileSync(FILE, "utf-8").includes('"version": 1'));

writeFileSync(FILE, JSON.stringify({ version: 1, peers: { wxid_x: { sessionId: "" }, wxid_y: { sessionId: "ok", since: "bad" } } }), "utf-8");
const repaired = new ModeStore(FILE, { now });
check("a binding without a session id is dropped", repaired.lookup("wxid_x").binding === null);
check("a binding with a bad timestamp is repaired", repaired.lookup("wxid_y").binding?.sessionId === "ok");

// Reverse lookup: which peer is relaying into one conversation (used by approvals).
store.release("wxid_a");
store.bind("wxid_phone", { sessionId: "session-target", title: "目标" });
equal("peerFor finds the peer", store.peerFor("session-target")?.peer, "wxid_phone");
check("peerFor ignores other conversations", store.peerFor("session-other") === null);
clock += RELAY_TTL_MS + 1;
check("peerFor ignores a stale binding", store.peerFor("session-target") === null);

// Freshness is what stops a prompt going to a phone the owner put down.
const fresh = { sessionId: "s", title: "t", since: 0, lastAt: 1_000_000 };
check("a just-used binding is fresh", isFresh(fresh, 1_000_000 + 60_000));
check("a quiet one is not", !isFresh(fresh, 1_000_000 + 5 * 60_000));
check("the window is adjustable", isFresh(fresh, 1_000_000 + 60_000, 120_000));

// The pure helpers the receipts are built from.
const binding = { sessionId: "abcdef123456", title: "标题", since: 0, lastAt: 0 };
check("active inside the window", isRelayActive(binding, RELAY_TTL_MS - 1));
check("inactive at the boundary", !isRelayActive(binding, RELAY_TTL_MS));
equal("remaining", remainingMs(binding, 0), RELAY_TTL_MS);
equal("remaining never negative", remainingMs(binding, RELAY_TTL_MS * 2), 0);
equal("remaining text rounds up", remainingText({ ...binding, lastAt: 0 }, 0), "还剩 30 分钟");
equal("expired text", remainingText(binding, RELAY_TTL_MS), "已过期");
equal("describe shows title, id and time", describeBinding(binding, 0), "《标题》 · abcdef12 · 还剩 30 分钟");

rmSync(DIR, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`modes: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
// A phone-readable id: every session id starts with "session-", so slicing the
// raw id names every conversation "session-" (it did, on 2026-11-03).
check("shortSessionId drops the prefix", shortSessionId("session-5c614db8-b450-43e6-9959-b11514b7c5c0") === "5c614db8");
check("shortSessionId keeps a bare id", shortSessionId("5c614db8") === "5c614db8");
check("shortSessionId survives nonsense", shortSessionId("session-") === "");

console.log(`modes: ${pass} passed, 0 failed`);
