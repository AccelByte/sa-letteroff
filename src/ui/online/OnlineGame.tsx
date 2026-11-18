import type { SaveStatus } from '../saveStatus';
import { useEffect, useState } from 'react';
import type { Dictionary } from '../../game/dictionary';
import { type MatchRecord, createOnlineRecord } from '../../game/history';
import { ROUND_COUNTS, ROUND_SECONDS, type RoundCount, type RoundSeconds } from '../../game/match';
import { QUICK_MATCH_SETTINGS, type OnlineSettings } from '../../game/online/protocol';
import type { OnlineMatchController, OnlineState } from '../../online/controller';
import type { BackendMode } from '../../net/backend';
import { Choice } from '../Choice';
import { ResultsScreen } from '../ResultsScreen';
import { RoundScreen, type RoundView } from '../RoundScreen';
import { RoundSummary } from '../RoundSummary';
import { useOnlineMatch } from './useOnlineMatch';

interface Props {
  dictionary: Dictionary;
  playerName: string;
  initialSettings: OnlineSettings;
  save: SaveStatus;
  onRecord: (record: MatchRecord) => void;
  onShowHistory: () => void;
  onExit: () => void;
}

const formatSeconds = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);
const describeSettings = (s: OnlineSettings | null) =>
  s ? `${s.rounds} ${s.rounds === 1 ? 'round' : 'rounds'} × ${formatSeconds(s.roundSeconds)}` : '';

export function OnlineGame({ dictionary, playerName, initialSettings, save, onRecord, onShowHistory, onExit }: Props) {
  const { controller, state, mode, configError } = useOnlineMatch(dictionary, playerName);

  // Save each finished match to history once.
  const finishedId = state?.stage === 'finished' ? state.sessionId : null;
  useEffect(() => {
    if (!finishedId || !state?.settings) return;
    onRecord(
      createOnlineRecord(
        {
          id: `${finishedId}-${state.userId}`,
          playerName,
          opponentName: state.opponent?.name ?? 'Opponent',
          rounds: state.settings.rounds,
          roundSeconds: state.settings.roundSeconds,
          results: state.results,
        },
        Date.now(),
      ),
    );
    // Only when a new match finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedId]);

  if (configError) {
    return (
      <section className="panel online">
        <h2>Online play isn't set up</h2>
        <p className="error" role="alert">
          {configError}
        </p>
        <button type="button" className="primary wide" onClick={onExit}>
          Back
        </button>
      </section>
    );
  }
  if (!controller || !state || state.stage === 'signing-in') {
    return (
      <section className="panel online" aria-busy="true">
        <p className="loading">Signing in as a guest…</p>
      </section>
    );
  }
  if (state.stage === 'fatal') {
    return (
      <section className="panel online">
        <h2>Couldn't connect</h2>
        <p className="error" role="alert">
          {state.error}
        </p>
        <button type="button" className="primary wide" onClick={onExit}>
          Back
        </button>
      </section>
    );
  }

  const opponentName = state.opponent?.name ?? 'Opponent';
  const leave = () => void controller.leave();

  switch (state.stage) {
    case 'menu':
      return (
        <OnlineMenu
          controller={controller}
          state={state}
          mode={mode}
          playerName={playerName}
          initialSettings={initialSettings}
          onExit={onExit}
        />
      );
    case 'matchmaking':
      return <MatchmakingScreen state={state} onCancel={() => void controller.cancelMatchmaking()} />;
    case 'room':
      return <RoomScreen controller={controller} state={state} playerName={playerName} />;
    case 'countdown':
    case 'playing': {
      const view: RoundView = {
        roundNumber: state.roundIndex + 1,
        totalRounds: state.settings?.rounds ?? 1,
        phase:
          state.stage === 'countdown' ? 'countdown' : state.myFinished || state.timeLeftMs <= 0 ? 'locked' : 'playing',
        letter: state.letter,
        countdownMs: state.countdownMs,
        timeLeftMs: state.timeLeftMs,
        roundMs: state.roundMs,
        playerName,
        myWords: state.myWords,
        pendingWords: state.pendingWords,
        takenWords: state.takenWords,
        lostWord: state.lostWord,
        opponent: { name: opponentName, words: state.opponentWords, hidden: false, finished: state.opponentFinished },
        hint: 'Each word can only be played once per round: whoever plays it first keeps it. You see each other’s words as you play.',
        status: statusLine(state, opponentName),
      };
      return (
        <RoundScreen
          view={view}
          onSubmit={(input) => controller.submitWord(input)}
          onFinish={() => controller.finishAnswering()}
          onQuit={leave}
          quitLabel="Leave match"
        />
      );
    }
    case 'round-over': {
      const result = state.results[state.results.length - 1];
      if (!result) return null;
      const nextRound = state.roundIndex + 2;
      return (
        <RoundSummary
          result={result}
          roundNumber={state.roundIndex + 1}
          totalRounds={state.settings?.rounds ?? 1}
          playerName={playerName}
          opponentName={opponentName}
          next={
            state.role === 'host'
              ? {
                  label: state.startQueued
                    ? `Starting when ${opponentName} has the result…`
                    : `Start round ${nextRound}`,
                  onClick: () => void controller.startNextRound(),
                }
              : null
          }
          waitingText={`Waiting for ${opponentName} to start round ${nextRound}…`}
          status={statusLine(state, opponentName)}
          onLeave={leave}
        />
      );
    }
    case 'finished':
    case 'ended':
      return (
        <ResultsScreen
          results={state.results}
          eyebrow={`${state.stage === 'finished' ? 'Match over' : 'Match ended'} · online vs ${opponentName}`}
          playerName={playerName}
          opponentName={opponentName}
          opponentWinsText={`${opponentName} wins`}
          notice={
            state.stage === 'ended'
              ? state.endReason === 'opponent-left'
                ? state.results.length > 0
                  ? `${opponentName} left the match. Scores below are from the rounds you finished.`
                  : `${opponentName} left the match before the first round finished.`
                : 'You lost your connection to the match.'
              : null
          }
          headline={state.stage === 'ended' ? 'Match ended' : undefined}
          primary={{ label: 'Back to online menu', onClick: leave }}
          secondary={{
            label: 'Home',
            onClick: () => {
              leave();
              onExit();
            },
          }}
          saved={state.stage === 'finished' ? save.state : 'not-saved'}
          ranked
          saveError={save.error}
          onRetrySave={save.retry}
          onShowHistory={() => {
            leave();
            onShowHistory();
          }}
        />
      );
  }
}

function statusLine(state: OnlineState, opponentName: string): string | null {
  if (state.opponent?.presence === 'reconnecting') {
    return `${opponentName}'s connection dropped. Waiting for them to come back…`;
  }
  if (state.syncTrouble) return 'Connection problem. Retrying…';
  return null;
}

function OnlineMenu({
  controller,
  state,
  mode,
  playerName,
  initialSettings,
  onExit,
}: {
  controller: OnlineMatchController;
  state: OnlineState;
  mode: BackendMode | null;
  playerName: string;
  initialSettings: OnlineSettings;
  onExit: () => void;
}) {
  const [rounds, setRounds] = useState<RoundCount>(initialSettings.rounds);
  const [roundSeconds, setRoundSeconds] = useState<RoundSeconds>(initialSettings.roundSeconds);
  const [code, setCode] = useState('');

  return (
    <section className="panel online" aria-labelledby="online-title">
      <div className="online-head">
        <h2 id="online-title">Play online</h2>
        <span className={`backend-badge ${mode ?? ''}`} title="Set by VITE_BACKEND_MODE">
          {mode === 'ags' ? 'AccelByte' : 'Local test mode'}
        </span>
      </div>
      <p className="hint online-who">
        Playing as <strong>{playerName}</strong> (guest)
        {mode === 'mock' && ' · open another tab or window to play yourself'}
      </p>
      {state.error && (
        <p className="error online-error" role="alert">
          {state.error}
        </p>
      )}

      <div className="online-block">
        <h3>Create a room</h3>
        <Choice
          legend="Rounds"
          name="online-rounds"
          options={ROUND_COUNTS}
          value={rounds}
          label={String}
          onChange={setRounds}
        />
        <Choice
          legend="Time per round"
          name="online-time"
          options={ROUND_SECONDS}
          value={roundSeconds}
          label={formatSeconds}
          onChange={setRoundSeconds}
        />
        <button
          type="button"
          className="primary wide"
          disabled={state.busy}
          onClick={() => void controller.createRoom({ rounds, roundSeconds })}
        >
          Create room
        </button>
      </div>

      <form
        className="online-block"
        onSubmit={(e) => {
          e.preventDefault();
          void controller.joinByCode(code);
        }}
      >
        <h3>
          <label htmlFor="room-code">Join with a code</label>
        </h3>
        <div className="code-entry">
          <input
            id="room-code"
            value={code}
            onChange={(e) => {
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/[^0-9A-Z]/g, '')
                  .slice(0, 6),
              );
              controller.clearError();
            }}
            placeholder="ABC123"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={6}
          />
          <button type="submit" disabled={state.busy || code.length < 6}>
            Join
          </button>
        </div>
      </form>

      <div className="online-block">
        <h3>Quick match</h3>
        <p className="hint">Play a random opponent: {describeSettings(QUICK_MATCH_SETTINGS)}.</p>
        <button type="button" className="wide" disabled={state.busy} onClick={() => void controller.quickMatch()}>
          Find an opponent
        </button>
      </div>

      <button type="button" className="link back-link" onClick={onExit}>
        Back to home
      </button>
    </section>
  );
}

function MatchmakingScreen({ state, onCancel }: { state: OnlineState; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const seconds = state.matchmakingSince ? Math.max(0, Math.floor((now - state.matchmakingSince) / 1000)) : 0;
  return (
    <section className="panel online matchmaking" aria-live="polite">
      <p className="eyebrow">Quick match · {describeSettings(QUICK_MATCH_SETTINGS)}</p>
      <h2>Finding an opponent…</h2>
      <p className="scoreline" aria-label={`${seconds} seconds`}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </p>
      <div className="spinner" aria-hidden="true" />
      <button type="button" className="wide" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function RoomScreen({
  controller,
  state,
  playerName,
}: {
  controller: OnlineMatchController;
  state: OnlineState;
  playerName: string;
}) {
  const [copied, setCopied] = useState(false);
  const opponent = state.opponent;
  const opponentHere = opponent?.presence === 'present';
  const isHost = state.role === 'host';

  const copy = async () => {
    if (!state.code) return;
    try {
      await navigator.clipboard.writeText(state.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="panel online room" aria-labelledby="room-title">
      <p className="eyebrow">{describeSettings(state.settings)}</p>
      <h2 id="room-title">{isHost ? 'Your room' : 'Room'}</h2>
      {state.code && (
        <div className="room-code">
          <span className="room-code-label">Room code</span>
          <span className="room-code-value" aria-label={`Room code ${state.code.split('').join(' ')}`}>
            {state.code}
          </span>
          <button type="button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
      )}
      {isHost && !opponentHere && <p className="hint">Send this code to a friend. They join from Play online.</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}

      <ul className="players" aria-label="Players">
        <li>
          <span className="player-name">{playerName}</span>
          <span className="player-tag">{isHost ? 'Host · you' : 'You'}</span>
        </li>
        <li className={opponentHere ? undefined : 'empty-seat'}>
          {opponentHere ? (
            <>
              <span className="player-name">{opponent.name}</span>
              <span className="player-tag">{isHost ? 'Guest' : 'Host'}</span>
            </>
          ) : opponent?.presence === 'reconnecting' ? (
            <span className="player-name">{opponent.name} is reconnecting…</span>
          ) : (
            <span className="player-name">Waiting for a friend to join…</span>
          )}
        </li>
      </ul>

      {isHost ? (
        <button
          type="button"
          className="primary wide"
          disabled={!opponentHere}
          onClick={() => void controller.startNextRound()}
        >
          Start match
        </button>
      ) : (
        <p className="waiting" role="status">
          Waiting for {opponent?.name ?? 'the host'} to start the match…
        </p>
      )}
      <button type="button" className="link leave-link" onClick={() => void controller.leave()}>
        Leave room
      </button>
    </section>
  );
}
