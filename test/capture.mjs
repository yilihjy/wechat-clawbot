#!/usr/bin/env node
/**
 * Offline checks for the capture fast path (`src/capture.ts`).
 *
 * The parts that break silently are all here: a `[链接]` card whose title and
 * URL are concatenated with no separator, a canonical URL that must drop the
 * tracking parameters, a body that is 3.5 MB of script tags, and the three
 * receipts D25 promises. The network is stubbed, so nothing leaves the machine.
 *
 *   node test/capture.mjs
 *
 * Exits non-zero when any check fails.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const {
  detectCapture,
  firstUrl,
  captureReady,
  decodeEntities,
  htmlToText,
  extractJsContent,
  wechatCanonical,
  extractArticle,
  trimHtml,
  captureUrl,
  captureReceipt,
  shortId,
  SHORT_TEXT_CHARS,
} = await import(join(ROOT, "lib/capture.js"));

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

// ---------------------------------------------------------------- detection

const LONG = "https://mp.weixin.qq.com/s?__biz=MzA5&mid=2656000&idx=1&sn=abc123";
const CARD = `[链接] 短短一周时间里，B站被DeepSeek狠狠入侵了${LONG}`;

equal("card -> url", detectCapture(CARD), { kind: "card", url: LONG });
equal("card with a space after the marker", detectCapture(`[链接] 某个标题 ${LONG}`).url, LONG);
equal("full-width card marker", detectCapture(`【链接】标题${LONG}`).url, LONG);
equal("bare url", detectCapture(`  ${LONG}  `), { kind: "bare", url: LONG });
equal("bare url with phone punctuation", detectCapture(`${LONG}。`).url, LONG);
check("plain text is not a capture", detectCapture("看这个怎么样") === null);
check(
  "a link inside a sentence stays a message",
  detectCapture(`帮我总结一下 ${LONG} 这篇`) === null,
);
check("a bare # is not a capture", detectCapture("#") === null);
check("null text", detectCapture(null) === null);
check("an empty card is not a capture", detectCapture("[链接] 没有链接") === null);

equal("firstUrl takes the first one", firstUrl(`a https://a.example/x b https://b.example/y`), "https://a.example/x");
equal("firstUrl trims a full stop", firstUrl("https://a.example/x。"), "https://a.example/x");
check("firstUrl on plain text", firstUrl("没有链接") === null);

check("captureReady needs the switch", captureReady({ captureEnabled: false, captureToken: "t" }) === false);
check("captureReady needs a token", captureReady({ captureEnabled: true, captureToken: "  " }) === false);
check("captureReady when both", captureReady({ captureEnabled: true, captureToken: "t" }) === true);

// ---------------------------------------------------------------- extraction

equal("named entities", decodeEntities("a &amp; b &lt;c&gt; &nbsp;d"), "a & b <c>  d");
equal("numeric entities", decodeEntities("&#20013;&#x6587;"), "中文");
check("unknown entities survive", decodeEntities("&bogus;") === "&bogus;");

equal(
  "block ends become newlines",
  htmlToText("<p>一</p><div>二</div><section>三</section>"),
  "一\n二\n三",
);
equal("br becomes a newline", htmlToText("一<br>二<br/>三"), "一\n二\n三");
equal("script content never leaks", htmlToText("<p>一</p><script>var x = '<p>秘密</p>';</script>"), "一");
equal("whitespace collapses", htmlToText("<p>  a\n\n\n   b  </p>"), "a\n\nb");

const BODY = [
  '<div class="rich_media_content" id="js_content" style="visibility: hidden;">',
  "<p>第一段文字。</p>",
  "<div><p>第二段 &amp; 实体。</p></div>",
  "</div>",
  "<div>页脚不该进正文</div>",
].join("\n");
const body = extractJsContent(BODY);
check("js_content is found", body !== null && body.includes("第一段") && body.includes("第二段"));
check("js_content stops at the matching close", body !== null && !body.includes("页脚"));
check("no js_content -> null", extractJsContent("<div>普通页面</div>") === null);

equal(
  "canonical keeps only the four identity parameters",
  wechatCanonical(`${LONG}&chksm=deadbeef&scene=21`),
  LONG,
);
check("canonical rejects a partial long link", wechatCanonical("https://mp.weixin.qq.com/s?__biz=MzA5&mid=1") === null);
check("canonical rejects another host", wechatCanonical("https://example.com/s?__biz=a&mid=1&idx=1&sn=x") === null);
check("canonical tolerates a short link", wechatCanonical("https://mp.weixin.qq.com/s/AbCdEf") === null);

const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="标题 &amp; 副题" />
<meta property="og:url" content="https://mp.weixin.qq.com/s?__biz=MzA5&amp;mid=2656000&amp;idx=1&amp;sn=abc123&amp;chksm=zz" />
<title></title>
</head><body>
${BODY}
<script>var biz = ""; var mid = 2656000; var nickname = htmlDecode("某公众号"); var ct = "1699948800";</script>
</body></html>`;

const article = extractArticle(PAGE, "https://mp.weixin.qq.com/s/ShortLink");
equal("article canonical comes from og:url", article.url, LONG);
equal("article title is decoded", article.title, "标题 & 副题");
equal("article publisher", article.publisher, "某公众号");
equal("article publishedAt is ms", article.publishedAt, 1699948800 * 1000);
check("article text has the body", article.text.includes("第一段文字") && article.text.includes("第二段 & 实体"));
check("article html drops scripts", !article.html.includes("<script>"));
check("short link input keeps its own url when the page has no canonical", extractArticle("<p>x</p>", "https://example.com/a").url === "https://example.com/a");

const big = `<p>${"字".repeat(4_000_000)}</p>`;
check("an oversized page is dropped rather than truncated", trimHtml(big) === "");
check("a normal page is kept", trimHtml("<p>x</p>") === "<p>x</p>");

// ---------------------------------------------------------------- the two calls

const CONFIG = { enabled: true, baseUrl: "http://127.0.0.1:9999/", token: "tok" };
const calls = [];
const okResponse = (body, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch stub: the page first, then the workbench. */
function stub(handlers) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const handler = handlers.find((h) => h.match(url, init));
    if (handler === undefined) throw new Error(`unexpected fetch ${url}`);
    return handler.reply(url, init);
  };
}

// Happy path: a WeChat article, filed pending.
calls.length = 0;
const happy = stub([
  { match: (url) => url === LONG || url.includes("mp.weixin.qq.com"), reply: () => new Response(PAGE, { status: 200 }) },
  {
    match: (url) => url.endsWith("/api/v1/extension/captures"),
    reply: () =>
      okResponse({ outcome: "pending", chars: 1200, capture: { id: "0f3c2b1a-1111-2222-3333-444455556666", status: "pending", title: "标题 & 副题" } }),
  },
]);
const filed = await captureUrl(LONG, CONFIG, happy);
check("capture ok", filed.ok === true, JSON.stringify(filed));
equal("capture id", filed.ok ? shortId(filed.id) : "", "0f3c2b");
check("capture is not a duplicate", filed.ok && filed.duplicate === false);
check("capture is not short", filed.ok && filed.short === false);
equal("two network calls", calls.length, 2);

const pageCall = calls[0];
check("page fetch carries a WeChat phone UA", /MicroMessenger/u.test(pageCall.init.headers["user-agent"]));
const postCall = calls[1];
equal("post goes to the configured base", postCall.url, "http://127.0.0.1:9999/api/v1/extension/captures");
equal("post is a bearer", postCall.init.headers.authorization, "Bearer tok");
equal("post is a POST", postCall.init.method, "POST");
const form = postCall.init.body;
check("body is multipart", typeof form.get === "function");
const payload = JSON.parse(form.get("payload"));
equal("payload url is canonical", payload.url, LONG);
equal("payload title", payload.title, "标题 & 副题");
equal("payload accountKind", payload.accountKind, "wechat");
check("payload has no mode (files it pending)", !("mode" in payload));
check("payload carries html", typeof payload.html === "string" && payload.html.includes("第一段"));
check("payload text is the article", payload.text.includes("第一段文字"));

equal(
  "pending receipt",
  captureReceipt(filed),
  "已进收件箱：《标题 & 副题》 · 1200 字 · 0f3c2b",
);

// A duplicate: the workbench answers with the existing capture.
const duplicate = await captureUrl(
  LONG,
  CONFIG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(PAGE, { status: 200 }) },
    {
      match: (url) => url.endsWith("/captures"),
      reply: () => okResponse({ outcome: "pending", duplicate: true, chars: 1200, capture: { id: "abcdef12-0000", status: "pending" } }, 200),
    },
  ]),
);
check("duplicate is flagged", duplicate.ok && duplicate.duplicate === true);
check("duplicate receipt says so", captureReceipt(duplicate).includes("已经在收件箱里了"));

// A short body is still filed, and the receipt warns (D25).
const short = await captureUrl(
  LONG,
  CONFIG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response("<html><body><div id=js_content><p>短</p></div></body></html>", { status: 200 }) },
    { match: (url) => url.endsWith("/captures"), reply: () => okResponse({ outcome: "pending", chars: SHORT_TEXT_CHARS - 1, capture: { id: "deadbeef-1", status: "pending" } }) },
  ]),
);
check("short body still filed", short.ok === true && short.short === true);
check("short receipt warns", captureReceipt(short).includes("正文偏短"));

// Nothing is filed when the page cannot be read (D25).
const blocked = await captureUrl(
  "https://mp.weixin.qq.com/s/Something",
  CONFIG,
  stub([{ match: () => true, reply: () => new Response("<html>wechat: please verify</html>", { status: 412 }) }]),
);
check("412 is a fetch failure", blocked.ok === false && blocked.kind === "fetch");
check("412 receipt names the verification", captureReceipt(blocked).includes("验证"));

const empty = await captureUrl(
  "https://example.com/nothing",
  CONFIG,
  stub([{ match: () => true, reply: () => new Response("<html><script>x</script></html>", { status: 200 }) }]),
);
check("a page with no text is not filed", empty.ok === false && empty.kind === "fetch");

// Config, auth and transport failures each get their own receipt.
const unconfigured = await captureUrl(LONG, { enabled: false, baseUrl: "x", token: "t" }, stub([{ match: () => true, reply: () => new Response("") }]));
check("switched off is a config failure", unconfigured.ok === false && unconfigured.kind === "config");

const unauthorized = await captureUrl(
  LONG,
  CONFIG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(PAGE, { status: 200 }) },
    { match: (url) => url.endsWith("/captures"), reply: () => okResponse({ error: { code: "unauthorized", message: "invalid or revoked token" } }, 401) },
  ]),
);
check("401 is a config failure", unauthorized.ok === false && unauthorized.kind === "config");
check("401 receipt points at pairing", captureReceipt(unauthorized).includes("重新配对"));

const offline = await captureUrl(
  LONG,
  CONFIG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(PAGE, { status: 200 }) },
    { match: (url) => url.endsWith("/captures"), reply: () => { throw new Error("ECONNREFUSED"); } },
  ]),
);
check("a dead workbench is a network failure", offline.ok === false && offline.kind === "network");
check("network receipt keeps the link", captureReceipt(offline).includes(LONG));

const noId = await captureUrl(
  LONG,
  CONFIG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(PAGE, { status: 200 }) },
    { match: (url) => url.endsWith("/captures"), reply: () => okResponse({ outcome: "pending" }) },
  ]),
);
check("a response without an id is a server failure", noId.ok === false && noId.kind === "server");

// ---------------------------------------------------------------- report

if (failures.length > 0) {
  console.error(`capture: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`capture: ${pass} passed, 0 failed`);
