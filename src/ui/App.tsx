import { useEffect, useState } from 'react';
import type { Dictionary } from '../game/dictionary';
import { createRecord } from '../game/history';
import type { MatchSettings } from '../game/match';
import { displayName } from '../game/player';
import type { OnlineSettings } from '../game/online/protocol';
import { createProfileStore } from '../net/createBackend';
import { HistoryScreen } from './HistoryScreen';
import { LeaderboardScreen } from './LeaderboardScreen';
import type { SaveStatus } from './saveStatus';
import { OnlineGame } from './online/OnlineGame';
import { loadDictionary } from './loadDictionary';
import { BotGame } from './BotGame';
import { SetupScreen } from './SetupScreen';
import { newSeed } from './seed';
import { useMatch } from './useMatch';
import { useProfile } from './useProfile';
import './styles.css';

export function App() {
  const [dictionary, setDictionary] = useState<Dictionary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDictionary().then(setDictionary, (e: unknown) => setError(String(e)));
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <h1 className="brand">
          <span className="brand-tile" aria-hidden="true">
            L
          </span>
          LetterOff
        </h1>
      </header>
      {error ? (
        <p className="error" role="alert">
          Couldn't load the word list: {error}
        </p>
      ) : dictionary ? (
        <Game dictionary={dictionary} />
      ) : (
        <p className="loading">Loading words…</p>
      )}
    </main>
  );
}

function Game({ dictionary }: { dictionary: Dictionary }) {
  const { match, now, start, submit, finish, next, quit } = useMatch(dictionary);
  const [store] = useState(() => createProfileStore());
  const profile = useProfile(store);
  const { playerName, setPlayerName, history, recordMatch, clearHistory } = profile;
  const save: SaveStatus = {
    state: profile.sync === 'error' ? 'failed' : profile.sync === 'saved' ? 'saved' : 'saving',
    error: profile.syncError,
    retry: profile.retry,
  };
  const [lastSettings, setLastSettings] = useState<Omit<MatchSettings, 'seed'> | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [online, setOnline] = useState<OnlineSettings | null>(null);
  const name = displayName(playerName);

  // Save each finished match once (recordMatch ignores repeats of the same match).
  const finished = match?.phase === 'finished' ? match : null;
  useEffect(() => {
    if (!finished) return;
    const record = createRecord(finished, playerName, Date.now());
    if (record) recordMatch(record);
    // playerName is read at the moment the match finishes; later edits don't rewrite history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, recordMatch]);

  const begin = (settings: MatchSettings) => {
    setLastSettings({ rounds: settings.rounds, roundSeconds: settings.roundSeconds, difficulty: settings.difficulty });
    setShowHistory(false);
    start(settings);
  };

  const openHistory = () => {
    quit();
    setShowHistory(true);
  };

  if (showLeaderboard) {
    return <LeaderboardScreen store={store} playerName={name} onBack={() => setShowLeaderboard(false)} />;
  }
  if (online && !showHistory) {
    return (
      <OnlineGame
        dictionary={dictionary}
        playerName={name}
        initialSettings={online}
        save={save}
        onRecord={recordMatch}
        onShowHistory={() => setShowHistory(true)}
        onExit={() => setOnline(null)}
      />
    );
  }
  if (showHistory) {
    return (
      <HistoryScreen
        history={history}
        totals={profile.progress.totals}
        remoteKind={profile.remoteKind}
        pending={profile.pending}
        onBack={() => {
          setShowHistory(false);
          setOnline(null);
        }}
        onClear={clearHistory}
      />
    );
  }
  if (!match) {
    return (
      <SetupScreen
        initial={lastSettings}
        playerName={playerName}
        onPlayerNameChange={setPlayerName}
        historyCount={history.length}
        onShowHistory={openHistory}
        onShowLeaderboard={() => {
          quit();
          setShowLeaderboard(true);
        }}
        onStart={begin}
        onPlayOnline={(settings) => setOnline(settings)}
      />
    );
  }
  return (
    <BotGame
      match={match}
      now={now}
      playerName={name}
      save={save}
      onSubmit={submit}
      onFinish={finish}
      onNext={next}
      onQuit={quit}
      onPlayAgain={() => begin({ ...match.settings, seed: newSeed() })}
      onShowHistory={openHistory}
    />
  );
}
