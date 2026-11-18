#!/usr/bin/env node
/**
 * Offline checks for the read-only auto-allow rule (`src/read-only.ts`, D55).
 *
 * This file is the safety net for a piece of code that answers approvals
 * without a human. Two kinds of cases matter equally:
 *
 *   - the commands that SHOULD be granted (the exact shapes the ledger shows),
 *   - the commands that must never be, including the same shapes with one
 *     character of write smuggled in (`; rm`, `$(`, `>`, a writable
 *     DatabaseSync, a second `require`).
 *
 * Every deny is cheap (the card is sent as before); a wrong allow is not. When
 * adding a case, prefer the awkward ones.
 *
 *   node test/readonly.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const { classifyReadOnly, parseShellCommand, ruleLabel } = await import(join(ROOT, "lib/read-only.js"));
const { ToolCallIndex } = await import(join(ROOT, "lib/tool-calls.js"));

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

const POLICY = {
  containers: ["workbench-workbench-1"],
  volumes: ["workbench_workbench-data"],
};

function allowed(name, command, rule) {
  const verdict = classifyReadOnly(command, POLICY);
  check(name, verdict.allow === true, verdict.why);
  if (rule !== undefined) equal(`${name} — rule`, verdict.rule, rule);
  return verdict;
}

function denied(name, command, whyPart) {
  const verdict = classifyReadOnly(command, POLICY);
  check(name, verdict.allow === false, `unexpectedly allowed: ${verdict.summary ?? ""}`);
  if (whyPart !== undefined) {
    check(`${name} — reason mentions ${whyPart}`, verdict.why.includes(whyPart), verdict.why);
  }
  return verdict;
}

// ---------------------------------------------------------------- reads (D55)

allowed("docker ps", "docker ps", "docker-read");
allowed("docker ps with filters and a format", "docker ps -a --filter name=comfyui --format '{{.Names}}'", "docker-read");
allowed("docker logs", "docker logs --tail 200 workbench-workbench-1", "docker-read");
allowed("docker inspect", "docker inspect workbench-workbench-1", "docker-read");
allowed("docker images", "docker images --format '{{.Repository}}:{{.Tag}}'", "docker-read");
allowed("docker system df through head", "docker system df | head -5", "docker-read");
allowed("docker container ls", "docker container ls", "docker-read");
allowed("docker volume ls", "docker volume ls", "docker-read");
allowed("docker compose ps", "docker compose -f deploy/workbench/docker-compose.yml ps", "docker-read");
allowed("docker exec ls", "docker exec workbench-workbench-1 ls /data", "docker-exec-read");

// Shell quoting note: these snippets are embedded in '…' words, so the JS
// itself uses double quotes. (A code sample that needs single quotes gets its
// own double-quoted shell word below.)
const nodeEval = (code) => `docker exec workbench-workbench-1 node -e '${code}'`;
const db = (body) =>
  'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/workbench.db",{readOnly:true});' + body;
const READ_CODE = db('console.log(db.prepare("SELECT count(*) AS c FROM articles").get());');

allowed("a read-only sqlite query inside the container", nodeEval(READ_CODE), "prod-db-read");
allowed("...even when the code is double-quoted", `docker exec workbench-workbench-1 node -e "${
  "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/workbench.db',{readOnly:true});console.log(db.prepare('SELECT 1').get())"
}"`, "prod-db-read");
allowed("PRAGMA table_info is a read", nodeEval(db('console.log(db.prepare("PRAGMA table_info(articles)").all())')), "prod-db-read");

const heredoc = `docker exec -i workbench-workbench-1 node - <<'EOF' 2>&1 | tail -8
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/workbench.db", { readOnly: true });
const q = (s) => db.prepare(s).all();
console.log(q("SELECT slug, status FROM articles LIMIT 5"));
EOF`;
allowed("the heredoc shape the ledger is full of", heredoc, "prod-db-read");

allowed(
  "a sleep in front does not change what the command is",
  `sleep 5; docker exec -i workbench-workbench-1 node -e '${READ_CODE}'`,
  "prod-db-read",
);
allowed(
  "a cd in front neither",
  `cd ~/workspace/global-seo && docker exec workbench-workbench-1 node -e '${READ_CODE}'`,
  "prod-db-read",
);
allowed(
  "a multi-line double-quoted payload (the shape the ledger actually has)",
  `docker exec workbench-workbench-1 node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/data/workbench.db',{readOnly:true});
console.log(db.prepare('select 1').get());
"`,
  "prod-db-read",
);
allowed(
  "echoing a banner around a query is still a query",
  `echo '--- prod claim_labels ---'; docker exec -i workbench-workbench-1 node -e '${READ_CODE}'`,
  "prod-db-read",
);
allowed(
  "a backslash-continued command is one line to the shell",
  `docker run --rm \\
  -v workbench_workbench-data:/data:ro \\
  node:26 node -e '${READ_CODE}'`,
  "docker-run-ro",
);
allowed(
  "docker run with --rm and a read-only volume",
  `docker run --rm -v workbench_workbench-data:/data:ro node:26-bookworm-slim node -e '${READ_CODE}'`,
  "docker-run-ro",
);

// ---------------------------------------------------------------- refuses to read as read-only

denied("a write subcommand", "docker rm -f workbench-workbench-1", "docker rm");
denied("container file deletion", "docker exec workbench-workbench-1 rm -rf /data", "rm");
denied("container shell", "docker exec workbench-workbench-1 sh -c 'ls /data'", "sh");
denied("a container outside the allowlist", "docker exec other-container node -e 'console.log(1)'", "白名单");
denied("a docker exec flag that changes the environment", "docker exec -e X=1 workbench-workbench-1 node -e 'x'", "-e");
denied("an unquoted heredoc (the shell would expand it)", "docker exec c node - <<EOF\necho hi\nEOF", "引号");
denied("python instead of node", "docker exec workbench-workbench-1 python - <<'PY'\nprint(1)\nPY", "python");

// The same read shape, with one thing changed into a write.
denied(
  "a writable DatabaseSync",
  nodeEval('const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/workbench.db");console.log(db.prepare("SELECT 1").get())'),
  "readOnly",
);
denied(
  "db.exec() is a write channel",
  nodeEval(db('db.exec("DELETE FROM articles")')),
  "exec",
);
denied(
  "a DELETE written through prepare()",
  nodeEval(db('db.prepare("DELETE FROM articles").all()')),
  "SQL",
);
denied(
  "a second, writable handle",
  nodeEval(db('const rw=new DatabaseSync("/tmp/x.db");console.log(rw)')),
  "readOnly",
);
denied(
  "child_process through require",
  nodeEval(db('require("child_process").execSync("rm -rf /data")')),
  "child_process",
);
denied(
  "fs writes",
  nodeEval(db('require("node:fs").writeFileSync("/data/x","")')),
  "文件写入",
);
denied(
  "fs through a destructured require",
  nodeEval(db('const fs=require("node:fs");fs.appendFileSync("/data/x","")')),
  "fs",
);
denied(
  "process access",
  nodeEval(db("console.log(process.env.HOME)")),
  "process",
);
denied(
  "eval",
  nodeEval(db('eval("1")')),
  "eval",
);
denied(
  "PRAGMA assignment",
  nodeEval(db('db.prepare("PRAGMA journal_mode = WAL").all()')),
  "PRAGMA",
);
denied("node without a read-only database at all", nodeEval("console.log(1)"), "DatabaseSync");

// Shell-level escapes: the parser refuses what it cannot model.
denied("a second segment that deletes", "docker ps; rm -rf /", "rm");
denied("command substitution", "docker ps $(rm -rf /)", "命令替换");
denied("backticks", "docker ps `rm -rf /`", "变量展开");
denied("a pipeline into an interpreter", "docker logs workbench-workbench-1 | bash", "bash");
denied("a network fetch in the same chain", "docker ps && curl http://example.com", "curl");
denied("output redirection", "docker logs workbench-workbench-1 > /tmp/out", "重定向");
denied("backgrounding", "docker ps & rm -rf /", "后台");
denied("sudo", "sudo docker ps", "sudo");
denied("an unterminated quote", "docker ps '", "引号没有闭合");
denied("a variable as a command", "$CMD ps", "变量展开");
denied("a plain write command", "git push origin main", "git");

// The write file the model actually tried once (`cat > /tmp/q.cjs <<'EOF'`).
denied(
  "writing a helper script first",
  "cat > /tmp/q.cjs <<'EOF'\nconst x = 1\nEOF",
  "重定向",
);

// docker run has to prove the mount, the image and the payload.
denied("a read-write volume", "docker run --rm -v workbench_workbench-data:/data node:26 node -e 'x'", ":ro");
denied(
  "a volume outside the allowlist",
  "docker run --rm -v /tmp/copy:/data:ro node:26 node -e 'console.log(1)'",
  "白名单",
);
denied(
  "a privileged container",
  "docker run --rm --privileged node:26 node -e 'console.log(1)'",
  "--privileged",
);
denied(
  "an image that is not node",
  "docker run --rm -v workbench_workbench-data:/data:ro python:3 python -c 'print(1)'",
  "node",
);
denied(
  "docker run without --rm",
  `docker run -v workbench_workbench-data:/data:ro node:26 node -e '${READ_CODE}'`,
  "--rm",
);

// Empty / nonsense.
denied("an empty command", "", "空");
denied("docker alone", "docker", "子命令");

// ---------------------------------------------------------------- parsing

{
  const parsed = parseShellCommand(heredoc);
  check("the heredoc parses", !("error" in parsed), JSON.stringify(parsed));
  if (!("error" in parsed)) {
    equal("two segments: the exec and tail", parsed.segments.length, 2);
    check("the body became stdin of the exec", parsed.segments[0].stdin?.includes("readOnly: true") === true,
      JSON.stringify(parsed.segments[0]));
  }
}
{
  const parsed = parseShellCommand("docker ps 2>&1 | head -3");
  check("2>&1 is not a redirect to refuse", !("error" in parsed), JSON.stringify(parsed));
}

// ---------------------------------------------------------------- labels

equal("prod-db label", ruleLabel("prod-db-read"), "只读生产库");
equal("docker label", ruleLabel("docker-read"), "只读 docker");

// ---------------------------------------------------------------- the tool-call index

{
  const index = new ToolCallIndex(3);
  index.record("s1", { type: "tool/call", data: { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "docker ps" }) } });
  equal("a recorded bash call is found", index.bashCommand("s1", "c1"), "docker ps");
  equal("another session does not see it", index.bashCommand("s2", "c1"), undefined);
  equal("an unknown call is undefined", index.bashCommand("s1", "nope"), undefined);
  index.record("s1", { type: "tool/call", data: { callId: "c2", name: "edit", arguments: JSON.stringify({ command: "docker ps" }) } });
  equal("a non-bash call is not a command", index.bashCommand("s1", "c2"), undefined);
  index.record("s1", { type: "tool/result", data: { callId: "c3", name: "bash", arguments: "{}" } });
  equal("only tool/call events are indexed", index.bashCommand("s1", "c3"), undefined);
  index.record("s1", { type: "tool/call", data: { callId: "c4", name: "bash", arguments: "{not json" } });
  equal("unparseable arguments are skipped", index.bashCommand("s1", "c4"), undefined);
  index.record("s1", { type: "tool/call", data: { callId: "c5", name: "bash", arguments: "{}" } });
  equal("arguments without a command are skipped", index.bashCommand("s1", "c5"), undefined);
  // The window: the oldest entry goes first.
  index.record("s1", { type: "tool/call", data: { callId: "c6", name: "bash", arguments: JSON.stringify({ command: "docker logs x" }) } });
  equal("the window is bounded", index.size, 3);
  equal("the oldest call was evicted", index.bashCommand("s1", "c1"), undefined);
  equal("the newest call is kept", index.bashCommand("s1", "c6"), "docker logs x");
}

if (failures.length > 0) {
  console.error(`readonly: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`readonly: ${pass} passed, 0 failed`);
