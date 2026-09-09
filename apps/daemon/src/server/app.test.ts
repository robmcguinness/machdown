import { after, before, describe, it } from 'node:test';
import type { DaemonConfig } from '#config.ts';
import type { FastifyInstance } from 'fastify';
import { PUBLIC_PATHS } from './plugins/auth.ts';
import assert from 'node:assert/strict';
import { buildApp } from './app.ts';
import { createDaemonState } from './context.ts';
import { hashToken } from './auth.ts';

/**
 * The transport layer, which oRPC never sees.
 *
 * Everything here is decided by a Fastify hook, the error handler, or the
 * not-found handler — before or after the contract gets a say. It was the one
 * part of the daemon with no coverage at all.
 */

const TOKEN = 'test-token';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

const config = (): DaemonConfig => ({
  bookmarksPath: null,
  extensions: [
    {
      extensionId: 'test-extension',
      label: 'Test',
      pairedAt: new Date().toISOString(),
      tokenHash: hashToken(TOKEN),
    },
  ],
  port: 0,
  repoPath: null,
  version: 1,
});

const authorized = { authorization: `Bearer ${TOKEN}` };

/** A type guard, not a bare `typeof`: Fastify's inject response headers are `string | string[]`. */
const isString = (value: unknown): value is string => typeof value === 'string';

describe('HTTP layer', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp(createDaemonState(config(), '0.0.0-test'));
  });

  after(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('rejects a request with no Authorization header', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/clips' });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'UNAUTHORIZED');
    });

    it('rejects an unrecognized token', async () => {
      const response = await app.inject({
        headers: { authorization: 'Bearer not-the-token' },
        method: 'GET',
        url: '/v1/clips',
      });

      assert.equal(response.statusCode, 401);
    });

    it('rejects a malformed Authorization header', async () => {
      for (const authorization of ['', 'Bearer', 'Basic abc', TOKEN]) {
        const response = await app.inject({
          headers: { authorization },
          method: 'GET',
          url: '/v1/clips',
        });

        assert.equal(response.statusCode, 401, `accepted ${JSON.stringify(authorization)}`);
      }
    });

    it('lets every public path through without a token', async () => {
      for (const path of PUBLIC_PATHS) {
        // `/v1/pair` is a POST; asking for it with GET still proves the auth
        // hook stood aside, because the refusal comes from the router instead.
        const response = await app.inject({ method: 'GET', url: path });
        assert.notEqual(response.statusCode, 401, `${path} demanded a token`);
      }
    });

    /**
     * Regression test. The hook used to compare the raw request target, so a
     * trailing slash missed the public-path set and came back as an auth
     * failure — even though oRPC's router treats the two as the same route.
     */
    it('treats a trailing slash as the same path', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/health/' });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<{ ok: boolean }>().ok, true);
    });

    it('ignores the query string when matching a public path', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/health?cache=0' });

      assert.equal(response.statusCode, 200, response.body);
    });

    /**
     * The normalization must not go further than oRPC does. oRPC resolves no
     * dot segments, so neither may the hook — if it did, it would authorize one
     * path and run another.
     */
    it('does not resolve dot segments into a public path', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/clips/../v1/health' });

      assert.equal(response.statusCode, 401, response.body);
    });

    it('does not treat a doubled leading slash as a public path', async () => {
      const response = await app.inject({ method: 'GET', url: '//v1/health' });

      assert.equal(response.statusCode, 401, response.body);
    });
  });

  describe('the security hook', () => {
    it('refuses a request from an origin that is not an extension', async () => {
      const response = await app.inject({
        headers: { origin: 'https://evil.test' },
        method: 'GET',
        url: '/v1/health',
      });

      assert.equal(response.statusCode, 403);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'FORBIDDEN');
    });

    it('accepts a request from an extension origin', async () => {
      const response = await app.inject({
        headers: { origin: EXTENSION_ORIGIN },
        method: 'GET',
        url: '/v1/health',
      });

      assert.equal(response.statusCode, 200, response.body);
    });

    it('refuses a cross-site request', async () => {
      const response = await app.inject({
        headers: { 'sec-fetch-site': 'cross-site' },
        method: 'GET',
        url: '/v1/health',
      });

      assert.equal(response.statusCode, 403);
    });

    it('refuses a mutating request that is not JSON', async () => {
      const response = await app.inject({
        headers: { ...authorized, 'content-type': 'text/plain' },
        method: 'POST',
        payload: 'code=AAAA-AAAA',
        url: '/v1/pair',
      });

      assert.equal(response.statusCode, 415);
    });
  });

  describe('CORS', () => {
    it('answers a preflight from an extension origin', async () => {
      const response = await app.inject({
        headers: {
          'access-control-request-headers': 'authorization,content-type',
          'access-control-request-method': 'POST',
          origin: EXTENSION_ORIGIN,
        },
        method: 'OPTIONS',
        url: '/v1/clips',
      });

      assert.equal(response.statusCode, 204);
      assert.equal(response.headers['access-control-allow-origin'], EXTENSION_ORIGIN);
    });

    /**
     * The advertised methods must cover every method the catch-all route
     * accepts, or a contract that adds one fails preflight rather than failing
     * a review.
     */
    it('advertises every method the router accepts', async () => {
      const response = await app.inject({
        headers: { 'access-control-request-method': 'DELETE', origin: EXTENSION_ORIGIN },
        method: 'OPTIONS',
        url: '/v1/clips',
      });

      const header = response.headers['access-control-allow-methods'];
      const allowed = new Set(
        (isString(header) ? header : '').split(',').map((method) => method.trim()),
      );

      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.ok(allowed.has(method), `preflight does not allow ${method}`);
      }
    });

    it('does not grant an unknown origin', async () => {
      const response = await app.inject({
        headers: { 'access-control-request-method': 'POST', origin: 'https://evil.test' },
        method: 'OPTIONS',
        url: '/v1/clips',
      });

      assert.equal(response.headers['access-control-allow-origin'], undefined);
    });
  });

  describe('error responses', () => {
    it('returns the daemon envelope for an unknown path', async () => {
      const response = await app.inject({
        headers: authorized,
        method: 'GET',
        url: '/v1/nothing-here',
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'NOT_FOUND');
    });

    it('reports a repo-less request as a typed conflict, not a crash', async () => {
      // The fixture config has no repoPath, so `withRepoPath` must produce
      // NO_REPO. `/v1/config` is the route to prove it on: it takes no input,
      // so nothing can fail validation ahead of the middleware.
      const response = await app.inject({ headers: authorized, method: 'GET', url: '/v1/config' });

      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.body, /NO_REPO/);
    });

    it('reports bad input as a validation failure', async () => {
      // `/v1/clips` requires a `url`; omitting it must be a 400, not a 500.
      const response = await app.inject({ headers: authorized, method: 'GET', url: '/v1/clips' });

      assert.equal(response.statusCode, 400, response.body);
      assert.match(response.body, /BAD_REQUEST/);
    });

    /**
     * Regression test. `setErrorHandler` used to be installed after the routes
     * were registered, and a Fastify route captures the error handler in place
     * when it is registered — so every route ran on the default handler and
     * errors came back in Fastify's shape instead of the daemon's.
     */
    it('renders a thrown error in the daemon envelope', async () => {
      const scoped = await buildApp(createDaemonState(config(), '0.0.0-test'));
      scoped.addHook('onRequest', async (request) => {
        if (request.url === '/__throw') {
          throw Object.assign(new Error('deliberate'), { code: 'TEAPOT', statusCode: 418 });
        }
      });
      await scoped.ready();

      const response = await scoped.inject({
        headers: authorized,
        method: 'GET',
        url: '/__throw',
      });

      assert.equal(response.statusCode, 418, response.body);
      assert.deepEqual(response.json(), {
        error: { code: 'TEAPOT', message: 'deliberate' },
      });

      await scoped.close();
    });
  });

  describe('socket timeouts', () => {
    it('keeps headersTimeout above keepAliveTimeout', () => {
      // Node's default headersTimeout is 60 s, under the 72 s keep-alive the
      // daemon promises. The shorter of the two wins, so the socket used to
      // die before the client stopped reusing it.
      assert.ok(
        app.server.headersTimeout > app.server.keepAliveTimeout,
        `headersTimeout ${app.server.headersTimeout} must outlive keepAliveTimeout ${app.server.keepAliveTimeout}`,
      );
    });
  });

  describe('documentation', () => {
    it('serves a spec covering every contract path', async () => {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });

      assert.equal(response.statusCode, 200);
      // Served as a string built once at registration, so the content type is
      // set by hand and no longer comes from Fastify's object serializer.
      assert.match(String(response.headers['content-type']), /^application\/json; charset=utf-8$/);
      const document = response.json<{ paths: object }>();
      for (const path of ['/v1/health', '/v1/pair', '/v1/clips']) {
        assert.ok(path in document.paths, `the spec is missing ${path}`);
      }
    });

    it('serves the docs page with a pinned, integrity-checked bundle', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs' });

      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /text\/html/);
      // An unpinned tag has no version an integrity hash could describe.
      assert.match(response.body, /@scalar\/api-reference@\d+\.\d+\.\d+/);
      assert.match(response.body, /integrity="sha384-[A-Za-z0-9+/=]+"/);
      assert.match(response.body, /crossorigin="anonymous"/);
    });

    it('sends security headers on the one HTML page it serves', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs' });

      assert.match(String(response.headers['content-security-policy']), /default-src 'self'/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      // Loopback HTTP: HSTS here would poison the whole localhost origin.
      assert.equal(response.headers['strict-transport-security'], undefined);
    });
  });
});
