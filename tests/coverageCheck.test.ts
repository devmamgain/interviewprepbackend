import { findUncoveredRequirementIds, mustHaveGapsRemain } from '../src/services/pipeline/coverageCheck';
import type { Question, Requirement } from '../src/utils/validation/kitSchema';

function req(id: string, priority: 'must' | 'nice' = 'must'): Requirement {
  return { id, text: `requirement ${id}`, priority, kind: 'technical' };
}

function question(id: string, requirementIds: string[]): Question {
  return { id, prompt: `q ${id}`, category: 'technical', requirement_ids: requirementIds, answer_outline: '', difficulty: 2, state: 'generated', order: 0 };
}

describe('findUncoveredRequirementIds', () => {
  it('marks a requirement covered when at least one question references it', () => {
    const requirements = [req('r1'), req('r2')];
    const questions = [question('q1', ['r1'])];
    expect(findUncoveredRequirementIds(requirements, questions)).toEqual(['r2']);
  });

  it('resolves a requirement covered by a question that tags multiple requirement ids', () => {
    const requirements = [req('r1'), req('r2')];
    const questions = [question('q1', ['r1', 'r2'])];
    expect(findUncoveredRequirementIds(requirements, questions)).toEqual([]);
  });

  it('returns every requirement id when there are no questions at all', () => {
    const requirements = [req('r1'), req('r2')];
    expect(findUncoveredRequirementIds(requirements, [])).toEqual(['r1', 'r2']);
  });

  it('mustHaveGapsRemain is false once every must-have requirement is covered, even if a nice-to-have is not', () => {
    const requirements = [req('r1', 'must'), req('r2', 'nice')];
    expect(mustHaveGapsRemain(requirements, ['r2'])).toBe(false);
  });

  it('mustHaveGapsRemain is true when any must-have requirement is uncovered', () => {
    const requirements = [req('r1', 'must'), req('r2', 'nice')];
    expect(mustHaveGapsRemain(requirements, ['r1'])).toBe(true);
  });
});
