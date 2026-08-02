import { defineConfig } from 'oxfmt';

import { rm3Fmt } from '@rm3/oxfmt-config';

export default defineConfig({
  ...rm3Fmt,
  // Generated schema tests compare byte-for-byte against JSON.stringify(..., 2).
  ignorePatterns: [...rm3Fmt.ignorePatterns, '.vscode', 'apps/daemon/daemon.schema.json'],
});
