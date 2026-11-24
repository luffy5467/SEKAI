import type { RoomRole } from '@playercn/protocol';

/**
 * SEKAI's user-facing role names. The wire and database keep the upstream
 * values (host / cohost / member / guest); only the words people see change.
 * Members and guests share a label because their difference — whether the
 * person has an account — is not a role inside the room.
 */
export const ROLE_LABEL: Record<RoomRole, string> = {
  host: 'Host',
  cohost: 'Moderator',
  member: 'Viewer',
  guest: 'Viewer',
};
