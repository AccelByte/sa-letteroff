/**
 * Latency simulation: two controllers play over a mock backend that imitates
 * the delays measured against live AGS (one browser for both players, so both
 * share a clock):
 *
 * - storage write: lands on the server after ~135 ms, acknowledged at ~270 ms
 * - session read: sees the server state as of ~135 ms, returns at ~530 ms
 *   (reads of a session with stored words took one extra round trip live)
 * - Lobby notification: arrives ~100 ms after the write is acknowledged
 *
 * Checks that both players end with the same ownership and results. With
 * LATENCY_REPORT=1 it also prints per-scenario guest timings (submit to pending
 * on screen, submit to the host's decision on screen) and request counts:
 * `LATENCY_REPORT=1 npx vitest run src/online/latency.sim.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dictionary } from '../game/dictionary';
import { ALPHABET } from '../game/letters';
import type { LeaderState, MemberState, SessionSnapshot } from '../game/online/protocol';
import type { BackendEvent } from '../net/backend';
import { MockBackend } from '../net/mock/mockBackend';
import { type MockStore, createMemoryStore } from '../net/mock/store';
import { OnlineMatchController, type TraceEvent } from './controller';

const WRITE_LAND_MS = 135;
const WRITE_ACK_MS = 270;
const READ_SNAPSHOT_MS = 135;
const READ_RETURN_MS = 530;
const NOTIFY_AFTER_LAND_MS = 235; // ~100 ms after the ack, as seen live
const POLL_MS = 1500;

const dict = new Dictionary([
  ALPHABET.flatMap((l) => Array.from({ length: 30 }, (_, i) => `${l.toLowerCase()}zz${String.fromCharCode(97 + i)}`)),
]);
const w = (letter: string, i: number) => `${letter.toLowerCase()}zz${String.fromCharCode(97 + i)}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class SimBackend extends MockBackend {
  reads = 0;
  writes = 0;
  notifications = 0;
  /** Drop Lobby notifications while true (they still count as sent). */
  dropNotifications = false;
  /** Extra delay before this player's member writes land. */
  memberWriteExtraMs = 0;

  override async getSession(sessionId: string): Promise<SessionSnapshot> {
    this.reads++;
    await sleep(READ_SNAPSHOT_MS);
    const snapshot = await super.getSession(sessionId);
    await sleep(READ_RETURN_MS - READ_SNAPSHOT_MS);
    return snapshot;
  }

  override async writeLeaderStorage(sessionId: string, data: LeaderState): Promise<void> {
    this.writes++;
    await sleep(WRITE_LAND_MS);
    await super.writeLeaderStorage(sessionId, data);
    await sleep(WRITE_ACK_MS - WRITE_LAND_MS);
  }

  override async writeMemberStorage(sessionId: string, userId: string, data: MemberState): Promise<void> {
    this.writes++;
    await sleep(WRITE_LAND_MS + this.memberWriteExtraMs);
    await super.writeMemberStorage(sessionId, userId, data);
    await sleep(WRITE_ACK_MS - WRITE_LAND_MS);
  }

  override subscribe(listener: (event: BackendEvent) => void): () => void {
    return super.subscribe((event) => {
      if (event.type !== 'session-changed') return listener(event);
      this.notifications++;
      if (this.dropNotifications) return;
      setTimeout(() => listener(event), NOTIFY_AFTER_LAND_MS);
    });
  }
}

let store: MockStore;
const cleanup: (() => void)[] = [];

function player(userId: string, name: string, trace: (TraceEvent & { who: string })[]) {
  const backend = new SimBackend({ store, userId, heartbeatMs: 1000, disconnectAfterMs: 4000, dropAfterMs: 20_000 });
  const c = new OnlineMatchController({
    backend,
    dictionary: dict,
    playerName: name,
    pollMs: POLL_MS,
    trace: (e) => trace.push({ ...e, who: name }),
  });
  cleanup.push(() => {
    c.dispose();
    backend.dispose();
  });
  return { backend, c, s: () => c.getState() };
}

async function until(check: () => boolean, label: string, maxMs = 30_000) {
  for (let t = 0; t < maxMs; t += 20) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function room(rounds: 1 | 3 = 1) {
  const trace: (TraceEvent & { who: string })[] = [];
  const host = player('host', 'Hana', trace);
  const guest = player('guest', 'Gus', trace);
  await host.c.start();
  await guest.c.start();
  // Don't await these directly: the simulated network runs on the fake timers advanced by until().
  void host.c.createRoom({ rounds, roundSeconds: 60 });
  await until(() => !!host.s().code && !host.s().busy && !!host.s().settings, 'room');
  void guest.c.joinByCode(host.s().code!);
  await until(() => guest.s().role === 'guest' && !guest.s().busy, 'joined');
  await until(() => host.s().opponent?.presence === 'present' && guest.s().opponent?.presence === 'present', 'present');
  return { host, guest, trace };
}

async function startRound(p: Awaited<ReturnType<typeof room>>) {
  void p.host.c.startNextRound();
  await until(() => p.host.s().stage === 'playing' && p.guest.s().stage === 'playing', 'playing');
  return p.host.s().letter!;
}

/** Watches the guest's state for each submitted word: when it first shows as pending and as decided. */
function watchGuest(guest: ReturnType<typeof player>) {
  const seen = new Map<string, { submitted: number; pending?: number; decided?: number; outcome?: string }>();
  const unsubscribe = guest.c.subscribe(() => {
    const s = guest.c.getState();
    for (const [word, rec] of seen) {
      if (rec.pending === undefined && s.pendingWords.includes(word)) rec.pending = Date.now();
      if (rec.decided === undefined && s.myWords.includes(word) && !s.pendingWords.includes(word)) {
        rec.decided = Date.now();
        rec.outcome = s.takenWords.includes(word) ? 'taken' : 'accepted';
      }
    }
  });
  cleanup.push(unsubscribe);
  return {
    submit(word: string) {
      seen.set(word, { submitted: Date.now() });
      const result = guest.c.submitWord(word);
      // A result that isn't pending was decided locally (taken or invalid).
      if (!(result && result.ok && 'pending' in result)) seen.delete(word);
      return result;
    },
    samples: () => [...seen.values()].filter((r) => r.decided !== undefined),
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

const report: string[] = [];
function record(name: string, samples: { submitted: number; pending?: number; decided?: number }[], extra = '') {
  const confirm = samples.map((r) => r.decided! - r.submitted);
  const local = samples.map((r) => (r.pending ?? r.decided!) - r.submitted);
  report.push(
    `${name.padEnd(34)} n=${String(samples.length).padStart(2)}  local max ${Math.max(...local)} ms  ` +
      `confirm median ${pct(confirm, 50)} ms  p95 ${pct(confirm, 95)} ms  max ${Math.max(...confirm)} ms  ${extra}`,
  );
}

function counts(p: Awaited<ReturnType<typeof room>>) {
  return {
    reads: p.host.backend.reads + p.guest.backend.reads,
    writes: p.host.backend.writes + p.guest.backend.writes,
  };
}

/** Both players agree on every round result, from their own side. */
function expectSameResults(p: Awaited<ReturnType<typeof room>>) {
  const h = p.host.s().results;
  const g = p.guest.s().results;
  expect(g.map((r) => [r.letter, r.playerWords, r.botWords, r.playerScore, r.botScore])).toEqual(
    h.map((r) => [r.letter, r.botWords, r.playerWords, r.botScore, r.playerScore]),
  );
  for (const r of h) expect(r.shared).toEqual([]);
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createMemoryStore();
});

afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.useRealTimers();
});

describe('latency simulation (live AGS delays)', { timeout: 300_000 }, () => {
  it('rapid distinct guest words', async () => {
    const p = await room();
    const l = await startRound(p);
    const watch = watchGuest(p.guest);
    const before = counts(p);
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      watch.submit(w(l, i));
      await vi.advanceTimersByTimeAsync(400);
    }
    await until(() => p.guest.s().pendingWords.length === 0, 'decided');
    const after = counts(p);
    const secs = (Date.now() - t0) / 1000;
    record(
      'rapid distinct words (every 400 ms)',
      watch.samples(),
      `reads/s ${((after.reads - before.reads) / secs).toFixed(1)}`,
    );
    expect(watch.samples()).toHaveLength(12);
    p.host.c.finishAnswering();
    p.guest.c.finishAnswering();
    await until(() => p.host.s().stage === 'finished' && p.guest.s().stage === 'finished', 'finished');
    expectSameResults(p);
    expect(p.host.s().results[0]!.botScore).toBe(12);
  });

  it('spaced guest words (one at a time)', async () => {
    const p = await room();
    const l = await startRound(p);
    const watch = watchGuest(p.guest);
    for (let i = 0; i < 12; i++) {
      watch.submit(w(l, i));
      await vi.advanceTimersByTimeAsync(2500);
    }
    await until(() => p.guest.s().pendingWords.length === 0, 'decided');
    record('spaced words (every 2.5 s)', watch.samples());
    p.host.c.finishAnswering();
    p.guest.c.finishAnswering();
    await until(() => p.host.s().stage === 'finished' && p.guest.s().stage === 'finished', 'finished');
    expectSameResults(p);
  });

  it('simultaneous claims on one word', async () => {
    const p = await room();
    const l = await startRound(p);
    const watch = watchGuest(p.guest);
    for (let i = 0; i < 6; i++) {
      watch.submit(w(l, i));
      p.host.c.submitWord(w(l, i));
      await vi.advanceTimersByTimeAsync(2000);
    }
    await until(() => p.guest.s().pendingWords.length === 0, 'decided');
    record('simultaneous claims', watch.samples(), 'all taken by host');
    p.host.c.finishAnswering();
    p.guest.c.finishAnswering();
    await until(() => p.host.s().stage === 'finished' && p.guest.s().stage === 'finished', 'finished');
    expectSameResults(p);
    expect(p.host.s().results[0]!.playerScore + p.host.s().results[0]!.botScore).toBe(6);
  });

  it('last-second submission still counts on both sides', async () => {
    const p = await room();
    const l = await startRound(p);
    const watch = watchGuest(p.guest);
    await until(() => p.guest.s().timeLeftMs <= 300, 'nearly over', 70_000);
    watch.submit(w(l, 7));
    await until(() => p.host.s().stage === 'finished' && p.guest.s().stage === 'finished', 'finished', 10_000);
    expectSameResults(p);
    expect(p.guest.s().results[0]!.playerWords).toEqual([w(l, 7)]);
    report.push(`${'last-second submission'.padEnd(34)} counted for the guest on both screens`);
  });

  it('missed notifications fall back to polling', async () => {
    const p = await room();
    const l = await startRound(p);
    const watch = watchGuest(p.guest);
    p.host.backend.dropNotifications = true;
    p.guest.backend.dropNotifications = true;
    for (let i = 0; i < 6; i++) {
      watch.submit(w(l, i));
      await vi.advanceTimersByTimeAsync(3000);
    }
    await until(() => p.guest.s().pendingWords.length === 0, 'decided');
    record('missed notifications (polling only)', watch.samples());
    p.host.backend.dropNotifications = false;
    p.guest.backend.dropNotifications = false;
    p.host.c.finishAnswering();
    p.guest.c.finishAnswering();
    await until(() => p.host.s().stage === 'finished' && p.guest.s().stage === 'finished', 'finished');
    expectSameResults(p);
  });

  it('a delayed write from the previous round is ignored in the next one', async () => {
    const p = await room(3);
    const l1 = await startRound(p);
    // The guest's last word of round 1 lands 4 s late, after the round has ended.
    p.guest.backend.memberWriteExtraMs = 4000;
    p.guest.c.submitWord(w(l1, 3));
    await vi.advanceTimersByTimeAsync(10);
    p.guest.backend.memberWriteExtraMs = 0;
    p.host.c.finishAnswering();
    p.guest.c.finishAnswering();
    await until(() => p.host.s().stage === 'round-over' && p.guest.s().stage === 'round-over', 'round 1 over', 70_000);
    void p.host.c.startNextRound();
    const l2 = await (async () => {
      await until(() => p.host.s().stage === 'playing' && p.guest.s().stage === 'playing', 'round 2 playing');
      return p.host.s().letter!;
    })();
    const watch = watchGuest(p.guest);
    watch.submit(w(l2, 0));
    await vi.advanceTimersByTimeAsync(6000); // the late round-1 write lands during round 2
    await until(() => p.guest.s().pendingWords.length === 0, 'decided');
    expect(p.host.s().opponentWords).toEqual([w(l2, 0)]);
    expect(p.guest.s().roundIndex).toBe(1);
    report.push(`${'delayed write across a round change'.padEnd(34)} round-1 word ignored in round 2`);
    // Play out the match.
    for (let r = 1; r < 3; r++) {
      p.host.c.finishAnswering();
      p.guest.c.finishAnswering();
      await until(() => ['round-over', 'finished'].includes(p.host.s().stage), 'over', 20_000);
      await until(() => ['round-over', 'finished'].includes(p.guest.s().stage), 'guest over', 20_000);
      if (r < 2) {
        void p.host.c.startNextRound();
        await until(() => p.host.s().stage === 'playing' && p.guest.s().stage === 'playing', 'next', 20_000);
      }
    }
    await until(() => p.host.s().stage === 'finished' && p.guest.s().stage === 'finished', 'finished');
    expectSameResults(p);
  });

  it('request counts while idle', async () => {
    const p = await room();
    const before = counts(p);
    await vi.advanceTimersByTimeAsync(30_000);
    const after = counts(p);
    report.push(
      `${'idle in the room, 30 s, both players'.padEnd(34)} reads ${after.reads - before.reads}, writes ${after.writes - before.writes}`,
    );
  });

  afterAll(() => {
    if (!process.env.LATENCY_REPORT) return;
    console.log(`\nLatency simulation (mock backend with live-AGS delays)\n${report.join('\n')}\n`);
  });
});
