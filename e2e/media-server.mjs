// Serves e2e/fixtures with HTTP Range support. Browsers need ranges to seek
// inside a media file; Python's http.server does not provide them.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const port = Number(process.env.MEDIA_PORT ?? 4173);

createServer((req, res) => {
  // basename() keeps requests inside the fixtures directory.
  const file = join(root, basename(decodeURIComponent((req.url ?? '/').split('?')[0])));
  if (req.url === '/') {
    res.writeHead(200).end('ok'); // readiness probe
    return;
  }
  let size;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' };
  const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!match) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(file).pipe(res);
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  createReadStream(file, { start, end }).pipe(res);
}).listen(port, '127.0.0.1', () =>
  process.stdout.write(`media fixtures on http://127.0.0.1:${port}\n`),
);
