import { api } from './api';

/** Public feature switches from `GET /api/config`. */
export interface ClientConfig {
  /** False when the API could not be reached at all (e.g. a web-only deploy). */
  reachable: boolean;
  googleSignIn: boolean;
  videoSearch: boolean;
  streamRelay: boolean;
  voiceMaxPeers: number;
}

const FALLBACK: ClientConfig = {
  reachable: false,
  googleSignIn: false,
  videoSearch: false,
  streamRelay: false,
  voiceMaxPeers: 0,
};

let pending: Promise<ClientConfig> | null = null;

/**
 * Fetched once per page load. A failure resolves to everything-off rather than
 * throwing, so a feature is only offered when the server confirms it exists.
 */
export function getClientConfig(): Promise<ClientConfig> {
  pending ??= api<Partial<ClientConfig>>('/api/config')
    .then((config) => ({ ...FALLBACK, ...config, reachable: true }))
    .catch(() => {
      pending = null; // allow a retry on the next call
      return FALLBACK;
    });
  return pending;
}
