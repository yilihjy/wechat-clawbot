/**
 * Capture fast path: turn a WeChat message into a workbench capture.
 *
 * Three shapes reach this module (D21/D22/D23 in `docs/wechat-bridge-plan.md`):
 *
 * - `[链接] <title><url>` — the text WeChat's own share card produces. Note the
 *   title and the URL are concatenated with no separator, so the URL is found by
 *   scanning, never by splitting on whitespace.
 * - a bare URL as the whole message;
 * - `#入库 <url>` — a command, routed by `commands.ts`, which calls this module.
 *
 * The workbench is the only place that decides what a capture becomes; this side
 * fetches the page, pulls out title/text/html, and POSTs to
 * `/api/v1/extension/captures` (multipart, one `payload` field). A capture is
 * filed **pending** — never auto-accepted — so it still shows up in the inbox and
 * stays rejectable (D30).
 *
 * Everything here is either pure (parsing, extraction, receipts) or takes its
 * `fetch` as a parameter, so the whole path is checkable without WeChat, a model,
 * or a running workbench (`test/capture.mjs`).
 */
import { logger } from "./ilink/util/logger.js";

/** How the page is read. A phone-shaped WeChat UA is what makes the article server answer with the article. */
const PAGE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
  + "Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN";

const PAGE_TIMEOUT_MS = 12_000;
const POST_TIMEOUT_MS = 20_000;

/** The workbench refuses more than this much html (4 MB); staying under it keeps the whole page. */
const MAX_HTML_BYTES = 4_000_000;

/** Largest page we are willing to read into memory at all (10 MB: articles are ~3.5 MB). */
const MAX_PAGE_BYTES = 10_000_000;

/** D25: under this many characters a capture is stored anyway, but the receipt says so. */
export const SHORT_TEXT_CHARS = 200;

/** Punctuation a phone keyboard or a chat bubble leaves at the end of a pasted URL. */
const URL_TRAILING = /[.,;:!?。，、；：！？）】》」』]+$/u;

/** What a message asks for, before any network work. */
export type CaptureTarget = {
  readonly kind: "bare" | "card";
  readonly url: string;
};

/** The first http(s) URL in a string, with chat punctuation trimmed off. */
export function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"'`\u3000]+/u.exec(text);
  if (match === null) return null;
  const url = match[0].replace(URL_TRAILING, "");
  return url === "" ? null : url;
}

/**
 * Does this message ask for a capture without naming a command?
 *
 * Only the two shapes WeChat itself produces count. A sentence that merely
 * contains a link stays a message for the agent — a pasted article inside a
 * question is a question, and stealing it would lose the question.
 */
export function detectCapture(text: string | null): CaptureTarget | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const card = /^[[【]链接[\]】]\s*/u.exec(trimmed);
  if (card !== null) {
    const url = firstUrl(trimmed.slice(card[0].length));
    return url === null ? null : { kind: "card", url };
  }
  if (/^https?:\/\/\S+$/u.test(trimmed)) {
    const url = trimmed.replace(URL_TRAILING, "");
    return url === "" ? null : { kind: "bare", url };
  }
  return null;
}

/** Whether the capture path can run at all: switched on and given a token. */
export function captureReady(config: { captureEnabled: boolean; captureToken: string }): boolean {
  return config.captureEnabled && config.captureToken.trim() !== "";
}

/** What the settings say about the workbench. */
export interface CaptureConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly token: string;
}

// ------------------------------------------------------------------ extraction

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…",
  mdash: "—", ndash: "–", middot: "·", copy: "©", reg: "®", trade: "™",
};

function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** Decode the five entities WeChat pages actually use, plus numeric ones. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_whole, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_whole, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/giu, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

/** Plain text of an HTML fragment: block ends become newlines, tags and entities go. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
  return decodeEntities(body)
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t\u00a0]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * The inner HTML of `#js_content` — the article body on a 公众号 page.
 *
 * Found by scanning sibling `<div>`s rather than by a non-greedy regex: the body
 * is many nested divs deep, so `(\/div)` would cut it at the first paragraph.
 */
export function extractJsContent(html: string): string | null {
  const open = /id=["']js_content["'][^>]*>/iu.exec(html);
  if (open === null) return null;
  const start = open.index + open[0].length;
  const tag = /<\s*(\/?)div\b[^>]*>/giu;
  tag.lastIndex = start;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return html.slice(start);
}

/** Strip the parts of a page the workbench never reads, so a 3.5 MB page fits the 4 MB limit. */
export function trimHtml(html: string): string {
  const trimmed = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  return trimmed.length > MAX_HTML_BYTES ? "" : trimmed;
}

/** Read one attribute of a `<meta>` tag, whichever order the page wrote it in. */
function metaContent(html: string, property: string): string | null {
  const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "iu");
  const found = tag.exec(html)?.[0];
  if (found === undefined) return null;
  const content = /content=["']([^"']*)["']/iu.exec(found)?.[1];
  return content === undefined ? null : decodeEntities(content);
}

/** `https://mp.weixin.qq.com/s?__biz=…&mid=…&idx=…&sn=…`, or null when the URL is not that shape. */
export function wechatCanonical(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "mp.weixin.qq.com") return null;
  const biz = parsed.searchParams.get("__biz");
  const mid = parsed.searchParams.get("mid");
  const idx = parsed.searchParams.get("idx");
  const sn = parsed.searchParams.get("sn");
  if (!biz || !mid || !idx || !sn) return null;
  return `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=${idx}&sn=${sn}`;
}

/** What one page yielded. */
export interface Extracted {
  /** Canonical URL: the long form when the page names one, else the URL we were given. */
  readonly url: string;
  readonly title: string | null;
  readonly publisher: string | null;
  readonly publishedAt: number | null;
  readonly text: string;
  /** The page with scripts and styles removed, or "" when it would not fit. */
  readonly html: string;
}

/** `var nickname = "…"` / `var nickname = htmlDecode("…")`. */
function publisherOf(html: string): string | null {
  const declared = /var\s+nickname\s*=\s*(?:htmlDecode\(\s*)?["']([^"']+)["']/u.exec(html);
  if (declared !== null) return decodeEntities(declared[1] ?? "").trim() || null;
  const alive = /<[^>]+id=["']js_name["'][^>]*>([\s\S]{0,200}?)<\//iu.exec(html);
  return alive === null ? null : htmlToText(alive[1] ?? "").trim() || null;
}

/** `var ct = "1699999999"` (unix seconds). */
function publishedAtOf(html: string): number | null {
  const declared = /var\s+ct\s*=\s*["'](\d{9,11})["']/u.exec(html);
  if (declared === null) return null;
  const seconds = Number.parseInt(declared[1] ?? "", 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Everything a capture needs, read out of one HTML document. */
export function extractArticle(html: string, sourceUrl: string): Extracted {
  const ogUrl = metaContent(html, "og:url");
  const canonical = (ogUrl === null ? null : wechatCanonical(ogUrl)) ?? wechatCanonical(sourceUrl) ?? sourceUrl;
  const ogTitle = metaContent(html, "og:title");
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  const body = extractJsContent(html);
  const text = htmlToText(body ?? html);
  return {
    url: canonical,
    title: (ogTitle ?? (titleTag === undefined ? null : htmlToText(titleTag)))?.trim() || null,
    publisher: publisherOf(html),
    publishedAt: publishedAtOf(html),
    text,
    html: trimHtml(html),
  };
}

// ------------------------------------------------------------------ the two calls

/** One page as the network returned it. */
export interface FetchedPage {
  readonly status: number;
  readonly url: string;
  readonly html: string;
}

/** Why a capture did not land, in the words the receipt uses. */
export type CaptureFailureKind = "config" | "fetch" | "network" | "http" | "server";

/** The result of trying to file one URL. */
export type CaptureResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly title: string | null;
      readonly chars: number;
      readonly duplicate: boolean;
      readonly short: boolean;
      readonly status: string;
      readonly url: string;
    }
  | { readonly ok: false; readonly kind: CaptureFailureKind; readonly message: string; readonly url: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetch one page as a phone would. Throws only on transport failures. */
export async function fetchPage(url: string, fetchImpl: FetchLike = fetch): Promise<FetchedPage> {
  const res = await fetchImpl(url, {
    headers: {
      "user-agent": PAGE_UA,
      "accept-language": "zh-CN,zh;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  // A link from a phone can point at anything, including a multi-gigabyte file.
  // Refuse on the declared length before reading a byte; chunked responses
  // without a length are bounded by the timeout and the trim below.
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    return { status: res.status, url: res.url === "" ? url : res.url, html: "" };
  }
  const html = await res.text();
  return { status: res.status, url: res.url === "" ? url : res.url, html: html.length > MAX_PAGE_BYTES ? "" : html };
}

/**
 * Is this page WeChat's "prove you are human" shell rather than the article?
 *
 * Measured 2026-11-02: fetching the same link a few times in a row redirected to
 * `mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=…&target_url=…`, which
 * returns 200 with 38 characters of text and no title. Filing that would put a
 * junk row in the inbox and lose the link (D25 says the opposite: a page we could
 * not read is not an entry).
 */
export function isVerificationShell(page: FetchedPage): boolean {
  if (/\/mp\/(wappoc_appmsgcaptcha|verify)|appmsgcaptcha/u.test(page.url)) return true;
  const head = page.html.slice(0, 4_000);
  return /环境异常|完成验证后即可继续访问|去验证|当前环境异常/u.test(head);
}

/** The shape `POST /api/v1/extension/captures` answers with (only the fields a receipt needs). */
type CaptureResponse = {
  outcome?: string;
  chars?: number;
  images?: number;
  duplicate?: boolean;
  capture?: { id?: string; status?: string; title?: string | null } | null;
  error?: { code?: string; message?: string };
};

/** True when the workbench said "I already have this one". */
function isDuplicate(body: CaptureResponse): boolean {
  return body.duplicate === true || body.outcome === "duplicate";
}

/**
 * POST one capture.
 *
 * The body is multipart because that is the only shape the endpoint parses: the
 * whole capture rides in a single `payload` JSON field, the way the browser
 * extension sends it.
 */
export async function postCapture(
  config: CaptureConfig,
  extracted: Extracted,
  fetchImpl: FetchLike = fetch,
): Promise<CaptureResult> {
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      url: extracted.url,
      title: extracted.title,
      publisher: extracted.publisher,
      publishedAt: extracted.publishedAt,
      text: extracted.text,
      html: extracted.html === "" ? null : extracted.html,
      accountKind: "wechat",
      // Filed as pending: the inbox is where a human decides (D30 keeps it rejectable).
      mode: undefined,
    }),
  );
  const endpoint = `${config.baseUrl.replace(/\/+$/u, "")}/api/v1/extension/captures`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      url: extracted.url,
      message: `连不上工作台（${config.baseUrl}）：${String((err as Error).message ?? err).slice(0, 120)}`,
    };
  }
  const raw = await res.text();
  let body: CaptureResponse = {};
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as CaptureResponse);
  } catch {
    return {
      ok: false,
      kind: "server",
      url: extracted.url,
      message: `工作台返回了非 JSON（HTTP ${res.status}）：${raw.slice(0, 120)}`,
    };
  }
  if (!res.ok) {
    const code = body.error?.code ?? `http_${res.status}`;
    const hint = res.status === 401 ? "（token 无效或过期，去工作台「信源 → 浏览器插件」重新配对，再把 token 填进设置）" : "";
    return {
      ok: false,
      kind: res.status === 401 ? "config" : "http",
      url: extracted.url,
      message: `${code}：${body.error?.message ?? `HTTP ${res.status}`}${hint}`,
    };
  }
  const id = body.capture?.id;
  if (typeof id !== "string" || id === "") {
    return { ok: false, kind: "server", url: extracted.url, message: "工作台没有返回 capture id" };
  }
  const chars = typeof body.chars === "number" ? body.chars : extracted.text.length;
  return {
    ok: true,
    id,
    title: body.capture?.title ?? extracted.title,
    chars,
    duplicate: isDuplicate(body),
    short: chars < SHORT_TEXT_CHARS,
    status: body.capture?.status ?? (body.outcome ?? "pending"),
    url: extracted.url,
  };
}

/** Read one URL and file it. The whole fast path, minus the message plumbing. */
export async function captureUrl(
  url: string,
  config: CaptureConfig,
  fetchImpl: FetchLike = fetch,
): Promise<CaptureResult> {
  if (!config.enabled || config.token.trim() === "") {
    return {
      ok: false,
      kind: "config",
      url,
      message: "采集没开：设置里打开 captureEnabled，并填上工作台的 capture token",
    };
  }
  let page: FetchedPage;
  try {
    page = await fetchPage(url, fetchImpl);
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      url,
      message: `打不开这个链接：${String((err as Error).message ?? err).slice(0, 120)}`,
    };
  }
  if (page.status < 200 || page.status >= 300 || page.html.trim() === "") {
    // D25: nothing is filed for a page we could not read; the receipt says why.
    return {
      ok: false,
      kind: "fetch",
      url,
      message: `抓不到正文（HTTP ${page.status}${page.status === 412 ? "，公众号要验证" : ""}）`,
    };
  }
  if (isVerificationShell(page)) {
    return { ok: false, kind: "fetch", url, message: "抓不到正文（公众号要求先验证，等一下再试）" };
  }
  const extracted = extractArticle(page.html, page.url);
  if (extracted.text.trim() === "") {
    return { ok: false, kind: "fetch", url: extracted.url, message: "抓不到正文（页面里没有可读文字）" };
  }
  logger.info(
    `capture: ${extracted.url} title=${extracted.title ?? "(none)"} chars=${extracted.text.length} html=${extracted.html.length}`,
  );
  return postCapture(config, extracted, fetchImpl);
}

// ------------------------------------------------------------------ the receipt

/** The short id a receipt shows: enough to find the capture, short enough for a phone. */
export function shortId(id: string): string {
  return id.replace(/-/gu, "").slice(0, 6);
}

/**
 * What the user reads back on WeChat.
 *
 * Three outcomes (D25): filed, already filed, or not filed at all — and a filed
 * page whose text is suspiciously short says so, because that is usually a
 * verification shell rather than an article.
 */
export function captureReceipt(result: CaptureResult): string {
  if (!result.ok) {
    const head = result.kind === "config" ? "采集没配置好" : "没能入库";
    return [head, result.message, "", result.url].filter((line) => line !== undefined).join("\n");
  }
  const title = result.title?.trim() || "(没有标题)";
  const short = result.short ? "，正文偏短，可能抓到的是验证页" : "";
  if (result.duplicate) {
    return `已经在收件箱里了：《${title}》 · ${result.chars} 字 · ${shortId(result.id)}（没有新建）`;
  }
  return `已进收件箱：《${title}》 · ${result.chars} 字 · ${shortId(result.id)}${short}`;
}
