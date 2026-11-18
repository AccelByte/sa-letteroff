/**
 * Browser storage for the player's name. (Match history is saved through
 * src/net/profile: AGS Cloud Save, or localStorage in mock mode.) localStorage can
 * be missing, full or blocked (private windows, strict privacy settings), so
 * every call is guarded and reports failure instead of throwing.
 */
import { MAX_NAME_LENGTH } from '../game/player';

export const STORAGE_KEYS = { playerName: 'letteroff:player-name' } as const;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false if the value could not be saved. */
function write(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadPlayerName(): string {
  return (read(STORAGE_KEYS.playerName) ?? '').slice(0, MAX_NAME_LENGTH * 2);
}

export function savePlayerName(name: string): boolean {
  return write(STORAGE_KEYS.playerName, name || null);
}
