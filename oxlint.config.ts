import { defineConfig } from 'oxlint';

import { reactPlugins, reactRulesOff, rm3Config, shadcnRulesOff } from '@rm3/oxlint-config';

export default defineConfig({
  env: { browser: true, serviceworker: true },
  extends: [rm3Config],
  globals: { browser: 'readonly', chrome: 'readonly' },
  overrides: [
    {
      env: { browser: false, node: true, serviceworker: false },
      files: ['apps/daemon/**', 'packages/contract/**'],
      rules: { 'new-cap': 'off' },
    },
    { files: ['packages/contract/**'], rules: { 'import/no-nodejs-modules': 'error' } },
    { files: ['apps/extension/**'], plugins: [...reactPlugins], rules: reactRulesOff },
    { files: ['apps/extension/src/lib/async.ts'], rules: { 'no-console': 'off' } },
    {
      files: ['apps/daemon/src/test-helpers.ts'],
      rules: { 'node/no-process-env': 'off', 'typescript/no-floating-promises': 'off' },
    },
    {
      files: ['apps/extension/src/components/ui/**'],
      plugins: [...reactPlugins],
      rules: shadcnRulesOff,
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
