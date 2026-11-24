import { defineConfig, devices } from '@playwright/test';

/**
 * Integration suite for the web → API proxy and the API's proxy gate.
 *
 *   browser / test ──▶ web (production build, node-server.mjs, :3090)
 *                        └─ /api/** proxy (SEKAI_PROXY_SECRET, x-real-ip)
 *                              ──▶ API (:8090, REQUIRE_PROXY_AUTH=true)
 *   test ─────────────────────────▶ API directly (gate, health, WebSocket)
 *
 * Isolated resources only: a local Postgres/Redis (the same ones the main
 * suite uses), never a hosted database. The API's environment is set
 * explicitly below — the repository `.env` is deliberately NOT sourced, so a
 * DATABASE_URL pointing at a real database there cannot be picked up.
 *
 * The secret below is a test fixture, not a credential.
 */

export const PROXY_TEST_SECRET = 'e2e-only-proxy-secret-not-a-credential-0123456789';
export const API = 'http://localhost:8090';
export const WEB = 'http://localhost:3090';
export const SERVER_LOG = 'test-results/proxy-api-server.log';

const database = process.env.E2E_DATABASE_URL ?? 'postgres://ytroom:ytroom@localhost:5432/ytroom';

const apiEnv = [
  'APP_ENV=development',
  'BIND_ADDR=0.0.0.0:8090',
  `DATABASE_URL=${database}`,
  'REDIS_URL=redis://localhost:6379',
  `PUBLIC_URL=${API}`,
  `WEB_ORIGIN=${WEB}`,
  'JWT_PRIVATE_KEY_FILE=./keys/jwt-private.pem',
  'JWT_PUBLIC_KEY_FILE=./keys/jwt-public.pem',
  'REQUIRE_PROXY_AUTH=true',
  `SEKAI_PROXY_SECRET=${PROXY_TEST_SECRET}`,
  // High enough that only the limiter under test can produce a 429.
  'RL_HTTP_PER_MIN=100000',
  'RL_REGISTER_PER_HOUR=1000',
  'RL_GUEST_PER_HOUR=1000',
  'WS_HANDSHAKE_TIMEOUT_SECS=2',
  // Debug logging, captured to a file the suite greps for the secret.
  'RUST_LOG=debug,sqlx=warn',
].join(' ');

const webEnv = [
  'PORT=3090',
  `SEKAI_API_ORIGIN=${API}`,
  `SEKAI_PROXY_SECRET=${PROXY_TEST_SECRET}`,
  'SEKAI_PROXY_CLIENT_IP_HEADER=x-real-ip',
].join(' ');

export default defineConfig({
  testDir: './tests',
  testMatch: /proxy-gate\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: `bash -c 'mkdir -p e2e/test-results && env ${apiEnv} cargo run --manifest-path apps/server/Cargo.toml > e2e/${SERVER_LOG} 2>&1'`,
      cwd: '..',
      url: `${API}/health/ready`,
      // Never attach to a server started elsewhere: its configuration is unknown.
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command: `bash -c 'pnpm --filter @playercn/web build && cd apps/web && env ${webEnv} node node-server.mjs'`,
      cwd: '..',
      url: `${WEB}/`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
