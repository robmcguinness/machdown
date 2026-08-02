import type { DaemonState } from '#server/context.ts';
import fp from 'fastify-plugin';

/**
 * Publishes the process-wide daemon state on the server instance.
 *
 * It used to be captured in `buildApp`'s closure, which meant only code written
 * inside that one function could reach it. As a decorator every plugin and hook
 * can, which is what lets the rest of this directory be separate files at all.
 */
declare module 'fastify' {
  interface FastifyInstance {
    state: DaemonState;
  }
}

export type StatePluginOptions = { state: DaemonState };

export default fp<StatePluginOptions>(
  // Callback form rather than async: decorating is synchronous, and there is
  // nothing here to await.
  (app, options, done) => {
    app.decorate('state', options.state);
    done();
  },
  { name: 'machdown-state' },
);
