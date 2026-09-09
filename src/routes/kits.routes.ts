import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth';
import { KitModel } from '../models/Kit';
import { generateKit, PipelineError } from '../services/pipeline/orchestrator';
import * as kitService from '../services/kitService';
import { NotFoundError } from '../services/kitService';
import { nowIso, uuid } from '../utils/idGen';
import type { BatchErrorCode, Kit, KitProgress } from '../utils/validation/kitSchema';

export const kitsRouter = Router();
kitsRouter.use(requireAuth);

function dedupeKeyFor(jd: string, companyUrl: string): string {
  return crypto.createHash('sha256').update(`${jd.trim()}\u0000${companyUrl.trim().toLowerCase()}`).digest('hex');
}

const createSchema = z.object({
  jd: z.string().min(1, 'Job description is required'),
  companyUrl: z.string().url('Company website must be a valid URL'),
  days: z.coerce.number().int().min(1).max(60),
});

const batchSchema = z.object({
  items: z.array(createSchema).min(1).max(20),
});

function pipelineErrorCode(err: unknown): BatchErrorCode {
  return err instanceof PipelineError ? err.code : 'UNKNOWN';
}

/** Runs the pipeline in the background and persists progress/result as it goes. */
async function runGenerationJob(kitId: string, userId: string, jd: string, companyUrl: string, days: number) {
  const onProgress = async (progress: KitProgress) => {
    await KitModel.updateOne({ kitId }, { $set: { 'data.progress': progress, 'data.status': progress.stage === 'failed' ? 'failed' : 'generating' } });
  };

  try {
    const { kit, researchCache } = await generateKit({ userId, jd, companyUrl, days }, onProgress);
    kit.id = kitId; // keep the id we already told the client about
    await KitModel.updateOne({ kitId }, { $set: { data: kit, researchCache } });
  } catch (err) {
    const code = pipelineErrorCode(err);
    await KitModel.updateOne(
      { kitId },
      {
        $set: {
          'data.status': 'failed',
          'data.progress': { stage: 'failed', detail: `[${code}] ${(err as Error).message}`, updated_at: nowIso() },
        },
      },
    );
  }
}

function emptyKitPlaceholder(kitId: string, userId: string, jd: string, companyUrl: string, days: number): Kit {
  const now = nowIso();
  return {
    id: kitId,
    user_id: userId,
    status: 'pending',
    progress: { stage: 'queued', updated_at: now },
    input: { jd, company_url: companyUrl, days },
    source: { company: '', company_url: companyUrl, role: '', location: '', jd_chars: jd.length, researched_at: now, pages_used: [], retrieval_log: [] },
    company_brief: { summary: '', what_they_do: '', sources: [], hiring_process: '', confidence: 'low', edited: false },
    role: { title: '', seniority: '', responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: { days_available: days, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
    warnings: [],
    created_at: now,
    updated_at: now,
  };
}

async function createAndStartKit(userId: string, jd: string, companyUrl: string, days: number) {
  const dedupeKey = dedupeKeyFor(jd, companyUrl);
  const existing = await KitModel.findOne({ userId, dedupeKey });
  if (existing) {
    return { kit: existing.data as Kit, alreadyExisted: true };
  }

  const kitId = uuid();
  const placeholder = emptyKitPlaceholder(kitId, userId, jd, companyUrl, days);

  await KitModel.create({ kitId, userId, dedupeKey, data: placeholder });
  // Fire and forget - the client polls GET /api/kits/:id for progress. This
  // is a single-process background job, not a durable queue; see README
  // "Backend requirements" for the trade-off and what a production version
  // would use instead (BullMQ/SQS-style worker).
  void runGenerationJob(kitId, userId, jd, companyUrl, days);

  return { kit: placeholder, alreadyExisted: false };
}

kitsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', message: parsed.error.errors[0]?.message });
  const { jd, companyUrl, days } = parsed.data;
  const { kit, alreadyExisted } = await createAndStartKit(req.user!.userId, jd, companyUrl, days);
  res.status(alreadyExisted ? 200 : 201).json({ kit, alreadyExisted });
});

kitsRouter.post('/batch', async (req, res) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', message: parsed.error.errors[0]?.message });

  const results = [];
  for (const item of parsed.data.items) {
    const { kit, alreadyExisted } = await createAndStartKit(req.user!.userId, item.jd, item.companyUrl, item.days);
    results.push({ kitId: kit.id, alreadyExisted });
  }
  res.status(202).json({ results });
});

kitsRouter.get('/', async (req, res) => {
  const docs = await KitModel.find({ userId: req.user!.userId }).sort({ createdAt: -1 });
  res.json({ kits: docs.map((d) => d.data) });
});

async function loadOwnedKit(userId: string, kitId: string) {
  const doc = await KitModel.findOne({ kitId, userId });
  return doc;
}

kitsRouter.get('/:id', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json({ kit: doc.data });
});

kitsRouter.delete('/:id', async (req, res) => {
  const result = await KitModel.deleteOne({ kitId: req.params.id, userId: req.user!.userId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).send();
});

// ---- Editing ----

function respondUpdated(res: any, doc: any) {
  return res.json({ kit: doc.data });
}

kitsRouter.patch('/:id/brief', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const patch = z.object({ summary: z.string().optional(), what_they_do: z.string().optional(), hiring_process: z.string().optional() }).parse(req.body);
  doc.data = kitService.editBrief(doc.data as Kit, patch);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.post('/:id/regenerate/brief', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const cache = doc.researchCache || { aboutPages: [], hiringPages: [], discussionPages: [] };
  doc.data = await kitService.regenerateBrief(doc.data as Kit, cache);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.post('/:id/regenerate/schedule', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  doc.data = kitService.regenerateSchedule(doc.data as Kit);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.post('/:id/regenerate/questions/:category', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const category = req.params.category as any;
  try {
    doc.data = await kitService.regenerateQuestionCategory(doc.data as Kit, category);
  } catch (err) {
    return res.status(502).json({ error: 'regeneration_failed', message: (err as Error).message });
  }
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.post('/:id/questions', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const body = z
    .object({
      prompt: z.string().min(1),
      category: z.enum(['technical', 'behavioural', 'system-design', 'company-fit']),
      requirement_ids: z.array(z.string()).default([]),
      answer_outline: z.string().default(''),
      difficulty: z.number().int().min(1).max(3).default(2),
    })
    .parse(req.body);
  doc.data = kitService.addQuestion(doc.data as Kit, body);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.patch('/:id/questions/:qid', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  try {
    doc.data = kitService.updateQuestion(doc.data as Kit, req.params.qid, req.body);
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'not_found', message: err.message });
    throw err;
  }
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.post('/:id/questions/:qid/pin', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  doc.data = kitService.setQuestionState(doc.data as Kit, req.params.qid, 'pinned');
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.delete('/:id/questions/:qid', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  doc.data = kitService.deleteQuestion(doc.data as Kit, req.params.qid);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.put('/:id/questions/reorder', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const { order } = z.object({ order: z.array(z.string()) }).parse(req.body);
  doc.data = kitService.reorderQuestions(doc.data as Kit, order);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

// ---- Flashcards ----

kitsRouter.post('/:id/flashcards', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const body = z.object({ front: z.string().min(1), back: z.string().min(1), requirement_ids: z.array(z.string()).default([]) }).parse(req.body);
  doc.data = kitService.addFlashcard(doc.data as Kit, body);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.patch('/:id/flashcards/:fcid', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  try {
    doc.data = kitService.updateFlashcard(doc.data as Kit, req.params.fcid, req.body);
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'not_found', message: err.message });
    throw err;
  }
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.delete('/:id/flashcards/:fcid', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  doc.data = kitService.deleteFlashcard(doc.data as Kit, req.params.fcid);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

kitsRouter.put('/:id/flashcards/reorder', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const { order } = z.object({ order: z.array(z.string()) }).parse(req.body);
  doc.data = kitService.reorderFlashcards(doc.data as Kit, order);
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});

// ---- Practice mode ----

kitsRouter.get('/:id/practice/next', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const ordered = kitService.nextPracticeOrder(doc.data as Kit);
  res.json({ flashcards: ordered });
});

kitsRouter.post('/:id/practice/flashcards/:fcid', async (req, res) => {
  const doc = await loadOwnedKit(req.user!.userId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const { confidence } = z.object({ confidence: z.number().min(1).max(5) }).parse(req.body);
  try {
    doc.data = kitService.recordFlashcardReview(doc.data as Kit, req.params.fcid, confidence);
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'not_found', message: err.message });
    throw err;
  }
  doc.markModified('data');
  await doc.save();
  respondUpdated(res, doc);
});
