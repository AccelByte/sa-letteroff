import { type RoundResult, matchTotals } from '../game/scoring';
import { RoundWords } from './RoundWords';

interface Action {
  label: string;
  onClick: () => void;
}

interface Props {
  results: readonly RoundResult[];
  eyebrow: string;
  playerName: string;
  opponentName: string;
  /** Headline when the opponent wins, e.g. "The bot wins". */
  opponentWinsText: string;
  /** Extra line above the score, e.g. why the match ended early. */
  notice?: string | null;
  /** Replaces the win/lose headline, e.g. when a match ended early. */
  headline?: string;
  primary: Action;
  secondary?: Action;
  saved: 'saving' | 'saved' | 'failed' | 'not-saved';
  /** Online matches count toward the leaderboards; bot matches only go to history. */
  ranked?: boolean;
  /** Why saving failed, shown with a retry button. */
  saveError?: string | null;
  onRetrySave?: () => void;
  onShowHistory: () => void;
}

export function ResultsScreen({
  results,
  eyebrow,
  playerName,
  opponentName,
  opponentWinsText,
  notice,
  headline: headlineOverride,
  primary,
  secondary,
  saved,
  ranked = false,
  saveError,
  onRetrySave,
  onShowHistory,
}: Props) {
  const totals = matchTotals(results);
  const computed = totals.winner === 'player' ? 'You win!' : totals.winner === 'bot' ? opponentWinsText : "It's a draw";
  return (
    <section className="panel results">
      <p className="eyebrow">{eyebrow}</p>
      {notice && (
        <p className="status-banner" role="status">
          {notice}
        </p>
      )}
      <h2 className={headlineOverride ? 'headline' : `headline ${totals.winner}`}>{headlineOverride ?? computed}</h2>
      {results.length > 0 && (
        <p className="scoreline big" aria-label={`You ${totals.player}, ${opponentName} ${totals.bot}`}>
          <span>{totals.player}</span>
          <span className="dash">–</span>
          <span>{totals.bot}</span>
        </p>
      )}

      {results.length > 0 && (
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Letter</th>
              <th scope="col" className="num name-cell">
                {playerName}
              </th>
              <th scope="col" className="num name-cell">
                {opponentName}
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={r.letter}>
                <td>{i + 1}</td>
                <td className="table-letter">{r.letter}</td>
                <td className={r.playerScore > r.botScore ? 'num win' : 'num'}>{r.playerScore}</td>
                <td className={r.botScore > r.playerScore ? 'num win' : 'num'}>{r.botScore}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                Total
              </th>
              <td className="num">{totals.player}</td>
              <td className="num">{totals.bot}</td>
            </tr>
          </tfoot>
        </table>
      )}

      <div className="round-details">
        {results.map((r, i) => (
          <details key={r.letter} open={results.length === 1}>
            <summary>
              Round {i + 1} · {r.letter} words
            </summary>
            <RoundWords result={r} playerName={playerName} opponentName={opponentName} />
          </details>
        ))}
      </div>

      <div className="actions">
        <button type="button" className="primary" onClick={primary.onClick} autoFocus>
          {primary.label}
        </button>
        {secondary && (
          <button type="button" onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
      </div>
      {saved !== 'not-saved' && (
        <p className="hint saved-note" role="status">
          {saved === 'failed' ? (
            <>
              Couldn't save this match yet{saveError ? ` (${saveError})` : ''}. It's kept and will be saved next time.{' '}
              {onRetrySave && (
                <button type="button" className="link inline" onClick={onRetrySave}>
                  Try again
                </button>
              )}
            </>
          ) : saved === 'saving' ? (
            'Saving…'
          ) : (
            <>
              Saved to{' '}
              <button type="button" className="link inline" onClick={onShowHistory}>
                match history
              </button>
              {ranked ? ' · counts toward the leaderboards' : " · bot matches don't count toward the leaderboards"}
            </>
          )}
        </p>
      )}
    </section>
  );
}
