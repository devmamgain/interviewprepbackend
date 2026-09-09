import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { UserModel } from '../models/User';
import { hashPassword, comparePassword } from '../auth/passwordHash';
import { issueSessionToken, setSessionCookie, clearSessionCookie } from '../auth/session';
import { requireAuth } from '../middleware/requireAuth';

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Login/register are the obvious brute-force target, so they get a tighter
// limit than the rest of the API.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

authRouter.post('/register', authLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', message: parsed.error.errors[0]?.message });
  }
  const { email, password } = parsed.data;

  const existing = await UserModel.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ error: 'email_taken', message: 'An account with that email already exists.' });
  }

  const passwordHash = await hashPassword(password);
  const user = await UserModel.create({ email: email.toLowerCase(), passwordHash });

  const token = issueSessionToken({ userId: user.id, email: user.email });
  setSessionCookie(res, token);
  res.status(201).json({ user: { id: user.id, email: user.email } });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', message: parsed.error.errors[0]?.message });
  }
  const { email, password } = parsed.data;

  const user = await UserModel.findOne({ email: email.toLowerCase() });
  // Same generic error whether the email doesn't exist or the password is
  // wrong, so login can't be used to enumerate registered emails.
  const genericError = { error: 'invalid_credentials', message: 'Incorrect email or password.' };
  if (!user) return res.status(401).json(genericError);

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) return res.status(401).json(genericError);

  const token = issueSessionToken({ userId: user.id, email: user.email });
  setSessionCookie(res, token);
  res.json({ user: { id: user.id, email: user.email } });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).send();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
