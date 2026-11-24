# Deploying the SEKAI API on Railway

The web app runs on Vercel. The API is the Rust server in `apps/server`, with
Postgres on Supabase and Redis on Railway.

```
Browser ──▶ Vercel (web)  ──/api/** proxy──▶ Railway: SEKAI API ──▶ Supabase Postgres
   └──────────── WebSocket (wss) ──────────▶       │
                                                  └──▶ Railway Redis (private network)
```

`/api` goes through Vercel so the login cookie stays same-site (it is
`SameSite=Lax`). Vercel's proxy (`apps/web/src/server/api-proxy.ts`) attaches
a shared secret, `SEKAI_PROXY_SECRET`, and the visitor's IP. The API refuses
`/api` without that secret (403), so the Railway domain can't be used to
bypass the web proxy or to forge a rate-limit identity. The WebSocket connects
to Railway directly; it authenticates with a one-time ticket that can only be
obtained through the proxied `/api`.

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
| `SEKAI_PROXY_SECRET` | the shared proxy secret (see below); **same value on Vercel** |
| `DATABASE_URL` | Supabase **Session pooler** URL (port 5432) + `?sslmode=require` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | from step 3 |
| `METRICS_TOKEN` | a long random string (`openssl rand -hex 32`) |
| `RUST_LOG` | `info,sqlx=warn` |

Do **not** set:

- `REQUIRE_PROXY_AUTH`. It defaults to `true` in production, and the server
  refuses to start without `SEKAI_PROXY_SECRET` (missing, empty or under 32
  characters). `false` would serve `/api` to anyone calling the Railway domain.
- `EDGE_CLIENT_IP_HEADER`. Off by default; see "Direct WebSocket rate limits"
  below for what must be verified before enabling it.
- `TRUST_PROXY_HEADERS`. No longer used (the server warns if it is set).
- `BIND_ADDR`. Railway sets `PORT`, which the server listens on automatically.

**Generate `SEKAI_PROXY_SECRET`** in your own terminal with
`openssl rand -hex 32`. Paste it into Railway and Vercel; never into a chat,
an issue, or a file in the repository.

Migrations run on start, including the one that locks Supabase's public data
API.

### Database connection pool

The server's pool is `DATABASE_MAX_CONNECTIONS` (default **20**) and
`DATABASE_MIN_CONNECTIONS` (default **2**), per running instance. Plan for
more than one instance at a time:

- During a deploy Railway starts the new instance and keeps the old one until
  the new one passes `/health/ready`, so for a short time **2 × the pool**.
- More replicas multiply it.
- Anything else connected to the same database (a local server, migrations,
  the Supabase dashboard) uses the same allowance.

Check your Supabase project's connection-pooler client limit in the Supabase
dashboard, then keep `DATABASE_MAX_CONNECTIONS × (instances during a deploy)`
plus headroom under it. The defaults have not been changed because that limit
depends on your plan.

## 5. Point the web app at the API (Vercel)

In the Vercel project **sekai → Settings → Environment Variables**
(Production), then redeploy:

| Variable | Value | Read |
|---|---|---|
| `SEKAI_API_ORIGIN` | `https://…up.railway.app` (origin only, no trailing slash or path) | at runtime |
| `SEKAI_PROXY_SECRET` | the same value as on Railway | at runtime, server only |
| `SEKAI_PROXY_CLIENT_IP_HEADER` | `x-real-ip` | at runtime |
| `PUBLIC_WS_URL` | `wss://…up.railway.app` | at build time (inlined into the client) |

The three `SEKAI_*` values are read by the server-side proxy on each request
and never reach the browser: the build contains no secret, and an automated
test checks the client bundle for it. If `SEKAI_API_ORIGIN` is set but the
secret is missing or short, the proxy answers 503 rather than forwarding
without authentication.

`SEKAI_PROXY_CLIENT_IP_HEADER=x-real-ip` relies on Vercel setting that header
to the visitor's IP in a way a visitor cannot override. Vercel documents
`x-real-ip` as the client IP and describes overwriting `x-forwarded-for` "to
prevent IP spoofing", but it does not state explicitly that a client-sent
`x-real-ip` is always replaced for requests reaching a Function. **Treat this
as unverified until the post-deploy check below passes.** If it fails, unset
the variable: all visitors then share one sign-up/login bucket (safe, but
easier to exhaust).

## 6. Check

- `https://…up.railway.app/health/ready` → `200`
- `https://…up.railway.app/api/config` → `403` (direct API access is refused)
- `https://sekai-lilac.vercel.app/api/config` → JSON, and the "room server isn't
  connected" banner is gone
- Register, create a room, open the invite link in a private window, and chat
  and play together.

## 7. Post-deploy verification (required before calling this production-ready)

Run these yourself, after the deploy, against your own test account. They
send a small number of failed logins; don't run them repeatedly against a
site with real users.

1. **Vercel client-IP integrity.** From one machine, send 31 failed logins
   through the Vercel site, each with a different forged `x-real-ip` and
   `x-forwarded-for` and a different made-up email:

   ```bash
   for i in $(seq 1 31); do
     curl -s -o /dev/null -w "%{http_code}\n" https://sekai-lilac.vercel.app/api/auth/login \
       -H 'content-type: application/json' \
       -H "x-real-ip: 192.0.2.$i" -H "x-forwarded-for: 192.0.2.$i" \
       -d "{\"email\":\"probe-$i-$RANDOM@example.test\",\"password\":\"wrong-password-123\"}"
   done
   ```

   **Pass:** the first 30 print `422`, the 31st prints `429` (Vercel replaced
   the forged headers, so every attempt counted against your real IP).
   **Fail:** all 31 print `422`. The forged header reached the API, so unset
   `SEKAI_PROXY_CLIENT_IP_HEADER` on Vercel and redeploy. Wait 15 minutes
   before logging in from that machine again.
2. **Direct access refused.** `curl -i https://…up.railway.app/api/config` →
   `403`, also with `-H 'x-sekai-proxy-auth: guess'`.
3. **Railway's `X-Real-IP` (only if you want `EDGE_CLIENT_IP_HEADER`).**
   Railway documents `X-Real-IP` as the client's IP but not whether a
   client-sent value is replaced. Enable `EDGE_CLIENT_IP_HEADER=x-real-ip`
   only after showing that a forged `X-Real-IP` sent straight to the Railway
   domain does not change which rate-limit bucket you land in.

## Direct WebSocket rate limits (known availability risk)

WebSocket upgrades go straight to Railway, so they are identified by the
direct-route rule: `EDGE_CLIENT_IP_HEADER` if enabled, otherwise the TCP peer.
On Railway the TCP peer is Railway's edge, so **by default every WebSocket
upgrade from every user shares one bucket** of `RL_HTTP_PER_MIN` (300 a
minute). One client opening connections in a loop can use it up, and
legitimate users then can't connect (or reconnect) until the minute rolls
over.

What limits the damage today:

- Direct `/api` calls are refused **before** the throttle, so they don't
  drain this bucket.
- An upgrade without a valid one-time ticket is closed within
  `WS_HANDSHAKE_TIMEOUT_SECS` (5 s), and tickets are issued only through the
  proxied, per-IP-limited `/api`.

It is still an open availability risk. Resolving it needs one of:

- verifying Railway's `X-Real-IP` (step 3 above) and enabling
  `EDGE_CLIENT_IP_HEADER`; or
- a future change that validates the ticket before the upgrade, so unticketed
  upgrades never count.

## Deployment order and rollback

### Treat the first deployment as staging

Green CI shows the code behaves as tested locally. It does not show how
Vercel, Railway and Supabase behave together. Do the first deployment as a
controlled verification, ideally on a separate Railway environment, Vercel
preview and Supabase project, and only promote once section 7's checks pass
and the open items below are resolved or accepted.

### Order

The API and the web proxy must agree on `SEKAI_PROXY_SECRET`. Deploying the
API first is safe because nothing points at it yet:

1. **Railway:** set all variables, including `SEKAI_PROXY_SECRET`. Deploy and
   confirm `/health/ready` is `200` and direct `/api/config` is `403`. The
   live Vercel site still has no `SEKAI_API_ORIGIN`, so users see the
   "not connected" banner and nothing breaks.
2. **Vercel:** set `SEKAI_API_ORIGIN`, `SEKAI_PROXY_SECRET`,
   `SEKAI_PROXY_CLIENT_IP_HEADER` and `PUBLIC_WS_URL`, then redeploy, so the
   proxy and client build pick them up.
3. Run the checks in sections 6 and 7.

### Rollback

**Database migrations are forward-only, and the API must not be rolled back
past this release.** The release adds three migrations (`20261124000004` to
`…006`). They only add columns and constraints, but the previous application
version can't use the data they allow:

| Migration | What an older API or web build would do |
|---|---|
| `…004_email_accounts` | The older web client's protocol rejects the account kind `email`, so it silently drops room snapshots containing email users. The older API has no email login. |
| `…005_e2ee_rooms` | The older API ignores `rooms.e2ee`: it would show placeholder names, **accept plaintext chat and links into encrypted rooms** (breaking the encryption guarantee), and try to play `https://sealed.invalid/` items. |
| `…006_lock_public_schema` | No effect on the API, which owns the tables. |

So, once these migrations have run against a database:

- **API problems:** fix forward (deploy a corrected build), or restore the
  database from a backup taken *before* the migrations together with the old
  build. Point-in-time backups depend on your Supabase plan; check this
  before the first deploy. Redeploying an earlier build of *this* release
  (same migrations) is safe.
- **Web problems:** promote the previous Vercel deployment of this release
  (instant). Don't promote a build from before this release; its client
  can't read email accounts.
- **Disconnect switch, not a rollback:** removing `SEKAI_API_ORIGIN` on
  Vercel and redeploying turns the product off. Verified locally:
  `/api/config` returns `404` "not connected", the site shows the "not
  connected" banner, and sign-up shows that message. Browsing works; accounts
  and rooms do not.
- **Secret mismatch** (every `/api` call returns 403 through Vercel): set the
  same value in both places and redeploy Vercel; the API needs no change.
- **Rotating the secret:** the API accepts one secret at a time, so a
  rotation briefly returns 403 to in-flight requests. Change Railway first,
  then Vercel immediately after, at a quiet time.
- **Unsetting `SEKAI_PROXY_CLIENT_IP_HEADER`** (for example, if check 1
  fails) is safe for security but has an **availability cost**: every visitor
  shares one sign-up allowance (`RL_REGISTER_PER_HOUR`, `RL_GUEST_PER_HOUR`)
  and one login allowance (30 per 15 minutes), so one person or a busy
  evening can lock everyone out of signing in until the window passes.

### Still open before production

- Vercel's `x-real-ip` integrity (section 7, check 1).
- Railway's `X-Real-IP` integrity, which decides `EDGE_CLIENT_IP_HEADER`
  (check 3).
- The direct-WebSocket shared-bucket denial-of-service risk (section above).
- The Supabase connection budget (pool sizing above).
- Self-hosted container and edge configurations (Traefik, Caddy) have not
  been run end to end; see docs/deployment.md.

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
