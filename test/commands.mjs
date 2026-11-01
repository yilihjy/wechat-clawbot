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

const { normalizeCommandText, routeInboundCommand, stripEscape, unknownCommandReply, helpText } = await import(
  join(ROOT, "lib/commands.js")
);

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

console.log(`commands: ${pass} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
