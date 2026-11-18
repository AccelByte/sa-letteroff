/**
 * Two controllers play each other through one shared in-memory mock backend,
 * with fake timers, to check the whole online flow end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dictionary } from '../game/dictionary';
import { ALPHABET } from '../game/letters';
import { type LeaderState, type MemberState, type OnlineSettings, parseLeaderState } from '../game/online/protocol';
import { BackendError, type BackendEvent } from '../net/backend';
import { matchTotals } from '../game/scoring';
import { MockBackend } from '../net/mock/mockBackend';
import { type MockStore, createMemoryStore } from '../net/mock/store';
import { OnlineMatchController } from './controller';

// Ten words for every letter: "a0word" .. "a9word".
const dict = new Dictionary([
  ALPHABET.flatMap((l) => Array.from({ length: 10 }, (_, i) => `${l.toLowerCase()}${i}word`)),
]);
const w = (letter: string, i: number) => `${letter.toLowerCase()}${i}word`;

let store: MockStore;
const controllers: OnlineMatchController[] = [];
const backends: MockBackend[] = [];

/** A mock backend on a slow connection: each read returns what was there when it was sent, `latencyMs` later. */
class SlowBackend extends MockBackend {
  readLatencyMs = 0;
  noServerClock = false;
  /** Member storage writes hang (a stalled connection). */
  stallMemberWrites = false;
  writeLatencyMs = 0;
  override async writeMemberStorage(...args: Parameters<MockBackend['writeMemberStorage']>) {
    if (this.stallMemberWrites) return new Promise<void>(() => undefined);
    if (this.writeLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeLatencyMs));
    this.memberWrites.push(structuredClone(args[2]));
    return super.writeMemberStorage(...args);
  }
  /** Delay before each leader storage write lands, and how many leader writes to fail. */
  leaderWriteLatencyMs = 0;
  failLeaderWrites = 0;
  leaderWrites: LeaderState[] = [];
  memberWrites: MemberState[] = [];
  /** Drop storage notifications (and every other session hint) while true. */
  dropNotifications = false;
  override async writeLeaderStorage(sessionId: string, data: LeaderState) {
    if (this.leaderWriteLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.leaderWriteLatencyMs));
    if (this.failLeaderWrites > 0) {
      this.failLeaderWrites--;
      throw new BackendError('network', 'Network error: simulated');
    }
    this.leaderWrites.push(structuredClone(data));
    return super.writeLeaderStorage(sessionId, data);
  }
  override subscribe(listener: (event: BackendEvent) => void) {
    return super.subscribe((event) => {
      if (this.dropNotifications && event.type === 'session-changed') return;
      listener(event);
    });
  }
  override async getSession(sessionId: string) {
    const snapshot = await super.getSession(sessionId);
    if (this.readLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readLatencyMs));
    return snapshot;
  }
  override async serverTime() {
    if (this.noServerClock) throw new Error('no clock');
    return super.serverTime();
  }
}

interface PlayerOptions {
  /** Delay on every session read. */
  latencyMs?: number;
  /** Delay before each member storage write lands. */
  writeLatencyMs?: number;
  /** How wrong this machine's clock is. */
  clockSkewMs?: number;
  /** The backend clock can't be read. */
  noServerClock?: boolean;
}

function player(userId: string, name: string, options: PlayerOptions = {}) {
  const backend = new SlowBackend({ store, userId, heartbeatMs: 1000, disconnectAfterMs: 3000, dropAfterMs: 8000 });
  backend.readLatencyMs = options.latencyMs ?? 0;
  backend.writeLatencyMs = options.writeLatencyMs ?? 0;
  backend.noServerClock = options.noServerClock ?? false;
  const skew = options.clockSkewMs ?? 0;
  const controller = new OnlineMatchController({
    backend,
    dictionary: dict,
    playerName: name,
    pollMs: 500,
    ticketPollMs: 500,
    now: () => Date.now() + skew,
  });
  backends.push(backend);
  controllers.push(controller);
  return { backend, c: controller, s: () => controller.getState() };
}

async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) await vi.advanceTimersByTimeAsync(100);
}

async function until(check: () => boolean, label: string, maxMs = 15_000) {
  for (let t = 0; t < maxMs; t += 100) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function roomWithTwoPlayers(
  settings: OnlineSettings = { rounds: 3, roundSeconds: 30 },
  options: { host?: PlayerOptions; guest?: PlayerOptions } = {},
) {
  const host = player('host', 'Hana', options.host);
  const guest = player('guest', 'Gus', options.guest);
  await host.c.start();
  await guest.c.start();
  // Drive the fake timers while these run: a slow backend's reads wait on timers.
  void host.c.createRoom(settings);
  await until(() => !!host.s().code && !host.s().busy, 'room created');
  const code = host.s().code!;
  void guest.c.joinByCode(code);
  await until(() => guest.s().role === 'guest' && !guest.s().busy, 'joined');
  await until(
    () => host.s().opponent?.presence === 'present' && guest.s().opponent?.presence === 'present',
    'both present',
  );
  return { host, guest, code };
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createMemoryStore();
});

afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  backends.splice(0).forEach((b) => b.dispose());
  vi.useRealTimers();
});

describe('online match (mock backend)', () => {
  it('sets up a room: code, roles, names and settings', async () => {
    const { host, guest, code } = await roomWithTwoPlayers();
    expect(code).toMatch(/^[0-9A-Z]{6}$/);
    expect(host.s()).toMatchObject({ stage: 'room', role: 'host', settings: { rounds: 3, roundSeconds: 30 } });
    expect(guest.s()).toMatchObject({ stage: 'room', role: 'guest', settings: { rounds: 3, roundSeconds: 30 } });
    expect(host.s().opponent!.name).toBe('Gus');
    expect(guest.s().opponent!.name).toBe('Hana');
  });

  it('plays a full 3-round match with live words, each word owned once, and mirrored results', async () => {
    const { host, guest } = await roomWithTwoPlayers();
    const letters: string[] = [];

    // ---- Round 1: both finish early ----
    await host.c.startNextRound();
    await until(() => guest.s().stage === 'countdown', 'guest countdown');
    expect(guest.s().letter).toBeNull(); // the letter stays hidden during the countdown
    expect(guest.c.submitWord('anything')).toMatchObject({ reason: 'not-started' });
    await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'round 1 playing');
    const l1 = host.s().letter!;
    expect(guest.s().letter).toBe(l1);
    letters.push(l1);

    expect(host.c.submitWord(w(l1, 0))).toEqual({ ok: true, word: w(l1, 0) });
    expect(host.c.submitWord(w(l1, 1))).toEqual({ ok: true, word: w(l1, 1) });
    // The guest hasn't seen the host's words yet, so these go to the host as claims.
    expect(guest.c.submitWord(w(l1, 1))).toEqual({ ok: true, word: w(l1, 1), pending: true });
    expect(guest.c.submitWord(w(l1, 2))).toEqual({ ok: true, word: w(l1, 2), pending: true });
    expect(guest.s().pendingWords).toEqual([w(l1, 1), w(l1, 2)]);
    expect(guest.c.submitWord(`${l1.toLowerCase()}zzzz`)).toMatchObject({ ok: false, reason: 'not-a-word' });
    await until(() => host.s().opponentWords.length === 1 && guest.s().opponentWords.length === 2, 'live words');
    // The host played l1-1 first, so the guest's claim is turned down; l1-2 is the guest's.
    expect(host.s().opponentWords).toEqual([w(l1, 2)]);
    await until(() => guest.s().pendingWords.length === 0, 'guest claims decided');
    expect(guest.s()).toMatchObject({
      myWords: [w(l1, 1), w(l1, 2)],
      takenWords: [w(l1, 1)],
      lostWord: { word: w(l1, 1) },
      opponentWords: [w(l1, 0), w(l1, 1)],
    });
    // Now that the guest can see the host's words, they are refused straight away.
    expect(guest.c.submitWord(w(l1, 0))).toMatchObject({ ok: false, reason: 'taken' });
    expect(guest.c.submitWord(w(l1, 1))).toMatchObject({ ok: false, reason: 'taken' });
    // And the host can't take the guest's word.
    expect(host.c.submitWord(w(l1, 2))).toMatchObject({ ok: false, reason: 'taken' });

    host.c.finishAnswering();
    await until(() => guest.s().opponentFinished, 'guest sees host finished');
    expect(host.s().stage).toBe('playing'); // still waiting for the guest
    guest.c.finishAnswering();
    await until(() => host.s().stage === 'round-over' && guest.s().stage === 'round-over', 'round 1 over');
    expect(host.s().results[0]).toMatchObject({
      letter: l1,
      playerWords: [w(l1, 0), w(l1, 1)],
      botWords: [w(l1, 2)],
      shared: [],
      playerScore: 2,
      botScore: 1,
    });
    expect(guest.s().results[0]).toMatchObject({ playerScore: 1, botScore: 2 });

    // Only the host can start rounds.
    await guest.c.startNextRound();
    await advance(500);
    expect(guest.s().stage).toBe('round-over');

    // ---- Round 2: time runs out ----
    await host.c.startNextRound();
    await until(() => guest.s().stage === 'playing', 'round 2 playing');
    const l2 = guest.s().letter!;
    letters.push(l2);
    guest.c.submitWord(w(l2, 3));
    guest.c.submitWord(w(l2, 4));
    host.c.submitWord(w(l2, 5));
    await advance(29_000);
    expect(host.s().stage).toBe('playing');
    await until(() => host.s().stage === 'round-over', 'round 2 over by time', 5000);
    expect(host.s().results[1]).toMatchObject({ letter: l2, playerScore: 1, botScore: 2 });
    await until(() => guest.s().stage === 'round-over', 'guest round 2 over');
    // A word sent after the round ended doesn't count.
    expect(guest.c.submitWord(w(l2, 6))).toBeNull();

    // ---- Round 3: guest finishes, host runs out of time ----
    await host.c.startNextRound();
    await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'round 3 playing');
    const l3 = host.s().letter!;
    letters.push(l3);
    host.c.submitWord(w(l3, 7));
    guest.c.submitWord(w(l3, 7)); // too late: the host already has it
    guest.c.finishAnswering();
    await until(() => host.s().stage === 'finished' && guest.s().stage === 'finished', 'match finished', 40_000);

    expect(new Set(letters).size).toBe(3);
    const hostTotals = matchTotals(host.s().results);
    const guestTotals = matchTotals(guest.s().results);
    expect(hostTotals).toEqual({ player: 4, bot: 3, winner: 'player' });
    expect(guestTotals).toEqual({ player: 3, bot: 4, winner: 'bot' });
    expect(host.s().results[2]).toMatchObject({ playerWords: [w(l3, 7)], botWords: [], shared: [] });
    expect(host.s().results.map((r) => r.letter)).toEqual(letters);
  });

  describe('same word from both players at nearly the same time', () => {
    async function playingRound() {
      const players = await roomWithTwoPlayers({ rounds: 1, roundSeconds: 30 });
      await players.host.c.startNextRound();
      await until(() => players.host.s().stage === 'playing' && players.guest.s().stage === 'playing', 'round playing');
      return { ...players, l: players.host.s().letter! };
    }

    /** Both sides agree on exactly one owner, during the round and in the result. */
    async function expectOneOwner(
      host: ReturnType<typeof player>,
      guest: ReturnType<typeof player>,
      word: string,
      owner: 'host' | 'guest',
    ) {
      await until(
        () => guest.s().pendingWords.length === 0 && host.s().opponentWords.length + guest.s().opponentWords.length > 0,
        'decided',
      );
      const hostHas = !host.s().opponentWords.includes(word) && host.s().myWords.includes(word);
      const guestHas = guest.s().myWords.includes(word) && !guest.s().takenWords.includes(word);
      expect({ hostHas, guestHas }).toEqual({ hostHas: owner === 'host', guestHas: owner === 'guest' });
      expect(guest.s().opponentWords.includes(word)).toBe(owner === 'host');
      host.c.finishAnswering();
      guest.c.finishAnswering();
      await until(() => host.s().stage === 'finished' && guest.s().stage === 'finished', 'finished');
      const [hostResult] = host.s().results;
      const [guestResult] = guest.s().results;
      expect(hostResult!.shared).toEqual([]);
      expect(hostResult!.playerWords.includes(word)).toBe(owner === 'host');
      expect(hostResult!.botWords.includes(word)).toBe(owner === 'guest');
      expect(guestResult!.playerWords).toEqual(hostResult!.botWords);
      expect(guestResult!.playerScore + guestResult!.botScore).toBe(1);
    }

    it("goes to the host when the host plays it before the guest's claim arrives", async () => {
      const { host, guest, l } = await playingRound();
      // Same instant: the guest's claim is still on its way when the host types the word.
      expect(guest.c.submitWord(w(l, 3))).toMatchObject({ ok: true, pending: true });
      expect(host.c.submitWord(w(l, 3))).toEqual({ ok: true, word: w(l, 3) });
      await until(() => guest.s().takenWords.includes(w(l, 3)), 'guest told it was taken');
      expect(guest.s().lostWord).toMatchObject({ word: w(l, 3) });
      await expectOneOwner(host, guest, w(l, 3), 'host');
    });

    it("goes to the guest when the guest's claim reaches the host first", async () => {
      const { host, guest, l } = await playingRound();
      guest.c.submitWord(w(l, 4));
      // The claim reaches the host (one storage write and a notification), but the host's screen
      // hasn't caught up with the guest's word when it types the same one.
      await until(() => host.s().opponentWords.includes(w(l, 4)), 'host has the claim');
      expect(host.c.submitWord(w(l, 4))).toMatchObject({ ok: false, reason: 'taken' });
      await expectOneOwner(host, guest, w(l, 4), 'guest');
    });

    it('never lets both have it, whatever the timing', async () => {
      const { host, guest, l } = await playingRound();
      guest.c.submitWord(w(l, 5));
      // Let the guest's write land in storage, but only a fraction of the host's poll interval pass.
      await vi.advanceTimersByTimeAsync(1);
      const result = host.c.submitWord(w(l, 5));
      // Whichever way it went, there is exactly one owner and both players agree.
      await expectOneOwner(host, guest, w(l, 5), result?.ok ? 'host' : 'guest');
    });
  });

  describe('round timing', () => {
    /** Steps 20 ms at a time and records when each player's screen first showed the letter. */
    async function revealTimes(host: ReturnType<typeof player>, guest: ReturnType<typeof player>) {
      const seen: { host?: number; guest?: number } = {};
      for (let t = 0; t < 10_000 && (seen.host === undefined || seen.guest === undefined); t += 20) {
        if (seen.host === undefined && host.s().stage === 'playing') seen.host = Date.now();
        if (seen.guest === undefined && guest.s().stage === 'playing') seen.guest = Date.now();
        await vi.advanceTimersByTimeAsync(20);
      }
      return seen as { host: number; guest: number };
    }

    it('reveals the letter on both screens at the same moment, even on a slow connection', async () => {
      // Every update takes the guest about a second to see.
      const { host, guest } = await roomWithTwoPlayers({ rounds: 1, roundSeconds: 30 }, { guest: { latencyMs: 900 } });
      await host.c.startNextRound();
      const seen = await revealTimes(host, guest);
      expect(Math.abs(seen.guest - seen.host)).toBeLessThanOrEqual(40); // two 20 ms test steps
      expect(guest.s().letter).toBe(host.s().letter);
      expect(Math.abs(guest.s().timeLeftMs - host.s().timeLeftMs)).toBeLessThanOrEqual(220);
      // The guest can play straight away; its claim is decided once the host has it.
      const word = w(guest.s().letter!, 0);
      expect(guest.c.submitWord(word)).toMatchObject({ ok: true, pending: true });
      await until(() => host.s().opponentWords.includes(word), 'host accepts the claim');
      await until(() => guest.s().pendingWords.length === 0, 'guest sees it accepted');
      expect(guest.s().takenWords).toEqual([]);
    });

    it("doesn't depend on the players' own clocks being right", async () => {
      const { host, guest } = await roomWithTwoPlayers(
        { rounds: 1, roundSeconds: 30 },
        { host: { clockSkewMs: -4000 }, guest: { clockSkewMs: 7000, latencyMs: 300 } },
      );
      await host.c.startNextRound();
      const seen = await revealTimes(host, guest);
      expect(Math.abs(seen.guest - seen.host)).toBeLessThanOrEqual(40);
      await advance(10_000);
      expect(Math.abs(guest.s().timeLeftMs - host.s().timeLeftMs)).toBeLessThanOrEqual(220);
    });

    it('still plays the round if the server clock is unavailable (guest times it from when it sees it)', async () => {
      const { host, guest } = await roomWithTwoPlayers(
        { rounds: 1, roundSeconds: 30 },
        { host: { noServerClock: true }, guest: { latencyMs: 300 } },
      );
      await host.c.startNextRound();
      await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'both playing');
      expect(guest.s().letter).toBe(host.s().letter);
      host.c.finishAnswering();
      guest.c.finishAnswering();
      await until(() => host.s().stage === 'finished' && guest.s().stage === 'finished', 'finished');
    });
  });

  describe('between rounds', () => {
    /** Steps 20 ms at a time until `check` passes; returns how long that took. */
    async function msUntil(check: () => boolean, maxMs = 10_000) {
      const start = Date.now();
      for (let t = 0; t < maxMs; t += 20) {
        if (check()) return Date.now() - start;
        await vi.advanceTimersByTimeAsync(20);
      }
      throw new Error('never happened');
    }

    async function playToTimeUp(options: { guest?: PlayerOptions } = {}) {
      const players = await roomWithTwoPlayers({ rounds: 3, roundSeconds: 30 }, options);
      const { host, guest } = players;
      await host.c.startNextRound();
      await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'playing');
      const word = w(guest.s().letter!, 0);
      await until(() => host.s().timeLeftMs <= 500, 'nearly time up', 40_000);
      guest.c.submitWord(word); // a word in the last half second still counts
      await until(() => host.s().timeLeftMs === 0, 'time up');
      return { ...players, word };
    }

    it("shows both players the result soon after time runs out, without waiting out the host's grace period", async () => {
      const { host, guest, word } = await playToTimeUp({ guest: { latencyMs: 300 } });
      const hostMs = await msUntil(() => host.s().stage === 'round-over');
      const guestMs = await msUntil(() => guest.s().stage === 'round-over');
      expect(hostMs).toBeLessThan(1000); // was 1.5 s + a read before
      expect(hostMs + guestMs).toBeLessThan(1500);
      expect(guest.s().results[0]!.playerWords).toEqual([word]);
    });

    it('waits for the guest to have the result before starting the next countdown', async () => {
      // The guest's "I have the result" write takes 600 ms to land.
      const { host, guest } = await playToTimeUp({ guest: { latencyMs: 300, writeLatencyMs: 600 } });
      await until(() => host.s().stage === 'round-over', 'host round over');
      let guestSawSummary = false;
      await host.c.startNextRound(); // straight away
      expect(host.s()).toMatchObject({ stage: 'round-over', startQueued: true });
      await until(() => {
        if (guest.s().stage === 'round-over') guestSawSummary = true;
        return guest.s().stage === 'countdown';
      }, 'guest countdown');
      expect(guestSawSummary).toBe(true);
      expect(host.s().startQueued).toBe(false);
      await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'round 2 playing');
      expect(guest.s().roundIndex).toBe(1);
    });

    it("doesn't wait for the guest forever if its updates stop arriving", async () => {
      const { host, guest } = await playToTimeUp();
      (guest.backend as SlowBackend).stallMemberWrites = true;
      await until(() => host.s().stage === 'round-over', 'host round over', 6000);
      await host.c.startNextRound();
      const ms = await msUntil(() => host.s().stage === 'countdown');
      expect(ms).toBeLessThanOrEqual(3200);
    });
  });

  describe('Start and Finish', () => {
    it('starts exactly one round however often Start is pressed while the write is slow', async () => {
      const { host, guest } = await roomWithTwoPlayers({ rounds: 3, roundSeconds: 30 });
      host.backend.leaderWriteLatencyMs = 800;
      const writesBefore = host.backend.leaderWrites.length;
      // Rapid clicks / repeated Enter on the Start button.
      for (let i = 0; i < 5; i++) void host.c.startNextRound();
      // The host shows the countdown straight away, before the write lands.
      expect(host.s()).toMatchObject({ stage: 'countdown', roundIndex: 0 });
      await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'playing');
      const countdowns = host.backend.leaderWrites.slice(writesBefore).filter((l) => l.phase === 'countdown');
      expect(
        new Set(countdowns.map((l) => `${l.roundIndex}:${l.letter}:${l.countdownEndsAt}:${l.roundEndsAt}`)).size,
      ).toBe(1);
      expect(countdowns[0]!.roundIndex).toBe(0);
      expect(guest.s().letter).toBe(host.s().letter);
      // Pressing Start during the round does nothing.
      void host.c.startNextRound();
      await advance(1000);
      expect(host.s().roundIndex).toBe(0);
    });

    it('a failed countdown write is retried with the same letter and deadline', async () => {
      const { host, guest } = await roomWithTwoPlayers({ rounds: 3, roundSeconds: 30 });
      host.backend.failLeaderWrites = 1;
      await host.c.startNextRound();
      expect(host.s()).toMatchObject({ stage: 'countdown', error: expect.stringContaining("Couldn't reach") });
      const shown = host.s().letter; // null during the countdown
      await until(() => host.s().stage === 'playing' && guest.s().stage === 'playing', 'playing after retry');
      const stored = parseLeaderState((await host.backend.getSession(host.s().sessionId!)).leaderStorage)!;
      const firstCountdown = host.backend.leaderWrites.find((l) => l.phase === 'countdown')!;
      expect(stored.letter).toBe(firstCountdown.letter);
      expect(stored.roundEndsAt).toBe(firstCountdown.roundEndsAt);
      expect(guest.s().letter).toBe(host.s().letter);
      expect(shown).toBeNull();
      expect(host.backend.leaderWrites.filter((l) => l.phase === 'countdown')).toHaveLength(1);
      // Once the retry worked, the error goes away.
      expect(host.s().error).toBeNull();
    });

    it('Finish pressed repeatedly marks the player finished once', async () => {
      const { host, guest } = await roomWithTwoPlayers({ rounds: 1, roundSeconds: 30 });
      await host.c.startNextRound();
      await until(() => guest.s().stage === 'playing', 'playing');
      const before = guest.backend.memberWrites.length;
      for (let i = 0; i < 4; i++) guest.c.finishAnswering();
      await advance(500);
      const finishedWrites = guest.backend.memberWrites.slice(before).filter((m) => m.finished);
      expect(finishedWrites.length).toBe(1);
      expect(guest.s().myFinished).toBe(true);
      expect(guest.s().error).toBeNull();
    });
  });

  describe('rapid word entry (guest)', () => {
    async function playing() {
      const players = await roomWithTwoPlayers({ rounds: 3, roundSeconds: 30 });
      await players.host.c.startNextRound();
      await until(() => players.host.s().stage === 'playing' && players.guest.s().stage === 'playing', 'playing');
      return { ...players, l: players.guest.s().letter! };
    }

    it('shows a valid word as pending immediately, keeps both words when a second one is sent mid-write', async () => {
      const { host, guest, l } = await playing();
      guest.backend.writeLatencyMs = 600;
      let renders = 0;
      const unsubscribe = guest.c.subscribe(() => renders++);
      expect(guest.c.submitWord(w(l, 1))).toMatchObject({ ok: true, pending: true });
      // Pending on the very next state update, before any network round trip.
      expect(renders).toBeGreaterThan(0);
      expect(guest.s()).toMatchObject({ pendingWords: [w(l, 1)], myWords: [w(l, 1)] });
      await advance(100); // first write still in flight
      expect(guest.c.submitWord(w(l, 2))).toMatchObject({ ok: true, pending: true });
      expect(guest.s().pendingWords).toEqual([w(l, 1), w(l, 2)]);
      await until(() => host.s().opponentWords.length === 2, 'host has both');
      await until(() => guest.s().pendingWords.length === 0, 'both decided');
      expect(host.s().opponentWords).toEqual([w(l, 1), w(l, 2)]);
      expect(guest.s()).toMatchObject({ myWords: [w(l, 1), w(l, 2)], takenWords: [] });
      // The writer batched: the last write carries both words.
      expect(guest.backend.memberWrites.at(-1)!.words).toEqual([w(l, 1), w(l, 2)]);
      unsubscribe();
    });

    it('repeated Enter on the same word sends one claim', async () => {
      const { host, guest, l } = await playing();
      expect(guest.c.submitWord(w(l, 3))).toMatchObject({ ok: true, pending: true });
      expect(guest.c.submitWord(w(l, 3))).toMatchObject({ ok: false, reason: 'already-used' });
      expect(guest.c.submitWord(w(l, 3))).toMatchObject({ ok: false, reason: 'already-used' });
      await until(() => guest.s().pendingWords.length === 0, 'decided');
      expect(host.s().opponentWords).toEqual([w(l, 3)]);
    });

    it('separates the confirmed count from words still pending', async () => {
      const { guest, l } = await playing();
      guest.backend.writeLatencyMs = 800;
      guest.c.submitWord(w(l, 1));
      guest.c.submitWord(w(l, 2));
      expect(guest.s().confirmedCount).toBe(0);
      expect(guest.s().pendingWords).toHaveLength(2);
      await until(() => guest.s().pendingWords.length === 0, 'decided');
      expect(guest.s().confirmedCount).toBe(2);
    });

    it('ignores a late copy of the previous round and of another session', async () => {
      const { host, guest, l } = await playing();
      const oldSnapshot = await guest.backend.getSession(guest.s().sessionId!);
      guest.c.submitWord(w(l, 4));
      await until(() => guest.s().pendingWords.length === 0, 'decided');
      host.c.finishAnswering();
      guest.c.finishAnswering();
      await until(() => host.s().stage === 'round-over' && guest.s().stage === 'round-over', 'round over');
      await host.c.startNextRound();
      await until(() => guest.s().stage === 'playing' && guest.s().roundIndex === 1, 'round 2');
      const l2 = guest.s().letter!;
      guest.c.submitWord(w(l2, 0));
      await until(() => guest.s().pendingWords.length === 0, 'decided round 2');
      // A stale read from round 1 arrives late, and a notification for some other session.
      const emit = (e: BackendEvent) =>
        (guest.backend as unknown as { events: { emit(e: BackendEvent): void } }).events.emit(e);
      (guest.c as unknown as { applySnapshot(s: unknown): void }).applySnapshot(oldSnapshot);
      emit({
        type: 'session-changed',
        sessionId: 'other',
        storage: { kind: 'leader', userId: 'host', data: oldSnapshot.leaderStorage },
      });
      expect(guest.s()).toMatchObject({ roundIndex: 1, stage: 'playing', letter: l2, myWords: [w(l2, 0)] });
      expect(guest.s().opponentWords).toEqual([]);
    });

    it('converges by polling when storage notifications are missed', async () => {
      const { host, guest, l } = await playing();
      host.backend.dropNotifications = true;
      guest.backend.dropNotifications = true;
      guest.c.submitWord(w(l, 5));
      await until(() => guest.s().pendingWords.length === 0, 'decided by polling', 5000);
      expect(host.s().opponentWords).toEqual([w(l, 5)]);
    });
  });

  it('rejects a word typed after this player finished answering', async () => {
    const { host, guest } = await roomWithTwoPlayers({ rounds: 1, roundSeconds: 30 });
    await host.c.startNextRound();
    await until(() => guest.s().stage === 'playing', 'playing');
    const l = guest.s().letter!;
    guest.c.finishAnswering();
    expect(guest.c.submitWord(w(l, 0))).toMatchObject({ reason: 'round-over' });
  });

  it('ends the match for the other player when someone leaves mid-match', async () => {
    const { host, guest } = await roomWithTwoPlayers();
    await host.c.startNextRound();
    await until(() => guest.s().stage === 'playing', 'playing');
    await guest.c.leave();
    expect(guest.s().stage).toBe('menu');
    await until(() => host.s().stage === 'ended', 'host sees guest leave');
    expect(host.s().endReason).toBe('opponent-left');
  });

  it('ends the match when the opponent disconnects and does not come back', async () => {
    const { host, guest } = await roomWithTwoPlayers();
    await host.c.startNextRound();
    await until(() => host.s().stage === 'playing', 'playing');
    // The guest's tab goes away without leaving: heartbeats stop.
    guest.c.dispose();
    guest.backend.dispose();
    await until(() => host.s().opponent?.presence === 'reconnecting', 'reconnecting');
    expect(host.s().stage).toBe('playing');
    await until(() => host.s().stage === 'ended', 'dropped', 20_000);
    expect(host.s().endReason).toBe('opponent-left');
  });

  it('keeps the room open if the guest leaves before the first round', async () => {
    const { host, guest, code } = await roomWithTwoPlayers();
    await guest.c.leave();
    await until(() => host.s().opponent?.presence === 'gone', 'guest gone');
    expect(host.s().stage).toBe('room');
    const second = player('second', 'Sam');
    await second.c.start();
    await second.c.joinByCode(code);
    await until(() => host.s().opponent?.name === 'Sam' && host.s().opponent?.presence === 'present', 'new guest');
  });

  it('ends the room for the guest if the host leaves', async () => {
    const { host, guest } = await roomWithTwoPlayers();
    await host.c.leave();
    await until(() => guest.s().stage === 'ended', 'guest sees host leave');
    expect(guest.s().endReason).toBe('opponent-left');
  });

  it('shows a readable error for a wrong code', async () => {
    const p = player('p', 'P');
    await p.c.start();
    await p.c.joinByCode('ZZZZZZ');
    expect(p.s()).toMatchObject({ stage: 'menu', error: 'No room has that code. Check it and try again.' });
  });

  it('Quick match pairs two players into a 3 x 1 min match hosted by the first in the queue', async () => {
    const a = player('a', 'Ann');
    const b = player('b', 'Bob');
    await a.c.start();
    await b.c.start();
    await a.c.quickMatch();
    expect(a.s().stage).toBe('matchmaking');
    await b.c.quickMatch();
    await until(() => a.s().stage === 'room' && b.s().stage === 'room', 'both in room');
    expect(a.s().sessionId).toBe(b.s().sessionId);
    expect(a.s().role).toBe('host');
    await until(() => b.s().settings?.roundSeconds === 60, 'guest sees quick match settings');
    expect(a.s().settings).toEqual({ rounds: 3, roundSeconds: 60 });
  });

  it('gives up on Quick match after the timeout', async () => {
    const a = player('a', 'Ann');
    await a.c.start();
    await a.c.quickMatch();
    await advance(71_000);
    expect(a.s()).toMatchObject({ stage: 'menu', error: 'No opponent found. Try again in a moment.' });
  });
});
