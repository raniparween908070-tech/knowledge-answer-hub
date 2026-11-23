import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const SITE_NAME = (process.env.SITE_NAME || 'Knowledge Answer Hub').trim();
const DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveGeminiModel() {
  const raw = (process.env.GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '');
  if (/^(models\/)?gemini-[a-z0-9.-]+$/i.test(raw)) {
    return raw;
  }
  if (raw) {
    console.warn(`[Config Warning] Ignoring invalid GEMINI_MODEL value; falling back to ${DEFAULT_MODEL}.`);
  }
  return DEFAULT_MODEL;
}

const GEMINI_MODEL = resolveGeminiModel();

const IS_SERVERLESS = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
);

const PUBLIC_DIR = path.resolve(__dirname, 'public');

const MAX_QUESTION_LENGTH = 1200;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_TEXT_LENGTH = 4000;

// Total time budget (ms) for one Gemini request, including a possible retry.
// Default 8000 fits Netlify's default 10s synchronous function limit. If Netlify
// enables the 26s limit for the site, set GEMINI_TIMEOUT_MS=23000 in Netlify.
const GEMINI_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.GEMINI_TIMEOUT_MS || '', 10);
  if (!Number.isFinite(parsed)) {
    return 8000;
  }
  return Math.min(Math.max(parsed, 3000), 55000);
})();
const GEMINI_MAX_ATTEMPTS = 2;

const ALLOWED_SUBJECTS = new Set([
  'General Knowledge',
  'Science',
  'Technology',
  'History',
  'Education',
  'Health',
  'Business',
  'Religion',
  'Other',
]);

const ALLOWED_LANGUAGES = new Set([
  'English',
  'Hindi',
  'Urdu',
  'Spanish',
  'Arabic',
  'French',
  'Bengali',
  'German',
  'Portuguese',
  'Japanese',
]);

const PLACEHOLDER_KEYS = new Set([
  '',
  'PASTE_YOUR_GEMINI_API_KEY_HERE',
  'MY_GEMINI_API_KEY',
  'YOUR_GEMINI_API_KEY',
]);

function getConfiguredApiKey() {
  const raw = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!raw || PLACEHOLDER_KEYS.has(raw)) {
    return null;
  }
  return raw;
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }
  // Remove NUL and non-printable control characters while preserving tabs and newlines
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return cleaned.slice(0, maxLength);
}

function buildSystemInstruction(subject, language) {
  return [
    `You are the educational assistant for ${SITE_NAME}.`,
    `Answer the user's question clearly, accurately, and in simple, approachable ${language}.`,
    `The user selected the subject category: "${subject}". Tailor your explanation and examples to this context when relevant.`,
    `Language requirement: Write the entire response strictly in ${language} (including headings and bullet points).`,
    `Formatting guidelines:`,
    `- Use clean Markdown headings (## and ###), short readable paragraphs, and bulleted or numbered lists where helpful.`,
    `- Explain complex ideas in everyday language first before introducing technical terms.`,
    `- Keep answers thorough yet concise (typically 150–450 words unless deeper explanation is needed).`,
    `- Do not fabricate sources, statistics, or citations. If a question asks about recent events or uncertain facts, state limitations clearly.`,
    `- For Health, Business, legal, or financial topics, provide general educational information only and remind the reader to consult a qualified professional for personal decisions.`,
  ].join('\n');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
        frameAncestors: ["'self'"],
      },
    },
    frameguard: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);

// Follow-up requests resend the conversation (up to a few long answers). Hindi/Urdu/Arabic/
// Japanese use 2-3 bytes per character, so 32kb was too small. Only the last
// MAX_HISTORY_TURNS messages are ever used.
app.use(express.json({ limit: '256kb' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload is too large.' });
  }
  return next(err);
});

function getClientIpKey(req) {
  const nfIp = req.headers['x-nf-client-connection-ip'];
  if (typeof nfIp === 'string' && nfIp.trim()) {
    return nfIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (typeof req.ip === 'string' && req.ip.trim()) {
    return req.ip.trim();
  }
  return 'unknown-client';
}

const askLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  validate: { xForwardedForHeader: false, ip: false, keyGeneratorIpFallback: false },
  message: {
    error: 'Too many questions submitted from this connection. Please wait a few minutes before asking again.',
  },
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/ask', askLimiter, async (req, res) => {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    console.error('[Config Error] GEMINI_API_KEY is missing or still a placeholder.');
    return res.status(503).json({
      error: 'The AI service is temporarily unavailable. Please try again later.',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const question = sanitizeText(body.question, MAX_QUESTION_LENGTH + 1);

  if (!question) {
    return res.status(400).json({ error: 'Please enter a question before submitting.' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({
      error: `Your question is too long. Please keep it under ${MAX_QUESTION_LENGTH} characters.`,
    });
  }

  const rawSubject = typeof body.subject === 'string' ? body.subject.trim() : 'General Knowledge';
  const subject = ALLOWED_SUBJECTS.has(rawSubject) ? rawSubject : 'General Knowledge';

  const rawLanguage = typeof body.language === 'string' ? body.language.trim() : 'English';
  const language = ALLOWED_LANGUAGES.has(rawLanguage) ? rawLanguage : 'English';

  const contents = [];
  if (Array.isArray(body.history)) {
    const trimmedHistory = body.history.slice(-MAX_HISTORY_TURNS);
    for (const turn of trimmedHistory) {
      if (!turn || typeof turn !== 'object') {
        continue;
      }
      const role = turn.role === 'model' ? 'model' : turn.role === 'user' ? 'user' : null;
      const text = sanitizeText(turn.text, MAX_HISTORY_TEXT_LENGTH);
      if (role && text) {
        contents.push({
          role,
          parts: [{ text }],
        });
      }
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: question }],
  });

  function makeTimeoutError() {
    const err = new Error('Gemini request exceeded the time budget.');
    err.isTimeout = true;
    return err;
  }

  function raceWithTimer(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(makeTimeoutError()), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const systemInstruction = buildSystemInstruction(subject, language);
    const deadline = Date.now() + GEMINI_TIMEOUT_MS;

    async function callGeminiWithRetry() {
      let lastError;
      for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining < 1500) {
          throw lastError || makeTimeoutError();
        }
        const signal = AbortSignal.timeout(remaining);
        try {
          return await raceWithTimer(
            ai.models.generateContent({
              model: GEMINI_MODEL,
              contents,
              config: { systemInstruction, abortSignal: signal },
            }),
            remaining
          );
        } catch (err) {
          if (err && err.isTimeout) {
            throw err;
          }
          if (signal.aborted) {
            throw makeTimeoutError();
          }
          lastError = err;
          const errStatus = err && typeof err.status === 'number' ? err.status : 0;
          const isTransient =
            errStatus === 500 || errStatus === 502 || errStatus === 503 || errStatus === 504 || errStatus === 0;
          const timeLeft = deadline - Date.now();
          if (!isTransient || attempt === GEMINI_MAX_ATTEMPTS || timeLeft < 2500) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw lastError;
    }

    const response = await callGeminiWithRetry();

    const answer = typeof response.text === 'string' ? response.text.trim() : '';
    if (!answer) {
      return res.status(502).json({
        error: 'The AI did not return an answer for that question. Please try rephrasing your question.',
      });
    }

    return res.json({ answer, subject, language });
  } catch (err) {
    if (err && err.isTimeout) {
      console.error('[Gemini Timeout]', { budgetMs: GEMINI_TIMEOUT_MS, model: GEMINI_MODEL });
      return res.status(504).json({
        error:
          'The AI took too long to respond. Please try again, or ask a shorter or simpler question.',
      });
    }

    const status = err && typeof err.status === 'number' ? err.status : 500;
    const message = err && typeof err.message === 'string' ? err.message : '';

    // Details are logged server-side only (Netlify function logs). Visitors only
    // ever see the generic messages below.
    console.error('[Gemini API Error]', {
      status,
      model: GEMINI_MODEL,
      message: message.split(apiKey).join('[redacted]').slice(0, 250),
    });

    if (status === 429 || message.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        error: 'The AI service is currently receiving high traffic. Please wait a moment and try again.',
      });
    }

    if (
      status === 401 ||
      status === 403 ||
      status === 404 ||
      message.includes('API_KEY_INVALID') ||
      message.includes('API_KEY_EXPIRED') ||
      message.includes('PERMISSION_DENIED') ||
      message.includes('NOT_FOUND')
    ) {
      return res.status(503).json({
        error: 'The AI service is temporarily unavailable. Please try again later.',
      });
    }

    if (status === 400) {
      return res.status(400).json({
        error: 'The AI service could not process this request. Please try rephrasing your question.',
      });
    }

    return res.status(502).json({
      error: 'Unable to generate an answer right now. Please try again shortly.',
    });
  }
});

// Clean route aliases for HTML pages
const PAGE_ROUTES = new Map([
  ['/', 'index.html'],
  ['/about', 'about.html'],
  ['/contact', 'contact.html'],
  ['/privacy', 'privacy.html'],
  ['/disclaimer', 'disclaimer.html'],
  ['/terms', 'terms.html'],
]);

for (const [routePath, fileName] of PAGE_ROUTES.entries()) {
  app.get(routePath, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, fileName));
  });
}

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: '1h',
  })
);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Last-resort error handler: never expose stack traces or internals to visitors.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err && err.message ? err.message : err);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
});

if (!IS_SERVERLESS) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`${SITE_NAME} running at http://localhost:${PORT}`);
    if (!getConfiguredApiKey()) {
      console.warn(
        [
          '',
          '------------------------------------------------------------------',
          'WARNING: GEMINI_API_KEY is missing or still set to a placeholder.',
          'To enable AI answers locally:',
          '  1. Copy .env.example to .env',
          '  2. Paste your Google Gemini API key into GEMINI_API_KEY',
          '  3. Restart the server',
          '------------------------------------------------------------------',
          '',
        ].join('\n')
      );
    }
  });
}

export { app };
export default app;
