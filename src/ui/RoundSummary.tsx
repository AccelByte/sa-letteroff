import type { RoundResult } from '../game/scoring';
import { RoundWords } from './RoundWords';

interface Props {
  result: RoundResult;
  roundNumber: number;
  totalRounds: number;
  playerName: string;
  opponentName: string;
  /** How the opponent is named in a sentence, e.g. "The bot". Defaults to opponentName. */
  opponentSentenceName?: string;
  /** The button to continue, or null when someone else starts the next round. */
  next: { label: string; onClick: () => void } | null;
  waitingText?: string;
  status?: string | null;
  onLeave?: () => void;
}

export function RoundSummary({
  result,
  roundNumber,
  totalRounds,
  playerName,
  opponentName,
  opponentSentenceName = opponentName,
  next,
  waitingText,
  status,
  onLeave,
}: Props) {
  const verdict =
    result.playerScore > result.botScore
      ? 'You took this round'
      : result.botScore > result.playerScore
        ? `${opponentSentenceName} took this round`
        : 'This round is a tie';

  return (
    <section className="panel summary">
      {status && (
        <p className="status-banner" role="status">
          {status}
        </p>
      )}
      <p className="eyebrow">
        Round {roundNumber} of {totalRounds} · Letter {result.letter}
      </p>
      <h2>{verdict}</h2>
      <p className="scoreline" aria-label={`You ${result.playerScore}, ${opponentName} ${result.botScore}`}>
        <span>{result.playerScore}</span>
        <span className="dash">–</span>
        <span>{result.botScore}</span>
      </p>
      <RoundWords result={result} playerName={playerName} opponentName={opponentName} />
      {next ? (
        <button type="button" className="primary wide" onClick={next.onClick} autoFocus>
          {next.label}
        </button>
      ) : (
        <p className="waiting" role="status">
          {waitingText}
        </p>
      )}
      {onLeave && (
        <button type="button" className="link leave-link" onClick={onLeave}>
          Leave match
        </button>
      )}
    </section>
  );
}
