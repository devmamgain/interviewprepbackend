import { generateJson } from '../llm/geminiClient';
import { SYSTEM_PREAMBLE, untrustedBlock } from '../llm/prompts';
import type { CrawledPage } from '../crawler/crawlCompanySite';
import type { DiscussionPage } from '../research/publicDiscussion';

export interface GeneratedBrief {
  summary: string;
  whatTheyDo: string;
  hiringProcess: string;
  confidence: 'low' | 'medium' | 'high';
}

function joinPages(pages: Array<{ url: string; title: string; text: string }>, maxCharsEach = 4000): string {
  return pages.map((p) => `[${p.title || p.url}](${p.url})\n${p.text.slice(0, maxCharsEach)}`).join('\n\n');
}

/**
 * Produces the company brief. Grounded only in what was actually retrieved -
 * if the crawl found nothing usable, the brief says so plainly rather than
 * fabricating a generic description (an explicit edge case in the brief).
 * hiringProcess is returned alongside summary/whatTheyDo because it's what
 * later determines question categories (see orchestrator.ts), even though
 * it's surfaced to the user as an extra field on company_brief rather than
 * a top-level Appendix A field.
 */
export async function generateCompanyBrief(
  companyUrl: string,
  aboutPages: CrawledPage[],
  hiringPages: CrawledPage[],
  discussionPages: DiscussionPage[],
): Promise<GeneratedBrief> {
  const hasAbout = aboutPages.length > 0;
  const hasHiring = hiringPages.length > 0;
  const hasDiscussion = discussionPages.length > 0;

  if (!hasAbout && !hasHiring && !hasDiscussion) {
    return {
      summary: `We couldn't retrieve any usable content from ${companyUrl} or find public discussion of its interview process. This brief is intentionally left thin rather than guessed.`,
      whatTheyDo: '',
      hiringProcess: '',
      confidence: 'low',
    };
  }

  const prompt = `${SYSTEM_PREAMBLE}

Using ONLY the material below, write a short company brief for someone preparing to interview there.

${untrustedBlock('COMPANY SITE PAGES', hasAbout ? joinPages(aboutPages) : '(none retrieved)')}

${untrustedBlock('HIRING-RELATED PAGES', hasHiring ? joinPages(hiringPages) : '(none retrieved)')}

${untrustedBlock('PUBLIC DISCUSSION OF INTERVIEW PROCESS', hasDiscussion ? joinPages(discussionPages) : '(none found)')}

Rules:
- Do not invent facts that are not supported by the material above.
- If a section has no supporting material, say so explicitly instead of guessing
  (e.g. "No public information on the hiring process was found.").
- "hiringProcess" should describe concrete stages/rounds if the material mentions them
  (e.g. take-home, system design, behavioural rounds) - this later determines what kinds of
  questions get generated, so be concrete when the material supports it.
- confidence: "high" if both about-the-company and hiring-process material were found and
  substantive, "medium" if only one was, "low" if material was thin or absent.

Return JSON: { "summary": string, "whatTheyDo": string, "hiringProcess": string, "confidence": "low"|"medium"|"high" }`;

  const result = await generateJson<GeneratedBrief>(prompt, { temperature: 0.3 });

  return {
    summary: result.summary || '',
    whatTheyDo: result.whatTheyDo || '',
    hiringProcess: result.hiringProcess || '',
    confidence: (['low', 'medium', 'high'] as const).includes(result.confidence) ? result.confidence : 'low',
  };
}
