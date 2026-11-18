import { useCallback, useEffect, useState } from 'react';
import type { Dictionary } from '../game/dictionary';
import {
  type MatchSettings,
  type MatchState,
  type SubmitResult,
  createMatch,
  finishAnswering,
  nextRound,
  submitWord,
  tick,
} from '../game/match';

const TICK_MS = 100;

/** Connects the pure match engine to React and the browser clock. */
export function useMatch(dictionary: Dictionary) {
  const [match, setMatch] = useState<MatchState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const playing = match?.phase === 'playing' || match?.phase === 'countdown';
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      setMatch((m) => (m ? tick(m, t) : m));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const start = useCallback(
    (settings: MatchSettings) => {
      const t = Date.now();
      setNow(t);
      setMatch(createMatch(settings, dictionary, t));
    },
    [dictionary],
  );

  const submit = useCallback(
    (input: string): SubmitResult | null => {
      if (!match) return null;
      const t = Date.now();
      const { state, result } = submitWord(match, dictionary, input, t);
      setNow(t);
      setMatch(state);
      return result;
    },
    [match, dictionary],
  );

  const next = useCallback(() => {
    const t = Date.now();
    setNow(t);
    setMatch((m) => (m ? nextRound(m, dictionary, t) : m));
  }, [dictionary]);

  const finish = useCallback(() => {
    const t = Date.now();
    setNow(t);
    setMatch((m) => (m ? finishAnswering(m, t) : m));
  }, []);

  const quit = useCallback(() => setMatch(null), []);

  return { match, now, start, submit, finish, next, quit };
}
