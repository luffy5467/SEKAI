# Deployment

Two containers plus Postgres and Redis. Nothing else is required.

## Dokploy (the supported path)

1. **Create the application** — point Dokploy at this repository and choose
   *Docker Compose*, with `docker-compose.prod.yml` as the compose file.

2. **Generate signing keys** locally and copy the inline form:

   ```bash
   ./scripts/gen-keys.sh
   ```

   The script prints `JWT_PRIVATE_KEY=…` and `JWT_PUBLIC_KEY=…` with newlines
   escaped, which is the form Dokploy's environment editor accepts.

3. **Set the environment** in Dokploy's UI. The minimum is:

   | Variable            | Example                          |
   | ------------------- | -------------------------------- |
   | `DOMAIN`            | `watch.example.com`              |
   | `API_DOMAIN`        | `api.watch.example.com`          |
   | `POSTGRES_PASSWORD` | *(generate a long random value)* |
   | `JWT_PRIVATE_KEY`   | *(from `gen-keys.sh`)*           |
   | `JWT_PUBLIC_KEY`    | *(from `gen-keys.sh`)*           |
   | `SEKAI_PROXY_SECRET`| *(`openssl rand -hex 32`)*       |

   `SEKAI_PROXY_SECRET` is shared by the web and API containers; the stack
   will not start without it. See
   [Proxy authentication and client IPs](#proxy-authentication-and-client-ips).

   Optional but recommended: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `YOUTUBE_API_KEY`, and TURN credentials. See `.env.example` for the full
   list — every variable there is documented with what it does and whether it
   is required.

4. **Point DNS** at the Dokploy host: an `A` record for both `DOMAIN` and
   `API_DOMAIN`. Traefik requests certificates on first request.

5. **Deploy.** Migrations run automatically at boot; there is no separate
   migration step.

### Why two domains

The API and the web client are separate services with different timeout and
caching needs, and the socket path benefits from a proxy configuration that
would be wrong for a page request. Running them on one domain is possible —
route `/api` and `/ws` to the server — but the split is simpler to reason about
and lets each scale independently.

Browsers no longer call `API_DOMAIN` for `/api`: the web container proxies
`/api` to the API and attaches `SEKAI_PROXY_SECRET` (that is why
`PUBLIC_API_URL` is empty in `docker-compose.prod.yml`). `API_DOMAIN` still
serves WebSocket upgrades (`PUBLIC_WS_URL`) and health checks; a direct `/api`
call there gets 403.

## Proxy authentication and client IPs

The API refuses `/api` requests that lack the proxy secret
(`REQUIRE_PROXY_AUTH`, true in production) and rate-limits sign-up and login
per client IP. Which IP it can trust depends on what sits in front:

| Request path | Identity used | Configure |
|---|---|---|
| Browser → `DOMAIN/api` → web container → API | The IP the web container reads from `SEKAI_PROXY_CLIENT_IP_HEADER` | Set it only to a header your edge proxy **overwrites** on every request |
| Browser → `API_DOMAIN/ws/...` (WebSocket) | `EDGE_CLIENT_IP_HEADER` if set, else the TCP peer | Same rule |
| Anything else direct to `API_DOMAIN/api` | — | Refused with 403 |

Forwarded headers are never trusted on their own. If neither variable is
set, the stack is **safe but shares buckets**: all visitors share one
sign-up/login allowance, and all WebSocket upgrades share the per-minute
HTTP allowance, which one abusive client can use up for everyone.

**Caddy** (`infra/caddy/Caddyfile`). Both site blocks already send
`header_up X-Real-IP {remote_host}`, which per Caddy's documentation *sets*
(replaces) the header with the TCP client address. With Caddy as the only way
in, set:

```
SEKAI_PROXY_CLIENT_IP_HEADER=x-real-ip   # web container
EDGE_CLIENT_IP_HEADER=x-real-ip          # API container
```

Confirm on your Caddy version that a client-sent `X-Real-IP` is replaced
before relying on it (send one with `curl -H 'X-Real-IP: 1.2.3.4'` and check
that your own address is rate-limited, not `1.2.3.4`).

**Traefik / Dokploy.** Traefik's handling of `X-Real-Ip` has not been verified
for this project. Leave both variables empty (shared buckets) until you have
confirmed that Traefik overwrites the header for requests from the internet.

**Opting out.** `REQUIRE_PROXY_AUTH=false` lets the API start in production
*without* `SEKAI_PROXY_SECRET` and serves `/api` to direct callers (it logs a
warning at startup). Use it only if the API is reachable solely through a
reverse proxy you control, on the same origin as the web app. Every per-IP
limit then keys on the TCP peer (your proxy) unless `EDGE_CLIENT_IP_HEADER`
is set as above. `docker-compose.prod.yml` does not opt out.

**Not yet tested end to end.** The proxy and gate are covered by automated
tests running the same web server (`node-server.mjs`) and API natively
(`pnpm test:e2e:proxy`), and `docker-compose.prod.yml` validates with
`docker compose config`. The full stack has not been run in Docker behind
Traefik or Caddy, so verify it on a staging host first.

## Anywhere else

```bash
cp .env.example .env      # then edit it
./scripts/gen-keys.sh
docker compose -f docker-compose.prod.yml up -d
```

Traefik labels are inert without Traefik, so add a proxy in front. The included
`infra/caddy/Caddyfile` is a working configuration with automatic TLS.

## Scaling out

```bash
docker compose -f docker-compose.prod.yml up -d --scale server=3
```

No sticky-session configuration is needed. Each room's authoritative timeline
is owned by whichever node holds its Redis lease; other nodes serve their own
sockets and forward mutating intents to the owner
([ADR 0010](adr/0010-horizontal-scaling.md)).

Postgres and Redis are single instances in the reference deployment. The
natural next step is managed Postgres with a read replica for the directory
queries.

## Health and rollout

| Endpoint        | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `/health/live`  | The process is running. Touches no dependency — a database blip must not trigger a restart loop. |
| `/health/ready` | Postgres and Redis are reachable **and** the node is not draining. |
| `/metrics`      | Prometheus exposition. Keep it off the public internet.     |

On `SIGTERM` the server flips readiness to 503 *first*, waits for the proxy to
notice, then releases its room leases and closes sockets. A deploy costs
clients one reconnect rather than a dropped room.

### What to alert on

- `ytroom_sync_drift_p95_ms` above 150 for a sustained period — this is the
  product's actual SLO, not a proxy for it.
- `ytroom_ws_slow_clients_total` climbing — clients being dropped for failing
  to drain, usually a sign of an overloaded node.
- `/health/ready` failing on any node for more than a minute.

## Operational notes

**Backups.** Only Postgres holds anything irreplaceable. Redis is entirely
reconstructible — losing it costs at most 30 seconds of room read-only time.

**Secrets rotation.** Replacing `JWT_PRIVATE_KEY` invalidates every access
token immediately; clients recover silently via the refresh cookie, so this is
safe to do during business hours. Replacing it *and* clearing
`refresh_tokens` signs everyone out.

**TURN.** Without a TURN server, users behind symmetric NAT (a real minority on
mobile networks) will join the room, see video, chat — and silently fail to
connect voice. If voice matters, run coturn; the dev compose file has a working
configuration to copy.
