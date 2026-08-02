import { open, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isErrnoException } from './errors.ts';

/**
 * Replace one file only after its complete contents have been flushed and closed.
 * The temporary file is a sibling so rename stays on the same filesystem.
 * Callers create the parent directory and serialize competing logical updates.
 */
export const atomicWriteFile = async (
  target: string,
  contents: string,
  options: { mode?: number; signal?: AbortSignal } = {},
): Promise<void> => {
  options.signal?.throwIfAborted();
  let previous;
  try {
    previous = await stat(target);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  const mode = options.mode ?? (previous ? previous.mode & 0o777 : 0o666);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try {
    // Preserve existing permissions even when the current umask is stricter.
    if (previous || options.mode !== undefined) {
      await file.chmod(mode);
    }
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    options.signal?.throwIfAborted();
    await rename(temporary, target);
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
};
