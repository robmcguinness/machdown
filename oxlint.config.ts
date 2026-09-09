import { defineConfig } from 'oxlint';

import {
  reactDoctorJsPlugin,
  reactDoctorRules,
  reactPlugins,
  reactRules,
  rm3Config,
} from '@rm3/oxlint-config';

export default defineConfig({
  env: { browser: true, serviceworker: true },
  extends: [rm3Config],
  globals: { browser: 'readonly', chrome: 'readonly' },
  // Registry output from `shadcn add`. Never hand-edited; customizations live in
  // wrappers under src/components. tsc still checks these files.
  ignorePatterns: ['apps/extension/src/components/ui/**'],
  overrides: [
    {
      env: { browser: false, node: true, serviceworker: false },
      files: ['apps/daemon/**', 'packages/contract/**'],
      rules: { 'new-cap': 'off' },
    },
    { files: ['packages/contract/**'], rules: { 'import/no-nodejs-modules': 'error' } },
    {
      files: ['apps/extension/**'],
      // react-doctor runs as an oxlint JS plugin. The extension renders in the
      // browser only, so no `ssr` bucket.
      jsPlugins: [reactDoctorJsPlugin],
      plugins: [...reactPlugins],
      rules: { ...reactRules, ...reactDoctorRules },
    },
    { files: ['apps/extension/src/lib/async.ts'], rules: { 'no-console': 'off' } },
    {
      files: ['apps/daemon/src/test-helpers.ts'],
      rules: { 'node/no-process-env': 'off', 'typescript/no-floating-promises': 'off' },
    },
    {
      files: ['apps/extension/build_scripts/**', 'apps/extension/*.config.ts'],
      rules: {
        'typescript/no-deprecated': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-member-access': 'off',
      },
    },
  ],
});
