import { sleep } from '../../utils/retry';
import { env } from '../../config/env';
import type { RetrievalLogEntry } from '../../utils/validation/kitSchema';
import { isAllowedByRobots } from '../crawler/robots';
import { safeFetchPage } from '../crawler/safeFetch';
import { extractReadableText, extractTitle } from '../crawler/linkRank';
import { searchPublicDiscussion } from './searchProvider';

export interface DiscussionPage {
  url: string;
  title: string;
  text: string;
}

export interface DiscussionResult {
  pages: DiscussionPage[];
  log: RetrievalLogEntry[];
}

const MAX_RESULTS_TO_FETCH = 4;

export async function researchPublicDiscussion(companyName: string): Promise<DiscussionResult> {
  const log: RetrievalLogEntry[] = [];
  const pages: DiscussionPage[] = [];

  const hits = await searchPublicDiscussion(companyName);
  if (hits.length === 0) {
    // "Public discussion turns up nothing at all" is an expected, handled case,
    // not a failure - the brief for it lives in coverage/brief generation,
    // which must say so honestly rather than fabricate.
    return { pages, log };
  }

  for (const hit of hits.slice(0, MAX_RESULTS_TO_FETCH)) {
    await sleep(env.crawler.minDelayMs);

    const robotsOk = await isAllowedByRobots(hit.url);
    if (!robotsOk) {
      log.push({ url: hit.url, kind: 'public_discussion', status: 'skipped', reason: 'disallowed by robots.txt' });
      continue;
    }

    const res = await safeFetchPage(hit.url);
    if (!res.ok) {
      log.push({ url: hit.url, kind: 'public_discussion', status: 'failed', reason: res.reason });
      continue;
    }

    log.push({ url: hit.url, kind: 'public_discussion', status: 'ok' });
    pages.push({ url: hit.url, title: extractTitle(res.page.html) || hit.title, text: extractReadableText(res.page.html) });
  }

  return { pages, log };
}
