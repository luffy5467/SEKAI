//! End-to-end encrypted rooms: what the server checks about ciphertext.
//!
//! The server cannot read sealed values — that is the point — so it validates
//! only their *shape*: the `e1.` prefix, base64url characters, and a size cap.
//! It also refuses plaintext where an encrypted room expects ciphertext, so a
//! buggy or outdated client cannot silently leak a message or a link.
//! The browser side lives in `packages/protocol/src/e2ee.ts`.

/// Prefix of every sealed value (`e1.` + base64url(iv ‖ ciphertext ‖ tag)).
pub const SEALED_PREFIX: &str = "e1.";

/// Name stored in `rooms.name` for an encrypted room. Members see the real
/// name, which only their browsers can decrypt.
pub const PLACEHOLDER_ROOM_NAME: &str = "Encrypted room";

/// Stored as an encrypted queue item's URL. `.invalid` is reserved (RFC 2606),
/// so this can never resolve or be fetched.
pub const SEALED_SOURCE_URL: &str = "https://sealed.invalid/";

/// Title stored for an encrypted queue item.
pub const PLACEHOLDER_ITEM_TITLE: &str = "Encrypted item";

// Smallest possible: prefix + base64url of a 12-byte IV and a 16-byte tag.
const MIN_SEALED_CHARS: usize = 3 + 38;

pub const MAX_SEALED_META: usize = 2048;
pub const MAX_KEY_CHECK: usize = 256;
pub const MAX_SEALED_CHAT: usize = 12_000;
pub const MAX_SEALED_QUEUE: usize = 16_384;

/// Whether `value` is shaped like ciphertext and no longer than `max`.
pub fn is_sealed(value: &str, max: usize) -> bool {
    let Some(body) = value.strip_prefix(SEALED_PREFIX) else {
        return false;
    };
    value.len() >= MIN_SEALED_CHARS
        && value.len() <= max
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(len: usize) -> String {
        format!("{SEALED_PREFIX}{}", "A".repeat(len))
    }

    #[test]
    fn accepts_well_formed_ciphertext() {
        assert!(is_sealed(&sample(40), 100));
        assert!(is_sealed("e1.Ab-_9zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 100));
    }

    #[test]
    fn rejects_plaintext_and_malformed_values() {
        for bad in [
            "hello world",
            "e1.",
            "e1.short",
            "E1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "e1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+",
            "e1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ",
        ] {
            assert!(!is_sealed(bad, 100), "accepted {bad:?}");
        }
    }

    #[test]
    fn enforces_the_size_cap() {
        assert!(is_sealed(&sample(97), 100));
        assert!(!is_sealed(&sample(98), 100));
    }
}
