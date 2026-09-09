import * as cheerio from 'cheerio';

export interface DiscoveredLink {
  url: string;
  anchorText: string;
}

export type LinkPurpose = 'hiring' | 'about';

// Keyword lists are matched against both the URL path and the anchor text.
// Path segments carry more weight than anchor text because anchor text is
// often generic ("Learn more") while paths are usually deliberate
// (/careers, /jobs, /life-at-acme).
const HIRING_PATH_KEYWORDS = [
  'career', 'careers', 'jobs', 'job', 'join', 'join-us', 'hiring', 'work-with-us',
  'life-at', 'openings', 'positions', 'employment', 'talent', 'people-team',
];
const HIRING_TEXT_KEYWORDS = [
  'careers', 'jobs', 'join us', 'join our team', 'we\'re hiring', 'open roles',
  'open positions', 'work with us', 'life at', 'our hiring process', 'interview process',
];
const ABOUT_PATH_KEYWORDS = ['about', 'company', 'mission', 'story', 'who-we-are', 'team'];
const ABOUT_TEXT_KEYWORDS = ['about us', 'about', 'our story', 'our mission', 'who we are', 'company'];

function scoreAgainst(link: DiscoveredLink, pathKeywords: string[], textKeywords: string[]): number {
  let score = 0;
  let path = '';
  try {
    path = new URL(link.url).pathname.toLowerCase();
  } catch {
    return 0;
  }
  const text = link.anchorText.toLowerCase().trim();

  for (const kw of pathKeywords) {
    if (path === `/${kw}` || path === `/${kw}/`) score += 6; // exact top-level match, e.g. /careers
    else if (path.includes(`/${kw}`)) score += 3; // nested, e.g. /company/careers
  }
  for (const kw of textKeywords) {
    if (text === kw) score += 4;
    else if (text.includes(kw)) score += 2;
  }
  // Mild penalty for very deep/unlikely paths (blog posts, tag pages, etc.)
  const depth = path.split('/').filter(Boolean).length;
  if (depth > 3) score -= 1;
  return score;
}

export function rankLinks(links: DiscoveredLink[], purpose: LinkPurpose): DiscoveredLink[] {
  const [pathKw, textKw] = purpose === 'hiring' ? [HIRING_PATH_KEYWORDS, HIRING_TEXT_KEYWORDS] : [ABOUT_PATH_KEYWORDS, ABOUT_TEXT_KEYWORDS];

  return [...links]
    .map((l) => ({ link: l, score: scoreAgainst(l, pathKw, textKw) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.link);
}

/** Extract same-site links with their anchor text from a page's HTML. */
export function extractLinks(html: string, baseUrl: string): DiscoveredLink[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: DiscoveredLink[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    abs.hash = '';
    if (abs.hostname !== base.hostname) return; // stay on-site
    if (!['http:', 'https:'].includes(abs.protocol)) return;
    const key = abs.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, anchorText: $(el).text().replace(/\s+/g, ' ').trim() });
  });

  return out;
}

/** Strips nav/footer/script/style noise and returns readable body text. */
export function extractReadableText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer, svg, header').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text.slice(0, 20_000); // cap what we push into prompts later
}

export function extractTitle(html: string): string {
  const $ = cheerio.load(html);
  return $('title').first().text().trim() || $('h1').first().text().trim() || '';
}
