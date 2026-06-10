// @ts-check
import tseslint from 'typescript-eslint';

// Stub rules so inline `eslint-disable` comments referencing react-hooks /
// @next/next rules don't error (those plugins are intentionally not installed
// to keep the toolchain light).
const noopRule = { create: () => ({}) };

export default tseslint.config(
  {
    ignores: ['.next/**', 'dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': { rules: { 'exhaustive-deps': noopRule, 'rules-of-hooks': noopRule } },
      '@next/next': { rules: { 'no-img-element': noopRule } },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
);
