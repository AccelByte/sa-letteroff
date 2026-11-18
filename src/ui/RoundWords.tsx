import type { RoundResult } from '../game/scoring';

/** Both sides' words for a finished round, side by side. Words both played are struck through and score 0. */
export function RoundWords({
  result,
  playerName,
  opponentName = 'Bot',
}: {
  result: RoundResult;
  playerName: string;
  opponentName?: string;
}) {
  const shared = new Set(result.shared);

  const column = (title: string, words: readonly string[], score: number) => (
    <div className="column">
      <h3>
        <span className="name">{title}</span> <span className="count">{score}</span>
      </h3>
      {words.length === 0 ? (
        <p className="empty">No words</p>
      ) : (
        <ul className="word-rows">
          {words.map((w) => {
            const both = shared.has(w);
            return (
              <li key={w} className={both ? 'shared' : undefined}>
                <span className="word">{both ? <s>{w}</s> : w}</span>
                <span className="points" aria-label={both ? '0 points, both played it' : '1 point'}>
                  {both ? '0' : '+1'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <>
      <div className="columns">
        {column(playerName, result.playerWords, result.playerScore)}
        {column(opponentName, result.botWords, result.botScore)}
      </div>
      {result.shared.length > 0 && (
        <p className="hint">
          {result.shared.length === 1 ? '1 word was' : `${result.shared.length} words were`} played by both of you and
          scored 0.
        </p>
      )}
    </>
  );
}
