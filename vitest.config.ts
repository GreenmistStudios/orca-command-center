import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: [
            'src/server/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'test/integration/**/*.test.ts',
            'test/fixtures/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/client/**/*.test.{ts,tsx}', 'test/client/**/*.test.{ts,tsx}'],
          setupFiles: ['test/client/setup.ts'],
        },
      },
    ],
  },
})
