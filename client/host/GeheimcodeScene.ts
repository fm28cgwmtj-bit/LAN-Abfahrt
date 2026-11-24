import Phaser from 'phaser';
import { CODE_LABEL, CODE_SYMBOL, CODE_TEAM, type CodeFarbe, type GeheimcodeState } from '../../shared/geheimcode';
import { WORLD } from '../../shared/flunky';
import type { GameState, Team } from '../../shared/types';
import { Juice } from './juice';
import { sfx } from './sfx';
import { bus, getState } from './store';
import { background, Countdown, ink, tagName, txt } from './ui';

const NAVY = 0x133d49;
const LIGHT = '#fff9e8';
const PAPER = 0xfff6db;
const COLORS: Record<CodeFarbe, { fill: number; ink: string }> = {
  A: { fill: 0xffce64, ink: '#51300b' },
  B: { fill: 0x8cdae7, ink: '#103a50' },
  neutral: { fill: 0xd1c4b0, ink: '#463a35' },
  falle: { fill: 0x462939, ink: '#fff6ec' },
};
const CARD_W = 90;
const CARD_H = 34;

interface Tile {
  paper: Phaser.GameObjects.Rectangle;
  word: Phaser.GameObjects.Text;
  mark: Phaser.GameObjects.Text;
}

/** Wort und Hinweis bleiben auch bei langen Zusammensetzungen vollständig lesbar. */
function fitLine(label: Phaser.GameObjects.Text, value: string, width: number, scale = 1) {
  label.setText(value);
  label.setScale(Math.min(scale, width / Math.max(1, label.width)), scale);
}

function setInk(label: Phaser.GameObjects.Text, color: string) {
  if (label.style.color !== color) label.setColor(color);
}

/** Die TV-Szene liest ausschließlich die öffentlich aufgedeckten Karten. */
export class GeheimcodeScene extends Phaser.Scene {
  private tiles: Tile[] = [];
  private scores!: Record<Team, Phaser.GameObjects.Text>;
  private headline!: Phaser.GameObjects.Text;
  private turnInfo!: Phaser.GameObjects.Text;
  private news!: Phaser.GameObjects.Text;
  private instruction!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private clock = new Countdown();
  private juice!: Juice;
  private previous: GeheimcodeState | null = null;

  constructor() {
    super('geheimcode');
  }

  create() {
    this.previous = null;
    this.tiles = [];
    this.clock.none = true;
    this.juice = new Juice(this, { depth: 5 });
    background(this, 'geheimcode', WORLD.W, WORLD.H, (p) => {
      p.rect(0, 0, WORLD.W, WORLD.H, '#297982');
      for (let y = 59; y < 245; y += 12) {
        p.hline(0, y, WORLD.W, '#318b91');
        for (let x = (y % 24) + 2; x < WORLD.W; x += 24) p.vline(x, y, 12, '#318b91');
      }
    });
    this.add.rectangle(0, 0, WORLD.W, 20, NAVY).setOrigin(0);
    this.add.rectangle(0, 20, WORLD.W, 35, 0xf8edcc).setOrigin(0);
    this.add.rectangle(0, 246, WORLD.W, 24, NAVY).setOrigin(0);
    // Links oben bleibt Platz für die Spieler-Verwaltung des Laptops.
    txt(this, 55, 10, 'GEHEIMCODE AM POOL', { origin: [0, 0.5], shadow: false });
    this.scores = { A: this.score('A', 252), B: this.score('B', 353) };
    this.clockText = txt(this, 473, 10, '', { origin: [1, 0.5], shadow: false });
    this.headline = ink(this, 8, 37, '', { size: 16, origin: [0, 0.5] });
    this.turnInfo = ink(this, 472, 37, '', { origin: [1, 0.5], align: 'right' });
    this.news = txt(this, 240, 258, '', { origin: [0.5, 0.5], shadow: false });
    this.instruction = txt(this, 240, 263, '', { origin: [0.5, 0.5], color: '#b1e4e6', shadow: false });
    for (let i = 0; i < 25; i++) {
      const x = 52 + (i % 5) * 94;
      const y = 75 + Math.floor(i / 5) * 38;
      this.add.rectangle(x, y + 2, CARD_W, CARD_H, NAVY);
      const paper = this.add.rectangle(x, y, CARD_W, CARD_H, PAPER).setStrokeStyle(1, NAVY);
      const word = ink(this, x, y, '', { size: 16, origin: [0.5, 0.5] });
      const mark = ink(this, x, y + 9, '', { origin: [0.5, 0.5] });
      this.tiles.push({ paper, word, mark });
    }

    bus.on('state', this.render, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => bus.off('state', this.render, this));
    const s = getState();
    if (s) this.render(s);
  }

  private score(team: Team, x: number) {
    this.add.rectangle(x, 10, 94, 14, COLORS[team].fill);
    return ink(this, x, 10, '', { origin: [0.5, 0.5], color: COLORS[team].ink });
  }

  private render(s: GameState) {
    if (s.mini?.kind !== 'geheimcode') return;
    const st = s.mini.state;
    const old = this.previous;
    this.previous = st;
    const team = CODE_TEAM[st.team];
    const who = (id: string | null) => tagName(s.players.find((p) => p.id === id)?.name ?? '');
    for (const t of ['A', 'B'] as const) {
      fitLine(this.scores[t], `${CODE_SYMBOL[t]} ${CODE_TEAM[t]} ${st.remaining[t]} offen`, 88);
    }
    if (old?.turn !== st.turn || old.sub !== st.sub) this.clock.set(st.endsIn);
    const captain = who(st.captain) || 'Kapitän';
    if (st.sub === 'over') {
      fitLine(this.headline, st.winner ? `Team ${CODE_TEAM[st.winner]} gewinnt!` : 'Spiel beendet', 340);
      this.turnInfo.setText('SPIELENDE').setScale(1);
    } else if (st.sub === 'clue') {
      fitLine(this.headline, `Team ${team} ist dran`, 277, 0.9);
      fitLine(this.turnInfo, `${who(st.leaders[st.team]) || 'Teamleitung'}\ngibt den Hinweis`, 165);
    } else {
      fitLine(this.headline, st.clue ? `${st.clue.word} · ${st.clue.count}` : 'Jetzt raten!', 277);
      fitLine(this.turnInfo, `Team ${team} rät\n${st.guessesLeft} ${st.guessesLeft === 1 ? 'Tipp' : 'Tipps'} übrig`, 160);
    }
    let instruction = '';
    if (st.sub === 'clue') instruction = 'Ein Hinweiswort und eine Zahl am Handy eingeben.';
    if (st.sub === 'guess') instruction = st.captain ? `${captain} bestätigt ein Wort oder passt.` : 'Warten auf das Rateteam.';
    this.news.setY(instruction && st.message ? 252 : 258);
    fitLine(this.news, st.message || instruction, 460);
    fitLine(this.instruction, st.message ? instruction : '', 460);

    const counts = new Map<number, number>();
    for (const index of Object.values(st.proposals)) counts.set(index, (counts.get(index) ?? 0) + 1);
    st.cards.forEach(({ word, color }, i) => {
      const tile = this.tiles[i];
      if (!tile) return;
      const votes = counts.get(i) ?? 0;
      const mark = color ? `${CODE_SYMBOL[color]} ${CODE_LABEL[color]}` : votes ? `${votes} ${votes === 1 ? 'Stimme' : 'Stimmen'}` : '';
      const palette = color ? COLORS[color] : null;
      tile.paper.setFillStyle(palette?.fill ?? PAPER).setStrokeStyle(votes && !color ? 2 : 1, votes && !color ? 0x975825 : NAVY);
      setInk(tile.word, palette?.ink ?? '#283e3b');
      tile.word.setY(tile.paper.y - (mark ? 5 : 0));
      fitLine(tile.word, word, CARD_W - 6, 0.78);
      setInk(tile.mark, palette?.ink ?? '#75441d');
      fitLine(tile.mark, mark, CARD_W - 6, 0.85);
      if (old?.cards[i]?.color === null && color && st.sub !== 'over') {
        const correct = color === old.team;
        this.juice.burst(tile.paper.x, tile.paper.y, correct ? 'spark' : 'puff', 7);
        sfx(correct ? 'coin' : 'pop');
      }
    });
    if (old && old.sub !== 'over' && st.sub === 'over') sfx('fanfare');
    this.update();
  }

  update() {
    const secs = this.clock.seconds;
    const visible = !this.clock.none && this.previous?.sub !== 'over';
    this.clockText.setText(visible ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '');
    setInk(this.clockText, secs <= 10 ? '#ffd080' : LIGHT);
  }
}
