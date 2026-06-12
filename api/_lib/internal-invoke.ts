// In-process invocation of an Express agent handler, for server-side
// orchestration (the pipeline runner). It builds a synthetic request carrying
// an already-verified user (so the handler's requireUser() succeeds without a
// Firebase token) and a minimal response that captures status + JSON body.
//
// Every agent handler follows the same shape: `(req, res) => res.status(n).json(obj)`.
// Reusing the handlers verbatim means orchestration goes through the exact same
// rate-limit checks, run logging, and DB writes as a real HTTP call — no logic
// is duplicated or allowed to drift.

import type { Request, Response } from 'express';
import { INTERNAL_USER, type AuthedUser } from './auth';

export interface InternalResult<T = unknown> {
  status: number;
  body: T;
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

export async function invokeAgent<T = unknown>(
  handler: Handler,
  opts: { user: AuthedUser; body: unknown; method?: string }
): Promise<InternalResult<T>> {
  const req = {
    method: opts.method ?? 'POST',
    headers: {},
    query: {},
    params: {},
    body: opts.body,
    [INTERNAL_USER]: opts.user,
  } as unknown as Request;

  return await new Promise<InternalResult<T>>((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const finish = (body: unknown) => {
      if (settled) return;
      settled = true;
      resolve({ status: statusCode, body: body as T });
    };

    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: unknown) {
        finish(payload);
        return res;
      },
      send(payload: unknown) {
        finish(payload);
        return res;
      },
      end() {
        finish(undefined);
        return res;
      },
      setHeader() {
        return res;
      },
    } as unknown as Response;

    Promise.resolve(handler(req, res)).catch((err) => {
      if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
