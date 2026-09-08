import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-z]{32}$/;
const MOZ_EXTENSION_ORIGIN = /^moz-extension:\/\/[0-9a-f-]{36}$/;

/** Vite dev server, for running the extension pages outside the browser sandbox. */
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

export const isAllowedOrigin = (origin: string): boolean =>
  EXTENSION_ORIGIN.test(origin) || MOZ_EXTENSION_ORIGIN.test(origin) || DEV_ORIGINS.has(origin);

/**
 * Any extension ID is accepted, because an unpacked extension's ID changes per
 * machine and there is nothing stable to pin. That is deliberate and safe:
 * CORS is not the security boundary here — the bearer token is. What this
 * policy does buy is blocking ordinary web pages from reaching the daemon at
 * all, so a malicious site cannot even attempt a request.
 */
export const corsOptions: FastifyCorsOptions = {
  origin: (origin, callback) => {
    // No Origin header: curl, or a same-origin navigation to /docs.
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isAllowedOrigin(origin));
  },
  // Kept in step with the method list on the catch-all route in plugins/rpc.ts.
  // A method the router accepts but preflight refuses fails only once a
  // contract adds it, which is the worst time to find out.
  allowedHeaders: ['authorization', 'content-type'],
  maxAge: 600,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Never `*`: it would silently mask a misconfigured origin check.
  strictPreflight: false,
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Blocks drive-by requests from ordinary web pages.
 *
 * A page on the open internet can reach `http://127.0.0.1:41998` even though
 * it cannot read the response — enough to trigger a write. Three cheap checks
 * close that off before any handler runs:
 *
 *  1. a present-but-unrecognized `Origin` is rejected outright;
 *  2. `Sec-Fetch-Site: cross-site` is rejected, covering navigations and forms;
 *  3. mutating requests must be `application/json`, which is not a CORS-simple
 *     content type and therefore forces a preflight our origin check fails.
 */
export const securityHook = async (request: FastifyRequest, reply: FastifyReply) => {
  const origin = request.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Origin not allowed' } });
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    return reply
      .code(403)
      .send({ error: { code: 'FORBIDDEN', message: 'Cross-site requests are not allowed' } });
  }

  if (MUTATING_METHODS.has(request.method)) {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return reply.code(415).send({
        error: { code: 'BAD_REQUEST', message: 'Content-Type must be application/json' },
      });
    }
  }
};
