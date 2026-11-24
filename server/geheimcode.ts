import { CODE_LABEL, CODE_TEAM, GEHEIMCODE, type CodeFarbe, type GeheimcodeState } from '../shared/geheimcode';
import type { MiniSnapshot, PrivateState, SkipInfo, Team } from '../shared/types';
import { CODE_WORDS } from './geheimcodeWords';
import { type MiniCtx, type MiniGame, Timers, asRecord, endsIn, shuffle } from './minigame';

const other = (team: Team): Team => team === 'A' ? 'B' : 'A';
const wordKey = (word: string) => word.toLowerCase().normalize('NFC')
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/-/g, '');
// Auch ein Paket aus der vorherigen Partie darf beim „Nochmal“ keinen frischen Zug treffen.
let lastTurn = 0;

export class GeheimcodeGame implements MiniGame {
  readonly kind = 'geheimcode' as const;
  private readonly words = shuffle(CODE_WORDS).slice(0, 25);
  private readonly key: CodeFarbe[];
  private revealed = new Set<number>();
  private team: Team = Math.random() < 0.5 ? 'A' : 'B';
  private readonly teams: Record<Team, string[]> = { A: [], B: [] };
  private readonly leaders: Record<Team, string>;
  /** Wer einmal den Schlüssel gesehen hat, darf in dieser Partie nie wieder raten. */
  private informed = new Set<string>();
  private readonly initial: Record<Team, number>;
  private remaining: Record<Team, number>;
  private captain: string | null = null;
  private turn = ++lastTurn;
  private sub: GeheimcodeState['sub'] = 'clue';
  private clue: GeheimcodeState['clue'] = null;
  private guessesLeft = 0;
  private proposals = new Map<string, number>();
  private errors = new Map<string, string>();
  private revealedThisTurn = false;
  private emptyTurns = 0;
  private deadline = 0;
  private timers = new Timers();
  private winner: Team | null = null;
  private message = '';
  private disposed = false;

  constructor(private ids: string[], private ctx: MiniCtx) {
    shuffle(ids).forEach((id, i) => this.teams[i % 2 === 0 ? 'A' : 'B'].push(id));
    this.leaders = { A: this.teams.A[0] ?? '', B: this.teams.B[0] ?? '' };
    this.informed = new Set(Object.values(this.leaders).filter(Boolean));
    this.initial = { A: this.team === 'A' ? 9 : 8, B: this.team === 'B' ? 9 : 8 };
    this.remaining = { ...this.initial };
    this.key = shuffle<CodeFarbe>([
      ...Array<Team>(this.initial.A).fill('A'), ...Array<Team>(this.initial.B).fill('B'),
      ...Array<CodeFarbe>(7).fill('neutral'), 'falle',
    ]);
    // Während der Regelkarte können Teilnehmer aussteigen.
    if (ids.length < 4) {
      this.end(null, 'Für zwei Hinweisgeber und zwei Ratende fehlen Mitspieler.');
      return;
    }
    this.refreshRoles();
    this.startClock();
  }

  private teamOf(id: string): Team | null {
    if (this.teams.A.includes(id)) return 'A';
    if (this.teams.B.includes(id)) return 'B';
    return null;
  }

  private online(id: string) {
    return this.ctx.isConnected(id) && !this.ctx.isGone?.(id);
  }

  /** Ämter bleiben stabil. Einen neuen Schlüssel geben wir nur aus, wenn jemand zum Raten übrig bleibt. */
  private refreshRoles() {
    if (this.sub === 'over') return;
    for (const team of ['A', 'B'] as const) {
      if (this.online(this.leaders[team])) continue;
      // Die bisherige Leitung behält ihre WLAN-Gnadenfrist. Einen Schlüssel
      // vergeben wir nur an ein Handy, dem der Raum ihn jetzt zustellen kann.
      const online = this.teams[team].filter((id) => this.online(id) && (this.ctx.offlineMs?.(id) ?? 0) === 0);
      const previous = online.find((id) => this.informed.has(id));
      const replacement = previous ?? (online.length >= 2 ? online[0] : undefined);
      if (replacement) {
        this.leaders[team] = replacement;
        this.informed.add(replacement);
      }
    }
    const guessers = this.teams[this.team].filter((id) => this.online(id) && !this.informed.has(id));
    if (!this.captain || !guessers.includes(this.captain)) this.captain = guessers[0] ?? null;
    for (const id of this.proposals.keys()) if (!guessers.includes(id)) this.proposals.delete(id);
  }

  private startClock() {
    this.timers.clear();
    this.deadline = Date.now() + GEHEIMCODE.TURN_MS;
    this.timers.later(GEHEIMCODE.TURN_MS, () => this.expireTurn());
  }

  private expireTurn() {
    this.nextTeam('Die Zeit ist um.');
    this.ctx.onChange();
  }

  private nextDecision() {
    this.turn = ++lastTurn;
    this.proposals.clear();
    this.errors.clear();
  }

  private nextTeam(message: string) {
    this.emptyTurns = this.revealedThisTurn ? 0 : this.emptyTurns + 1;
    if (this.emptyTurns >= GEHEIMCODE.MAX_EMPTY_TURNS) {
      // Das Startteam hat eine Karte mehr. Für den Abbruch zählt der Anteil gefundener Codes.
      const diff = this.remaining.B * this.initial.A - this.remaining.A * this.initial.B;
      this.end(diff > 0 ? 'A' : diff < 0 ? 'B' : null, 'Vier Züge ohne aufgedecktes Wort.');
      return;
    }
    this.team = other(this.team);
    this.sub = 'clue';
    this.clue = null;
    this.guessesLeft = 0;
    this.revealedThisTurn = false;
    this.captain = null;
    this.message = message;
    this.nextDecision();
    this.refreshRoles();
    this.startClock();
  }

  private end(winner: Team | null, reason: string) {
    this.sub = 'over';
    this.winner = winner;
    this.guessesLeft = 0;
    this.captain = null;
    this.message = reason + (winner ? ` Team ${CODE_TEAM[winner]} gewinnt!` : ' Unentschieden!');
    this.nextDecision();
    this.timers.clear();
    this.deadline = Date.now() + GEHEIMCODE.RESULT_MS;
    this.timers.later(GEHEIMCODE.RESULT_MS, () => this.finish());
  }

  private finish() {
    if (this.disposed) return;
    this.dispose();
    const groups = this.winner ? [this.teams[this.winner], this.teams[other(this.winner)]] : [this.ids];
    const details: Record<string, string> = {};
    for (const team of ['A', 'B'] as const) {
      for (const id of this.teams[team]) details[id] = `Team ${CODE_TEAM[team]} · ${this.initial[team] - this.remaining[team]}/${this.initial[team]} Codes`;
    }
    this.ctx.finish({ groups, details, subtitle: this.message });
  }

  private reveal(index: number) {
    const color = this.key[index];
    this.revealed.add(index);
    this.revealedThisTurn = true;
    const message = `${this.words[index]} · ${CODE_LABEL[color]}.`;
    if (color === 'falle') return this.end(other(this.team), message);
    if (color !== 'neutral') {
      this.remaining[color]--;
      if (this.remaining[color] === 0) return this.end(color, message);
    }
    this.guessesLeft--;
    if (color !== this.team || this.guessesLeft === 0) return this.nextTeam(message);
    this.message = message;
    this.nextDecision();
  }

  snapshot(): MiniSnapshot {
    this.refreshRoles();
    return {
      kind: this.kind,
      state: {
        sub: this.sub,
        turn: this.turn,
        team: this.team,
        teams: this.teams,
        leaders: { ...this.leaders },
        captain: this.captain,
        cards: this.words.map((word, i) => ({ word, color: this.sub === 'over' || this.revealed.has(i) ? this.key[i] : null })),
        remaining: { ...this.remaining },
        clue: this.clue,
        guessesLeft: this.guessesLeft,
        proposals: Object.fromEntries(this.proposals),
        endsIn: endsIn(this.deadline),
        winner: this.winner,
        message: this.message,
      },
    };
  }

  privateFor(id: string): PrivateState {
    const team = this.teamOf(id);
    if (!team || !this.online(id)) return null;
    this.refreshRoles();
    const role = this.leaders[team] === id ? 'leader' : this.informed.has(id) ? 'watch' : 'guesser';
    return { kind: this.kind, state: { team, role, key: role === 'leader' ? [...this.key] : null, error: this.errors.get(id) ?? null } };
  }

  input(id: string, action: string, payload: unknown) {
    const p = asRecord(payload);
    if (this.disposed || this.sub === 'over' || p.turn !== this.turn || !this.online(id) || this.teamOf(id) !== this.team) return;
    if (Date.now() >= this.deadline) return this.expireTurn();
    this.refreshRoles();
    if (action === 'clue' && this.sub === 'clue' && this.leaders[this.team] === id) {
      const word = typeof p.word === 'string' ? p.word.trim().normalize('NFC') : '';
      const count = p.count;
      if (word.length > GEHEIMCODE.MAX_CLUE || !/^\p{L}+(?:-\p{L}+)*$/u.test(word)) {
        this.errors.set(id, 'Gib ein einzelnes Wort mit höchstens 24 Zeichen ein.');
      } else if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > GEHEIMCODE.MAX_COUNT) {
        this.errors.set(id, 'Wähle eine Zahl von 1 bis 9.');
      } else if (this.words.some((w) => wordKey(w) === wordKey(word))) {
        this.errors.set(id, 'Das Wort liegt auf dem Tisch. Wähle einen anderen Hinweis.');
      } else {
        this.clue = { word, count };
        this.guessesLeft = count + 1;
        this.sub = 'guess';
        this.message = '';
        this.nextDecision();
      }
    } else if (this.sub === 'guess' && !this.informed.has(id)) {
      if (action === 'pass' && id === this.captain) {
        this.nextTeam(`Team ${CODE_TEAM[this.team]} passt.`);
      } else {
        const index = p.index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= this.words.length || this.revealed.has(index)) return;
        if (action === 'vote') this.proposals.set(id, index);
        else if (action === 'confirm' && id === this.captain && [...this.proposals.values()].includes(index)) this.reveal(index);
        else return;
      }
    } else return;
    this.ctx.onChange();
  }

  playerDisconnected(_id: string) {
    this.refreshRoles();
    this.ctx.onChange();
  }

  skippable(): SkipInfo | null {
    if (this.disposed) return null;
    return this.sub === 'over' ? { label: 'Zur Wertung', info: true } : { label: 'Teamzug beenden' };
  }

  skip() {
    if (this.disposed) return;
    if (this.sub === 'over') return this.finish();
    this.nextTeam('Der Teamzug wurde beendet.');
    this.ctx.onChange();
  }

  dispose() {
    this.disposed = true;
    this.timers.clear();
  }
}
