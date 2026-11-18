/**
 * Drives one player's side of an online match. Plain TypeScript (no React),
 * so the whole two-player flow can be tested with two controllers sharing a
 * mock backend.
 *
 * Sync model:
 * - The session is the source of truth. The controller re-reads it on every
 *   backend hint (Lobby notification / mock broadcast) and polls it on a timer
 *   as a fallback.
 * - The host (session leader) owns the round flow and writes leader storage.
 *   Each player writes only their own member storage (name, words, finished).
 * - Each word can only be played once per round, and the host is the referee.
 *   The host's words are decided as it types them; the guest's words go into
 *   its member storage as claims, and the host accepts or turns them down in
 *   the order they arrive, then publishes who owns what in leader storage.
 *   Until the host has decided, a guest's word shows as pending. If both play
 *   the same word at nearly the same time, whichever claim the host handles
 *   first wins, and both players see the same result.
 * - Both players measure their clock's offset from the backend's clock at
 *   sign-in. The host writes the letter, the reveal time and the end time in
 *   one go when the countdown starts, on that shared clock, so both screens
 *   reveal the letter and end the round at the same moment even though the
 *   guest sees each update a little later. (If the server clock can't be
 *   read, the guest falls back to timing the round from when it sees it.)
 *   The host waits a short grace period after the round ends before scoring,
 *   so words sent in the last moment still count.
 */
import type { Dictionary } from '../game/dictionary';
import { checkWord } from '../game/dictionary';
import { drawLetters } from '../game/letters';
import { COUNTDOWN_MS, type SubmitResult } from '../game/match';
import {
  acceptGuestClaims,
  canStartNextRound,
  claimHostWord,
  createLeaderState,
  endRound,
  finishedRound,
  resultsFor,
  shouldEndRound,
  startCountdown,
  startPlaying,
  wordsForRound,
} from '../game/online/host';
import {
  type LeaderState,
  type MemberState,
  type OnlineSettings,
  type Presence,
  QUICK_MATCH_SETTINGS,
  type SessionSnapshot,
  memberState,
  parseLeaderState,
  parseMemberState,
  presenceOf,
} from '../game/online/protocol';
import { createRng, randomSeed } from '../game/rng';
import type { RoundResult } from '../game/scoring';
import { type BackendEvent, type ConnectionState, describeError, type OnlineBackend } from '../net/backend';

export type EndReason = 'opponent-left' | 'connection-lost';

export type Stage =
  | 'signing-in'
  | 'menu'
  | 'matchmaking'
  | 'room'
  | 'countdown'
  | 'playing'
  | 'round-over'
  | 'finished'
  | 'ended'
  | 'fatal';

export interface OpponentView {
  userId: string;
  name: string;
  presence: Presence;
}

export interface OnlineState {
  stage: Stage;
  userId: string | null;
  connection: ConnectionState;
  busy: boolean;
  /** A problem with the last action, shown until the next one. */
  error: string | null;
  /** True while the session can't be read; the game keeps retrying. */
  syncTrouble: boolean;
  endReason: EndReason | null;
  matchmakingSince: number | null;
  sessionId: string | null;
  code: string | null;
  role: 'host' | 'guest' | null;
  settings: OnlineSettings | null;
  opponent: OpponentView | null;
  roundIndex: number;
  letter: string | null;
  countdownMs: number;
  timeLeftMs: number;
  roundMs: number;
  /** This player's words this round, in order. For the guest this includes pending and taken words. */
  myWords: string[];
  /** Guest only: words the host hasn't decided yet. */
  pendingWords: string[];
  /** Words this player owns so far this round, as decided by the host (pending words not included). */
  confirmedCount: number;
  /** Guest only: words the host gave to the opponent, who played them first. */
  takenWords: string[];
  /** The latest of this player's words that turned out to be taken; `key` changes each time. */
  lostWord: { word: string; key: number } | null;
  myFinished: boolean;
  /** Host only: Start was pressed, and the round starts as soon as the guest has seen the last result. */
  startQueued: boolean;
  /** The opponent's words this round, as decided by the host. */
  opponentWords: string[];
  opponentFinished: boolean;
  /** Results so far, from this player's point of view. */
  results: RoundResult[];
}

export interface ControllerOptions {
  backend: OnlineBackend;
  dictionary: Dictionary;
  playerName: string;
  now?: () => number;
  pollMs?: number;
  ticketPollMs?: number;
  tickMs?: number;
  /** Give up on Quick match after this long. */
  matchmakingTimeoutMs?: number;
  /** Timing events for measurements and tests (claims, reads, writes). Times are this machine's clock. */
  trace?: (event: TraceEvent) => void;
}

export type RefreshCause = 'notify' | 'poll' | 'round-end' | 'enter';

/** One step of the online sync, with the local time it happened (`t`, ms). */
export type TraceEvent = { t: number; session: string | null; round: number } & (
  | { type: 'guest-claim'; word: string }
  | { type: 'guest-confirmed'; word: string; outcome: 'accepted' | 'taken' }
  | { type: 'host-decided'; word: string; outcome: 'accepted' | 'taken' }
  | { type: 'member-write'; ms: number; words: number }
  | { type: 'leader-write'; ms: number }
  | { type: 'read'; cause: RefreshCause; ms: number }
  | { type: 'notify' }
);

/** Words are sent straight away (the writer still batches words typed while a write is in flight), so claims reach the host quickly. */
const MEMBER_WRITE_DEBOUNCE_MS = 0;
/**
 * The host waits for the guest to have seen the last round's result before the
 * next countdown, but never longer than this after the round ended.
 */
const RESULTS_WAIT_MS = 3000;
/** Round trips used to measure the clock offset. */
const CLOCK_SAMPLES = 4;
/** After a failed leader write, wait this long before trying again. */
const LEADER_RETRY_MS = 1000;

export class OnlineMatchController {
  private readonly backend: OnlineBackend;
  private readonly dictionary: Dictionary;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly ticketPollMs: number;
  private readonly matchmakingTimeoutMs: number;
  private readonly traceFn: ((event: TraceEvent) => void) | null;
  private playerName: string;

  private listeners = new Set<() => void>();
  private state: OnlineState;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // One-shot timer for the exact moment the letter is revealed or the round ends,
  // so those don't wait for the next regular tick.
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = 0;

  // Session
  private snapshot: SessionSnapshot | null = null;
  private leader: LeaderState | null = null;
  private pendingSettings: OnlineSettings | null = null;
  private letters: string[] = [];
  private opponentSeen = false;
  private joinedAs: 'host' | 'guest' | null = null;
  private refreshing = false;
  private refreshAgain = false;
  private refreshAgainCause: RefreshCause = 'poll';

  // Clock: backend time minus this machine's time, or null if it couldn't be measured.
  private clockOffset: number | null = null;

  // Fallback timing (no shared clock): when this player first saw the current round, on this machine.
  private roundKey = '';
  private roundSeenAt = 0;
  private roundSeenInCountdown = false;

  // This player's words for the current round.
  private myRound = -1;
  private myWords: string[] = [];
  private myFinished = false;
  private memberWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private memberWriting = false;
  private memberDirty = false;

  // Words of ours the host gave to the opponent, already reported.
  private lostSeen = new Set<string>();

  // How many round results this player's screen has shown (sent to the host so it can wait for the guest).
  private seenResults = 0;
  // Host: Start was pressed while the guest was still catching up; when the current round-over began.
  private startQueued = false;
  private roundOverSince = 0;
  private roundOverKey = -1;
  private lostKey = 0;

  // Host: leader storage writes. `leader` is always the latest state; the writer sends it until nothing is left.
  private leaderDirty = false;
  private leaderWriting = false;
  private leaderRetryAt = 0;
  /** The error shown for a failed leader write, cleared once a retry succeeds. */
  private leaderError: string | null = null;
  private ending = false;

  // Matchmaking
  private ticketId: string | null = null;

  constructor(options: ControllerOptions) {
    this.backend = options.backend;
    this.dictionary = options.dictionary;
    this.playerName = options.playerName;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 1500;
    this.ticketPollMs = options.ticketPollMs ?? 2000;
    this.matchmakingTimeoutMs = options.matchmakingTimeoutMs ?? 70_000;
    this.traceFn = options.trace ?? null;
    this.state = initialState();
    this.tickTimer = setInterval(() => this.tick(), options.tickMs ?? 200);
  }

  // ---------- public API ----------

  getState(): OnlineState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPlayerName(name: string): void {
    this.playerName = name;
  }

  async start(): Promise<void> {
    this.unsubscribe = this.backend.subscribe((e) => this.onBackendEvent(e));
    try {
      const player = await this.backend.login();
      await this.syncClock();
      this.update({ userId: player.userId, stage: 'menu', connection: 'connected' });
    } catch (error) {
      this.update({ stage: 'fatal', error: describeError(error) });
    }
  }

  async createRoom(settings: OnlineSettings): Promise<void> {
    await this.action(async () => {
      this.pendingSettings = settings;
      const snapshot = await this.backend.createRoom();
      await this.enterSession(snapshot);
    });
  }

  async joinByCode(code: string): Promise<void> {
    if (!/^[0-9A-Za-z]{4,12}$/.test(code.trim())) {
      this.update({ error: 'Enter the 6-character room code.' });
      return;
    }
    await this.action(async () => {
      this.pendingSettings = null;
      const snapshot = await this.backend.joinByCode(code);
      await this.enterSession(snapshot);
    });
  }

  async quickMatch(): Promise<void> {
    await this.action(async () => {
      this.pendingSettings = QUICK_MATCH_SETTINGS;
      this.ticketId = await this.backend.createTicket();
      this.update({ stage: 'matchmaking', matchmakingSince: this.now() });
      this.startPolling(this.ticketPollMs);
      void this.checkTicket();
    });
  }

  async cancelMatchmaking(): Promise<void> {
    const ticket = this.ticketId;
    this.ticketId = null;
    this.stopPolling();
    this.update({ stage: 'menu', matchmakingSince: null });
    if (ticket) await this.backend.cancelTicket(ticket).catch(() => undefined);
  }

  /** Host only: start the countdown for the next round. */
  async startNextRound(): Promise<void> {
    if (this.state.role !== 'host' || !this.leader || !this.snapshot) return;
    if (this.state.opponent?.presence !== 'present') {
      this.update({ error: 'Wait for your opponent to join.' });
      return;
    }
    if (!canStartNextRound(this.leader)) return;
    if (!this.opponentHasSeenResults()) {
      // Start as soon as the guest has the last result on screen (see hostStep).
      this.startQueued = true;
      this.recompute();
      return;
    }
    await this.beginCountdown();
  }

  private async beginCountdown(): Promise<void> {
    if (!this.leader) return;
    this.startQueued = false;
    const clock = this.clockOffset === null ? 'host' : 'server';
    const next = startCountdown(this.leader, this.sharedNow(), this.nextLetter(this.leader), clock);
    if (next === this.leader) return this.recompute();
    await this.setLeader(next);
  }

  /** True once the guest has seen every round result so far, or the host has waited long enough. */
  private opponentHasSeenResults(): boolean {
    const leader = this.leader;
    if (!leader || leader.results.length === 0) return true;
    const seen = this.guestMember()?.seenResults ?? 0;
    return seen >= leader.results.length || this.now() - this.roundOverSince >= RESULTS_WAIT_MS;
  }

  submitWord(input: string): SubmitResult | null {
    const s = this.state;
    if (s.stage === 'countdown') return { ok: false, word: input.trim().toLowerCase(), reason: 'not-started' };
    if (s.stage !== 'playing' || !s.letter) return null;
    if (this.myFinished || s.timeLeftMs <= 0)
      return { ok: false, word: input.trim().toLowerCase(), reason: 'round-over' };
    const result = checkWord(this.dictionary, s.letter, input, new Set(this.myWords));
    if (!result.ok) {
      // A word we tried that the host gave to the opponent reads better as "taken" than "already played".
      if (result.reason === 'already-used' && s.takenWords.includes(result.word)) {
        return { ok: false, word: result.word, reason: 'taken' };
      }
      return result;
    }
    return s.role === 'host' ? this.submitAsHost(result.word) : this.submitAsGuest(result.word);
  }

  /** The host decides its own word on the spot, after first handling any guest claims it has already received. */
  private submitAsHost(word: string): SubmitResult {
    // The screen may already show the letter a moment before the host loop moves the round to playing.
    if (this.leader) void this.setLeader(startPlaying(this.leader, this.sharedNow()));
    const leader = this.leader;
    if (!leader) return { ok: false, word, reason: 'round-over' };
    const claim = claimHostWord(this.withGuestClaims(leader), word);
    if (!claim.ok) {
      // Still publish any guest claims that were handled just now.
      void this.setLeader(this.withGuestClaims(leader));
      return { ok: false, word, reason: claim.reason };
    }
    this.myWords = [...this.myWords, word];
    this.scheduleMemberWrite();
    void this.setLeader(claim.state);
    return { ok: true, word };
  }

  /** The guest can rule out words the host already owns; anything else is sent as a claim for the host to decide. */
  private submitAsGuest(word: string): SubmitResult {
    if (this.leader?.claims.host.includes(word)) return { ok: false, word, reason: 'taken' };
    this.myWords = [...this.myWords, word];
    this.trace({ type: 'guest-claim', word });
    this.scheduleMemberWrite();
    this.recompute();
    return { ok: true, word, pending: true };
  }

  finishAnswering(): void {
    if (this.state.stage !== 'playing' || this.myFinished) return;
    this.myFinished = true;
    this.scheduleMemberWrite(0);
    this.recompute();
    if (this.state.role === 'host') void this.hostStep();
  }

  /** Leave the current session or queue and go back to the online menu. */
  async leave(options: { keepalive?: boolean } = {}): Promise<void> {
    const sessionId = this.snapshot?.id ?? null;
    const ticket = this.ticketId;
    this.resetSession();
    this.update({ ...sessionFields(), stage: this.state.userId ? 'menu' : this.state.stage, error: null });
    await Promise.all([
      sessionId ? this.backend.leaveSession(sessionId, options).catch(() => undefined) : undefined,
      ticket ? this.backend.cancelTicket(ticket, options).catch(() => undefined) : undefined,
    ]);
  }

  /** Call when the page is closing: leave without waiting. */
  handlePageHide(): void {
    if (this.snapshot || this.ticketId) void this.leave({ keepalive: true });
  }

  clearError(): void {
    if (this.state.error) this.update({ error: null });
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.stopPolling();
    if (this.memberWriteTimer) clearTimeout(this.memberWriteTimer);
    this.unsubscribe?.();
    this.listeners.clear();
  }

  // ---------- session ----------

  private async enterSession(snapshot: SessionSnapshot): Promise<void> {
    this.resetSession();
    this.snapshot = snapshot;
    this.update({ stage: 'room', sessionId: snapshot.id, code: snapshot.code });
    await this.writeMember();
    this.applySnapshot(snapshot);
    this.startPolling(this.pollMs);
    await this.refresh('enter');
  }

  private resetSession(): void {
    this.stopPolling();
    if (this.memberWriteTimer) clearTimeout(this.memberWriteTimer);
    this.snapshot = null;
    this.leader = null;
    this.letters = [];
    this.opponentSeen = false;
    this.joinedAs = null;
    this.roundKey = '';
    this.myRound = -1;
    this.myWords = [];
    this.myFinished = false;
    this.memberDirty = false;
    this.ticketId = null;
    this.lostSeen = new Set();
    this.seenResults = 0;
    this.startQueued = false;
    this.roundOverKey = -1;
    this.leaderDirty = false;
    this.leaderRetryAt = 0;
    this.ending = false;
  }

  private async refresh(cause: RefreshCause = 'poll'): Promise<void> {
    const id = this.snapshot?.id;
    if (!id || this.disposed) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      this.refreshAgainCause = cause;
      return;
    }
    this.refreshing = true;
    try {
      const started = this.now();
      const snapshot = await this.backend.getSession(id);
      if (this.snapshot?.id !== id) return; // left meanwhile
      this.trace({ type: 'read', cause, ms: this.now() - started });
      if (this.state.syncTrouble) this.update({ syncTrouble: false });
      this.applySnapshot(snapshot);
    } catch (error) {
      if (this.snapshot?.id !== id) return;
      if ((error as { kind?: string }).kind === 'not-found') {
        this.endMatch('connection-lost');
      } else if (!this.state.syncTrouble) {
        this.update({ syncTrouble: true });
      }
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh(this.refreshAgainCause);
      }
    }
  }

  private applySnapshot(incoming: SessionSnapshot): void {
    if (this.state.stage === 'ended') return;
    // A read can return storage older than what a notification already gave us: keep the newer one.
    const snapshot = this.snapshot?.id === incoming.id ? keepNewerStorage(this.snapshot, incoming) : incoming;
    this.snapshot = snapshot;
    const me = this.state.userId!;
    const myMember = snapshot.members.find((m) => m.userId === me);
    if (!myMember || presenceOf(myMember.status) === 'gone') {
      this.endMatch('connection-lost');
      return;
    }
    const role = snapshot.leaderId === me ? 'host' : 'guest';
    this.joinedAs ??= role;
    // Only the host writes leader storage, so once the host has a leader state, its
    // own copy is always the newest; a read can only show an older one.
    if (!(role === 'host' && this.leader)) this.leader = parseLeaderState(snapshot.leaderStorage);
    this.update({ role, code: snapshot.code });

    if (role === 'host') {
      if (!this.leader) {
        // The host sets the match up once.
        void this.setLeader(createLeaderState(this.pendingSettings ?? QUICK_MATCH_SETTINGS));
      } else {
        // Decide any new guest words as soon as they arrive.
        void this.setLeader(this.withGuestClaims(this.leader));
      }
    }
    this.recompute();
    // React to the guest finishing or seeing a result now, not on the next tick.
    if (role === 'host') void this.hostStep();
  }

  private opponent(): OpponentView | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    const others = snapshot.members.filter((m) => m.userId !== this.state.userId);
    // Prefer someone still in the session; otherwise report the last one who was.
    const member = others.find((m) => presenceOf(m.status) !== 'gone') ?? others.at(-1);
    if (!member) return null;
    const stored = parseMemberState(snapshot.memberStorage[member.userId]);
    return { userId: member.userId, name: stored?.name || 'Opponent', presence: presenceOf(member.status) };
  }

  // ---------- timing and host loop ----------

  private tick(): void {
    if (this.disposed) return;
    if (this.state.stage === 'matchmaking' && this.state.matchmakingSince !== null) {
      if (this.now() - this.state.matchmakingSince > this.matchmakingTimeoutMs) {
        void this.cancelMatchmaking().then(() => this.update({ error: 'No opponent found. Try again in a moment.' }));
        return;
      }
    }
    if (!this.snapshot || !this.leader) return;
    this.recompute();
    // When this player's clock runs out they are finished: that write carries their last words,
    // so the host can score as soon as it sees both players finished.
    const s = this.state;
    if (s.stage === 'playing' && s.timeLeftMs <= 0 && !this.myFinished) this.finishAnswering();
    if (s.role === 'host') void this.hostStep();
  }

  private async hostStep(): Promise<void> {
    const leader = this.leader;
    if (!leader || this.ending) return;
    if (this.leaderDirty && !this.leaderWriting && this.now() >= this.leaderRetryAt) void this.flushLeader();
    const now = this.sharedNow();
    if (leader.phase === 'countdown' && leader.countdownEndsAt !== null && now >= leader.countdownEndsAt) {
      await this.setLeader(startPlaying(leader, now));
      return;
    }
    if (this.startQueued && canStartNextRound(leader) && this.opponentHasSeenResults()) {
      await this.beginCountdown();
      return;
    }
    if (leader.phase === 'playing') {
      const guest = this.guestMember();
      const players = {
        hostFinished: this.myFinished && this.myRound === leader.roundIndex,
        guestFinished: finishedRound(guest, leader.roundIndex),
      };
      if (!shouldEndRound(leader, now, players)) return;
      this.ending = true;
      try {
        // The guest's "finished" write includes all its words, so if we have it, score straight away.
        // Otherwise we gave up waiting: read once more for any last words first.
        if (!players.guestFinished) await this.refresh('round-end');
        const fresh = this.leader;
        if (!fresh || fresh.phase !== 'playing' || fresh.roundIndex !== leader.roundIndex) return;
        await this.setLeader(endRound(this.withGuestClaims(fresh), this.dictionary));
      } finally {
        this.ending = false;
      }
    }
  }

  /** The leader state with the guest's undecided words accepted or turned down. */
  private withGuestClaims(leader: LeaderState): LeaderState {
    const next = acceptGuestClaims(leader, this.dictionary, wordsForRound(this.guestMember(), leader.roundIndex));
    if (next !== leader && this.traceFn) {
      for (const word of next.claims.guest.slice(leader.claims.guest.length)) {
        this.trace({ type: 'host-decided', word, outcome: 'accepted' });
      }
      for (const word of next.claims.rejected.slice(leader.claims.rejected.length)) {
        this.trace({ type: 'host-decided', word, outcome: 'taken' });
      }
    }
    return next;
  }

  /**
   * The next letter, never one already played. Letters are drawn by the host
   * and kept in memory, so the guest can't see upcoming letters.
   */
  private nextLetter(leader: LeaderState): string {
    if (this.letters.length === 0) this.letters = drawLetters(createRng(randomSeed()), 26);
    const used = new Set(leader.results.map((r) => r.letter));
    return this.letters.find((l) => !used.has(l))!;
  }

  private guestMember(): MemberState | null {
    const opponent = this.opponent();
    return opponent ? parseMemberState(this.snapshot?.memberStorage[opponent.userId]) : null;
  }

  /**
   * Host only: makes `next` the leader state, shows it straight away and
   * writes it. Writes are one at a time and always send the latest state, so
   * a slow write can never overwrite a newer one. Resolves once written (or failed).
   */
  private async setLeader(next: LeaderState): Promise<void> {
    if (next === this.leader && !this.leaderDirty) return;
    this.leader = next;
    this.leaderDirty = true;
    this.recompute();
    await this.flushLeader();
  }

  private async flushLeader(): Promise<void> {
    const sessionId = this.snapshot?.id;
    if (!sessionId || this.leaderWriting) return;
    this.leaderWriting = true;
    try {
      while (this.leaderDirty && this.leader && this.snapshot?.id === sessionId) {
        this.leaderDirty = false;
        const started = this.now();
        await this.backend.writeLeaderStorage(sessionId, this.leader);
        this.trace({ type: 'leader-write', ms: this.now() - started });
        // A retry got through: drop the error the failed write showed.
        if (this.leaderError !== null && this.state.error === this.leaderError) this.update({ error: null });
        this.leaderError = null;
      }
    } catch (error) {
      // Keep the state and try again shortly (from the host loop).
      this.leaderDirty = true;
      this.leaderRetryAt = this.now() + LEADER_RETRY_MS;
      this.leaderError = describeError(error);
      if (this.snapshot?.id === sessionId) this.update({ error: this.leaderError });
    } finally {
      this.leaderWriting = false;
    }
  }

  /** Recomputes everything the screens show from the session, the leader state and the clock. */
  private recompute(): void {
    const leader = this.leader;
    const now = this.now();
    const opponent = this.opponent();
    const role = this.state.role;
    const roundMs = leader ? leader.settings.roundSeconds * 1000 : 0;

    // Opponent left?
    if (opponent && opponent.presence !== 'gone') this.opponentSeen = true;
    // Once a match has started, or if the host leaves the room, the match is over.
    // If the guest leaves the room before the first round, the host keeps waiting.
    const matchStarted = !!leader && leader.roundIndex >= 0 && leader.phase !== 'finished';
    const opponentGone = !opponent || opponent.presence === 'gone';
    if (
      this.opponentSeen &&
      opponentGone &&
      (matchStarted || (this.joinedAs === 'guest' && leader?.phase !== 'finished'))
    ) {
      this.endMatch('opponent-left');
      return;
    }

    // New round: reset this player's words.
    if (leader && leader.roundIndex !== this.myRound && (leader.phase === 'countdown' || leader.phase === 'playing')) {
      this.myRound = leader.roundIndex;
      this.myWords = [];
      this.myFinished = false;
      this.lostSeen = new Set();
      this.scheduleMemberWrite(0);
    }

    // Round timing: when the letter is revealed and when the round ends, on this machine's clock.
    let countdownMs = 0;
    let timeLeftMs = roundMs;
    let started = false;
    const inRound = leader?.phase === 'countdown' || leader?.phase === 'playing';
    if (leader && inRound) {
      const key = `${leader.roundIndex}`;
      if (key !== this.roundKey) {
        this.roundKey = key;
        this.roundSeenAt = now;
        this.roundSeenInCountdown = leader.phase === 'countdown';
      }
      let revealAt: number;
      let endAt: number;
      const shared = role === 'host' || (leader.clock === 'server' && this.clockOffset !== null);
      if (shared && leader.countdownEndsAt !== null && leader.roundEndsAt !== null) {
        // Host timestamps on the shared clock, converted to this machine's clock.
        const toLocal = role === 'host' ? -(this.clockOffset ?? 0) : -this.clockOffset!;
        revealAt = leader.countdownEndsAt + toLocal;
        endAt = leader.roundEndsAt + toLocal;
      } else {
        // No shared clock: time the round from when this player first saw it.
        revealAt = this.roundSeenInCountdown ? this.roundSeenAt + COUNTDOWN_MS : this.roundSeenAt;
        endAt = revealAt + roundMs;
      }
      countdownMs = Math.min(COUNTDOWN_MS, Math.max(0, revealAt - now));
      started = countdownMs === 0;
      timeLeftMs = started ? Math.min(roundMs, Math.max(0, endAt - now)) : roundMs;
      this.wakeUpAt(started ? (timeLeftMs > 0 ? endAt : 0) : revealAt);
    } else if (leader && leader.phase !== 'waiting') {
      timeLeftMs = 0;
    }

    const opponentMember = opponent ? parseMemberState(this.snapshot?.memberStorage[opponent.userId]) : null;
    const round = leader?.roundIndex ?? -1;
    const stage: Stage =
      !leader || leader.phase === 'waiting' ? 'room' : inRound ? (started ? 'playing' : 'countdown') : leader.phase;

    // Results shown: tell the host (it waits for the guest before the next countdown).
    if (leader && (stage === 'round-over' || stage === 'finished') && this.roundOverKey !== leader.results.length) {
      this.roundOverKey = leader.results.length;
      this.roundOverSince = now;
    }
    if (leader && leader.results.length > this.seenResults) {
      this.seenResults = leader.results.length;
      this.scheduleMemberWrite(0);
    }
    if (this.startQueued && stage !== 'round-over') this.startQueued = false;

    // Word ownership comes from the host's claims.
    const claims = leader?.claims;
    const myWords = this.myRound === round ? this.myWords : [];
    let pendingWords: string[] = [];
    let takenWords: string[] = [];
    let lostWord = this.state.lostWord;
    if (role === 'guest' && claims && started) {
      const accepted = new Set(claims.guest);
      const rejected = new Set(claims.rejected);
      takenWords = myWords.filter((word) => rejected.has(word));
      pendingWords = myWords.filter((word) => !accepted.has(word) && !rejected.has(word));
      if (this.traceFn) {
        for (const word of this.state.pendingWords) {
          if (accepted.has(word)) this.trace({ type: 'guest-confirmed', word, outcome: 'accepted' });
          else if (rejected.has(word)) this.trace({ type: 'guest-confirmed', word, outcome: 'taken' });
        }
      }
      for (const word of takenWords) {
        if (this.lostSeen.has(word)) continue;
        this.lostSeen.add(word);
        lostWord = { word, key: ++this.lostKey };
      }
    }
    const opponentWords = claims && round >= 0 ? (role === 'host' ? claims.guest : claims.host) : [];

    this.update({
      stage: this.state.stage === 'ended' ? 'ended' : stage,
      opponent,
      settings: leader?.settings ?? this.pendingSettings,
      roundIndex: round,
      letter: started ? (leader?.letter ?? null) : null,
      countdownMs,
      timeLeftMs,
      roundMs,
      myWords,
      pendingWords,
      confirmedCount: myWords.length - pendingWords.length - takenWords.length,
      takenWords,
      lostWord,
      myFinished: this.myRound === round && this.myFinished,
      startQueued: this.startQueued,
      opponentWords,
      opponentFinished: finishedRound(opponentMember, round),
      results: leader && role ? resultsFor(leader.results, role) : [],
    });
  }

  private trace(event: Omit<TraceEvent, 't' | 'session' | 'round'> & Partial<TraceEvent>): void {
    if (!this.traceFn) return;
    this.traceFn({
      t: this.now(),
      session: this.snapshot?.id ?? null,
      round: this.leader?.roundIndex ?? -1,
      ...event,
    } as TraceEvent);
  }

  /** Runs a tick at `at` (this machine's clock), unless one is already set for that moment. 0 cancels. */
  private wakeUpAt(at: number): void {
    if (at === this.wakeAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = at;
    if (at > 0) this.wakeTimer = setTimeout(() => this.tick(), Math.max(0, at - this.now()));
  }

  /** The backend's clock, as far as this player can tell (this machine's clock if it couldn't be measured). */
  private sharedNow(): number {
    return this.now() + (this.clockOffset ?? 0);
  }

  /**
   * Measures this machine's clock against the backend's: a few round trips,
   * keeping the one with the shortest delay, assuming the server read the time
   * halfway through it. Usually accurate to a few tens of milliseconds.
   */
  private async syncClock(): Promise<void> {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      try {
        const sent = this.now();
        const server = await this.backend.serverTime();
        const received = this.now();
        const rtt = received - sent;
        if (!best || rtt < best.rtt) best = { rtt, offset: server - (sent + received) / 2 };
      } catch {
        break;
      }
    }
    this.clockOffset = best ? Math.round(best.offset) : null;
  }

  private endMatch(reason: EndReason): void {
    if (this.state.stage === 'ended') return;
    this.stopPolling();
    const sessionId = this.snapshot?.id;
    this.update({ stage: 'ended', endReason: reason });
    // Free our seat; the session is over for us either way.
    if (sessionId && reason === 'opponent-left') void this.backend.leaveSession(sessionId).catch(() => undefined);
  }

  // ---------- member storage ----------

  private scheduleMemberWrite(delay = MEMBER_WRITE_DEBOUNCE_MS): void {
    if (this.memberWriteTimer) clearTimeout(this.memberWriteTimer);
    this.memberWriteTimer = setTimeout(() => void this.writeMember(), delay);
  }

  private async writeMember(): Promise<void> {
    const sessionId = this.snapshot?.id;
    const userId = this.state.userId;
    if (!sessionId || !userId) return;
    if (this.memberWriting) {
      this.memberDirty = true;
      return;
    }
    this.memberWriting = true;
    try {
      do {
        this.memberDirty = false;
        const data = memberState(this.playerName, this.myRound, this.myWords, this.myFinished, this.seenResults);
        const started = this.now();
        await this.backend.writeMemberStorage(sessionId, userId, data);
        this.trace({ type: 'member-write', ms: this.now() - started, words: data.words.length });
      } while (this.memberDirty && this.snapshot?.id === sessionId);
    } catch (error) {
      if (this.snapshot?.id === sessionId) this.update({ syncTrouble: true, error: describeError(error) });
    } finally {
      this.memberWriting = false;
    }
  }

  // ---------- matchmaking ----------

  private async checkTicket(): Promise<void> {
    const ticket = this.ticketId;
    if (!ticket || this.state.stage !== 'matchmaking') return;
    try {
      const status = await this.backend.getTicket(ticket);
      if (this.ticketId !== ticket || !status.matchFound || !status.sessionId) return;
      this.ticketId = null;
      this.stopPolling();
      const snapshot = await this.backend.getSession(status.sessionId);
      this.update({ matchmakingSince: null });
      await this.enterSession(snapshot);
    } catch (error) {
      if ((error as { kind?: string }).kind === 'not-found' && this.ticketId === ticket) {
        // The ticket expired without a match.
        this.ticketId = null;
        this.stopPolling();
        this.update({ stage: 'menu', matchmakingSince: null, error: 'No opponent found. Try again in a moment.' });
      }
    }
  }

  // ---------- plumbing ----------

  private onBackendEvent(event: BackendEvent): void {
    if (event.type === 'connection') {
      this.update({ connection: event.state });
    } else if (event.type === 'session-changed') {
      const snapshot = this.snapshot;
      if (event.storage && snapshot && event.sessionId === snapshot.id) {
        // The notification carries the written storage: apply it, no read needed.
        // Our own writes bring nothing new.
        if (event.storage.userId === this.state.userId) return;
        this.trace({ type: 'notify' });
        const { kind, userId, data } = event.storage;
        this.applySnapshot(
          kind === 'leader'
            ? { ...snapshot, leaderStorage: data }
            : { ...snapshot, memberStorage: { ...snapshot.memberStorage, [userId]: data } },
        );
        return;
      }
      if (event.storage) return; // storage of another session
      if (!event.sessionId || event.sessionId === snapshot?.id) {
        this.trace({ type: 'notify' });
        void this.refresh('notify');
      }
      if (this.state.stage === 'matchmaking') void this.checkTicket();
    } else if (event.type === 'match-found') {
      void this.checkTicket();
    }
  }

  private startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.state.stage === 'matchmaking') void this.checkTicket();
      else void this.refresh();
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async action(fn: () => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.update({ busy: true, error: null });
    try {
      await fn();
    } catch (error) {
      this.update({ error: describeError(error) });
    } finally {
      this.update({ busy: false });
    }
  }

  private update(patch: Partial<OnlineState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof OnlineState)[]) {
      if (!shallowEqual(this.state[k], patch[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

function initialState(): OnlineState {
  return {
    stage: 'signing-in',
    userId: null,
    connection: 'connecting',
    busy: false,
    error: null,
    syncTrouble: false,
    matchmakingSince: null,
    ...sessionFields(),
  };
}

function sessionFields() {
  return {
    endReason: null,
    sessionId: null,
    code: null,
    role: null,
    settings: null,
    opponent: null,
    roundIndex: -1,
    letter: null,
    countdownMs: 0,
    timeLeftMs: 0,
    roundMs: 0,
    myWords: [],
    pendingWords: [],
    confirmedCount: 0,
    takenWords: [],
    lostWord: null,
    startQueued: false,
    myFinished: false,
    opponentWords: [],
    opponentFinished: false,
    results: [],
  } satisfies Partial<OnlineState>;
}

/** Orders leader states: by round, then phase, then results and claims (which only grow within a round). */
function leaderProgress(l: LeaderState): number[] {
  const order = { waiting: 0, countdown: 1, playing: 2, 'round-over': 3, finished: 4 } as const;
  return [
    l.roundIndex,
    order[l.phase],
    l.results.length,
    l.claims.host.length + l.claims.guest.length + l.claims.rejected.length,
  ];
}

/** Orders member states: by round, then words (which only grow within a round), then finished and seen results. */
function memberProgress(m: MemberState): number[] {
  return [m.roundIndex, m.words.length, m.finished ? 1 : 0, m.seenResults];
}

function isBehind(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * Notifications and reads can arrive out of order. Storage only moves forward
 * within a session, so if the incoming copy of a storage is behind the one we
 * already have, keep ours.
 */
function keepNewerStorage(current: SessionSnapshot, incoming: SessionSnapshot): SessionSnapshot {
  let leaderStorage = incoming.leaderStorage;
  const oldLeader = parseLeaderState(current.leaderStorage);
  const newLeader = parseLeaderState(incoming.leaderStorage);
  if (oldLeader && (!newLeader || isBehind(leaderProgress(newLeader), leaderProgress(oldLeader)))) {
    leaderStorage = current.leaderStorage;
  }
  const memberStorage = { ...incoming.memberStorage };
  for (const [userId, raw] of Object.entries(current.memberStorage)) {
    const oldMember = parseMemberState(raw);
    const newMember = parseMemberState(memberStorage[userId]);
    if (oldMember && (!newMember || isBehind(memberProgress(newMember), memberProgress(oldMember)))) {
      memberStorage[userId] = raw;
    }
  }
  return { ...incoming, leaderStorage, memberStorage };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => shallowEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => shallowEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}
