import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real stack: Rust API, web dev server, Postgres
 * and Redis. Start the datastores first with `pnpm infra:up`.
 *
 * The API reads the repository `.env` (see `.env.example`).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    launchOptions: {
      // Every client must start playback without a click; the room, not the
      // user, decides when the film plays.
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Each run registers fresh accounts; the production default (10/hour/IP)
      // would throttle the suite after a couple of runs.
      command:
        "bash -c 'set -a; . ./.env; set +a; RL_REGISTER_PER_HOUR=1000 cargo run --manifest-path apps/server/Cargo.toml'",
      cwd: '..',
      url: 'http://localhost:8080/health/ready',
      reuseExistingServer: true,
      timeout: 300_000,
    },
    {
      command: 'pnpm --filter @playercn/web dev',
      cwd: '..',
      url: 'http://localhost:3000',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'node media-server.mjs',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: true,
    },
  ],
});
