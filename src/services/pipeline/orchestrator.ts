import { makeCounterIdFactory, nowIso, uuid } from '../../utils/idGen';
import type { BatchErrorCode, Kit, KitProgress, Question, QuestionCategory, Requirement } from '../../utils/validation/kitSchema';
import { validateKit, validateScheduleReferences } from '../../utils/validation/kitSchema';
import { crawlCompanySite } from '../crawler/crawlCompanySite';
import { researchPublicDiscussion } from '../research/publicDiscussion';
import { extractRole } from './extractRole';
import { generateCompanyBrief } from './companyBrief';
import { categoryForRequirementKind, generateQuestionsForCategory, toQuestions } from './generateQuestions';
import { findUncoveredRequirementIds, mustHaveGapsRemain } from './coverageCheck';
import { buildSchedule } from './scheduler';
import { buildFlashcards } from './buildFlashcards';
import type { CrawledPage } from '../crawler/crawlCompanySite';
import type { DiscussionPage } from '../research/publicDiscussion';

export interface GenerateKitInput {
  userId: string;
  jd: string;
  companyUrl: string;
  days: number;
}

export type ProgressReporter = (progress: KitProgress) => void | Promise<void>;

export interface ResearchCache {
  aboutPages: CrawledPage[];
  hiringPages: CrawledPage[];
  discussionPages: DiscussionPage[];
}

export interface GenerateKitResult {
  kit: Kit;
  researchCache: ResearchCache;
}

const MAX_COVERAGE_PASSES = 3;

/** Thrown for failures severe enough that no kit could be produced at all - see README's batch error table. */
export class PipelineError extends Error {
  constructor(public readonly code: BatchErrorCode, message: string) {
    super(message);
  }
}

function deriveCompanyName(companyUrl: string, aboutTitle?: string): string {
  if (aboutTitle && aboutTitle.length < 60) {
    return aboutTitle.split(/[|\u2013-]/)[0].trim();
  }
  try {
    const host = new URL(companyUrl).hostname.replace(/^www\./, '');
    return host.split('.')[0];
  } catch {
    return companyUrl;
  }
}

async function report(reporter: ProgressReporter | undefined, stage: KitProgress['stage'], detail?: string) {
  await reporter?.({ stage, detail, updated_at: nowIso() });
}

async function generateForCategoryGroups(
  requirements: Requirement[],
  hiringProcessText: string,
  countPerRequirement: number,
  questionIdFactory: () => string,
  startOrder: number,
  warnings: string[],
): Promise<Question[]> {
  const groups = new Map<QuestionCategory, Requirement[]>();
  for (const r of requirements) {
    const category = categoryForRequirementKind(r.kind, hiringProcessText);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(r);
  }

  let questions: Question[] = [];
  for (const [category, reqs] of groups) {
    try {
      const raw = await generateQuestionsForCategory(reqs, category, hiringProcessText, countPerRequirement);
      questions = questions.concat(toQuestions(raw, category, questionIdFactory, startOrder + questions.length));
    } catch (err) {
      warnings.push(`Question generation for "${category}" questions failed: ${(err as Error).message}`);
    }
  }
  return questions;
}

/**
 * Runs the full research + generation + validation pipeline for one kit.
 * Used identically by the interactive API (via the async job wrapper) and
 * by `npm run evaluate` - there is exactly one implementation of this logic.
 */
export async function generateKit(input: GenerateKitInput, reporter?: ProgressReporter): Promise<GenerateKitResult> {
  const warnings: string[] = [];

  // 1. Role + requirements come straight out of the pasted text - no retrieval needed.
  await report(reporter, 'extracting_role');
  let extracted;
  try {
    extracted = await extractRole(input.jd);
  } catch (err) {
    throw new PipelineError('LLM_UNAVAILABLE', `Role extraction failed: ${(err as Error).message}`);
  }
  const requirements: Requirement[] = extracted.requirements;
  if (requirements.length === 0) {
    warnings.push('The job description was too short or too vague to extract concrete requirements from. This kit will be thin by necessity.');
  }

  // 2. A homepage needs crawling before it's useful - rank links, don't hard-code paths.
  // Total unreachability of the company site is treated as a hard failure (see README);
  // missing hiring/about sub-pages beyond the homepage is not.
  await report(reporter, 'crawling_company_site');
  let crawl;
  try {
    crawl = await crawlCompanySite(input.companyUrl);
  } catch (err) {
    throw new PipelineError('COMPANY_UNREACHABLE', `Could not crawl ${input.companyUrl}: ${(err as Error).message}`);
  }
  const homepageAttempt = crawl.log.find((e) => e.url === input.companyUrl);
  if (!homepageAttempt || homepageAttempt.status !== 'ok') {
    throw new PipelineError('COMPANY_UNREACHABLE', homepageAttempt?.reason || `Could not reach ${input.companyUrl}`);
  }
  const failedSubpages = crawl.log.filter((e) => e.status === 'failed').length;
  if (crawl.hiringPages.length === 0) {
    warnings.push('No dedicated hiring/careers page was found on the company site - the brief relies on the homepage and any public discussion found.');
  }
  if (failedSubpages > 0) {
    warnings.push(`${failedSubpages} page(s) on the company site could not be retrieved and were skipped.`);
  }

  // 3. Public discussion of the interview process - a separate research step,
  //    genuinely independent of what the crawl above found. Not fatal if it fails.
  await report(reporter, 'researching_interview_process');
  const companyName = deriveCompanyName(input.companyUrl, crawl.aboutPages[0]?.title);
  let discussion: Awaited<ReturnType<typeof researchPublicDiscussion>> = { pages: [], log: [] };
  try {
    discussion = await researchPublicDiscussion(companyName);
    if (discussion.pages.length === 0) {
      warnings.push("No public discussion of this company's interview process was found. The brief and questions rely only on the company site and job description.");
    }
  } catch (err) {
    warnings.push(`Public discussion research failed: ${(err as Error).message}`);
  }

  // 4. The hiring-process material found above changes what gets generated next,
  //    so the brief is produced before questions, not alongside them.
  await report(reporter, 'generating_brief');
  let brief;
  try {
    brief = await generateCompanyBrief(input.companyUrl, crawl.aboutPages, crawl.hiringPages, discussion.pages);
  } catch (err) {
    throw new PipelineError('LLM_UNAVAILABLE', `Company brief generation failed: ${(err as Error).message}`);
  }

  // 5. Questions: one call per resulting category, each with genuinely different
  //    instructions (see generateQuestionsForCategory) - never one call for everything.
  //    A technical requirement becomes a system-design question specifically when the
  //    hiring process mentions a system-design round (categoryForRequirementKind).
  await report(reporter, 'generating_questions');
  const questionIdFactory = makeCounterIdFactory('q');
  let questions: Question[] = [];
  if (requirements.length > 0) {
    questions = await generateForCategoryGroups(requirements, brief.hiringProcess, 2, questionIdFactory, 0, warnings);
    if (questions.length === 0) {
      throw new PipelineError('LLM_UNAVAILABLE', 'Question generation failed for every requirement category.');
    }
  }

  // 6/7. Deterministic coverage check, then a genuine retry loop that only
  // regenerates for the specific requirements still uncovered.
  await report(reporter, 'checking_coverage');
  let uncovered = findUncoveredRequirementIds(requirements, questions);
  let passes = 1;

  while (mustHaveGapsRemain(requirements, uncovered) && passes < MAX_COVERAGE_PASSES) {
    await report(reporter, 'filling_gaps', `pass ${passes + 1}`);
    const uncoveredSet = new Set(uncovered);
    const gapRequirements = requirements.filter((r) => uncoveredSet.has(r.id));
    const gapQuestions = await generateForCategoryGroups(gapRequirements, brief.hiringProcess, 1, questionIdFactory, questions.length, warnings);
    questions = questions.concat(gapQuestions);
    uncovered = findUncoveredRequirementIds(requirements, questions);
    passes++;
  }

  if (uncovered.length > 0) {
    const stillUncoveredMust = requirements.filter((r) => uncovered.includes(r.id) && r.priority === 'must').map((r) => r.text);
    if (stillUncoveredMust.length > 0) {
      warnings.push(`After ${passes} pass(es), these must-have requirements still have no question: ${stillUncoveredMust.join('; ')}`);
    }
  }

  // 8. Scheduling is arithmetic - the app's code decides this, not the model.
  await report(reporter, 'building_schedule');
  const schedule = buildSchedule(requirements, questions, input.days);

  const flashcardIdFactory = makeCounterIdFactory('fc');
  const flashcards = buildFlashcards(questions, flashcardIdFactory);

  const retrievalLog = [...crawl.log, ...discussion.log];
  const pagesUsed = retrievalLog.filter((e) => e.status === 'ok').map((e) => e.url);

  const kitCandidate: Kit = {
    id: uuid(),
    user_id: input.userId,
    status: 'ready',
    progress: { stage: 'done', updated_at: nowIso() },
    input: { jd: input.jd, company_url: input.companyUrl, days: input.days },

    source: {
      company: companyName,
      company_url: input.companyUrl,
      role: extracted.title,
      location: extracted.location,
      jd_chars: input.jd.length,
      researched_at: nowIso(),
      pages_used: pagesUsed,
      retrieval_log: retrievalLog,
    },
    company_brief: {
      summary: brief.summary,
      what_they_do: brief.whatTheyDo,
      sources: pagesUsed,
      hiring_process: brief.hiringProcess,
      confidence: brief.confidence,
      edited: false,
    },
    role: {
      title: extracted.title,
      seniority: extracted.seniority,
      responsibilities: extracted.responsibilities,
      requirements,
    },
    questions,
    flashcards,
    schedule,
    coverage: { uncovered_requirement_ids: uncovered, passes },

    warnings,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  // 9. Validate the generated kit against the expected structure before it
  // is ever saved or returned - "the model returned an incomplete kit" is
  // handled by rejecting it here, not by hoping the shape is right.
  const validation = validateKit(kitCandidate);
  if (!validation.valid) {
    await report(reporter, 'failed', validation.errors.join('; '));
    throw new PipelineError('VALIDATION_FAILED', `Generated kit failed structural validation: ${validation.errors.join('; ')}`);
  }
  const refErrors = validateScheduleReferences(validation.kit);
  if (refErrors.length > 0) {
    await report(reporter, 'failed', refErrors.join('; '));
    throw new PipelineError('VALIDATION_FAILED', `Schedule referenced unknown question id(s): ${refErrors.join('; ')}`);
  }

  await report(reporter, 'done');
  return {
    kit: validation.kit,
    researchCache: { aboutPages: crawl.aboutPages, hiringPages: crawl.hiringPages, discussionPages: discussion.pages },
  };
}
