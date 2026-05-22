// Express entry point — Cloud Run target.
// Replaces the per-file Vercel handler model. Each former api/**/handler.ts
// is now an Express handler that we mount here.

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import agentTarget from '../api/agents/target';
import agentContacts from '../api/agents/contacts';
import agentEvidence from '../api/agents/evidence';
import agentSequence from '../api/agents/sequence';
import agentReply from '../api/agents/reply';
import agentEnrichProfile from '../api/agents/enrich-profile';
import agentCoach from '../api/agents/coach';
import agentParseResume from '../api/agents/parse-resume';

import gmailSend from '../api/gmail/send';
import gmailStart from '../api/integrations/gmail/start';
import gmailCallback from '../api/integrations/gmail/callback';
import gmailStatus from '../api/integrations/gmail/status';
import gmailDisconnect from '../api/integrations/gmail/disconnect';

import cronPollGmail from '../api/cron/poll-gmail';
import tasksWorker from '../api/tasks/worker';
import dataRouter from '../api/data/router';

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// agents
app.post('/api/agents/target', wrap(agentTarget));
app.post('/api/agents/contacts', wrap(agentContacts));
app.post('/api/agents/evidence', wrap(agentEvidence));
app.post('/api/agents/sequence', wrap(agentSequence));
app.post('/api/agents/reply', wrap(agentReply));
app.post('/api/agents/enrich-profile', wrap(agentEnrichProfile));
app.post('/api/agents/coach', wrap(agentCoach));
app.post('/api/agents/parse-resume', wrap(agentParseResume));

// gmail
app.post('/api/gmail/send', wrap(gmailSend));
app.post('/api/integrations/gmail/start', wrap(gmailStart));
app.get('/api/integrations/gmail/callback', wrap(gmailCallback));
app.get('/api/integrations/gmail/status', wrap(gmailStatus));
app.post('/api/integrations/gmail/disconnect', wrap(gmailDisconnect));

// cron + tasks
app.post('/api/cron/poll-gmail', wrap(cronPollGmail));
app.post('/api/tasks/worker', wrap(tasksWorker));

// generic CRUD for the frontend (replaces direct Supabase queries)
app.use('/api/data', dataRouter);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error', detail: err.message });
});

function wrap(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(handler(req, res)).catch(next);
}

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`outreachos api listening on :${port}`);
});
