// @ts-ignore - robots-parser has no bundled types
import robotsParser from 'robots-parser';
import { env } from '../../config/env';
import { safeFetchPage } from './safeFetch';

const cache = new Map<string, { allow: (url: string, ua: string) => boolean }>();

async function getRobots(origin: string) {
  if (cache.has(origin)) return cache.get(origin)!;
  const robotsUrl = `${origin}/robots.txt`;
  const res = await safeFetchPage(robotsUrl);
  const body = res.ok ? res.page.html : '';
  const parser = robotsParser(robotsUrl, body);
  const wrapper = {
    allow: (url: string, ua: string) => {
      // robots-parser returns true when disallowed info is absent, so an
      // empty/failed robots.txt correctly defaults to "allowed".
      const allowed = parser.isAllowed(url, ua);
      return allowed !== false;
    },
  };
  cache.set(origin, wrapper);
  return wrapper;
}

export async function isAllowedByRobots(targetUrl: string): Promise<boolean> {
  try {
    const u = new URL(targetUrl);
    const robots = await getRobots(u.origin);
    return robots.allow(targetUrl, env.crawler.userAgent);
  } catch {
    // If robots.txt can't be evaluated at all, err on the side of not crawling.
    return false;
  }
}
