import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AccountForm } from '~/components/account-form';
import { SiteHeader } from '~/components/site-header';
import { useSession } from '~/hooks/use-session';

export interface SignInSearch {
  mode?: 'signin' | 'register';
  returnTo?: string;
}

/** Only same-site paths, so the page can never be used as an open redirect. */
function safeReturnTo(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/rooms';
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    mode: search.mode === 'register' ? 'register' : 'signin',
    returnTo: safeReturnTo(search.returnTo),
  }),
  component: SignInPage,
});

function SignInPage() {
  const { mode, returnTo } = Route.useSearch();
  const { state } = useSession();
  const navigate = useNavigate();
  const destination = returnTo ?? '/rooms';

  // Already signed in with a full account: nothing to do here.
  useEffect(() => {
    if (state.status === 'authenticated' && state.user.kind !== 'guest') {
      void navigate({ to: destination });
    }
  }, [state, navigate, destination]);

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto grid w-full max-w-sm place-items-center px-6 py-16">
        <h1 className="mb-6 self-start text-2xl font-semibold tracking-tight">
          {mode === 'register' ? 'Create your account' : 'Welcome back'}
        </h1>
        <AccountForm
          initialMode={mode ?? 'signin'}
          returnTo={destination}
          onDone={() => void navigate({ to: destination })}
        />
      </main>
    </div>
  );
}
