import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DaemonConfig } from '#config.ts';
import type { DaemonState } from '#server/context.ts';
import type { FastifyInstance } from 'fastify';
import assert from 'node:assert/strict';
import { buildApp } from '#server/app.ts';
import { createDaemonState } from '#server/context.ts';

/**
 * Pairing is the only unauthenticated route that accepts a guess, so its
 * refusals are the ones worth pinning down: a used code, an expired one, a
 * wrong one, and too many attempts.
 *
 * `state.persist` is replaced throughout. The real one writes the operator's
 * own `~/.machdown/daemon.json`, and a test has no business touching it.
 */

const config = (): DaemonConfig => ({
  bookmarksPath: null,
  extensions: [],
  port: 0,
  repoPath: null,
  version: 1,
});

const pair = (app: FastifyInstance, code: string, extensionId = 'test-extension') =>
  app.inject({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    payload: { code, extensionId, label: 'Test' },
    url: '/v1/pair',
  });

const buildPaired = async (): Promise<{ app: FastifyInstance; state: DaemonState }> => {
  const state = createDaemonState(config(), '0.0.0-test');
  state.persist = async () => {};
  return { app: await buildApp(state), state };
};

describe('POST /v1/pair', () => {
  let app: FastifyInstance;
  let state: DaemonState;

  // A fresh instance per test, so the rate limiter's in-memory counters do not
  // carry attempts from one case into the next.
  beforeEach(async () => {
    ({ app, state } = await buildPaired());
  });

  afterEach(async () => {
    await app.close();
  });

  it('trades a valid code for a token that then authenticates', async () => {
    const { code } = state.pairingCodes.issue();

    const response = await pair(app, code);
    assert.equal(response.statusCode, 200, response.body);

    const { token } = response.json<{ token: string }>();
    assert.ok(token.length > 0);

    const authed = await app.inject({
      headers: { authorization: `Bearer ${token}` },
      method: 'GET',
      url: '/v1/config',
    });
    // 409 NO_REPO, not 401: the token was accepted and the handler ran.
    assert.equal(authed.statusCode, 409, authed.body);
  });

  it('stores only the hash of the token, never the token', async () => {
    const { code } = state.pairingCodes.issue();
    const { token } = (await pair(app, code)).json<{ token: string }>();

    const stored = JSON.stringify(state.config.extensions);
    assert.ok(!stored.includes(token), 'the raw token was written to the config');
    assert.match(state.config.extensions[0].tokenHash, /^[0-9a-f]{64}$/);
  });

  it('refuses a code that has already been used', async () => {
    const { code } = state.pairingCodes.issue();

    assert.equal((await pair(app, code)).statusCode, 200);
    assert.equal((await pair(app, code, 'second-extension')).statusCode, 401);
    assert.equal(state.config.extensions.length, 1);
  });

  it('refuses a code that has expired', async () => {
    const issued = state.pairingCodes.issue();
    // Reach past the ten-minute window without waiting for it.
    const expired = Date.now() + 11 * 60 * 1000;
    const realNow = Date.now;
    Date.now = () => expired;

    try {
      assert.equal((await pair(app, issued.code)).statusCode, 401);
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses a wrong code', async () => {
    state.pairingCodes.issue();

    assert.equal((await pair(app, 'ZZZZ-ZZZZ')).statusCode, 401);
    assert.equal(state.config.extensions.length, 0);
  });

  it('refuses any code when none has been issued', async () => {
    assert.equal((await pair(app, 'AAAA-AAAA')).statusCode, 401);
  });

  it('accepts a code typed with stray case and spacing', async () => {
    const { code } = state.pairingCodes.issue();
    const sloppy = ` ${code.toLowerCase().replace('-', ' - ')} `;

    assert.equal((await pair(app, sloppy)).statusCode, 200);
  });

  it('replaces the previous token when an extension pairs again', async () => {
    const first = state.pairingCodes.issue();
    const firstToken = (await pair(app, first.code)).json<{ token: string }>().token;

    const second = state.pairingCodes.issue();
    assert.equal((await pair(app, second.code)).statusCode, 200);

    assert.equal(state.config.extensions.length, 1);
    const stale = await app.inject({
      headers: { authorization: `Bearer ${firstToken}` },
      method: 'GET',
      url: '/v1/config',
    });
    assert.equal(stale.statusCode, 401, 'the superseded token still works');
  });

  /**
   * The code is only about forty bits and lives for ten minutes. Single use
   * bounds the damage, but nothing else stopped a local process from spending
   * that window guessing as fast as it could.
   */
  it('throttles repeated attempts', async () => {
    state.pairingCodes.issue();

    const codes: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      codes.push((await pair(app, 'ZZZZ-ZZZZ')).statusCode);
    }

    assert.ok(codes.includes(429), `no attempt was throttled: ${codes.join(', ')}`);
    assert.equal(codes.at(-1), 429);

    const throttled = await pair(app, 'ZZZZ-ZZZZ');
    assert.equal(throttled.json<{ error: { code: string } }>().error.code, 'TOO_MANY_REQUESTS');
  });

  it('does not throttle the health check the extension polls', async () => {
    const seen = new Set<number>();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      seen.add((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode);
    }

    assert.deepEqual([...seen], [200]);
  });
});
