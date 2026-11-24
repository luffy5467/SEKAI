/**
 * Server-only proxy from the web origin's `/api/**` to the SEKAI API.
 *
 * Why it exists: the refresh cookie is `SameSite=Lax`, so the API must be
 * same-site with the page. Routing `/api` through the web host achieves that.
 *
 * Security properties. Unit tests in api-proxy.test.ts cover each one against
 * a real local upstream; e2e/tests/proxy-gate.spec.ts covers the proxy and the
 * gated API together:
 *  - Fixed upstream. The target origin comes only from `SEKAI_API_ORIGIN`;
 *    the request can change the path and query under `/api/`, never the host.
 *  - Proxy authentication. Client-supplied `x-sekai-proxy-auth` and
 *    `x-sekai-client-ip` are always stripped, then set by this proxy: the
 *    shared secret, and the visitor IP taken from the one header named by
 *    `SEKAI_PROXY_CLIENT_IP_HEADER` (e.g. Vercel's `x-real-ip`). With no such
 *    header configured, no client IP is sent and the API fails closed to a
 *    single shared bucket.
 *  - The secret never leaves the server: it is read from `process.env` at
 *    request time (never bundled), sent only to the fixed upstream, never
 *    logged, and never echoed in responses. Redirects are not followed
 *    (`redirect: 'manual'`), so it can't be carried to another origin.
 *  - Faithful pass-through: method, path, query, body (streamed), cookies,
 *    every `Set-Cookie`, status and streaming response bodies.
 *
 * The secret proves "came through this proxy". It is not user authentication
 * or CSRF protection — those stay bearer tokens, the SameSite refresh cookie,
 * and the API's CORS allow-list (the browser's `Origin` is forwarded as-is).
 */

export const PROXY_AUTH_HEADER = 'x-sekai-proxy-auth';
export const PROXY_CLIENT_IP_HEADER = 'x-sekai-client-ip';
export const MIN_SECRET_LENGTH = 32;

export interface ApiProxyConfig {
  /** e.g. `https://sekai-api.up.railway.app` — scheme and host only. */
  apiOrigin: string;
  secret: string;
  /** Lower-case header the hosting platform sets to the visitor's IP, or null. */
  clientIpHeader: string | null;
}

export type ApiProxyConfigResult =
  | { kind: 'disabled' }
  | { kind: 'invalid'; problem: string }
  | { kind: 'ok'; config: ApiProxyConfig };

/**
 * Read proxy settings. Unset `SEKAI_API_ORIGIN` means "no proxy" (local
 * development uses the Vite dev proxy instead). A set origin with a missing,
 * empty or short secret is a misconfiguration, never "proxy without auth".
 */
export function readApiProxyConfig(env: Record<string, string | undefined>): ApiProxyConfigResult {
  const rawOrigin = env.SEKAI_API_ORIGIN?.trim();
  if (!rawOrigin) return { kind: 'disabled' };

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return { kind: 'invalid', problem: 'SEKAI_API_ORIGIN is not a URL' };
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') {
    return { kind: 'invalid', problem: 'SEKAI_API_ORIGIN must be http(s)' };
  }
  if (origin.username || origin.password || (origin.pathname !== '/' && origin.pathname !== '')) {
    return {
      kind: 'invalid',
      problem: 'SEKAI_API_ORIGIN must be an origin only (no path or credentials)',
    };
  }
  if (origin.search || origin.hash) {
    return {
      kind: 'invalid',
      problem: 'SEKAI_API_ORIGIN must be an origin only (no query or fragment)',
    };
  }

  const secret = env.SEKAI_PROXY_SECRET?.trim() ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      kind: 'invalid',
      problem: `SEKAI_PROXY_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`,
    };
  }

  const clientIpHeader = env.SEKAI_PROXY_CLIENT_IP_HEADER?.trim().toLowerCase() || null;
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) {
    return { kind: 'invalid', problem: 'SEKAI_PROXY_CLIENT_IP_HEADER is not a header name' };
  }

  return { kind: 'ok', config: { apiOrigin: origin.origin, secret, clientIpHeader } };
}

/** Hop-by-hop and connection-specific headers, never forwarded either way. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers dropped before forwarding: ours (re-set below), routing
 * headers the API must not rely on, and encodings the proxy normalises.
 */
const DROP_REQUEST = new Set([
  'host',
  'content-length',
  'accept-encoding',
  PROXY_AUTH_HEADER,
  PROXY_CLIENT_IP_HEADER,
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
]);

/**
 * Response headers never passed to the browser: ones that no longer describe
 * the body after fetch decoded it, `set-cookie` (re-added one by one below),
 * and the internal proxy headers — the API never sends them, and if it ever
 * did they must not reach a browser.
 */
const DROP_RESPONSE = new Set([
  'content-encoding',
  'content-length',
  'set-cookie',
  PROXY_AUTH_HEADER,
  PROXY_CLIENT_IP_HEADER,
]);

function connectionTokens(headers: Headers): Set<string> {
  return new Set(
    (headers.get('connection') ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Exactly one IPv4 or IPv6 address, as the API requires; anything else → null. */
export function singleIp(value: string | null): string | null {
  if (!value || /[\s,]/.test(value)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255) ? value : null;
  }
  // IPv6: let the URL parser validate it.
  if (value.includes(':')) {
    try {
      return new URL(`http://[${value}]/`).hostname ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export async function proxyApiRequest(
  request: Request,
  config: ApiProxyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith('/api/') && incoming.pathname !== '/api') {
    return jsonError(404, 'not_found', 'Not found.');
  }

  // Build the target from the fixed origin; only path and query vary. Setting
  // `pathname` on a URL can't change its host, even for `//evil.example`.
  const target = new URL(config.apiOrigin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  if (target.origin !== config.apiOrigin) {
    return jsonError(400, 'bad_request', 'Bad request.');
  }

  const nominated = connectionTokens(request.headers);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (HOP_BY_HOP.has(name) || DROP_REQUEST.has(name) || nominated.has(name)) continue;
    headers.append(name, value);
  }
  headers.set('accept-encoding', 'identity');
  headers.set(PROXY_AUTH_HEADER, config.secret);
  const clientIp = config.clientIpHeader
    ? singleIp(request.headers.get(config.clientIpHeader))
    : null;
  if (clientIp) headers.set(PROXY_CLIENT_IP_HEADER, clientIp);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: request.signal,
      // Required by fetch for a streamed request body.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch {
    // Deliberately generic: no upstream URL, no secret, no error text.
    return jsonError(502, 'bad_gateway', 'The SEKAI server could not be reached.');
  }

  const responseHeaders = new Headers();
  const upstreamNominated = connectionTokens(upstream.headers);
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name) || DROP_RESPONSE.has(name) || upstreamNominated.has(name)) continue;
    responseHeaders.append(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  // Keep the browser on the web origin for redirects back into the API.
  const location = upstream.headers.get('location');
  if (location) {
    try {
      const resolved = new URL(location, config.apiOrigin);
      if (resolved.origin === config.apiOrigin) {
        responseHeaders.set('location', resolved.pathname + resolved.search + resolved.hash);
      }
    } catch {
      // Unparseable Location: pass through untouched.
    }
  }

  const body =
    request.method === 'HEAD' || NULL_BODY_STATUS.has(upstream.status) ? null : upstream.body;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** Route entry point: reads config per request so secrets stay runtime-only. */
export async function handleApiProxy(request: Request): Promise<Response> {
  const result = readApiProxyConfig(process.env);
  if (result.kind === 'disabled') {
    return jsonError(404, 'not_found', 'The SEKAI server is not connected to this site.');
  }
  if (result.kind === 'invalid') {
    // Log the problem (never values) for the operator; tell the client nothing.
    console.error(`[api-proxy] misconfigured: ${result.problem}`);
    return jsonError(503, 'unavailable', 'The SEKAI server is not available.');
  }
  return proxyApiRequest(request, result.config);
}
