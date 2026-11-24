# End-to-end encryption in SEKAI

Rooms are **end-to-end encrypted by default**. A host can turn encryption off
when creating a room (for example, to list it publicly).

## What is encrypted

| Data | Encrypted? | Notes |
|---|---|---|
| Room name and topic | ✅ | Server stores the placeholder `Encrypted room` and ciphertext. |
| Chat messages (incl. pinned) | ✅ | Server stores and relays ciphertext only. |
| Queue: links, titles, source type | ✅ | Server stores `https://sealed.invalid/` and ciphertext. |
| The video itself | ✅ never touches SEKAI | Each browser streams directly from the source over HTTPS. The stream relay is off by default. |
| Voice (when the browser client ships) | ✅ by design | Peer-to-peer WebRTC (DTLS-SRTP); the server only relays connection setup. |
| Transport | ✅ | HTTPS / WSS everywhere. |

## What is not encrypted — and why

| Data | Why the server must read it |
|---|---|
| Play / pause / seek positions, playback rate | The server is the timeline authority that keeps everyone in sync. These are numbers, not content. |
| Who is in a room, display names, roles, timestamps | Access control, moderation and presence. |
| System chat lines ("Aiko joined") | Written by the server. |
| Account email and password | Needed to sign in. The password is stored only as an Argon2id hash. |
| Media duration | Reported by players so the room can auto-advance. |

## How it works

- **Key.** The host's browser generates a random 256-bit AES-GCM key when the
  room is created (`generateRoomKey`). The server never receives it.
- **Distribution.** The key travels in the invite link's fragment:
  `https://…/rooms/<slug>#k=<key>`. Browsers never send the fragment in requests
  or `Referer` headers. On arrival the key is saved on that device
  (`localStorage`) and **removed from the address bar**, so it doesn't appear in
  screenshots or screen shares. **Copy link** in the room adds it back.
- **Sealing.** `e1.` + base64url(IV ‖ ciphertext ‖ tag). Each value gets a
  fresh 96-bit IV. The field (`name`, `chat`, `queue`, `check`) is bound as
  additional authenticated data, so ciphertext can't be moved between fields.
  Any change to it fails decryption.
- **Key check.** Each room stores a sealed constant, so a joiner's browser can
  tell "no key" from "wrong key" before connecting.
- **Server enforcement.** An encrypted room **refuses plaintext**: plain chat,
  plain queue links, playlist import, plaintext renames and initial queue
  seeding are all rejected. An outdated or buggy client therefore fails loudly
  instead of leaking. Unencrypted rooms refuse sealed input.
- **Code:** `packages/protocol/src/e2ee.ts` (crypto, tests in
  `tests/e2ee.test.ts`), `apps/web/src/lib/room-crypto.ts` (decrypt/encrypt at
  the socket boundary), `apps/server/src/e2ee.rs` (shape validation).

## Limitations (read before relying on it)

1. **Anyone with the link can read the room.** Share it like a password. A
   person who is removed from the room still has the key and anything they
   already received. Keys are not rotated.
2. **The web app delivers its own crypto code.** A compromised SEKAI server or
   CDN could serve JavaScript that steals keys. Every browser-based E2EE system
   (for example, web versions of messengers) shares this limit. Native, signed
   apps don't.
3. **Metadata is visible to the server:** who joined, when, how many messages
   were sent (and their approximate length), and playback timing.
4. **No server-side content moderation** for encrypted rooms. Moderators can
   still delete messages and remove people.
5. **Features unavailable in encrypted rooms:** public directory listing,
   playlist import, server-fetched YouTube titles and thumbnails, @mention
   notifications parsed by the server, and Google Drive / Dropbox link
   conversion.
6. **History depends on the key.** If every member loses the link and clears
   their browser storage, the room's history can't be recovered by anyone,
   SEKAI included.

## Verification

`e2e/tests/e2ee.spec.ts` runs the real stack and asserts both sides:

- members' browsers show the plaintext room name, chat and queue, and the
  encrypted video plays in sync;
- direct SQL against Postgres finds only `e1.` ciphertext and placeholders. None
  of the room name, message text or media URL appears anywhere in the room's
  rows;
- the bare room URL shows a locked screen, and a wrong key is detected.
