import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF guard for the proxy target. The gateway fetches a caller-supplied URL
 * and relays the response, so without this an agent could make it reach cloud
 * metadata (169.254.169.254), localhost admin, or internal services and
 * exfiltrate the result.
 *
 * We block literal private/reserved IPs and resolve hostnames so a public name
 * pointing at a private address is also caught. Residual risk: DNS rebinding
 * between this check and `fetch` re-resolving — acceptable for this MVP; a full
 * fix pins the resolved IP into the connection.
 */

function isPrivateV4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT 100.64/10
  );
}

function isPrivateV6(ip: string): boolean {
  const v = ip.toLowerCase().split("%")[0]!; // strip zone id
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true; // fe80::/10
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

/** True if a literal IP is in a private/reserved/loopback range. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an IP we understand → block
}

/**
 * Resolve `urlStr` and decide whether it must be blocked. Returns true (block)
 * for loopback names, literal private IPs, and hostnames that resolve to any
 * private address, or anything unparseable/unresolvable.
 */
export async function isBlockedTarget(urlStr: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(urlStr).hostname;
  } catch {
    return true;
  }
  // URL keeps IPv6 hosts in brackets — strip them for net.isIP.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (isIP(bare)) return isPrivateIp(bare);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  try {
    const addrs = await lookup(bare, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // unresolvable → block
  }
}
