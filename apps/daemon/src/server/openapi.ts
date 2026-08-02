import type { FastifyInstance } from 'fastify';
import { ERROR_STATUS_MAP } from './errorStatus.ts';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod';
import { contract } from '@machdown/contract';

const generator = new OpenAPIGenerator({
  converters: [new ZodToJsonSchemaConverter()],
});

/**
 * Scalar renders the spec without the daemon bundling any UI assets itself.
 *
 * Pinned and checked with SRI rather than floating on `@latest`. Unpinned, the
 * daemon executes whatever that tag points at on the day someone opens `/docs`
 * — and there is no version an integrity hash could describe. The trade is that
 * an upgrade is now three deliberate steps:
 *
 *   1. pick the new version;
 *   2. `curl -sL https://cdn.jsdelivr.net/npm/@scalar/api-reference@<version>
 *      | openssl dgst -sha384 -binary | openssl base64 -A`;
 *   3. update SCALAR_VERSION and SCALAR_SRI together.
 *
 * Note this page still needs the network. Everything else the daemon does works
 * offline; only the docs UI does not.
 */
const SCALAR_VERSION = '1.64.0';
const SCALAR_SRI = 'sha384-MjGH/UsAZcRWbWSD70Yp9VOYGaCELxb+2a6meIvJsl5NkpqfdvkepJM6+ExL2Vmv';
const SCALAR_SRC = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}`;

const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Machdown daemon API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script
      src="${SCALAR_SRC}"
      integrity="${SCALAR_SRI}"
      crossorigin="anonymous"
    ></script>
  </body>
</html>
`;

/** Exported so the CSP in the security plugin cannot drift from the tag above. */
export const SCALAR_ORIGIN = 'https://cdn.jsdelivr.net';

/**
 * Serves the generated OpenAPI document and a browsable UI.
 *
 * The spec is generated from the same contract the router implements, so it
 * cannot drift from the actual behaviour — and it makes the daemon debuggable
 * with plain curl.
 */
export const registerOpenApi = async (app: FastifyInstance, version: string): Promise<void> => {
  const document = await generator.generate(contract, {
    // The same map the handler answers with, so a documented status is the
    // status a caller actually gets.
    base: {
      info: {
        description:
          'Local companion daemon for the Machdown extension. Binds to loopback only; ' +
          'every route except /v1/health requires a bearer token obtained by pairing.',
        title: 'Machdown daemon',
        version,
      },
      servers: [{ url: '/' }],
    },
    errorStatusMap: ERROR_STATUS_MAP,
  });

  // The document is fixed once the contract is generated, so the bytes are
  // built here rather than re-serialized on every poll of the spec.
  const documentJson = JSON.stringify(document);

  app.get('/openapi.json', async (_request, reply) => {
    await reply.type('application/json; charset=utf-8').send(documentJson);
  });

  app.get('/docs', async (_request, reply) => {
    await reply.type('text/html; charset=utf-8').send(DOCS_HTML);
  });
};
