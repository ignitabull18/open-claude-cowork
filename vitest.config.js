import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // server/ has its own node_modules — force all imports of @supabase/supabase-js
      // to resolve to the same path so vi.mock() intercepts transitive imports
      '@supabase/supabase-js': path.resolve(__dirname, 'server/node_modules/@supabase/supabase-js')
    }
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup/setup-env.js'],
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js'],
      exclude: ['server/opencode.json', 'server/node_modules/**']
    },
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
