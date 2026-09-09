import { buildSchedule } from '../src/services/pipeline/scheduler';
import type { Question, Requirement } from '../src/utils/validation/kitSchema';

function req(id: string, priority: 'must' | 'nice' = 'must'): Requirement {
  return { id, text: `requirement ${id}`, priority, kind: 'technical' };
}

function question(id: string, requirementIds: string[], difficulty: Question['difficulty'] = 2, order = 0): Question {
  return { id, prompt: `q ${id}`, category: 'technical', requirement_ids: requirementIds, answer_outline: '', difficulty, state: 'generated', order };
}

describe('buildSchedule', () => {
  it('produces exactly as many days as requested, and echoes days_available', () => {
    const requirements = [req('r1')];
    const questions = [question('q1', ['r1'])];
    for (const days of [1, 3, 7, 14]) {
      const schedule = buildSchedule(requirements, questions, days);
      expect(schedule.days_available).toBe(days);
      expect(schedule.days).toHaveLength(days);
      expect(schedule.days.map((d) => d.day)).toEqual(Array.from({ length: days }, (_, i) => i + 1));
    }
  });

  it('places every must-have requirement somewhere in the schedule', () => {
    const requirements = [req('r1', 'must'), req('r2', 'must'), req('r3', 'nice')];
    const questions = [question('q1', ['r1']), question('q2', ['r2']), question('q3', ['r3'])];
    const schedule = buildSchedule(requirements, questions, 5);

    const scheduledQuestionIds = new Set(schedule.days.flatMap((d) => d.question_ids));
    const coveredRequirementIds = new Set(
      questions.filter((q) => scheduledQuestionIds.has(q.id)).flatMap((q) => q.requirement_ids),
    );
    const mustHaves = requirements.filter((r) => r.priority === 'must');
    for (const must of mustHaves) {
      expect(coveredRequirementIds.has(must.id)).toBe(true);
    }
  });

  it('never drops a question - every question id appears in exactly one day, satisfying the schedule/question cross-reference invariant', () => {
    const requirements = [req('r1'), req('r2'), req('r3'), req('r4')];
    const questions = [
      question('q1', ['r1'], 3),
      question('q2', ['r2'], 2),
      question('q3', ['r3'], 1),
      question('q4', ['r4'], 3),
    ];
    const schedule = buildSchedule(requirements, questions, 2);
    const allIds = schedule.days.flatMap((d) => d.question_ids);
    expect(allIds.sort()).toEqual(['q1', 'q2', 'q3', 'q4'].sort());
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates

    const knownIds = new Set(questions.map((q) => q.id));
    for (const id of allIds) expect(knownIds.has(id)).toBe(true); // no dangling references
  });

  it('cram case: a single requested day still contains every question', () => {
    const requirements = [req('r1'), req('r2'), req('r3')];
    const questions = [question('q1', ['r1']), question('q2', ['r2']), question('q3', ['r3'])];
    const schedule = buildSchedule(requirements, questions, 1);
    expect(schedule.days).toHaveLength(1);
    expect(schedule.days[0].question_ids.sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it('sparse case: a generous day count fills empty days with a review focus rather than leaving them undefined', () => {
    const requirements = [req('r1')];
    const questions = [question('q1', ['r1'])];
    const schedule = buildSchedule(requirements, questions, 10);
    expect(schedule.days).toHaveLength(10);
    const emptyDays = schedule.days.filter((d) => d.question_ids.length === 0);
    expect(emptyDays.length).toBeGreaterThan(0);
    for (const d of emptyDays) {
      expect(d.focus.toLowerCase()).toContain('review');
      expect(d.minutes).toBeGreaterThan(0);
    }
  });

  it('schedules harder / higher-priority material on earlier days, not the last day', () => {
    const requirements = [req('r_must', 'must'), req('r_nice', 'nice')];
    const questions = [
      question('q_easy_nice', ['r_nice'], 1, 0),
      question('q_hard_must', ['r_must'], 3, 1),
    ];
    const schedule = buildSchedule(requirements, questions, 2);
    const dayOfHardMust = schedule.days.find((d) => d.question_ids.includes('q_hard_must'))!.day;
    const dayOfEasyNice = schedule.days.find((d) => d.question_ids.includes('q_easy_nice'))!.day;
    expect(dayOfHardMust).toBeLessThanOrEqual(dayOfEasyNice);
  });

  it('every duration ("minutes") is a positive integer', () => {
    const requirements = [req('r1'), req('r2')];
    const questions = [question('q1', ['r1'], 3), question('q2', ['r2'], 1)];
    const schedule = buildSchedule(requirements, questions, 4);
    for (const day of schedule.days) {
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeGreaterThan(0);
    }
  });
});
