import { generateJson } from '../llm/geminiClient';
import { SYSTEM_PREAMBLE, untrustedBlock } from '../llm/prompts';
import type { Question, QuestionCategory, Requirement, RequirementKind } from '../../utils/validation/kitSchema';

interface RawQuestion {
  prompt: string;
  requirement_ids: string[];
  answer_outline: string;
  difficulty?: number;
}

const CATEGORY_INSTRUCTIONS: Record<QuestionCategory, string> = {
  technical: [
    'Write hands-on TECHNICAL interview questions: implementation, debugging scenarios, or',
    '"how would you build/fix..." questions. Prefer depth over trivia.',
  ].join(' '),
  'system-design': [
    'Write SYSTEM-DESIGN interview questions: "design a system that...", scaling, trade-offs,',
    'architecture decisions. This company is known to run a system-design round, so lean into',
    'open-ended architecture questions rather than narrow implementation trivia.',
  ].join(' '),
  behavioural: [
    'Write BEHAVIOURAL/situational interview questions in the style of "Tell me about a time...",',
    '"How would you handle...", or "Describe a situation where...". Probe judgment,',
    'collaboration, and past experience, not technical trivia.',
  ].join(' '),
  'company-fit': [
    'Write COMPANY-FIT / domain-knowledge questions that probe familiarity with this company\'s',
    'specific industry, product space, or the domain concepts the posting mentions, and why the',
    'candidate wants to work here specifically.',
  ].join(' '),
};

/**
 * Deterministic mapping from a requirement's kind to the question category
 * to generate for it. This is app logic, not a model decision: a technical
 * requirement becomes a system-design question specifically when the
 * company brief's hiring-process text mentions a system-design round -
 * this is the concrete mechanism behind "a company that publishes a
 * take-home followed by a system design round should produce a different
 * kit from one that says nothing" (brief, section 3).
 */
export function categoryForRequirementKind(kind: RequirementKind, hiringProcessText: string): QuestionCategory {
  const mentionsSystemDesign = /system[\s-]?design/i.test(hiringProcessText);
  if (kind === 'technical') return mentionsSystemDesign ? 'system-design' : 'technical';
  if (kind === 'behavioural') return 'behavioural';
  return 'company-fit'; // domain
}

/**
 * Generates questions for a batch of requirements that share one target
 * category. Categories get genuinely different instructions and are
 * genuinely separate model calls (see CATEGORY_INSTRUCTIONS) - a technical
 * requirement and a behavioural one never come from the same call with the
 * same instructions.
 */
export async function generateQuestionsForCategory(
  requirements: Requirement[],
  category: QuestionCategory,
  hiringProcessContext: string,
  countPerRequirement = 2,
): Promise<RawQuestion[]> {
  if (requirements.length === 0) return [];

  const reqList = requirements.map((r) => `- [${r.id}] (${r.priority}) ${r.text}`).join('\n');
  const hiringContextBlock = hiringProcessContext
    ? untrustedBlock('KNOWN HIRING PROCESS', hiringProcessContext)
    : '(No confirmed hiring-process detail was found - write general-purpose questions for this category.)';

  const prompt = `${SYSTEM_PREAMBLE}

${CATEGORY_INSTRUCTIONS[category]}

Write about ${countPerRequirement} interview question(s) PER requirement below, tailored to that
specific requirement. Tag every question with the id(s) of the requirement(s) it actually covers
(usually one, occasionally more if two requirements naturally combine into one question).

${hiringContextBlock}

Requirements:
${reqList}

For each question, also write a short answer outline (2-4 bullet-point-style sentences on what a
strong answer would cover) - not a full model answer, just what to hit. difficulty is an integer
from 1 (easy) to 3 (hard).

Return JSON: { "questions": [ { "prompt": string, "requirement_ids": string[], "answer_outline": string, "difficulty": 1|2|3 } ] }`;

  const result = await generateJson<{ questions: RawQuestion[] }>(prompt, { temperature: 0.5 });
  return (result.questions || []).filter((q) => q.prompt && q.requirement_ids?.length > 0);
}

export function toQuestions(raw: RawQuestion[], category: QuestionCategory, nextId: () => string, startOrder: number): Question[] {
  return raw.map((q, i) => ({
    id: nextId(),
    prompt: q.prompt.trim(),
    category,
    requirement_ids: q.requirement_ids,
    answer_outline: (q.answer_outline || '').trim(),
    difficulty: [1, 2, 3].includes(q.difficulty as number) ? (q.difficulty as 1 | 2 | 3) : 2,
    state: 'generated' as const,
    order: startOrder + i,
  }));
}
