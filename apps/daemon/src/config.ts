import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { atomicWriteFile } from '#util/atomic-write.ts';
import { DEFAULT_DAEMON_PORT } from '@machdown/contract/constants';
import {
  buildConfigJsonSchema,
  DaemonConfigSchema,
  EnvPortSchema,
  PairedExtensionSchema,
  PortSchema,
} from './config-schema.ts';
import { env, qmdDbOverride } from '#env';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isErrnoException } from './util/errors.ts';
import { isJsonObject, type Json, JsonSchema } from './util/json.ts';

/**
 * Daemon-private state.
 *
 * Deliberately outside the clip repository: it holds token hashes and must
 * never be committed or synced to another machine.
 */
export type PairedExtension = {
  extensionId: string;
  label?: string;
  /** SHA-256 of the bearer token. The token itself is shown once, at pairing. */
  pairedAt: string;
  tokenHash: string;
};

export type DaemonConfig = {
  /** Folder holding `bookmarks.md`; `null` until the user picks one. */
  bookmarksPath: string | null;
  extensions: PairedExtension[];
  port: number;
  repoPath: string | null;
  version: 1;
};

export const CONFIG_DIR = path.join(os.homedir(), '.machdown');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'daemon.json');

/** The generated JSON Schema, written next to the file it describes. */
export const CONFIG_SCHEMA_PATH = path.join(CONFIG_DIR, 'daemon.schema.json');

/** What `serializeConfig` writes, and what the schema file must answer to. */
export const CONFIG_SCHEMA_REF = './daemon.schema.json';

/**
 * The embedded search index.
 *
 * Daemon-owned rather than qmd's own `~/.cache/qmd/index.sqlite`: collection
 * names are global to a qmd database, and the name comes from repo config, so
 * sharing the user's personal index would let the two collide.
 *
 * Read on every call rather than captured at import: the override exists for
 * tests, and a test that sets it after importing the search client would
 * otherwise silently operate on the real index.
 */
export const qmdDbPath = (): string =>
  qmdDbOverride() ?? path.join(CONFIG_DIR, 'qmd', 'index.sqlite');

const DEFAULTS: DaemonConfig = {
  bookmarksPath: null,
  extensions: [],
  port: DEFAULT_DAEMON_PORT,
  repoPath: null,
  version: 1,
};

/**
 * Expands a leading `~` only. `~user` is deliberately unsupported: resolving
 * another account's home would let the directory browser out of its root.
 */
export const expandHome = (target: string): string =>
  target === '~' || target.startsWith('~/') ? path.join(os.homedir(), target.slice(1)) : target;

/**
 * Validates the parts of the config that reach security- or boot-critical code.
 *
 * The file is hand-editable and the environment overrides are free-form, so
 * without this a string port reaches `listen()` as `NaN` and a truncated
 * `tokenHash` reaches `timingSafeEqual`.
 *
 * The schemas themselves live in `config-schema.ts`, which the JSON Schema
 * generator imports without `#env`. Re-exported here so the existing import
 * surface keeps working.
 */
export {
  buildConfigJsonSchema,
  DaemonConfigSchema,
  EnvPortSchema,
  PairedExtensionSchema,
  PortSchema,
} from './config-schema.ts';

/** A field the loader could not use, reported so the daemon can log it. */
export type ConfigIssue = { field: string; reason: string };

const firstIssue = (error: z.ZodError): string => error.issues[0]?.message ?? 'invalid value';

type ReadFieldOptions<T> = {
  fallback: T;
  field: string;
  issues: ConfigIssue[];
};

/**
 * Validates one field in isolation.
 *
 * Per field rather than per document on purpose: one bad value must not
 * discard the paired extensions alongside it.
 */
const readField = <T>(
  schema: z.ZodType<T>,
  value: Json | undefined,
  options: ReadFieldOptions<T>,
): T => {
  const { fallback, field, issues } = options;
  if (value === undefined) {
    return fallback;
  }

  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  issues.push({ field, reason: firstIssue(parsed.error) });
  return fallback;
};

export const loadDaemonConfig = async (): Promise<{
  config: DaemonConfig;
  issues: ConfigIssue[];
}> => {
  const issues: ConfigIssue[] = [];
  let stored: { readonly [key: string]: Json } = {};

  try {
    const parsed = JsonSchema.parse(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
    if (isJsonObject(parsed)) {
      stored = parsed;
    } else {
      issues.push({ field: 'config', reason: 'the file does not contain a JSON object' });
    }
  } catch (cause) {
    // First run, or an unreadable file: fall back to defaults rather than
    // refusing to start. Re-pairing is cheap; being unable to boot is not.
    if (!isErrnoException(cause) || cause.code !== 'ENOENT') {
      issues.push({ field: 'config', reason: 'the file could not be read or parsed' });
    }
  }

  const envPort = env.MACHDOWN_PORT;
  const envRepo = env.MACHDOWN_REPO;

  // A misspelled key does nothing at all today, which reads as "the setting
  // had no effect". Report it — still a report, never a refusal to boot.
  for (const key of Object.keys(stored)) {
    if (!(key in DaemonConfigSchema.shape)) {
      issues.push({ field: key, reason: 'unknown key' });
    }
  }

  // The environment wins over the file, so validate it the same way. An
  // unusable MACHDOWN_PORT falls through to the stored value.
  const storedPort = readField(PortSchema, stored.port, {
    fallback: DEFAULTS.port,
    field: 'port',
    issues,
  });
  const port =
    envPort === undefined
      ? storedPort
      : readField(EnvPortSchema, envPort, { fallback: storedPort, field: 'MACHDOWN_PORT', issues });

  const storedRepo = readField(z.string().min(1).nullable(), stored.repoPath, {
    fallback: null,
    field: 'repoPath',
    issues,
  });

  const bookmarksPath = readField(z.string().min(1).nullable(), stored.bookmarksPath, {
    fallback: DEFAULTS.bookmarksPath,
    field: 'bookmarksPath',
    issues,
  });

  // Drop only the entries that are unusable. Losing every pairing because one
  // record is malformed would be a worse outcome than losing that one.
  const rawExtensions = Array.isArray(stored.extensions) ? stored.extensions : [];
  if (stored.extensions !== undefined && !Array.isArray(stored.extensions)) {
    issues.push({ field: 'extensions', reason: 'expected an array' });
  }

  const extensions: PairedExtension[] = [];
  for (const [position, entry] of rawExtensions.entries()) {
    const parsed = PairedExtensionSchema.safeParse(entry);
    if (parsed.success) {
      extensions.push(parsed.data);
      continue;
    }
    issues.push({ field: `extensions[${position}]`, reason: firstIssue(parsed.error) });
  }

  return {
    config: {
      bookmarksPath,
      extensions,
      port,
      repoPath: envRepo ? path.resolve(expandHome(envRepo)) : storedRepo,
      version: 1,
    },
    issues,
  };
};

/**
 * `$schema` is added at the serialization edge, not carried on `DaemonConfig`.
 *
 * It exists for the editor alone, so every consumer of the config type stays
 * unaware of it. It is emitted first because that is where a reader looks for
 * it, and because JSON keeps insertion order.
 */
export const serializeConfig = (config: DaemonConfig): string =>
  `${JSON.stringify({ $schema: CONFIG_SCHEMA_REF, ...config }, null, 2)}\n`;

/**
 * Writes the JSON Schema next to the config it describes.
 *
 * The config lives outside any repository, so a repo-relative `$schema` cannot
 * reach it. The daemon regenerates the schema in the directory it owns, and
 * the editor then validates the file the user actually edits.
 *
 * Written in place, without the 0600 mode and temp-rename `saveDaemonConfig`
 * uses: this file holds no credentials, and a torn write self-heals on the
 * next boot. A byte-identical result is skipped, so an unchanged daemon does
 * not touch the file at all.
 */
export const ensureConfigSchemaFile = async (): Promise<void> => {
  const contents = `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;

  const current = await readFile(CONFIG_SCHEMA_PATH, 'utf8').catch(() => null);
  if (current === contents) {
    return;
  }

  await mkdir(CONFIG_DIR, { mode: 0o700, recursive: true });
  await writeFile(CONFIG_SCHEMA_PATH, contents, 'utf8');
};

/**
 * Writes with mode 0600 — the file contains credentials.
 *
 * Written to a temporary file and renamed rather than in place: an interrupted
 * write would otherwise truncate the file holding every paired extension's
 * token hash, and unpair every browser at once.
 *
 * A write whose result is byte-identical is skipped, so the common case of
 * booting with unchanged settings does not rewrite credentials at all.
 */
export const saveDaemonConfig = async (config: DaemonConfig): Promise<void> => {
  const contents = serializeConfig(config);

  const current = await readFile(CONFIG_PATH, 'utf8').catch(() => null);
  if (current === contents) {
    return;
  }

  await mkdir(CONFIG_DIR, { mode: 0o700, recursive: true });

  await atomicWriteFile(CONFIG_PATH, contents, { mode: 0o600 });
};

export const resolveRepoPath = (target: string): string => path.resolve(expandHome(target));

/**
 * Resolves the port to bind for this run, from the stored value and an
 * optional CLI `--port`.
 *
 * Deliberately pure and separate from `DaemonConfig`: the override lasts one
 * run only, so it must never reach the object `saveDaemonConfig` serializes.
 * `--port 0` (ask the OS for an ephemeral port, which the tests rely on) is a
 * valid override, so this tests `!== undefined` rather than truthiness; an
 * unusable value falls back to the stored port, like `MACHDOWN_PORT` does.
 */
export const effectivePort = (storedPort: number, override: number | undefined): number =>
  override !== undefined && Number.isFinite(override) && override >= 0 ? override : storedPort;
