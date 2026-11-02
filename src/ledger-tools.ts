/**
 * The two tools that make the ledger useful to the agent (D30).
 *
 * Why tools and not commands: undoing is a conversation. "撤销刚才那个" can mean
 * three different entries, and the right behaviour is "there is only one, done"
 * or "here are three, which one" — which is a question, not a parser. So the
 * decision lives with the model, and the *effects* stay in here where they are
 * written down.
 *
 * Both tools are registered on the WeChat session only (see bridge.ts): the
 * ledger is about commands typed on the phone, and that is the conversation the
 * phone talks to.
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { rejectCapture, type CaptureConfig } from "./capture.js";
import { clockOf } from "./timeline.js";
import type { CommandLedger, LedgerEntry, LedgerUndo } from "./ledger.js";
import type { ModeStore } from "./modes.js";
import { logger } from "./ilink/util/logger.js";

/** How many candidates the answer lists when the undo is ambiguous. */
const CANDIDATE_LIMIT = 5;

/** What the tools need from the plugin body. */
export interface LedgerToolDeps {
  readonly ledger: CommandLedger;
  /** Where the relay bindings live; absent in compositions without relay. */
  readonly modes?: ModeStore;
  /** The workbench connection, for undoing a capture. */
  readonly capture: CaptureConfig;
  /** Clock override for tests. */
  readonly now?: () => number;
}

/** One line for a candidate: enough to recognise it, short enough for a phone. */
function describe(entry: LedgerEntry): string {
  return `${clockOf(entry.ts)} #${entry.command} — ${entry.summary}`;
}

/** How to name an undo in the receipt. */
function undoLabel(undo: LedgerUndo): string {
  if (undo.kind === "capture") return `《${undo.title?.trim() || "(没有标题)"}》`;
  if (undo.kind === "relay-bind") return "那次接管";
  return "那次交还";
}

/**
 * Undo one entry.
 *
 * `#入库` goes to the workbench (the inbox is the record); relay commands are
 * local state, so they undo themselves. `#新会话` and `#停一下` are not
 * reversible at all — they are not offered here.
 */
export async function undoEntry(
  entry: LedgerEntry,
  deps: LedgerToolDeps,
): Promise<{ ok: boolean; message: string }> {
  const undo = entry.undo;
  if (undo === null || undo === undefined) return { ok: false, message: "这条命令没有可撤的动作。" };
  const label = undoLabel(undo);

  if (undo.kind === "capture") {
    const result = await rejectCapture(undo.captureId, deps.capture);
    if (!result.ok) return { ok: false, message: `没能撤掉${label}：${result.message}` };
    return { ok: true, message: result.already ? `${label}早就撤过了，收件箱里没有它。` : `已从收件箱撤掉${label}。` };
  }

  if (deps.modes === undefined) return { ok: false, message: "这里没有接管状态，撤不了。" };
  if (undo.kind === "relay-bind") {
    // Only the binding that is still on that session can be withdrawn: if it was
    // replaced since, releasing would end the wrong one.
    const active = deps.modes.peerFor(undo.sessionId);
    if (active === null) return { ok: false, message: "那次接管已经结束（或换成了别的会话），没什么可撤的。" };
    const dropped = deps.modes.release(active.peer);
    return dropped === null
      ? { ok: false, message: "那次接管已经结束，没什么可撤的。" }
      : { ok: true, message: `已结束对《${dropped.title.trim() || dropped.sessionId.slice(0, 8)}》的接管。` };
  }

  // relay-release: undoing a hand-back means taking that conversation over again.
  // The peer comes from the entry — it is who was bound when the command ran.
  const previous = undo.previous;
  if (previous === null) return { ok: false, message: "那次交还之前本来就没在接管，没有可恢复的。" };
  if (deps.modes.peerFor(previous.sessionId) !== null) {
    return { ok: false, message: "那个会话现在已经在接管中，不用恢复。" };
  }
  if (entry.peer === "") return { ok: false, message: "那条记录里没有绑定的主人，恢复不了。" };
  deps.modes.bind(entry.peer, { sessionId: previous.sessionId, title: previous.title });
  return { ok: true, message: `已重新接管《${previous.title.trim() || previous.sessionId.slice(0, 8)}》。` };
}

/** Append the record that makes an undo visible (and not repeatable). */
function markUndone(deps: LedgerToolDeps, entry: LedgerEntry, message: string): void {
  deps.ledger.append(
    {
      command: "撤销",
      args: { target: entry.ts, undone: entry.command },
      result: "ok",
      summary: message,
      undo: null,
    },
    { mode: "agent", peer: entry.peer },
  );
}

/**
 * Register `command_ledger` and `undo_command` on the WeChat session.
 *
 * Both are additive: they never send anything to WeChat themselves. A WeChat
 * reply still goes through `send_wechat_text`, so a failed tool cannot leave
 * the owner with half an answer.
 */
export function registerLedgerTools(agentCtx: Context, deps: LedgerToolDeps): void {
  agentCtx.tools.register(
    defineTool({
      name: "command_ledger",
      description:
        "Read the WeChat command ledger: the deterministic commands (#入库, #接管, #交还, #停一下 …) "
        + "the owner typed on their phone, with their result. Use it when asked what was filed or done "
        + "today, or to find the entry a 'undo that' refers to. It holds command arguments and results, "
        + "never the conversation text.",
      parameters: {
        day: { type: "string", description: "One day as YYYY-MM-DD (local time). Omit for the last few entries." },
        limit: { type: "number", description: "How many entries, 1-50. Default 20." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const { day, limit } = args as { day?: string; limit?: number };
        const count = Math.min(50, Math.max(1, Math.round(limit ?? 20)));
        if (typeof day === "string" && day !== "") {
          const { entries, skipped } = deps.ledger.readDay(day);
          if (entries.length === 0 && skipped === 0) return { ok: false, text: `${day} 没有记录。` };
          const lines = entries
            .slice(-count)
            .map((entry) => `${clockOf(entry.ts)} #${entry.command} — ${entry.summary}`);
          const tail = skipped === 0 ? [] : [`(${skipped} 行读不出来)`];
          return { ok: true, text: [`${day}：`, ...lines, ...tail].join("\n") };
        }
        const entries = deps.ledger.recent(count);
        if (entries.length === 0) return { ok: false, text: "账本还是空的：还没有任何命令。" };
        return { ok: true, text: entries.map((entry) => `${clockOf(entry.ts)} #${entry.command} — ${entry.summary}`).join("\n") };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "undo_command",
      description:
        "Undo one earlier WeChat command. Only #入库 (while the capture is still pending), #接管 and #交还 "
        + "can be undone; #新会话, #停一下 and read-only commands cannot. Call with no arguments to undo the "
        + "only candidate, or when it answers that there are several, call again with the index it listed.",
      parameters: {
        which: { type: "number", description: "1-based index from the candidate list the tool returned." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
            candidates: { type: "number" },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const { which } = args as { which?: number };
        const candidates = deps.ledger.undoable(CANDIDATE_LIMIT);
        if (candidates.length === 0) return { ok: false, text: "最近没有可撤销的命令（入库撤不了已 accepted 的，接管/交还也已经结束了）。" };
        const caller = String((exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id ?? "");

        if (which === undefined) {
          if (candidates.length > 1) {
            const list = candidates.map((entry, i) => `${i + 1}. ${describe(entry)}`).join("\n");
            return {
              ok: false,
              text: `有 ${candidates.length} 条可以撤，是哪一条？\n${list}\n\n回一句话告诉我编号，我再调用一次。`,
              candidates: candidates.length,
            };
          }
          const only = candidates[0]!;
          const result = await undoEntry(only, deps);
          if (result.ok) markUndone(deps, only, `${undoLabel(only.undo!)} · ${result.message}`);
          logger.info(`undo_command: ${caller} undid ${only.command}@${only.ts}: ${result.message}`);
          return { ok: result.ok, text: result.message };
        }

        const index = Math.round(which);
        if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
          return { ok: false, text: `只有 ${candidates.length} 条候选。` };
        }
        const entry = candidates[index - 1]!;
        const result = await undoEntry(entry, deps);
        if (result.ok) markUndone(deps, entry, `${undoLabel(entry.undo!)} · ${result.message}`);
        logger.info(`undo_command: ${caller} undid #${index} ${entry.command}@${entry.ts}: ${result.message}`);
        return { ok: result.ok, text: result.message };
      },
    }),
  );
}
