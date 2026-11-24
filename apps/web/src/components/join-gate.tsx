import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { Spinner } from '~/components/ui/spinner';
import { useSession } from '~/hooks/use-session';
import { ApiError } from '~/lib/api';
import { getClientConfig } from '~/lib/client-config';

/**
 * The sign-in wall.
 *
 * Guest sign-in is first and needs nothing but a name: requiring an account to
 * *join* a room would defeat the point of sharing one link. Account sign-in
 * (email, and Google when the server has it configured) is offered alongside.
 */
export function JoinGate({
  onJoined,
  title = 'Choose a name',
  description = 'This is how everyone in the room will see you.',
}: {
  onJoined: () => void;
  title?: string;
  description?: string;
}) {
  const { signInAsGuest, signInWithGoogle } = useSession();
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getClientConfig().then((config) => {
      if (!cancelled) setGoogle(config.googleSignIn);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const here =
    typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = displayName.trim();

    if (trimmed.length < 2 || trimmed.length > 32) {
      setError('Use between 2 and 32 characters.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await signInAsGuest(trimmed);
      onJoined();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 429
          ? 'Too many sign-ins from this network. Please wait a few minutes and try again.'
          : 'Could not sign you in. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              autoFocus
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Sam"
              maxLength={32}
              autoComplete="nickname"
              aria-invalid={Boolean(error)}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Spinner className="size-4" /> : null}
            Continue as guest
          </Button>
        </form>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">or</span>
          <Separator className="flex-1" />
        </div>

        <Button
          variant="outline"
          className="w-full"
          render={<Link to="/sign-in" search={{ mode: 'signin', returnTo: here }} />}
        >
          Sign in with email
        </Button>
        {google ? (
          <Button variant="outline" className="w-full" onClick={() => signInWithGoogle(here)}>
            Continue with Google
          </Button>
        ) : null}
      </div>
    </main>
  );
}
