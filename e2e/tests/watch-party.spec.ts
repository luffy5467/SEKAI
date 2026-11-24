import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * The product's core promise, exercised through the real UI and the real
 * server: an account holder creates a private room, friends join through the
 * link, and every player follows the host's play / pause / seek.
 */

const MEDIA_URL = 'http://127.0.0.1:4173/sync-test.webm';

/** A room page — `/rooms/new` shares the prefix, so exclude it explicitly. */
const ROOM_URL = /\/rooms\/(?!new$)[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** Wall-clock position difference SEKAI must hold between two viewers (s). */
const SYNC_TOLERANCE = 0.4;

const video = (page: Page) => page.locator('video');
const position = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const isPaused = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.paused);

/** Read both clocks as close together as two round trips allow. */
async function drift(a: Page, b: Page): Promise<number> {
  const [ta, tb] = await Promise.all([position(a), position(b)]);
  return Math.abs(ta - tb);
}

/**
 * Pages are server-rendered; typing before React hydrates is lost when it
 * takes over the inputs. Wait for the page to go quiet first.
 */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/** Room shortcuts are ignored while a text field has focus. */
async function pressRoomKey(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(key);
}

async function joinAsGuest(browser: Browser, roomUrl: string, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, roomUrl);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(video(page)).toBeAttached();
  return page;
}

test('host creates a room, guests join by link and stay in sync', async ({ browser }) => {
  // --- Host: register with email + password -------------------------------
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  const email = `host-${Date.now()}@example.test`;

  await open(host, '/sign-in?mode=register');
  await host.getByLabel('Display name').fill('Host Aiko');
  await host.getByLabel('Email').fill(email);
  await host.getByLabel('Password').fill('correct-horse-battery');
  await host.getByRole('button', { name: 'Create account' }).last().click();
  await expect(host).toHaveURL(/\/rooms$/);

  // --- Host: create a private room ----------------------------------------
  await open(host, '/rooms/new');
  await host.getByLabel('Room name').fill('E2E Screening');
  await host.getByRole('button', { name: 'Create room' }).click();
  await expect(host).toHaveURL(ROOM_URL);
  const roomUrl = host.url();

  // --- Host: queue a direct video -----------------------------------------
  await host.getByRole('tab', { name: /queue/i }).click();
  await host.getByRole('button', { name: 'Add', exact: true }).click();
  await host.getByLabel('Address').fill(MEDIA_URL);
  await host.getByRole('button', { name: 'Add to queue' }).click();
  await expect(video(host)).toHaveAttribute('src', /.+/, { timeout: 20_000 });

  // --- Guest joins through the link ---------------------------------------
  const guest = await joinAsGuest(browser, roomUrl, 'Guest Ren');

  // Make sure the room is playing, whatever state the first item started in.
  if (await isPaused(host)) await pressRoomKey(host, 'k');
  await expect.poll(() => position(guest), { timeout: 20_000 }).toBeGreaterThan(3);
  await expect.poll(() => isPaused(guest)).toBe(false);

  // --- Playing: positions converge ----------------------------------------
  await expect.poll(() => drift(host, guest), { timeout: 15_000 }).toBeLessThan(SYNC_TOLERANCE);

  // --- Host pauses: the guest pauses at the same frame --------------------
  await pressRoomKey(host, 'k');
  await expect.poll(() => isPaused(guest), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => drift(host, guest), { timeout: 5_000 }).toBeLessThan(SYNC_TOLERANCE);

  // --- Host seeks forward while paused ------------------------------------
  const before = await position(host);
  await pressRoomKey(host, 'l');
  await expect.poll(() => position(guest), { timeout: 5_000 }).toBeGreaterThan(before + 5);
  await expect.poll(() => drift(host, guest), { timeout: 5_000 }).toBeLessThan(SYNC_TOLERANCE);

  // --- Host resumes --------------------------------------------------------
  await pressRoomKey(host, 'k');
  await expect.poll(() => isPaused(guest), { timeout: 5_000 }).toBe(false);

  // --- A late joiner lands on the current position, not at zero -----------
  await host.waitForTimeout(3_000);
  const late = await joinAsGuest(browser, roomUrl, 'Late Mina');
  await expect.poll(() => position(late), { timeout: 15_000 }).toBeGreaterThan(before + 5);
  await expect.poll(() => drift(host, late), { timeout: 15_000 }).toBeLessThan(SYNC_TOLERANCE);
});

test('a guest cannot drive playback in a default room', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await open(host, '/sign-in?mode=register');
  await host.getByLabel('Display name').fill('Host Kai');
  await host.getByLabel('Email').fill(`host2-${Date.now()}@example.test`);
  await host.getByLabel('Password').fill('correct-horse-battery');
  await host.getByRole('button', { name: 'Create account' }).last().click();
  await expect(host).toHaveURL(/\/rooms$/);

  await open(host, '/rooms/new');
  await host.getByLabel('Room name').fill('Permissions Check');
  await host.getByRole('button', { name: 'Create room' }).click();
  await expect(host).toHaveURL(ROOM_URL);
  await host.getByRole('tab', { name: /queue/i }).click();
  await host.getByRole('button', { name: 'Add', exact: true }).click();
  await host.getByLabel('Address').fill(MEDIA_URL);
  await host.getByRole('button', { name: 'Add to queue' }).click();
  await expect(video(host)).toHaveAttribute('src', /.+/, { timeout: 20_000 });
  if (await isPaused(host)) await pressRoomKey(host, 'k');
  await expect.poll(() => position(host), { timeout: 20_000 }).toBeGreaterThan(2);

  const guest = await joinAsGuest(browser, host.url(), 'Guest Sora');
  await expect.poll(() => isPaused(guest), { timeout: 20_000 }).toBe(false);

  // The guest's pause intent must be refused by the server: the room keeps playing.
  await pressRoomKey(guest, 'k');
  await guest.waitForTimeout(2_000);
  expect(await isPaused(host)).toBe(false);
  expect(await isPaused(guest)).toBe(false);
});
