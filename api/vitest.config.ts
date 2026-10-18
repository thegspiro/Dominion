import { defineConfig } from 'vitest/config';

// Integration tests share one MySQL database, so test files run one at a time.
export default defineConfig({
  test: { fileParallelism: false },
});
