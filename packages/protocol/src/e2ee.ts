/**
 * End-to-end encryption for SEKAI rooms.
 *
 * Threat model: the SEKAI server (and its database, logs and backups) must not
 * be able to read a room's name, chat or queue. Every member's browser holds
 * the same 256-bit AES-GCM room key, which travels only in the invite link's
 * fragment (`#k=…`). Browsers never send a fragment to any server, so the key
 * never leaves the people the link was shared with.
 *
 * What this does NOT protect, by design:
 *   - Playback timing (play/pause/seek positions). The server must read these
 *     to keep everyone in sync.
 *   - Who is in a room, their display names and roles, and when they speak.
 *   - Against anyone the link is shared with, including people later removed.
 *   - Against a server that serves malicious JavaScript — the limit of every
 *     web-delivered E2EE system.
 *
 * Format: `e1.<purpose-free base64url(iv ‖ ciphertext ‖ tag)>`. The purpose
 * ("name", "chat", "queue", "check") is bound as AES-GCM additional data, so a
 * ciphertext cannot be moved from one field to another without failing to
 * decrypt. Each room has its own random key, so ciphertext from another room
 * fails too.
 *
 * Uses only WebCrypto (`globalThis.crypto.subtle`), available in every
 * supported browser and in Node ≥ 20.
 */

export const SEALED_PREFIX = 'e1.';

/** Field a ciphertext belongs to. Bound as additional authenticated data. */
export type SealPurpose = 'name' | 'chat' | 'queue' | 'check';

/** Fixed plaintext sealed into `keyCheck`, so a joiner can tell a wrong key. */
const KEY_CHECK_PLAINTEXT = 'sekai/key-check/v1';

/** Placeholder the server stores in place of an encrypted queue item's URL. */
export const SEALED_SOURCE_URL = 'https://sealed.invalid/';

const IV_BYTES = 12;
const KEY_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error('Encryption needs WebCrypto (a secure https context).');
  }
  return crypto.subtle;
}

// --- base64url -------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url.');
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- keys ------------------------------------------------------------------

/** A fresh random room key, as the base64url string that goes in the link. */
export function generateRoomKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** True for a string shaped like a room key (43 base64url chars = 32 bytes). */
export function isRoomKey(text: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return false;
  try {
    return fromBase64Url(text).length === KEY_BYTES;
  } catch {
    return false;
  }
}

export async function importRoomKey(encoded: string): Promise<CryptoKey> {
  if (!isRoomKey(encoded)) throw new Error('Invalid room key.');
  return subtle().importKey(
    'raw',
    fromBase64Url(encoded) as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

// --- seal / open -------------------------------------------------------------

export function isSealed(text: string | null | undefined): text is string {
  return typeof text === 'string' && text.startsWith(SEALED_PREFIX);
}

/** Encrypt a UTF-8 string for one field of a room. */
export async function seal(
  key: CryptoKey,
  purpose: SealPurpose,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    key,
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return SEALED_PREFIX + toBase64Url(out);
}

/**
 * Decrypt a sealed string. Throws if the key is wrong, the purpose differs, or
 * the ciphertext was altered — AES-GCM authenticates all three.
 */
export async function open(key: CryptoKey, purpose: SealPurpose, sealed: string): Promise<string> {
  if (!isSealed(sealed)) throw new Error('Not a sealed value.');
  const bytes = fromBase64Url(sealed.slice(SEALED_PREFIX.length));
  if (bytes.length < IV_BYTES + 16) throw new Error('Sealed value is truncated.');
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(purpose) },
    key,
    bytes.slice(IV_BYTES),
  );
  return decoder.decode(plaintext);
}

/** JSON convenience wrappers for structured fields (room meta, queue items). */
export async function sealJson(
  key: CryptoKey,
  purpose: SealPurpose,
  value: unknown,
): Promise<string> {
  return seal(key, purpose, JSON.stringify(value));
}

export async function openJson<T>(
  key: CryptoKey,
  purpose: SealPurpose,
  sealed: string,
): Promise<T> {
  return JSON.parse(await open(key, purpose, sealed)) as T;
}

/** The value stored as a room's `keyCheck`. */
export function makeKeyCheck(key: CryptoKey): Promise<string> {
  return seal(key, 'check', KEY_CHECK_PLAINTEXT);
}

/** Whether `key` is this room's key, judged against the stored `keyCheck`. */
export async function verifyKeyCheck(key: CryptoKey, keyCheck: string): Promise<boolean> {
  try {
    return (await open(key, 'check', keyCheck)) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

// --- sealed payload shapes ---------------------------------------------------

/** Encrypted room metadata. */
export interface SealedRoomMeta {
  name: string;
  topic: string | null;
}

/** Encrypted queue item: everything that would reveal what is being watched. */
export interface SealedQueueEntry {
  kind: 'youtube' | 'file' | 'hls' | 'dash' | 'twitch' | 'kick';
  url: string;
  videoId: string | null;
  title: string;
}

// --- invite links -------------------------------------------------------------

/** Read `k=<key>` from a URL fragment such as `#k=abc…`. */
export function keyFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const key = params.get('k');
  return key && isRoomKey(key) ? key : null;
}

/** An invite link that carries the key in its fragment. */
export function inviteLink(roomUrl: string, key: string): string {
  const base = roomUrl.split('#')[0];
  return `${base}#k=${key}`;
}
