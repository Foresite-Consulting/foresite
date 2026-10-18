// ESLint 9 flat config for the whole monorepo.
// TypeScript (type-aware), React, hooks, accessibility and Next.js rules, with
// Prettier handling formatting so the two never fight.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/next-env.d.ts',
      'forecast/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.mjs', 'apps/*/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Formatted-string restrictions are too noisy for UI copy.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'table'] }],
    },
  },

  // React + accessibility rules for every component file.
  {
    files: ['**/*.tsx'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    settings: { react: { version: 'detect' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
      ...jsxA11y.flatConfigs.strict.rules,
      'react/prop-types': 'off',
    },
  },

  // Next.js app rules.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
    settings: { next: { rootDir: 'apps/web/' } },
  },

  // The two-layer branding rule: product code never names a colour.
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/src/components/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/e2e/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'No hard-coded colours. Use a theme token (bg-surface, text-text-primary, ...).',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'No hard-coded colours. Use a theme token (bg-surface, text-text-primary, ...).',
        },
        {
          selector: 'Literal[value=/\\b(rgb|hsl)a?\\(/]',
          message: 'No hard-coded colours. Use a theme token (bg-surface, text-text-primary, ...).',
        },
      ],
    },
  },

  // Plain JavaScript (config files and the service worker) is not type-checked.
  {
    files: ['**/*.mjs', 'apps/web/public/sw.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
      sourceType: 'script',
    },
  },

  // Tests: relax rules that fight with testing idioms.
  {
    files: ['**/*.test.{ts,tsx}', '**/e2e/**/*.ts', '**/vitest.setup.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  prettier,
);
