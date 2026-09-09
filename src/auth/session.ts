import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../config/env';

export const SESSION_COOKIE = 'ipk_session';

export interface SessionPayload {
  userId: string;
  email: string;
}

export function issueSessionToken(payload: SessionPayload): string {
  return jwt.sign(payload, env.sessionSecret, { expiresIn: `${env.sessionTtlHours}h` });
}

/** Throws on missing/expired/tampered tokens - callers treat any throw as "not authenticated". */
export function verifySessionToken(token: string): SessionPayload {
  return jwt.verify(token, env.sessionSecret) as SessionPayload;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'lax',
    maxAge: env.sessionTtlHours * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
