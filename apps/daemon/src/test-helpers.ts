import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '@machdown/contract';
import os from 'node:os';
import path from 'node:path';
import { run } from './util/exec.ts';

/** The daemon's own runner, so the tests shell out exactly the way it does. */
const git = (args: string[]) => run('git', args, { timeoutMs: 30_000 });

/**
 * Builds a throwaway repository on disk.
 *
 * These tests are about filesystem and git behaviour — renames surviving as
 * renames, an idempotent second run leaving a clean tree — so there is nothing
 * useful to mock. A real temp directory is both simpler and a stronger check.
 */
export const makeRepo = async (options: { layoutVersion?: number } = {}): Promise<string> => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'machdown-test-'));

  await mkdir(path.join(repoPath, '.machdown'), { recursive: true });
  await mkdir(path.join(repoPath, 'clips'), { recursive: true });

  await writeFile(
    path.join(repoPath, '.machdown', 'config.json'),
    `${JSON.stringify({ ...DEFAULT_CONFIG, layoutVersion: options.layoutVersion ?? 1 }, null, 2)}\n`,
    'utf8',
  );

  await git(['init', '-q', repoPath]);
  // Preserve Git's generated config and set fixture-local options in one
  // write instead of starting a process for each setting.
  // A developer's global config may sign commits through an external agent
  // (1Password, gpg), which is unavailable to a non-interactive test run.
  await appendFile(
    path.join(repoPath, '.git', 'config'),
    '\n[user]\n\temail = test@machdown.local\n\tname = Machdown Test\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n',
    'utf8',
  );

  return repoPath;
};

export const commitAll = async (repoPath: string, message = 'test fixture'): Promise<void> => {
  await git(['-C', repoPath, 'add', '-A']);
  await git(['-C', repoPath, 'commit', '-q', '-m', message]);
};

export const porcelain = async (repoPath: string): Promise<string> => {
  const { stdout } = await git(['-C', repoPath, 'status', '--porcelain']);
  return stdout.trim();
};

/** Rename detection as git itself reports it, e.g. `R  clips/A/x.md -> clips/x.md`. */
export const stagedRenames = async (repoPath: string): Promise<string[]> => {
  await git(['-C', repoPath, 'add', '-A']);
  const { stdout } = await git(['-C', repoPath, 'diff', '--cached', '-M', '--name-status']);
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('R'))
    .map((line) => line.trim());
};

export const writeClip = async (
  repoPath: string,
  relPath: string,
  frontmatter: Record<string, string>,
  body = 'Body text.',
): Promise<void> => {
  const target = path.join(repoPath, relPath);
  await mkdir(path.dirname(target), { recursive: true });

  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  await writeFile(target, `---\n${lines.join('\n')}\n---\n\n${body}\n`, 'utf8');
};
