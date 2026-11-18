import { describe, expect, it } from 'vitest';
import { createLeaderState } from '../../game/online/host';
import { memberState } from '../../game/online/protocol';
import { BackendError } from '../backend';
import { MockBackend } from './mockBackend';
import { createMemoryStore } from './store';

function setup() {
  const store = createMemoryStore();
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const make = (userId: string) =>
    new MockBackend({
      store,
      userId,
      now: clock.now,
      autoHeartbeat: false,
      disconnectAfterMs: 6000,
      dropAfterMs: 20_000,
    });
  const host = make('host');
  const guest = make('guest');
  host.heartbeat();
  guest.heartbeat();
  return { store, clock, host, guest, make };
}

describe('MockBackend rooms', () => {
  it('creates a room with a 6-character code and lets a second player join with it', async () => {
    const { host, guest } = setup();
    const room = await host.createRoom();
    expect(room.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(room.leaderId).toBe('host');
    const joined = await guest.joinByCode(room.code!.toLowerCase());
    expect(joined.id).toBe(room.id);
    expect(joined.members.map((m) => [m.userId, m.status])).toEqual([
      ['host', 'JOINED'],
      ['guest', 'JOINED'],
    ]);
  });

  it('rejects unknown codes and full rooms', async () => {
    const { host, guest, make } = setup();
    await expect(guest.joinByCode('ZZZZZZ')).rejects.toMatchObject({ kind: 'invalid-code' });
    const room = await host.createRoom();
    await guest.joinByCode(room.code!);
    const third = make('third');
    third.heartbeat();
    await expect(third.joinByCode(room.code!)).rejects.toMatchObject({ kind: 'room-full' });
  });

  it('enforces the AGS storage rules', async () => {
    const { host, guest } = setup();
    const room = await host.createRoom();
    await guest.joinByCode(room.code!);
    const leader = createLeaderState({ rounds: 3, roundSeconds: 30 });
    await host.writeLeaderStorage(room.id, leader);
    await expect(guest.writeLeaderStorage(room.id, leader)).rejects.toMatchObject({ kind: 'forbidden' });
    await guest.writeMemberStorage(room.id, 'guest', memberState('G', 0, ['ant'], false));
    await expect(guest.writeMemberStorage(room.id, 'host', memberState('G', 0, [], false))).rejects.toBeInstanceOf(
      BackendError,
    );
    // A write replaces the whole object.
    await guest.writeMemberStorage(room.id, 'guest', memberState('G', 0, [], true));
    const s = await host.getSession(room.id);
    expect(s.leaderStorage).toEqual(leader);
    expect(s.memberStorage.guest).toEqual(memberState('G', 0, [], true));
  });

  it('marks silent players disconnected, then dropped, and hands the lead over', async () => {
    const { host, guest, clock } = setup();
    const room = await host.createRoom();
    await guest.joinByCode(room.code!);
    clock.advance(7000);
    guest.heartbeat();
    let s = await guest.getSession(room.id);
    expect(s.members.find((m) => m.userId === 'host')!.status).toBe('DISCONNECTED');
    expect(s.leaderId).toBe('host');
    clock.advance(14_000);
    guest.heartbeat();
    s = await guest.getSession(room.id);
    expect(s.members.find((m) => m.userId === 'host')!.status).toBe('DROPPED');
    expect(s.leaderId).toBe('guest');
  });

  it('reports a player who leaves as LEFT and notifies the other tab', async () => {
    const { host, guest } = setup();
    const room = await host.createRoom();
    await guest.joinByCode(room.code!);
    const events: unknown[] = [];
    host.subscribe((e) => events.push(e));
    await guest.leaveSession(room.id);
    await Promise.resolve();
    expect(events).toContainEqual({ type: 'session-changed', sessionId: room.id });
    const s = await host.getSession(room.id);
    expect(s.members.find((m) => m.userId === 'guest')!.status).toBe('LEFT');
  });
});

describe('MockBackend matchmaking', () => {
  it('pairs two tickets into a session led by the first player to queue', async () => {
    const { host, guest } = setup();
    const t1 = await host.createTicket();
    expect(await host.getTicket(t1)).toEqual({ matchFound: false, sessionId: null });
    const t2 = await guest.createTicket();
    const a = await host.getTicket(t1);
    const b = await guest.getTicket(t2);
    expect(a.matchFound && b.matchFound).toBe(true);
    expect(a.sessionId).toBe(b.sessionId);
    const s = await host.getSession(a.sessionId!);
    expect(s.leaderId).toBe('host');
    expect(s.members.every((m) => m.status === 'JOINED')).toBe(true);
  });

  it('drops cancelled and expired tickets from the queue', async () => {
    const { host, guest, clock, make } = setup();
    const t1 = await host.createTicket();
    await host.cancelTicket(t1);
    const t2 = await guest.createTicket();
    expect((await guest.getTicket(t2)).matchFound).toBe(false);
    clock.advance(61_000);
    const late = make('late');
    late.heartbeat();
    const t3 = await late.createTicket();
    expect((await late.getTicket(t3)).matchFound).toBe(false);
  });
});
