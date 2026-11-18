import { describe, expect, it } from 'vitest';
import { createLeaderState } from './host';
import { memberState, parseLeaderState, parseMemberState, presenceOf } from './protocol';

describe('parseLeaderState', () => {
  it('round-trips a valid state', () => {
    const state = createLeaderState({ rounds: 3, roundSeconds: 60 });
    expect(parseLeaderState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each([
    ['nothing', undefined],
    ['an empty object', {}],
    ['another version', { ...createLeaderState({ rounds: 3, roundSeconds: 60 }), v: 3 }],
    [
      'unsupported rounds',
      { ...createLeaderState({ rounds: 3, roundSeconds: 60 }), settings: { rounds: 4, roundSeconds: 60 } },
    ],
    ['an unknown phase', { ...createLeaderState({ rounds: 1, roundSeconds: 30 }), phase: 'paused' }],
    ['a round past the end', { ...createLeaderState({ rounds: 1, roundSeconds: 30 }), roundIndex: 1 }],
    ['a lowercase letter', { ...createLeaderState({ rounds: 1, roundSeconds: 30 }), letter: 'a' }],
    ['missing claims', { ...createLeaderState({ rounds: 1, roundSeconds: 30 }), claims: undefined }],
    ['an unknown clock', { ...createLeaderState({ rounds: 1, roundSeconds: 30 }), clock: 'sundial' }],
    ['malformed claims', { ...createLeaderState({ rounds: 1, roundSeconds: 30 }), claims: { host: [], guest: 'x' } }],
  ])('rejects %s', (_, value) => {
    expect(parseLeaderState(value)).toBeNull();
  });

  it('rejects malformed round results', () => {
    const state = { ...createLeaderState({ rounds: 3, roundSeconds: 60 }), results: [{ letter: 'A', hostScore: -1 }] };
    expect(parseLeaderState(state)).toBeNull();
  });
});

describe('parseMemberState', () => {
  it('normalises words and names', () => {
    const parsed = parseMemberState({
      v: 4,
      name: '  Mira   Santos  ',
      roundIndex: 0,
      words: ['Apple', 'apple', ' ant ', '', 42, 'x'.repeat(41)],
      finished: false,
      seenResults: 1,
    });
    expect(parsed).toEqual({
      v: 4,
      name: 'Mira Santos',
      roundIndex: 0,
      words: ['apple', 'ant'],
      finished: false,
      seenResults: 1,
    });
  });

  it('caps long names and huge word lists', () => {
    const parsed = parseMemberState(
      memberState(
        'N'.repeat(50),
        0,
        Array.from({ length: 900 }, (_, i) => `a${i}`),
        true,
      ),
    )!;
    expect(parsed.name).toHaveLength(20);
    expect(parsed.words).toHaveLength(500);
  });

  it('rejects missing fields', () => {
    expect(parseMemberState({ v: 4, name: 'x', words: [] })).toBeNull();
    expect(parseMemberState({ v: 4, name: 'x', roundIndex: 0, words: [], finished: false })).toBeNull();
    expect(parseMemberState(null)).toBeNull();
  });
});

describe('presenceOf', () => {
  it('maps AGS member statuses', () => {
    expect(presenceOf('JOINED')).toBe('present');
    expect(presenceOf('CONNECTED')).toBe('present');
    expect(presenceOf('DISCONNECTED')).toBe('reconnecting');
    for (const s of ['LEFT', 'DROPPED', 'KICKED', 'TERMINATED', 'SOMETHING_NEW']) expect(presenceOf(s)).toBe('gone');
  });
});
