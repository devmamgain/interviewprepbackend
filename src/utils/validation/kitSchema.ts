import { z } from 'zod';

/**
 * Matches Appendix A exactly for every required field name and shape.
 * Fields not in Appendix A (status, progress, per-item edit state, flashcard
 * practice tracking, an audit-friendly retrieval log, etc.) are added
 * alongside the required ones - the brief explicitly allows extending the
 * structure "where that genuinely helps", and the builder/practice-mode/
 * dedupe features required elsewhere in the brief need somewhere to live.
 * Every field name that Appendix A specifies is reproduced verbatim,
 * including its snake_case casing.
 */

// ---------- source ----------

export const RetrievalLogEntrySchema = z.object({
  url: z.string(),
  kind: z.enum(['company_site', 'public_discussion']),
  status: z.enum(['ok', 'skipped', 'failed']),
  reason: z.string().optional(),
});
export type RetrievalLogEntry = z.infer<typeof RetrievalLogEntrySchema>;

export const SourceSchema = z.object({
  company: z.string(),
  company_url: z.string(),
  role: z.string(),
  location: z.string(),
  jd_chars: z.number().int().min(0),
  researched_at: z.string().datetime(),
  pages_used: z.array(z.string()),
  // Extension: every URL attempted, not just the ones that succeeded - kept
  // so the "skip and report" requirement is auditable in the UI, without
  // taking away from pages_used being exactly what Appendix A specifies.
  retrieval_log: z.array(RetrievalLogEntrySchema).default([]),
});
export type Source = z.infer<typeof SourceSchema>;

// ---------- company_brief ----------

export const CompanyBriefSchema = z.object({
  summary: z.string(),
  what_they_do: z.string(),
  sources: z.array(z.string()),
  // Extensions: hiring_process is genuinely part of "read a company brief"
  // (App Overview) and is what later determines question categories, so we
  // surface it as its own field rather than burying it inside summary.
  hiring_process: z.string().default(''),
  confidence: z.enum(['low', 'medium', 'high']).default('low'),
  edited: z.boolean().default(false),
});
export type CompanyBrief = z.infer<typeof CompanyBriefSchema>;

// ---------- role / requirements ----------

export const RequirementKindSchema = z.enum(['technical', 'behavioural', 'domain']);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

export const RequirementSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  kind: RequirementKindSchema,
  priority: z.enum(['must', 'nice']),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const RoleSchema = z.object({
  title: z.string(),
  seniority: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(RequirementSchema),
});
export type Role = z.infer<typeof RoleSchema>;

// ---------- questions ----------

export const QuestionCategorySchema = z.enum(['technical', 'behavioural', 'system-design', 'company-fit']);
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;

export const ItemStateSchema = z.enum(['generated', 'edited', 'user_added', 'pinned']);
export type ItemState = z.infer<typeof ItemStateSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  requirement_ids: z.array(z.string()),
  category: QuestionCategorySchema,
  prompt: z.string().min(1),
  answer_outline: z.string().default(''),
  difficulty: z.number().int().min(1).max(3),
  // Extensions powering the builder (edit/reorder/pin) - see README.
  state: ItemStateSchema.default('generated'),
  order: z.number().default(0),
});
export type Question = z.infer<typeof QuestionSchema>;

// ---------- flashcards ----------

export const FlashcardPracticeSchema = z.object({
  times_reviewed: z.number().default(0),
  last_confidence: z.number().min(1).max(5).nullable().default(null),
  confidence_history: z.array(z.object({ at: z.string().datetime(), confidence: z.number().min(1).max(5) })).default([]),
  next_due_at: z.string().datetime().nullable().default(null),
});
export type FlashcardPractice = z.infer<typeof FlashcardPracticeSchema>;

export const FlashcardSchema = z.object({
  id: z.string(),
  front: z.string().min(1),
  back: z.string().min(1),
  requirement_ids: z.array(z.string()),
  // Extensions: same state model as questions, plus practice-mode tracking
  // and a link back to the question a card was derived from (see
  // kitService.ts for why that link matters when regenerating).
  state: ItemStateSchema.default('generated'),
  order: z.number().default(0),
  practice: FlashcardPracticeSchema,
  source_question_id: z.string().optional(),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

// ---------- schedule ----------

export const ScheduleDaySchema = z.object({
  day: z.number().int().min(1),
  focus: z.string(),
  question_ids: z.array(z.string()),
  minutes: z.number().int().positive(),
});
export type ScheduleDay = z.infer<typeof ScheduleDaySchema>;

export const ScheduleSchema = z.object({
  days_available: z.number().int().min(1).max(60),
  days: z.array(ScheduleDaySchema),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

// ---------- coverage ----------

export const CoverageSchema = z.object({
  uncovered_requirement_ids: z.array(z.string()),
  passes: z.number().int().min(0),
});
export type Coverage = z.infer<typeof CoverageSchema>;

// ---------- kit progress / status (extension - operational metadata) ----------

export const KitStatusSchema = z.enum(['pending', 'generating', 'ready', 'failed']);
export type KitStatus = z.infer<typeof KitStatusSchema>;

export const KitProgressSchema = z.object({
  stage: z.enum([
    'queued',
    'extracting_role',
    'crawling_company_site',
    'researching_interview_process',
    'generating_brief',
    'generating_questions',
    'checking_coverage',
    'filling_gaps',
    'building_schedule',
    'done',
    'failed',
  ]),
  detail: z.string().optional(),
  updated_at: z.string().datetime(),
});
export type KitProgress = z.infer<typeof KitProgressSchema>;

// ---------- the full kit ----------

export const KitSchema = z.object({
  // Required by Appendix A:
  source: SourceSchema,
  company_brief: CompanyBriefSchema,
  role: RoleSchema,
  questions: z.array(QuestionSchema),
  flashcards: z.array(FlashcardSchema),
  schedule: ScheduleSchema,
  coverage: CoverageSchema,

  // Extensions - app-operational fields, not part of Appendix A itself:
  id: z.string(),
  user_id: z.string(),
  status: KitStatusSchema,
  progress: KitProgressSchema,
  input: z.object({ jd: z.string(), company_url: z.string(), days: z.number().int().min(1).max(60) }),
  warnings: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Kit = z.infer<typeof KitSchema>;

export function validateKit(data: unknown): { valid: true; kit: Kit } | { valid: false; errors: string[] } {
  const result = KitSchema.safeParse(data);
  if (result.success) return { valid: true, kit: result.data };
  return { valid: false, errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`) };
}

/**
 * Every question_ids entry in the schedule must refer to a question that
 * actually exists (Appendix A) - checked separately from the Zod shape
 * check since it's a cross-field invariant, not a per-field type.
 */
export function validateScheduleReferences(kit: Kit): string[] {
  const knownIds = new Set(kit.questions.map((q) => q.id));
  const errors: string[] = [];
  for (const day of kit.schedule.days) {
    for (const qid of day.question_ids) {
      if (!knownIds.has(qid)) errors.push(`schedule day ${day.day} references unknown question id "${qid}"`);
    }
  }
  return errors;
}

// ---------- Appendix B: batch input / output ----------

export const BatchCaseSchema = z.object({
  id: z.string(),
  jd: z.string(),
  company_url: z.string(),
  days: z.number().int().min(1).max(60),
});
export type BatchCase = z.infer<typeof BatchCaseSchema>;

export type BatchErrorCode =
  | 'INVALID_INPUT'
  | 'COMPANY_UNREACHABLE'
  | 'LLM_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN';

export interface BatchKitResult {
  id: string;
  status: 'ok' | 'failed';
  kit: Kit | null;
  error: { code: BatchErrorCode; message: string } | null;
}

export interface BatchOutput {
  version: '1.0';
  generated_at: string;
  kits: BatchKitResult[];
}
