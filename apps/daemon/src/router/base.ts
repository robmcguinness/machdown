import type { RequestContext } from '#server/context.ts';
import { addEventFields } from '#server/request-store.ts';
import { contract } from '@machdown/contract';
import { implement } from '@orpc/server';

/** Implements the shared contract; every procedure below is type-checked against it. */
const base = implement(contract).$context<RequestContext>();

/** Whether a thrown value carries the stable `code` a typed oRPC error has. */
function hasStringCode(cause: unknown): cause is { code: string } {
  return (
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
  );
}

/**
 * The `code` of a typed oRPC error, for any value a procedure may throw.
 *
 * Exported for its own test: the `throw null` case cannot be reached through
 * a real procedure, and it is the case that would otherwise go unchecked.
 */
export const errorCodeOf = (cause: unknown): string =>
  hasStringCode(cause) ? cause.code : 'UNKNOWN';

/**
 * Enriches the request's wide event.
 *
 * This is the oRPC layer's whole logging job. The Fastify `onResponse` hook
 * owns emission — it is the only place that sees every outcome — so this
 * middleware only contributes the three things that only oRPC knows: which
 * procedure matched, who called it, and which typed error it threw.
 */
const widened = base.middleware(async ({ context, next, path }) => {
  addEventFields({
    // `path` is the procedure's segments in the router, e.g. ['clips', 'save'].
    procedure: path.join('.'),
    // The id, never the token: the token is the credential, the id is the name.
    // No tsconfig here sets `exactOptionalPropertyTypes`, so an `undefined`
    // value is the same as omitting the key — the field stays absent from the
    // wide event's JSON when there is no paired extension.
    extensionId: context.extension?.extensionId,
  });

  try {
    return await next({ context });
  } catch (error) {
    // A typed oRPC error carries a stable `code`. oRPC answers such an error
    // itself, so it never reaches the Fastify error handler that would attach
    // the full `err` — recording the code here is what keeps the wide event
    // able to tell the whole story on its own line.
    //
    // `throw null` is legal JavaScript, and so is a `code` that is not a
    // string. Reading the property off either without a check would replace
    // the thrown value with a TypeError from this line, which is the one
    // thing this middleware promises not to do.
    addEventFields({ errorCode: errorCodeOf(error) });
    throw error;
  }
});

/**
 * The one implementer every procedure is built from.
 *
 * `widened` is applied here rather than per procedure so no procedure can
 * forget it. `authed` and `withRepoPath` below are declared on `base`, because
 * an implementer that already carries middleware no longer offers
 * `.middleware()` — they still run after `widened` wherever they are used.
 */
export const os = base.use(widened);

/**
 * Rejects anything without a valid bearer token.
 *
 * Applied per procedure rather than globally so `health` and `pair` — the two
 * calls an unpaired extension has to be able to make — stay reachable.
 */
export const authed = base.middleware(async ({ context, errors, next }) => {
  if (!context.extension) {
    throw errors.UNAUTHORIZED();
  }
  return next({ context });
});

/**
 * Resolves the configured repository, or fails with NO_REPO.
 *
 * Every repository-touching procedure runs this so the "not set up yet" case
 * is a typed error the extension can render as a call to action, rather than
 * an unexpected 500.
 */
export const withRepoPath = base.middleware(async ({ context, errors, next }) => {
  const repoPath = context.state.config.repoPath;
  if (!repoPath) {
    throw errors.NO_REPO();
  }
  return next({ context: { ...context, repoPath } });
});
