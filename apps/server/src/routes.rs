//! Router assembly and the middleware stack.

use crate::{
    auth::{self, CurrentUser},
    db,
    error::{AppError, AppResult},
    health,
    realtime::ws,
    rooms,
    state::AppState,
    util,
    youtube::YouTube,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderName, HeaderValue, Method, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use std::{sync::atomic::Ordering, time::Duration};
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    cors::CorsLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

pub fn build(state: AppState) -> Router {
    let api = Router::new()
        .nest("/auth", auth::routes::router())
        .nest("/rooms", rooms::routes::router())
        .nest("/me", me_router())
        .nest("/stream", stream_router())
        .route("/videos/search", get(search_videos))
        .route("/videos/resolve", get(resolve_video))
        .route("/config", get(client_config));

    // Health and metrics sit outside the throttle: a probe must never be
    // rate-limited, or a busy node looks dead and gets restarted.
    let throttled = Router::new()
        .nest("/api", api)
        .route("/ws/rooms/{room_id}", get(ws::handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            throttle_by_ip,
        ))
        // Added last, so it runs first: see `require_proxy_auth`.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_proxy_auth,
        ));

    let router = Router::new()
        .merge(throttled)
        .nest("/health", health::router())
        .route("/metrics", get(health::metrics))
        .with_state(state.clone());

    apply_layers(router, &state)
}

/// Gate for `/api/**`: with proxy authentication required, a request must
/// carry the SEKAI web proxy's secret or it is refused with 403 — never served
/// on an unauthenticated path. Runs *before* the IP throttle, so rejected
/// direct calls do not drain the shared direct-caller bucket that WebSocket
/// upgrades also use. `/ws/**`, `/health/**` and `/metrics` are not gated.
async fn require_proxy_auth(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let path = request.uri().path();
    let is_api = path == "/api" || path.starts_with("/api/");
    if is_api
        && state.config.require_proxy_auth
        && !crate::client_ip::proxy_authenticated(request.headers(), &state.config.client_ip)
    {
        return Err(AppError::Forbidden("Direct API access is not allowed."));
    }
    Ok(next.run(request).await)
}

/// Coarse per-IP ceiling in front of everything.
///
/// The per-action limits inside handlers are the meaningful ones; this exists
/// so an unauthenticated flood cannot reach them in the first place.
async fn throttle_by_ip(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    state.metrics.http_requests.fetch_add(1, Ordering::Relaxed);

    let subject =
        crate::client_ip::resolve(request.headers(), peer.ip(), &state.config.client_ip).bucket();

    let mut redis = state.redis.clone();
    let decision = crate::ratelimit::check_per_minute(
        &mut redis,
        "http",
        &subject,
        state.config.limits.http_per_minute,
    )
    .await;

    if !decision.allowed {
        state.metrics.rate_limited.fetch_add(1, Ordering::Relaxed);
        return Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        });
    }

    Ok(next.run(request).await)
}

/// Security headers applied to every response.
///
/// The CSP stays strict where strictness costs nothing, and is explicit about
/// the two places it cannot be: a room plays arbitrary URLs, so `media-src` and
/// `img-src` have to admit any https origin. Pinning those to an allowlist
/// would mean the product only works for hosts we happened to think of, which
/// is the opposite of what a room is for. Everything that executes code —
/// `script-src`, `frame-src`, `object-src` — stays on a named list.
pub fn security_headers(state: &AppState) -> Vec<(HeaderName, HeaderValue)> {
    let csp = "default-src 'self'; \
               frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://player.kick.com; \
               img-src 'self' data: https:; \
               media-src 'self' blob: https:; \
               script-src 'self' https://www.youtube.com https://s.ytimg.com https://player.twitch.tv; \
               style-src 'self' 'unsafe-inline'; \
               connect-src 'self' https: ws: wss:; \
               font-src 'self' data:; \
               object-src 'none'; \
               base-uri 'self'; \
               form-action 'self'; \
               frame-ancestors 'none'";

    let mut headers = vec![
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ),
        (
            HeaderName::from_static("permissions-policy"),
            // Microphone is required for voice; everything else is denied.
            HeaderValue::from_static("microphone=(self), camera=(), geolocation=(), payment=()"),
        ),
        (
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_str(csp).unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'")),
        ),
    ];

    // HSTS only in production: sending it from a local http server would pin
    // the developer's browser to https on localhost.
    if state.config.environment.is_production() {
        headers.push((
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        ));
    }

    headers
}

/// CORS for the SPA origin only, with credentials so the refresh cookie flows.
pub fn cors(state: &AppState) -> CorsLayer {
    let origins: Vec<HeaderValue> = state
        .config
        .allowed_origins()
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, REQUEST_ID])
        .allow_credentials(true)
        .max_age(Duration::from_secs(3600))
}

/// The full outer stack, applied in `main` where the concrete types line up.
pub fn apply_layers(router: Router, state: &AppState) -> Router {
    let mut router = router
        .layer(TraceLayer::new_for_http())
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(cors(state))
        .layer(PropagateRequestIdLayer::new(REQUEST_ID))
        .layer(SetRequestIdLayer::new(REQUEST_ID, MakeRequestUuid))
        .layer(CatchPanicLayer::new());

    for (name, value) in security_headers(state) {
        router = router.layer(SetResponseHeaderLayer::if_not_present(name, value));
    }

    router
}

/// What this deployment can actually do.
///
/// The frontend needs to know whether to render a Google button or a search
/// box at all. Feature-detecting by calling an endpoint and handling the error
/// makes the first paint wrong; asking once is honest and cacheable.
async fn client_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());

    Json(serde_json::json!({
        "googleSignIn": state.config.google.is_some(),
        "videoSearch": youtube.is_configured(),
        "voiceMaxPeers": state.config.voice.mesh_max_peers,
        "streamRelay": state.config.stream_relay_enabled,
        "maxRoomParticipants": 100,
        "reactions": crate::realtime::session::ALLOWED_REACTIONS,
    }))
}

// ---------------------------------------------------------------------------
// Stream relay
// ---------------------------------------------------------------------------

/// Where the relay lives. Written once and shared with the rewriter, so the
/// paths in a rewritten manifest can never drift from the routes that serve
/// them.
const MANIFEST_ROUTE: &str = "/api/stream/manifest";
const SEGMENT_ROUTE: &str = "/api/stream/segment";

/// Ceiling on a single relayed segment.
///
/// Segments are a few seconds of video — single-digit megabytes at the
/// bitrates anyone streams over the web. The cap is what stops the relay being
/// used to pull arbitrarily large files through the server.
const MAX_SEGMENT_BYTES: u64 = 48 * 1024 * 1024;

const RELAY_TIMEOUT: Duration = Duration::from_secs(20);

fn stream_router() -> Router<AppState> {
    Router::new()
        .route("/manifest", get(relay_manifest))
        .route("/segment", get(relay_segment))
}

#[derive(Debug, Deserialize)]
struct RelayQuery {
    url: String,
}

/// Fetch a manifest and hand it back with every reference pointing at us.
///
/// Authenticated deliberately. An unauthenticated version of this endpoint is
/// an open proxy: anyone on the internet could route traffic through the
/// server, at the server's expense and under its IP address.
async fn relay_manifest(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Query(query): Query<RelayQuery>,
) -> AppResult<Response> {
    relay_allowed(&state, &claims).await?;

    let opened = crate::media::fetch::open_stream(&query.url, RELAY_TIMEOUT).await?;
    let final_url = opened.final_url.clone();

    let body = opened
        .response
        .text()
        .await
        .map_err(|_| AppError::BadRequest("That stream stopped responding.".into()))?;

    let rewritten =
        crate::media::relay::rewrite_manifest(&body, &final_url, MANIFEST_ROUTE, SEGMENT_ROUTE);

    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
            // A live manifest is rewritten every few seconds; caching one is
            // how a player ends up stuck on a window that has already expired.
            (header::CACHE_CONTROL, "no-store"),
        ],
        rewritten,
    )
        .into_response())
}

/// Stream a segment through, without buffering it.
async fn relay_segment(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Query(query): Query<RelayQuery>,
) -> AppResult<Response> {
    relay_allowed(&state, &claims).await?;

    let opened = crate::media::fetch::open_stream(&query.url, RELAY_TIMEOUT).await?;

    if opened.response.content_length().is_some_and(|length| length > MAX_SEGMENT_BYTES) {
        return Err(AppError::BadRequest("That segment is too large.".into()));
    }

    let content_type = opened
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let content_type = HeaderValue::from_str(&content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            // Media segments are immutable once published, and a live playlist
            // stops referencing them soon enough that this is bounded.
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=30"),
            ),
        ],
        axum::body::Body::from_stream(opened.response.bytes_stream()),
    )
        .into_response())
}

/// Meter the relay per user.
///
/// Far tighter than the general HTTP limit would be: one channel is a manifest
/// refresh every few seconds plus a segment each, and anything an order of
/// magnitude above that is not someone watching television.
async fn relay_allowed(state: &AppState, claims: &crate::auth::tokens::AccessClaims) -> Result<(), AppError> {
    if !state.config.stream_relay_enabled {
        return Err(AppError::Forbidden(
            "This server does not relay streams. Use a link that allows browser playback.",
        ));
    }

    let mut redis = state.redis.clone();
    let decision =
        crate::ratelimit::check_per_minute(&mut redis, "relay", &claims.sub.to_string(), 600).await;

    if decision.allowed {
        Ok(())
    } else {
        state.metrics.rate_limited.fetch_add(1, Ordering::Relaxed);
        Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        })
    }
}

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

fn me_router() -> Router<AppState> {
    Router::new()
        .route("/history", get(watch_history))
        .route("/continue", get(continue_watching))
        .route("/progress", axum::routing::post(record_progress))
        .route("/bookmarks", get(list_bookmarks).post(add_bookmark))
        .route("/bookmarks/{id}", axum::routing::delete(delete_bookmark))
        .route("/favorites/{room_id}", axum::routing::put(add_favorite))
        .route("/favorites/{room_id}", axum::routing::delete(remove_favorite))
        .route("/stats", get(user_stats))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressRequest {
    video_id: String,
    title: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    room_id: Option<uuid::Uuid>,
    position_seconds: f64,
    #[serde(default)]
    duration_seconds: i32,
}

/// Record how far the caller got in a video.
///
/// Client-reported rather than derived from the room timeline, because what
/// matters for "continue watching" is what *this person* saw — someone who
/// joined a room halfway through has not watched the first half.
async fn record_progress(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<ProgressRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let video_id = util::parse_video_id(&body.video_id)
        .ok_or_else(|| AppError::field("videoId", "Not a YouTube video."))?;

    if !body.position_seconds.is_finite() || body.position_seconds < 0.0 {
        return Err(AppError::field("positionSeconds", "Invalid position."));
    }

    // What someone watches in an end-to-end encrypted room must not be
    // recorded in plaintext history. Clients skip this call; refuse it too.
    if let Some(room_id) = body.room_id
        && db::rooms::find_by_id(&state.db, room_id)
            .await?
            .is_some_and(|room| room.e2ee)
    {
        return Ok(Json(serde_json::json!({ "ok": true, "recorded": false })));
    }

    db::history::record_watch(
        &state.db,
        claims.sub,
        db::history::WatchProgress {
            room_id: body.room_id,
            video_id: &video_id,
            title: body.title.trim(),
            thumbnail_url: &body.thumbnail_url,
            position_seconds: body.position_seconds,
            duration_seconds: body.duration_seconds.max(0),
        },
    )
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_bookmark(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let removed = db::history::remove_bookmark(&state.db, claims.sub, id).await?;
    if !removed {
        return Err(AppError::not_found("bookmark"));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn add_favorite(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    axum::extract::Path(room_id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    db::history::set_favorite(&state.db, claims.sub, room_id, true).await?;
    Ok(Json(serde_json::json!({ "favorite": true })))
}

async fn remove_favorite(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    axum::extract::Path(room_id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    db::history::set_favorite(&state.db, claims.sub, room_id, false).await?;
    Ok(Json(serde_json::json!({ "favorite": false })))
}

async fn watch_history(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let entries = db::history::recent_watches(&state.db, claims.sub, 50).await?;
    Ok(Json(entries.into_iter().map(watch_entry_json).collect()))
}

async fn continue_watching(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let entries = db::history::continue_watching(&state.db, claims.sub, 12).await?;
    Ok(Json(entries.into_iter().map(watch_entry_json).collect()))
}

fn watch_entry_json(entry: db::history::WatchHistoryEntry) -> serde_json::Value {
    serde_json::json!({
        "videoId": entry.video_id,
        "title": entry.title,
        "thumbnailUrl": entry.thumbnail_url,
        "roomId": entry.room_id,
        "roomName": entry.room_name,
        "positionSeconds": entry.position_seconds,
        "durationSeconds": entry.duration_seconds,
        "watchedAt": entry.watched_at.timestamp_millis(),
    })
}

async fn list_bookmarks(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let bookmarks = db::history::list_bookmarks(&state.db, claims.sub, 100).await?;
    Ok(Json(
        bookmarks
            .into_iter()
            .map(|b| {
                serde_json::json!({
                    "id": b.id,
                    "videoId": b.video_id,
                    "title": b.title,
                    "thumbnailUrl": b.thumbnail_url,
                    "positionSeconds": b.position_seconds,
                    "note": b.note,
                    "createdAt": b.created_at.timestamp_millis(),
                })
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBookmarkRequest {
    video_id: String,
    title: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    position_seconds: Option<f64>,
    #[serde(default)]
    note: Option<String>,
}

async fn add_bookmark(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<AddBookmarkRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let video_id = util::parse_video_id(&body.video_id)
        .ok_or_else(|| AppError::field("videoId", "Not a YouTube video."))?;

    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(280).collect::<String>());

    let bookmark = db::history::add_bookmark(
        &state.db,
        claims.sub,
        &video_id,
        body.title.trim(),
        &body.thumbnail_url,
        body.position_seconds.filter(|p| p.is_finite() && *p >= 0.0),
        note.as_deref(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "id": bookmark.id })))
}

async fn user_stats(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<db::history::UserStats>> {
    Ok(Json(db::history::user_stats(&state.db, claims.sub).await?))
}

// ---------------------------------------------------------------------------
// Video lookup
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<u8>,
}

/// Search proxied through our own key, never the browser's.
async fn search_videos(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<Vec<crate::youtube::VideoMetadata>>> {
    let term = query.q.trim();
    if term.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // Quota on the Data API is finite and shared; search is the expensive call.
    let mut redis = state.redis.clone();
    let decision =
        crate::ratelimit::check_per_minute(&mut redis, "search", &claims.sub.to_string(), 20).await;

    if !decision.allowed {
        state.metrics.rate_limited.fetch_add(1, Ordering::Relaxed);
        return Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        });
    }

    let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());
    Ok(Json(youtube.search(term, query.limit.unwrap_or(12)).await?))
}

#[derive(Debug, Deserialize)]
struct ResolveQuery {
    url: String,
}

/// Turn a pasted URL into playable metadata, so the client can show a preview
/// before committing it to the queue.
async fn resolve_video(
    State(state): State<AppState>,
    CurrentUser(_): CurrentUser,
    Query(query): Query<ResolveQuery>,
) -> AppResult<Json<crate::youtube::VideoMetadata>> {
    let video_id = util::parse_video_id(&query.url)
        .ok_or_else(|| AppError::field("url", "That is not a YouTube link."))?;

    let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());
    let mut redis = state.redis.clone();
    Ok(Json(youtube.video(&mut redis, &video_id).await))
}
