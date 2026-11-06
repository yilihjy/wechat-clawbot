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
import type { LedgerDraft } from "./ledger.js";
import { browserCaptureFromEnv } from "./config.js";
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

/**
 * D6 personal-library admission: the workbench auto-accepts a page only when its
 * visible text reaches this many characters. Below it the capture stays pending
 * for a human — and the HTTP page is worth re-reading in the host browser.
 */
export const PERSONAL_MIN_CHARS = 800;

/** The browser fallback opens a real browser page; it is much slower than a fetch. */
const BROWSER_TIMEOUT_MS = 60_000;

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
  /**
   * Let the workbench re-read a page with the host browser when the HTTP page
   * cannot pass personal-library admission. Omitted means on; the environment
   * variable `WORKBENCH_BROWSER_CAPTURE=0` is a global kill switch.
   */
  readonly browserCapture?: boolean;
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
  /** 公众号 biz (the account's stable id), when this page names one. */
  readonly biz: string | null;
  readonly text: string;
  /** The page with scripts and styles removed, or "" when it would not fit. */
  readonly html: string;
}

/** Decode the URL-encoding a biz can carry (`%3D` etc.) and trim it. */
function decodeBiz(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let value = raw.trim();
  if (value === "") return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    // A malformed escape is still more useful than dropping the account id.
  }
  value = value.trim();
  return value === "" ? null : value;
}

/** `__biz=` in an og:url or the URL we were given, decoded once. */
function bizFromUrl(url: string | null): string | null {
  if (url === null) return null;
  const raw = /[?&]__biz=([^&#\s]+)/u.exec(url)?.[1];
  return decodeBiz(raw ?? null);
}

/**
 * The 公众号 biz: the page's own `var biz = "…"` wins, because it is the
 * canonical value; `og:url` and finally the source URL are fallbacks. A short
 * `https://mp.weixin.qq.com/s/<sn>` link carries no biz at all.
 */
function bizOf(html: string, ogUrl: string | null, sourceUrl: string): string | null {
  const declared = /var\s+biz\s*=\s*(?:htmlDecode\(\s*)?["']([^"']*)["']/u.exec(html)?.[1];
  const fromHtml = decodeBiz(declared ?? null);
  if (fromHtml !== null) return fromHtml;
  return bizFromUrl(ogUrl) ?? bizFromUrl(sourceUrl);
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
    biz: bizOf(html, ogUrl, sourceUrl),
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

/** What the workbench decided for a capture (personal library, migration 45). */
export type CaptureOutcome = "accepted" | "pending" | "needs_manual" | "duplicate";

/** The D6 admission verdict, when the workbench returned one. */
export interface CaptureAdmission {
  readonly admit?: boolean;
  readonly chars?: number;
  readonly reason?: string | null;
  readonly detail?: string | null;
}

/** Which source produced the capture that landed. */
export type CaptureVia = "http" | "browser";

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
      /** `http` for the plain fetch, `browser` when the workbench re-read the page. */
      readonly via: CaptureVia;
      /** True when both the HTTP attempt and the browser fallback failed to file it. */
      readonly degraded: boolean;
      readonly outcome?: CaptureOutcome;
      readonly admission?: CaptureAdmission;
      readonly libraryScope?: "personal" | "site";
      readonly sourceArticleId?: string | null;
      /** Why the browser fallback failed, kept for the receipt. */
      readonly browserError?: string;
    }
  | {
      readonly ok: false;
      readonly kind: CaptureFailureKind;
      readonly message: string;
      readonly url: string;
      readonly via: CaptureVia;
      readonly degraded: boolean;
      /** Why the browser fallback failed, kept for the receipt. */
      readonly browserError?: string;
    };

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

/** The shape the two capture endpoints answer with (only the fields a receipt needs). */
type CaptureResponse = {
  outcome?: string;
  chars?: number;
  images?: number;
  duplicate?: boolean;
  admission?: CaptureAdmission | null;
  sourceArticleId?: string | null;
  libraryScope?: string;
  textChars?: number;
  capture?: { id?: string; status?: string; title?: string | null } | null;
  error?: { code?: string; message?: string; details?: unknown };
};

/** True when the workbench said "I already have this one". */
function isDuplicate(body: CaptureResponse): boolean {
  return body.duplicate === true || body.outcome === "duplicate";
}

/** Keep only outcomes the bridge knows how to explain. */
function outcomeOf(body: CaptureResponse): CaptureOutcome | undefined {
  const value = body.outcome;
  return value === "accepted" || value === "pending" || value === "needs_manual" || value === "duplicate"
    ? value
    : undefined;
}

/** The admission block, when the response carried a usable one. */
function admissionOf(body: CaptureResponse): CaptureAdmission | undefined {
  return body.admission !== null && typeof body.admission === "object" ? body.admission : undefined;
}

/** Visible characters, counted the way D6 counts them (whitespace excluded). */
export function visibleChars(text: string): number {
  return text.replace(/\s+/gu, "").length;
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
      // Personal library (migration 45): the workbench decides admission by D6;
      // the account id is what lets it group articles under one 公众号.
      libraryScope: "personal",
      accountExternalId: extracted.biz,
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
      via: "http",
      degraded: false,
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
      via: "http",
      degraded: false,
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
      via: "http",
      degraded: false,
      message: `${code}：${body.error?.message ?? `HTTP ${res.status}`}${hint}`,
    };
  }
  const id = body.capture?.id;
  if (typeof id !== "string" || id === "") {
    return {
      ok: false,
      kind: "server",
      url: extracted.url,
      via: "http",
      degraded: false,
      message: "工作台没有返回 capture id",
    };
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
    via: "http",
    degraded: false,
    outcome: outcomeOf(body),
    admission: admissionOf(body),
    libraryScope: body.libraryScope === "personal" ? "personal" : undefined,
    sourceArticleId: typeof body.sourceArticleId === "string" ? body.sourceArticleId : null,
  };
}

/**
 * Ask the workbench to re-read a URL with the host browser (D4=A).
 *
 * The workbench owns extraction and admission; this side only sends the URL.
 * This is slow (a real browser page), hence its own longer timeout.
 */
async function postBrowserCapture(
  config: CaptureConfig,
  url: string,
  fetchImpl: FetchLike,
): Promise<CaptureResult> {
  const endpoint = `${config.baseUrl.replace(/\/+$/u, "")}/api/v1/captures/browser`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      url,
      via: "browser",
      degraded: false,
      message: `浏览器补抓失败：连不上工作台（${config.baseUrl}）：${String((err as Error).message ?? err).slice(0, 120)}`,
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
      url,
      via: "browser",
      degraded: false,
      message: `浏览器补抓失败：工作台返回了非 JSON（HTTP ${res.status}）：${raw.slice(0, 120)}`,
    };
  }
  if (!res.ok || body.error !== undefined) {
    const code = body.error?.code ?? `http_${res.status}`;
    const hint = res.status === 401 ? "（token 无效或过期，重新配对后再试）" : "";
    return {
      ok: false,
      kind: res.status === 401 ? "config" : "http",
      url,
      via: "browser",
      degraded: false,
      message: `浏览器补抓失败：${code}：${body.error?.message ?? `HTTP ${res.status}`}${hint}`,
    };
  }
  const id = body.capture?.id;
  if (typeof id !== "string" || id === "") {
    return {
      ok: false,
      kind: "server",
      url,
      via: "browser",
      degraded: false,
      message: "浏览器补抓失败：工作台没有返回 capture id",
    };
  }
  const chars = typeof body.chars === "number"
    ? body.chars
    : typeof body.textChars === "number"
      ? body.textChars
      : (body.admission?.chars ?? 0);
  return {
    ok: true,
    id,
    title: body.capture?.title ?? null,
    chars,
    duplicate: isDuplicate(body),
    short: chars < SHORT_TEXT_CHARS,
    status: body.capture?.status ?? (body.outcome ?? "pending"),
    url,
    via: "browser",
    degraded: false,
    outcome: outcomeOf(body),
    admission: admissionOf(body),
    libraryScope: body.libraryScope === "personal" ? "personal" : undefined,
    sourceArticleId: typeof body.sourceArticleId === "string" ? body.sourceArticleId : null,
  };
}

/** Why the HTTP attempt is not good enough, and the browser should try. */
type BrowserRetry = "unreadable" | "verification" | "too_short" | "needs_manual";

/** D6 reasons the browser can actually fix; anything else (aggregator) needs a human. */
const BROWSER_RETRY_REASONS: ReadonlySet<string> = new Set([
  "too_short",
  "verification_shell",
  "shell_page",
]);

/** Browser fallback is on unless the config or the environment switched it off. */
export function browserCaptureAllowed(config: CaptureConfig, env = process.env): boolean {
  if (config.browserCapture === false) return false;
  return browserCaptureFromEnv(env.WORKBENCH_BROWSER_CAPTURE);
}

/** The HTTP fast path plus the reason the browser might do better (if any). */
async function attemptHttp(
  url: string,
  config: CaptureConfig,
  fetchImpl: FetchLike,
): Promise<{ result: CaptureResult; retry: BrowserRetry | null }> {
  if (!config.enabled || config.token.trim() === "") {
    return {
      result: {
        ok: false,
        kind: "config",
        url,
        via: "http",
        degraded: false,
        message: "采集没开：设置里打开 captureEnabled，并填上工作台的 capture token",
      },
      retry: null,
    };
  }
  let page: FetchedPage;
  try {
    page = await fetchPage(url, fetchImpl);
  } catch (err) {
    return {
      result: {
        ok: false,
        kind: "network",
        url,
        via: "http",
        degraded: false,
        message: `打不开这个链接：${String((err as Error).message ?? err).slice(0, 120)}`,
      },
      retry: "unreadable",
    };
  }
  if (page.status < 200 || page.status >= 300 || page.html.trim() === "") {
    // D25: nothing is filed for a page we could not read; the receipt says why.
    return {
      result: {
        ok: false,
        kind: "fetch",
        url,
        via: "http",
        degraded: false,
        message: `抓不到正文（HTTP ${page.status}${page.status === 412 ? "，公众号要验证" : ""}）`,
      },
      retry: "unreadable",
    };
  }
  if (isVerificationShell(page)) {
    return {
      result: {
        ok: false,
        kind: "fetch",
        url,
        via: "http",
        degraded: false,
        message: "抓不到正文（公众号要求先验证，等一下再试）",
      },
      retry: "verification",
    };
  }
  const extracted = extractArticle(page.html, page.url);
  if (extracted.text.trim() === "") {
    return {
      result: {
        ok: false,
        kind: "fetch",
        url: extracted.url,
        via: "http",
        degraded: false,
        message: "抓不到正文（页面里没有可读文字）",
      },
      retry: "unreadable",
    };
  }
  logger.info(
    `capture: ${extracted.url} title=${extracted.title ?? "(none)"} chars=${extracted.text.length} html=${extracted.html.length}`,
  );
  const result = await postCapture(config, extracted, fetchImpl);
  const tooShort = visibleChars(extracted.text) < PERSONAL_MIN_CHARS;
  let retry: BrowserRetry | null = null;
  if (result.ok) {
    // A needs_manual verdict whose reason the browser can fix is the clearest
    // signal; a short extraction is the pre-emptive one (D6 is 800 chars).
    if (result.outcome === "needs_manual") {
      const reason = result.admission?.reason;
      if (typeof reason === "string" && BROWSER_RETRY_REASONS.has(reason)) retry = "needs_manual";
    }
    if (retry === null && tooShort) retry = "too_short";
  } else if (tooShort && result.kind !== "config") {
    retry = "too_short";
  }
  return { result, retry };
}

/**
 * Read one URL and file it through the HTTP fast path only.
 *
 * Kept as the pure HTTP attempt (`#入库` and the link fast path call
 * `captureWithFallback`); the result still carries `via: "http"` so receipts
 * stay honest about where it came from.
 */
export async function captureUrl(
  url: string,
  config: CaptureConfig,
  fetchImpl: FetchLike = fetch,
): Promise<CaptureResult> {
  return (await attemptHttp(url, config, fetchImpl)).result;
}

/**
 * File one URL, letting the workbench re-read it in the host browser when the
 * HTTP page cannot pass personal-library admission.
 *
 * The HTTP attempt still runs first and still reports its own failure; the
 * browser is only a second source. When both fail, `degraded` is true and the
 * receipt says the capture can be handled by hand in the workbench inbox.
 */
export async function captureWithFallback(
  config: CaptureConfig,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<CaptureResult> {
  const attempt = await attemptHttp(url, config, fetchImpl);
  if (attempt.retry === null || !browserCaptureAllowed(config)) return attempt.result;
  logger.info(`capture: ${url} browser fallback (${attempt.retry})`);
  const browser = await postBrowserCapture(config, url, fetchImpl);
  if (browser.ok) return browser;
  const landed = attempt.result.ok
    && (attempt.result.outcome === "accepted" || attempt.result.outcome === "duplicate");
  if (landed) return { ...attempt.result, browserError: browser.message };
  return { ...attempt.result, degraded: true, browserError: browser.message };
}

// ------------------------------------------------------------------ the ledger

/**
 * The ledger line for one capture (D28), whichever way it came in.
 *
 * `#入库` and a bare link are the same act from the owner's side, so they file
 * the same record — including the undo. Sharing it here is what keeps "撤销刚才
 * 那个链接" working for the common case (a pasted link), not just the typed one.
 */
export function captureLedgerDraft(
  result: CaptureResult,
  url: string,
  command: "入库" | "采集",
): LedgerDraft {
  if (!result.ok) {
    return { command, args: { url, failure: result.kind }, result: "failed", summary: result.message };
  }
  const title = result.title?.trim() || "(没有标题)";
  return {
    command,
    args: { url, captureId: result.id, duplicate: result.duplicate, short: result.short },
    result: "ok",
    summary: result.duplicate ? `收件箱里本来就有《${title}》` : `入库《${title}》`,
    undo: { kind: "capture", captureId: result.id, url, title: result.title },
  };
}

// ------------------------------------------------------------------ undoing

/** Why a rejection did not happen. */
export type RejectFailure = "config" | "network" | "not-found" | "not-implemented" | "conflict" | "server";

/** What undoing a `#入库` learned from the workbench. */
export type RejectResult =
  | { readonly ok: true; readonly id: string; readonly already: boolean }
  | { readonly ok: false; readonly kind: RejectFailure; readonly message: string };

/**
 * Take one capture back out of the inbox (D30).
 *
 * The endpoint is the extension-side `POST /captures/:id/reject` (OpenSpec
 * change `workbench-capture-reject`). Until that ships the route 404s with no
 * body — and that is exactly the ambiguity this separates: a workbench that
 * answers with `{error}` means "no such capture", while a bare 404 or a 405
 * means "this workbench cannot reject yet". Saying the wrong one would send the
 * owner looking through the inbox for a capture that is right there.
 */
export async function rejectCapture(
  captureId: string,
  config: CaptureConfig,
  fetchImpl: FetchLike = fetch,
): Promise<RejectResult> {
  if (!config.enabled || config.token.trim() === "") {
    return { ok: false, kind: "config", message: "采集没开或没有 token，撤不了" };
  }
  const endpoint =
    `${config.baseUrl.replace(/\/+$/u, "")}/api/v1/extension/captures/${encodeURIComponent(captureId)}/reject`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `连不上工作台（${config.baseUrl}）：${String((err as Error).message ?? err).slice(0, 120)}`,
    };
  }
  const raw = await res.text();
  let body: { ok?: boolean; alreadyRejected?: boolean; error?: { code?: string; message?: string } } = {};
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
  } catch {
    body = {};
  }
  if (res.ok) return { ok: true, id: captureId, already: body.alreadyRejected === true };
  const detail = body.error?.message ?? (raw === "" ? `HTTP ${res.status}` : raw.slice(0, 120));
  // A workbench without this route answers with its generic API 404, and that body
  // is byte-for-byte the same as for any other unknown path under /api/v1
  // (measured: "not found", code not_found). Only a 404 that says something
  // *specific* means the capture itself is gone — otherwise "no such capture"
  // would send the owner hunting through an inbox the capture is still sitting in.
  const generic404 = res.status === 404
    && (body.error === undefined || body.error.message === undefined || body.error.message === "not found");
  if (res.status === 404 && !generic404) {
    return { ok: false, kind: "not-found", message: `工作台里没有这条（${detail}）` };
  }
  if (res.status === 404 || res.status === 405) {
    return {
      ok: false,
      kind: "not-implemented",
      message: "这个工作台还没有撤销端点（extension 侧 reject）—— 只能在收件箱里点「拒绝」",
    };
  }
  if (res.status === 409) {
    return { ok: false, kind: "conflict", message: `已经被 accepted，撤不了（${detail}）` };
  }
  return { ok: false, kind: "server", message: `${body.error?.code ?? `http_${res.status}`}：${detail}` };
}

/** What undoing a `#入库` learned from the workbench. */
export type UndoCaptureResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly already: boolean;
      /** `withdraw` is the personal-library route; `reject` is the old inbox route. */
      readonly via: "withdraw" | "reject";
      readonly sourceArticleId?: string | null;
      readonly removedDocuments?: number;
    }
  | {
      readonly ok: false;
      readonly kind: RejectFailure;
      readonly message: string;
      /** Present when the personal material is still cited by articles. */
      readonly articles?: readonly string[];
    };

type WithdrawResponse = {
  ok?: boolean;
  sourceArticleId?: string | null;
  removedDocuments?: number;
  error?: { code?: string; message?: string; details?: { articles?: unknown } };
};

/** The article ids in a withdraw 409, when the workbench listed them. */
function citedArticles(body: WithdrawResponse): string[] {
  const raw = body.error?.details?.articles;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value !== "") : [];
}

/**
 * Take one capture back out, preferring the personal-library withdraw route.
 *
 * `withdraw` is the D16 operation: a personal material that no article cites can
 * be removed (and its KB documents with it). When the route is missing (older
 * workbench), answers 409 for a capture that was never accepted, or fails for
 * any other reason, the old extension `reject` route is tried so the inbox undo
 * keeps working. A 409 that lists citing articles is final: material that is in
 * use must be unlinked in the workbench, not deleted from here.
 */
export async function undoCapture(
  captureId: string,
  config: CaptureConfig,
  fetchImpl: FetchLike = fetch,
): Promise<UndoCaptureResult> {
  if (!config.enabled || config.token.trim() === "") {
    return { ok: false, kind: "config", message: "采集没开或没有 token，撤不了" };
  }
  const endpoint =
    `${config.baseUrl.replace(/\/+$/u, "")}/api/v1/extension/captures/${encodeURIComponent(captureId)}/withdraw`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      message: `连不上工作台（${config.baseUrl}）：${String((err as Error).message ?? err).slice(0, 120)}`,
    };
  }
  const raw = await res.text();
  let body: WithdrawResponse = {};
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as WithdrawResponse);
  } catch {
    body = {};
  }
  if (res.ok) {
    return {
      ok: true,
      id: captureId,
      already: false,
      via: "withdraw",
      sourceArticleId: typeof body.sourceArticleId === "string" ? body.sourceArticleId : null,
      ...(typeof body.removedDocuments === "number" ? { removedDocuments: body.removedDocuments } : {}),
    };
  }
  const articles = citedArticles(body);
  if (res.status === 409 && articles.length > 0) {
    return {
      ok: false,
      kind: "conflict",
      message: `已被 ${articles.length} 篇文章引用，不能撤销`,
      articles,
    };
  }
  // 404/405 = the route is not there; 409 without articles = the capture was
  // never accepted. Both, and any other response, keep the old reject behaviour.
  const rejected = await rejectCapture(captureId, config, fetchImpl);
  if (!rejected.ok) return rejected;
  return { ok: true, id: captureId, already: rejected.already, via: "reject" };
}

// ------------------------------------------------------------------ the receipt

/** The short id a receipt shows: enough to find the capture, short enough for a phone. */
export function shortId(id: string): string {
  return id.replace(/-/gu, "").slice(0, 6);
}

/** Why D6 admission did not happen, in one short Chinese phrase. */
function admissionReasonText(admission: CaptureAdmission | undefined): string {
  const reason = admission?.reason ?? "";
  const chars = typeof admission?.chars === "number" ? admission.chars : undefined;
  if (reason === "too_short") {
    return chars === undefined ? `正文不足 ${PERSONAL_MIN_CHARS} 字` : `正文 ${chars} 字不足 ${PERSONAL_MIN_CHARS}`;
  }
  if (reason === "verification_shell") return "公众号要求验证，抓到的不是正文";
  if (reason === "shell_page") return "正文没有成句，疑似栏目/壳页";
  if (reason === "aggregator_page") return "疑似聚合/门户页，需要人工确认";
  if (reason === "invalid_url") return "链接不是可抓的 http(s) 页面";
  const detail = admission?.detail?.trim();
  return detail !== undefined && detail !== "" ? detail.slice(0, 80) : "自动接纳没通过";
}

/** Keep the browser's failure to one short receipt line. */
function shortBrowserError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const text = message.replace(/\s+/gu, " ").replace(/^浏览器补抓失败：/u, "").trim().slice(0, 50);
  return text === "" ? undefined : text;
}

/**
 * What the user reads back on WeChat.
 *
 * Three outcomes (D25): filed, already filed, or not filed at all — and a filed
 * page whose text is suspiciously short says so, because that is usually a
 * verification shell rather than an article. Personal-library captures add the
 * D6 admission verdict; a browser capture says so, and a failed fallback calls
 * itself a degradation instead of a success.
 */
export function captureReceipt(result: CaptureResult): string {
  if (!result.ok) {
    const head = result.kind === "config" ? "采集没配置好" : "没能入库";
    const browserError = shortBrowserError(result.browserError);
    const degraded = result.degraded
      ? `已降级：稍后可在工作台收件箱手动处理${browserError === undefined ? "" : `（浏览器补抓失败：${browserError}）`}`
      : undefined;
    return [head, result.message, degraded, "", result.url]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  const title = result.title?.trim() || "(没有标题)";
  const short = result.short ? "，正文偏短，可能抓到的是验证页" : "";
  const id = shortId(result.id);
  if (result.duplicate) {
    const library = result.libraryScope === "personal" ? "个人库" : "收件箱";
    return [
      `已经在${library}里了：《${title}》 · ${result.chars} 字 · ${id}（没有新建）`,
      ...(result.via === "browser" ? ["↻ 浏览器补抓成功"] : []),
    ].join("\n");
  }
  const lines: string[] = [];
  if (result.outcome === "needs_manual") {
    lines.push(`已放收件箱：《${title}》 · ${result.chars} 字 · ${id}`);
    lines.push(`未自动进个人库：${admissionReasonText(result.admission)}`);
  } else {
    const personal = result.libraryScope === "personal" && result.outcome === "accepted";
    const verb = result.degraded ? "已放" : "已进";
    lines.push(`${verb}${personal ? "个人库" : "收件箱"}：《${title}》 · ${result.chars} 字 · ${id}${short}`);
  }
  if (result.via === "browser") lines.push("↻ 浏览器补抓成功");
  if (result.degraded) {
    const browserError = shortBrowserError(result.browserError);
    lines.push(`已降级：稍后可在工作台收件箱手动处理${browserError === undefined ? "" : `（浏览器补抓失败：${browserError}）`}`);
  }
  return lines.join("\n");
}
