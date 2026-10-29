import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores([
    'dist/**',
    'build/**',
    'node_modules/**',
    'coverage/**',
    'prisma/generated/**',
    'prisma/migrations/**',
  ]),

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,

  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Scripts and Prisma seed are dev tooling run through tsx — relax the strict rules there.
  {
    files: ['scripts/**/*.ts', 'prisma/**/*.ts'],
    rules: {
      '@typescript-eslint/no-console': 'off',
      'no-console': 'off',
    },
  },

  // Vitest's asymmetric matchers (`expect.any(String)`) are typed `any`.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['eslint.config.mjs', 'vitest.config.mts'],
    ...tseslint.configs.disableTypeChecked,
  },
])
