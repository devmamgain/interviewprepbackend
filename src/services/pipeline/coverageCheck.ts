import type { Question, Requirement } from '../../utils/validation/kitSchema';

/**
 * Deterministic gap check: for every requirement, does at least one
 * question reference its id? Plain code, not a model call - the brief is
 * explicit that coverage checking is the application's decision to make,
 * not the LLM's, precisely because it needs to be checkable rather than a
 * matter of the model's opinion.
 */
export function findUncoveredRequirementIds(requirements: Requirement[], questions: Question[]): string[] {
  const covered = new Set<string>();
  for (const q of questions) {
    for (const rid of q.requirement_ids) covered.add(rid);
  }
  return requirements.filter((r) => !covered.has(r.id)).map((r) => r.id);
}

export function mustHaveGapsRemain(requirements: Requirement[], uncoveredIds: string[]): boolean {
  const uncovered = new Set(uncoveredIds);
  return requirements.some((r) => r.priority === 'must' && uncovered.has(r.id));
}
