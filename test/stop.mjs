#!/usr/bin/env node
/**
 * Offline checks for `#停一下`'s confirmation window (`src/stop.ts`, D14).
 *
 * Two things matter here and both are about *not* doing something: the window
 * must expire (a forgotten "回「停」才停" must not stop a turn tomorrow), and it
 * must never swallow a real message — only the word that confirms it.
 *
 *   node test/stop.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { StopConfirms, isStopWord, STOP_CONFIRM_MS } = await import(join(ROOT, "lib/stop.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}

// ---------------------------------------------------------------- the word

for (const word of ["停", "停。", "停！", " 停 ", "停下", "停一下", "#停", "STOP"]) {
  check(`${JSON.stringify(word)} confirms`, isStopWord(word));
}
for (const word of ["停了", "不要停", "停一下这个任务", "停止", "能不能停", "", "stop it"]) {
  check(`${JSON.stringify(word)} does not confirm`, !isStopWord(word));
}
check("no text at all does not confirm", !isStopWord(null));

// ---------------------------------------------------------------- the window

const now = 1_700_000_000_000;
const stops = new StopConfirms();
const target = { sessionId: "session-alpha", title: "重构导入流程" };
check("nothing is pending before a request", stops.pending("wxid_me", now) === null);
stops.request("wxid_me", target, now);
check("the request is remembered", stops.pending("wxid_me", now)?.sessionId === "session-alpha");
check("another peer is unaffected", stops.pending("wxid_other", now) === null);
check("the title comes back too", stops.pending("wxid_me", now)?.title === "重构导入流程");

// It expires: a forgotten confirmation must not stop a turn tomorrow.
check("it is still open just before the window ends", stops.pending("wxid_me", now + STOP_CONFIRM_MS - 1) !== null);
check("it is closed at the window's end", stops.pending("wxid_me", now + STOP_CONFIRM_MS) === null);
check("an expired window stays closed", stops.pending("wxid_me", now) === null);

// clear() is what a confirmed stop (or any other message) does.
stops.request("wxid_me", target, now);
stops.clear("wxid_me");
check("clearing closes the window", stops.pending("wxid_me", now) === null);

// A second #停一下 replaces the first rather than queueing: the newest target wins.
stops.request("wxid_me", target, now);
stops.request("wxid_me", { sessionId: "session-beta", title: "" }, now);
check("a newer request replaces the older one", stops.pending("wxid_me", now)?.sessionId === "session-beta");

if (failures.length > 0) {
  console.error(`stop: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`stop: ${pass} passed, 0 failed`);
