import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { PairingCode, PairingCodes } from './auth.ts';
import { isErrnoException } from '#util/errors.ts';

const TIMEOUT_MS = 2_000;
const PairingCodeSchema = z.object({
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  expiresAt: z.number().int().positive(),
});

export const pairingSocketPath = (directory: string, port: number): string =>
  path.join(directory, `${port}.sock`);

const missing = (code: string | undefined): boolean => code === 'ENOENT' || code === 'ECONNREFUSED';

/** Reject symlinks and paths accessible to another account, on both sides. */
const assertPrivate = async (target: string, socket: boolean): Promise<void> => {
  const info = await lstat(target);
  if (
    !process.getuid ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    !(socket ? info.isSocket() : info.isDirectory())
  ) {
    throw new Error(
      `Pairing control path must be private and owned by the current user: ${target}`,
    );
  }
};

/** Null means no running control endpoint; invalid replies and permissions are errors. */
export const requestPairingCode = async (
  directory: string,
  port: number,
): Promise<PairingCode | null> => {
  const target = pairingSocketPath(directory, port);
  try {
    await assertPrivate(directory, false);
    await assertPrivate(target, true);
  } catch (error) {
    if (isErrnoException(error) && missing(error.code)) {
      return null;
    }
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(target);
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy(new Error('Timed out requesting a pairing code.'));
    });
    socket.on('connect', () => {
      socket.write('pair\n');
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.length > 1_024) {
        socket.destroy(new Error('Invalid pairing control response.'));
      }
    });
    socket.on('error', (error) => {
      if (isErrnoException(error) && missing(error.code)) {
        resolve(null);
      } else {
        reject(error);
      }
    });
    socket.on('end', () => {
      try {
        resolve(PairingCodeSchema.parse(JSON.parse(response)));
      } catch (error) {
        reject(new Error('Invalid pairing control response.', { cause: error }));
      } finally {
        socket.destroy();
      }
    });
  });
};

const isListening = (target: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(target);
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy(new Error('Pairing control socket did not answer.'));
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', (error) => {
      if (isErrnoException(error) && missing(error.code)) {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });

/** Start after binding the HTTP port; the port identifies the daemon to contact. */
export const startPairingControl = async (
  directory: string,
  port: number,
  codes: PairingCodes,
): Promise<() => Promise<void>> => {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await assertPrivate(directory, false);
  const target = pairingSocketPath(directory, port);
  try {
    await assertPrivate(target, true);
    if (await isListening(target)) {
      throw new Error('Pairing control socket is already in use.');
    }
    await unlink(target);
  } catch (error) {
    if (!isErrnoException(error) || !missing(error.code)) {
      throw error;
    }
  }

  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => {
      connections.delete(socket);
    });
    // A client can disconnect before receiving its answer.
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
    });
    let command = '';
    socket.on('data', (chunk: string) => {
      command += chunk;
      if (command === 'pair\n') {
        socket.end(`${JSON.stringify(codes.issue())}\n`);
      } else if (!'pair\n'.startsWith(command)) {
        socket.destroy();
      }
    });
  });
  const close = async (): Promise<void> => {
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chmod(target, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  server.unref();
  return close;
};
