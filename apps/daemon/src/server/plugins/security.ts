import { corsOptions, securityHook } from '#server/cors.ts';
import { SCALAR_ORIGIN } from '#server/openapi.ts';
import cors from '@fastify/cors';
import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

/**
 * Everything that decides whether a request is allowed to exist at all,
 * before authentication looks at who is asking.
 *
 * Registered ahead of the authentication plugin so a drive-by request from an
 * ordinary web page is refused without the daemon hashing a token for it.
 */
export default fp(
  async (app) => {
    await app.register(cors, corsOptions);

    /**
     * The API responses are JSON that no browser renders, so the headers that
     * matter are the ones covering `/docs` — the one HTML page the daemon
     * serves. The CSP is written for exactly that page: Scalar's bundle from
     * jsdelivr, the spec from this origin, and nothing else.
     */
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          // Scalar mounts itself and injects its own styles at runtime.
          'font-src': ["'self'", SCALAR_ORIGIN, 'data:'],
          'img-src': ["'self'", 'data:', 'https:'],
          'script-src': ["'self'", SCALAR_ORIGIN],
          'style-src': ["'self'", "'unsafe-inline'", SCALAR_ORIGIN],
          // The page reads /openapi.json from this origin only.
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          // Loopback HTTP: an upgrade directive would break every request.
          'upgrade-insecure-requests': null,
        },
        useDefaults: true,
      },
      // The daemon is http://127.0.0.1; HSTS on it would be meaningless at best
      // and would poison the whole localhost origin for other tools at worst.
      hsts: false,
      // Scalar loads cross-origin, which COEP would block.
      crossOriginEmbedderPolicy: false,
    });

    /**
     * Only `/v1/pair` is limited, and it is limited because it is the one
     * unauthenticated route that accepts a guess. The code is single use and
     * expires in ten minutes, but nothing otherwise stopped a local process
     * from spending that window guessing as fast as it could.
     *
     * Registered globally disabled: every other route already needs a token,
     * and the extension polls `/v1/health` often enough that limiting it would
     * be a self-inflicted outage. The opt-in happens in the auth plugin, which
     * is where the normalized path is known.
     */
    await app.register(rateLimit, {
      global: false,
      /**
       * The return value here is *thrown*, not sent — so returning an error
       * carrying the status and code lets `setErrorHandler` render it in the
       * same envelope as every other Fastify-level rejection, rather than
       * hand-building a second response shape here.
       */
      errorResponseBuilder: (_request, context) =>
        Object.assign(new Error(`Too many pairing attempts. Try again in ${context.after}.`), {
          code: 'TOO_MANY_REQUESTS',
          statusCode: context.statusCode,
        }),
    });

    app.addHook('onRequest', securityHook);
  },
  { name: 'machdown-security' },
);
