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
2. In the API service (not Redis), set both of these:

   | Setting | Value |
   |---|---|
   | **Settings → Source → Root Directory** | `apps/server` |
   | **Config File Path** (service Settings, config-as-code section; the label may vary) | `/apps/server/railway.toml` |

   - **Root Directory.** Without it, Railway builds the repository root, detects
     the pnpm workspace as a Node app, and fails with "No start command
     detected". With it, Railway builds `apps/server/Dockerfile` using
     `apps/server` as the build context.
   - **Config File Path.** Railway's docs state that the config file *does not
     follow* the Root Directory, so `apps/server/railway.toml` is not found
     automatically. Without this setting the Dockerfile is still used, but the
     `/health/ready` health check and restart policy in that file are ignored.
     Use the absolute path, with the leading `/`.
   - After saving, **reload the page and confirm both values are still there**,
     and apply any pending-changes banner.
3. **Settings → Networking → Generate Domain.** Note it, e.g.
   `https://sekai-api-production.up.railway.app`.

The build needs nothing outside `apps/server`. The server is a standalone Cargo
crate (no workspace), `Cargo.lock` lives in `apps/server`, there are no path
dependencies, and the Dockerfile copies only `Cargo.toml`, `Cargo.lock`,
`build.rs`, `src/` and `migrations/`. A `docker build` from `apps/server` has
been run successfully. The resulting image listens on `$PORT` and passes
`/health/ready` in production mode.

## 2. Redis

**New → Database → Redis** in the same project. Reference it from the API
service as `REDIS_URL=${{Redis.REDIS_URL}}`, replacing `Redis` with the Redis
service's actual name if yours differs. That URL is plain `redis://` on
Railway's private network, which the server's Redis client supports.

## 3. Production signing keys

Generate a **new** keypair; never reuse development keys. Run this in your own
terminal (not inside Claude Code, so the private key isn't shown in a chat):

```bash
./scripts/gen-keys.sh keys/prod
```

It prints `JWT_PRIVATE_KEY="…"` and `JWT_PUBLIC_KEY="…"`, the exact names the
server reads (`apps/server/src/config.rs`). In Railway's single-variable form,
paste only the value, without the surrounding double quotes; the literal `\n`
sequences are expected and decoded by the server. `keys/` is git-ignored.

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

## Fallback: deploying with the Railway CLI

Use this only if deploying from GitHub isn't possible, for example when the
service's branch picker shows "Could not load branches".

> **Status: not yet tested.** Part of this procedure depends on Railway
> behaviour that is not documented (see below). Treat the first run as a test
> and watch the build log at the checkpoint.

### Verified

From the Railway CLI source (`src/commands/up.rs`, `src/controllers/upload.rs`)
and Railway's docs:

- `railway up` uploads files relative to the **linked project directory**: the
  nearest folder, searching upward, where `railway link` was run. "By default,
  Railway uses your project root as the archive base."
- `railway up <path>` uploads only `<path>`, keeping paths relative to the
  linked directory. Linked at the repository root, `railway up apps/server`
  uploads `apps/server/...` paths only.
- `--path-as-root` makes `<path>` itself the archive root instead.
- The upload skips `.git`, `node_modules`, and anything matched by `.gitignore`
  or `.railwayignore`. That excludes `.env`, `keys/` and `target/` here.
- `railway up` uploads your **local working tree**, including uncommitted
  changes, not a git commit.

### Not verified

- Whether Railway applies the service's **Root Directory** to files uploaded
  with `railway up`. Railway documents Root Directory for GitHub deployments.
  For the CLI it only says to "configure a root directory in your service
  settings" to deploy a specific directory, which suggests but does not state
  that it applies.

### Procedure (keeps Root Directory `apps/server`)

Run every command from the repository root, `~/Developer/sekai`.

```bash
git switch sekai/foundation && git pull
git status --short          # must print nothing: uncommitted edits would be uploaded
brew install railway        # or: npm install -g @railway/cli
railway login               # opens a browser
railway link                # choose: your SEKAI project → environment → the API service (not Redis)
railway status              # confirm project, environment and service before deploying
railway up apps/server      # no --path-as-root, no --new, no -y
```

Don't run `railway up` with `--new`, or with `-y` while nothing is linked:
either creates a **new** project instead of deploying to the existing service.

**Expected:** Railway builds `apps/server/Dockerfile` with `apps/server` as the
build context, and the deploy waits on `/health/ready` (from the Config File
Path above).

**Checkpoint (first lines of the build log):**

- Building from the Dockerfile and compiling the Rust stages means Root
  Directory was applied, so the procedure works.
- "Railpack", "Detected Node", or "No start command detected" means Root
  Directory was **not** applied to the upload. Stop. The alternative,
  `railway up apps/server --path-as-root` with Root Directory cleared, also
  changes how GitHub deployments of this service build. Decide it deliberately
  rather than switching back and forth.

Once tested, update this section with the result.

## Costs

Railway bills by usage. A small API plus Redis is typically a few dollars a
month; check Railway's current pricing. The Supabase free tier covers
development-scale Postgres. Nothing here streams video through your servers:
the stream relay is off by default.
