import { zipSync } from 'fflate';
import type { ZipFiles, ZipReply } from './zip.ts';

self.addEventListener('message', (event: MessageEvent<ZipFiles>) => {
  try {
    // oxlint-disable-next-line node/no-sync -- this is a dedicated Web Worker; blocking it is the point
    const data = zipSync(event.data);
    const reply: ZipReply = { data, ok: true };
    self.postMessage(reply, { transfer: [data.buffer] });
  } catch (error) {
    const reply: ZipReply = {
      error: error instanceof Error ? error.message : 'ZIP compression failed',
      ok: false,
    };
    self.postMessage(reply);
  }
});
