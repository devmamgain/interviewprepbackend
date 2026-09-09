import dotenv from 'dotenv';
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',

  mongoUri: required('MONGODB_URI', process.env.MONGODB_URI),

  sessionSecret: required('SESSION_SECRET', process.env.SESSION_SECRET),
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || '24', 10),

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    rpmLimit: parseInt(process.env.GEMINI_RPM_LIMIT || '15', 10),
  },

  crawler: {
    userAgent: process.env.CRAWLER_USER_AGENT || 'InterviewPrepKitBot/1.0',
    maxPagesPerSite: parseInt(process.env.CRAWLER_MAX_PAGES_PER_SITE || '8', 10),
    requestTimeoutMs: parseInt(process.env.CRAWLER_REQUEST_TIMEOUT_MS || '8000', 10),
    minDelayMs: parseInt(process.env.CRAWLER_MIN_DELAY_MS || '500', 10),
    allowPrivateHosts: (process.env.ALLOW_PRIVATE_HOSTS || 'false').toLowerCase() === 'true',
  },

  search: {
    apiKey: process.env.SEARCH_PROVIDER_API_KEY || '',
  },
};
