import { validateKit, validateScheduleReferences } from '../src/utils/validation/kitSchema';
import { nowIso, uuid } from '../src/utils/idGen';

function validKit() {
  const now = nowIso();
  return {
    id: uuid(),
    user_id: 'user_1',
    status: 'ready',
    progress: { stage: 'done', updated_at: now },
    input: { jd: 'We need a senior engineer with 5 years of React.', company_url: 'https://example.com', days: 5 },

    source: {
      company: 'Example Co',
      company_url: 'https://example.com',
      role: 'Senior Engineer',
      location: 'Remote',
      jd_chars: 48,
      researched_at: now,
      pages_used: ['https://example.com'],
      retrieval_log: [{ url: 'https://example.com', kind: 'company_site', status: 'ok' }],
    },
    company_brief: {
      summary: 'Example Co builds widgets.',
      what_they_do: 'Widgets.',
      sources: ['https://example.com'],
      hiring_process: 'Phone screen, then onsite.',
      confidence: 'medium',
      edited: false,
    },
    role: {
      title: 'Senior Engineer',
      seniority: 'Senior',
      responsibilities: ['Ship features'],
      requirements: [{ id: 'r1', text: '5 years of React', kind: 'technical', priority: 'must' }],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'How would you optimize a slow React render?',
        answer_outline: 'Discuss memoization, profiling.',
        difficulty: 2,
        state: 'generated',
        order: 0,
      },
    ],
    flashcards: [
      {
        id: 'f1',
        front: 'How would you optimize a slow React render?',
        back: 'Discuss memoization, profiling.',
        requirement_ids: ['r1'],
        state: 'generated',
        order: 0,
        practice: { times_reviewed: 0, last_confidence: null, confidence_history: [], next_due_at: null },
        source_question_id: 'q1',
      },
    ],
    schedule: { days_available: 5, days: [{ day: 1, focus: 'React fundamentals', question_ids: ['q1'], minutes: 15 }] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
    created_at: now,
    updated_at: now,
  };
}

describe('validateKit', () => {
  it('accepts a well-formed kit', () => {
    const result = validateKit(validKit());
    expect(result.valid).toBe(true);
  });

  it('rejects a kit missing a required field', () => {
    const kit: any = validKit();
    delete kit.company_brief;
    const result = validateKit(kit);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('company_brief'))).toBe(true);
    }
  });

  it('rejects a schedule with a non-integer "minutes" value', () => {
    const kit: any = validKit();
    kit.schedule.days[0].minutes = 15.5;
    expect(validateKit(kit).valid).toBe(false);
  });

  it('rejects a requirement with an invalid priority value', () => {
    const kit: any = validKit();
    kit.role.requirements[0].priority = 'sometimes';
    expect(validateKit(kit).valid).toBe(false);
  });

  it('rejects a requirement kind outside technical/behavioural/domain', () => {
    const kit: any = validKit();
    kit.role.requirements[0].kind = 'other';
    expect(validateKit(kit).valid).toBe(false);
  });

  it('rejects a question difficulty outside 1-3', () => {
    const kit: any = validKit();
    kit.questions[0].difficulty = 4;
    expect(validateKit(kit).valid).toBe(false);
  });

  it('rejects a day count requested outside the 1-60 range', () => {
    const kit: any = validKit();
    kit.input.days = 0;
    expect(validateKit(kit).valid).toBe(false);
    kit.input.days = 61;
    expect(validateKit(kit).valid).toBe(false);
  });

  it('rejects a malformed researched_at timestamp', () => {
    const kit: any = validKit();
    kit.source.researched_at = 'not-a-date';
    expect(validateKit(kit).valid).toBe(false);
  });

  it('enforces the flashcard confidence 1-5 bound', () => {
    const kit: any = validKit();
    kit.flashcards[0].practice.last_confidence = 6;
    expect(validateKit(kit).valid).toBe(false);
    kit.flashcards[0].practice.last_confidence = 3;
    expect(validateKit(kit).valid).toBe(true);
  });

  it('validateScheduleReferences catches a schedule that points at a non-existent question id', () => {
    const kit: any = validKit();
    const result = validateKit(kit);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(validateScheduleReferences(result.kit)).toEqual([]);
      result.kit.schedule.days[0].question_ids.push('does-not-exist');
      expect(validateScheduleReferences(result.kit).length).toBeGreaterThan(0);
    }
  });
});
