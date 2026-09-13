import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';
import { runInNewContext } from 'node:vm';
import type { ClipRequest, ClipResponse } from '../src/types/clip.ts';
import { DEFAULT_SETTINGS } from '../src/common/appTypes.ts';

type Listener = (
  message: ClipRequest,
  sender: { tabId?: number },
  reply: (response: ClipResponse) => void,
) => boolean;

await test('reinjecting the built clipper installs only one extraction listener', async () => {
  const bundle = await build({
    build: { write: false },
    configFile: 'vite.content.config.ts',
    logLevel: 'silent',
  });
  assert.ok('output' in bundle);
  const chunk = bundle.output.find((entry) => entry.type === 'chunk');
  assert.ok(chunk?.type === 'chunk');
  const listeners: Listener[] = [];
  const scope = {
    chrome: {
      runtime: {
        onMessage: {
          addListener: (listener: Listener) => {
            listeners.push(listener);
          },
        },
      },
    },
  };
  runInNewContext(chunk.code, scope);
  runInNewContext(chunk.code, scope);
  runInNewContext(chunk.code, scope);
  assert.equal(listeners.length, 1);
  let replies = 0;
  // No DOM: extraction fails and sends exactly one error response.
  const reply = () => {
    replies += 1;
  };
  for (const listener of listeners) {
    listener({ settings: DEFAULT_SETTINGS, type: 'clip:extract' }, {}, reply);
  }
  assert.equal(replies, 1);
  runInNewContext(chunk.code, { chrome: scope.chrome });
  assert.equal(listeners.length, 2, 'a new document gets its own listener');
});
