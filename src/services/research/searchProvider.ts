import * as cheerio from 'cheerio';
import { env } from '../../config/env';
import { safeFetchPage } from '../crawler/safeFetch';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

/**
 * Finds public discussion of a company's interview process. Defaults to
 * scraping DuckDuckGo's no-JS HTML endpoint, which needs no API key and has
 * no meaningful rate limit for the handful of queries this app makes per
 * kit - a reasonable trade for a take-home assessment. If
 * SEARCH_PROVIDER_API_KEY is set, swap in a real provider (Bing Web Search,
 * SerpAPI, etc.) by implementing the same SearchHit[] contract here.
 */
export async function searchPublicDiscussion(companyName: string): Promise<SearchHit[]> {
  if (env.search.apiKey) {
    return searchViaConfiguredProvider(companyName);
  }
  return searchViaDuckDuckGo(companyName);
}

async function searchViaDuckDuckGo(companyName: string): Promise<SearchHit[]> {
  const query = encodeURIComponent(`${companyName} interview process questions`);
  const url = `https://html.duckduckgo.com/html/?q=${query}`;
  const res = await safeFetchPage(url);
  if (!res.ok) return [];

  const $ = cheerio.load(res.page.html);
  const hits: SearchHit[] = [];
  $('.result').each((_, el) => {
    const titleEl = $(el).find('.result__a').first();
    const href = titleEl.attr('href');
    const title = titleEl.text().trim();
    const snippet = $(el).find('.result__snippet').first().text().trim();
    if (href && title) hits.push({ url: href, title, snippet });
  });
  return hits.slice(0, 6);
}

// Placeholder adapter - map a real provider's response shape to SearchHit[]
// here if SEARCH_PROVIDER_API_KEY is configured. Left unimplemented for the
// default free-tier path (see searchViaDuckDuckGo above).
async function searchViaConfiguredProvider(_companyName: string): Promise<SearchHit[]> {
  return [];
}
