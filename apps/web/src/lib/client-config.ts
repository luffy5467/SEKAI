import { api } from './api';

/** Public feature switches from `GET /api/config`. */
export interface ClientConfig {
  googleSignIn: boolean;
  videoSearch: boolean;
  streamRelay: boolean;
  voiceMaxPeers: number;
}

const FALLBACK: ClientConfig = {
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
    .then((config) => ({ ...FALLBACK, ...config }))
    .catch(() => {
      pending = null; // allow a retry on the next call
      return FALLBACK;
    });
  return pending;
}
