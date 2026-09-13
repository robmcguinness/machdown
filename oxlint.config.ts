import { defineConfig } from 'oxlint';

import { rm3Config } from '@rm3/oxlint-config';

export default defineConfig({
  env: { browser: true, serviceworker: true },
  extends: [rm3Config],
  globals: { browser: 'readonly', chrome: 'readonly' },
  // Registry output from `shadcn add`. Never hand-edited; customizations live in
  // wrappers under src/components. tsc still checks these files.
  ignorePatterns: ['apps/extension/src/components/ui/**'],
  overrides: [
    // React and react-doctor are on via rm3Config; the extension renders in
    // the browser only, so no `ssr` bucket.
    {
      env: { browser: false, node: true, serviceworker: false },
      files: ['apps/daemon/**', 'packages/contract/**'],
      rules: { 'new-cap': 'off' },
    },
    { files: ['packages/contract/**'], rules: { 'import/no-nodejs-modules': 'error' } },
    { files: ['apps/extension/src/lib/async.ts'], rules: { 'no-console': 'off' } },
    {
      files: ['apps/daemon/src/test-helpers.ts'],
      rules: { 'node/no-process-env': 'off', 'typescript/no-floating-promises': 'off' },
    },
    {
      files: ['apps/extension/build_scripts/**', 'apps/extension/*.config.ts'],
      rules: {
        // Build-time scripts run once, synchronously, inside Vite's transform hook.
        'node/no-sync': 'off',
        'typescript/no-deprecated': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-member-access': 'off',
      },
    },
  ],
});
