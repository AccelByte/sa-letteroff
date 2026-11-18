import { useState } from 'react';
import { DIFFICULTIES, type Difficulty } from '../game/bot';
import { type MatchSettings, ROUND_COUNTS, ROUND_SECONDS, type RoundCount, type RoundSeconds } from '../game/match';
import { DEFAULT_PLAYER_NAME, MAX_NAME_LENGTH } from '../game/player';
import { Choice } from './Choice';
import { HowToPlay } from './HowToPlay';
import { newSeed } from './seed';

interface Props {
  initial: Omit<MatchSettings, 'seed'> | null;
  playerName: string;
  onPlayerNameChange: (name: string) => void;
  historyCount: number;
  onShowHistory: () => void;
  onShowLeaderboard: () => void;
  onStart: (settings: MatchSettings) => void;
  onPlayOnline: (settings: { rounds: RoundCount; roundSeconds: RoundSeconds }) => void;
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const formatSeconds = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

export function SetupScreen({
  initial,
  playerName,
  onPlayerNameChange,
  historyCount,
  onShowHistory,
  onShowLeaderboard,
  onStart,
  onPlayOnline,
}: Props) {
  const [rounds, setRounds] = useState<RoundCount>(initial?.rounds ?? 3);
  const [roundSeconds, setRoundSeconds] = useState<RoundSeconds>(initial?.roundSeconds ?? 60);
  const [difficulty, setDifficulty] = useState<Difficulty>(initial?.difficulty ?? 'medium');

  return (
    <>
      <section className="panel setup" aria-labelledby="setup-title">
        <h2 id="setup-title" className="hero">
          One letter. One clock. <span className="accent">Out-word the bot, or a friend.</span>
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onStart({ rounds, roundSeconds, difficulty, seed: newSeed() });
          }}
        >
          <div className="field">
            <label htmlFor="player-name">Your name</label>
            <input
              id="player-name"
              value={playerName}
              onChange={(e) => onPlayerNameChange(e.target.value.slice(0, MAX_NAME_LENGTH))}
              placeholder={DEFAULT_PLAYER_NAME}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="nickname"
              autoCapitalize="words"
              spellCheck={false}
            />
          </div>
          <Choice
            legend="Rounds"
            name="rounds"
            options={ROUND_COUNTS}
            value={rounds}
            label={String}
            onChange={setRounds}
          />
          <Choice
            legend="Time per round"
            name="time"
            options={ROUND_SECONDS}
            value={roundSeconds}
            label={formatSeconds}
            onChange={setRoundSeconds}
          />
          <Choice
            legend="Bot (offline play)"
            name="difficulty"
            options={DIFFICULTIES}
            value={difficulty}
            label={(d) => DIFFICULTY_LABELS[d]}
            onChange={setDifficulty}
          />
          <button type="submit" className="primary wide">
            Play the bot
          </button>
          <button type="button" className="wide play-online" onClick={() => onPlayOnline({ rounds, roundSeconds })}>
            Play online
          </button>
          <button type="button" className="wide history-link" onClick={onShowHistory}>
            Match history{historyCount > 0 ? ` (${historyCount})` : ''}
          </button>
          <button type="button" className="wide history-link" onClick={onShowLeaderboard}>
            Leaderboard
          </button>
        </form>
      </section>
      <HowToPlay />
    </>
  );
}
