/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { generateKit, PipelineError } from '../src/services/pipeline/orchestrator';
import { BatchCaseSchema } from '../src/utils/validation/kitSchema';
import type { BatchErrorCode, BatchKitResult, BatchOutput } from '../src/utils/validation/kitSchema';
import { nowIso } from '../src/utils/idGen';

interface CliArgs {
  input: string;
  output: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i++;
    }
  }
  if (!args.input || !args.output) {
    console.error('Usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
    process.exit(1);
  }
  return { input: args.input, output: args.output };
}

function errorCodeFor(err: unknown): BatchErrorCode {
  return err instanceof PipelineError ? err.code : 'UNKNOWN';
}

async function main() {
  const { input, output } = parseArgs(process.argv.slice(2));

  const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf-8'));
  if (!Array.isArray(raw)) {
    console.error('Input file must contain a JSON array of cases.');
    process.exit(1);
  }

  console.log(`Running ${raw.length} case(s)...`);

  const kits: BatchKitResult[] = [];

  for (const [i, rawCase] of raw.entries()) {
    // A malformed case must not abort the run - record it as failed and continue.
    const parsedCase = BatchCaseSchema.safeParse(rawCase);
    if (!parsedCase.success) {
      const id = typeof rawCase?.id === 'string' ? rawCase.id : `case-${i}`;
      console.error(`  -> [${id}] FAILED: malformed input (${parsedCase.error.errors.map((e) => e.message).join('; ')})`);
      kits.push({ id, status: 'failed', kit: null, error: { code: 'INVALID_INPUT', message: parsedCase.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ') } });
      continue;
    }

    const c = parsedCase.data;
    const start = Date.now();
    console.log(`  -> [${c.id}] starting`);
    try {
      const { kit } = await generateKit({ userId: 'batch', jd: c.jd, companyUrl: c.company_url, days: c.days });
      console.log(`  -> [${c.id}] ok in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      kits.push({ id: c.id, status: 'ok', kit, error: null });
    } catch (err) {
      const code = errorCodeFor(err);
      console.error(`  -> [${c.id}] FAILED (${code}) after ${((Date.now() - start) / 1000).toFixed(1)}s: ${(err as Error).message}`);
      kits.push({ id: c.id, status: 'failed', kit: null, error: { code, message: (err as Error).message } });
    }
  }

  const output_payload: BatchOutput = {
    version: '1.0',
    generated_at: nowIso(),
    kits,
  };

  fs.writeFileSync(path.resolve(output), JSON.stringify(output_payload, null, 2));
  const succeeded = kits.filter((k) => k.status === 'ok').length;
  console.log(`Wrote ${kits.length} result(s) to ${output} (${succeeded}/${kits.length} succeeded)`);
}

main().catch((err) => {
  console.error('Fatal error running batch evaluation:', err);
  process.exit(1);
});
