// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// One flat config for the whole workspace: `pnpm lint` runs `eslint .` from the root,
// so files that live outside a package (scripts, config) are linted too.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    // Type-aware rules need the type information of the package each file belongs to.
    // `projectService` picks up every package tsconfig.json automatically, including
    // apps/ui's, which is the one the root tsconfig excludes.
    // `.tsx` is listed everywhere `.ts` is: the UI gets the same rules as the services,
    // and no React-specific plugin is installed for it.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // A leading underscore means "this parameter exists because the signature needs it,
    // not because the body uses it" — the shape of an interface declared before its
    // implementation, and of callbacks that ignore an argument.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Config files are plain JavaScript: no types to reason about.
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
