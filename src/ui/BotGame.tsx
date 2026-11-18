import type { SaveStatus } from './saveStatus';
import { botWordsSoFar, countdownLeftMs, currentLetter, type MatchState, roundMs, timeLeftMs } from '../game/match';
import type { SubmitResult } from '../game/match';
import { ResultsScreen } from './ResultsScreen';
import { RoundScreen, type RoundView } from './RoundScreen';
import { RoundSummary } from './RoundSummary';

interface Props {
  match: MatchState;
  now: number;
  playerName: string;
  save: SaveStatus;
  onSubmit: (input: string) => SubmitResult | null;
  onFinish: () => void;
  onNext: () => void;
  onQuit: () => void;
  onPlayAgain: () => void;
  onShowHistory: () => void;
}

/** A match against the bot, drawn with the shared round, summary and results screens. */
export function BotGame({
  match,
  now,
  playerName,
  save,
  onSubmit,
  onFinish,
  onNext,
  onQuit,
  onPlayAgain,
  onShowHistory,
}: Props) {
  if (match.phase === 'countdown' || match.phase === 'playing') {
    const view: RoundView = {
      roundNumber: match.roundIndex + 1,
      totalRounds: match.settings.rounds,
      phase: match.phase,
      letter: match.phase === 'playing' ? currentLetter(match) : null,
      countdownMs: countdownLeftMs(match, now),
      timeLeftMs: timeLeftMs(match, now),
      roundMs: roundMs(match),
      playerName,
      myWords: match.playerWords,
      opponent: { name: 'Bot', words: botWordsSoFar(match), hidden: true },
      hint: 'Each word can only be played once per round. Bot words stay hidden until the round ends.',
    };
    return <RoundScreen view={view} onSubmit={onSubmit} onFinish={onFinish} onQuit={onQuit} />;
  }

  if (match.phase === 'round-over') {
    return (
      <RoundSummary
        result={match.results[match.results.length - 1]!}
        roundNumber={match.roundIndex + 1}
        totalRounds={match.settings.rounds}
        playerName={playerName}
        opponentName="Bot"
        opponentSentenceName="The bot"
        next={{ label: `Start round ${match.roundIndex + 2}`, onClick: onNext }}
      />
    );
  }

  return (
    <ResultsScreen
      results={match.results}
      eyebrow={`Match over · ${match.settings.difficulty} bot`}
      playerName={playerName}
      opponentName="Bot"
      opponentWinsText="The bot wins"
      primary={{ label: 'Play again', onClick: onPlayAgain }}
      secondary={{ label: 'Change settings', onClick: onQuit }}
      saved={save.state}
      saveError={save.error}
      onRetrySave={save.retry}
      onShowHistory={onShowHistory}
    />
  );
}
