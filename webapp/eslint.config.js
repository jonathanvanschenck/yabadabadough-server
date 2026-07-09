import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import pluginQuery from '@tanstack/eslint-plugin-query';

export default [
  { ignores: ['dist'] },

  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
          ...globals.browser,
          __APP_VERSION__: 'readonly',
        },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      '@tanstack/query': pluginQuery,
    },
    rules: {
      // Completely replace the recommended rule with our version
      ...js.configs.recommended.rules,   // keep all other recommended rules
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^[A-Z_]_*',
        argsIgnorePattern: '^_+$',
        destructuredArrayIgnorePattern: '^_+$',
        caughtErrorsIgnorePattern: '^_+$',
      }],

      // your other custom rules below
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
];
