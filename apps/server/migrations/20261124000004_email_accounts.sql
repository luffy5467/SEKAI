-- SEKAI: email + password accounts.
--
-- A third identity kind alongside Google and guest. Email accounts are full
-- accounts (they can own rooms); guests remain join-only.
--
-- The password hash lives on the row but is never part of USER_COLUMNS, so it
-- cannot leak through the `User` struct or `UserSummary`.

ALTER TABLE users ADD COLUMN password_hash text;

ALTER TABLE users DROP CONSTRAINT users_kind_check;
ALTER TABLE users ADD CONSTRAINT users_kind_check
    CHECK (kind IN ('google', 'guest', 'email'));

ALTER TABLE users DROP CONSTRAINT users_identity_matches_kind;
ALTER TABLE users ADD CONSTRAINT users_identity_matches_kind CHECK (
    (kind = 'google' AND google_sub IS NOT NULL AND password_hash IS NULL) OR
    (kind = 'guest'  AND google_sub IS NULL     AND password_hash IS NULL) OR
    (kind = 'email'  AND google_sub IS NULL     AND password_hash IS NOT NULL AND email IS NOT NULL)
);

-- `users_email_lower_idx` (unique on lower(email)) already prevents two
-- accounts — of any kind — from sharing an address.
