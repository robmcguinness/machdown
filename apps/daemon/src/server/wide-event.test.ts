import { describe, it } from 'node:test';
import { REDACT_PATHS, buildApp } from './app.ts';
import type { DaemonConfig } from '#config.ts';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import { createDaemonState } from './context.ts';
import { errorCodeOf } from '#router/base.ts';
import { hashToken } from './auth.ts';
import { z } from 'zod';

/**
 * The one wide event per request.
 *
 * `npm test` runs the daemon at `silent`, so every app here is built with the
 * test-only logger override: level `info`, and a stream that keeps the raw
 * NDJSON so the assertions can look at the bytes an operator would see.
 */

const TOKEN = 'test-token';

const config = (): DaemonConfig => ({
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

// Pino writes one JSON object per line; parsed here into the shape the
// assertions below need instead of casting the parsed value field by field.
const LogLineSchema = z.looseObject({
  durationMs: z.number().optional(),
  err: z
    .looseObject({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  errorCode: z.string().optional(),
  extensionId: z.string().optional(),
  msg: z.string().optional(),
  procedure: z.string().optional(),
  req: z
    .looseObject({
      headers: z.record(z.string(), z.string()),
      method: z.string(),
      url: z.string(),
    })
    .optional(),
  res: z.looseObject({ statusCode: z.number() }).optional(),
});

type LogLine = z.output<typeof LogLineSchema>;

const parseLogLine = (line: string): LogLine => LogLineSchema.parse(JSON.parse(line));

type Capture = {
  app: FastifyInstance;
  /** Raw serialized lines, for assertions that a secret is nowhere on them. */
  raw: string[];
  /** Only the wide events, in order. */
  wide: () => LogLine[];
};

const captureApp = async (
  // Fastify refuses a hook once the root plugin has booted, so a test that
  // needs one has to get in before `ready()`.
  beforeReady?: (app: FastifyInstance) => void,
): Promise<Capture> => {
  const raw: string[] = [];
  const app = await buildApp(createDaemonState(config(), '0.0.0-test'), {
    level: 'info',
    stream: {
      write: (msg: string) => {
        raw.push(msg);
      },
    },
  });
  beforeReady?.(app);
  await app.ready();

  return {
    app,
    raw,
    wide: () =>
      raw.map((line) => parseLogLine(line)).filter((line) => line.msg === 'request completed'),
  };
};

describe('the wide request event', () => {
  it('emits exactly one event per request, carrying req, res and durationMs', async () => {
    const { app, wide } = await captureApp();

    const response = await app.inject({ headers: authorized, method: 'GET', url: '/v1/health' });
    assert.equal(response.statusCode, 200, response.body);

    const events = wide();
    assert.equal(events.length, 1, `expected one wide event, got ${events.length}`);

    const [event] = events;
    assert.deepEqual(event.req?.method, 'GET', 'the event is missing the request method');
    assert.equal(event.req?.url, '/v1/health');
    assert.equal(event.res?.statusCode, 200);
    assert.ok(Number.isFinite(event.durationMs), 'expected a numeric durationMs');

    await app.close();
  });

  it('counts one event per request across several requests', async () => {
    const { app, wide } = await captureApp();

    for (const url of ['/v1/health', '/v1/health', '/openapi.json']) {
      await app.inject({ headers: authorized, method: 'GET', url });
    }

    assert.equal(wide().length, 3);

    await app.close();
  });

  it('redacts the Authorization header out of the event', async () => {
    const { app, raw, wide } = await captureApp();

    await app.inject({ headers: authorized, method: 'GET', url: '/v1/health' });

    const [event] = wide();
    assert.ok(event.req, 'expected the request wide event field');
    const { headers } = event.req;

    // The header is still reported as present — its value is what is censored.
    assert.equal(headers.authorization, '[Redacted]');
    // And the token must not have escaped onto any line by another route.
    assert.ok(
      raw.every((line) => !line.includes(TOKEN)),
      'the bearer token reached the log',
    );

    await app.close();
  });

  it('keeps the headers that explain a decision', async () => {
    const { app, wide } = await captureApp();

    await app.inject({
      headers: { ...authorized, origin: 'https://evil.test' },
      method: 'GET',
      url: '/v1/health',
    });

    const [event] = wide();
    assert.ok(event.req, 'expected the request wide event field');
    const { headers } = event.req;

    assert.equal(headers.origin, 'https://evil.test');
    assert.equal(event.res?.statusCode, 403);

    await app.close();
  });

  it('emits one event for a path with no route', async () => {
    const { app, wide } = await captureApp();

    const response = await app.inject({
      headers: authorized,
      method: 'GET',
      url: '/v1/nothing-here',
    });
    assert.equal(response.statusCode, 404);

    const events = wide();
    assert.equal(events.length, 1);
    assert.equal(events[0].res?.statusCode, 404);

    await app.close();
  });

  it('emits one event carrying the error when a handler throws', async () => {
    const { app, wide } = await captureApp((scoped) => {
      scoped.addHook('onRequest', async (request) => {
        if (request.url === '/__throw') {
          throw Object.assign(new Error('deliberate'), { code: 'TEAPOT', statusCode: 418 });
        }
      });
    });

    const response = await app.inject({ headers: authorized, method: 'GET', url: '/__throw' });
    assert.equal(response.statusCode, 418, response.body);

    const events = wide();
    assert.equal(events.length, 1);

    const [event] = events;
    assert.equal(event.res?.statusCode, 418);
    // The error handler routes the failure into the bag, so the one wide line
    // tells the whole story without needing the separate `error` line.
    assert.equal(event.err?.message, 'deliberate');

    await app.close();
  });

  it('leaves err.code readable on both the wide event and the error line', async () => {
    const { app, raw, wide } = await captureApp((scoped) => {
      scoped.addHook('onRequest', async (request) => {
        if (request.url === '/__throw') {
          throw Object.assign(new Error('deliberate'), { code: 'TEAPOT', statusCode: 418 });
        }
      });
    });

    await app.inject({ headers: authorized, method: 'GET', url: '/__throw' });

    // `err.code` is the one stable name a failure has — `err.type` is only
    // `Error` here. A `*.code` redaction path would censor it, which is why
    // the pairing code is named path by path instead.
    const [event] = wide();
    assert.equal(event.err?.code, 'TEAPOT');

    const errorLine = raw
      .map((line) => parseLogLine(line))
      .find((line) => line.msg === 'request failed');
    assert.ok(errorLine, 'the error handler logged no failure line');
    assert.equal(errorLine.err?.code, 'TEAPOT');

    await app.close();
  });

  it('names every path it redacts, and no wildcard over `code`', () => {
    // A ratchet, not a tautology: the list is exported so a future field that
    // carries a secret has one obvious place to be added.
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'token',
      'code',
      'req.body.code',
    ]) {
      assert.ok(REDACT_PATHS.includes(path), `${path} is no longer redacted`);
    }

    // Guards the decision above: `*.code` would take `err.code` with it.
    assert.ok(!REDACT_PATHS.includes('*.code'), 'a wildcard over `code` also censors err.code');
  });
});

/**
 * What the oRPC layer contributes to the event.
 *
 * Emission stays a Fastify concern; these tests only check that the matched
 * procedure, the caller and a typed error reach the same one line.
 */
describe('the oRPC enrichment of the wide event', () => {
  it('names the procedure and the paired extension on a successful call', async () => {
    const { app, wide } = await captureApp();

    const response = await app.inject({ headers: authorized, method: 'GET', url: '/v1/health' });
    assert.equal(response.statusCode, 200, response.body);

    const [event] = wide();
    assert.equal(event.procedure, 'health');
    assert.equal(event.extensionId, 'test-extension');

    await app.close();
  });

  it('names a nested procedure by its full path', async () => {
    const { app, wide } = await captureApp();

    // The fixture config has no repoPath, so `withRepoPath` fails with
    // NO_REPO — which is exactly the typed error the enrichment must record.
    const response = await app.inject({ headers: authorized, method: 'GET', url: '/v1/config' });
    assert.equal(response.statusCode, 409, response.body);

    const [event] = wide();
    assert.equal(event.procedure, 'config.get');
    assert.equal(event.extensionId, 'test-extension');
    assert.equal(event.errorCode, 'NO_REPO');

    await app.close();
  });

  it('records the error code of an unauthorized call', async () => {
    const { app, wide } = await captureApp();

    // `/v1/pair` is reachable without a token, so the rejection happens inside
    // oRPC rather than at the Fastify auth hook — the only unauthorized case
    // the enrichment can see.
    const response = await app.inject({
      method: 'POST',
      payload: { code: 'WRNG-CODE', extensionId: 'test-extension' },
      url: '/v1/pair',
    });
    assert.equal(response.statusCode, 401, response.body);

    const [event] = wide();
    assert.equal(event.procedure, 'pair');
    assert.equal(event.errorCode, 'UNAUTHORIZED');
    assert.equal(event.extensionId, undefined);

    await app.close();
  });

  it('still emits an event for an unauthenticated call, with no extensionId', async () => {
    const { app, wide } = await captureApp();

    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(response.statusCode, 200, response.body);

    const events = wide();
    assert.equal(events.length, 1);
    assert.equal(events[0].procedure, 'health');
    assert.equal(events[0].extensionId, undefined);

    await app.close();
  });
});

describe('the error code read off a thrown value', () => {
  it('reads the code of a typed oRPC error', () => {
    assert.equal(
      errorCodeOf(Object.assign(new Error('nope'), { code: 'UNAUTHORIZED' })),
      'UNAUTHORIZED',
    );
  });

  it('answers UNKNOWN for anything that carries no string code', () => {
    // `throw null` is legal, and a `code` is not always a string. Neither may
    // become a TypeError thrown from the middleware in place of the original.
    for (const thrown of [null, undefined, 'a string', 42, new Error('bare'), { code: 7 }]) {
      assert.equal(errorCodeOf(thrown), 'UNKNOWN');
    }
  });
});
