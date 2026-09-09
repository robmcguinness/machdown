import { defineConfig } from 'oxfmt';

import { rm3Fmt } from '@rm3/oxfmt-config';

export default defineConfig({
  ...rm3Fmt,
  ignorePatterns: [
    ...rm3Fmt.ignorePatterns,
    '.vscode',
    // Generated schema tests compare byte-for-byte against JSON.stringify(..., 2).
    'apps/daemon/daemon.schema.json',
    // Registry output from `shadcn add`. Kept byte-for-byte so a re-sync is a clean diff.
    'apps/extension/src/components/ui',
    // Hand-written UI mockups. Static HTML, not source.
    'apps/extension/design',
  ],
});
