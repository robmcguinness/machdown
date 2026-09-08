import { createEnv } from '@rm3/env';
import { z } from 'zod';

/**
 * Boot-time configuration: read once, before anything can change it.
 *
 * Every field is optional or defaulted, and none of them coerce. That is not
 * laziness — `loadConfig` deliberately treats a bad `MACHDOWN_PORT` as a
 * *reportable issue* rather than a fatal one, falling back to the stored value
 * and logging a `ConfigIssue`. Coercing here would turn a typo into a daemon
 * that will not boot. Shape and documentation live here; the precedence rules
 * stay in `config.ts`.
 */
export const env = createEnv({
  schema: {
    /** Colon-separated extra roots for the folder picker. */
    MACHDOWN_BROWSE_ROOTS: z.string().default(''),
    /** pino level. */
    MACHDOWN_LOG_LEVEL: z
      .enum(['debug', 'error', 'fatal', 'info', 'silent', 'trace', 'warn'])
      .default('info'),
    /** Validated against `PortSchema` in `config.ts`, where a bad value degrades. */
    MACHDOWN_PORT: z.string().optional(),
    /**
     * Repository path, overriding the stored one. `~` is expanded in
     * `config.ts`, which treats it as *falsy-or-set*, not
     * *undefined-or-set* — so no `.min(1)` here. `MACHDOWN_REPO=""` must keep
     * falling through to the stored path, not fail validation.
     */
    MACHDOWN_REPO: z.string().optional(),
  },
});

/**
 * Test-only overrides, read on every call.
 *
 * These cannot join `env`: both are set by tests *after* module load, and a
 * value captured at import would silently point the search client at the real
 * index. That trade — no freezing, in exchange for a working test hook — is
 * the reason this is a function and `env` is not.
 */
// oxlint-disable-next-line node/no-process-env -- see above
export const qmdDbOverride = (): string | undefined => process.env.MACHDOWN_QMD_DB;
// oxlint-disable-next-line node/no-process-env -- see above
export const qmdDisabled = (): boolean => process.env.MACHDOWN_QMD_DISABLED === '1';

/**
 * The environment handed to the qmd worker thread.
 *
 * A pass-through, and deliberately nothing else. A worker's `env` option only
 * fills that worker's JavaScript `process.env` map; it never calls `setenv`,
 * so native code reading `getenv` cannot see anything added here. This once
 * carried `GGML_METAL_NO_RESIDENCY=1` to stand in for `qmd`'s launcher, which
 * was worse than useless: node-llama-cpp performs the real native `setenv`
 * itself, but only when that key is absent from `process.env`, so the override
 * silently disabled the very mitigation it was meant to apply.
 */
export const workerEnv = (): NodeJS.ProcessEnv => ({
  // oxlint-disable-next-line node/no-process-env -- forwarding, not reading
  ...process.env,
});
