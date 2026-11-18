/**
 * The arguments of recent tool calls, indexed by `(session, callId)` (D55).
 *
 * An approval request carries only `toolName`, `callId` and a human reason — the
 * arguments live on the `tool/call` session event. The read-only auto-allow
 * needs the actual `command`, so this keeps the last few hundred calls in
 * memory, keyed the way the request refers to them.
 *
 * The map is bounded on purpose: it exists to answer "what is THIS approval
 * about", not to become a second session log.
 */
interface Entry {
  readonly name: string;
  readonly command: string | undefined;
}

export class ToolCallIndex {
  private readonly entries = new Map<string, Entry>();

  /**
   * @param limit - how many calls to remember (oldest evicted first).
   */
  constructor(private readonly limit = 512) {}

  /**
   * Remember one session event, when it is a tool call with a bash command.
   *
   * @param sessionId - the session the event belongs to.
   * @param event - the raw `session/event` payload.
   */
  record(sessionId: string, event: { readonly type?: unknown; readonly data?: unknown }): void {
    if (event.type !== "tool/call") return;
    const data = event.data as
      | { callId?: unknown; name?: unknown; arguments?: unknown }
      | undefined;
    const callId = data?.callId;
    const name = data?.name;
    if (typeof callId !== "string" || typeof name !== "string") return;
    let command: string | undefined;
    if (name === "bash" && typeof data?.arguments === "string") {
      try {
        const parsed = JSON.parse(data.arguments) as { command?: unknown };
        if (typeof parsed.command === "string") command = parsed.command;
      } catch {
        // An unparseable argument blob simply means "no command to classify".
      }
    }
    const key = `${sessionId}:${callId}`;
    this.entries.delete(key);
    this.entries.set(key, { name, command });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * The `command` of one bash call, if it is still remembered.
   *
   * @param sessionId - the session the approval belongs to.
   * @param callId - the tool call the approval is about.
   * @returns the raw command, or undefined when the call is unknown.
   */
  bashCommand(sessionId: string, callId: string): string | undefined {
    const entry = this.entries.get(`${sessionId}:${callId}`);
    return entry?.name === "bash" ? entry.command : undefined;
  }

  /** How many calls are remembered (diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }
}
