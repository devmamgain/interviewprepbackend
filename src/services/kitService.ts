import { makeCounterIdFactory, nowIso, uuid } from '../utils/idGen';
import type { Flashcard, ItemState, Kit, Question, QuestionCategory, Requirement } from '../utils/validation/kitSchema';
import { generateCompanyBrief } from './pipeline/companyBrief';
import { categoryForRequirementKind, generateQuestionsForCategory, toQuestions } from './pipeline/generateQuestions';
import { findUncoveredRequirementIds } from './pipeline/coverageCheck';
import { buildSchedule } from './pipeline/scheduler';
import type { CrawledPage } from './crawler/crawlCompanySite';
import type { DiscussionPage } from './research/publicDiscussion';

/**
 * STATE MODEL (see README "Editing, regeneration and pinned state" for the
 * full write-up):
 *  - "generated": untouched model output. The only state a regeneration is
 *    allowed to discard.
 *  - "edited": model output the user has since modified. Always preserved.
 *  - "user_added": created by hand. Always preserved.
 *  - "pinned": explicitly protected by the user, independent of whether its
 *    content was ever edited. Always preserved.
 * Flashcards additionally carry `source_question_id`, so regenerating a
 * question category can safely drop only the flashcards it owns.
 */

export class NotFoundError extends Error {}

function touch(kit: Kit): void {
  kit.updated_at = nowIso();
}

function nextOrder(items: Array<{ order: number }>): number {
  return items.length === 0 ? 0 : Math.max(...items.map((i) => i.order)) + 1;
}

function recomputeCoverage(kit: Kit): void {
  kit.coverage.uncovered_requirement_ids = findUncoveredRequirementIds(kit.role.requirements, kit.questions);
}

// ---------- Company brief ----------

export function editBrief(kit: Kit, patch: Partial<Pick<Kit['company_brief'], 'summary' | 'what_they_do' | 'hiring_process'>>): Kit {
  kit.company_brief = { ...kit.company_brief, ...patch, edited: true };
  touch(kit);
  return kit;
}

export async function regenerateBrief(
  kit: Kit,
  research: { aboutPages: CrawledPage[]; hiringPages: CrawledPage[]; discussionPages: DiscussionPage[] },
): Promise<Kit> {
  const brief = await generateCompanyBrief(kit.source.company_url, research.aboutPages, research.hiringPages, research.discussionPages);
  kit.company_brief = {
    summary: brief.summary,
    what_they_do: brief.whatTheyDo,
    sources: kit.company_brief.sources,
    hiring_process: brief.hiringProcess,
    confidence: brief.confidence,
    edited: false,
  };
  touch(kit);
  return kit;
}

// ---------- Questions ----------

export function addQuestion(kit: Kit, input: Pick<Question, 'prompt' | 'category' | 'requirement_ids' | 'answer_outline' | 'difficulty'>): Kit {
  const q: Question = {
    id: `q_${uuid().slice(0, 8)}`,
    prompt: input.prompt,
    category: input.category,
    requirement_ids: input.requirement_ids || [],
    answer_outline: input.answer_outline || '',
    difficulty: input.difficulty || 2,
    state: 'user_added',
    order: nextOrder(kit.questions),
  };
  kit.questions.push(q);
  recomputeCoverage(kit);
  touch(kit);
  return kit;
}

export function updateQuestion(
  kit: Kit,
  questionId: string,
  patch: Partial<Pick<Question, 'prompt' | 'category' | 'requirement_ids' | 'answer_outline' | 'difficulty' | 'order'>>,
): Kit {
  const q = kit.questions.find((x) => x.id === questionId);
  if (!q) throw new NotFoundError(`Question ${questionId} not found`);
  Object.assign(q, patch);
  // Any hand edit promotes a generated question so it survives regeneration,
  // but never demotes something the user already pinned.
  if (q.state === 'generated') q.state = 'edited';
  recomputeCoverage(kit);
  touch(kit);
  return kit;
}

export function setQuestionState(kit: Kit, questionId: string, state: ItemState): Kit {
  const q = kit.questions.find((x) => x.id === questionId);
  if (!q) throw new NotFoundError(`Question ${questionId} not found`);
  q.state = state;
  touch(kit);
  return kit;
}

export function deleteQuestion(kit: Kit, questionId: string): Kit {
  kit.questions = kit.questions.filter((q) => q.id !== questionId);
  // Deleting a question doesn't touch flashcards derived from it - a card
  // the user has been practising against shouldn't vanish just because the
  // question view is tidied up. It becomes an orphaned-but-independent card.
  // Also drop any now-dangling schedule references so Appendix A's
  // "every question_ids entry must refer to a question that exists" holds.
  for (const day of kit.schedule.days) {
    day.question_ids = day.question_ids.filter((id) => id !== questionId);
  }
  recomputeCoverage(kit);
  touch(kit);
  return kit;
}

export function reorderQuestions(kit: Kit, orderedIds: string[]): Kit {
  const orderIndex = new Map(orderedIds.map((id, i) => [id, i]));
  for (const q of kit.questions) {
    if (orderIndex.has(q.id)) q.order = orderIndex.get(q.id)!;
  }
  touch(kit);
  return kit;
}

export async function regenerateQuestionCategory(kit: Kit, category: QuestionCategory): Promise<Kit> {
  const categoryQuestions = kit.questions.filter((q) => q.category === category);
  const keepQuestions = categoryQuestions.filter((q) => q.state !== 'generated');
  const removedIds = new Set(categoryQuestions.filter((q) => q.state === 'generated').map((q) => q.id));

  // Requirements that map to this category under the current hiring-process text.
  const reqsInCategory = kit.role.requirements.filter((r) => categoryForRequirementKind(r.kind, kit.company_brief.hiring_process) === category);

  const idFactory = makeCounterIdFactory(`q${Date.now().toString(36)}`);
  const raw = await generateQuestionsForCategory(reqsInCategory, category, kit.company_brief.hiring_process);
  const startOrder = nextOrder(kit.questions);
  const newQuestions = toQuestions(raw, category, idFactory, startOrder);

  kit.questions = [...kit.questions.filter((q) => q.category !== category), ...keepQuestions, ...newQuestions];

  // Flashcards owned by removed generated questions go with them; anything
  // hand-edited, hand-added, or pinned survives regardless of its source question.
  const keepFlashcards = kit.flashcards.filter((fc) => fc.state !== 'generated' || !fc.source_question_id || !removedIds.has(fc.source_question_id));
  const fcIdFactory = makeCounterIdFactory(`fc${Date.now().toString(36)}`);
  const newFlashcards: Flashcard[] = newQuestions.map((q) => ({
    id: fcIdFactory(),
    front: q.prompt,
    back: q.answer_outline,
    requirement_ids: q.requirement_ids,
    state: 'generated',
    order: nextOrder(kit.flashcards),
    practice: { times_reviewed: 0, last_confidence: null, confidence_history: [], next_due_at: null },
    source_question_id: q.id,
  }));
  kit.flashcards = [...keepFlashcards, ...newFlashcards];

  // Drop schedule references to removed questions so they never dangle.
  for (const day of kit.schedule.days) {
    day.question_ids = day.question_ids.filter((id) => !removedIds.has(id));
  }

  recomputeCoverage(kit);
  kit.coverage.passes += 1;
  touch(kit);
  return kit;
}

// ---------- Flashcards ----------

export function addFlashcard(kit: Kit, input: Pick<Flashcard, 'front' | 'back' | 'requirement_ids'>): Kit {
  kit.flashcards.push({
    id: `fc_${uuid().slice(0, 8)}`,
    front: input.front,
    back: input.back,
    requirement_ids: input.requirement_ids || [],
    state: 'user_added',
    order: nextOrder(kit.flashcards),
    practice: { times_reviewed: 0, last_confidence: null, confidence_history: [], next_due_at: null },
  });
  touch(kit);
  return kit;
}

export function updateFlashcard(kit: Kit, flashcardId: string, patch: Partial<Pick<Flashcard, 'front' | 'back' | 'requirement_ids' | 'order'>>): Kit {
  const fc = kit.flashcards.find((x) => x.id === flashcardId);
  if (!fc) throw new NotFoundError(`Flashcard ${flashcardId} not found`);
  Object.assign(fc, patch);
  if (fc.state === 'generated') fc.state = 'edited';
  touch(kit);
  return kit;
}

export function setFlashcardState(kit: Kit, flashcardId: string, state: ItemState): Kit {
  const fc = kit.flashcards.find((x) => x.id === flashcardId);
  if (!fc) throw new NotFoundError(`Flashcard ${flashcardId} not found`);
  fc.state = state;
  touch(kit);
  return kit;
}

export function deleteFlashcard(kit: Kit, flashcardId: string): Kit {
  kit.flashcards = kit.flashcards.filter((fc) => fc.id !== flashcardId);
  touch(kit);
  return kit;
}

export function reorderFlashcards(kit: Kit, orderedIds: string[]): Kit {
  const orderIndex = new Map(orderedIds.map((id, i) => [id, i]));
  for (const fc of kit.flashcards) {
    if (orderIndex.has(fc.id)) fc.order = orderIndex.get(fc.id)!;
  }
  touch(kit);
  return kit;
}

// ---------- Practice mode ----------

/**
 * Confidence-weighted scheduling: after each review we set a next-due date
 * that shrinks as confidence drops (a 1/5 card is due again in under a day;
 * a 5/5 card is pushed out over a week). This is a deliberately simple
 * stand-in for a full spaced-repetition algorithm (see README for why a
 * proper SM-2 implementation was decided against for this scope), but it
 * still means "what's next" always surfaces weak spots first.
 */
const CONFIDENCE_INTERVAL_HOURS: Record<number, number> = { 1: 4, 2: 12, 3: 24, 4: 72, 5: 168 };

export function recordFlashcardReview(kit: Kit, flashcardId: string, confidence: number): Kit {
  const fc = kit.flashcards.find((x) => x.id === flashcardId);
  if (!fc) throw new NotFoundError(`Flashcard ${flashcardId} not found`);
  const clamped = Math.min(5, Math.max(1, Math.round(confidence)));
  fc.practice.times_reviewed += 1;
  fc.practice.last_confidence = clamped;
  fc.practice.confidence_history.push({ at: nowIso(), confidence: clamped });
  const intervalHours = CONFIDENCE_INTERVAL_HOURS[clamped] ?? 24;
  fc.practice.next_due_at = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
  touch(kit);
  return kit;
}

/** Least-confident (and never-reviewed) cards first; ties broken by due date. */
export function nextPracticeOrder(kit: Kit): Flashcard[] {
  const now = Date.now();
  return [...kit.flashcards].sort((a, b) => {
    const dueA = a.practice.next_due_at ? new Date(a.practice.next_due_at).getTime() <= now : true;
    const dueB = b.practice.next_due_at ? new Date(b.practice.next_due_at).getTime() <= now : true;
    if (dueA !== dueB) return dueA ? -1 : 1; // due cards before not-yet-due cards
    const confA = a.practice.last_confidence ?? 0; // never-reviewed ranks as least confident
    const confB = b.practice.last_confidence ?? 0;
    if (confA !== confB) return confA - confB;
    return a.order - b.order;
  });
}

// ---------- Schedule ----------

export function regenerateSchedule(kit: Kit): Kit {
  kit.schedule = buildSchedule(kit.role.requirements, kit.questions, kit.input.days);
  touch(kit);
  return kit;
}
