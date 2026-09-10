import { run } from '#util/exec.ts';
import type { CommitInfo, RepoStatus } from '@machdown/contract';
import path from 'node:path';
import { stat } from 'node:fs/promises';

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Identity used only when the repository has none configured, so a clip never
 * fails to commit just because the user has no global git identity.
 */
const FALLBACK_IDENTITY = [
  '-c',
  'user.name=Machdown',
  '-c',
  'user.email=machdown@localhost',
] as const;

const git = (repoPath: string, args: readonly string[], allowExitCodes?: readonly number[]) =>
  run('git', ['-C', repoPath, ...args], { allowExitCodes });

export const isGitRepo = async (repoPath: string): Promise<boolean> => {
  try {
    const { stdout } = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
};

export const init = async (repoPath: string): Promise<void> => {
  await run('git', ['init', '--initial-branch=main', repoPath], { allowExitCodes: [] });
};

const hasIdentity = async (repoPath: string): Promise<boolean> => {
  const [name, email] = await Promise.all([
    git(repoPath, ['config', '--get', 'user.name'], [1]),
    git(repoPath, ['config', '--get', 'user.email'], [1]),
  ]);
  return (
    name.code === 0 && email.code === 0 && name.stdout.trim() !== '' && email.stdout.trim() !== ''
  );
};

export const currentBranch = async (repoPath: string): Promise<string> => {
  const { stdout } = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], [128]);
  const branch = stdout.trim();
  // A repo with no commits yet reports the unborn branch name via symbolic-ref.
  if (branch === '' || branch === 'HEAD') {
    const symbolic = await git(repoPath, ['symbolic-ref', '--short', 'HEAD'], [1, 128]);
    return symbolic.stdout.trim() || 'main';
  }
  return branch;
};

export const isDirty = async (repoPath: string): Promise<boolean> => {
  const { stdout } = await git(repoPath, ['status', '--porcelain']);
  return stdout.trim() !== '';
};

export const hasRemote = async (repoPath: string): Promise<boolean> => {
  const { stdout } = await git(repoPath, ['remote']);
  return stdout.trim() !== '';
};

export const headSha = async (repoPath: string): Promise<string | null> => {
  const { code, stdout } = await git(repoPath, ['rev-parse', 'HEAD'], [128]);
  return code === 0 ? stdout.trim() : null;
};

export const status = async (repoPath: string): Promise<RepoStatus> => {
  if (!(await isGitRepo(repoPath))) {
    return null;
  }
  const [branch, dirty, remote] = await Promise.all([
    currentBranch(repoPath),
    isDirty(repoPath),
    hasRemote(repoPath),
  ]);
  return { branch, dirty, hasRemote: remote, path: repoPath };
};

/** Stages a rename so history follows the file across a category change. */
export const move = async (repoPath: string, from: string, to: string): Promise<void> => {
  await git(repoPath, ['mv', '--', from, to]);
};

/**
 * Stages the daemon-owned paths and commits only if something actually changed.
 *
 * Returning `null` instead of creating an empty commit matters: the README is
 * regenerated on every mutation, and without this check a no-op save would add
 * a commit to history every time.
 */
export const commitIfChanged = async (
  repoPath: string,
  message: string,
  paths: readonly string[] = ['README.md', '.gitignore', '.machdown', 'clips'],
): Promise<CommitInfo> => {
  // Include tracked deletions as well as existing paths. Literal pathspecs
  // prevent filenames with glob characters from selecting other files.
  const present: string[] = [];
  for (const entry of new Set(paths)) {
    const literal = `:(literal)${entry}`;
    const exists = await pathExists(path.join(repoPath, entry));
    const tracked = exists
      ? null
      : await git(repoPath, ['ls-files', '--error-unmatch', '--', literal], [1]);
    if (exists || tracked?.code === 0) {
      present.push(literal);
    }
  }
  if (present.length === 0) {
    return null;
  }

  await git(repoPath, ['add', '-A', '--', ...present]);

  const staged = await git(repoPath, ['diff', '--cached', '--quiet', '--', ...present], [1]);
  if (staged.code === 0) {
    return null;
  }

  const identityArgs = (await hasIdentity(repoPath)) ? [] : [...FALLBACK_IDENTITY];
  await run('git', [
    '-C',
    repoPath,
    ...identityArgs,
    'commit',
    '--only',
    '-m',
    message,
    '--',
    ...present,
  ]);

  const sha = await headSha(repoPath);
  return sha ? { message, sha } : null;
};

export type SyncResult = {
  pulled: boolean;
  pushed: boolean;
  sha: string | null;
};

/**
 * Pull (rebase) and optionally push.
 *
 * Push is never implicit — the daemon commits on every save, but sending those
 * commits to a remote is an outward-facing action the user triggers.
 */
export const sync = async (
  repoPath: string,
  push: boolean,
  afterPull: () => Promise<void> = async () => {},
): Promise<SyncResult> => {
  if (!(await hasRemote(repoPath))) {
    return { pulled: false, pushed: false, sha: await headSha(repoPath) };
  }

  // On failure, leave the tree as git left it; the caller surfaces GIT_FAILED.
  await git(repoPath, ['pull', '--rebase', '--autostash']);
  // Local files have changed even if the following push fails.
  await afterPull();

  let pushed = false;
  if (push) {
    await git(repoPath, ['push']);
    pushed = true;
  }

  return { pulled: true, pushed, sha: await headSha(repoPath) };
};
