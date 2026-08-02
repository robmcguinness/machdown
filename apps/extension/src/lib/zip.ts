export type ZipFiles = Record<string, Uint8Array<ArrayBuffer>>;
export type ZipReply = { data: Uint8Array<ArrayBuffer>; ok: true } | { error: string; ok: false };

/** A worker transport: production uses a bundled browser worker. */
export type ZipWorker = {
  listen: (receive: (reply: ZipReply) => void, fail: (error: Error) => void) => void;
  post: (files: ZipFiles, transfer: ArrayBuffer[]) => void;
  terminate: () => void;
};

const createZipWorker = (): ZipWorker => {
  const worker = new Worker(new URL('./zip.worker.ts', import.meta.url), { type: 'module' });
  return {
    listen: (receive, fail) => {
      worker.addEventListener('message', (event: MessageEvent<ZipReply>) => {
        receive(event.data);
      });
      worker.addEventListener('error', (event) => {
        fail(new Error(event.message || 'ZIP compression failed'));
      });
      worker.addEventListener('messageerror', () => {
        fail(new Error('Could not read the ZIP worker response'));
      });
    },
    post: (files, transfer) => {
      worker.postMessage(files, transfer);
    },
    terminate: () => {
      worker.terminate();
    },
  };
};

/** Consumes input buffers; callers must not reuse them after this call. */
export const zipFiles = async (
  files: ZipFiles,
  createWorker: () => ZipWorker = createZipWorker,
): Promise<Uint8Array<ArrayBuffer>> => {
  const worker = createWorker();
  try {
    return await new Promise((resolve, reject) => {
      worker.listen((reply) => {
        if (reply.ok) {
          resolve(reply.data);
        } else {
          reject(new Error(reply.error));
        }
      }, reject);
      // Unique transferables avoid a DataCloneError if two files share a buffer.
      worker.post(files, [...new Set(Object.values(files).map((file) => file.buffer))]);
    });
  } finally {
    worker.terminate();
  }
};
