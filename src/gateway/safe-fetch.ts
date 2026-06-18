import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { guardedLookup, isPrivateIp } from "./ssrf.js";

function blocked(host: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`Blocked target host "${host}" — private/reserved address`);
  e.code = "SSRF_BLOCKED";
  return e;
}

/**
 * Minimal HTTP client for the proxy that the SSRF guard can fully cover. Unlike
 * global `fetch`, it lets us pin DNS resolution (via a guarded `lookup`) and
 * re-validate every redirect hop, so neither DNS rebinding nor a redirect to an
 * internal address can slip past. Bodies are exposed as a stream so responses
 * are never buffered whole into memory.
 */
export interface SafeResponse {
  status: number;
  headers: IncomingMessage["headers"];
  /** Readable response body. Consume it (stream to the client or read for parsing) or call `.resume()`. */
  body: IncomingMessage;
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Allow private/loopback targets (local testing only). */
  allowPrivateTargets?: boolean;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export async function safeRequest(urlStr: string, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  const lookup = guardedLookup(opts.allowPrivateTargets ?? false);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;

  let url = new URL(urlStr);
  let method = (opts.method ?? "GET").toUpperCase();
  let body = opts.body;
  let headers = { ...opts.headers };

  for (let hop = 0; ; hop++) {
    // Node connects to a literal-IP host without calling `lookup`, so guard those here.
    // Hostnames are guarded by `lookup` at connect time (covers DNS rebinding).
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!(opts.allowPrivateTargets ?? false) && isIP(host) && isPrivateIp(host)) throw blocked(host);

    const res = await sendOnce(url, method, headers, body, lookup, timeoutMs);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (location && REDIRECT_CODES.has(status)) {
      res.resume(); // drain the redirect body
      if (hop >= maxRedirects) throw new Error("too many redirects");
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error(`redirect to non-http(s) scheme ${next.protocol}`);
      // 303, and 301/302 on an unsafe method, degrade to GET without a body (standard client behavior).
      if (status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      url = next;
      continue; // re-validated by the guarded lookup on the next connect
    }

    return { status: status || 502, headers: res.headers, body: res };
  }
}

function sendOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  lookup: ReturnType<typeof guardedLookup>,
  timeoutMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method, headers, lookup, timeout: timeoutMs }, resolve);
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

/** Read a response stream to text, capped so a huge body can't exhaust memory. */
export async function readStreamText(stream: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error("response body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
