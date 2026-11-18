/**
 * 只读生产库 / 只读生产 docker 的默认放行判据（D55）。
 *
 * 起因不是猜的：把 `~/.dsh/sessions` 里所有 `approval/asked` 按 `callId` 对回
 * `tool/call` 的 `arguments` 之后，最近 74 条审批里 **32 条是只读贴库**
 * （`docker exec workbench-workbench-1 node -e "…new DatabaseSync('/data/workbench.db',
 * { readOnly: true })…"`）、6 条是 `docker ps / logs / inspect`，剩下的才是真的要人判断的写操作。
 * 每次只读查询都要在手机上点一下，是纯摩擦。
 *
 * 判据不是"看起来像只读"，而是**可证明的只读**，任何一条不满足就照旧问人：
 *
 * 1. 命令必须能被解析成若干简单命令；看不懂的构造一律不放行 —— 子 shell、
 *    命令替换、变量展开、重定向、后台 `&`、未闭合引号。宁可多问一次。
 * 2. 每一个简单命令都必须在只读白名单里；只要有一段不是，整条不放行
 *    （`docker ps; rm -rf /` 不是"大部分只读"）。
 * 3. `docker exec` 的目标容器必须在白名单里，载荷只能是 `node -e` / `node -`
 *    的**只读贴库代码**：`readOnly: true` + 没有写 API（fs / child_process /
 *    process / eval…）+ 没有写 SQL。
 * 4. `docker run` 必须 `--rm`、每个 `-v` 都带 `:ro`、卷在白名单里、镜像是 `node`。
 *
 * 放行结果是一次性的（`allowed-once`），每次都进账本并在微信回一句 ——
 * 默认允许不等于默默允许。
 */

/** What counts as "production" for the auto-allow rules. */
export interface ReadOnlyPolicy {
  /** Containers `docker exec` may enter (empty = none). */
  readonly containers: readonly string[];
  /** Named volumes `docker run -v …:ro` may mount (empty = none). */
  readonly volumes: readonly string[];
}

export type ReadOnlyRule = "docker-read" | "docker-exec-read" | "prod-db-read" | "docker-run-ro";

export interface ReadOnlyVerdict {
  readonly allow: boolean;
  /** Why not, when `allow` is false; empty string when allowed. */
  readonly why: string;
  /** Which rule matched (allowed verdicts only). */
  readonly rule?: ReadOnlyRule;
  /** One human line for the ledger / WeChat, e.g. 「docker ps」. */
  readonly summary?: string;
  /** Containers / volumes the command touched (audit only). */
  readonly targets?: readonly string[];
}

/** The verdict for a command that is not covered by any rule. */
function deny(why: string): ReadOnlyVerdict {
  return { allow: false, why };
}

// --- shell parsing ---------------------------------------------------------

interface Segment {
  /** Simple-command words, dequoted. */
  readonly words: readonly string[];
  /** Literal stdin body for a `<<'EOF'` heredoc, when the segment had one. */
  readonly stdin?: string;
}

type ParseResult = { readonly segments: ReadonlyArray<Segment> } | { readonly error: string };

type Unit =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "op"; readonly op: ";" | "|" | "&&" | "||" }
  | { readonly kind: "heredoc"; readonly delim: string };

/**
 * Split one shell command into simple commands.
 *
 * Deliberately a *whitelist* parser: it understands quoting, `<<'EOF'` heredocs,
 * `2>&1` / `2>/dev/null`, and the four separators; everything else is a parse
 * error, which the caller turns into "ask the human". A parser that guesses is
 * worse than no automation at all.
 *
 * @param text - the raw command from the tool call.
 * @returns the segments, or the reason it could not be parsed.
 */
export function parseShellCommand(text: string): ParseResult {
  const segments: Segment[] = [];
  const pending: Array<{ readonly delim: string; readonly index: number }> = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let i = 0;

  const fail = (reason: string): { readonly error: string } => {
    const line = text.slice(0, i).split("\n").length;
    return { error: `第 ${line} 行：${reason}` };
  };
  const pushWord = (): void => {
    if (started) {
      words.push(word);
      word = "";
      started = false;
    }
  };
  const pushSegment = (): void => {
    pushWord();
    if (words.length > 0) {
      segments.push({ words });
      words = [];
    }
  };

  while (i < text.length) {
    const ch = text[i] as string;
    // Quoting is stateful across newlines on purpose: the ledger is full of
    // `node -e "…"` snippets written over several lines, and refusing them
    // would make the rule useless on the commands it exists for.
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) return fail("双引号里的反斜杠没有内容");
        // `\` + newline is a line continuation inside double quotes too.
        if (next === "\n") {
          i += 2;
          continue;
        }
        word += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        quote = null;
        i += 1;
        continue;
      }
      if (ch === "$" || ch === "`") return fail("双引号里有变量展开或命令替换");
      word += ch;
      i += 1;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      started = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      started = true;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushSegment();
      i += 1;
      // Heredoc bodies start after the line that declared them.
      for (const doc of pending.splice(0)) {
        const body: string[] = [];
        let closed = false;
        while (i <= text.length) {
          const eol = text.indexOf("\n", i);
          const line = eol < 0 ? text.slice(i) : text.slice(i, eol);
          const after = eol < 0 ? text.length : eol + 1;
          if (line === doc.delim) {
            closed = true;
            i = after;
            break;
          }
          if (eol < 0) {
            i = text.length;
            break;
          }
          body.push(line);
          i = after;
        }
        if (!closed) return fail(`heredoc 没有结束标记 ${doc.delim}`);
        const target = segments[doc.index];
        if (target === undefined) return fail("heredoc 没挂在任何命令上");
        segments[doc.index] = { ...target, stdin: body.join("\n") };
      }
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return fail("行尾有孤立的反斜杠");
      // A backslash-newline is a continuation, not a character: the command is
      // one line to the shell even when it was typed as several.
      if (next === "\n") {
        i += 2;
        continue;
      }
      word += next;
      started = true;
      i += 2;
      continue;
    }
    if (ch === "$" || ch === "`") return fail("变量展开或命令替换");
    if (ch === "(" || ch === ")") return fail("子 shell 或分组");
    if (ch === "&") {
      if (text[i + 1] === "&") {
        pushSegment();
        i += 2;
        continue;
      }
      return fail("后台执行");
    }
    if (ch === "|") {
      pushSegment();
      i += text[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === ";") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "<") {
      if (text[i + 1] !== "<") return fail("输入重定向");
      // `<<'EOF'`: only a quoted delimiter is accepted — an unquoted one makes
      // the shell expand the body, so what we read would not be what runs.
      let j = i + 2;
      if (text[j] === "-") return fail("heredoc 的 <<- 形式");
      while (text[j] === " " || text[j] === "\t") j += 1;
      const marker = text[j];
      if (marker !== "'" && marker !== '"') return fail("heredoc 的结束标记必须带引号");
      const end = text.indexOf(marker, j + 1);
      if (end < 0) return fail("heredoc 结束标记没有闭合");
      const delim = text.slice(j + 1, end);
      if (delim.length === 0) return fail("heredoc 结束标记是空的");
      pushWord();
      pending.push({ delim, index: segments.length });
      i = end + 1;
      continue;
    }
    if (ch === ">") {
      // Only the two silent-by-design forms are modelled; anything else could
      // create or truncate a file, which is a write.
      if (word === "2" && text.startsWith(">&1", i)) {
        word = "";
        started = false;
        i += 3;
        continue;
      }
      if (word === "2" && text.startsWith(">/dev/null", i)) {
        word = "";
        started = false;
        i += "/dev/null".length + 1;
        continue;
      }
      return fail("重定向");
    }
    word += ch;
    started = true;
    i += 1;
  }
  pushSegment();
  if (quote !== null) return { error: "引号没有闭合" };
  return { segments };
}

// --- per-command rules -----------------------------------------------------

/** Shell commands that only read (or do nothing outside this process). */
const SHELL_READONLY = new Set([
  "cd", "sleep", "echo", "printf", "true", ":", "ls", "cat", "head", "tail", "wc",
  "sort", "uniq", "cut", "tr", "grep", "jq", "column", "date", "pwd", "ps",
  "pgrep", "du", "df", "stat", "which", "basename", "dirname", "id", "uname",
]);

/** `docker <sub>` that only reads. */
const DOCKER_READ_SUBS = new Set([
  "ps", "logs", "inspect", "images", "stats", "top", "port", "version", "info",
  "history", "diff",
]);

/** `docker system <sub>` that only reads. */
const DOCKER_SYSTEM_READ = new Set(["df", "info"]);

/** `docker <noun> <sub>` that only reads. */
const DOCKER_NOUN_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  container: new Set(["ls", "list", "inspect", "logs", "stats", "top", "port", "diff"]),
  image: new Set(["ls", "list", "inspect", "history"]),
  volume: new Set(["ls", "list", "inspect"]),
  network: new Set(["ls", "list", "inspect"]),
  compose: new Set(["ps", "logs", "config", "top", "version", "ls"]),
};

/** Read-only shell commands that may run *inside* an allowlisted container. */
const CONTAINER_READONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "ps", "du", "stat", "df", "pgrep", "date", "pwd",
]);

// A read-only node snippet: the DB is opened `readOnly: true`, and none of the
// escape hatches that would let it write elsewhere (or reconstitute SQL) appear.
const NODE_DENY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bchild_process\b/, "child_process"],
  [/\bprocess\s*\./, "process.*"],
  [/\bglobalThis\b/, "globalThis"],
  [/\bconstructor\b/, "constructor 反射"],
  [/\beval\s*\(/, "eval()"],
  [/\bFunction\s*\(/, "Function()"],
  [/\bimport\s*\(/, "动态 import()"],
  [/\bmodule\s*\./, "module.*"],
  [/\bfs\s*\./, "fs.*"],
  [/\b(writeFile|appendFile|unlink|rmdir|mkdir|rename|copyFile|chmod|chown|symlink|truncate)/i, "文件写入 API"],
  [/\b(fetch|WebSocket)\s*\(/, "网络请求"],
  [/\b(http|https|net|dns)\s*\./, "网络模块"],
  [/\.exec\s*\(|\.run\s*\(/, "db.exec()/.run()（写）"],
  [/\b(vacuum|attach|detach|reindex)\b/i, "SQL 管理语句"],
  [/\b(insert\s+into|delete\s+from|drop\s+(table|index|view|trigger)|alter\s+table|create\s+(table|index|view|trigger)|replace\s+into)\b/i, "SQL 写语句"],
  [/\bpragma\s+\w+\s*=/i, "PRAGMA 赋值"],
];

/** `require()` is allowed for `node:sqlite` only. */
const NODE_REQUIRE_OTHER = /\brequire\s*\(\s*(?!['"]node:sqlite['"])/;

const NODE_MAX_CHARS = 20_000;

/**
 * Decide whether one `node -e` / `node -` snippet only reads.
 *
 * @param code - the snippet text.
 * @returns null when it is read-only, otherwise the reason it is not.
 */
function nodeIsReadOnly(code: string): string | null {
  if (code.trim().length === 0) return "空的 node 代码";
  if (code.length > NODE_MAX_CHARS) return "node 代码太长";
  if (!code.includes("DatabaseSync")) return "没有用 DatabaseSync";
  if (!/readOnly\s*:\s*true/i.test(code)) return "没有 readOnly: true";
  // Every opened database must be the read-only one: a snippet that opens a
  // second, writable handle is not a read-only snippet.
  const opens = [...code.matchAll(/new\s+DatabaseSync\s*\(/g)];
  if (opens.length === 0) return "没有 new DatabaseSync(";
  for (const match of opens) {
    const window = code.slice(match.index ?? 0, (match.index ?? 0) + 160);
    if (!/readOnly\s*:\s*true/i.test(window)) return "有一个 DatabaseSync 没有 readOnly: true";
  }
  for (const [re, what] of NODE_DENY) {
    if (re.test(code)) return `含有${what}`;
  }
  if (NODE_REQUIRE_OTHER.test(code)) return "require() 了 node:sqlite 以外的模块";
  return null;
}

interface SegmentVerdict {
  readonly allow: boolean;
  readonly why: string;
  readonly rule?: ReadOnlyRule;
  readonly summary?: string;
  readonly target?: string;
}

/** Classify one simple command. */
function classifySegment(segment: Segment, policy: ReadOnlyPolicy): SegmentVerdict {
  const words = segment.words;
  const cmd = words[0] ?? "";
  if (cmd === "") return { allow: false, why: "空命令" };
  if (SHELL_READONLY.has(cmd)) {
    if (cmd === "sleep" && !/^\d+(\.\d+)?$/.test(words[1] ?? "")) {
      return { allow: false, why: "sleep 的参数不是秒数" };
    }
    return { allow: true, why: "" };
  }
  if (cmd === "docker") return classifyDocker(words.slice(1), segment.stdin, policy);
  return { allow: false, why: `命令不在只读白名单：${cmd}` };
}

/** Classify a `docker …` invocation. */
function classifyDocker(
  args: readonly string[],
  stdin: string | undefined,
  policy: ReadOnlyPolicy,
): SegmentVerdict {
  const first = args[0] ?? "";
  if (first === "") return { allow: false, why: "docker 没有子命令" };
  if (first.startsWith("-")) return { allow: false, why: "docker 的全局参数" };

  if (first === "exec") return classifyDockerExec(args.slice(1), stdin, policy);
  if (first === "run") return classifyDockerRun(args.slice(1), stdin, policy);

  if (first === "system") {
    const sub = args[1] ?? "";
    return DOCKER_SYSTEM_READ.has(sub)
      ? { allow: true, why: "", rule: "docker-read", summary: `docker system ${sub}` }
      : { allow: false, why: `docker system ${sub} 不是只读` };
  }
  const noun = DOCKER_NOUN_READ[first];
  if (noun !== undefined) {
    let i = 1;
    if (first === "compose" && (args[i] === "-f" || args[i] === "--file")) i += 2;
    const sub = args[i] ?? "";
    return noun.has(sub)
      ? { allow: true, why: "", rule: "docker-read", summary: `docker ${first} ${sub}` }
      : { allow: false, why: `docker ${first} ${sub} 不是只读` };
  }
  if (DOCKER_READ_SUBS.has(first)) {
    return { allow: true, why: "", rule: "docker-read", summary: `docker ${first}` };
  }
  return { allow: false, why: `docker ${first} 不是只读子命令` };
}

/** Classify `docker exec <flags> <container> <cmd…>`. */
function classifyDockerExec(
  args: readonly string[],
  stdin: string | undefined,
  policy: ReadOnlyPolicy,
): SegmentVerdict {
  let i = 0;
  while (i < args.length) {
    const word = args[i] ?? "";
    if (!word.startsWith("-")) break;
    if (!["-i", "-t", "-it", "-ti", "--interactive", "--tty"].includes(word)) {
      return { allow: false, why: `docker exec 的参数 ${word}` };
    }
    i += 1;
  }
  const container = args[i] ?? "";
  i += 1;
  if (container === "") return { allow: false, why: "docker exec 没有容器名" };
  if (!policy.containers.includes(container)) {
    return { allow: false, why: `${container} 不在生产容器白名单里` };
  }
  const inner = args.slice(i);
  const head = inner[0] ?? "";
  if (head === "node") {
    const code = nodePayload(inner.slice(1), stdin);
    if ("error" in code) return { allow: false, why: code.error };
    const bad = nodeIsReadOnly(code.text);
    if (bad !== null) return { allow: false, why: `容器内 node 不是只读：${bad}` };
    return {
      allow: true, why: "", rule: "prod-db-read",
      summary: `docker exec ${container} 只读查询`, target: container,
    };
  }
  if (CONTAINER_READONLY.has(head)) {
    return {
      allow: true, why: "", rule: "docker-exec-read",
      summary: `容器内只读命令（${container}：${head}）`, target: container,
    };
  }
  return { allow: false, why: `容器内命令不在只读白名单：${head}` };
}

/** Classify `docker run <flags> <image> <cmd…>`. */
function classifyDockerRun(
  args: readonly string[],
  stdin: string | undefined,
  policy: ReadOnlyPolicy,
): SegmentVerdict {
  let i = 0;
  let mounted: string | undefined;
  let sawRm = false;
  while (i < args.length) {
    const word = args[i] ?? "";
    if (!word.startsWith("-")) break;
    if (word === "--rm") {
      sawRm = true;
      i += 1;
      continue;
    }
    if (word === "-v" || word === "--volume") {
      const spec = args[i + 1] ?? "";
      if (!spec.endsWith(":ro")) return { allow: false, why: "docker run 的挂载不是只读（缺 :ro）" };
      const source = spec.slice(0, spec.lastIndexOf(":")).split(":")[0] ?? "";
      if (!policy.volumes.includes(source)) {
        return { allow: false, why: `${source} 不在生产卷白名单里` };
      }
      mounted = source;
      i += 2;
      continue;
    }
    if (word === "--name") {
      i += 2;
      continue;
    }
    return { allow: false, why: `docker run 的参数 ${word}` };
  }
  if (!sawRm) return { allow: false, why: "docker run 没有 --rm" };
  const image = args[i] ?? "";
  i += 1;
  if (!/^(node|node:[0-9][\w.-]*)$/.test(image)) {
    return { allow: false, why: `镜像不是 node：${image}` };
  }
  const inner = args.slice(i);
  const head = inner[0] ?? "";
  if (head !== "node") return { allow: false, why: `docker run 里只放行 node：${head}` };
  const code = nodePayload(inner.slice(1), stdin);
  if ("error" in code) return { allow: false, why: code.error };
  const bad = nodeIsReadOnly(code.text);
  if (bad !== null) return { allow: false, why: `node 不是只读：${bad}` };
  return {
    allow: true, why: "", rule: "docker-run-ro",
    summary: `docker run --rm -v ${mounted ?? "卷"} 只读查询`,
    ...(mounted === undefined ? {} : { target: mounted }),
  };
}

/** Extract the `node` payload: `-e <code>`, `--eval <code>`, or `-` from stdin. */
function nodePayload(args: readonly string[], stdin: string | undefined): { text: string } | { error: string } {
  const [first] = args;
  if (first === "-e" || first === "--eval") {
    const text = args[1];
    return text === undefined ? { error: "node -e 没有代码" } : { text };
  }
  if (first === "-") {
    return stdin === undefined ? { error: "node - 没有 stdin 内容" } : { text: stdin };
  }
  return { error: `node 的载荷不是 -e 或 -：${first ?? "（空）"}` };
}

/**
 * Decide whether one bash command is production-read-only.
 *
 * @param command - the raw `command` argument of a bash tool call.
 * @param policy - which containers / volumes count as production.
 * @returns the verdict; `allow: false` means "ask the human like before".
 */
export function classifyReadOnly(command: string, policy: ReadOnlyPolicy): ReadOnlyVerdict {
  const text = command.trim();
  if (text.length === 0) return deny("空命令");
  if (text.length > 100_000) return deny("命令太长");

  const parsed = parseShellCommand(text);
  if ("error" in parsed) return deny(`解析不了：${parsed.error}`);
  if (parsed.segments.length === 0) return deny("没有命令");

  const hits: Array<{ rule: ReadOnlyRule; summary: string; target?: string }> = [];
  for (let index = 0; index < parsed.segments.length; index += 1) {
    const segment = parsed.segments[index] as Segment;
    const verdict = classifySegment(segment, policy);
    if (!verdict.allow) return deny(`第 ${index + 1} 段：${verdict.why}`);
    if (verdict.rule !== undefined && verdict.summary !== undefined) {
      hits.push({
        rule: verdict.rule,
        summary: verdict.summary,
        ...(verdict.target === undefined ? {} : { target: verdict.target }),
      });
    }
  }
  if (hits.length === 0) return deny("没有只读的生产库 / docker 命令");

  const primary = hits.find((hit) => hit.rule === "prod-db-read") ?? hits.find((hit) => hit.rule === "docker-run-ro") ?? hits[0]!;
  const targets = [...new Set(hits.flatMap((hit) => (hit.target === undefined ? [] : [hit.target])))];
  return {
    allow: true,
    why: "",
    rule: primary.rule,
    summary: [...new Set(hits.map((hit) => hit.summary))].join("；").slice(0, 160),
    targets,
  };
}

/** The label shown on the card / ledger for one rule. */
export function ruleLabel(rule: ReadOnlyRule): string {
  switch (rule) {
    case "prod-db-read": return "只读生产库";
    case "docker-read": return "只读 docker";
    case "docker-exec-read": return "容器内只读";
    case "docker-run-ro": return "只读挂载读库";
  }
}
