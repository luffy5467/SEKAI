import { expect, test } from '@playwright/test';
import {
  copyInviteLink,
  createRoom,
  drift,
  isPaused,
  joinAsGuest,
  position,
  pressRoomKey,
  queueVideo,
  registerHost,
} from './helpers';

/**
 * The product's core promise, exercised through the real UI and the real
 * server: an account holder creates a room, friends join through the link,
 * and every player follows the host's play / pause / seek.
 */

/** Wall-clock position difference SEKAI must hold between two viewers (s). */
const SYNC_TOLERANCE = 0.4;

test('host creates a room, guests join by link and stay in sync', async ({ browser }) => {
  const host = await registerHost(browser, 'Host Aiko');
  await createRoom(host, 'E2E Screening');
  await queueVideo(host);
  const link = await copyInviteLink(host);

  const guest = await joinAsGuest(browser, link, 'Guest Ren');

  // Make sure the room is playing, whatever state the first item started in.
  if (await isPaused(host)) await pressRoomKey(host, 'k');
  await expect.poll(() => position(guest), { timeout: 20_000 }).toBeGreaterThan(3);
  await expect.poll(() => isPaused(guest)).toBe(false);

  // Playing: positions converge.
  await expect.poll(() => drift(host, guest), { timeout: 15_000 }).toBeLessThan(SYNC_TOLERANCE);

  // Host pauses: the guest pauses at the same frame.
  await pressRoomKey(host, 'k');
  await expect.poll(() => isPaused(guest), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => drift(host, guest), { timeout: 5_000 }).toBeLessThan(SYNC_TOLERANCE);

  // Host seeks forward while paused.
  const before = await position(host);
  await pressRoomKey(host, 'l');
  await expect.poll(() => position(guest), { timeout: 5_000 }).toBeGreaterThan(before + 5);
  await expect.poll(() => drift(host, guest), { timeout: 5_000 }).toBeLessThan(SYNC_TOLERANCE);

  // Host resumes.
  await pressRoomKey(host, 'k');
  await expect.poll(() => isPaused(guest), { timeout: 5_000 }).toBe(false);

  // A late joiner lands on the current position, not at zero.
  await host.waitForTimeout(3_000);
  const late = await joinAsGuest(browser, link, 'Late Mina');
  await expect.poll(() => position(late), { timeout: 15_000 }).toBeGreaterThan(before + 5);
  await expect.poll(() => drift(host, late), { timeout: 15_000 }).toBeLessThan(SYNC_TOLERANCE);
});

test('a guest cannot drive playback (unencrypted room)', async ({ browser }) => {
  const host = await registerHost(browser, 'Host Kai');
  await createRoom(host, 'Permissions Check', { encrypted: false });
  await queueVideo(host);
  if (await isPaused(host)) await pressRoomKey(host, 'k');
  await expect.poll(() => position(host), { timeout: 20_000 }).toBeGreaterThan(2);

  // An unencrypted room's link is just its address.
  const guest = await joinAsGuest(browser, host.url(), 'Guest Sora');
  await expect.poll(() => isPaused(guest), { timeout: 20_000 }).toBe(false);

  // The guest's pause intent must be refused by the server: the room keeps playing.
  await pressRoomKey(guest, 'k');
  await guest.waitForTimeout(2_000);
  expect(await isPaused(host)).toBe(false);
  expect(await isPaused(guest)).toBe(false);
});
