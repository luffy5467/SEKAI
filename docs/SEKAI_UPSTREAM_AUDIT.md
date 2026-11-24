# SEKAI — Upstream Audit (playercn)

**Date:** 2026-11-24
**Upstream:** `https://github.com/ttherealdev/playercn` @ `a652642` (27 commits, last 2026-08-06)
**Remotes:** `upstream` → playercn, `origin` → `luffy5467/SEKAI`
**Scope:** read-only inspection plus local verification. No source files were changed during the audit.

---

## 1. Summary

playercn is a serious, well-engineered watch-party engine: a Rust (Axum/Tokio) authority, a TanStack Start (React 19) client, PostgreSQL + Redis, and a Zod wire protocol. Its core (server-authoritative timeline, clock estimation, drift correction, permissions, chat, queue) is real and tested. **It is a strong foundation for SEKAI.**

It does **not** currently run cleanly out of the box:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ |
| Rust tests (`cargo test`) | ✅ **214 passed**, 0 failed |
| Protocol tests | ✅ **16 passed**, 0 failed |
| Web production build | ✅ builds; `node server.js` serves `/` → 200 |
| Rust server boot + migrations | ✅ `/health/ready` → 200 |
| Guest sign-in | ✅ `POST /api/auth/guest` returns an access token and refresh cookie |
| Room creation as guest | ✅ correctly **403** ("Sign in with Google to create a room") |
| **Web typecheck** | ❌ 1 error, `player.tsx:656` |
| **Biome lint** | ❌ 2 errors, 6 warnings |
| **`pnpm dev` (web dev server)** | ❌ every page → **HTTP 500** |
| Clippy `-D warnings` | ⚠️ not run: `clippy` component not installed (`rustup component add clippy`) |
| End-to-end sync in two real browsers | ⚠️ not verified (no browser automation available in this session) |
| Google OAuth, YouTube search, Kick metadata | ⚠️ not verified (need API credentials) |

---

## 2. Environment

| Tool | Required | Found |
|---|---|---|
| Node | ≥ 22 | 24.12.0 ✅ |
| pnpm | 11.3.0 (`packageManager`) | not installed globally; used via `corepack pnpm` ✅ |
| Rust | ≥ 1.90 | 1.98.1 ✅ |
| Docker | — | 29.8.0 ✅ (Postgres 17 + Redis 8 started via `pnpm infra:up`) |
| openssl | for `gen-keys.sh` | ✅ |
| sqlx-cli | only for `pnpm db:migrate` | missing (not needed: the server runs migrations on boot) |
| clippy | `pnpm server:lint` | missing (`rustup component add clippy`) |

Local setup performed: `.env` copied from `.env.example` (defaults) and an Ed25519 keypair generated in `keys/`. Both are git-ignored.

---

## 3. Architecture (as built)

```
apps/server   Rust · Axum 0.8 · Tokio · SQLx 0.9 · Redis   — the only authority
apps/web      TanStack Start (SSR) · React 19 · Vite 8 · Tailwind 4 · shadcn/Base UI · Zustand · TanStack Query
packages/protocol   Zod schemas mirroring the Rust enums by hand
infra/caddy   reverse proxy; docker-compose(.prod).yml; Dokploy runbook in docs/deployment.md
```

> ⚠️ The README says **Next.js 16**; the code is **TanStack Start + Vite**. The README is stale.

### Backend modules
| Area | Files | Notes |
|---|---|---|
| Timeline / sync | `sync/timeline.rs` (pure) | `anchor_pos + (now − anchor_at) × rate`, monotonic `version`; heavily tested |
| Realtime | `realtime/{ws,session,hub,room,relay,autoadvance,protocol}.rs` | one WS per client; single-use WS ticket (Redis, 30 s); Redis room **leases** for multi-node ownership; pub/sub fan-out |
| Auth | `auth/{tokens,cookies,google,routes,extract}.rs` | EdDSA access JWT (15 min, memory only) + opaque rotating refresh cookie with reuse detection; guest + Google OAuth (PKCE) |
| Rooms | `rooms/{routes,permissions,lifecycle,themes}.rs` | CRUD, public directory, invites, join-by-code, Argon2id room passwords, ownership succession, empty-room cleanup |
| Media | `media/{source,playlist,fetch,relay}.rs`, `youtube.rs`, `kick.rs` | source classification, M3U/PLS, SSRF-guarded fetch, HLS manifest relay |
| Ops | `health.rs`, `metrics.rs`, `ratelimit.rs`, `telemetry.rs` | liveness/readiness, Prometheus metrics, Redis sliding-window limits, graceful drain |

### Database (forward-only SQL migrations, 3 files)
`users`, `refresh_tokens`, `rooms` (visibility public/private/unlisted, `password_hash`, `settings jsonb`, owner/successor), `room_members` (roles **host / cohost / member / guest**, single-host unique index), `room_invites`, `queue_items` (fractional positions, generic sources), `chat_messages` (pins, system kinds), `watch_history`, `bookmarks`, `room_favorites`, `audit_log`, `feature_flags`.
Queries are runtime-bound (`FromRow` + `.bind()`); there is no compile-time `query!` verification.

### Frontend
Routes: `/`, `/rooms` (directory), `/rooms/new`, `/rooms/$slug`.
Room UI: `room-shell`, `player` (1,437 lines), `chat` (virtualised), `queue` (dnd-kit), `participants`, `settings`.
Realtime client: `realtime/clock.ts` (Cristian's algorithm, median of filtered samples, `performance.now()`), `use-player-sync.ts` (drift loop), `socket.ts`, and player engines for **YouTube, direct media, HLS (hls.js), DASH (dash.js), Twitch, Kick** behind one `PlayerEngine` interface.

### Sync parameters (documented and implemented)
- Clock: 8 probes at 250 ms on connect, then every 10 s; 32-sample ring; samples above 1.5 × p20 RTT dropped; median of the rest.
- Drift: < 50 ms → ignore; 50 ms – 1.5 s → ±5 % rate nudge; > 1.5 s → seek. Suppressed while buffering or while the clock estimate is untrusted.
- Clients send intents; even the host waits for the echo. Stale `version` is rejected.

---

## 4. Defects found

| # | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| D1 | **High** | **`pnpm dev` is broken.** Every SSR request returns 500. | `Cannot find module '~/components/ui/button'` from `components/not-found.tsx`. The `~/*` alias exists only in `tsconfig.json` `paths`; the Vite config has no matching `resolve` alias, and the dev SSR runner doesn't apply tsconfig paths. | Add `resolve: { tsconfigPaths: true }` (Vite 8) or an explicit `resolve.alias` in `apps/web/vite.config.ts`. |
| D2 | **High** | **Web typecheck fails** (`pnpm typecheck` exits 1). | `player.tsx(645)`: TS2719. With `exactOptionalPropertyTypes`, line 656 passes `onTheatre` (`(() => void) \| undefined`) to an optional prop typed `() => void`. Introduced by the last upstream commit, "Update player.tsx" (+696 / −338). | Type the prop as `onTheatre?: (() => void) \| undefined`. |
| D3 | Medium | **Lint fails** (Biome: 2 errors, 6 warnings). | Unused suppression in `routes/__root.tsx:59`; `noStaticElementInteractions` in `player.tsx:914`; formatting in `player.tsx`; `!important` in `styles/app.css`. | Fix or justify each. |
| D4 | Medium | **No room can be created without Google OAuth credentials.** Guests are blocked by design, and there is no email/password account. Local development can't exercise the main flow. | `403 forbidden` on `POST /api/rooms` as a guest. | Decide the SEKAI account model (see §8, decision 1). |

---

## 5. Security review (initial)

**Strong, keep as-is:**
- Server-side authorisation re-resolved per action; one policy module (`rooms/permissions.rs`).
- Split tokens: in-memory access JWT, `httpOnly` rotating refresh cookie with family revocation.
- WebSocket auth via a single-use ticket instead of a token in the URL.
- SQL only through `.bind()`.
- SSRF guard on outbound fetches: resolves DNS, requires **every** resolved address to be public, pins the address, and re-checks each redirect hop manually.
- Distributed rate limits; opaque 500s; Argon2id room passwords; strict CSP (per docs).

**Concerns:**

| # | Severity | Finding |
|---|---|---|
| S1 | Medium | **`GET /metrics` is unauthenticated** (returned 200 with no credentials). It exposes operational data to anyone who can reach the API. Restrict it to an internal network, the proxy or a bearer token. |
| S2 | Medium / **policy** | **The HLS relay (`/api/stream/manifest`, `/segment`) re-serves third-party streams whose CORS policy blocks other origins** (the code comments cite Pluto TV). Any signed-in user, **including an anonymous guest**, may use it, at up to 600 requests per minute. This costs bandwidth and re-publishes content its owner restricted, which conflicts with SEKAI's "authorised media only" rule. It needs a product decision (see §8). |
| S3 | Low | `TRUST_PROXY_HEADERS` must be `true` behind a proxy, or rate limits collapse to a single bucket. This is documented, but easy to get wrong in AWS. *Superseded: forwarded headers are no longer trusted at all; proxy authentication (`SEKAI_PROXY_SECRET`) replaces this setting. See docs/DEPLOY_RAILWAY.md.* |
| S4 | Low | No `pnpm audit` / `cargo audit` in a pipeline; there is no CI at all (`.github/` absent). |

Not reviewed in depth yet (Phase 7): CSP headers at runtime, cookie flags in production mode, WS message-size limits, audit-log coverage.

---

## 6. Missing or incomplete functionality

| Area | State |
|---|---|
| **Voice** | Server signalling complete (relay, perfect-negotiation roles, capacity, ICE config); protocol messages defined. **No browser `RTCPeerConnection` controller, so voice doesn't work.** Mesh topology, ~8 peers maximum. TURN optional (coturn profile in compose). |
| Web tests | **None.** No test runner is configured in `apps/web`. |
| Integration / E2E | **None.** No Playwright, no API integration tests, no two-client sync test. |
| CI | None. README badges are static. |
| Protocol contract test | Rust enums and Zod schemas are mirrored by hand; not automated. |
| Compile-time SQL checks | Not adopted (documented trade-off). |
| ADRs | `docs/architecture.md` links to `docs/adr/*`, but **the folder isn't in the repo**. |
| Accounts | Guest + Google only. No email/password, email verification, password reset or avatar upload. |
| Media | No uploads and no "each viewer's own local file" mode. Sources are URL-based or embeds (YouTube / Twitch / Kick). Subtitles not observed. |
| Not started (per upstream) | Admin dashboard, i18n, scheduled rooms, PWA. |

---

## 7. Licence and attribution

- The README states **"Licence: MIT"** and shows an MIT badge, but **the repository contains no `LICENSE` file** and no copyright line.
- A README statement is a weak grant. Before publishing SEKAI publicly we should:
  1. ask the upstream author to add a `LICENSE` file (or confirm MIT in writing), and
  2. add a `LICENSE` + `NOTICE` to SEKAI crediting `ttherealdev/playercn`, keeping the upstream remote and history.
- Until then, treat redistribution as **pending confirmation**. Private development is unaffected.

---

## 8. Decisions needed from the product owner

1. **Account model.** The upstream design is guest + Google OAuth with a custom Rust auth service. The SEKAI brief asked for Supabase email/password.
   - *Recommended:* keep the upstream Rust auth (it is well built, and the Rust service is the single authority) and **add email/password accounts** to it (Argon2id is already a dependency), plus email verification and reset later. Adding Supabase would create a second source of truth for identity.
   - Alternative: configure Google OAuth credentials only (fastest; no email/password).
2. **Stream relay (S2).** Options: (a) disable it by default behind a flag; (b) allow only room hosts or registered users and add a per-room bandwidth budget; (c) keep as-is. *Recommended: (a) off by default.*
3. **Roles.** Upstream uses host / cohost / member / guest; the brief says host / moderator / viewer. *Recommended:* keep the data model and relabel in the UI (cohost → "Moderator", member/guest → "Viewer").
4. **Earlier scaffold.** The scaffold in `~/SEKAI` (Fastify + Vite) is superseded by this codebase. *Recommended:* archive it; reuse only the SEKAI emblem, colour tokens and landing copy.

---

## 9. Proposed next steps (in order)

1. **Make it green** (small, isolated commits): fix D1 (dev alias), D2 (typecheck), D3 (lint). Re-run every check.
2. **Unblock the main flow locally:** resolve decision 1 so a room can be created without Google.
3. **Two-browser verification:** add Playwright and a test that opens two contexts, creates a room, joins it, plays, pauses and seeks, and asserts both positions are within tolerance. This is the first real end-to-end proof.
4. **Then** SEKAI branding (tokens → buttons/cards → landing → room), one verified step at a time.
5. Voice client, moderation, profiles, media improvements and production hardening as in the brief.

---

## Verification log

```
corepack pnpm install --frozen-lockfile    → 215 packages, OK
cargo test                                 → test result: ok. 214 passed; 0 failed
pnpm test:protocol                         → tests 16, pass 16, fail 0
pnpm typecheck                             → FAIL  @playercn/web  player.tsx(645,14) TS2719
pnpm lint                                  → FAIL  2 errors, 6 warnings
pnpm build                                 → OK
node apps/web/server.js                    → GET / 200
pnpm --filter @playercn/web dev            → GET / 500  (Cannot find module '~/components/ui/button')
pnpm infra:up                              → postgres 17, redis 8 healthy
cargo run (server)                         → GET /health/ready 200
POST /api/auth/guest                       → 200 + access token
POST /api/rooms (as guest)                 → 403 forbidden (expected)
GET  /api/rooms                            → 200
GET  /metrics (no auth)                    → 200  (see S1)
cargo clippy                               → NOT RUN (component not installed)
```

---

## 10. Progress since the audit (branch `sekai/foundation`)

| Item | Status | Commit |
|---|---|---|
| D1 `pnpm dev` 500 | ✅ fixed: Vite `resolve.alias` for `~` | `48e1dc6` |
| D2 web typecheck | ✅ fixed | `48e1dc6` |
| D3 lint | ✅ clean (justified suppressions for reduced-motion `!important`) | `48e1dc6` |
| D4 no room creation without Google | ✅ **email + password accounts** (Argon2id, enumeration-safe login, per-IP/per-account limits) | `cace1c0` |
| S1 `/metrics` public | ✅ `METRICS_TOKEN` bearer guard; 404 in production without a token | `6b31f9a` |
| S2 stream relay | ✅ **off by default** (`STREAM_RELAY_ENABLED`); player shows a clear error instead of relaying | `6b31f9a` |
| S4 no CI | ✅ GitHub Actions: lint, typecheck, protocol, build, clippy, cargo test, Playwright | this commit |
| No integration or browser tests | ✅ Playwright: register → create room → queue → guest joins → play/pause/seek sync (< 0.4 s) → late join; guest cannot control playback. 6/6 passing over 3 repeats | `14826d0` |
| Roles host/cohost/member/guest | ✅ shown as Host / Moderator / Viewer | `bc4b7a7` |
| Licence | ⚠️ `NOTICE.md` added; upstream `LICENSE` still to be confirmed | this commit |

**Current verification:** 220 Rust tests, clippy `-D warnings` clean, 16 protocol tests, typecheck clean, Biome clean, production build OK, e2e 2/2.

**Still open:** voice client (WebRTC controller), email verification and password reset (need an email provider such as SES), SEKAI branding, the protocol contract test, compile-time SQL checks, missing ADR documents.
