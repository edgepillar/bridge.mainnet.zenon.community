import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Served from the root of bridge.mainnet.zenon.community (public/CNAME), so
// base stays '/'. A Pages project site under /<repo>/ sets VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [vue(), tailwindcss()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: { port: 5190 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
