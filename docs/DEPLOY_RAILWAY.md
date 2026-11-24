# Deploying the SEKAI API on Railway

The web app runs on Vercel. The API is the Rust server in `apps/server`, with
Postgres on Supabase and Redis on Railway.

```
Browser ──▶ Vercel (web)  ──/api/** proxy──▶ Railway: SEKAI API ──▶ Supabase Postgres
   └──────────── WebSocket (wss) ──────────▶       │
                                                  └──▶ Railway Redis (private network)
```

`/api` goes through Vercel so the login cookie stays same-site (it is
`SameSite=Lax`). The WebSocket connects to Railway directly; it authenticates
with a one-time ticket, not a cookie.

## 1. Railway service for the API

1. In your Railway project: **New → GitHub Repo → luffy5467/SEKAI**.
2. Service **Settings → Source → Root Directory: `apps/server`**.
   Without this Railway builds the repository root as a Node app and fails
   with "No start command detected".
   `apps/server/railway.toml` then selects the Dockerfile and the
   `/health/ready` health check.
3. **Settings → Networking → Generate Domain.** Note it, e.g.
   `https://sekai-api-production.up.railway.app`.

## 2. Redis

**New → Database → Redis** in the same project. Reference it from the API
service as `REDIS_URL=${{Redis.REDIS_URL}}`. That URL is plain `redis://` on
Railway's private network, which the server's Redis client supports.

## 3. Production signing keys

Generate a **new** keypair; never reuse development keys. Run this in your own
terminal (not inside Claude Code, so the private key isn't shown in a chat):

```bash
./scripts/gen-keys.sh keys/prod
```

It prints `JWT_PRIVATE_KEY="…"` and `JWT_PUBLIC_KEY="…"`. Paste both into
Railway variables. `keys/` is git-ignored.

## 4. API service variables

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `PUBLIC_URL` | your Railway domain, `https://…up.railway.app` |
| `WEB_ORIGIN` | `https://sekai-lilac.vercel.app` (your Vercel site) |
| `TRUST_PROXY_HEADERS` | `true` (Railway sits behind a proxy) |
| `DATABASE_URL` | Supabase **Session pooler** URL (port 5432) + `?sslmode=require` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | from step 3 |
| `METRICS_TOKEN` | a long random string (`openssl rand -hex 32`) |
| `RUST_LOG` | `info,sqlx=warn` |

Railway sets `PORT`; the server listens on it automatically. Migrations run on
start, including the one that locks Supabase's public data API.

## 5. Point the web app at the API (Vercel)

In the Vercel project **sekai → Settings → Environment Variables**
(Production), then redeploy:

| Variable | Value |
|---|---|
| `SEKAI_API_ORIGIN` | `https://…up.railway.app` (no trailing slash) |
| `PUBLIC_WS_URL` | `wss://…up.railway.app` |

`SEKAI_API_ORIGIN` makes the Vercel build proxy `/api/**` to Railway.
`PUBLIC_WS_URL` is inlined into the client for the WebSocket.

## 6. Check

- `https://…up.railway.app/health/ready` → `200`
- `https://sekai-lilac.vercel.app/api/config` → JSON, and the "room server isn't
  connected" banner is gone
- Register, create a room, open the invite link in a private window, and chat
  and play together.

## Costs

Railway bills by usage. A small API plus Redis is typically a few dollars a
month; check Railway's current pricing. The Supabase free tier covers
development-scale Postgres. Nothing here streams video through your servers:
the stream relay is off by default.
