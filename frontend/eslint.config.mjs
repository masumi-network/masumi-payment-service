import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

const eslintConfig = defineConfig([
  ...nextVitals,
  prettierConfig,
  globalIgnores(['.next/**', 'dist/**', 'node_modules/**']),
  {
    ignores: ['**/*.gen.ts', 'src/lib/api/generated/**'],
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
    },
  },
  {
    files: ['**/*.gen.ts', 'src/lib/api/generated/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]);

export default eslintConfig;
