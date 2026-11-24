import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test';
import { API, PROXY_TEST_SECRET, SERVER_LOG, WEB } from '../playwright.proxy.config';

/**
 * Proxy + gate integration (run with `pnpm test:e2e:proxy`).
 *
 * Simulation note: `x-real-ip` stands in for the header a platform such as
 * Vercel sets. Injecting different values here validates how OUR proxy and
 * API treat that header. It does not and cannot show that the platform
 * prevents a visitor from forging it — that is a post-deployment check
 * (docs/DEPLOY_RAILWAY.md, "Post-deploy verification").
 */

/** A per-run random IP, so repeated local runs never share a 15-minute bucket. */
function randomIp(prefix: string): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `${prefix}.${octet()}.${octet()}`;
}
const uniqueEmail = (tag: string) =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@example.test`;

let api: APIRequestContext;
test.beforeAll(async () => {
  api = await playwrightRequest.newContext();
});
test.afterAll(async () => {
  await api.dispose();
});

const viaProxy = (path: string) => `${WEB}${path}`;
const direct = (path: string) => `${API}${path}`;

async function failedLogin(clientIp: string, extraHeaders: Record<string, string> = {}) {
  return api.post(viaProxy('/api/auth/login'), {
    headers: { 'x-real-ip': clientIp, ...extraHeaders },
    data: { email: uniqueEmail('nobody'), password: 'definitely-wrong-password' },
  });
}

// --- the gate (direct route) ---------------------------------------------------

test.describe('direct requests to the API', () => {
  test('/api without the proxy secret is refused, whatever else is sent', async () => {
    const attempts: Record<string, string>[] = [
      {},
      { 'x-sekai-proxy-auth': 'wrong-secret' },
      { 'x-sekai-proxy-auth': `${PROXY_TEST_SECRET}x` },
      { 'x-sekai-client-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' },
      { 'x-real-ip': '198.51.100.3', 'cf-connecting-ip': '198.51.100.4' },
    ];
    for (const headers of attempts) {
      const res = await api.get(direct('/api/config'), { headers });
      expect(res.status(), JSON.stringify(headers)).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    }
    // State-changing endpoints are refused before any handler runs.
    const login = await api.post(direct('/api/auth/login'), {
      data: { email: uniqueEmail('direct'), password: 'whatever-password' },
    });
    expect(login.status()).toBe(403);
  });

  test('health and metrics stay reachable; WebSocket upgrades are not gated', async () => {
    expect((await api.get(direct('/health/ready'))).status()).toBe(200);
    expect((await api.get(direct('/health/live'))).status()).toBe(200);
    // Development mode without METRICS_TOKEN serves metrics openly (its own
    // auth is unit-tested in health.rs); the point here is no proxy gate.
    expect((await api.get(direct('/metrics'))).status()).toBe(200);
  });

  test('the same request through the proxy is accepted', async () => {
    const res = await api.get(viaProxy('/api/config'));
    expect(res.status()).toBe(200);
    expect(res.headers()['x-sekai-proxy-auth']).toBeUndefined();
    expect(res.headers()['x-sekai-client-ip']).toBeUndefined();
    expect(await res.text()).not.toContain(PROXY_TEST_SECRET);
  });
});

// --- client-IP rate limiting (Vercel route) ----------------------------------------

test.describe('login rate limit through the proxy', () => {
  test('spoofed forwarding headers cannot escape the per-IP limit; other IPs are unaffected', async () => {
    const attacker = randomIp('203.0');
    const bystander = randomIp('198.51');

    // 30 failed logins from one verified IP, each with a fresh email (so the
    // per-email limiter can never trigger) and different forged headers.
    // RL_HTTP_PER_MIN is 100000 in this suite, so the general throttle can't
    // trigger either: the only limiter that can return 429 is `login_ip`.
    for (let i = 0; i < 30; i++) {
      const spoof = `192.0.2.${i + 1}`;
      const res = await failedLogin(attacker, {
        'x-forwarded-for': spoof,
        'x-sekai-client-ip': spoof,
        'cf-connecting-ip': spoof,
        'x-sekai-proxy-auth': 'forged',
      });
      expect(res.status(), `attempt ${i + 1}`).toBe(422);
    }

    // 31st, with yet another forged identity and a never-seen email → 429.
    const limited = await failedLogin(attacker, { 'x-forwarded-for': '192.0.2.250' });
    expect(limited.status()).toBe(429);
    const error = (await limited.json()).error;
    expect(error.code).toBe('rate_limited');
    // A 15-minute window (login_ip), not the 1-minute general throttle.
    expect(error.retry_after_ms).toBeGreaterThan(60_000);

    // A different verified IP has its own bucket.
    expect((await failedLogin(bystander)).status()).toBe(422);
    // The limited IP stays limited even with a brand-new email: IP-keyed.
    expect((await failedLogin(attacker)).status()).toBe(429);
  });

  test('without a valid client IP header, the proxy fails closed to one shared bucket', async () => {
    // Not asserted to exhaustion (it is shared across runs); verifies the
    // request still works and is handled rather than rejected.
    const res = await api.post(viaProxy('/api/auth/login'), {
      headers: { 'x-real-ip': '203.0.113.1, 10.0.0.1' },
      data: { email: uniqueEmail('multi'), password: 'definitely-wrong-password' },
    });
    expect([422, 429]).toContain(res.status());
  });
});

// --- WebSocket tickets across the proxy / direct split -------------------------------

async function registerHost(ip: string) {
  const res = await api.post(viaProxy('/api/auth/register'), {
    headers: { 'x-real-ip': ip },
    data: { email: uniqueEmail('ws'), password: 'correct-horse-battery', displayName: 'WS Host' },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).accessToken as string;
}

function openSocket(roomId: string): Promise<WebSocket> {
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws/rooms/${roomId}`);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('socket error')), { once: true });
  });
}

/**
 * The first frame that is `ready` or `error`, or 'closed' if the server closes
 * first. Other frames (e.g. `participant_joined`) may arrive in any order.
 */
function outcome(ws: WebSocket, timeoutMs = 8_000): Promise<'ready' | 'error' | 'closed'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no outcome')), timeoutMs);
    const finish = (result: 'ready' | 'error' | 'closed') => {
      clearTimeout(timer);
      resolve(result);
    };
    ws.addEventListener('message', (event) => {
      const t = (JSON.parse(String(event.data)) as { t?: string }).t;
      if (t === 'ready' || t === 'error') finish(t);
    });
    ws.addEventListener('close', () => finish('closed'), { once: true });
  });
}

test.describe('WebSocket tickets', () => {
  test('issued through the proxy, redeemed directly, exactly once', async () => {
    const token = await registerHost(randomIp('203.0'));
    const auth = { authorization: `Bearer ${token}` };

    const room = await api.post(viaProxy('/api/rooms'), {
      headers: auth,
      data: { name: 'Ticket Test', visibility: 'private' },
    });
    expect(room.status()).toBe(200);
    const roomId = (await room.json()).id as string;

    // Issuing a ticket directly is refused by the gate.
    expect(
      (await api.post(direct('/api/auth/ws-ticket'), { headers: auth, data: { roomId } })).status(),
    ).toBe(403);

    const issued = await api.post(viaProxy('/api/auth/ws-ticket'), {
      headers: auth,
      data: { roomId },
    });
    expect(issued.status()).toBe(200);
    const ticket = (await issued.json()).ticket as string;

    // First use: the socket authenticates and receives the room snapshot.
    const first = await openSocket(roomId);
    first.send(JSON.stringify({ t: 'authenticate', ticket }));
    expect(await outcome(first)).toBe('ready');
    first.close();

    // Second use of the same ticket: refused.
    const reuse = await openSocket(roomId);
    reuse.send(JSON.stringify({ t: 'authenticate', ticket }));
    expect(await outcome(reuse)).not.toBe('ready');

    // A made-up ticket: refused.
    const bogus = await openSocket(roomId);
    bogus.send(JSON.stringify({ t: 'authenticate', ticket: 'not-a-real-ticket' }));
    expect(await outcome(bogus)).not.toBe('ready');

    // No authentication at all: closed after the handshake timeout.
    const silent = await openSocket(roomId);
    expect(await outcome(silent)).not.toBe('ready');
  });
});

// --- browser-origin / CSRF, separately from CORS ---------------------------------------

test.describe('cross-origin reads', () => {
  test('CORS: only the configured web origin may read API responses', async () => {
    const foreign = await api.get(viaProxy('/api/config'), {
      headers: { origin: 'http://attacker.test' },
    });
    expect(foreign.headers()['access-control-allow-origin']).toBeUndefined();
    const own = await api.get(viaProxy('/api/config'), { headers: { origin: WEB } });
    expect(own.headers()['access-control-allow-origin']).toBe(WEB);
  });
});

// --- the secret stays server-side -----------------------------------------------------

test.describe('secret containment', () => {
  test('the proxy secret and internal header names are not in browser bundles', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(js|mjs|css|html)$/.test(name)) files.push(path);
      }
    };
    walk('../apps/web/dist/client');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain(PROXY_TEST_SECRET);
      expect(text, file).not.toContain('x-sekai-proxy-auth');
      expect(text, file).not.toContain('SEKAI_PROXY_SECRET');
    }
  });

  test('the API server log never contains the secret', () => {
    const log = readFileSync(SERVER_LOG, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(PROXY_TEST_SECRET);
  });
});
