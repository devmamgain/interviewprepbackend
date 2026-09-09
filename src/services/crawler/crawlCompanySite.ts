import { env } from '../../config/env';
import { sleep } from '../../utils/retry';
import type { RetrievalLogEntry } from '../../utils/validation/kitSchema';
import { safeFetchPage } from './safeFetch';
import { isAllowedByRobots } from './robots';
import { extractLinks, extractReadableText, extractTitle, rankLinks } from './linkRank';

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

export interface CrawlResult {
  aboutPages: CrawledPage[];
  hiringPages: CrawledPage[];
  log: RetrievalLogEntry[];
}

/**
 * Crawls a company site to find (a) what the company does and (b) how they
 * hire. Instead of guessing a fixed path list, it fetches the homepage,
 * ranks every discovered on-site link by how "about-like" or "hiring-like"
 * its path and anchor text are, and fetches the best few candidates of each
 * kind. Every attempted URL - fetched, skipped, or failed - is recorded in
 * the retrieval log so the run stays auditable.
 */
export async function crawlCompanySite(companyUrl: string): Promise<CrawlResult> {
  const log: RetrievalLogEntry[] = [];
  const aboutPages: CrawledPage[] = [];
  const hiringPages: CrawledPage[] = [];

  const record = (url: string, status: RetrievalLogEntry['status'], reason?: string) => {
    log.push({ url, kind: 'company_site', status, reason });
  };

  // 1. Homepage
  const robotsOkHome = await isAllowedByRobots(companyUrl);
  if (!robotsOkHome) {
    record(companyUrl, 'skipped', 'disallowed by robots.txt');
    return { aboutPages, hiringPages, log };
  }

  const home = await safeFetchPage(companyUrl);
  if (!home.ok) {
    record(companyUrl, 'failed', home.reason);
    return { aboutPages, hiringPages, log };
  }
  record(companyUrl, 'ok');
  aboutPages.push({ url: companyUrl, title: extractTitle(home.page.html), text: extractReadableText(home.page.html) });

  // 2. Rank on-site links for "hiring" and "about" intent.
  const links = extractLinks(home.page.html, home.page.finalUrl);
  const hiringCandidates = rankLinks(links, 'hiring');
  const aboutCandidates = rankLinks(links, 'about');

  const budget = Math.max(0, env.crawler.maxPagesPerSite - 1); // homepage already spent one
  const hiringBudget = Math.min(hiringCandidates.length, Math.ceil(budget * 0.6));
  const aboutBudget = Math.min(aboutCandidates.length, budget - hiringBudget);

  const toFetch: Array<{ url: string; purpose: 'hiring' | 'about' }> = [
    ...hiringCandidates.slice(0, hiringBudget).map((l) => ({ url: l.url, purpose: 'hiring' as const })),
    ...aboutCandidates.slice(0, aboutBudget).map((l) => ({ url: l.url, purpose: 'about' as const })),
  ];

  const alreadyFetched = new Set([companyUrl]);

  for (const target of toFetch) {
    if (alreadyFetched.has(target.url)) continue;
    alreadyFetched.add(target.url);

    await sleep(env.crawler.minDelayMs); // be a polite crawler

    const robotsOk = await isAllowedByRobots(target.url);
    if (!robotsOk) {
      record(target.url, 'skipped', 'disallowed by robots.txt');
      continue;
    }

    const res = await safeFetchPage(target.url);
    if (!res.ok) {
      // Skip and report - one bad page must not fail the run.
      record(target.url, 'failed', res.reason);
      continue;
    }

    record(target.url, 'ok');
    const page: CrawledPage = {
      url: target.url,
      title: extractTitle(res.page.html),
      text: extractReadableText(res.page.html),
    };
    if (target.purpose === 'hiring') hiringPages.push(page);
    else aboutPages.push(page);
  }

  return { aboutPages, hiringPages, log };
}
