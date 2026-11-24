import { generateRoomKey } from '@playercn/protocol';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { AccountForm } from '~/components/account-form';
import { SiteHeader } from '~/components/site-header';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useSession } from '~/hooks/use-session';
import { ApiError, api } from '~/lib/api';
import { rememberRoomKey, sealNewRoom } from '~/lib/room-crypto';
import { cn } from '~/lib/utils';

export const Route = createFileRoute('/rooms/new')({
  component: NewRoomPage,
});

const CATEGORIES = [
  'general',
  'anime',
  'gaming',
  'programming',
  'music',
  'movies',
  'education',
] as const;

const VISIBILITIES = [
  ['private', 'Private', 'Link only'],
  ['unlisted', 'Unlisted', 'Not listed'],
  ['public', 'Public', 'Listed for anyone'],
] as const;

function NewRoomPage() {
  const { state } = useSession();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<string>('private');
  const [category, setCategory] = useState<string>('general');
  const [maxParticipants, setMaxParticipants] = useState(25);
  const [password, setPassword] = useState('');
  const [allowGuestQueue, setAllowGuestQueue] = useState(true);
  const [allowGuestControl, setAllowGuestControl] = useState(false);
  // On by default: the room name, chat and queue are sealed in the browser.
  const [encrypted, setEncrypted] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') {
    return (
      <main className="grid min-h-dvh place-items-center">
        <Spinner />
      </main>
    );
  }

  // Creating a room needs a real account, so this screen asks for one directly.
  // Offering "continue as guest" here — as the shared join gate does — walks
  // people into a dead end: they name themselves, sign in, and are then told
  // guests cannot own a room.
  if (state.status === 'anonymous' || state.user.kind === 'guest') {
    return <SignInToCreate guest={state.status === 'authenticated'} />;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (name.trim().length < 2) {
      setErrors({ name: 'Give the room a name of at least 2 characters.' });
      return;
    }

    setBusy(true);
    try {
      // For an encrypted room the key is made here and never sent: the server
      // receives only the sealed name and a key check.
      const key = encrypted ? generateRoomKey() : null;
      const sealedFields = key
        ? { e2ee: true, ...(await sealNewRoom(key, { name: name.trim(), topic: null })) }
        : {};
      const room = await api<{ slug: string }>('/api/rooms', {
        method: 'POST',
        body: {
          name: key ? 'Encrypted room' : name.trim(),
          ...sealedFields,
          visibility,
          category,
          maxParticipants,
          allowGuestQueue,
          allowGuestControl,
          ...(password.trim() ? { password: password.trim() } : {}),
        },
      });
      if (key) rememberRoomKey(room.slug, key);
      void navigate({ to: '/rooms/$slug', params: { slug: room.slug } });
    } catch (cause) {
      setErrors(
        cause instanceof ApiError
          ? (cause.fields ?? { name: cause.message })
          : { name: 'Could not create the room. Please try again.' },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <SiteHeader />

      <main className="mx-auto w-full max-w-lg px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Create a room</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You can change any of this later from room settings.
        </p>

        <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="room-name">Room name</Label>
            <Input
              id="room-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Friday film night"
              maxLength={60}
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <Label
              htmlFor="room-e2ee"
              className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 font-normal"
            >
              <span className="flex items-center gap-1.5 text-sm">
                <Lock className="size-3.5 text-emerald-500" />
                End-to-end encrypted
              </span>
              <span className="block text-xs text-muted-foreground">
                The room name, chat and queue are encrypted in your browser. SEKAI’s servers can’t
                read them — only people with the invite link can. Encrypted rooms can’t be listed
                publicly, and playlist import is off.
              </span>
            </Label>
            <Switch
              id="room-e2ee"
              checked={encrypted}
              onCheckedChange={(next) => {
                setEncrypted(next);
                if (next && visibility === 'public') setVisibility('private');
              }}
              className="mt-0.5 shrink-0"
            />
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Who can find it</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {VISIBILITIES.map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    'cursor-pointer rounded-md border p-2.5 transition-colors',
                    encrypted && value === 'public' && 'pointer-events-none opacity-40',
                    visibility === value
                      ? 'border-primary bg-primary/5'
                      : 'hover:border-foreground/25',
                  )}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value={value}
                    checked={visibility === value}
                    disabled={encrypted && value === 'public'}
                    onChange={() => setVisibility(value)}
                    className="sr-only"
                  />
                  <span className="block text-xs font-medium">{label}</span>
                  <span className="block text-[11px] text-muted-foreground">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="room-category">Category</Label>
              <Select value={category} onValueChange={(value) => setCategory(value ?? category)}>
                <SelectTrigger id="room-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value} className="capitalize">
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="room-max">Maximum members</Label>
              <Input
                id="room-max"
                type="number"
                min={2}
                max={100}
                value={maxParticipants}
                onChange={(event) => setMaxParticipants(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="room-password">Password</Label>
            <Input
              id="room-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Leave blank for no password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.password)}
            />
            <p className="text-xs text-muted-foreground">
              {errors.password ?? 'Optional. Anyone with the link will also need this.'}
            </p>
          </div>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-medium">What members can do</legend>
            {(
              [
                [
                  'allow-guest-queue',
                  allowGuestQueue,
                  setAllowGuestQueue,
                  'Add to the queue',
                  'Recommended — it is what makes a room feel shared.',
                ],
                [
                  'allow-guest-control',
                  allowGuestControl,
                  setAllowGuestControl,
                  'Control playback',
                  'Anyone can play, pause and seek for everyone.',
                ],
              ] as const
            ).map(([id, checked, setter, label, hint]) => (
              <div key={id} className="flex items-start justify-between gap-4">
                <Label
                  htmlFor={id}
                  className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 font-normal"
                >
                  <span className="block text-sm">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </Label>
                <Switch
                  id={id}
                  checked={checked}
                  onCheckedChange={setter}
                  className="mt-0.5 shrink-0"
                />
              </div>
            ))}
          </fieldset>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Spinner className="size-4" /> : null}
            Create room
          </Button>
        </form>
      </main>
    </div>
  );
}

/**
 * A guest can join anything but cannot own a room: an anonymous owner cannot be
 * contacted or held responsible for a public one (ADR 0007).
 */
function SignInToCreate({ guest }: { guest: boolean }) {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto grid w-full max-w-sm gap-6 px-6 py-16">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold tracking-tight">Sign in to create a room</h1>
          <p className="text-sm text-muted-foreground">
            {guest
              ? 'You are signed in as a guest, which is enough to join any room. Creating one needs an account so the room has an owner who can moderate it.'
              : 'Joining a room only needs a name, but creating one needs an account so the room has an owner who can moderate it.'}
          </p>
        </div>
        {/* Signing in updates the session, which re-renders this page as the form. */}
        <AccountForm initialMode="register" returnTo="/rooms/new" />
      </main>
    </div>
  );
}
