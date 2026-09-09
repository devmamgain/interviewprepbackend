import fetch from 'node-fetch';
import { env } from '../../config/env';
import { RateLimiter, withRetry } from '../../utils/retry';

// Shared across the whole process so every pipeline step - not just each
// individual call - respects the same requests-per-minute budget. Free tiers
// throttle tokens/requests per minute, and a pipeline with several
// sequential LLM steps per kit will blow through that fast if each step
// paces itself independently.
const limiter = new RateLimiter(env.gemini.rpmLimit);

export class LlmError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

interface GenerateOptions {
  system?: string;
  temperature?: number;
  jsonMode?: boolean;
}

/** Calls Gemini's generateContent endpoint and returns the raw text output. */
async function callGemini(prompt: string, opts: GenerateOptions): Promise<string> {
  if (!env.gemini.apiKey) {
    throw new LlmError('GEMINI_API_KEY is not set - see .env.example', false);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent?key=${env.gemini.apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (opts.system) {
    body.systemInstruction = { role: 'system', parts: [{ text: opts.system }] };
  }

  await limiter.acquire();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new LlmError('rate limited by Gemini', true);
  }
  if (res.status >= 500) {
    throw new LlmError(`Gemini server error ${res.status}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmError(`Gemini request failed ${res.status}: ${text.slice(0, 300)}`, false);
  }

  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  if (!text) throw new LlmError('Gemini returned an empty response', true);
  return text;
}

/** Plain text generation with retry/backoff on rate limits and transient errors. */
export async function generateText(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  return withRetry(() => callGemini(prompt, opts), {
    maxAttempts: 5,
    baseDelayMs: 2000,
    isRetryable: (err) => err instanceof LlmError && err.retryable,
  });
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Generates JSON and parses it, retrying the whole call (with a stricter
 * "return ONLY JSON" nudge) if the model returns malformed JSON. This is the
 * "model returns invalid JSON" edge case from the brief - handled here so
 * every pipeline step gets it for free rather than reimplementing recovery.
 */
export async function generateJson<T>(prompt: string, opts: GenerateOptions = {}): Promise<T> {
  const jsonPrompt = `${prompt}\n\nRespond with ONLY valid JSON. No markdown fences, no commentary, no trailing commas.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await generateText(jsonPrompt, { ...opts, jsonMode: true });
    try {
      return JSON.parse(stripCodeFence(raw)) as T;
    } catch (err) {
      lastErr = err;
      // Ask again, more forcefully, rather than aborting the whole kit.
      continue;
    }
  }
  throw new LlmError(`Gemini returned invalid JSON after 3 attempts: ${String(lastErr)}`, false);
}
