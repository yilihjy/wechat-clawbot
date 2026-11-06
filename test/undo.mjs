#!/usr/bin/env node
/**
 * Offline checks for undoing a command (`src/ledger-tools.ts` `undoEntry`, D30).
 *
 * The interesting part is not the happy path but what each failure means: an
 * undo the workbench cannot do yet must not look like one it did, and a failed
 * attempt must leave its target on offer — otherwise the retry after the
 * endpoint lands would find nothing to point at.
 *
 *   node test/undo.mjs
 *
 * Exits non-zero when any check fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { CommandLedger } = await import(join(ROOT, "lib/ledger.js"));
const { undoEntry } = await import(join(ROOT, "lib/ledger-tools.js"));
const { ModeStore } = await import(join(ROOT, "lib/modes.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}

const DIR = mkdtempSync(join(tmpdir(), "clawbot-undo-"));
let clock = new Date(2026, 10, 2, 9, 0).getTime();
const ledger = new CommandLedger({ dir: join(DIR, "ledger"), now: () => clock });
const modes = new ModeStore(join(DIR, "modes.json"), { now: () => clock });
const capture = { enabled: true, baseUrl: "http://127.0.0.1:9", token: "tok" };
const deps = { ledger, modes, capture, now: () => clock };

const captureEntry = (id) =>
  ledger.append(
    {
      command: "入库",
      args: { url: "https://e.x/a", captureId: id },
      result: "ok",
      summary: "入库《一篇》",
      undo: { kind: "capture", captureId: id, url: "https://e.x/a", title: "一篇" },
    },
    { mode: "agent", peer: "wxid_me" },
  );

// ---------------------------------------------------------------- the capture branch

const realFetch = globalThis.fetch;
try {
  const entry = captureEntry("cap-1");
  const reply = (status, body) =>
    body === undefined
      ? new Response("", { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  // The undo now tries withdraw first, then the old reject route.
  const route = ({ withdraw, reject }) =>
    async (url) => {
      const handler = url.includes("/withdraw") ? withdraw : url.includes("/reject") ? reject : undefined;
      if (handler === undefined) throw new Error(`unexpected fetch ${url}`);
      return typeof handler === "function" ? handler() : handler;
    };

  globalThis.fetch = route({ withdraw: reply(404), reject: reply(404) });
  const missingRoute = await undoEntry(entry, deps);
  check("a workbench without the route says so", !missingRoute.ok && missingRoute.message.includes("还没有撤销端点"), missingRoute.message);
  check("the failure names what it tried to undo", missingRoute.message.includes("《一篇》"), missingRoute.message);

  globalThis.fetch = route({ withdraw: reply(404), reject: reply(200) });
  const done = await undoEntry(entry, deps);
  check("an old inbox capture is reported as undone", done.ok && done.message.includes("已从收件箱撤掉《一篇》"), done.message);

  globalThis.fetch = route({ withdraw: reply(200, { ok: true, sourceArticleId: "sa-1", removedDocuments: 2 }), reject: reply(500) });
  const withdrawn = await undoEntry(entry, deps);
  check(
    "a personal material is reported as withdrawn",
    withdrawn.ok && withdrawn.message.includes("已撤销《一篇》（移出个人库）"),
    withdrawn.message,
  );

  globalThis.fetch = route({ withdraw: reply(404), reject: reply(200, { ok: true, alreadyRejected: true }) });
  const again = await undoEntry(entry, deps);
  check("a second undo says it was already gone", again.ok && again.message.includes("早就撤过了"), again.message);

  globalThis.fetch = route({
    withdraw: reply(409, { error: { code: "conflict", message: "source is already cited by articles", details: { articles: ["a-1", "a-2"] } } }),
    reject: reply(500),
  });
  const cited = await undoEntry(entry, deps);
  check(
    "material cited by articles cannot be undone",
    !cited.ok && cited.message.includes("已被 2 篇文章引用，不能撤销"),
    cited.message,
  );

  globalThis.fetch = route({
    withdraw: reply(404),
    reject: reply(409, { error: { code: "conflict", message: "accepted" } }),
  });
  const conflict = await undoEntry(entry, deps);
  check("an accepted capture cannot be undone", !conflict.ok && conflict.message.includes("accepted"), conflict.message);
} finally {
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- the relay branches

clock += 1000;
const bound = ledger.append(
  {
    command: "接管",
    args: { index: 1, sessionId: "s-alpha" },
    result: "ok",
    summary: "接管了《甲》",
    undo: { kind: "relay-bind", sessionId: "s-alpha" },
  },
  { mode: "agent", peer: "wxid_me" },
);
modes.bind("wxid_me", { sessionId: "s-alpha", title: "甲" });
const released = await undoEntry(bound, deps);
check("undoing a takeover ends the binding", released.ok && modes.peerFor("s-alpha") === null, released.message);
check("the receipt names the conversation", released.message.includes("《甲》"), released.message);

const againReleased = await undoEntry(bound, deps);
check("undoing a takeover twice is refused", !againReleased.ok && againReleased.message.includes("已经结束"), againReleased.message);

// A takeover that was replaced since must not end the newer one.
modes.bind("wxid_me", { sessionId: "s-beta", title: "乙" });
const stale = await undoEntry(bound, deps);
check("a replaced takeover leaves the newer binding alone", !stale.ok && modes.peerFor("s-beta") !== null, stale.message);
modes.release("wxid_me");

clock += 1000;
const handed = ledger.append(
  {
    command: "交还",
    args: { sessionId: "s-gamma" },
    result: "ok",
    summary: "交还了《丙》",
    undo: { kind: "relay-release", previous: { sessionId: "s-gamma", title: "丙" } },
  },
  { mode: "relay", peer: "wxid_me" },
);
const back = await undoEntry(handed, deps);
check("undoing a hand-back takes the conversation over again", back.ok && modes.peerFor("s-gamma")?.peer === "wxid_me", back.message);

const alreadyBack = await undoEntry(handed, deps);
check("when it is already bound again, the undo says so", !alreadyBack.ok && alreadyBack.message.includes("已经在接管"), alreadyBack.message);
modes.release("wxid_me");

// A hand-back that undid nothing has nothing to restore.
clock += 1000;
const noopHandBack = ledger.append(
  { command: "交还", result: "noop", summary: "本来就没在接管", undo: { kind: "relay-release", previous: null } },
  { mode: "agent", peer: "wxid_me" },
);
const nothing = await undoEntry(noopHandBack, deps);
check("a hand-back with nothing before it has nothing to restore", !nothing.ok && nothing.message.includes("本来就没在接管"), nothing.message);

// ---------------------------------------------------------------- candidates that failed once

clock += 1000;
const failedUndo = ledger.append(
  {
    command: "撤销",
    args: { target: captureEntry("cap-2").ts, undone: "入库" },
    result: "failed",
    summary: "没能撤掉《一篇》：这个工作台还没有撤销端点",
  },
  { mode: "agent", peer: "wxid_me" },
);
const candidates = ledger.undoable(10);
check("a failed undo stays in the ledger", failedUndo.result === "failed");
check(
  "a failed undo leaves its target on offer",
  candidates.some((entry) => entry.command === "入库" && entry.args?.captureId === "cap-2"),
  candidates.map((e) => `${e.command}:${String(e.args?.captureId ?? "")}`).join(","),
);

// ---------------------------------------------------------------- entries with nothing to undo

const plain = ledger.append({ command: "任务状态", result: "ok", summary: "看了看" }, { mode: "agent", peer: "wxid_me" });
const refused = await undoEntry(plain, deps);
check("a read-only command has nothing to undo", !refused.ok && refused.message.includes("没有可撤的动作"), refused.message);

rmSync(DIR, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`undo: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`undo: ${pass} passed, 0 failed`);
