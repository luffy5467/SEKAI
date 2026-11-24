import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real stack: Rust API, web dev server, Postgres
 * and Redis. Start the datastores first with `pnpm infra:up`.
 *
 * The API reads the repository `.env` (see `.env.example`). A DATABASE_URL
 * set in the environment overrides it, so tests can run against a scratch
 * database instead of a real one:
 *   DATABASE_URL=postgres://ytroom:ytroom@localhost:5432/ytroom pnpm test:e2e
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
      // Each run registers fresh accounts and guests; the production defaults
      // (10 and 20 per hour per IP) would throttle the suite after a few runs.
      command:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: `${DATABASE_URL:-}` is Bash parameter expansion run by `bash -c`, not a JS template; a template literal would break it
        'bash -c \'E2E_DB="${DATABASE_URL:-}"; set -a; . ./.env; set +a; if [ -n "$E2E_DB" ]; then export DATABASE_URL="$E2E_DB"; fi; RL_REGISTER_PER_HOUR=1000 RL_GUEST_PER_HOUR=1000 cargo run --manifest-path apps/server/Cargo.toml\'',
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
