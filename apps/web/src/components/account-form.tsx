import { useEffect, useId, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { useSession } from '~/hooks/use-session';
import { ApiError } from '~/lib/api';
import { getClientConfig } from '~/lib/client-config';

type Mode = 'signin' | 'register';

/**
 * Email + password sign-in and registration, plus Google when the server has
 * it configured. Used on /sign-in and inline wherever an account is required.
 */
export function AccountForm({
  initialMode = 'signin',
  returnTo,
  onDone,
}: {
  initialMode?: Mode;
  /** Where Google should send the browser back to. */
  returnTo: string;
  onDone?: () => void;
}) {
  const { signInWithPassword, register, signInWithGoogle } = useSession();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  const id = useId();

  useEffect(() => {
    let cancelled = false;
    void getClientConfig().then((config) => {
      if (!cancelled) setGoogle(config.googleSignIn);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    const local: Record<string, string> = {};
    if (!email.trim()) local.email = 'Enter your email address.';
    if (mode === 'register' && password.length < 10) local.password = 'Use at least 10 characters.';
    if (mode === 'signin' && !password) local.password = 'Enter your password.';
    if (mode === 'register' && displayName.trim().length < 2)
      local.displayName = 'Use at least 2 characters.';
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }

    setBusy(true);
    try {
      if (mode === 'register') await register(email, password, displayName);
      else await signInWithPassword(email, password);
      onDone?.();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setErrors(cause.fields ?? { form: cause.message });
      } else {
        setErrors({ form: 'Something went wrong. Please try again.' });
      }
    } finally {
      setBusy(false);
    }
  }

  const field = (key: string) => `${id}-${key}`;

  return (
    <div className="w-full space-y-5">
      <div
        role="tablist"
        aria-label="Account"
        className="grid grid-cols-2 rounded-lg bg-muted p-1 text-sm"
      >
        {(
          [
            ['signin', 'Sign in'],
            ['register', 'Create account'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setErrors({});
            }}
            className={
              mode === value
                ? 'rounded-md bg-background px-3 py-1.5 font-medium shadow-sm'
                : 'rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        {mode === 'register' ? (
          <div className="space-y-1.5">
            <Label htmlFor={field('name')}>Display name</Label>
            <Input
              id={field('name')}
              autoComplete="nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={32}
              aria-invalid={Boolean(errors.displayName)}
            />
            {errors.displayName ? (
              <p className="text-xs text-destructive">{errors.displayName}</p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor={field('email')}>Email</Label>
          <Input
            id={field('email')}
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            aria-invalid={Boolean(errors.email)}
          />
          {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={field('password')}>Password</Label>
          <Input
            id={field('password')}
            type="password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={128}
            aria-invalid={Boolean(errors.password)}
          />
          {mode === 'register' && !errors.password ? (
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          ) : null}
          {errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}
        </div>

        {errors.form ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.form}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      {google ? (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="outline" className="w-full" onClick={() => signInWithGoogle(returnTo)}>
            Continue with Google
          </Button>
        </>
      ) : null}
    </div>
  );
}
