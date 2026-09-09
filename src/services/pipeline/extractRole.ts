import { generateJson } from '../llm/geminiClient';
import { SYSTEM_PREAMBLE, untrustedBlock } from '../llm/prompts';
import { makeCounterIdFactory } from '../../utils/idGen';
import type { Requirement, RequirementKind } from '../../utils/validation/kitSchema';

interface RawRequirement {
  text: string;
  kind: RequirementKind;
  priority: 'must' | 'nice';
}

interface RawRoleExtraction {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: RawRequirement[];
}

export interface ExtractedRole {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: Requirement[];
}

const EMPTY_EXTRACTION: ExtractedRole = { title: '', seniority: '', location: '', responsibilities: [], requirements: [] };

/**
 * Pulls the role's title/seniority/location/responsibilities and its
 * requirements out of the pasted job description in one call - all of it
 * comes from the same source text, needs no retrieval, and is naturally one
 * extraction task. Explicitly instructed not to invent anything the posting
 * doesn't say - a thin JD should yield a short list, not a padded one.
 */
export async function extractRole(jd: string): Promise<ExtractedRole> {
  const trimmed = jd.trim();
  if (trimmed.length < 20) {
    // Two-line-stub edge case: don't even call the model on almost nothing.
    return EMPTY_EXTRACTION;
  }

  const prompt = `${SYSTEM_PREAMBLE}

Read the job description below and extract structured information about the role.

Rules:
- Only extract what the text actually states or clearly implies. Do NOT invent details a
  thin posting doesn't mention - leave a field as an empty string, or requirements as a
  short list, rather than padding it out.
- "seniority" should be a short label like "Junior", "Mid", "Senior", "Staff", "Lead", or ""
  if the posting doesn't indicate one.
- "location" should be what the posting states (e.g. "Remote", "San Francisco, CA", "Remote
  (US)"), or "" if not stated.
- "responsibilities" are the day-to-day duties described (distinct from qualifications).
- "requirements" are the qualifications/skills/experience asked for.
  - kind: "technical" (languages, tools, systems, architecture), "behavioural"
    (communication, leadership, mentoring, collaboration), or "domain" (industry/product
    knowledge). Every requirement must fit one of these three - pick the closest one.
  - priority: "must" if the posting phrases it as required/essential ("must have",
    "required", "X+ years of..."), "nice" if phrased as a bonus ("nice to have", "bonus
    points for", "preferred but not required").
  - Keep each requirement's text short (under ~15 words) and specific.

${untrustedBlock('JOB DESCRIPTION', trimmed)}

Return JSON: { "title": string, "seniority": string, "location": string, "responsibilities": string[], "requirements": [ { "text": string, "kind": "technical"|"behavioural"|"domain", "priority": "must"|"nice" } ] }`;

  const result = await generateJson<RawRoleExtraction>(prompt, { temperature: 0.2 });
  const nextId = makeCounterIdFactory('r');

  const requirements: Requirement[] = (result.requirements || [])
    .filter((r) => r.text && r.text.trim().length > 0)
    .map((r) => ({
      id: nextId(),
      text: r.text.trim(),
      kind: (['technical', 'behavioural', 'domain'] as const).includes(r.kind) ? r.kind : 'technical',
      priority: r.priority === 'nice' ? 'nice' : 'must',
    }));

  return {
    title: result.title || '',
    seniority: result.seniority || '',
    location: result.location || '',
    responsibilities: (result.responsibilities || []).filter(Boolean),
    requirements,
  };
}
