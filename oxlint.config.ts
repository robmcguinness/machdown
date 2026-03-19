import { defineConfig } from 'oxlint';

export default defineConfig({
  $schema: './node_modules/oxlint/configuration_schema.json',
  options: {
    typeAware: true,
    typeCheck: true,
  },
  env: {
    browser: true,
    serviceworker: true,
    es2024: true,
  },
  globals: {
    chrome: 'readonly',
    browser: 'readonly',
  },
  plugins: ['import', 'react', 'react-perf', 'jsx-a11y', 'node', 'promise'],
  categories: {
    // Code that is definitely wrong or useless
    correctness: 'warn',
    // Code that is likely to be wrong or useless
    suspicious: 'warn',
    // Extra strict rules that may have false positives
    pedantic: 'warn',
    // Rules that aim to improve runtime performance
    perf: 'warn',
    // Idiomatic and consistent style rules
    style: 'warn',
    // Rules that ban specific patterns or features
    restriction: 'warn',
    // Rules under development that may change
    nursery: 'warn',
  },
  rules: {
    'import/no-default-export': 'off',
    'eslint/no-unused-vars': 'error',
    'sort-keys': 'off',
    // React/TSX: .tsx is the standard extension for JSX in TypeScript
    'react/jsx-filename-extension': 'off',
    // React 17+ JSX transform doesn't require React in scope
    'react/react-in-jsx-scope': 'off',
    // Prop spreading is standard for wrapper/UI components
    'react/jsx-props-no-spreading': 'off',
    // Named exports are idiomatic in React/TS
    'import/no-named-export': 'off',
    'import/prefer-default-export': 'off',
    // import * as React is standard shadcn/ui pattern
    'import/no-namespace': 'off',
    // Build scripts need Node builtins
    'import/no-nodejs-modules': 'off',
    // Inline type specifiers are valid TS
    'import/consistent-type-specifier-style': 'off',
    // Function declarations are fine for components
    'eslint/func-style': 'off',
    // Ternaries are standard JS
    'eslint/no-ternary': 'off',
    'eslint/no-nested-ternary': 'off',
    // Too strict for general use
    'eslint/no-magic-numbers': 'off',
    // void is valid TS pattern for unused params
    'eslint/no-void': 'off',
    // .current on refs is standard React
    'eslint/prefer-destructuring': 'off',
    // Too strict for most components
    'react-perf/jsx-no-new-function-as-prop': 'off',
    // Generic Label component — htmlFor passed via props
    'jsx-a11y/label-has-associated-control': 'off',
    // TypeScript handles undefined checks; process is valid in Node
    'eslint/no-undef': 'off',
    // Multiple related components in one file is standard (e.g. Card variants)
    'react/no-multi-comp': 'off',
    // Arrow body style — implicit returns not always clearer
    'eslint/arrow-body-style': 'off',
    // max-lines-per-function too restrictive for component files
    'eslint/max-lines-per-function': 'off',
    // max-statements too restrictive
    'eslint/max-statements': 'off',
    // Curly braces not needed for single-line if returns
    'eslint/curly': 'off',
    // Empty functions are valid (e.g. no-op callbacks)
    'eslint/no-empty-function': 'off',
    // max-lines too restrictive
    'eslint/max-lines': 'off',
    // Inline styles needed for dynamic values
    'react/no-inline-styles': 'off',
    // className on custom components is standard React pattern
    'react/no-unknown-property': 'off',
    // Object shorthand not always clearer
    'react-perf/jsx-no-new-object-as-prop': 'off',
    // JSX expressions are fine
    'react-perf/jsx-no-jsx-as-prop': 'off',
    // id attributes are fine
    'eslint/id-length': 'off',
    // Bitwise false positives with logical operators
    'eslint/no-bitwise': 'off',
    // Regex is fine
    'eslint/prefer-named-capture-group': 'off',
    'eslint/no-control-regex': 'off',
    // Type assertions are valid TS
    'typescript/no-unsafe-type-assertion': 'off',
    // Underscore params indicate intentionally unused
    'eslint/no-underscore-dangle': 'off',
    // Logical assignment operators not always clearer
    'eslint/logical-assignment-operators': 'off',
    // Unnecessary for modern code
    'eslint/radix': 'off',
    // Too pedantic
    'eslint/no-negated-condition': 'off',
    'eslint/no-else-return': 'off',
    'eslint/max-params': 'off',
    'eslint/complexity': 'off',
    'eslint/operator-assignment': 'off',
    'eslint/no-param-reassign': 'off',
    // Promise rules too strict
    'promise/prefer-await-to-callbacks': 'off',
    'promise/prefer-await-to-then': 'off',
    'promise/catch-or-return': 'off',
    'promise/always-return': 'off',
    // Type imports handled by TS
    'typescript/consistent-type-imports': 'off',
    // Multiple export declarations are standard TS
    'import/group-exports': 'off',
    // Export at declaration is standard TS pattern
    'import/exports-last': 'off',
    // CSS side-effect imports are standard
    'import/no-unassigned-import': 'off',
    // .d.ts files are modules by convention
    'import/unambiguous': 'off',
    // Relative parent imports are standard
    'import/no-relative-parent-imports': 'off',
    // Component composition makes depth limits impractical
    'react/jsx-max-depth': 'off',
    // Exporting variants alongside components is standard (shadcn)
    'react/only-export-components': 'off',
    // Standard loop constructs
    'eslint/no-continue': 'off',
    'eslint/no-plusplus': 'off',
    // Not always practical for conditional assignment
    'eslint/init-declarations': 'off',
    // Commented-out code and inline notes
    'eslint/capitalized-comments': 'off',
    // !! is idiomatic JS
    'eslint/no-implicit-coercion': 'off',
    // Hoisted functions are fine in module scope
    'eslint/no-use-before-define': 'off',
    // undefined is valid JS/TS
    'eslint/no-undefined': 'off',
    // Self-closing handled by formatter
    'react/self-closing-comp': 'off',
    // Wrapping scalars in arrays for component props is fine
    'react-perf/jsx-no-new-array-as-prop': 'off',
  },
});
