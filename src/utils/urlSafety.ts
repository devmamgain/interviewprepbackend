import dns from 'dns/promises';
import net from 'net';
import { env } from '../config/env';

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
];

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const ipLong = ipToLong(ip);
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const baseLong = ipToLong(base);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipLong & mask) === (baseLong & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
  normalizedUrl?: string;
}

/**
 * Validates that a URL is well-formed, http(s), and (in production) does not
 * resolve to a private/loopback/link-local address. This runs before every
 * fetch the crawler makes, both for the user-supplied company URL and for
 * every link discovered while crawling.
 */
export async function checkUrlIsSafeToFetch(rawUrl: string): Promise<UrlCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  }

  if (env.crawler.allowPrivateHosts) {
    // Explicit opt-in, used by the batch evaluate harness against local fixtures.
    return { ok: true, normalizedUrl: parsed.toString() };
  }

  const hostname = parsed.hostname;
  if (hostname === 'localhost') return { ok: false, reason: 'localhost is blocked' };

  if (net.isIP(hostname)) {
    if (net.isIP(hostname) === 4 && isPrivateV4(hostname)) {
      return { ok: false, reason: 'private IPv4 address blocked' };
    }
    if (net.isIP(hostname) === 6 && isPrivateV6(hostname)) {
      return { ok: false, reason: 'private IPv6 address blocked' };
    }
    return { ok: true, normalizedUrl: parsed.toString() };
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const r of records) {
      if (r.family === 4 && isPrivateV4(r.address)) {
        return { ok: false, reason: `hostname resolves to private address ${r.address}` };
      }
      if (r.family === 6 && isPrivateV6(r.address)) {
        return { ok: false, reason: `hostname resolves to private address ${r.address}` };
      }
    }
  } catch {
    return { ok: false, reason: 'DNS resolution failed' };
  }

  return { ok: true, normalizedUrl: parsed.toString() };
}
