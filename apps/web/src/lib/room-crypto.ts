import {
  type ChatMessage,
  type ClientMessage,
  classifyLink,
  importRoomKey,
  isRoomKey,
  isSealed,
  keyFromFragment,
  type MediaSource,
  makeKeyCheck,
  open,
  openJson,
  type QueueItem,
  type RoomSnapshot,
  type SealedQueueEntry,
  type SealedRoomMeta,
  type ServerMessage,
  seal,
  sealJson,
  verifyKeyCheck,
} from '@playercn/protocol';
import { createContext, useContext } from 'react';

/**
 * The browser half of end-to-end encrypted rooms.
 *
 * Decryption happens at the socket boundary: every server message passes
 * through `decryptIncoming` before it reaches the room store, and every
 * outgoing chat message or queue link through `encryptOutgoing`. Components
 * therefore render plaintext without knowing a room is encrypted, and nothing
 * readable is ever sent for an encrypted room. See packages/protocol/src/e2ee.ts
 * for the format and threat model.
 */

const STORAGE_PREFIX = 'sekai:room-key:';

/** Shown where a value exists but could not be decrypted (tampered or wrong key). */
export const UNREADABLE = '🔒 Couldn’t decrypt this';

// --- key storage ---------------------------------------------------------------

function readStored(slug: string): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_PREFIX + slug);
    return value && isRoomKey(value) ? value : null;
  } catch {
    return null; // storage blocked (private mode); the link still works this visit
  }
}

function store(slug: string, key: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + slug, key);
  } catch {
    /* see readStored */
  }
}

export function forgetRoomKey(slug: string): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + slug);
  } catch {
    /* see readStored */
  }
}

/**
 * The key for this room: from the invite link's fragment if present (then
 * remembered on this device and removed from the address bar, so it does not
 * show in screenshots or screen shares), otherwise from this device's storage.
 */
export function takeRoomKey(slug: string): string | null {
  if (typeof window === 'undefined') return null;
  const fromLink = keyFromFragment(window.location.hash);
  if (fromLink) {
    store(slug, fromLink);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', pathname + search);
    return fromLink;
  }
  return readStored(slug);
}

export function rememberRoomKey(slug: string, key: string): void {
  store(slug, key);
}

// --- the cipher ----------------------------------------------------------------

export type KeyStatus = 'missing' | 'wrong' | 'ok';

export class RoomCipher {
  readonly #key: CryptoKey;
  readonly encodedKey: string;
  /** Sealed text → decrypted promise. Ciphertext is immutable, so this never goes stale. */
  readonly #cache = new Map<string, Promise<string | null>>();

  private constructor(key: CryptoKey, encodedKey: string) {
    this.#key = key;
    this.encodedKey = encodedKey;
  }

  /** Check `encodedKey` against the room's key check before trusting it. */
  static async create(
    encodedKey: string | null,
    keyCheck: string | null,
  ): Promise<{ status: KeyStatus; cipher: RoomCipher | null }> {
    if (!encodedKey) return { status: 'missing', cipher: null };
    try {
      const key = await importRoomKey(encodedKey);
      if (!keyCheck || !(await verifyKeyCheck(key, keyCheck))) {
        return { status: 'wrong', cipher: null };
      }
      return { status: 'ok', cipher: new RoomCipher(key, encodedKey) };
    } catch {
      return { status: 'wrong', cipher: null };
    }
  }

  #open(purpose: 'name' | 'chat' | 'queue', sealed: string): Promise<string | null> {
    const cacheKey = `${purpose}:${sealed}`;
    let pending = this.#cache.get(cacheKey);
    if (!pending) {
      pending = open(this.#key, purpose, sealed).catch(() => null);
      this.#cache.set(cacheKey, pending);
    }
    return pending;
  }

  // ----- incoming ------------------------------------------------------------

  async openRoom(room: RoomSnapshot): Promise<RoomSnapshot> {
    if (!room.e2ee || !room.metaSealed) return room;
    const text = await this.#open('name', room.metaSealed);
    if (text === null) return { ...room, name: UNREADABLE, topic: null };
    try {
      const meta = JSON.parse(text) as SealedRoomMeta;
      return { ...room, name: meta.name, topic: meta.topic };
    } catch {
      return { ...room, name: UNREADABLE, topic: null };
    }
  }

  async openChat(message: ChatMessage): Promise<ChatMessage> {
    // System lines (joins, role changes) are written by the server in plaintext.
    if (message.system || !isSealed(message.body)) return message;
    const body = await this.#open('chat', message.body);
    return { ...message, body: body ?? UNREADABLE };
  }

  /** The real source of a sealed item, or the placeholder if it can't be opened. */
  async openSource(source: MediaSource): Promise<{ source: MediaSource; title: string | null }> {
    if (!source.sealed) return { source, title: null };
    const text = await this.#open('queue', source.sealed);
    if (text === null) return { source, title: UNREADABLE };
    try {
      const entry = JSON.parse(text) as SealedQueueEntry;
      return {
        source: { kind: entry.kind, url: entry.url, videoId: entry.videoId, sealed: source.sealed },
        title: entry.title,
      };
    } catch {
      return { source, title: UNREADABLE };
    }
  }

  async openQueueItem(item: QueueItem): Promise<QueueItem> {
    if (!item.source.sealed) return item;
    const { source, title } = await this.openSource(item.source);
    return { ...item, source, title: title ?? item.title };
  }

  async decryptIncoming(message: ServerMessage): Promise<ServerMessage> {
    switch (message.t) {
      case 'ready': {
        const [room, timelineSource, queue, recentMessages, pinnedMessages] = await Promise.all([
          this.openRoom(message.room),
          message.timeline.source ? this.openSource(message.timeline.source) : null,
          Promise.all(message.queue.map((item) => this.openQueueItem(item))),
          Promise.all(message.recentMessages.map((m) => this.openChat(m))),
          Promise.all(message.pinnedMessages.map((m) => this.openChat(m))),
        ]);
        return {
          ...message,
          room,
          timeline: timelineSource
            ? { ...message.timeline, source: timelineSource.source }
            : message.timeline,
          queue,
          recentMessages,
          pinnedMessages,
        };
      }
      case 'timeline': {
        if (!message.timeline.source) return message;
        const { source } = await this.openSource(message.timeline.source);
        return { ...message, timeline: { ...message.timeline, source } };
      }
      case 'queue_updated':
        return {
          ...message,
          items: await Promise.all(message.items.map((item) => this.openQueueItem(item))),
        };
      case 'chat_message':
        return { ...message, message: await this.openChat(message.message) };
      case 'chat_pinned':
        return { ...message, message: await this.openChat(message.message) };
      case 'room_updated':
        return { ...message, room: await this.openRoom(message.room) };
      default:
        return message;
    }
  }

  // ----- outgoing ------------------------------------------------------------

  /**
   * Seal what must not leave the browser readable. Returns `null` (and
   * reports why) for something an encrypted room cannot accept.
   */
  async encryptOutgoing(
    message: ClientMessage,
    onRefused: (reason: string) => void,
  ): Promise<ClientMessage | null> {
    if (message.t === 'chat_send') {
      return { ...message, body: await seal(this.#key, 'chat', message.body) };
    }
    if (message.t === 'queue_add') {
      const classified = classifyLink(message.url);
      if (!classified.ok) {
        onRefused(
          classified.reason === 'playlist'
            ? 'Playlist import isn’t available in end-to-end encrypted rooms. Add items one by one.'
            : 'That is not a link this room can play.',
        );
        return null;
      }
      return {
        t: 'queue_add_sealed',
        sealed: await sealJson(this.#key, 'queue', classified.entry),
        ...(message.playNext !== undefined ? { playNext: message.playNext } : {}),
      };
    }
    if (message.t === 'queue_import') {
      onRefused('Playlist import isn’t available in end-to-end encrypted rooms.');
      return null;
    }
    return message;
  }

  sealMeta(meta: SealedRoomMeta): Promise<string> {
    return sealJson(this.#key, 'name', meta);
  }
}

/** Seal metadata with a fresh key, for room creation. */
export async function sealNewRoom(
  encodedKey: string,
  meta: SealedRoomMeta,
): Promise<{ metaSealed: string; keyCheck: string }> {
  const key = await importRoomKey(encodedKey);
  const [metaSealed, keyCheck] = await Promise.all([
    sealJson(key, 'name', meta),
    makeKeyCheck(key),
  ]);
  return { metaSealed, keyCheck };
}

/** Decrypt sealed metadata outside a live room (e.g. the join screen). */
export async function openMeta(
  encodedKey: string,
  metaSealed: string,
): Promise<SealedRoomMeta | null> {
  try {
    return await openJson<SealedRoomMeta>(await importRoomKey(encodedKey), 'name', metaSealed);
  } catch {
    return null;
  }
}

/** The open room's cipher, or null for an unencrypted room. */
export const RoomCipherContext = createContext<RoomCipher | null>(null);

export function useRoomCipherContext(): RoomCipher | null {
  return useContext(RoomCipherContext);
}
