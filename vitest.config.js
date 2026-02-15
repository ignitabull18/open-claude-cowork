import { defineConfig } from 'vitest/config';

export default defineConfig({
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
