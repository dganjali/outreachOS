import express from 'express';
import session from 'express-session';

import authRouter from './routes/auth.js';
import missionsRouter from './routes/missions.js';
import contactsRouter from './routes/contacts.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.use(
    session({
      secret: process.env.SESSION_SECRET ?? 'dev-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax'
      }
    })
  );

  app.get('/healthz', (_req, res) => {
    res.json({ success: true, data: { ok: true } });
  });

  app.use('/auth', authRouter);
  app.use('/missions', missionsRouter);
  app.use('/', contactsRouter);

  return app;
}

