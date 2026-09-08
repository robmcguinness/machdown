/**
 * `@machdown/contract` — the wire protocol shared by the extension and the daemon.
 *
 * This package is bundled into the Chrome extension, so it must never import
 * `node:*` builtins or anything else that only resolves on the server.
 *
 * Importing from here pulls in Zod. Code that only needs plain constants should
 * import `@machdown/contract/constants` instead.
 */

export * from './constants.ts';
export * from './schemas.ts';
export * from './router.ts';
