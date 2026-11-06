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
  captureWithFallback,
  rejectCapture,
  undoCapture,
  captureLedgerDraft,
  captureReceipt,
  shortId,
  SHORT_TEXT_CHARS,
  PERSONAL_MIN_CHARS,
} = await import(join(ROOT, "lib/capture.js"));

// The suite checks both sides of the switch; keep the ambient environment from
// deciding which one runs.
delete process.env.WORKBENCH_BROWSER_CAPTURE;

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

// The host-browser fallback is on unless the setting or the env says otherwise.
const { browserCaptureFromEnv, normalizeConfig } = await import(join(ROOT, "lib/config.js"));
check("browser capture is on when the env is unset", browserCaptureFromEnv(undefined) === true);
check("browser capture is on for an empty env", browserCaptureFromEnv("") === true);
for (const off of ["0", "false", "off", "no", " OFF "]) {
  check(`browser capture is off for ${JSON.stringify(off)}`, browserCaptureFromEnv(off) === false);
}
check("browser capture is on for other env values", browserCaptureFromEnv("1") === true && browserCaptureFromEnv("yes") === true);
check(
  "the setting keeps an explicit switch",
  normalizeConfig({ browserCapture: false }).browserCapture === false
    && normalizeConfig({ browserCapture: true }).browserCapture === true,
);

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
equal("article biz falls back to og:url when var biz is empty", article.biz, "MzA5");
check("short link input keeps its own url when the page has no canonical", extractArticle("<p>x</p>", "https://example.com/a").url === "https://example.com/a");
check("short link input has no biz", extractArticle("<p>x</p>", "https://mp.weixin.qq.com/s/xxxx").biz === null);

// biz: the page's own declaration wins, and the value is URL-decoded.
equal(
  "biz from var biz with spaces and a short quote",
  extractArticle('<script>var  biz ="MzA5%3D%3D";</script>', LONG).biz,
  "MzA5==",
);
equal(
  "biz from var biz when the page has no og:url",
  extractArticle('<script>var biz = "MzA5MTIz%2Babc";</script>', "https://mp.weixin.qq.com/s/Short").biz,
  "MzA5MTIz+abc",
);
equal(
  "biz from og:url",
  extractArticle(
    `<meta property="og:url" content="https://mp.weixin.qq.com/s?__biz=MzA5%3D%3D&amp;mid=1&amp;idx=1&amp;sn=x" />`,
    "https://mp.weixin.qq.com/s/Short",
  ).biz,
  "MzA5==",
);
equal("biz from the source URL", extractArticle("<p>x</p>", LONG).biz, "MzA5");
check("a short link has no biz to report", extractArticle("<p>x</p>", "https://mp.weixin.qq.com/s/abc").biz === null);

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
equal("payload is a personal-library capture", payload.libraryScope, "personal");
equal("payload carries the 公众号 biz", payload.accountExternalId, "MzA5");
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

// WeChat's verification shell returns 200 with a little text — and must not be filed (D25).
const beforeShell = calls.length;
const shell = await captureUrl(
  LONG,
  CONFIG,
  stub([
    {
      match: () => true,
      reply: () =>
        new Response(
          '<html><head><title>微信公众平台</title></head><body><div class="weui-msg__title">环境异常</div><p>完成验证后即可继续访问。</p></body></html>',
          { status: 200 },
        ),
    },
  ]),
);
check("a verification shell is refused", shell.ok === false && shell.kind === "fetch");
check("its receipt says verification is needed", captureReceipt(shell).includes("验证"));
check("nothing was POSTed for it", calls.slice(beforeShell).every((call) => !call.url.endsWith("/captures")), JSON.stringify(calls.slice(beforeShell).map((c) => c.url)));

const shellByUrl = await captureUrl(
  "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=abc&target_url=x",
  CONFIG,
  stub([{ match: () => true, reply: () => new Response("<html><body><div id=\"js_content\"><p>veri</p></div></body></html>", { status: 200 }) }]),
);
check("a captcha redirect is refused even with a body", shellByUrl.ok === false && shellByUrl.kind === "fetch");

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

// ------------------------------------------- personal library + browser fallback (D4=A / D6)

const BROWSER_ENDPOINT = "http://127.0.0.1:9999/api/v1/captures/browser";
const SIX_HUNDRED = `<html><head>
<meta property="og:title" content="六百字" />
<meta property="og:url" content="https://mp.weixin.qq.com/s?__biz=MzA5&amp;mid=2656000&amp;idx=1&amp;sn=abc123" />
</head><body><div id="js_content"><p>${"字".repeat(600)}</p></div></body></html>`;
const needsManual = (chars = 600) =>
  okResponse(
    {
      outcome: "needs_manual",
      libraryScope: "personal",
      chars,
      admission: { admit: false, chars, reason: "too_short", detail: `可见正文 ${chars} 字 < ${PERSONAL_MIN_CHARS}` },
      capture: { id: "http-short", status: "pending", title: "六百字" },
    },
    201,
  );
const browserAccepted = (id, title, chars = 1200) =>
  okResponse(
    {
      outcome: "accepted",
      libraryScope: "personal",
      chars,
      capture: { id, status: "accepted", title },
      sourceArticleId: "sa-browser",
    },
    201,
  );

// HTTP fetch failed: the workbench's host browser is the only way to get the page.
calls.length = 0;
const afterFetchFailure = await captureWithFallback(
  CONFIG,
  LONG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => { throw new Error("ENETUNREACH"); } },
    { match: (url) => url.endsWith("/api/v1/captures/browser"), reply: () => browserAccepted("browser-1", "浏览器版") },
  ]),
);
check(
  "an HTTP failure still reaches the browser",
  afterFetchFailure.ok === true && afterFetchFailure.via === "browser",
  JSON.stringify(afterFetchFailure),
);
check("a successful browser capture is not degraded", afterFetchFailure.ok && afterFetchFailure.degraded === false);
equal("the browser result has an id", afterFetchFailure.ok ? shortId(afterFetchFailure.id) : "", "browse");
equal("the browser request goes to the workbench", calls.at(-1).url, BROWSER_ENDPOINT);
equal("the browser request body is just the URL", JSON.parse(calls.at(-1).init.body), { url: LONG });
equal("the browser request carries the bearer", calls.at(-1).init.headers.authorization, "Bearer tok");
equal("the browser request is a POST", calls.at(-1).init.method, "POST");

// A page that clears D6 is filed by HTTP and never opens the browser.
const NINE_HUNDRED = SIX_HUNDRED.replace("字".repeat(600), "字".repeat(900));
calls.length = 0;
const normalPersonal = await captureWithFallback(
  CONFIG,
  LONG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(NINE_HUNDRED, { status: 200 }) },
    {
      match: (url) => url.endsWith("/api/v1/extension/captures"),
      reply: () =>
        okResponse({
          outcome: "accepted",
          libraryScope: "personal",
          chars: 900,
          capture: { id: "http-long", status: "accepted", title: "九百字" },
          sourceArticleId: "sa-http",
        }),
    },
  ]),
);
check("a normal personal capture stays on HTTP", normalPersonal.ok && normalPersonal.via === "http" && normalPersonal.degraded === false, JSON.stringify(normalPersonal));
equal("no browser request for a long page", calls.length, 2);
check("its receipt says 个人库 without a browser line", captureReceipt(normalPersonal).includes("已进个人库") && !captureReceipt(normalPersonal).includes("浏览器补抓"), captureReceipt(normalPersonal));

// A 600-char HTTP body cannot pass D6; the workbench says needs_manual, so the
// bridge asks the host browser for the real page.
calls.length = 0;
const browserAfterShort = await captureWithFallback(
  CONFIG,
  LONG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(SIX_HUNDRED, { status: 200 }) },
    { match: (url) => url.endsWith("/api/v1/extension/captures"), reply: () => needsManual() },
    { match: (url) => url.endsWith("/api/v1/captures/browser"), reply: () => browserAccepted("browser-2", "浏览器版") },
  ]),
);
check(
  "a 600-char HTTP page triggers the browser",
  browserAfterShort.ok === true && browserAfterShort.via === "browser",
  JSON.stringify(browserAfterShort),
);
equal("the browser is asked for the same URL", JSON.parse(calls[2].init.body).url, LONG);
const browserReceipt = captureReceipt(browserAfterShort);
check("a browser capture receipt says the browser helped", browserReceipt.includes("↻ 浏览器补抓成功"), browserReceipt);
check("a personal-library capture says 个人库", browserReceipt.includes("已进个人库"), browserReceipt);
const plainPersonal = {
  ok: true,
  id: "abcdef12-0000",
  title: "六百字",
  chars: 1200,
  duplicate: false,
  short: false,
  status: "accepted",
  url: LONG,
  via: "http",
  degraded: false,
  outcome: "accepted",
  libraryScope: "personal",
};
check(
  "a browser receipt stays within twice the plain receipt",
  browserReceipt.length <= captureReceipt(plainPersonal).length * 2,
  `${browserReceipt.length} vs ${captureReceipt(plainPersonal).length}`,
);

// The browser is also tried when HTTP says needs_manual; if it fails too, the
// receipt must call it a degradation, not a success.
calls.length = 0;
const degraded = await captureWithFallback(
  CONFIG,
  LONG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(SIX_HUNDRED, { status: 200 }) },
    { match: (url) => url.endsWith("/api/v1/extension/captures"), reply: () => needsManual() },
    {
      match: (url) => url.endsWith("/api/v1/captures/browser"),
      reply: () => okResponse({ error: { code: "provider_unavailable", message: "browser-assist is not configured" } }, 502),
    },
  ]),
);
check(
  "both sources failing is degraded",
  degraded.ok === true && degraded.via === "http" && degraded.degraded === true,
  JSON.stringify(degraded),
);
check("the browser failure is kept for the receipt", degraded.ok && degraded.browserError?.includes("provider_unavailable"), degraded.browserError);
const degradedReceipt = captureReceipt(degraded);
check("the degraded receipt says so", degradedReceipt.includes("已降级") && degradedReceipt.includes("手动处理"), degradedReceipt);
check("the degraded receipt still explains admission", degradedReceipt.includes("正文 600 字不足 800"), degradedReceipt);
check("the degraded receipt does not claim admission", !degradedReceipt.includes("已进个人库"), degradedReceipt);

// An unreadable page plus a dead browser is a degraded failure (not a success).
calls.length = 0;
const bothDown = await captureWithFallback(
  CONFIG,
  LONG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response("", { status: 502 }) },
    {
      match: (url) => url.endsWith("/api/v1/captures/browser"),
      reply: () => okResponse({ error: { code: "provider_unavailable", message: "browser-assist is not configured" } }, 400),
    },
  ]),
);
check("a failed page and a failed browser are a degraded failure", bothDown.ok === false && bothDown.degraded === true, JSON.stringify(bothDown));
check("its receipt says it is degraded", captureReceipt(bothDown).includes("已降级"), captureReceipt(bothDown));

// WORKBENCH_BROWSER_CAPTURE=0 is the global kill switch: no browser request at all.
const savedBrowserEnv = process.env.WORKBENCH_BROWSER_CAPTURE;
process.env.WORKBENCH_BROWSER_CAPTURE = "0";
try {
  calls.length = 0;
  const envOff = await captureWithFallback(
    CONFIG,
    LONG,
    stub([
      { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(SIX_HUNDRED, { status: 200 }) },
      { match: (url) => url.endsWith("/api/v1/extension/captures"), reply: () => needsManual() },
    ]),
  );
  check("the env kill switch keeps the HTTP result", envOff.ok && envOff.via === "http", JSON.stringify(envOff));
  equal("the env kill switch sends no browser request", calls.length, 2);
} finally {
  if (savedBrowserEnv === undefined) delete process.env.WORKBENCH_BROWSER_CAPTURE;
  else process.env.WORKBENCH_BROWSER_CAPTURE = savedBrowserEnv;
}

// The settings flag is the same switch for one config object.
calls.length = 0;
const configOff = await captureWithFallback(
  { ...CONFIG, browserCapture: false },
  LONG,
  stub([
    { match: (url) => url.includes("mp.weixin.qq.com"), reply: () => new Response(SIX_HUNDRED, { status: 200 }) },
    { match: (url) => url.endsWith("/api/v1/extension/captures"), reply: () => needsManual() },
  ]),
);
equal("browserCapture:false sends no browser request", calls.length, 2);
const manualReceipt = captureReceipt(configOff);
check(
  "a needs_manual receipt explains the admission reason",
  manualReceipt.includes("已放收件箱") && manualReceipt.includes("正文 600 字不足 800"),
  manualReceipt,
);

// A declared-huge response is refused before it is read (a phone link can point anywhere).
const huge = await captureUrl(
  "https://example.com/huge",
  CONFIG,
  stub([
    {
      match: () => true,
      reply: () =>
        new Response("<html>never read</html>", {
          status: 200,
          headers: { "content-length": "99000000" },
        }),
    },
  ]),
);
check("an oversized page is refused", huge.ok === false && huge.kind === "fetch");
check("its receipt says nothing could be read", captureReceipt(huge).includes("抓不到正文"));

// ---------------------------------------------------------------- the ledger line (D28)

{
  const filed = { ok: true, id: "cap-9", title: "一篇", chars: 900, duplicate: false, short: false, status: "pending", url: "https://e.x/a" };
  const draft = captureLedgerDraft(filed, "https://e.x/a", "入库");
  check("a filed capture becomes an undoable ledger line", draft.undo?.kind === "capture" && draft.undo.captureId === "cap-9");
  check("the ledger line names the title", draft.undo?.title === "一篇");
  check("the ledger line carries the command that filed it", draft.command === "入库" && draft.result === "ok");

  const dup = captureLedgerDraft({ ...filed, duplicate: true }, "https://e.x/a", "采集");
  check("a duplicate says so", dup.summary.includes("本来就有"), dup.summary);
  check("a duplicate is still undoable", dup.undo?.kind === "capture");
  check("a bare link is recorded under its own command", dup.command === "采集");

  const short = captureLedgerDraft({ ...filed, short: true }, "https://e.x/a", "采集");
  check("a short page is flagged for the timeline", short.args?.short === true);

  const failed = captureLedgerDraft({ ok: false, kind: "fetch", message: "抓不到正文", url: "u" }, "https://e.x/a", "入库");
  check("a failed capture has no undo", failed.undo === undefined);
  check("a failed capture keeps the reason", failed.summary === "抓不到正文" && failed.result === "failed");
}

// ---------------------------------------------------------------- undoing a capture (D30)

// The workbench answers 200 with alreadyRejected for a second undo, 409 once the
// capture was accepted, and (until the change lands) a bare 404 for the route.
const rejectStub = (status, body) =>
  stub([{ match: (url) => url.includes("/reject"), reply: () => (body === undefined ? new Response("", { status }) : okResponse(body, status)) }]);

calls.length = 0;
const undone = await rejectCapture("cap-1234", CONFIG, rejectStub(200, { ok: true }));
check("a rejected capture is reported as done", undone.ok === true, JSON.stringify(undone));
check("the undo calls the extension reject route", calls[0].url === "http://127.0.0.1:9999/api/v1/extension/captures/cap-1234/reject", calls[0].url);
check("the undo is a POST", calls[0].init.method === "POST");
check("the undo carries the token", String(calls[0].init.headers.authorization) === "Bearer tok");

const again = await rejectCapture("cap-1234", CONFIG, rejectStub(200, { ok: true, alreadyRejected: true }));
check("an already-rejected capture says so", again.ok === true && again.already === true);

const conflict = await rejectCapture("cap-1234", CONFIG, rejectStub(409, { error: { code: "conflict", message: "already accepted" } }));
check("an accepted capture cannot be undone", conflict.ok === false && conflict.kind === "conflict", JSON.stringify(conflict));
check("the conflict message keeps the server's words", conflict.message.includes("already accepted"), conflict.message);

const missingRoute = await rejectCapture("cap-1234", CONFIG, rejectStub(404));
check("a bare 404 means the workbench has no reject route", missingRoute.ok === false && missingRoute.kind === "not-implemented", JSON.stringify(missingRoute));
check("that message tells the owner what to do instead", missingRoute.message.includes("收件箱"), missingRoute.message);

const missingCapture = await rejectCapture("cap-1234", CONFIG, rejectStub(404, { error: { code: "not_found", message: "no such capture" } }));
check("a specific 404 means the capture is gone", missingCapture.ok === false && missingCapture.kind === "not-found", JSON.stringify(missingCapture));

// The real workbench answers every unknown /api/v1 path with this exact body
// (measured 2026-11-02 23:59), so it must NOT be read as "no such capture".
const generic = await rejectCapture("cap-1234", CONFIG, rejectStub(404, { error: { code: "not_found", message: "not found" } }));
check("the workbench's generic 404 means it cannot reject", generic.ok === false && generic.kind === "not-implemented", JSON.stringify(generic));
check("and it does not claim the capture is missing", !generic.message.includes("没有这条"), generic.message);

const methodNotAllowed = await rejectCapture("cap-1234", CONFIG, rejectStub(405));
check("405 also means the route is not there", methodNotAllowed.ok === false && methodNotAllowed.kind === "not-implemented");

const downWorkbench = await rejectCapture("cap-1234", CONFIG, async () => { throw new Error("ECONNREFUSED"); });
check("a workbench that is down is a network failure", downWorkbench.ok === false && downWorkbench.kind === "network", JSON.stringify(downWorkbench));

const noToken = await rejectCapture("cap-1234", { ...CONFIG, token: "  " });
check("without a token nothing is attempted", noToken.ok === false && noToken.kind === "config");

// ------------------------------------------- withdrawing personal material (D16)

const withdrawReply = (status, body) =>
  stub([{ match: (url) => url.includes("/withdraw"), reply: () => (body === undefined ? new Response("", { status }) : okResponse(body, status)) }]);

calls.length = 0;
const withdrawn = await undoCapture("cap-1234", CONFIG, withdrawReply(200, {
  ok: true,
  sourceArticleId: "sa-9",
  removedDocuments: 3,
}));
check("withdraw 200 is a successful undo", withdrawn.ok === true && withdrawn.via === "withdraw", JSON.stringify(withdrawn));
check("the withdraw result names the material", withdrawn.ok && withdrawn.sourceArticleId === "sa-9" && withdrawn.removedDocuments === 3);
check("the undo calls the withdraw route", calls[0].url === "http://127.0.0.1:9999/api/v1/extension/captures/cap-1234/withdraw", calls[0].url);
check("withdraw is a POST with the bearer", calls[0].init.method === "POST" && String(calls[0].init.headers.authorization) === "Bearer tok");
check("withdraw does not fall back when it succeeded", calls.length === 1);

calls.length = 0;
const cited = await undoCapture("cap-1234", CONFIG, withdrawReply(409, {
  error: { code: "conflict", message: "source is already cited by articles", details: { articles: ["art-1", "art-2"] } },
}));
check("a cited material cannot be withdrawn", cited.ok === false && cited.kind === "conflict", JSON.stringify(cited));
check("the conflict lists the citing articles", cited.ok === false && cited.articles?.length === 2, JSON.stringify(cited));
check("the conflict message counts the articles", cited.message.includes("已被 2 篇文章引用"), cited.message);
check("a cited conflict does not fall back to reject", calls.length === 1);

calls.length = 0;
const missingWithdraw = await undoCapture("cap-1234", CONFIG, stub([
  { match: (url) => url.includes("/withdraw"), reply: () => new Response("", { status: 404 }) },
  { match: (url) => url.includes("/reject"), reply: () => okResponse({ ok: true }, 200) },
]));
check("a missing withdraw route falls back to reject", missingWithdraw.ok === true && missingWithdraw.via === "reject", JSON.stringify(missingWithdraw));
equal("the fallback order is withdraw then reject", calls.map((call) => (call.url.includes("/withdraw") ? "withdraw" : "reject")), ["withdraw", "reject"]);

calls.length = 0;
const unaccepted = await undoCapture("cap-1234", CONFIG, stub([
  { match: (url) => url.includes("/withdraw"), reply: () => okResponse({ error: { code: "conflict", message: "capture has not been accepted yet" } }, 409) },
  { match: (url) => url.includes("/reject"), reply: () => okResponse({ ok: true, alreadyRejected: true }, 200) },
]));
check("a 409 without articles falls back to reject", unaccepted.ok === true && unaccepted.via === "reject" && unaccepted.already === true, JSON.stringify(unaccepted));

// ---------------------------------------------------------------- report


if (failures.length > 0) {
  console.error(`capture: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`capture: ${pass} passed, 0 failed`);
