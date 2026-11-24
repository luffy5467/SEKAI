import { createFileRoute, Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Crown,
  Link2,
  ListVideo,
  Lock,
  MessageSquare,
  MonitorPlay,
  RefreshCw,
} from 'lucide-react';
import { BRAND, Emblem, Logo } from '~/components/brand/logo';
import { SiteHeader } from '~/components/site-header';
import { Button } from '~/components/ui/button';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

/**
 * The landing page.
 *
 * Server-rendered and almost entirely static: the only motion is CSS, so the
 * page is readable before any JavaScript arrives. Every claim here describes
 * something the product does today.
 */
function LandingPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />

      <main>
        {/* ---------------------------------------------------------------- Hero */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute top-[-12rem] left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-fuji/10 blur-[120px]"
          />
          <div className="relative mx-auto w-full max-w-5xl px-6 pt-16 pb-16 sm:pt-24">
            <div className="sekai-rise mx-auto max-w-3xl text-center">
              <p className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
                <span lang="ja" className="font-jp text-foreground">
                  {BRAND.nameJa}
                </span>
                <span aria-hidden className="h-3 w-px bg-border" />
                Watch parties for people who live far apart
              </p>

              <h1 className="mt-7 text-[2.6rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl md:text-7xl">
                One world. One screen.
                <br />
                <span className="text-shu">Together.</span>
              </h1>

              <p className="mx-auto mt-6 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
                Open a private room, send one link, and everyone watches the same second — with chat
                and a shared queue built in.
              </p>

              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button render={<Link to="/rooms/new" />} size="lg" className="w-full sm:w-auto">
                  Create a room
                  <ArrowRight className="size-4" />
                </Button>
                <Button
                  render={<Link to="/rooms" />}
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  Browse public rooms
                </Button>
              </div>
            </div>

            <div className="sekai-rise sekai-delay-2 mt-14 sm:mt-20">
              <RoomPreview />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ Features */}
        <section id="features" className="scroll-mt-16 border-t py-20 sm:py-24">
          <div className="mx-auto w-full max-w-5xl px-6">
            <SectionHeading
              eyebrow="Features"
              title="Built for the film, not the meeting."
              body="Everything a watch night needs, and nothing between you and the screen."
            />
            <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="group bg-background p-7 transition-colors hover:bg-card"
                >
                  <Icon className="size-5 text-shu transition-transform duration-300 group-hover:-translate-y-0.5" />
                  <h3 className="mt-5 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm text-pretty text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- How it works */}
        <section className="border-t bg-card/40 py-20 sm:py-24">
          <div className="mx-auto w-full max-w-5xl px-6">
            <SectionHeading
              eyebrow="How it works"
              title="From invite to opening credits in a minute."
            />
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-2xl border bg-background p-7">
                  <span className="font-mono text-sm text-fuji">0{index + 1}</span>
                  <h3 className="mt-4 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm text-pretty text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------- Sources */}
        <section className="border-t py-20 sm:py-24">
          <div className="mx-auto w-full max-w-5xl px-6">
            <SectionHeading
              eyebrow="Sources"
              title="Bring what you’re allowed to share."
              body="SEKAI doesn’t host a film catalogue. You choose the source, and every viewer’s browser plays it directly."
            />
            <ul className="mx-auto mt-12 grid max-w-3xl gap-3 sm:grid-cols-2">
              {SOURCES.map((source) => (
                <li key={source.title} className="rounded-xl border p-5">
                  <p className="font-medium">{source.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{source.body}</p>
                </li>
              ))}
            </ul>
            <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-pretty text-muted-foreground">
              Quality follows the source: 1080p, 1440p or 4K play when the source, browser, device
              and connection all support them. A 4K stream typically needs 15–25 Mbps for every
              viewer.
            </p>
          </div>
        </section>

        {/* ----------------------------------------------------------------- CTA */}
        <section className="border-t py-20 sm:py-24">
          <div className="mx-auto w-full max-w-5xl px-6">
            <div className="relative overflow-hidden rounded-3xl border bg-card px-6 py-16 text-center sm:px-16">
              <span
                lang="ja"
                aria-hidden
                className="pointer-events-none absolute -top-10 -right-6 font-jp text-[11rem] leading-none font-bold text-foreground/[0.03] select-none sm:text-[14rem]"
              >
                {BRAND.nameJa}
              </span>
              <h2 className="relative text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Tonight’s screening starts with a link.
              </h2>
              <p className="relative mx-auto mt-4 max-w-md text-pretty text-muted-foreground">
                Create a free account, open a room and send the invite. Friends join with just a
                name.
              </p>
              <Button render={<Link to="/rooms/new" />} size="lg" className="relative mt-8">
                Get started
                <Link2 className="size-4" />
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs">
            <Logo />
            <p className="mt-3 text-sm text-muted-foreground">{BRAND.tagline}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Play only media you own or have permission to share.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:items-end">
            <span lang="ja" className="font-jp">
              ひとつの世界、ひとつのスクリーン。
            </span>
            <span>
              Built on{' '}
              <a
                href="https://github.com/ttherealdev/playercn"
                className="underline underline-offset-2 hover:text-foreground"
                rel="noopener noreferrer"
                target="_blank"
              >
                playercn
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-semibold tracking-[0.25em] text-shu uppercase">{eyebrow}</p>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
      {body ? <p className="mt-4 text-pretty text-muted-foreground">{body}</p> : null}
    </div>
  );
}

/**
 * A decorative illustration of a room, hidden from assistive technology —
 * the copy around it carries the meaning. The skyline is drawn for SEKAI.
 */
function RoomPreview() {
  const viewers = [
    { initial: 'A', color: '#e63946' },
    { initial: 'R', color: '#8b5cf6' },
    { initial: 'M', color: '#3fa7d6' },
    { initial: 'K', color: '#e9b44c' },
  ];
  const chat = [
    { who: 'Ren', color: '#a78bfa', text: 'this soundtrack 🔥' },
    { who: 'Mina', color: '#5fbfe6', text: 'wait, rewind 10s?' },
    { who: 'Aiko', color: '#f0606b', text: 'done — synced for everyone' },
  ];

  return (
    <div aria-hidden className="relative mx-auto w-full max-w-4xl select-none">
      <div className="absolute -inset-x-8 -top-8 bottom-0 -z-10 rounded-[40px] bg-shu/10 blur-3xl" />
      <div className="overflow-hidden rounded-2xl border bg-card shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs">
          <span className="flex items-center gap-2 font-medium">
            <span className="size-2 rounded-full bg-shu" />
            Friday Night Cinema
          </span>
          <span className="text-muted-foreground">4 watching</span>
        </div>
        <div className="grid md:grid-cols-[1fr_210px]">
          <div className="relative aspect-video overflow-hidden bg-black">
            <svg
              viewBox="0 0 640 360"
              preserveAspectRatio="xMidYMid slice"
              className="absolute inset-0 size-full"
            >
              <defs>
                <linearGradient id="sekai-sky" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#120f22" />
                  <stop offset="0.65" stopColor="#1a1030" />
                  <stop offset="1" stopColor="#2a0f1c" />
                </linearGradient>
              </defs>
              <rect width="640" height="360" fill="url(#sekai-sky)" />
              <circle cx="470" cy="96" r="30" fill="#e63946" opacity="0.9" />
              <path
                fill="#0c0b14"
                d="M0 360V250h30v-30h22v40h18v-70h26v80h20v-50h34v60h16v-110h10v-20h8v20h10v110h24v-40h30v50h22v-90h40v100h18v-60h28v60h26v-130h8v-14h6v14h8v130h20v-70h34v70h26v-50h22v60h30v-80h28v90h24v-40h22v-30h20v170z"
              />
              <g fill="#e63946" opacity="0.55">
                <rect x="236" y="172" width="3" height="3" />
                <rect x="244" y="190" width="3" height="3" />
                <rect x="460" y="176" width="3" height="3" />
              </g>
              <g fill="#8b5cf6" opacity="0.6">
                <rect x="364" y="200" width="3" height="3" />
                <rect x="110" y="214" width="3" height="3" />
                <rect x="560" y="226" width="3" height="3" />
              </g>
            </svg>
            <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur">
              <span className="size-1.5 rounded-full bg-emerald-400" /> In sync
            </span>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pt-10 pb-3">
              <div className="h-1 overflow-hidden rounded-full bg-white/15">
                <div className="sekai-progress h-full rounded-full bg-shu" />
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-white/80">
                <span>0:41:07 / 2:01:44</span>
                <span className="rounded bg-white/10 px-1.5 font-medium">1080p</span>
              </div>
            </div>
          </div>
          <div className="hidden flex-col border-l md:flex">
            <div className="flex -space-x-2 border-b px-4 py-3">
              {viewers.map((viewer) => (
                <span
                  key={viewer.initial}
                  className="flex size-7 items-center justify-center rounded-full border-2 border-card text-[11px] font-semibold text-white"
                  style={{ background: viewer.color }}
                >
                  {viewer.initial}
                </span>
              ))}
            </div>
            <div className="flex flex-1 flex-col justify-end gap-2.5 p-4 text-xs">
              {chat.map((message, index) => (
                <p
                  key={message.text}
                  className="sekai-chat leading-snug"
                  style={{ animationDelay: `${0.8 + index * 0.9}s` }}
                >
                  <span className="font-semibold" style={{ color: message.color }}>
                    {message.who}
                  </span>{' '}
                  {message.text}
                </p>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
              <Emblem className="size-4 text-foreground" /> Room 7KQ-2MX
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: RefreshCw,
    title: 'Server-timed sync',
    body: 'The server owns the timeline. Play, pause and seek land for everyone, late joiners drop into the right second, and small drift is smoothed instead of jumping.',
  },
  {
    icon: Lock,
    title: 'Private rooms',
    body: 'Invite-only by default, with optional room passwords. Access is checked on the server for every action — not just hidden in the interface.',
  },
  {
    icon: Crown,
    title: 'Host, moderators, viewers',
    body: 'The host decides who can drive playback, promotes moderators they trust, and names who inherits the room.',
  },
  {
    icon: MessageSquare,
    title: 'Live room chat',
    body: 'React in the moment, mention friends, pin the important bits. Moderators can remove messages.',
  },
  {
    icon: ListVideo,
    title: 'A shared queue',
    body: 'Line up the night together. Drag to reorder, vote to skip, and the next item starts on its own.',
  },
  {
    icon: MonitorPlay,
    title: 'A real player',
    body: 'Keyboard shortcuts, picture-in-picture, fullscreen, playback speed — and quality selection when the source offers renditions.',
  },
] as const;

const STEPS = [
  {
    title: 'Open a room',
    body: 'Name it, choose who can find it, optionally set a password.',
  },
  {
    title: 'Send the link',
    body: 'Friends open it and join with just a name — no account needed to watch.',
  },
  {
    title: 'Press play — together',
    body: 'Add something you’re allowed to share. Your controls drive every screen in the room.',
  },
] as const;

const SOURCES = [
  {
    title: 'Video files',
    body: 'MP4, WebM and other formats your browser can decode, from a direct link.',
  },
  {
    title: 'Streams',
    body: 'HLS (.m3u8) and DASH (.mpd), with quality levels when the stream has them.',
  },
  { title: 'YouTube', body: 'Videos, shorts and live streams through YouTube’s own player.' },
  { title: 'Twitch & Kick', body: 'Live channels and VODs through their official embeds.' },
] as const;
