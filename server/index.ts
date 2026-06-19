// Express entry point - Cloud Run target.
// Replaces the per-file Vercel handler model. Each former api/**/handler.ts
// is now an Express handler that we mount here.

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import agentTarget from '../api/agents/target';
import agentContacts from '../api/agents/contacts';
import agentEvidence from '../api/agents/evidence';
import agentSequence from '../api/agents/sequence';
import agentDraft from '../api/agents/draft';
import agentCalibrateDraft from '../api/agents/calibrate-draft';
import agentOnboardQuestions from '../api/agents/onboard-questions';
import agentRefine from '../api/agents/refine';
import agentExtractStyle from '../api/agents/extract-style';
import agentReply from '../api/agents/reply';
import agentEnrichProfile from '../api/agents/enrich-profile';
import agentCoach from '../api/agents/coach';
import agentParseResume from '../api/agents/parse-resume';
import agentExtractContext from '../api/agents/extract-context';
import agentPipeline, { cancel as agentPipelineCancel } from '../api/agents/pipeline';

import gmailSend from '../api/gmail/send';
import gmailReply from '../api/gmail/reply';
import gmailStart from '../api/integrations/gmail/start';
import gmailCallback from '../api/integrations/gmail/callback';
import gmailStatus from '../api/integrations/gmail/status';
import gmailDisconnect from '../api/integrations/gmail/disconnect';

import cronPollGmail from '../api/cron/poll-gmail';
import cronSendDueTouches from '../api/cron/send-due-touches';
import cronWeeklyDigest from '../api/cron/weekly-digest';
import cronAutopilotTick from '../api/cron/autopilot-tick';
import cronResumeRuns from '../api/cron/resume-runs';
import dataRouter from '../api/data/router';
import { localPutHandler, localGetHandler } from '../api/_lib/storage';

import { globalRateLimit, authRateLimit } from '../api/_lib/rate-limit';
import billingCheckout from '../api/billing/checkout';
import billingPortal from '../api/billing/portal';
import billingWebhook from '../api/billing/webhook';
import billingMe from '../api/billing/me';

const app = express();

// Cloud Run terminates TLS at the Google Front End and forwards the client IP
// in X-Forwarded-For. Trust it so req.ip (used by the rate limiters) reflects
// the real caller rather than the proxy hop.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Stripe webhook MUST receive the raw body for signature verification, so it is
// registered with express.raw BEFORE the global JSON parser below (and before
// the global rate limiter - Stripe retries from a small set of IPs).
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), wrap(billingWebhook));

// Body parsing. File uploads go straight to GCS via signed URLs, so every JSON
// body here is small (ids + short text). Cap at 256kb to reject oversized
// payloads early; `verify` rejects a body that isn't a JSON object/array before
// any handler sees it.
app.use(
  express.json({
    limit: '256kb',
    verify: (_req, _res, buf) => {
      if (buf.length === 0) return; // empty body is fine (GET / no-body POST)
      const first = buf[0];
      // 0x7b '{'  0x5b '['  - anything else (a bare string/number/quote) is
      // not a payload any endpoint accepts; fail fast as malformed.
      if (first !== 0x7b && first !== 0x5b) {
        throw new SyntaxError('Body must be a JSON object or array');
      }
    },
  }),
);

// Translate body-parser failures into 4xx instead of the generic 500 handler:
// malformed JSON / non-object body -> 400, oversized -> 413.
app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', detail: 'Request body exceeds the 256kb limit.' });
  }
  if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'malformed_payload', detail: 'Request body is not valid JSON.' });
  }
  return next(err);
});

// Baseline security response headers. Conservative set that won't interfere
// with the SPA / Firebase / Three.js (no strict CSP - add one at the CDN/LB
// layer where script origins are known). HSTS is safe because the service is
// HTTPS-only behind Cloud Run.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Per-IP request ceiling on every endpoint.
app.use(globalRateLimit);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// billing
app.post('/api/billing/checkout', wrap(billingCheckout));
app.post('/api/billing/portal', wrap(billingPortal));
app.get('/api/billing/me', wrap(billingMe));

// agents
app.post('/api/agents/target', wrap(agentTarget));
app.post('/api/agents/contacts', wrap(agentContacts));
app.post('/api/agents/evidence', wrap(agentEvidence));
app.post('/api/agents/sequence', wrap(agentSequence));
app.post('/api/agents/draft', wrap(agentDraft));
app.post('/api/agents/calibrate-draft', wrap(agentCalibrateDraft));
app.post('/api/agents/onboard-questions', wrap(agentOnboardQuestions));
app.post('/api/agents/refine', wrap(agentRefine));
app.post('/api/agents/extract-style', wrap(agentExtractStyle));
app.post('/api/agents/reply', wrap(agentReply));
app.post('/api/agents/enrich-profile', wrap(agentEnrichProfile));
app.post('/api/agents/coach', wrap(agentCoach));
app.post('/api/agents/parse-resume', wrap(agentParseResume));
app.post('/api/agents/extract-context', wrap(agentExtractContext));

// server-side durable pipeline (replaces browser orchestration)
app.post('/api/agents/pipeline/cancel', wrap(agentPipelineCancel));
app.post('/api/agents/pipeline', wrap(agentPipeline));
app.get('/api/agents/pipeline', wrap(agentPipeline));

// gmail
app.post('/api/gmail/send', wrap(gmailSend));
app.post('/api/gmail/reply', wrap(gmailReply));
// Authentication routes (OAuth start + callback): max 5 attempts / 15 min per
// IP. status/disconnect are not auth attempts (status is UI-polled), so they
// ride the global limiter only.
app.post('/api/integrations/gmail/start', authRateLimit, wrap(gmailStart));
app.get('/api/integrations/gmail/callback', authRateLimit, wrap(gmailCallback));
app.get('/api/integrations/gmail/status', wrap(gmailStatus));
app.post('/api/integrations/gmail/disconnect', wrap(gmailDisconnect));

// cron
app.post('/api/cron/poll-gmail', wrap(cronPollGmail));
app.post('/api/cron/send-due-touches', wrap(cronSendDueTouches));
app.post('/api/cron/weekly-digest', wrap(cronWeeklyDigest));
app.post('/api/cron/autopilot-tick', wrap(cronAutopilotTick));
app.post('/api/cron/resume-runs', wrap(cronResumeRuns));

// Local-filesystem storage driver (dev, when no real GCS bucket). Token-authed
// via the HMAC query param baked into the signed URL - no Firebase bearer - so
// they sit OUTSIDE the /api/data auth router. PUT body arrives as a raw Buffer.
app.put('/api/storage-local/put', express.raw({ type: '*/*', limit: '25mb' }), wrap(localPutHandler));
app.get('/api/storage-local/get', wrap(localGetHandler));

// generic CRUD for the frontend (replaces direct Supabase queries)
app.use('/api/data', dataRouter);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Log the full error (message + stack) server-side only. NEVER return err.message
  // to the client: unhandled errors here originate deep in the stack (Mongo driver,
  // GCS, Stripe, the LLM SDK) and routinely embed connection strings, internal
  // hostnames, query fragments, and stack-trace detail. Surface a stable opaque
  // code to the caller instead. (Security checklist #12.)
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

function wrap(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(handler(req, res)).catch(next);
}

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`outreachos api listening on :${port}`);
});
