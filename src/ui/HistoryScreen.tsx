import { useState } from 'react';
import { HISTORY_LIMIT, type MatchRecord } from '../game/history';
import { type LifetimeTotals, overallTotals } from '../game/progress';
import { RoundWords } from './RoundWords';

interface Props {
  history: readonly MatchRecord[];
  totals: LifetimeTotals;
  /** Where history is saved: AGS Cloud Save, or this browser (mock mode). */
  remoteKind: 'ags' | 'local';
  /** Finished matches not saved yet. */
  pending: number;
  onBack: () => void;
  onClear: () => void;
}

const OUTCOME_LABELS = { player: 'Win', bot: 'Loss', draw: 'Draw' } as const;
const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' } as const;

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Short opponent label for a history row. */
function opponentLabel(r: MatchRecord): string {
  return r.mode === 'online' ? `vs ${r.opponentName ?? 'Opponent'}` : DIFFICULTY_LABELS[r.difficulty ?? 'medium'];
}

function opponentLong(r: MatchRecord): string {
  return r.mode === 'online'
    ? `${r.opponentName ?? 'Opponent'} (online)`
    : `${DIFFICULTY_LABELS[r.difficulty ?? 'medium']} bot`;
}

const formatSeconds = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

export function HistoryScreen({ history, totals, remoteKind, pending, onBack, onClear }: Props) {
  const stats = overallTotals(totals);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="panel history" aria-labelledby="history-title">
      <div className="history-head">
        <h2 id="history-title">Match history</h2>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>

      {pending > 0 && (
        <p className="status-banner" role="status">
          {pending} finished {pending === 1 ? 'match is' : 'matches are'} waiting to be saved.
        </p>
      )}
      {history.length === 0 && stats.played === 0 ? (
        <div className="empty-state">
          <p>No matches yet.</p>
          <p className="hint">
            Every match you finish is saved here, up to the last {HISTORY_LIMIT}. Matches you quit aren't saved.
          </p>
          <button type="button" className="primary" onClick={onBack}>
            Play a match
          </button>
        </div>
      ) : (
        <>
          <dl className="stats">
            <div>
              <dt>Played</dt>
              <dd>{stats.played}</dd>
            </div>
            <div>
              <dt>Won</dt>
              <dd className="accent">{stats.wins}</dd>
            </div>
            <div>
              <dt>Lost</dt>
              <dd>{stats.losses}</dd>
            </div>
            <div>
              <dt>Drawn</dt>
              <dd>{stats.draws}</dd>
            </div>
          </dl>
          <p className="hint lifetime-note">
            Lifetime: {totals.online.played} online ({totals.online.wins} won) · {totals.bot.played} vs the bot (
            {totals.bot.wins} won)
          </p>

          <ol className="history-list">
            {history.map((r) => (
              <li key={r.id}>
                <details>
                  <summary>
                    <span className={`outcome ${r.winner}`}>{OUTCOME_LABELS[r.winner]}</span>
                    <span className="history-main">
                      <span className="history-score">
                        {r.playerTotal} – {r.botTotal}
                      </span>
                      <span className="history-meta">
                        {r.results.map((x) => x.letter).join(' ')} · {opponentLabel(r)} ·{' '}
                        {formatSeconds(r.roundSeconds)}
                      </span>
                    </span>
                    <time dateTime={r.playedAt}>{dateFormat.format(new Date(r.playedAt))}</time>
                  </summary>
                  <div className="history-detail">
                    <p className="hint">
                      {r.playerName} vs {opponentLong(r)} · {r.rounds} {r.rounds === 1 ? 'round' : 'rounds'} of{' '}
                      {formatSeconds(r.roundSeconds)}
                    </p>
                    {r.trimmed && <p className="hint">Words aren't kept for older matches; scores are.</p>}
                    {r.results.map((result, i) => (
                      <div key={result.letter} className="history-round">
                        <h4>
                          Round {i + 1} · {result.letter}
                        </h4>
                        <RoundWords result={result} playerName={r.playerName} />
                      </div>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ol>

          <div className="history-foot">
            <p className="hint">
              {remoteKind === 'ags'
                ? 'Saved to your AGS account (private Cloud Save record).'
                : 'Saved in this browser.'}{' '}
              Keeps your last {HISTORY_LIMIT} matches; totals count every match.
            </p>
            {confirming ? (
              <div className="confirm" role="group" aria-label="Confirm clearing history">
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    onClear();
                    setConfirming(false);
                  }}
                >
                  Delete {history.length} {history.length === 1 ? 'match' : 'matches'} (totals stay)
                </button>
                <button type="button" onClick={() => setConfirming(false)} autoFocus>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="link" onClick={() => setConfirming(true)}>
                Clear history
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
