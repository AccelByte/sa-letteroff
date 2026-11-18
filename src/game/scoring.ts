/**
 * Round and match scoring. A word scores 1 point for whoever played it,
 * unless both sides played it, in which case it cancels for both.
 */

export type Side = 'player' | 'bot';
export type Outcome = Side | 'draw';

export interface RoundResult {
  letter: string;
  /** Every accepted word, in the order it was played. */
  playerWords: readonly string[];
  botWords: readonly string[];
  /** Words both sides played; they score for nobody. */
  shared: readonly string[];
  playerScore: number;
  botScore: number;
}

export function scoreRound(letter: string, playerWords: readonly string[], botWords: readonly string[]): RoundResult {
  const player = new Set(playerWords);
  const bot = new Set(botWords);
  const shared = [...player].filter((word) => bot.has(word));
  return {
    letter,
    playerWords: [...player],
    botWords: [...bot],
    shared,
    playerScore: player.size - shared.length,
    botScore: bot.size - shared.length,
  };
}

export interface MatchTotals {
  player: number;
  bot: number;
  winner: Outcome;
}

export function matchTotals(rounds: readonly RoundResult[]): MatchTotals {
  const player = rounds.reduce((sum, r) => sum + r.playerScore, 0);
  const bot = rounds.reduce((sum, r) => sum + r.botScore, 0);
  const winner: Outcome = player > bot ? 'player' : bot > player ? 'bot' : 'draw';
  return { player, bot, winner };
}
