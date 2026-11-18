/** How saving the last finished match is going, for the results screen. */
export interface SaveStatus {
  state: 'saving' | 'saved' | 'failed';
  error: string | null;
  retry: () => void;
}
