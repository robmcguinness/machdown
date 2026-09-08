import { readBearer, verifyToken } from '#server/auth.ts';
import type { PairedExtension } from '#config.ts';
import fp from 'fastify-plugin';

/**
 * Enforces the bearer token before oRPC sees the request.
 *
 * The contract also guards each procedure with an `authed` middleware, but that
 * runs *after* input validation — so without this hook an unauthenticated
 * caller could probe request schemas by sending bad bodies and reading the
 * validation errors.
 *
 * The result is published on the request so the RPC plugin does not have to
 * hash the token a second time to find out who is calling.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** The request path, without the query string, matched the way oRPC matches. */
    pathname: string;
    /** The bearer token as sent, or null. */
    token: string | null;
    /** The extension that token identifies, or null when it identifies none. */
    extension: PairedExtension | null;
  }
}

/**
 * Reachable without a token: the liveness probe an unpaired extension polls,
 * the pairing exchange itself, and the local API documentation.
 */
export const PUBLIC_PATHS = new Set(['/v1/health', '/v1/pair', '/openapi.json', '/docs']);

/**
 * Reduces a raw request target to the path oRPC will match it against.
 *
 * Only two things are done, because only two things are safe to do. The query
 * string is dropped, and one trailing slash is dropped because oRPC's router
 * treats `/v1/health/` and `/v1/health` as the same route — matching that here
 * is what stops a trailing slash from being reported as an auth failure.
 *
 * Dot segments are deliberately *not* collapsed: oRPC does not collapse them
 * either (`/v1/health/../v1/health` is a 404 there, not a match), so collapsing
 * them here would make this hook see a different route than the one that
 * eventually runs.
 */
export const normalizePath = (url: string): string => {
  const path = url.split('?')[0] ?? '';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
};

/** Pairing is a person typing a code off a terminal; five a minute is generous. */
const PAIR_ATTEMPTS_PER_MINUTE = 5;

export default fp(
  async (app) => {
    app.decorateRequest('pathname', '');
    app.decorateRequest('token', null);
    app.decorateRequest('extension', null);

    // Resolve who is calling once, so nothing downstream hashes the token again.
    app.addHook('onRequest', async (request) => {
      request.pathname = normalizePath(request.url);

      const token = readBearer(request.headers.authorization);
      request.token = token;
      request.extension = token ? verifyToken(app.state.config, token) : null;
    });

    /**
     * Throttles the one unauthenticated route that accepts a guess.
     *
     * Applied by path rather than by route config because `/v1/pair` has no
     * Fastify route of its own — oRPC matches it inside the catch-all.
     */
    const pairLimiter = app.rateLimit({
      max: PAIR_ATTEMPTS_PER_MINUTE,
      timeWindow: '1 minute',
    });

    app.addHook('onRequest', async function limitPairing(request, reply) {
      if (request.pathname !== '/v1/pair') {
        return;
      }
      await pairLimiter.call(this, request, reply);
    });

    app.addHook('onRequest', async (request, reply) => {
      if (PUBLIC_PATHS.has(request.pathname)) {
        return;
      }

      if (!request.extension) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid daemon token. Pair the extension again.',
          },
        });
      }
    });
  },
  { dependencies: ['machdown-state'], name: 'machdown-auth' },
);
