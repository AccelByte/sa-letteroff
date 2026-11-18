import { randomSeed } from '../game/rng';

/**
 * Seed for a new match. Adding ?seed=123 to the URL replays the same letters
 * and bot moves every time, which helps when testing or reporting a bug.
 */
export function newSeed(): number {
  const fromUrl = Number(new URLSearchParams(window.location.search).get('seed'));
  return Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : randomSeed();
}
