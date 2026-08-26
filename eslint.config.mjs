// Flat config: ESLint 10 ya no lee .eslintrc.json.
// Equivalente al .eslintrc.json anterior (eslint:recommended +
// plugin:@typescript-eslint/recommended + las reglas propias del proyecto).
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'auth_sessions/**', 'logs/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      // El chequeo de nombres y de variables sin usar lo hace TypeScript:
      // las reglas base dan falsos positivos sobre tipos y sobrecargas.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // El proyecto usa `catch (error) { return false; }` como idioma;
          // typescript-eslint v8 empezó a marcarlos por defecto.
          caughtErrors: 'none',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
