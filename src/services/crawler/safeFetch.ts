import fetch from 'node-fetch';
import { env } from '../../config/env';
import { checkUrlIsSafeToFetch } from '../../utils/urlSafety';

const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const MAX_BYTES = 3 * 1024 * 1024; // 3MB is plenty for a marketing/careers page

export interface FetchedPage {
  url: string;
  finalUrl: string;
  html: string;
  status: number;
}

export type SafeFetchResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; reason: string };

/**
 * Fetches a single page defensively: validates the URL isn't private/loopback,
 * enforces a timeout, restricts to text/html-ish content types, and caps the
 * response size. Treats everything it downloads as untrusted content only
 * (never executed, never treated as instructions).
 */
export async function safeFetchPage(rawUrl: string): Promise<SafeFetchResult> {
  const check = await checkUrlIsSafeToFetch(rawUrl);
  if (!check.ok) return { ok: false, reason: check.reason || 'blocked url' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.crawler.requestTimeoutMs);

  try {
    const res = await fetch(check.normalizedUrl!, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': env.crawler.userAgent, Accept: 'text/html' },
    });

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return { ok: false, reason: `unsupported content-type: ${contentType || 'unknown'}` };
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BYTES) {
      return { ok: false, reason: 'response too large' };
    }

    // Stream-cap in case content-length was absent or lied about.
    const reader = res.body;
    let bytes = 0;
    const chunks: Buffer[] = [];
    if (reader) {
      for await (const chunk of reader as unknown as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return { ok: false, reason: 'response exceeded size cap while streaming' };
        chunks.push(chunk as Buffer);
      }
    }
    const html = Buffer.concat(chunks).toString('utf-8');

    return {
      ok: true,
      page: { url: rawUrl, finalUrl: res.url || rawUrl, html, status: res.status },
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, reason: 'request timed out' };
    return { ok: false, reason: err?.message || 'fetch failed' };
  } finally {
    clearTimeout(timeout);
  }
}
