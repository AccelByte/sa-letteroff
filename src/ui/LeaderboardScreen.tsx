import { useCallback, useEffect, useState } from 'react';
import { ALPHABET } from '../game/letters';
import { sumBests } from '../game/progress';
import { describeError } from '../net/backend';
import type { BoardId, LeaderboardView, ProfileStore } from '../net/profile/profileStore';

type Tab = BoardId | 'letters';

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'wins', label: 'Total wins', blurb: 'Online matches won against other players.' },
  {
    id: 'az',
    label: 'A–Z best',
    blurb: 'Your best score in a 60-second online round for each letter, added up across A–Z.',
  },
  { id: 'letters', label: 'Best by letter', blurb: 'Your best score in a 60-second online round, per letter.' },
];

const BOARD_SIZE = 20;

type Loaded = { tab: BoardId; view: LeaderboardView } | { tab: 'letters'; bests: Partial<Record<string, number>> };

interface Props {
  store: ProfileStore;
  playerName: string;
  onBack: () => void;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function LeaderboardScreen({ store, playerName, onBack }: Props) {
  const [tab, setTab] = useState<Tab>('wins');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Fetches a board; state is only set when the request settles.
  const fetchBoard = useCallback(
    (which: Tab) => {
      const request: Promise<Loaded> =
        which === 'letters'
          ? store.remote.letterBests().then((bests) => ({ tab: 'letters' as const, bests }))
          : store.remote.leaderboard(which, BOARD_SIZE).then((view) => ({ tab: which, view }));
      request.then(
        (next) => {
          setLoaded(next);
          setUpdatedAt(Date.now());
          setError(null);
          setLoading(false);
        },
        (e: unknown) => {
          setError(describeError(e));
          setLoading(false);
        },
      );
    },
    [store],
  );

  useEffect(() => {
    fetchBoard(tab);
  }, [fetchBoard, tab]);

  const load = (which: Tab) => {
    setLoading(true);
    fetchBoard(which);
  };

  const current = TABS.find((t) => t.id === tab)!;
  const shown = loaded && loaded.tab === tab ? loaded : null;

  return (
    <section className="panel leaderboard" aria-labelledby="leaderboard-title">
      <div className="history-head">
        <h2 id="leaderboard-title">Leaderboard</h2>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label="Leaderboards">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={t.id === tab ? 'tab active' : 'tab'}
            onClick={() => {
              if (t.id === tab) return;
              setLoading(true);
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="hint">{current.blurb} Only player-vs-player matches count.</p>

      <div role="tabpanel" aria-label={current.label} aria-busy={loading}>
        {error ? (
          <p className="online-error" role="alert">
            Couldn't load the leaderboard: {error}
          </p>
        ) : !shown ? (
          <p className="hint">Loading…</p>
        ) : shown.tab === 'letters' ? (
          <LetterBests bests={shown.bests} />
        ) : (
          <Board view={shown.view} playerName={playerName} unit={tab === 'wins' ? 'wins' : 'points'} />
        )}
      </div>

      <div className="history-foot">
        <p className="hint">
          {updatedAt ? `Updated ${timeFormat.format(updatedAt)}. ` : ''}A match can take a few seconds to show up.
        </p>
        <button type="button" className="link" onClick={() => load(tab)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </section>
  );
}

function Board({ view, playerName, unit }: { view: LeaderboardView; playerName: string; unit: string }) {
  if (view.entries.length === 0) {
    return (
      <div className="empty-state">
        <p>No one is on this board yet.</p>
        <p className="hint">Finish an online match to get on it.</p>
      </div>
    );
  }
  const meListed = view.entries.some((e) => e.userId === view.myUserId);
  return (
    <>
      <ol className="board" aria-label={`Top ${view.entries.length}`}>
        {view.entries.map((e) => {
          const isMe = e.userId === view.myUserId;
          return (
            <li key={e.userId} className={isMe ? 'me' : undefined}>
              <span className="board-rank">{e.rank}</span>
              <span className="board-name">{isMe ? `${playerName} (you)` : e.name}</span>
              <span className="board-value" aria-label={`${e.value} ${unit}`}>
                {e.value}
              </span>
            </li>
          );
        })}
      </ol>
      {!meListed && (
        <p className="hint board-me">
          {view.me ? `You: #${view.me.rank} with ${view.me.value} ${unit}.` : "You're not on this board yet."}
        </p>
      )}
    </>
  );
}

function LetterBests({ bests }: { bests: Partial<Record<string, number>> }) {
  const played = ALPHABET.filter((l) => bests[l]).length;
  return (
    <>
      <ul className="letter-grid" aria-label="Your best score per letter">
        {ALPHABET.map((l) => (
          <li key={l} className={bests[l] ? 'has' : undefined}>
            <span className="letter-grid-letter">{l}</span>
            <span className="letter-grid-value">{bests[l] ?? '–'}</span>
          </li>
        ))}
      </ul>
      <p className="hint">
        {played} of 26 letters played · A–Z best {sumBests(bests)}
      </p>
    </>
  );
}
