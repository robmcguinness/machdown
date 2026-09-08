/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { zipFiles, type ZipReply, type ZipWorker } from '../src/lib/zip.ts';

await test('bundled ZIP worker round-trips files, transfers buffers and terminates', async () => {
  const bundle = await build({
    build: {
      rolldownOptions: { input: 'src/lib/zip.worker.ts', output: { format: 'iife' } },
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
  });
  assert.ok('output' in bundle);
  const chunk = bundle.output.find((entry) => entry.type === 'chunk');
  assert.ok(chunk?.type === 'chunk');
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    globalThis.self = {
      addEventListener: (_type, listener) => parentPort.on('message', data => listener({ data })),
      postMessage: (data, options) => parentPort.postMessage(data, options?.transfer),
    };
    ${chunk.code}
  `,
    { eval: true },
  );
  let terminated = false;
  const transport: ZipWorker = {
    listen: (receive, fail) => {
      worker.on('message', (reply: ZipReply) => {
        receive(reply);
      });
      worker.on('error', fail);
    },
    post: (files, transfer) => {
      worker.postMessage(files, transfer);
    },
    terminate: () => {
      terminated = true;
      void worker.terminate();
    },
  };
  const shared = strToU8('# Hello café\n');
  const files = { 'empty.md': new Uint8Array(0), 'first.md': shared, 'nested/second.md': shared };
  const pending = zipFiles(files, () => transport);
  assert.equal(shared.byteLength, 0, 'input ownership moved to the worker');
  const result = unzipSync(await pending);
  assert.equal(strFromU8(result['first.md']), '# Hello café\n');
  assert.equal(strFromU8(result['nested/second.md']), '# Hello café\n');
  assert.equal(result['empty.md'].length, 0);
  assert.ok(terminated);
});

await test('compression and transport failures reject and terminate the worker', async () => {
  for (const failure of ['compression', 'transport', 'post']) {
    let terminated = false;
    const transport: ZipWorker = {
      listen: (receive, fail) => {
        if (failure === 'compression') {
          receive({ error: 'bad input', ok: false });
        }
        if (failure === 'transport') {
          fail(new Error('worker crashed'));
        }
      },
      post: () => {
        if (failure === 'post') {
          throw new Error('could not transfer');
        }
      },
      terminate: () => {
        terminated = true;
      },
    };
    await assert.rejects(
      zipFiles({}, () => transport),
      /bad input|worker crashed|could not transfer/,
    );
    assert.ok(terminated);
  }
});
