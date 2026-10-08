import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/**', '**/.next/**', '**/dist/**']),
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Non-negotiable 10: never log secrets, recording URLs, transcripts or email bodies.
      // Use the redacting logger from @meetlou/domain instead of console.
      'no-console': 'error',
    },
  },
  { files: ['tools/harness/**'], rules: { 'no-console': 'off' } },
);
