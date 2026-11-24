//! Who is calling, for rate limiting — and whether they came through our proxy.
//!
//! # Trust boundary
//!
//! The API is reachable two ways:
//!
//! 1. **Through the SEKAI web proxy** (`/api/**` on the web origin, e.g. a
//!    Vercel Function). The proxy strips any client-supplied
//!    `x-sekai-proxy-auth` / `x-sekai-client-ip`, then sets
//!    `x-sekai-proxy-auth` to a shared secret and `x-sekai-client-ip` to the
//!    visitor's IP as reported by its platform. A request carrying the right
//!    secret is trusted for its `x-sekai-client-ip`; nothing else is.
//! 2. **Directly** (the API's own public domain): browsers' WebSockets, health
//!    checks, and anyone with curl. No forwarded header is trusted here —
//!    `X-Forwarded-For`, `X-Real-IP` and `CF-Connecting-IP` are all
//!    client-controllable unless the platform's edge provably overwrites them.
//!    The identity is the TCP peer (on Railway: its edge proxy, i.e. one
//!    bucket shared by every direct caller), unless `EDGE_CLIENT_IP_HEADER`
//!    names a header the edge has been *verified* to overwrite.
//!
//! When proxy authentication is required (the production default),
//! `/api/**` without the right secret is refused outright — see
//! `proxy_authenticated` and the gate in `routes.rs` — so direct API callers
//! never reach a rate limiter at all.
//!
//! The secret proves "this request passed through our proxy". It is **not**
//! user authentication and **not** CSRF protection: the proxy forwards any
//! browser's request. Those remain bearer tokens and the SameSite refresh
//! cookie.

use axum::http::{HeaderMap, HeaderName};
use sha2::{Digest, Sha256};
use std::{fmt, net::IpAddr};

/// Header carrying the shared proxy secret.
pub const PROXY_AUTH_HEADER: HeaderName = HeaderName::from_static("x-sekai-proxy-auth");
/// Header carrying the client IP, trusted only alongside a valid secret.
pub const PROXY_CLIENT_IP_HEADER: HeaderName = HeaderName::from_static("x-sekai-client-ip");
/// Minimum secret length. 32 characters of `openssl rand -hex 32` output is
/// 128 bits; the recommended 64 is 256.
pub const MIN_PROXY_SECRET_LEN: usize = 32;

/// How to identify callers. Built once from config.
#[derive(Clone, Default)]
pub struct ClientIpPolicy {
    /// SHA-256 of the proxy secret. The raw secret is never stored, so it
    /// cannot leak through `Debug`, logs or error messages.
    proxy_secret_digest: Option<[u8; 32]>,
    /// A header the platform edge is verified to overwrite on every request.
    edge_header: Option<HeaderName>,
}

impl fmt::Debug for ClientIpPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientIpPolicy")
            .field("proxy_secret", &self.proxy_secret_digest.map(|_| "<redacted>"))
            .field("edge_header", &self.edge_header)
            .finish()
    }
}

impl ClientIpPolicy {
    pub fn new(proxy_secret: Option<&str>, edge_header: Option<HeaderName>) -> Self {
        Self {
            proxy_secret_digest: proxy_secret.map(digest),
            edge_header,
        }
    }

    pub fn has_proxy_secret(&self) -> bool {
        self.proxy_secret_digest.is_some()
    }
}

/// The identity a request is rate-limited under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientIdentity {
    /// Came through our proxy, which vouched for this IP.
    Proxied(IpAddr),
    /// Came through our proxy, which could not name a valid IP. All such
    /// requests share one bucket: failing closed rather than unlimited.
    ProxiedUnknown,
    /// Direct, identified by a verified edge header.
    Edge(IpAddr),
    /// Direct, identified by the TCP peer. Behind a platform edge this is the
    /// edge itself, shared by every direct caller.
    Peer(IpAddr),
}

impl ClientIdentity {
    /// The rate-limit subject. The same IP is the same subject however it was
    /// established, so one person can't double their allowance by switching
    /// between routes.
    pub fn bucket(&self) -> String {
        match self {
            Self::Proxied(ip) | Self::Edge(ip) | Self::Peer(ip) => ip.to_string(),
            Self::ProxiedUnknown => "proxy-unknown".to_owned(),
        }
    }
}

/// Whether the request carries the correct proxy secret.
///
/// Exactly one header value is accepted; the comparison is constant-time over
/// SHA-256 digests, so neither the secret's content nor its length leaks.
pub fn proxy_authenticated(headers: &HeaderMap, policy: &ClientIpPolicy) -> bool {
    let Some(expected) = policy.proxy_secret_digest.as_ref() else {
        return false;
    };
    let Some(presented) = single_value(headers, &PROXY_AUTH_HEADER) else {
        return false;
    };
    constant_time_eq(&digest(presented), expected)
}

/// Resolve the caller's identity. See the module docs for the policy.
pub fn resolve(headers: &HeaderMap, peer: IpAddr, policy: &ClientIpPolicy) -> ClientIdentity {
    if proxy_authenticated(headers, policy) {
        return match single_value(headers, &PROXY_CLIENT_IP_HEADER).and_then(parse_ip) {
            Some(ip) => ClientIdentity::Proxied(ip),
            None => ClientIdentity::ProxiedUnknown,
        };
    }

    if let Some(header) = &policy.edge_header
        && let Some(ip) = single_value(headers, header).and_then(parse_ip)
    {
        return ClientIdentity::Edge(ip);
    }

    ClientIdentity::Peer(canonical(peer))
}

/// The one value of a header, or `None` if it is absent, repeated, or not
/// visible ASCII. A repeated header is ambiguous and therefore untrusted.
fn single_value<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?;
    if values.next().is_some() {
        return None;
    }
    first.to_str().ok()
}

/// Exactly one IP address and nothing else: no list, no port, no whitespace.
fn parse_ip(value: &str) -> Option<IpAddr> {
    if value.is_empty() || value.contains(|c: char| c == ',' || c.is_whitespace()) {
        return None;
    }
    value.parse::<IpAddr>().ok().map(canonical)
}

/// `::ffff:203.0.113.9` and `203.0.113.9` are the same caller.
fn canonical(ip: IpAddr) -> IpAddr {
    ip.to_canonical()
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-test-only";
    const EDGE: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 1));

    fn policy() -> ClientIpPolicy {
        ClientIpPolicy::new(Some(SECRET), None)
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    fn proxied(ip: &str) -> HeaderMap {
        headers(&[("x-sekai-proxy-auth", SECRET), ("x-sekai-client-ip", ip)])
    }

    // --- buckets ------------------------------------------------------------

    #[test]
    fn separate_verified_ips_get_separate_buckets() {
        let a = resolve(&proxied("203.0.113.1"), EDGE, &policy());
        let b = resolve(&proxied("203.0.113.2"), EDGE, &policy());
        assert_eq!(a, ClientIdentity::Proxied("203.0.113.1".parse().unwrap()));
        assert_ne!(a.bucket(), b.bucket());
    }

    #[test]
    fn the_same_verified_ip_shares_a_bucket() {
        let a = resolve(&proxied("203.0.113.1"), EDGE, &policy());
        let b = resolve(&proxied("203.0.113.1"), "10.9.9.9".parse().unwrap(), &policy());
        assert_eq!(a.bucket(), b.bucket());
    }

    #[test]
    fn ipv4_mapped_ipv6_is_the_same_caller() {
        let a = resolve(&proxied("::ffff:203.0.113.1"), EDGE, &policy());
        let b = resolve(&proxied("203.0.113.1"), EDGE, &policy());
        assert_eq!(a.bucket(), b.bucket());
        let v6 = resolve(&proxied("2001:db8::1"), EDGE, &policy());
        assert_eq!(v6, ClientIdentity::Proxied("2001:db8::1".parse().unwrap()));
    }

    // --- spoofing -----------------------------------------------------------

    #[test]
    fn forwarded_headers_never_change_a_direct_identity() {
        // Even with every header a client might forge, a direct caller is the peer.
        let spoofed = headers(&[
            ("x-forwarded-for", "198.51.100.7"),
            ("x-real-ip", "198.51.100.8"),
            ("cf-connecting-ip", "198.51.100.9"),
            ("x-sekai-client-ip", "198.51.100.10"),
        ]);
        for policy in [policy(), ClientIpPolicy::default()] {
            let identity = resolve(&spoofed, EDGE, &policy);
            assert_eq!(identity, ClientIdentity::Peer(EDGE));
        }
        let other = headers(&[("x-forwarded-for", "192.0.2.55"), ("x-sekai-client-ip", "192.0.2.56")]);
        assert_eq!(
            resolve(&spoofed, EDGE, &policy()).bucket(),
            resolve(&other, EDGE, &policy()).bucket(),
            "changing spoofed headers must not move a direct caller to a new bucket"
        );
    }

    #[test]
    fn a_wrong_or_missing_secret_is_not_trusted() {
        for auth in [None, Some(""), Some("wrong"), Some(&SECRET[..SECRET.len() - 1])] {
            let mut map = headers(&[("x-sekai-client-ip", "203.0.113.1")]);
            if let Some(value) = auth {
                map.insert(PROXY_AUTH_HEADER, HeaderValue::from_str(value).unwrap());
            }
            assert!(!proxy_authenticated(&map, &policy()), "{auth:?}");
            assert_eq!(resolve(&map, EDGE, &policy()), ClientIdentity::Peer(EDGE));
        }
    }

    #[test]
    fn a_repeated_secret_header_is_not_trusted() {
        let map = headers(&[
            ("x-sekai-proxy-auth", SECRET),
            ("x-sekai-proxy-auth", SECRET),
            ("x-sekai-client-ip", "203.0.113.1"),
        ]);
        assert!(!proxy_authenticated(&map, &policy()));
    }

    #[test]
    fn without_a_configured_secret_nothing_is_proxy_authenticated() {
        assert!(!proxy_authenticated(&proxied("203.0.113.1"), &ClientIpPolicy::default()));
    }

    // --- malformed client IP from an authenticated proxy -----------------------

    #[test]
    fn malformed_missing_or_multi_entry_client_ip_fails_closed() {
        for bad in ["", "not-an-ip", "203.0.113.1, 203.0.113.2", " 203.0.113.1", "203.0.113.1:443", "999.1.1.1"] {
            let map = headers(&[("x-sekai-proxy-auth", SECRET), ("x-sekai-client-ip", bad)]);
            assert_eq!(resolve(&map, EDGE, &policy()), ClientIdentity::ProxiedUnknown, "{bad:?}");
        }
        let missing = headers(&[("x-sekai-proxy-auth", SECRET)]);
        assert_eq!(resolve(&missing, EDGE, &policy()), ClientIdentity::ProxiedUnknown);
        let repeated = headers(&[
            ("x-sekai-proxy-auth", SECRET),
            ("x-sekai-client-ip", "203.0.113.1"),
            ("x-sekai-client-ip", "203.0.113.2"),
        ]);
        assert_eq!(resolve(&repeated, EDGE, &policy()), ClientIdentity::ProxiedUnknown);
        assert_eq!(ClientIdentity::ProxiedUnknown.bucket(), "proxy-unknown");
    }

    // --- optional verified edge header -----------------------------------------

    #[test]
    fn edge_header_is_used_only_when_configured_and_well_formed() {
        let edge_policy = ClientIpPolicy::new(Some(SECRET), Some(HeaderName::from_static("x-real-ip")));
        let good = headers(&[("x-real-ip", "198.51.100.4"), ("x-forwarded-for", "192.0.2.1")]);
        assert_eq!(
            resolve(&good, EDGE, &edge_policy),
            ClientIdentity::Edge("198.51.100.4".parse().unwrap())
        );
        for bad in ["", "198.51.100.4, 192.0.2.1", "nonsense"] {
            let map = headers(&[("x-real-ip", bad)]);
            assert_eq!(resolve(&map, EDGE, &edge_policy), ClientIdentity::Peer(EDGE), "{bad:?}");
        }
        // Disabled by default: the same header is ignored.
        assert_eq!(resolve(&good, EDGE, &policy()), ClientIdentity::Peer(EDGE));
    }

    #[test]
    fn a_valid_proxy_secret_takes_precedence_over_the_edge_header() {
        let edge_policy = ClientIpPolicy::new(Some(SECRET), Some(HeaderName::from_static("x-real-ip")));
        let mut map = proxied("203.0.113.1");
        map.insert("x-real-ip", HeaderValue::from_static("10.20.30.40"));
        assert_eq!(
            resolve(&map, EDGE, &edge_policy),
            ClientIdentity::Proxied("203.0.113.1".parse().unwrap())
        );
    }

    #[test]
    fn debug_output_never_contains_the_secret() {
        let rendered = format!("{:?}", policy());
        assert!(!rendered.contains(SECRET));
        assert!(rendered.contains("<redacted>"));
    }
}
