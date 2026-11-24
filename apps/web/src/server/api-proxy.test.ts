/**
 * Tests for the `/api/**` proxy, against a real local HTTP upstream (no fetch
 * mocks), so headers, bodies, streaming and redirects behave as they do in
 * production. Run with: pnpm --filter @playercn/web test
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  type ApiProxyConfig,
  handleApiProxy,
  proxyApiRequest,
  readApiProxyConfig,
  singleIp,
} from './api-proxy.ts';

const SECRET = 'test-only-secret-0123456789abcdef0123456789';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let upstream: Server;
let foreign: Server;
let apiOrigin: string;
let foreignOrigin: string;
let seen: Seen[] = [];
let foreignHits = 0;

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

    const path = (req.url ?? '').split('?')[0];
    switch (path) {
      case '/api/cookies':
        res.setHeader('set-cookie', ['a=1; Path=/; HttpOnly', 'b=2; Path=/api/auth; SameSite=Lax']);
        res.end('ok');
        return;
      case '/api/stream': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first|');
        await new Promise((r) => setTimeout(r, 150));
        res.end('second');
        return;
      }
      case '/api/redirect-internal':
        res.writeHead(302, { location: `${apiOrigin}/api/elsewhere?x=1` });
        res.end();
        return;
      case '/api/redirect-relative':
        res.writeHead(303, { location: '/api/next' });
        res.end();
        return;
      case '/api/redirect-foreign':
        res.writeHead(302, { location: `${foreignOrigin}/steal` });
        res.end();
        return;
      case '/api/status':
        res.writeHead(429, { 'retry-after': '42', 'content-type': 'application/json' });
        res.end('{"error":{"code":"rate_limited"}}');
        return;
      case '/api/no-content':
        res.writeHead(204);
        res.end();
        return;
      case '/api/leaky-headers':
        // An upstream that (wrongly) echoed internal headers back.
        res.setHeader('x-sekai-proxy-auth', SECRET);
        res.setHeader('x-sekai-client-ip', '203.0.113.9');
        res.end('ok');
        return;
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    }
  });
  foreign = createServer((_req, res) => {
    foreignHits += 1;
    res.end('foreign');
  });
  apiOrigin = await listen(upstream);
  foreignOrigin = await listen(foreign);
});

after(() => {
  upstream.close();
  foreign.close();
});

beforeEach(() => {
  seen = [];
  foreignHits = 0;
});

const config = (overrides: Partial<ApiProxyConfig> = {}): ApiProxyConfig => ({
  apiOrigin,
  secret: SECRET,
  clientIpHeader: 'x-real-ip',
  ...overrides,
});

const WEB = 'https://sekai.example';

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${WEB}${path}`, init);
}

// --- configuration ----------------------------------------------------------

describe('readApiProxyConfig', () => {
  it('is disabled without SEKAI_API_ORIGIN (local development uses the Vite proxy)', () => {
    assert.deepEqual(readApiProxyConfig({}), { kind: 'disabled' });
  });

  it('refuses a missing, empty or short secret instead of proxying without auth', () => {
    for (const secret of [undefined, '', '   ', 'too-short']) {
      const result = readApiProxyConfig({
        SEKAI_API_ORIGIN: 'https://api.example',
        SEKAI_PROXY_SECRET: secret,
      });
      assert.equal(result.kind, 'invalid', String(secret));
    }
  });

  it('accepts an origin only', () => {
    for (const bad of [
      'not a url',
      'ftp://api.example',
      'https://api.example/base',
      'https://u:p@api.example',
      'https://api.example/?q=1',
    ]) {
      const result = readApiProxyConfig({ SEKAI_API_ORIGIN: bad, SEKAI_PROXY_SECRET: SECRET });
      assert.equal(result.kind, 'invalid', bad);
    }
    const ok = readApiProxyConfig({
      SEKAI_API_ORIGIN: 'https://api.example/',
      SEKAI_PROXY_SECRET: SECRET,
      SEKAI_PROXY_CLIENT_IP_HEADER: 'X-Real-IP',
    });
    assert.deepEqual(ok, {
      kind: 'ok',
      config: { apiOrigin: 'https://api.example', secret: SECRET, clientIpHeader: 'x-real-ip' },
    });
  });

  it('reports problems without echoing configured values', () => {
    const result = readApiProxyConfig({
      SEKAI_API_ORIGIN: 'https://api.example',
      SEKAI_PROXY_SECRET: 'short-secret-value',
    });
    assert.equal(result.kind, 'invalid');
    assert.ok(result.kind === 'invalid' && !result.problem.includes('short-secret-value'));
  });
});

// --- fixed upstream -----------------------------------------------------------

describe('fixed upstream origin', () => {
  it('cannot be changed by the request path, encoded or not', async () => {
    for (const path of [
      '/api//evil.example/x',
      '/api/%2F%2Fevil.example/x',
      '/api/%2f%2fevil.example',
      '/api/https://evil.example/',
      '/api/@evil.example',
      '/api\\\\evil.example',
    ]) {
      seen = [];
      const res = await proxyApiRequest(req(path), config());
      assert.equal(foreignHits, 0, path);
      if (res.status === 404 && seen.length === 0) continue; // refused before forwarding
      assert.equal(seen.length, 1, path);
      assert.equal(seen[0]?.headers.host, new URL(apiOrigin).host, path);
      assert.ok(seen[0]?.url.startsWith('/api/'), `${path} → ${seen[0]?.url}`);
    }
  });

  it('never forwards outside /api, including dot-segment and encoded traversal', async () => {
    for (const path of ['/metrics', '/api/../metrics', '/api/%2e%2e/health/ready', '/apix/y']) {
      seen = [];
      const res = await proxyApiRequest(req(path), config());
      assert.equal(res.status, 404, path);
      assert.equal(seen.length, 0, path);
    }
  });

  it('keeps an encoded slash encoded rather than turning it into a separator', async () => {
    await proxyApiRequest(req('/api/rooms/a%2Fb'), config());
    assert.equal(seen[0]?.url, '/api/rooms/a%2Fb');
  });
});

// --- proxy authentication headers -------------------------------------------------

describe('proxy authentication headers', () => {
  it('strips client-supplied internal and forwarding headers, then sets its own', async () => {
    await proxyApiRequest(
      req('/api/config', {
        headers: {
          'x-sekai-proxy-auth': 'forged',
          'x-sekai-client-ip': '198.51.100.66',
          'x-forwarded-for': '198.51.100.1, 10.0.0.1',
          'cf-connecting-ip': '198.51.100.2',
          forwarded: 'for=198.51.100.3',
          'x-real-ip': '203.0.113.7',
        },
      }),
      config(),
    );
    const h = seen[0]?.headers ?? {};
    assert.equal(h['x-sekai-proxy-auth'], SECRET);
    assert.equal(h['x-sekai-client-ip'], '203.0.113.7');
    assert.equal(h['x-forwarded-for'], undefined);
    assert.equal(h['cf-connecting-ip'], undefined);
    assert.equal(h.forwarded, undefined);
    assert.equal(h['x-real-ip'], undefined);
  });

  it('sends no client IP when none is configured or the value is not exactly one IP', async () => {
    const cases: [ApiProxyConfig, string | undefined][] = [
      [config({ clientIpHeader: null }), '203.0.113.7'],
      [config(), undefined],
      [config(), ''],
      [config(), '203.0.113.7, 10.0.0.1'],
      [config(), 'not-an-ip'],
      [config(), '999.0.0.1'],
    ];
    for (const [cfg, value] of cases) {
      seen = [];
      const headers: Record<string, string> = {};
      if (value !== undefined) headers['x-real-ip'] = value;
      await proxyApiRequest(req('/api/config', { headers }), cfg);
      assert.equal(seen[0]?.headers['x-sekai-client-ip'], undefined, String(value));
      assert.equal(seen[0]?.headers['x-sekai-proxy-auth'], SECRET);
    }
  });

  it('accepts IPv6 client IPs', async () => {
    await proxyApiRequest(
      req('/api/config', { headers: { 'x-real-ip': '2001:db8::5' } }),
      config(),
    );
    assert.equal(seen[0]?.headers['x-sekai-client-ip'], '2001:db8::5');
    assert.equal(singleIp('2001:db8::5'), '2001:db8::5');
    assert.equal(singleIp('2001:db8::5, ::1'), null);
  });

  it('never returns internal headers or the secret to the browser', async () => {
    const res = await proxyApiRequest(req('/api/leaky-headers'), config());
    assert.equal(res.headers.get('x-sekai-proxy-auth'), null);
    assert.equal(res.headers.get('x-sekai-client-ip'), null);
    for (const [, value] of res.headers) assert.ok(!value.includes(SECRET));
    assert.ok(!(await res.text()).includes(SECRET));
  });
});

// --- pass-through ---------------------------------------------------------------

describe('faithful pass-through', () => {
  it('preserves method, query string, body and cookies', async () => {
    const body = JSON.stringify({ email: 'a@example.test', password: 'pässwörd 🎬' });
    const res = await proxyApiRequest(
      req('/api/auth/login?next=%2Frooms&a=1&a=2', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'yr_refresh=abc; other=1' },
        body,
      }),
      config(),
    );
    assert.equal(res.status, 200);
    const s = seen[0];
    assert.equal(s?.method, 'POST');
    assert.equal(s?.url, '/api/auth/login?next=%2Frooms&a=1&a=2');
    assert.equal(s?.body, body);
    assert.equal(s?.headers.cookie, 'yr_refresh=abc; other=1');
    assert.equal(s?.headers['content-type'], 'application/json');
  });

  it('streams a request body', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-1|'));
        controller.enqueue(new TextEncoder().encode('chunk-2'));
        controller.close();
      },
    });
    await proxyApiRequest(
      req('/api/upload', { method: 'PUT', body: stream, duplex: 'half' } as RequestInit),
      config(),
    );
    assert.equal(seen[0]?.body, 'chunk-1|chunk-2');
  });

  it('passes every Set-Cookie header separately', async () => {
    const res = await proxyApiRequest(req('/api/cookies'), config());
    assert.deepEqual(res.headers.getSetCookie(), [
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/api/auth; SameSite=Lax',
    ]);
  });

  it('preserves status codes and headers such as Retry-After', async () => {
    const res = await proxyApiRequest(req('/api/status'), config());
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '42');
    assert.equal((await res.json()).error.code, 'rate_limited');
  });

  it('returns 204 without a body', async () => {
    const res = await proxyApiRequest(req('/api/no-content', { method: 'DELETE' }), config());
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
  });

  it('streams the response instead of buffering it', async () => {
    const res = await proxyApiRequest(req('/api/stream'), config());
    const reader = res.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first|');
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      rest += new TextDecoder().decode(r.value);
    }
    assert.equal(rest, 'second');
  });
});

// --- redirects ------------------------------------------------------------------

describe('redirects', () => {
  it('are returned to the browser, not followed', async () => {
    const res = await proxyApiRequest(req('/api/redirect-relative'), config());
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/api/next');
    assert.equal(seen.length, 1, 'the proxy did not follow it');
  });

  it('back into the API are rewritten to the web origin', async () => {
    const res = await proxyApiRequest(req('/api/redirect-internal'), config());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/api/elsewhere?x=1');
  });

  it('to another origin are passed through without the proxy ever contacting it', async () => {
    const res = await proxyApiRequest(req('/api/redirect-foreign'), config());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${foreignOrigin}/steal`);
    assert.equal(foreignHits, 0, 'the secret was never sent to the foreign origin');
  });
});

// --- failure handling ---------------------------------------------------------------

describe('failures', () => {
  it('reports an unreachable upstream generically', async () => {
    const res = await proxyApiRequest(
      req('/api/config'),
      config({ apiOrigin: 'http://127.0.0.1:9' }),
    );
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes('127.0.0.1') && !text.includes(SECRET));
  });

  it('handleApiProxy logs misconfiguration without values and tells the client nothing', async () => {
    const saved = { ...process.env };
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      process.env.SEKAI_API_ORIGIN = apiOrigin;
      process.env.SEKAI_PROXY_SECRET = 'short-but-secret';
      const res = await handleApiProxy(req('/api/config'));
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.ok(!text.includes('short-but-secret') && !text.includes(apiOrigin));
      assert.equal(logged.length, 1);
      assert.ok(!logged[0]?.includes('short-but-secret'));
      assert.ok(!logged[0]?.includes(apiOrigin));
      assert.equal(seen.length, 0, 'nothing was forwarded');

      delete process.env.SEKAI_API_ORIGIN;
      assert.equal((await handleApiProxy(req('/api/config'))).status, 404);
    } finally {
      console.error = original;
      process.env = saved;
    }
  });
});
