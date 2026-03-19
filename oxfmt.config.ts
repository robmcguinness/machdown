import { defineConfig } from 'oxfmt';

export default defineConfig({
  $schema: './node_modules/oxfmt/configuration_schema.json',
  printWidth: 100,
  singleQuote: true,
  jsxSingleQuote: true,
  semi: true,
  endOfLine: 'lf',
  ignorePatterns: ['dist', 'build', 'node_modules', '.vite', '.vscode'],
});
