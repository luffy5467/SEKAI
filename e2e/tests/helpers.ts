import { type Browser, expect, type Page } from '@playwright/test';

export const MEDIA_URL = 'http://127.0.0.1:4173/sync-test.webm';

/** A room page — `/rooms/new` shares the prefix, so exclude it explicitly. */
export const ROOM_URL = /\/rooms\/(?!new$)[a-z0-9]+(?:-[a-z0-9]+)+$/;

export const video = (page: Page) => page.locator('video');
export const position = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
export const isPaused = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.paused);

/** Read both clocks as close together as two round trips allow. */
export async function drift(a: Page, b: Page): Promise<number> {
  const [ta, tb] = await Promise.all([position(a), position(b)]);
  return Math.abs(ta - tb);
}

/**
 * Pages are server-rendered; typing before React hydrates is lost when it
 * takes over the inputs. Wait for the page to go quiet first.
 */
export async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/** Room shortcuts are ignored while a text field has focus. */
export async function pressRoomKey(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(key);
}

/** A browser context that may use the clipboard (for "Copy link"). */
export async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  return context.newPage();
}

export async function registerHost(browser: Browser, displayName: string): Promise<Page> {
  const host = await newPage(browser);
  await open(host, '/sign-in?mode=register');
  await host.getByLabel('Display name').fill(displayName);
  await host
    .getByLabel('Email')
    .fill(`host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await host.getByLabel('Password').fill('correct-horse-battery');
  await host.getByRole('button', { name: 'Create account' }).last().click();
  await expect(host).toHaveURL(/\/rooms$/);
  return host;
}

export async function createRoom(
  host: Page,
  name: string,
  { encrypted = true }: { encrypted?: boolean } = {},
): Promise<void> {
  await open(host, '/rooms/new');
  await host.getByLabel('Room name', { exact: true }).fill(name);
  const toggle = host.getByRole('switch', { name: /end-to-end encrypted/i });
  if ((await toggle.getAttribute('aria-checked')) !== String(encrypted)) await toggle.click();
  await host.getByRole('button', { name: 'Create room' }).click();
  await expect(host).toHaveURL(ROOM_URL);
}

export async function queueVideo(host: Page, url = MEDIA_URL): Promise<void> {
  await host.getByRole('tab', { name: /queue/i }).click();
  await host.getByRole('button', { name: 'Add', exact: true }).click();
  await host.getByLabel('Address').fill(url);
  await host.getByRole('button', { name: 'Add to queue' }).click();
  await expect(video(host)).toHaveAttribute('src', /.+/, { timeout: 20_000 });
}

/** The invite link as a person gets it: from the room's "Copy link" button. */
export async function copyInviteLink(host: Page): Promise<string> {
  await host.getByRole('button', { name: /copy link/i }).click();
  return host.evaluate(() => navigator.clipboard.readText());
}

export async function joinAsGuest(browser: Browser, link: string, name: string): Promise<Page> {
  const page = await newPage(browser);
  await open(page, link);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(video(page)).toBeAttached();
  return page;
}

export async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByRole('tab', { name: /chat/i }).click();
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill(text);
  await box.press('Enter');
}
