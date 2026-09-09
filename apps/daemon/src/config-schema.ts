import { DEFAULT_DAEMON_PORT } from '@machdown/contract/constants';
import { z } from 'zod';

/**
 * The shape of `~/.machdown/daemon.json`, as Zod.
 *
 * Kept apart from `config.ts` because this module is the source the JSON
 * Schema is generated from: the generator and its sync test import it outside
 * a configured daemon, so it must never import `#env` — reading the
 * environment at import time would make schema generation depend on the
 * machine that runs it.
 */

/**
 * The file variant, deliberately strict.
 *
 * The generated JSON Schema advertises `integer`, so an editor marks `"port":
 * "8080"` as wrong. Coercing it here would make the daemon accept what the
 * schema rejects.
 */
export const PortSchema = z.int().min(0).max(65_535);

/**
 * The environment variant.
 *
 * `MACHDOWN_PORT` can only ever arrive as a string, so coercion belongs here
 * and nowhere else.
 */
export const EnvPortSchema = z.coerce.number().int().min(0).max(65_535);

export const PairedExtensionSchema = z.object({
  extensionId: z.string().min(1),
  label: z.string().optional(),
  pairedAt: z.string().min(1),
  /** Exactly what `hashToken` produces; anything else can never match a token. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * The single source of truth for the config document.
 *
 * `$schema` is data for the editor rather than for the daemon, but it is
 * declared here so the loader counts it as a known key instead of reporting
 * the line that makes the file validate at all.
 */
export const DaemonConfigSchema = z.object({
  $schema: z.string().optional(),
  /**
   * The folder holding `bookmarks.md`. Separate from `repoPath` on purpose:
   * bookmarks are a plain file the user owns, not repository content, so one
   * can be configured without the other.
   */
  bookmarksPath: z.string().min(1).nullable().default(null),
  extensions: z.array(PairedExtensionSchema).default([]),
  port: PortSchema.default(DEFAULT_DAEMON_PORT),
  repoPath: z.string().min(1).nullable().default(null),
  version: z.literal(1).default(1),
});

/**
 * The JSON Schema for `~/.machdown/daemon.json`, built from the Zod schema.
 *
 * One builder for the generator script, the sync test, and the runtime writer:
 * three call sites producing three slightly different schemas would defeat the
 * point of a single source of truth.
 */
export const buildConfigJsonSchema = () => {
  const { $schema, ...rest } = z.toJSONSchema(DaemonConfigSchema, {
    // The 'input' view keeps fields with `.default()` optional, which is what a
    // hand-edited file wants: an absent field means "use the default".
    io: 'input',
    target: 'draft-2020-12',
  });

  return {
    $id: 'https://machdown.dev/schemas/daemon.schema.json',
    $schema,
    title: 'Machdown daemon configuration (~/.machdown/daemon.json)',
    ...rest,
  };
};
