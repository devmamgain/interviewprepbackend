import { Schema, model, Document } from 'mongoose';
import type { Kit } from '../utils/validation/kitSchema';
import type { ResearchCache } from '../services/pipeline/orchestrator';

export interface KitDoc extends Document {
  kitId: string;
  userId: string;
  dedupeKey: string;
  data: Kit;
  // Cached crawled/researched page text, used only server-side to power
  // "regenerate company brief" without re-crawling. Never sent to the
  // frontend as part of the public Kit shape.
  researchCache?: ResearchCache;
  createdAt: Date;
  updatedAt: Date;
}

const kitSchema = new Schema<KitDoc>(
  {
    kitId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    dedupeKey: { type: String, required: true, index: true },
    data: { type: Schema.Types.Mixed, required: true },
    researchCache: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// A user can't accidentally spawn two kits for the exact same JD + company URL.
kitSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true });

export const KitModel = model<KitDoc>('Kit', kitSchema);
