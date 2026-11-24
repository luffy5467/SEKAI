import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Generate the synthetic test video (2 min, VP8/WebM, no audio) on first run.
 * Generated rather than committed: it is a few MB of binary that ffmpeg makes
 * deterministically. VP8 because Playwright's Chromium ships without H.264.
 */
export default function globalSetup() {
  const out = fileURLToPath(new URL('./fixtures/sync-test.webm', import.meta.url));
  if (existsSync(out)) return;
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25',
      '-t',
      '120',
      '-c:v',
      'libvpx',
      '-b:v',
      '400k',
      '-g',
      '25',
      out,
    ],
    { stdio: 'inherit' },
  );
}
