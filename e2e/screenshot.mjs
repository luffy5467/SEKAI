// Dev helper: capture key pages at desktop and phone width.
// Usage: node e2e/screenshot.mjs <outDir> [label]
import { chromium } from '@playwright/test';

const out = process.argv[2];
const label = process.argv[3] ?? 'shot';
const pages = ['/', '/rooms', '/sign-in?mode=register', '/rooms/new', '/nope'];
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

const browser = await chromium.launch();
for (const [name, viewport] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport });
  for (const path of pages) {
    await page.goto(`http://localhost:3000${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    const slug = path === '/' ? 'home' : path.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    await page.screenshot({ path: `${out}/${label}-${name}-${slug}.png`, fullPage: name === 'desktop' && path === '/' });
  }
  await page.close();
}
await browser.close();
