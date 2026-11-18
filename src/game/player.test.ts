import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYER_NAME, MAX_NAME_LENGTH, displayName, normalizePlayerName } from './player';

describe('normalizePlayerName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizePlayerName('  Mira   A \t ')).toBe('Mira A');
  });

  it('drops control characters', () => {
    expect(normalizePlayerName('Mi\u0000ra\u0007')).toBe('Mira');
  });

  it('caps the length without splitting characters', () => {
    expect(normalizePlayerName('x'.repeat(40))).toHaveLength(MAX_NAME_LENGTH);
    const emoji = normalizePlayerName('😀'.repeat(30));
    expect([...emoji]).toHaveLength(MAX_NAME_LENGTH);
  });

  it('keeps non-Latin names', () => {
    expect(normalizePlayerName('Ádítya')).toBe('Ádítya');
  });
});

describe('displayName', () => {
  it('falls back to the default for blank names', () => {
    expect(displayName('   ')).toBe(DEFAULT_PLAYER_NAME);
    expect(displayName('Mira')).toBe('Mira');
  });
});
