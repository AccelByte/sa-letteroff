import { useCallback, useEffect, useState } from 'react';
import type { MatchRecord } from '../game/history';
import { type Progress, emptyProgress } from '../game/progress';
import { describeError } from '../net/backend';
import type { ProfileStore } from '../net/profile/profileStore';
import { loadPlayerName, savePlayerName } from './storage';

export type SyncState = 'loading' | 'saving' | 'saved' | 'error';

/**
 * The player's name (this browser), and their saved matches, lifetime totals
 * and rankings (AGS Cloud Save in AGS mode, localStorage in mock mode).
 */
export function useProfile(store: ProfileStore) {
  const [playerName, setPlayerNameState] = useState(loadPlayerName);
  const [progress, setProgress] = useState<Progress>(() => emptyProgress());
  const [sync, setSync] = useState<SyncState>('loading');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  // Applies the result of a load or save. Only called from promise callbacks.
  const settle = (task: Promise<Progress>) =>
    task.then(
      (next) => {
        setProgress(next);
        setSync('saved');
        setSyncError(null);
        setPending(store.pendingCount);
      },
      (error: unknown) => {
        // Keep showing what we have, including a match that is waiting to be saved.
        setProgress(store.current);
        setSync('error');
        setSyncError(describeError(error));
        setPending(store.pendingCount);
      },
    );

  useEffect(() => {
    let cancelled = false;
    store.load().then(
      (next) => {
        if (cancelled) return;
        setProgress(next);
        setSync('saved');
        setPending(store.pendingCount);
      },
      (error: unknown) => {
        if (cancelled) return;
        setProgress(store.current);
        setSync('error');
        setSyncError(describeError(error));
        setPending(store.pendingCount);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  const setPlayerName = (name: string) => {
    setPlayerNameState(name);
    savePlayerName(name);
  };

  /** Saves a finished match. Safe to call twice for the same match. */
  const recordMatch = useCallback(
    (record: MatchRecord) => {
      setSync('saving');
      void settle(store.saveMatch(record));
    },
    // settle only uses the store and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );

  /** Tries again to load and save anything waiting. */
  const retry = () => {
    setSync('saving');
    void settle(store.load());
  };

  const clearHistory = () => {
    setSync('saving');
    void settle(store.clearMatches());
  };

  return {
    playerName,
    setPlayerName,
    progress,
    history: progress.matches,
    recordMatch,
    clearHistory,
    retry,
    sync,
    syncError,
    pending,
    saveFailed: sync === 'error',
    remoteKind: store.remote.kind,
  };
}
