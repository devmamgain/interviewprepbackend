import { v4 as uuidv4 } from 'uuid';

/** Stable, prefixed, human-legible ids (req_1, q_3, fc_2...) scoped within one kit. */
export function makeCounterIdFactory(prefix: string) {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

export function uuid(): string {
  return uuidv4();
}

export function nowIso(): string {
  return new Date().toISOString();
}
