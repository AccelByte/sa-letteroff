/** Player name rules. Names are display-only for now; later they can come from an AccelByte account. */

export const MAX_NAME_LENGTH = 20;
export const DEFAULT_PLAYER_NAME = 'Player';

/**
 * Cleans a typed name: trims, collapses runs of whitespace, drops control
 * characters and caps the length. Returns '' when nothing usable is left.
 */
export function normalizePlayerName(input: string): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** The name to show: the cleaned name, or the default when it is blank. */
export function displayName(input: string): string {
  return normalizePlayerName(input) || DEFAULT_PLAYER_NAME;
}
