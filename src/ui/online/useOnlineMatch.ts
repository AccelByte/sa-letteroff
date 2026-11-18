import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Dictionary } from '../../game/dictionary';
import { type OnlineState, OnlineMatchController } from '../../online/controller';
import { type BackendMode, describeError } from '../../net/backend';
import { createBackend } from '../../net/createBackend';

interface Session {
  controller: OnlineMatchController | null;
  mode: BackendMode | null;
  error: string | null;
}

/** Creates the backend and controller while the online screens are open, and tears them down after. */
export function useOnlineMatch(dictionary: Dictionary, playerName: string) {
  const [session, setSession] = useState<Session>({ controller: null, mode: null, error: null });

  useEffect(() => {
    let backend: ReturnType<typeof createBackend>;
    try {
      backend = createBackend();
    } catch (error) {
      // Report a configuration problem (missing env variables) instead of crashing.
      queueMicrotask(() => setSession({ controller: null, mode: null, error: describeError(error) }));
      return;
    }
    const controller = new OnlineMatchController({ backend, dictionary, playerName });
    queueMicrotask(() => setSession({ controller, mode: backend.mode, error: null }));
    void controller.start();
    const onPageHide = () => controller.handlePageHide();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      void controller.leave();
      controller.dispose();
      backend.dispose();
    };
    // The controller lives for as long as the online screens are open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictionary]);

  const { controller } = session;
  useEffect(() => {
    controller?.setPlayerName(playerName);
  }, [controller, playerName]);

  const state = useSyncExternalStore(
    (onChange) => controller?.subscribe(onChange) ?? (() => undefined),
    () => controller?.getState() ?? null,
  );

  return { controller, state: state as OnlineState | null, mode: session.mode, configError: session.error };
}
