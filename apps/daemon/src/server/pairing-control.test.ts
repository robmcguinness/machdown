import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createPairingCodes } from './auth.ts';
import { pairingSocketPath, requestPairingCode, startPairingControl } from './pairing-control.ts';
import { run } from '#util/exec.ts';

const fixture = async (t: import('node:test').TestContext) => {
  // Keep Unix socket paths below the platform limit, even on macOS.
  const dir = await mkdtemp('/tmp/md-pair-');
  t.after(() => rm(dir, { force: true, recursive: true }));
  return dir;
};

const posix = { skip: process.platform === 'win32' };

test(
  'private control endpoint rotates single-use codes and closes idle clients',
  posix,
  async (t) => {
    const dir = await fixture(t);
    const codes = createPairingCodes();
    const old = codes.issue();
    const close = await startPairingControl(dir, 1234, codes);
    try {
      assert.equal((await stat(pairingSocketPath(dir, 1234))).mode & 0o777, 0o600);
      const issued = await requestPairingCode(dir, 1234);
      assert.ok(issued);
      assert.equal(codes.consume(old.code), false);
      assert.equal(codes.consume(issued.code), true);
      assert.equal(codes.consume(issued.code), false);
      const idle = createConnection(pairingSocketPath(dir, 1234));
      await once(idle, 'connect');
      const ended = once(idle, 'close');
      await close();
      await ended;
    } finally {
      // close() has already run on the successful path.
      if (await stat(pairingSocketPath(dir, 1234)).catch(() => null)) {
        await close();
      }
    }
    assert.equal(await requestPairingCode(dir, 1234), null);
  },
);

test(
  'rejects public directories, socket symlinks, and an already-running endpoint',
  posix,
  async (t) => {
    const dir = await fixture(t);
    await chmod(dir, 0o755);
    await assert.rejects(requestPairingCode(dir, 1234), /private/);
    await assert.rejects(startPairingControl(dir, 1234, createPairingCodes()), /private/);
    await chmod(dir, 0o700);
    const close = await startPairingControl(dir, 1234, createPairingCodes());
    t.after(close);
    await symlink(pairingSocketPath(dir, 1234), pairingSocketPath(dir, 5678));
    await assert.rejects(requestPairingCode(dir, 5678), /private/);
    await assert.rejects(startPairingControl(dir, 1234, createPairingCodes()), /already in use/);
  },
);

test(
  'invalid responses are rejected instead of falling back to a second daemon',
  posix,
  async (t) => {
    const dir = await fixture(t);
    const server = createServer((socket) => {
      socket.resume();
      socket.end('not JSON');
    });
    server.listen(pairingSocketPath(dir, 1234));
    await once(server, 'listening');
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    await chmod(pairingSocketPath(dir, 1234), 0o600);
    await assert.rejects(requestPairingCode(dir, 1234), /Invalid pairing control response/);
  },
);

test(
  'CLI --pair contacts the live daemon, exits, and produces a usable code',
  { ...posix, timeout: 20_000 },
  async (t) => {
    const dir = await fixture(t);
    const bootstrap = path.join(dir, 'boot.mjs');
    // Override the homedir API only in this child process; never touch real daemon state.
    await writeFile(
      bootstrap,
      `import os from 'node:os';\nos.homedir = () => ${JSON.stringify(dir)};\nawait import(${JSON.stringify(new URL('../main.ts', import.meta.url).href)});\n`,
    );
    const child = spawn(
      process.execPath,
      ['--conditions=source', bootstrap, '--pair', '--port', '0'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill('SIGTERM');
      await exited;
    });
    let output = '';
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /Machdown daemon\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          resolve(Number(match[1]));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', reject);
      child.once('exit', () => {
        reject(new Error(output));
      });
    });
    const configPath = path.join(dir, '.machdown', 'daemon.json');
    const before = await readFile(configPath, 'utf8');
    const result = await run(
      process.execPath,
      ['--conditions=source', bootstrap, '--pair', '--port', String(port)],
      { timeoutMs: 5_000 },
    );
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /Machdown daemon/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    const code = /Pairing code\s+([A-Z0-9-]+)/.exec(result.stdout)?.[1];
    assert.ok(code);
    const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      body: JSON.stringify({ code, extensionId: 'test-extension' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(child.exitCode, null);
  },
);

test(
  'a stale socket is recovered after its process exits',
  { ...posix, timeout: 5_000 },
  async (t) => {
    const dir = await fixture(t);
    const target = pairingSocketPath(dir, 1234);
    const script = `import { createServer } from 'node:net';\nimport { chmodSync } from 'node:fs';\ncreateServer().listen(${JSON.stringify(target)}, () => { chmodSync(${JSON.stringify(target)}, 0o600); process.stdout.write('ready'); });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await exited;
    assert.equal(await requestPairingCode(dir, 1234), null);
    const codes = createPairingCodes();
    const close = await startPairingControl(dir, 1234, codes);
    try {
      const issued = await requestPairingCode(dir, 1234);
      assert.ok(issued && codes.consume(issued.code));
    } finally {
      await close();
    }
  },
);
