#!/usr/bin/env node
/**
 * Offline checks for the 「已收到，正在处理中…」 receipt (`src/ack.ts`, D51).
 *
 * The rules worth pinning are all about restraint: a fast answer must not add a
 * second message, three messages in a row must produce one receipt, and the
 * delay is a live config value.
 *
 *   node test/ack.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { AckQueue, ACK_TEXT, ACK_AFTER_MS, ACK_TICK_MS } = await import(join(ROOT, "lib/ack.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------- the happy path

{
  const queue = new AckQueue(4_000);
  queue.arm("wxid_me", T0);
  check("arming leaves nothing to send yet", queue.due(T0).length === 0);
  const first = queue.due(T0 + ACK_AFTER_MS - 1);
  check("still nothing one millisecond early", first.length === 0);
  const second = queue.due(T0 + ACK_AFTER_MS);
  check("the receipt is due at the delay", second.length === 1 && second[0].peer === "wxid_me");
  check("it says what it should say", second[0].text === ACK_TEXT, second[0].text);
  check("it is sent once", queue.due(T0 + ACK_AFTER_MS + 5_000).length === 0);
  check("nothing is left armed", queue.size === 0);
}

// ---------------------------------------------------------------- a fast answer wins

{
  const queue = new AckQueue(4_000);
  queue.arm("wxid_me", T0);
  check("the answer cancels it", queue.cancel("wxid_me") === true);
  check("a cancelled receipt never fires", queue.due(T0 + 60_000).length === 0);
  check("cancelling twice is harmless", queue.cancel("wxid_me") === false);
}

// ---------------------------------------------------------------- one per burst

{
  const queue = new AckQueue(4_000);
  queue.arm("wxid_me", T0);
  queue.arm("wxid_me", T0 + 1_000);
  queue.arm("wxid_me", T0 + 2_000);
  check("three messages in a row keep one receipt armed", queue.size === 1);
  check("the last message restarts the wait", queue.due(T0 + 4_500).length === 0);
  check("it fires four seconds after the last one", queue.due(T0 + 6_000).length === 1);
}

// ---------------------------------------------------------------- a relayed title

{
  const queue = new AckQueue(4_000);
  queue.arm("wxid_me", T0, "[重构导入流程] ");
  check("the receipt carries the relay prefix", queue.due(T0 + 4_000)[0].text === `[重构导入流程] ${ACK_TEXT}`);
}

// ---------------------------------------------------------------- peers are independent

{
  const queue = new AckQueue(4_000);
  queue.arm("wxid_a", T0);
  queue.arm("wxid_b", T0 + 2_000);
  const due = queue.due(T0 + 4_000);
  check("only the peer whose turn is up gets one", due.length === 1 && due[0].peer === "wxid_a");
  check("the other is still waiting", queue.due(T0 + 6_000)[0]?.peer === "wxid_b");
}

// ---------------------------------------------------------------- the switch

{
  const queue = new AckQueue(0);
  queue.arm("wxid_me", T0);
  check("0 disables the receipt entirely", queue.size === 0 && queue.due(T0 + 60_000).length === 0);

  // A live config value: flipping the delay takes effect on the next message.
  let delay = 4_000;
  const live = new AckQueue(() => delay);
  live.arm("wxid_me", T0);
  delay = 0;
  live.arm("wxid_me", T0);
  check("turning it off disarms what was waiting", live.size === 0);
}

// ---------------------------------------------------------------- due order and clear

{
  const queue = new AckQueue(1_000);
  queue.arm("b", T0);
  queue.arm("a", T0);
  const due = queue.due(T0 + 1_000);
  check("both are due", due.length === 2);
  queue.arm("c", T0);
  queue.clear();
  check("clear forgets everything", queue.size === 0);
}

check("the documented constants stay put", ACK_AFTER_MS === 4_000 && ACK_TICK_MS === 1_000);

if (failures.length > 0) {
  console.error(`ack: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`ack: ${pass} passed, 0 failed`);
