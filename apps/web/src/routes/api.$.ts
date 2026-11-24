import { createFileRoute } from '@tanstack/react-router';
import { handleApiProxy } from '~/server/api-proxy';

/**
 * `/api/**` on the web origin → the SEKAI API (see src/server/api-proxy.ts).
 * Server-only: the handler and its environment are never sent to browsers.
 * Local development bypasses this through the Vite dev proxy in vite.config.ts.
 */
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      ANY: ({ request }) => handleApiProxy(request),
    },
  },
});
