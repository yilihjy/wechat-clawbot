/**
 * CDN transport for the WeChat C2C endpoints — deliberately **not** `fetch`.
 *
 * `fetch` in this host is proxied: DSH installs a global undici dispatcher from
 * the proxy policy it can see, and on this machine that is the macOS system
 * proxy (127.0.0.1:15556). The app process holds live connections to it while
 * its launch environment carries no proxy variables at all — which is why the
 * "it must be the shell environment" theory was wrong.
 *
 * That proxy forwards `ilinkai.weixin.qq.com` (text messages arrive) but cannot
 * reach `novac2c.cdn.weixin.qq.com` (measured 2026-11-03: a connect timeout,
 * repeatedly). The CDN is the only way either direction of media works, so both
 * sides broke at once and both looked inexplicable:
 *
 * - outbound: `send_wechat_file` failed with `fetch failed` on every size
 *   (PNG, JPEG, even 120 KB) while text kept flowing;
 * - inbound: the photo the owner sent at 17:34 failed to download the same way,
 *   the error was logged and swallowed, and the phone was told
 *   "收到视频消息，暂不支持处理".
 *
 * `node:https` never consults the system proxy nor undici's dispatcher, so these
 * two legs go direct: the host resolves as usual, connects itself, and the
 * request carries a hard deadline that also covers a stalled lookup (a plain
 * socket `timeout` only starts once a socket exists, which is how an upload once
 * hung with no error at all).
 */
import http from "node:http";
import https from "node:https";

/** What one CDN request produced. */
export interface CdnResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** How many times to follow a redirect (CDN downloads sometimes 302 to another shard). */
const MAX_REDIRECTS = 3;

/**
 * One request to a CDN URL, bypassing every proxy the host might apply.
 *
 * Throws only on transport problems (DNS, connect, timeout, aborted); HTTP
 * statuses are returned for the caller to interpret — the upload path treats
 * 4xx and 5xx differently and needs to see them.
 */
export function cdnRequest(
  url: string,
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: Buffer;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    /** Internal: hops left (see MAX_REDIRECTS). */
    readonly redirectsLeft?: number;
  } = {},
): Promise<CdnResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error(`invalid CDN url: ${url}`));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Promise.reject(new Error(`unsupported CDN protocol: ${parsed.protocol}`));
  }
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const redirectsLeft = options.redirectsLeft ?? MAX_REDIRECTS;
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise<CdnResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const headers: Record<string, string | number> = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers["content-length"] = options.body.length;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        timeout: timeoutMs,
        // Covers the connect phase and a stalled resolver too; `timeout` alone
        // starts only once a socket exists.
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string" && method === "GET") {
          res.resume();
          if (redirectsLeft <= 0) {
            finish(() => reject(new Error(`too many redirects: ${parsed.toString()}`)));
            return;
          }
          const next = new URL(location, parsed);
          finish(() =>
            resolve(
              cdnRequest(next.toString(), {
                method,
                ...(options.headers === undefined ? {} : { headers: options.headers }),
                timeoutMs,
                ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
                redirectsLeft: redirectsLeft - 1,
              }),
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (options.maxBytes !== undefined && total > options.maxBytes) {
            // `destroy()` without an error: passing one here emits an unhandled
            // 'error' on the socket after the promise has settled.
            res.destroy();
            finish(() => reject(new Error(`CDN response larger than ${options.maxBytes} bytes`)));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
        res.on("error", (err) => finish(() => reject(err)));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`CDN request timed out after ${timeoutMs} ms (${parsed.hostname})`));
    });
    req.on("error", (err) => {
      // The AbortSignal deadline surfaces as a bare AbortError; say what it means.
      const timedOut = err.name === "AbortError" || /aborted/i.test(err.message);
      finish(() =>
        reject(timedOut ? new Error(`CDN request timed out after ${timeoutMs} ms (${parsed.hostname})`) : err),
      );
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
