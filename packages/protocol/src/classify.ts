/**
 * Client-side link classification, for end-to-end encrypted rooms.
 *
 * In an ordinary room the server classifies a pasted link
 * (apps/server/src/media/source.rs `classify`). In an encrypted room it can't
 * read the link, so the browser classifies it here before sealing it. The
 * rules mirror the Rust ones; keep the two in step.
 *
 * Not mirrored: Google Drive / Dropbox share-link rewriting, and playlist
 * import (the server would have to fetch the list in plaintext).
 */

import type { SealedQueueEntry } from './e2ee.ts';

export type ClassifyResult =
  | { ok: true; entry: SealedQueueEntry }
  | { ok: false; reason: 'invalid' | 'playlist' };

const PLAYLIST_EXTENSIONS = ['m3u', 'pls', 'xspf', 'asx'];

const NOT_CHANNELS = new Set([
  'directory',
  'settings',
  'downloads',
  'subscriptions',
  'wallet',
  'drops',
  'friends',
  'videos',
  'clips',
  'browse',
  'categories',
  'following',
  'messages',
  'clips-feed',
  'search',
  'about',
  'login',
  'signup',
]);

const isVideoId = (s: string) => /^[A-Za-z0-9_-]{11}$/.test(s);
const isPlainId = (s: string) => /^\d{1,20}$/.test(s);
const isChannelName = (s: string) => {
  const lower = s.toLowerCase();
  return !NOT_CHANNELS.has(lower) && /^[a-z0-9_-]{1,40}$/.test(lower);
};

/** Mirrors `util::parse_video_id`. */
export function parseYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (isVideoId(trimmed)) return trimmed;

  const bare = trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const first = (rest: string) => rest.split(/[?&#/]/)[0] ?? '';

  if (bare.startsWith('youtu.be/')) {
    const candidate = first(bare.slice('youtu.be/'.length));
    return isVideoId(candidate) ? candidate : null;
  }
  if (bare.startsWith('youtube.com/') || bare.startsWith('m.youtube.com/')) {
    const pathAndQuery = bare.slice(bare.indexOf('/') + 1);
    for (const prefix of ['embed/', 'shorts/', 'live/', 'v/']) {
      if (pathAndQuery.startsWith(prefix)) {
        const candidate = first(pathAndQuery.slice(prefix.length));
        return isVideoId(candidate) ? candidate : null;
      }
    }
    const query = pathAndQuery.split('?')[1];
    if (query) {
      for (const pair of query.split('&')) {
        if (pair.startsWith('v=')) {
          const candidate = (pair.slice(2).split('#')[0] ?? '').trim();
          return isVideoId(candidate) ? candidate : null;
        }
      }
    }
  }
  return null;
}

/** Mirrors `normalize_url`: http(s) only; a missing scheme becomes https. */
function normalizeUrl(input: string): URL | null {
  const tryParse = (text: string) => {
    try {
      return new URL(text);
    } catch {
      return null;
    }
  };
  let url = tryParse(input);
  if (!url && !input.includes('://')) {
    const host = input.split(/[/?#]/)[0] ?? '';
    const looksLikeHost =
      host.length > 0 &&
      !host.includes(' ') &&
      host.includes('.') &&
      !host.startsWith('.') &&
      !host.endsWith('.');
    if (looksLikeHost) url = tryParse(`https://${input}`);
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return null;
  }
  if (url.username || url.password) return null;
  return url;
}

function titleFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (!last) return url.hostname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Decide how a pasted link plays, entirely in the browser. */
export function classifyLink(input: string): ClassifyResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };

  const videoId = parseYouTubeId(trimmed);
  if (videoId) {
    return {
      ok: true,
      entry: {
        kind: 'youtube',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        title: 'YouTube video',
      },
    };
  }

  const url = normalizeUrl(trimmed);
  if (!url) return { ok: false, reason: 'invalid' };

  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^m\./, '');
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'twitch.tv' || host === 'player.twitch.tv') {
    if (segments.length === 2 && segments[0] === 'videos' && isPlainId(segments[1] ?? '')) {
      return {
        ok: true,
        entry: {
          kind: 'twitch',
          url: `https://www.twitch.tv/videos/${segments[1]}`,
          videoId: null,
          title: `Twitch VOD ${segments[1]}`,
        },
      };
    }
    if (segments.length === 1 && isChannelName(segments[0] ?? '')) {
      const channel = (segments[0] ?? '').toLowerCase();
      return {
        ok: true,
        entry: {
          kind: 'twitch',
          url: `https://www.twitch.tv/${channel}`,
          videoId: null,
          title: channel,
        },
      };
    }
    return { ok: false, reason: 'invalid' };
  }

  if (host === 'kick.com' || host === 'player.kick.com') {
    if (segments.length === 1 && isChannelName(segments[0] ?? '')) {
      const channel = (segments[0] ?? '').toLowerCase();
      return {
        ok: true,
        entry: { kind: 'kick', url: `https://kick.com/${channel}`, videoId: null, title: channel },
      };
    }
    return { ok: false, reason: 'invalid' };
  }

  const last = segments.at(-1) ?? '';
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  const href = url.toString();
  const title = titleFromUrl(url);

  if (ext === 'm3u8') return { ok: true, entry: { kind: 'hls', url: href, videoId: null, title } };
  if (PLAYLIST_EXTENSIONS.includes(ext)) return { ok: false, reason: 'playlist' };
  if (ext === 'mpd') return { ok: true, entry: { kind: 'dash', url: href, videoId: null, title } };
  return { ok: true, entry: { kind: 'file', url: href, videoId: null, title } };
}
