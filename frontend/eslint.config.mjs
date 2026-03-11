import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import noUnknownValuedMapsRule from '../.eslint-rules/no-unknown-valued-maps.js';

const localRulesPlugin = {
  rules: {
    'no-unknown-valued-maps': noUnknownValuedMapsRule,
  },
};

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
      local: localRulesPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
      'local/no-unknown-valued-maps': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSImportType',
          message:
            'Inline import() types are not allowed. Use a top-level import statement instead.',
        },
      ],
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
