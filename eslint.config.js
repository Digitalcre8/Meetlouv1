import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/dist/**',
    '**/next-env.d.ts',
    'scripts/**',
    // Deno code: checked with `deno check` (see CI), not by the Node TypeScript project.
    'supabase/functions/**',
  ]),
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Non-negotiable 10: never log secrets, recording URLs, transcripts or email bodies.
      // Use the redacting logger from @meetlou/domain instead of console.
      'no-console': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  { files: ['tools/harness/**'], rules: { 'no-console': 'off' } },
);
