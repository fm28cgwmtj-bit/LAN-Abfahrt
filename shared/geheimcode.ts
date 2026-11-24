import type { Team } from './types';

export type CodeFarbe = Team | 'neutral' | 'falle';
export const CODE_TEAM = { A: 'Sonne', B: 'Welle' } as const;
export const CODE_LABEL: Record<CodeFarbe, string> = { ...CODE_TEAM, neutral: 'Neutral', falle: 'Falle' };
export const CODE_SYMBOL: Record<CodeFarbe, string> = { A: '☀', B: '≈', neutral: '·', falle: '×' };

export const GEHEIMCODE = {
  MAX_CLUE: 24,
  MAX_COUNT: 9,
  TURN_MS: 90_000,
  RESULT_MS: 7_000,
  MAX_EMPTY_TURNS: 4,
} as const;

export interface GeheimcodeState {
  sub: 'clue' | 'guess' | 'over';
  /** Kennung der aktuellen Entscheidung; wechselt auch zwischen zwei Tipps derselben Mannschaft. */
  turn: number;
  team: Team;
  teams: Record<Team, string[]>;
  leaders: Record<Team, string>;
  captain: string | null;
  cards: { word: string; color: CodeFarbe | null }[];
  remaining: Record<Team, number>;
  clue: { word: string; count: number } | null;
  guessesLeft: number;
  /** Pro Ratendem höchstens ein aktueller Vorschlag (Feldindex). */
  proposals: Record<string, number>;
  endsIn: number;
  winner: Team | null;
  message: string;
}

export interface GeheimcodePrivate {
  team: Team;
  role: 'leader' | 'guesser' | 'watch';
  key: CodeFarbe[] | null;
  error: string | null;
}
