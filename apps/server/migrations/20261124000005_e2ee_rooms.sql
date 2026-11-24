-- SEKAI: end-to-end encrypted rooms.
--
-- In an encrypted room the browser seals the room name, chat messages and
-- queue items with a room key the server never sees (it travels only in the
-- invite link's #fragment). The server stores and relays ciphertext.
--
-- Columns that must stay readable for sync, access control and moderation —
-- timeline numbers, membership, roles, timestamps — are unchanged.

ALTER TABLE rooms
    ADD COLUMN e2ee        boolean NOT NULL DEFAULT false,
    -- Sealed {name, topic}. `name` then holds a generic placeholder.
    ADD COLUMN meta_sealed text CHECK (meta_sealed IS NULL OR char_length(meta_sealed) <= 2048),
    -- Sealed constant, so a joiner can tell a wrong key from a missing one.
    ADD COLUMN key_check   text CHECK (key_check IS NULL OR char_length(key_check) <= 256);

-- An encrypted room always carries its sealed metadata, is never listed in the
-- public directory (whose search would index the placeholder anyway) and keeps
-- no plaintext topic. A plain room carries none of the sealed fields.
ALTER TABLE rooms ADD CONSTRAINT rooms_e2ee_shape CHECK (
    (e2ee AND meta_sealed IS NOT NULL AND key_check IS NOT NULL
          AND visibility <> 'public' AND topic IS NULL)
    OR
    (NOT e2ee AND meta_sealed IS NULL AND key_check IS NULL)
);

-- Sealed chat bodies are base64 of the UTF-8 ciphertext: up to ~4.5x longer
-- than the 2000-character plaintext limit, which the server still enforces
-- for unencrypted rooms.
ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_body_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_body_check
    CHECK (char_length(body) BETWEEN 1 AND 12000);

-- A sealed queue item stores ciphertext here and a placeholder in source_url.
ALTER TABLE queue_items
    ADD COLUMN sealed text CHECK (sealed IS NULL OR char_length(sealed) <= 16384);
