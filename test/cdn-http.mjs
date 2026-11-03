#!/usr/bin/env node
/**
 * Offline checks for the CDN transport (`src/ilink/cdn/cdn-http.ts`).
 *
 * The reason this file exists at all: the host proxies `fetch` (DSH installs a
 * global dispatcher from the launch policy — here the macOS system proxy), that
 * proxy cannot reach `novac2c.cdn.weixin.qq.com`, and on 2026-11-03 that broke
 * both directions of WeChat media while text kept working. So the one property
 * that must never regress is: **a poisoned proxy environment does not affect
 * this transport**, and it is checked by pointing the proxy variables at a dead
 * port and making a real request.
 *
 *   node test/cdn-http.mjs
 *
 * Exits non-zero when any check fails.
 */
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// Poison the proxy environment BEFORE anything can read it. Port 1 is closed,
// so any client that honours these variables fails immediately.
process.env.HTTP_PROXY = "http://127.0.0.1:1";
process.env.HTTPS_PROXY = "http://127.0.0.1:1";
process.env.http_proxy = "http://127.0.0.1:1";
process.env.https_proxy = "http://127.0.0.1:1";
process.env.NODE_USE_ENV_PROXY = "1";
// Loopback is normally bypassed by every proxy client, which would make the
// poisoned proxy look harmless. Emptying the bypass list is what turns this
// into a real test — without it, `fetch` would "pass" too.
process.env.NO_PROXY = "";
process.env.no_proxy = "";

const { cdnRequest } = await import(join(ROOT, "lib/ilink/cdn/cdn-http.js"));
const { downloadMediaFromItem } = await import(join(ROOT, "lib/inbound-media.js"));
const { unsupportedText } = await import(join(ROOT, "lib/inbound.js"));
const { MessageItemType } = await import(join(ROOT, "lib/ilink/api/types.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}

// ---------------------------------------------------------------- a real server

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/ok") {
    res.writeHead(200, { "content-type": "application/octet-stream", "x-encrypted-param": "param-42" });
    res.end(Buffer.from([1, 2, 3, 4]));
    return;
  }
  if (url.pathname === "/echo") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "x-got": String(Buffer.concat(chunks).length) });
      res.end("ok");
    });
    return;
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/ok" });
    res.end();
    return;
  }
  if (url.pathname === "/loop") {
    res.writeHead(302, { location: "/loop" });
    res.end();
    return;
  }
  if (url.pathname === "/missing") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
    return;
  }
  if (url.pathname === "/slow") {
    setTimeout(() => { res.writeHead(200); res.end("late"); }, 2_000);
    return;
  }
  if (url.pathname === "/big") {
    res.writeHead(200);
    res.end(Buffer.alloc(4096, 7));
    return;
  }
  res.writeHead(500);
  res.end("unexpected");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------- the point of the module

const ok = await cdnRequest(`${base}/ok`);
check("a request succeeds with a dead proxy in the environment", ok.status === 200, String(ok.status));
check("the body survives", ok.body.length === 4 && ok.body[0] === 1);
check("response headers are readable", ok.headers["x-encrypted-param"] === "param-42");

// The same environment breaks `fetch` — that is what made the WeChat CDN look
// unreachable while the API host worked. Kept as a guard: if a future change
// routes media back through fetch, this file still passes, but the reason for it
// has reappeared and the comment above says why.
// The poisoned environment alone proves nothing on loopback (every client
// bypasses it), so the transport is also fenced: any use of `fetch` throws.
{
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch must not be used for WeChat CDN traffic");
  };
  let trapped = null;
  try {
    const res = await cdnRequest(`${base}/ok`);
    check("the CDN transport never calls fetch", res.status === 200, String(res.status));
  } catch (err) {
    trapped = err;
  } finally {
    globalThis.fetch = original;
  }
  check("…and still works with fetch disarmed", trapped === null, String(trapped));
}

// ---------------------------------------------------------------- uploads and errors

const post = await cdnRequest(`${base}/echo`, { method: "POST", body: Buffer.alloc(1234, 1) });
check("a POST carries its body", post.status === 200 && post.headers["x-got"] === "1234", String(post.headers["x-got"]));

const missing = await cdnRequest(`${base}/missing`);
check("a 404 is returned to the caller, not thrown", missing.status === 404 && missing.body.toString() === "nope");

const redirected = await cdnRequest(`${base}/redirect`);
check("one redirect is followed", redirected.status === 200 && redirected.body.length === 4, String(redirected.status));

let looped = null;
try {
  await cdnRequest(`${base}/loop`);
} catch (err) {
  looped = err;
}
check("a redirect loop stops instead of spinning", looped instanceof Error && looped.message.includes("too many redirects"), String(looped));

let timedOut = null;
try {
  await cdnRequest(`${base}/slow`, { timeoutMs: 100 });
} catch (err) {
  timedOut = err;
}
check("a hung socket times out with a readable message", timedOut instanceof Error && timedOut.message.includes("timed out"), String(timedOut));

let tooBig = null;
try {
  await cdnRequest(`${base}/big`, { maxBytes: 100 });
} catch (err) {
  tooBig = err;
}
check("an oversized response is refused", tooBig instanceof Error, String(tooBig));

let badUrl = null;
try {
  await cdnRequest("ftp://example.com/x");
} catch (err) {
  badUrl = err;
}
check("an unsupported protocol is refused", badUrl instanceof Error && badUrl.message.includes("protocol"), String(badUrl));

// ---------------------------------------------------------------- inbound media reports why

const noFields = await downloadMediaFromItem(
  { type: 2, image_item: { media: {} } },
  { cdnBaseUrl: base, label: "test" },
);
check("an image with no download URL says so", noFields.failure === "图片消息里没有下载地址", JSON.stringify(noFields));
check("and yields no file", noFields.imagePath === undefined);

const unreachable = await downloadMediaFromItem(
  { type: 2, image_item: { media: { full_url: "http://127.0.0.1:1/x", aes_key: Buffer.alloc(16).toString("base64") }, aeskey: "00".repeat(16) } },
  { cdnBaseUrl: base, label: "test" },
);
check("a download that fails carries the reason", typeof unreachable.failure === "string" && unreachable.failure !== "", JSON.stringify(unreachable));

// ---------------------------------------------------------------- the honest message

const text = (types) => unsupportedText({ item_list: types.map((type) => ({ type })) });
check("an image that did not arrive is not called a video", !text([MessageItemType.IMAGE]).includes("视频"), text([MessageItemType.IMAGE]));
check("a file that did not arrive mentions the attachment", text([MessageItemType.FILE]).includes("附件"), text([MessageItemType.FILE]));
check("a real video is still a video", text([MessageItemType.VIDEO]).includes("视频"), text([MessageItemType.VIDEO]));
check("voice says it could not be transcribed", text([MessageItemType.VOICE]).includes("语音"), text([MessageItemType.VOICE]));
check("nothing to say when there is no non-text item", text([]) === "");

// Keep the process from waiting on keep-alive sockets.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

if (failures.length > 0) {
  console.error(`cdn-http: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`cdn-http: ${pass} passed, 0 failed`);
