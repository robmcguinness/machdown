import { CommandError, run } from '#util/exec.ts';
import { PathRejectedError, assertWithinAny, resolveRepoRelative } from '#repo/paths.ts';
import { authed, os, withRepoPath } from './base.ts';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { DirectoryEntry } from '@machdown/contract';
import { expandHome } from '#config.ts';
import { env } from '#env';
import nodeOs from 'node:os';
import path from 'node:path';
import { sync } from '#repo/git.ts';
import { reconcileAfterPull } from '#repo/reconcile.ts';
import { isErrnoException } from '#util/errors.ts';

/** Per-platform "open this file in whatever handles it". */
const openCommand = (target: string) => {
  switch (process.platform) {
    case 'darwin':
      return { args: [target], file: 'open' };
    case 'win32':
      return { args: ['/c', 'start', '', target], file: 'cmd' };
    default:
      return { args: [target], file: 'xdg-open' };
  }
};

/**
 * Opens a clip locally.
 *
 * The path is resolved and containment-checked against the repo first, so this
 * cannot be turned into "open any file on the machine".
 */
export const systemOpen = os.system.open
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    let absPath: string;
    try {
      absPath = await resolveRepoRelative(context.repoPath, input.path);
    } catch (error) {
      if (error instanceof PathRejectedError) {
        throw errors.PATH_REJECTED();
      }
      throw error;
    }

    const { args, file } = openCommand(absPath);
    await run(file, args, { timeoutMs: 10_000 });
    return { ok: true };
  });

/**
 * Directories that are never worth showing in a location picker and are noisy
 * or enormous when they are: VCS internals, dependency trees, the macOS
 * library, and the trash.
 */
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules', '.Trash', 'Library']);

/** Enough to browse comfortably; beyond this the UI asks the user to type. */
const MAX_ENTRIES = 500;

/**
 * Where the picker may look: the home directory, plus the configured repo and
 * bookmarks folder when they live outside home, plus an explicit env allowlist
 * for a knowledge base on an external volume.
 *
 * The caller is a browser extension page. Rooting this at `/` would turn a
 * paired extension into a filesystem enumerator, which is a far larger grant
 * than "help me pick a folder".
 *
 * Exported because `bookmarks.setLocation` containment-checks against exactly
 * the same set: a folder the picker cannot show must not be settable by typing
 * its path into the field next to it.
 */
export const allowedRoots = (repoPath: string | null, bookmarksPath: string | null): string[] => {
  const roots = [nodeOs.homedir()];
  if (repoPath) {
    roots.push(path.resolve(repoPath));
  }
  if (bookmarksPath) {
    roots.push(path.resolve(bookmarksPath));
  }

  for (const extra of env.MACHDOWN_BROWSE_ROOTS.split(':')) {
    const trimmed = extra.trim();
    if (trimmed !== '') {
      roots.push(path.resolve(expandHome(trimmed)));
    }
  }

  return roots;
};

const isDirectoryEntry = async (
  full: string,
  entry: { isDirectory: () => boolean; isSymbolicLink: () => boolean },
  roots: readonly string[],
): Promise<boolean> => {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }

  // A symlink counts only if it still lands inside an allowed root — otherwise
  // it is a way out of the sandbox, so it is omitted rather than errored.
  try {
    const target = await realpath(full);
    if (!(await stat(target)).isDirectory()) {
      return false;
    }
    await assertWithinAny(roots, target);
    return true;
  } catch {
    return false;
  }
};

const describe = async (full: string, name: string): Promise<DirectoryEntry> => {
  const base: DirectoryEntry = {
    childCount: null,
    hidden: name.startsWith('.'),
    isGitRepo: false,
    isMachdownRepo: false,
    name,
    path: full,
    readable: true,
  };

  try {
    const children = await readdir(full, { withFileTypes: true });
    return {
      ...base,
      childCount: children.filter((child) => child.isDirectory()).length,
      isGitRepo: children.some((child) => child.name === '.git'),
      isMachdownRepo: children.some((child) => child.name === '.machdown'),
    };
  } catch {
    // A directory we cannot read is still worth showing — greyed out — so the
    // user understands why their folder is missing rather than assuming a bug.
    return { ...base, readable: false };
  }
};

/**
 * Lists directories so the extension can offer a real location picker.
 *
 * A Chrome extension page cannot hand the daemon a filesystem path —
 * `showDirectoryPicker()` returns an opaque handle — so browsing has to happen
 * on this side. Only directories are ever returned: listing files would make
 * this a file-existence oracle for anything under the allowed roots.
 */
export const systemListDirectory = os.system.listDirectory
  .use(authed)
  .handler(async ({ context, errors, input }) => {
    const roots = allowedRoots(context.state.config.repoPath, context.state.config.bookmarksPath);
    const home = nodeOs.homedir();

    const rootEntries = await Promise.all(
      [...new Set(roots)].map((root) => describe(root, path.basename(root) || root)),
    );

    if (input.path.trim() === '') {
      return {
        breadcrumbs: [],
        entries: rootEntries,
        parent: null,
        path: '',
        roots: rootEntries,
        truncated: false,
        writable: false,
      };
    }

    let target: string;
    try {
      target = await assertWithinAny(roots, path.resolve(expandHome(input.path.trim())));
    } catch (error) {
      if (error instanceof PathRejectedError) {
        throw errors.PATH_REJECTED();
      }
      throw error;
    }

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (cause) {
      const code = isErrnoException(cause) ? cause.code : undefined;
      if (code === 'EACCES' || code === 'EPERM') {
        throw errors.BAD_REQUEST({ message: 'That folder cannot be read.' });
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw errors.BAD_REQUEST({ message: 'That folder does not exist.' });
      }
      throw cause;
    }

    const named = dirents
      .filter((entry) => input.showHidden || !entry.name.startsWith('.'))
      .filter((entry) => !ALWAYS_HIDDEN.has(entry.name))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    const directories: DirectoryEntry[] = [];
    let truncated = false;

    for (const entry of named) {
      if (directories.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const full = path.join(target, entry.name);
      if (!(await isDirectoryEntry(full, entry, roots))) {
        continue;
      }
      directories.push(await describe(full, entry.name));
    }

    // Stop at the outermost root that contains `target`, so the UI has no
    // affordance for climbing out of the sandbox.
    const containing =
      roots.filter((root) => target === root || target.startsWith(`${root}${path.sep}`)) ?? [];
    const boundary = containing.toSorted((a, b) => a.length - b.length)[0] ?? home;

    const breadcrumbs: { name: string; path: string }[] = [];
    for (let cursor = target; cursor.startsWith(boundary);) {
      breadcrumbs.unshift({ name: path.basename(cursor) || cursor, path: cursor });
      if (cursor === boundary) {
        break;
      }
      const up = path.dirname(cursor);
      if (up === cursor) {
        break;
      }
      cursor = up;
    }

    const parent = target === boundary ? null : path.dirname(target);

    return {
      breadcrumbs,
      entries: directories,
      parent,
      path: target,
      roots: rootEntries,
      truncated,
      writable: true,
    };
  });

/**
 * Pulls, and pushes only when explicitly asked.
 *
 * Saves commit automatically, but publishing to a remote stays a deliberate
 * action rather than a side effect of clipping a page.
 */
export const gitSync = os.git.sync
  .use(authed)
  .use(withRepoPath)
  .handler(async ({ context, errors, input }) => {
    return context.state.withRepo(async () => {
      try {
        return await sync(context.repoPath, input.push, () => reconcileAfterPull(context.repoPath));
      } catch (error) {
        if (error instanceof CommandError) {
          throw errors.GIT_FAILED({ data: { command: error.command, stderr: error.stderr } });
        }
        throw error;
      }
    });
  });
