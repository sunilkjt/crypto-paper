import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the repo at /crypto/ — assets must use that base.
  // Local dev keeps "/" (GITHUB_PAGES is only set in the Pages workflow).
  base: process.env.GITHUB_PAGES === "true" ? "/crypto/" : "/",
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
