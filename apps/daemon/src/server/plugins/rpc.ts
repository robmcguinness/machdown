import { ERROR_STATUS_MAP } from '#server/errorStatus.ts';
import { OpenAPIHandler } from '@orpc/openapi/fastify';
import { SmartCoercionHandlerPlugin } from '@orpc/json-schema';
import { ZodToJsonSchemaConverter } from '@orpc/zod';
import fp from 'fastify-plugin';
import { router } from '#router/index.ts';

/**
 * Hands every remaining path to oRPC, which matches it against the contract.
 *
 * The handler is built here rather than at module scope so importing this file
 * has no effect on its own, and so each `buildApp` in a test gets its own.
 *
 * The coercion plugin is required, not optional: query strings and path params
 * are always strings, so a GET input like `showHidden=false` reaches Zod as
 * `'false'` and fails `z.boolean()` with "Input validation failed".
 */
export default fp(
  async (app) => {
    const handler = new OpenAPIHandler(router, {
      errorStatusMap: ERROR_STATUS_MAP,
      plugins: [new SmartCoercionHandlerPlugin({ converters: [new ZodToJsonSchemaConverter()] })],
    });

    app.route({
      // Not `all`: @fastify/cors owns OPTIONS, and declaring it twice collides.
      handler: async (request, reply) => {
        // `extension` was resolved once by the auth plugin; re-verifying here
        // would hash the token a second time on every single request.
        const { matched } = await handler.handle(request, reply, {
          context: {
            extension: request.extension,
            log: request.log,
            state: app.state,
            token: request.token,
          },
        });

        if (!matched) {
          return reply.callNotFound();
        }
      },
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/*',
    });
  },
  { dependencies: ['machdown-state', 'machdown-auth'], name: 'machdown-rpc' },
);
