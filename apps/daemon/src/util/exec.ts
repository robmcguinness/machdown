import { execFile, type ExecException } from 'node:child_process';
import { promisify } from 'node:util';

/** Whether a thrown value is the shape `execFile` rejects with. */
function isExecFileException(cause: unknown): cause is ExecException {
  return cause instanceof Error;
}

const isNumber = (value: unknown): value is number => typeof value === 'number';
const isString = (value: unknown): value is string => typeof value === 'string';

// `execFile` carries a `util.promisify.custom` overload, so the callback shape
// the rule sees is never the one actually invoked.
// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  /** Exit codes that are expected rather than failures (e.g. `git diff --quiet`). */
  allowExitCodes?: readonly number[];
  env?: NodeJS.ProcessEnv;
};

export type RunResult = {
  code: number;
  stderr: string;
  stdout: string;
};

export class CommandError extends Error {
  readonly command: string;
  readonly code: number;
  readonly stderr: string;

  constructor(command: string, code: number, stderr: string, cause?: unknown) {
    super(`${command} exited with code ${code}: ${stderr.trim() || '(no output)'}`, { cause });
    this.name = 'CommandError';
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Runs an external command with an argv array.
 *
 * Never uses a shell, so no caller can turn a category name or search query
 * into command injection.
 */
export const run = async (
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> => {
  const { allowExitCodes = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  try {
    const { stderr, stdout } = await execFileAsync(file, [...args], {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: MAX_BUFFER,
      shell: false,
      timeout: timeoutMs,
    });
    return { code: 0, stderr, stdout };
  } catch (cause) {
    if (!isExecFileException(cause)) {
      throw cause;
    }

    // ENOENT and friends surface `code` as a string; a real exit status is numeric.
    const code = isNumber(cause.code) ? cause.code : -1;
    const stdout = isString(cause.stdout) ? cause.stdout : '';
    const stderr = isString(cause.stderr) ? cause.stderr : cause.message;

    if (allowExitCodes.includes(code)) {
      return { code, stderr, stdout };
    }

    throw new CommandError(`${file} ${args.join(' ')}`, code, stderr, cause);
  }
};

/** True when the executable is on PATH and answers within `timeoutMs`. */
export const isAvailable = async (file: string, probeArgs: readonly string[] = ['--version']) => {
  try {
    await run(file, probeArgs, { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
};
