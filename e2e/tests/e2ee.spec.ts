import { expect, test } from '@playwright/test';
import pg from 'pg';
import {
  copyInviteLink,
  createRoom,
  isPaused,
  joinAsGuest,
  MEDIA_URL,
  newPage,
  open,
  position,
  pressRoomKey,
  queueVideo,
  registerHost,
  sendChat,
} from './helpers';

/**
 * End-to-end encryption, verified from both sides: members read plaintext in
 * their browsers, while the database holds nothing readable for the room's
 * name, chat or queue.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ytroom:ytroom@localhost:5432/ytroom';

const ROOM_NAME = `Secret Screening ${Date.now()}`;
const SECRET_MESSAGE = 'the password is swordfish';

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

test('an encrypted room is readable by members and opaque to the server', async ({ browser }) => {
  const host = await registerHost(browser, 'Host Yuki');
  await createRoom(host, ROOM_NAME);
  const slug = new URL(host.url()).pathname.split('/').pop() ?? '';

  // The host sees the real name, marked as encrypted, and the key is not left
  // in the address bar.
  await expect(host.getByRole('heading', { level: 1 })).toContainText(ROOM_NAME);
  await expect(host.getByLabel('End-to-end encrypted')).toBeVisible();
  expect(new URL(host.url()).hash).toBe('');

  await queueVideo(host);
  await sendChat(host, SECRET_MESSAGE);
  await expect(host.getByText(SECRET_MESSAGE)).toBeVisible();

  // --- A guest with the full invite link reads everything ------------------
  const link = await copyInviteLink(host);
  expect(new URL(link).hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);

  const guest = await joinAsGuest(browser, link, 'Guest Haru');
  await expect(guest.getByRole('heading', { level: 1 })).toContainText(ROOM_NAME);
  await expect(guest.getByText(SECRET_MESSAGE)).toBeVisible();
  await guest.getByRole('tab', { name: /queue/i }).click();
  await expect(guest.getByText('sync-test.webm')).toBeVisible();

  // Encrypted queue items still play, in sync.
  if (await isPaused(host)) await pressRoomKey(host, 'k');
  await expect.poll(() => position(guest), { timeout: 20_000 }).toBeGreaterThan(2);

  // A reply from the guest arrives decrypted for the host.
  await sendChat(guest, 'see you at the credits');
  await expect(host.getByText('see you at the credits')).toBeVisible();

  // --- The database holds only ciphertext -----------------------------------
  const [room] = await query<{
    id: string;
    name: string;
    e2ee: boolean;
    meta_sealed: string;
    topic: string | null;
  }>('SELECT id, name, e2ee, meta_sealed, topic FROM rooms WHERE slug = $1', [slug]);
  expect(room?.e2ee).toBe(true);
  expect(room?.name).toBe('Encrypted room');
  expect(room?.topic).toBeNull();
  expect(room?.meta_sealed).toMatch(/^e1\./);

  const messages = await query<{ body: string; system_kind: string | null }>(
    'SELECT body, system_kind FROM chat_messages WHERE room_id = $1',
    [room?.id],
  );
  const userMessages = messages.filter((m) => m.system_kind === null);
  expect(userMessages.length).toBe(2);
  for (const m of userMessages) expect(m.body).toMatch(/^e1\./);

  const items = await query<{ source_url: string; title: string; sealed: string | null }>(
    'SELECT source_url, title, sealed FROM queue_items WHERE room_id = $1',
    [room?.id],
  );
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.source_url).toBe('https://sealed.invalid/');
    expect(item.title).toBe('Encrypted item');
    expect(item.sealed).toMatch(/^e1\./);
  }

  // Nothing readable anywhere in the room's rows.
  const everything = JSON.stringify({ room, messages, items });
  for (const secret of [
    ROOM_NAME,
    SECRET_MESSAGE,
    'swordfish',
    'credits',
    'sync-test',
    MEDIA_URL,
  ]) {
    expect(everything).not.toContain(secret);
  }
});

test('the room is locked without the key, and with the wrong one', async ({ browser }) => {
  const host = await registerHost(browser, 'Host Mei');
  await createRoom(host, 'Locked Room');
  const roomUrl = host.url();

  // The bare address (what a server log or a shoulder-surfer would see).
  const stranger = await newPage(browser);
  await open(stranger, roomUrl);
  await expect(
    stranger.getByRole('heading', { name: 'This room is end-to-end encrypted' }),
  ).toBeVisible();
  await expect(stranger.getByText('Locked Room')).toHaveCount(0);

  // A well-formed key that belongs to some other room.
  const wrong = await newPage(browser);
  await open(wrong, `${roomUrl}#k=${'A'.repeat(43)}`);
  await expect(wrong.getByRole('heading', { name: 'This link has the wrong key' })).toBeVisible();
});
