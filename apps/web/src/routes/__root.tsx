import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { NotFound } from '~/components/not-found';
import { Providers } from '~/components/providers';
import { ServiceNotice } from '~/components/service-notice';
import { themeBootstrapScript } from '~/components/theme-provider';
import appCss from '~/styles/app.css?url';

/**
 * The application shell.
 *
 * Everything that must survive navigation lives here: the query cache, the
 * theme and the toaster. This is the concrete reason for a framework with real
 * layout routes — the room shell is not torn down and rebuilt when the URL
 * changes underneath it.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#08090d' },
      { title: 'SEKAI · 世界 — One world. One screen. Together.' },
      {
        name: 'description',
        content:
          'SEKAI is a private watch-party platform: create a room, invite friends with one link, and watch media you are allowed to share in perfect sync — with chat built in.',
      },
      { name: 'application-name', content: 'SEKAI' },
      { property: 'og:title', content: 'SEKAI · 世界' },
      { property: 'og:description', content: 'One world. One screen. Together.' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      // The first third-party bytes a YouTube room needs; warming these
      // removes a round trip from the critical path.
      { rel: 'preconnect', href: 'https://www.youtube.com' },
      { rel: 'preconnect', href: 'https://i.ytimg.com' },
    ],
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    // `suppressHydrationWarning` is load-bearing: the bootstrap script below
    // mutates <html> before React hydrates, so the class and data-theme
    // attributes legitimately differ from the server's markup.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Applies the stored theme before first paint. Without it every page
            load flashes the default palette before settling. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>
          <ServiceNotice />
          <Outlet />
        </Providers>
        <Scripts />
      </body>
    </html>
  );
}
