import fp from 'fastify-plugin';
import { registerOpenApi } from '#server/openapi.ts';

/**
 * Serves the generated OpenAPI document and the browsable UI.
 *
 * Registered after the authentication plugin so its two routes pick up the
 * `onRequest` chain; both paths are in `PUBLIC_PATHS`, so they stay reachable
 * from a browser with no token.
 */
export default fp(
  async (app) => {
    await registerOpenApi(app, app.state.version);
  },
  { dependencies: ['machdown-state', 'machdown-auth'], name: 'machdown-openapi' },
);
