#!/usr/bin/env node
import {
  CONFIG_DIR,
  effectivePort,
  ensureConfigSchemaFile,
  loadDaemonConfig,
  saveDaemonConfig,
} from './config.ts';
import path from 'node:path';
import { requestPairingCode, startPairingControl } from './server/pairing-control.ts';
import { buildApp } from './server/app.ts';
import closeWithGrace from 'close-with-grace';
import { createDaemonState } from './server/context.ts';
import { warmClipSnapshot } from './repo/store.ts';
import { ensureMigrated } from './repo/migrate.ts';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { isAddressInfo, isErrnoException } from './util/errors.ts';
import { z } from 'zod';
import { detach } from './util/detach.ts';

const PackageVersionSchema = z.looseObject({ version: z.string().optional() });

const readVersion = async (): Promise<string> => {
  try {
    const raw: unknown = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const pkg = PackageVersionSchema.parse(raw);
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/**
 * Reads the two flags the daemon accepts.
 *
 * `strict: false` keeps the tolerance the hand-rolled parser had: an unknown
 * flag is ignored, not a start-up failure. `--port` is read as a string and
 * converted here, so `--port 0` stays the ephemeral-port request the tests use.
 * A bare `--port` with no value parses as `true` under `strict: false`, so the
 * type is checked rather than coerced — `Number(true)` would bind port 1.
 */
// `strict: false` means the declared `type: 'string'` in readCliArgs below is
// a request, not an enforced contract: a bare `--port` still parses as the
// boolean `true`. This guard checks the value `parseArgs` actually returned
// instead of trusting the type the options object asked for.
const isPortString = (value: unknown): value is string => typeof value === 'string';

const readCliArgs = (argv: readonly string[]) => {
  const { values } = parseArgs({
    args: [...argv],
    options: { pair: { type: 'boolean' }, port: { type: 'string' } },
    strict: false,
  });

  return {
    pairOnly: values.pair === true,
    port: isPortString(values.port) ? Number(values.port) : undefined,
  };
};

const main = async (): Promise<void> => {
  const { pairOnly, port: portOverride } = readCliArgs(process.argv.slice(2));

  const { config, issues } = await loadDaemonConfig();
  const port = effectivePort(config.port, portOverride);
  const controlDirectory = path.join(CONFIG_DIR, 'control');
  // Contact the running daemon before persisting config or touching its repo.
  if (pairOnly && process.platform !== 'win32') {
    const issued = await requestPairingCode(controlDirectory, port);
    if (issued) {
      const minutes = Math.max(1, Math.ceil((issued.expiresAt - Date.now()) / 60_000));
      process.stdout.write(`Pairing code     ${issued.code}   (valid ${minutes} minutes)\n`);
      return;
    }
  }
  // Written back to materialize the first-run defaults, and nothing more. The
  // CLI override stays off `config` on purpose: `state.persist` re-serializes
  // that same object, so a pairing performed under `--port 0` used to store 0
  // and every later boot then bound a random port the extension could not find.
  await saveDaemonConfig(config);

  const state = createDaemonState(config, await readVersion());
  const app = await buildApp(state);
  let closeControl: (() => Promise<void>) | undefined;
  app.addHook('onClose', async () => {
    await closeControl?.();
  });

  if (issues.length > 0) {
    app.log.warn({ count: issues.length, issues }, 'ignored invalid config values');
  }

  // Non-fatal by design, like every other config problem: a read-only home
  // directory costs the user editor completion, not a daemon that starts.
  await ensureConfigSchemaFile().catch((cause: unknown) => {
    app.log.warn({ err: cause }, 'could not write the config schema file');
  });

  if (config.repoPath) {
    // A repo cloned from a machine running an older daemon still has the
    // category-directory layout; upgrade it before serving any request. A
    // failure here is not fatal — the repo stays readable, and every write path
    // retries the migration.
    await ensureMigrated(config.repoPath, state.withRepo).catch((cause: unknown) => {
      app.log.error({ err: cause }, 'could not upgrade the repository layout');
    });
    detach(
      () => warmClipSnapshot(config.repoPath!),
      (cause) => app.log.warn({ err: cause }, 'clip snapshot warm-up failed'),
    );
  }

  try {
    // Loopback only. Binding 0.0.0.0 would expose file writes and git to the
    // local network.
    await app.listen({ host: '127.0.0.1', port });
  } catch (error) {
    // Nothing installed the graceful shutdown yet, so release what the failed
    // start already opened before handing the error to the top-level reporter.
    // `app.close()` also runs the `onClose` hook that closes the qmd worker.
    await app.close().catch(() => {});
    throw error;
  }

  const { code, expiresAt } = state.pairingCodes.issue();
  const address = app.server.address();
  const boundPort = isAddressInfo(address) ? address.port : port;
  if (process.platform !== 'win32') {
    try {
      closeControl = await startPairingControl(controlDirectory, boundPort, state.pairingCodes);
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  /**
   * Installed only once the server is actually up.
   *
   * `close-with-grace` also listens for `beforeExit`, and on a clean drain it
   * calls `process.exit(0)` — which overrides the exit code the start-up
   * failure path sets. Registered any earlier, a daemon that could not bind its
   * port would report success to whatever supervises it.
   *
   * The delay allows the qmd close reply budget of ten seconds plus its two
   * second exit guard, with time left for the HTTP drain. Falling short is not a
   * tidier shutdown: close-with-grace's timeout path is another hard
   * `process.exit`, which is exactly the abort this budget exists to avoid.
   * `logger` sends its second-signal and timeout notices through pino instead
   * of raw `console.error`.
   */
  closeWithGrace({ delay: 15_000, logger: app.log }, async ({ err }) => {
    if (err) {
      app.log.error({ err }, 'shutting down after an error');
    }
    // The `onClose` hook closes the qmd worker's open database, so closing the
    // server is what makes the shutdown clean rather than merely quick.
    await app.close();
  });

  const minutes = Math.round((expiresAt - Date.now()) / 60_000);

  // Read back rather than reuse the requested port: `--port 0` asks the OS to
  // pick one, and printing the 0 we asked for would give an address nobody can
  // open.
  process.stdout.write(
    [
      '',
      `  Machdown daemon  http://127.0.0.1:${boundPort}`,
      `  API docs         http://127.0.0.1:${boundPort}/docs`,
      `  Repository       ${config.repoPath ?? '(not configured — set one from the extension options)'}`,
      '',
      `  Pairing code     ${code}   (valid ${minutes} minutes)`,
      config.extensions.length > 0
        ? `  Paired           ${config.extensions.length} extension(s)`
        : '  Paired           none yet',
      '',
    ].join('\n'),
  );

  if (pairOnly) {
    app.log.info('issued a new pairing code; the daemon stays up so pairing can complete');
  }
};

function isListenError(cause: unknown): cause is NodeJS.ErrnoException & { port?: number } {
  return isErrnoException(cause);
}

/**
 * Reports a start-up failure as a sentence rather than a stack trace.
 *
 * The overwhelmingly common one is a second daemon on an occupied port, and
 * the fix is obvious once it is named.
 */
const explainStartupFailure = (cause: unknown): string => {
  // Node puts the port it tried to bind on the error itself, so this stays
  // correct whichever of --port, MACHDOWN_PORT, or the config file supplied it.
  const listenError = isListenError(cause) ? cause : null;

  if (listenError?.code === 'EADDRINUSE') {
    return [
      `Port ${listenError.port ?? '(unknown)'} is already in use.`,
      'Another Machdown daemon is probably running.',
      'Stop it, or start this one with --port <other port>.',
    ].join(' ');
  }

  return cause instanceof Error ? cause.message : String(cause);
};

try {
  await main();
} catch (cause) {
  process.stderr.write(`machdownd: ${explainStartupFailure(cause)}\n`);
  process.exitCode = 1;
}
