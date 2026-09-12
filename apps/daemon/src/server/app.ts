import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import { createFastifyLogger, resolveRedactPaths } from '@rm3/fastify';
import { addEventFields, currentEvent, enterRequest, setFallbackLog } from './request-store.ts';
import authPlugin from './plugins/auth.ts';
import { closeQmd } from '#qmd/client.ts';
import { env } from '#env';
import type { DaemonState } from './context.ts';
import openapiPlugin from './plugins/openapi.ts';
import { randomUUID } from 'node:crypto';
import rpcPlugin from './plugins/rpc.ts';
import securityPlugin from './plugins/security.ts';
import statePlugin from './plugins/state.ts';

/** Clips of long articles are large; 8 MB leaves generous headroom. */
const BODY_LIMIT = 8 * 1024 * 1024;

/** Longer than the slowest git operation, short enough to free a stuck socket. */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Above the 60 s a browser will idle a keep-alive connection for. */
const KEEP_ALIVE_TIMEOUT_MS = 72_000;

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * Drops the automatic request/response pair.
 *
 * Two lines per request tells the operator nothing the extension does not
 * already show, and it used to be suppressed by raising the whole log level to
 * `warn` — which silenced genuine `info` along with it. Errors are still logged
 * explicitly in the error handler, so nothing diagnostic is lost.
 *
 * Set through `logController` rather than the top-level `disableRequestLogging`,
 * which Fastify 5 deprecates and Fastify 6 removes. Fastify wants an instance
 * here, not the class.
 */
const quietLogController = new LogController({ disableRequestLogging: true });

/**
 * The daemon's own secrets, on top of the shared `@rm3/logger` baseline.
 *
 * The baseline already censors `authorization`, `cookie` and `*.token`. A
 * top-level `token` is named here because pino's `*` matches exactly one
 * level, so `*.token` misses `{ token }`. The stored config holds only
 * SHA-256 hashes, so those are not listed.
 *
 * The pairing code is named path by path rather than by a `*.code` wildcard.
 * A wildcard would also censor `err.code` — pino applies a wildcard path to
 * every top-level key — and `err.code` is the stable name of a failure, while
 * `err.type` is usually just `Error`. The pairing code only ever arrives as
 * the request body of `POST /v1/pair`, so the paths below are where it could
 * surface if a handler ever logged that body.
 */
const REDACT_EXTRAS = ['token', 'code', 'body.code', 'input.code', 'req.body.code'];

/**
 * Everything the wide event must never carry: the shared baseline plus the
 * daemon's extras, in one exported list for the ratchet test.
 */
export const REDACT_PATHS: readonly string[] = resolveRedactPaths(REDACT_EXTRAS);

/**
 * Test-only escape hatch for `buildApp`.
 *
 * `npm test` runs at `silent`, so a test that asserts on log output has to
 * raise the level and point the bytes at somewhere it can read them back.
 */
export type LoggerOverride = {
  level?: string;
  stream?: { write: (msg: string) => void };
};

export const buildApp = async (
  state: DaemonState,
  loggerOverride?: LoggerOverride,
): Promise<FastifyInstance> => {
  // The shared serializer keeps an allow-list of headers rather than none:
  // `origin`, `sec-fetch-site` and `content-type` are what the security hook
  // decides on, and they are the difference between knowing a request was
  // refused and knowing why.
  //
  // Typed as `FastifyBaseLogger` so `Fastify()` infers its default logger
  // generic instead of pino's, which would widen the returned instance type.
  const logger: FastifyBaseLogger = createFastifyLogger(
    {
      // `info` is usable because the log controller removes the per-request
      // pair that made it noise for a single-user local daemon.
      level: loggerOverride?.level ?? env.MACHDOWN_LOG_LEVEL,
      // A test that captures output wants the raw NDJSON rather than
      // prettied text; a terminal wants colour.
      pretty: !loggerOverride?.stream && process.stdout.isTTY,
      redactPaths: REDACT_EXTRAS,
    },
    loggerOverride?.stream,
  );

  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    genReqId: () => randomUUID(),
    logController: quietLogController,
    loggerInstance: logger,
    // The client is a browser extension, not a trusted proxy, so it does not
    // get to choose the id its own errors are filed under.
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    requestIdHeader: false,
    // Requests come only from the extension and curl; no proxy is in front.
    trustProxy: false,
  });

  // Node reaps an idle keep-alive socket with `headersTimeout` (default 60 s),
  // which is *shorter* than the 72 s promised above — so the 72 s never took
  // effect, and a client reusing the socket near the boundary saw ECONNRESET.
  // The rule: `headersTimeout` must outlive `keepAliveTimeout`.
  app.server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;

  // From here on a module-level singleton that logs outside a request — the
  // qmd worker client, the config loader — reaches the real destination.
  setFallbackLog(app.log);

  // The worker holds an open SQLite handle; close it with the server, always.
  app.addHook('onClose', async () => {
    await closeQmd();
  });

  /**
   * Opens the request store, and closes it with the one wide event.
   *
   * The bag lives in `AsyncLocalStorage` rather than on `request`, so code
   * that never sees a Fastify object can still add to this request's event.
   * `onResponse` is the hook that fires for every outcome — a matched
   * procedure, `/health`, a 404, an auth rejection, a rate-limit refusal — so
   * it is the only place one event per request can be promised.
   */
  app.addHook('onRequest', async (request) => {
    enterRequest({ event: {}, log: request.log });
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        ...currentEvent(),
        durationMs: reply.elapsedTime,
        req: request,
        res: reply,
      },
      'request completed',
    );
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send(errorBody('NOT_FOUND', `No route for ${request.method} ${request.url}`)),
  );

  /**
   * Registered before any route, not after.
   *
   * A route captures the error handler that is in place when it is *registered*,
   * so setting this last left every route on Fastify's default handler and this
   * one reachable only from code added afterwards. The symptom was a rate-limit
   * rejection coming back in Fastify's default error shape instead of the
   * daemon's envelope.
   */
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // The wide event has to tell the whole story on its own line, so the
    // failure goes into the bag as well as onto its own `error` line. First,
    // before any early return: both exits below are still a failed request.
    addEventFields({ err: error });

    // oRPC writes through `reply.raw`, so by the time an error surfaces the
    // response may already be on the wire. Sending a second one would throw
    // over the top of the first and lose both.
    if (reply.sent || reply.raw.headersSent) {
      request.log.error({ err: error }, 'request failed after the response was sent');
      return;
    }

    request.log.error({ err: error }, 'request failed');

    if (error.validation) {
      return reply.code(400).send(errorBody('BAD_REQUEST', error.message));
    }

    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send(
      errorBody(
        statusCode === 500 ? 'INTERNAL_ERROR' : (error.code ?? 'ERROR'),
        // A local daemon's user is the operator, so the real message is useful
        // rather than a leak.
        error.message,
      ),
    );
  });

  // Order matters: hooks and error handlers only apply to routes registered
  // after them, so the two route-owning plugins come last.
  await app.register(statePlugin, { state });
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(openapiPlugin);
  await app.register(rpcPlugin);

  return app;
};
