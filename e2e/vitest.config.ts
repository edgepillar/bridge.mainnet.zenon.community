import { defineConfig } from 'vitest/config'

// The end-to-end suite: needs the bridge lab up (e2e/lab/lab.sh up). One file,
// run in order, with timeouts sized for ~15 s momentums on Docker Desktop.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    bail: 1,
  },
})
