import type { Question, Requirement, Schedule } from '../../utils/validation/kitSchema';

const REVIEW_DAY_MINUTES = 20;

function minutesFor(q: Question): number {
  const base = { 1: 7, 2: 10, 3: 15 }[q.difficulty] ?? 10;
  return base + (q.category === 'technical' || q.category === 'system-design' ? 5 : 0);
}

function priorityScore(q: Question, requirementById: Map<string, Requirement>): number {
  const hasMust = q.requirement_ids.some((id) => requirementById.get(id)?.priority === 'must');
  return (hasMust ? 10 : 0) + q.difficulty;
}

function focusFor(questions: Question[], requirementById: Map<string, Requirement>): string {
  if (questions.length === 0) return 'Review & practice flashcards';
  const reqTexts = Array.from(
    new Set(
      questions
        .flatMap((q) => q.requirement_ids)
        .map((id) => requirementById.get(id)?.text)
        .filter((t): t is string => Boolean(t)),
    ),
  ).slice(0, 3);
  const categories = Array.from(new Set(questions.map((q) => q.category)));
  const label = categories.length === 1 ? categories[0] : 'mixed';
  return reqTexts.length > 0 ? `${label}: ${reqTexts.join('; ')}` : `${label} practice`;
}

/**
 * This is arithmetic, not something to hand to a model: it applies a
 * decreasing per-day time budget (day 1 gets the largest share, later days
 * progressively less) and greedily fills days, in priority order, from a
 * queue of questions sorted must-have-and-hardest first. Anything left over
 * after the queue is exhausted becomes a lighter review day rather than an
 * empty one, so a generous day count doesn't produce dead days. The final
 * day always absorbs whatever is left, so a tight day count never drops a
 * question.
 */
export function buildSchedule(requirements: Requirement[], questions: Question[], daysAvailable: number): Schedule {
  const requirementById = new Map(requirements.map((r) => [r.id, r]));

  const queue = [...questions].sort((a, b) => {
    const diff = priorityScore(b, requirementById) - priorityScore(a, requirementById);
    return diff !== 0 ? diff : a.order - b.order;
  });

  const totalMinutes = queue.reduce((sum, q) => sum + minutesFor(q), 0);

  const weights = Array.from({ length: daysAvailable }, (_, i) => daysAvailable - i);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const targetMinutes = weights.map((w) => Math.max(15, Math.round((totalMinutes * w) / weightSum)));

  const days: Schedule['days'] = [];
  let cursor = 0;

  for (let day = 1; day <= daysAvailable; day++) {
    const dayQuestions: Question[] = [];
    let dayMinutes = 0;
    const isLastDay = day === daysAvailable;
    const budget = targetMinutes[day - 1];

    while (cursor < queue.length) {
      const next = queue[cursor];
      const nextMinutes = minutesFor(next);
      const fitsBudget = dayMinutes + nextMinutes <= budget || dayQuestions.length === 0;
      if (!fitsBudget && !isLastDay) break;
      dayQuestions.push(next);
      dayMinutes += nextMinutes;
      cursor++;
    }

    if (dayQuestions.length === 0) {
      days.push({ day, focus: 'Review & practice flashcards', question_ids: [], minutes: REVIEW_DAY_MINUTES });
    } else {
      days.push({
        day,
        focus: focusFor(dayQuestions, requirementById),
        question_ids: dayQuestions.map((q) => q.id),
        minutes: Math.round(dayMinutes),
      });
    }
  }

  return { days_available: daysAvailable, days };
}
