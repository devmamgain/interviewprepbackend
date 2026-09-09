import type { Request, Response, NextFunction } from 'express';
import { SESSION_COOKIE, verifySessionToken, clearSessionCookie } from '../auth/session';
import { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { userId: string; email: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'not_authenticated', message: 'You must be logged in.' });
    return;
  }

  try {
    req.user = verifySessionToken(token);
    next();
  } catch (err) {
    clearSessionCookie(res);
    if (err instanceof TokenExpiredError) {
      res.status(401).json({ error: 'session_expired', message: 'Your session has expired. Please log in again.' });
      return;
    }
    if (err instanceof JsonWebTokenError) {
      res.status(401).json({ error: 'invalid_session', message: 'Your session is invalid. Please log in again.' });
      return;
    }
    res.status(401).json({ error: 'not_authenticated', message: 'You must be logged in.' });
  }
}
