import { useEffect, useRef, useState } from 'react';
import type { SubmitResult } from '../game/match';

/**
 * Everything the round screen shows. Bot matches and online matches build
 * this from their own state, so both use the same screen.
 */
export interface RoundView {
  roundNumber: number;
  totalRounds: number;
  /** `countdown` hides the letter; `locked` means this player has finished answering. */
  phase: 'countdown' | 'playing' | 'locked';
  letter: string | null;
  countdownMs: number;
  timeLeftMs: number;
  roundMs: number;
  playerName: string;
  myWords: readonly string[];
  /** Online guest: words waiting for the host to confirm. */
  pendingWords?: readonly string[];
  /** Online guest: words the opponent turned out to have played first. Shown struck through, not counted. */
  takenWords?: readonly string[];
  /** Shown as a rejection when one of this player's words turns out to be taken; `key` changes each time. */
  lostWord?: { word: string; key: number } | null;
  opponent: {
    name: string;
    words: readonly string[];
    /** Bot words stay hidden until the round ends; an online opponent's words show live. */
    hidden: boolean;
    finished?: boolean;
  };
  hint: string;
  /** Optional banner, for example a dropped connection. */
  status?: string | null;
}

interface Props {
  view: RoundView;
  onSubmit: (input: string) => SubmitResult | null;
  onFinish: () => void;
  onQuit: () => void;
  quitLabel?: string;
}

/** The clock turns red for the last stretch of every round. */
const URGENT_MS = 10_000;

type Feedback = { tone: 'good' | 'bad'; text: string } | null;

function describe(result: SubmitResult, letter: string, opponentName: string): Feedback {
  if (result.ok) {
    return 'pending' in result
      ? { tone: 'good', text: `“${result.word}” sent, checking ${opponentName} didn't play it first…` }
      : { tone: 'good', text: `“${result.word}” +1` };
  }
  switch (result.reason) {
    case 'empty':
      return null;
    case 'wrong-letter':
      return { tone: 'bad', text: `“${result.word}” doesn't start with ${letter}` };
    case 'already-used':
      return { tone: 'bad', text: `You already played “${result.word}”` };
    case 'not-a-word':
      return { tone: 'bad', text: `“${result.word}” isn't in the word list` };
    case 'round-over':
      return { tone: 'bad', text: "Time's up" };
    case 'not-started':
      return { tone: 'bad', text: 'Wait for the letter' };
    case 'taken':
      return { tone: 'bad', text: `${opponentName} already played “${result.word}”` };
  }
}

function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function RoundScreen({ view, onSubmit, onFinish, onQuit, quitLabel = 'Quit match' }: Props) {
  const [input, setInput] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const counting = view.phase === 'countdown';
  const locked = view.phase === 'locked';
  const letter = view.letter ?? '';
  const left = view.timeLeftMs;
  const urgent = !counting && left <= URGENT_MS;
  const fraction = view.roundMs > 0 ? left / view.roundMs : 0;
  const countdown = Math.max(1, Math.ceil(view.countdownMs / 1000));
  const { opponent } = view;
  const pending = new Set(view.pendingWords ?? []);
  const taken = new Set(view.takenWords ?? []);
  // Confirmed words only; words still waiting for the host are shown separately.
  const myScore = view.myWords.length - taken.size - pending.size;
  const lost = view.lostWord;

  // Tell the player when a word they sent turns out to be the opponent's
  // (state adjusted during render, so it shows in the same paint).
  const [lostKey, setLostKey] = useState(lost?.key ?? 0);
  if (lost && lost.key !== lostKey) {
    setLostKey(lost.key);
    setFeedback({ tone: 'bad', text: `${opponent.name} played “${lost.word}” first` });
  }

  // Keep the input focused for the whole round, including when the countdown ends.
  useEffect(() => {
    inputRef.current?.focus();
  }, [view.roundNumber, counting]);

  const submit = () => {
    const result = onSubmit(input);
    inputRef.current?.focus();
    if (!result) return;
    setFeedback(describe(result, letter, opponent.name));
    if (result.ok || result.reason === 'already-used') {
      setInput('');
    } else {
      // Keep a mistyped word so it can be fixed; selecting it lets the next keystroke replace it.
      requestAnimationFrame(() => inputRef.current?.select());
    }
  };

  return (
    <section className="round" aria-label={`Round ${view.roundNumber}`}>
      {view.status && (
        <p className="status-banner" role="status">
          {view.status}
        </p>
      )}
      <div className="round-bar">
        <span className="round-count">
          Round <strong>{view.roundNumber}</strong> / {view.totalRounds}
        </span>
        <span className={urgent ? 'clock urgent' : 'clock'} role="timer" aria-label={`${formatClock(left)} left`}>
          {formatClock(left)}
        </span>
      </div>
      <div className={urgent ? 'timer-track urgent' : 'timer-track'} aria-hidden="true">
        <div style={{ transform: `scaleX(${fraction})` }} />
      </div>

      {counting ? (
        <div className="letter-tile countdown" aria-live="assertive">
          <span className="countdown-label">Get ready</span>
          <span key={countdown} className="countdown-number">
            {countdown}
          </span>
        </div>
      ) : (
        <div className="letter-tile" aria-label={`Letter ${letter}`}>
          {letter}
        </div>
      )}

      <form
        className="word-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={feedback?.tone === 'bad' ? 'word-input invalid' : 'word-input'}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (feedback?.tone === 'bad') setFeedback(null);
            }}
            placeholder={counting ? 'Get ready…' : locked ? 'Answers locked' : `Words starting with ${letter}`}
            aria-label="Your word"
            aria-describedby="word-feedback"
            aria-invalid={feedback?.tone === 'bad'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            maxLength={40}
            disabled={locked}
          />
          <button
            type="submit"
            className="primary"
            disabled={counting || locked}
            // Stop the button taking focus, so the phone keyboard stays open.
            onPointerDown={(e) => e.preventDefault()}
          >
            Enter
          </button>
        </div>
        <p id="word-feedback" className={`feedback ${feedback?.tone ?? ''}`} role="status" aria-live="polite">
          {locked ? `Answers locked. Waiting for ${opponent.name}…` : (feedback?.text ?? ' ')}
        </p>
      </form>

      <div className="columns live">
        <div className="column">
          <h3>
            <span className="name">{view.playerName}</span>{' '}
            <span className="count">
              {myScore}
              {pending.size > 0 && (
                <span className="count-pending" aria-label={`${pending.size} waiting for confirmation`}>
                  {' '}
                  +{pending.size}
                </span>
              )}
            </span>
          </h3>
          <ul className="word-rows">
            {[...view.myWords].reverse().map((w) =>
              taken.has(w) ? (
                <li key={w} className="taken">
                  <span className="word">
                    <s>{w}</s>
                  </span>
                  <span className="tag">{opponent.name}’s</span>
                </li>
              ) : (
                <li key={w} className={pending.has(w) ? 'pending' : undefined}>
                  <span className="word">{w}</span>
                  {pending.has(w) && (
                    <span className="tag" aria-label="waiting for confirmation">
                      …
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        </div>
        <div className="column">
          <h3>
            <span className="name">{opponent.name}</span> <span className="count">{opponent.words.length}</span>
          </h3>
          {opponent.hidden ? (
            <ul
              className="word-rows hidden-words"
              aria-label={`${opponent.name} has played ${opponent.words.length} words, hidden until the round ends`}
            >
              {opponent.words.map((_, i) => (
                <li key={i} aria-hidden="true">
                  <span className="word">••••••</span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="word-rows opponent-words" aria-label={`${opponent.name}'s words`}>
              {[...opponent.words].reverse().map((w) => (
                <li key={w}>
                  <span className="word">{w}</span>
                </li>
              ))}
            </ul>
          )}
          {opponent.finished && <p className="column-note">Finished answering</p>}
        </div>
      </div>
      <p className="hint">{view.hint}</p>

      <div className="round-actions">
        <button type="button" onClick={onFinish} disabled={counting || locked}>
          Finish answering
        </button>
        <button type="button" className="link" onClick={onQuit}>
          {quitLabel}
        </button>
      </div>
    </section>
  );
}
