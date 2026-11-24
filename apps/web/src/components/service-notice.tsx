import { CloudOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getClientConfig } from '~/lib/client-config';

/**
 * Tells visitors plainly when the room server is unreachable — for example a
 * web-only deployment with no API behind it — instead of letting sign-in and
 * room buttons fail one by one with generic errors.
 *
 * Rendered only on the client after the check, so server HTML never shows it.
 */
export function ServiceNotice() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getClientConfig().then((config) => {
      if (!cancelled) setOffline(!config.reachable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b bg-card px-4 py-2 text-center text-xs text-muted-foreground"
    >
      <CloudOff className="size-3.5 shrink-0 text-shu" />
      <span>
        The SEKAI room server isn’t connected yet. You can look around, but signing in and rooms are
        unavailable for now.
      </span>
    </div>
  );
}
