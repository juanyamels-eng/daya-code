import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Lenient-by-default flat config: catches obvious mistakes (unused vars,
// undefined globals, undefined refs) without failing on existing code that
// makes intentional use of non-null assertions or `any`.
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['packages/*/tsconfig.json'],
      },
    },
    rules: {
      // Codebase deliberately uses non-null assertions and loose typings.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Async patterns used across the repo (e.g. `void this.onFinish(...)`).
      '@typescript-eslint/no-floating-promises': 'off',
      // Keep it informational — nothing here can break the build.
      'no-constant-condition': 'warn',
      'no-unreachable': 'warn',
    },
  },
);