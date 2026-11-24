import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { GeheimcodeGame } from '../server/geheimcode';
import { CODE_WORDS, CODE_WORTGRUPPEN } from '../server/geheimcodeWords';
import type { MiniResult } from '../server/minigame';
import { GEHEIMCODE, type CodeFarbe } from '../shared/geheimcode';
import type { Team } from '../shared/types';

const other = (team: Team): Team => team === 'A' ? 'B' : 'A';

test('Alle Wortkarten sind eindeutig und jedes Bot-Hinweiswort ist auf jedem Brett erlaubt', () => {
  const norm = (word: string) => word.normalize('NFC').toLocaleLowerCase('de');
  const words = new Set(CODE_WORDS.map(norm));
  assert.equal(words.size, CODE_WORDS.length);
  assert.ok(words.size >= 410);
  for (const [clue, members] of Object.entries(CODE_WORTGRUPPEN)) {
    assert.ok(members.length > 0);
    assert.ok(!words.has(norm(clue)), clue);
    assert.match(clue, /^\p{L}+(?:-\p{L}+)*$/u);
    assert.ok(clue.length <= GEHEIMCODE.MAX_CLUE);
  }
});

function setup(t: TestContext, n = 8) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const ids = Array.from({ length: n }, (_, i) => `Gast-${i}`);
  const connected = new Set(ids);
  const offline = new Map<string, number>();
  const results: MiniResult[] = [];
  const game = new GeheimcodeGame(ids, {
    mode: 'arcade', isConnected: id => connected.has(id), nameOf: id => id,
    offlineMs: id => offline.get(id) ?? (connected.has(id) ? 0 : 5_000),
    onChange() {}, finish: r => results.push(r),
  });
  t.after(() => game.dispose());
  const state = () => {
    const s = game.snapshot();
    assert.equal(s.kind, 'geheimcode');
    return s.state;
  };
  const phone = (id: string) => {
    const p = game.privateFor(id);
    assert.ok(p?.kind === 'geheimcode');
    return p.state;
  };
  const act = (id: string, action: string, payload = {}) =>
    game.input(id, action, { turn: state().turn, ...payload });
  const leader = () => state().leaders[state().team];
  const clue = (count = 1) => act(leader(), 'clue', { word: 'Seemannsgarn', count });
  const key = phone(leader()).key!;
  const field = (color: CodeFarbe) => {
    const index = state().cards.findIndex((c, i) => c.color === null && key[i] === color);
    assert.notEqual(index, -1, `Verdecktes Feld der Farbe ${color}`);
    return index;
  };
  const reveal = (index: number) => {
    const cap = state().captain!;
    act(cap, 'vote', { index });
    act(cap, 'confirm', { index });
  };
  return { ids, game, state, phone, act, clue, key, field, reveal, leader, connected, offline, results };
}

for (const first of ['A', 'B'] as const) test(`Team ${first} beginnt mit 9 Wörtern, nur die Hinweisgeber kennen die Farben`, t => {
  t.mock.method(Math, 'random', () => first === 'A' ? 0.25 : 0.75);
  const { ids, game, state, phone, key } = setup(t, 5);
  const s = state();
  assert.equal(s.team, first);
  assert.equal(s.sub, 'clue');
  assert.equal(s.cards.length, 25);
  assert.equal(new Set(s.cards.map(c => c.word.toLocaleLowerCase('de'))).size, 25);
  assert.ok(s.cards.every(c => c.color === null));
  assert.ok(!('key' in s));
  assert.equal(key.length, 25);
  for (const [color, n] of [[s.team, 9], [other(s.team), 8], ['neutral', 7], ['falle', 1]] as const) {
    assert.equal(key.filter(c => c === color).length, n);
  }
  assert.equal(s.remaining[s.team], 9);
  assert.equal(s.remaining[other(s.team)], 8);
  assert.deepEqual(s.teams.A.concat(s.teams.B).sort(), [...ids].sort());
  for (const team of ['A', 'B'] as const) {
    assert.ok(s.teams[team].length >= 2 && s.teams[team].includes(s.leaders[team]));
    for (const id of s.teams[team]) {
      const shown = phone(id);
      assert.equal(shown.team, team);
      assert.deepEqual(shown.key, id === s.leaders[team] ? key : null);
    }
  }
  assert.equal(game.privateFor('Zuschauer'), null);
});

test('Hinweise, Vorschläge und Bestätigung gehören der aktiven Mannschaft und der aktuellen Entscheidung', t => {
  const { state, phone, leader, clue, act, field, reveal } = setup(t);
  const first = state().team;
  const foreign = state().leaders[other(first)];
  const original = state().turn;
  act(foreign, 'clue', { word: 'Paddeltour', count: 1 });
  act(leader(), 'clue', { word: state().cards[0].word.toLowerCase(), count: 1 });
  assert.equal(state().sub, 'clue');
  assert.ok(phone(leader()).error);
  assert.equal(phone(foreign).key?.length, 25);
  assert.equal(phone(foreign).error, null);
  assert.ok(!('error' in state()), 'Eine abgelehnte Eingabe wird nicht auf dem TV angezeigt');
  act(leader(), 'clue', { word: 'Paddeltour', count: 0 });
  assert.equal(state().sub, 'clue');
  clue(1);
  assert.equal(state().sub, 'guess');
  assert.notEqual(state().turn, original);
  assert.equal(state().guessesLeft, 2);
  const current = state().turn;
  const own = field(first);
  const cap = state().captain!;
  const teammate = state().teams[first].find(id => id !== cap && id !== leader())!;
  const opponent = state().teams[other(first)].find(id => id !== foreign)!;
  act(cap, 'confirm', { index: own });
  act(leader(), 'vote', { index: own });
  act(opponent, 'vote', { index: own });
  act(cap, 'vote', { turn: original, index: own });
  assert.deepEqual(state().proposals, {});
  act(teammate, 'vote', { index: field('neutral') });
  act(teammate, 'vote', { index: own });
  assert.deepEqual(state().proposals, { [teammate]: own });
  act(teammate, 'confirm', { index: own });
  act(opponent, 'pass');
  assert.equal(state().cards[own].color, null);
  act(cap, 'confirm', { index: own });
  assert.equal(state().cards[own].color, first);
  assert.equal(state().remaining[first], 8);
  assert.equal(state().guessesLeft, 1);
  assert.deepEqual(state().proposals, {});
  act(cap, 'confirm', { turn: current, index: own });
  assert.equal(state().remaining[first], 8);
  reveal(field(first));
  assert.equal(state().team, other(first), 'Der Bonustipp war der letzte erlaubte Tipp');
  assert.equal(state().sub, 'clue');
  assert.equal(state().remaining[first], 7);
});

test('Eine neutrale Karte beendet den Zug, die Falle das Spiel mit genau einer Wertung', t => {
  const { state, clue, field, reveal, key, results } = setup(t, 4);
  const first = state().team;
  clue();
  reveal(field('neutral'));
  assert.equal(state().team, other(first));
  assert.equal(state().remaining[first], 9);
  clue();
  reveal(field('falle'));
  assert.equal(state().sub, 'over');
  assert.equal(state().winner, first);
  assert.deepEqual(state().cards.map(c => c.color), key);
  t.mock.timers.tick(GEHEIMCODE.RESULT_MS);
  assert.equal(results.length, 1);
  assert.deepEqual(new Set(results[0].groups[0]), new Set(state().teams[first]));
});

test('Auch die gegnerische Mannschaft gewinnt sofort, wenn ihr letztes Wort aufgedeckt wird', t => {
  const { state, clue, field, reveal, act } = setup(t, 4);
  const first = state().team;
  const second = other(first);
  clue();
  reveal(field(second));
  assert.equal(state().team, second);
  assert.equal(state().remaining[second], 7);
  clue(7);
  for (let i = 0; i < 6; i++) reveal(field(second));
  assert.equal(state().remaining[second], 1);
  act(state().captain!, 'pass');
  assert.equal(state().team, first);
  clue();
  reveal(field(second));
  assert.equal(state().winner, second);
  assert.equal(state().remaining[second], 0);
});

test('Das Startteam kann seine neun Wörter in einem Zug aufdecken', t => {
  const { state, clue, field, reveal } = setup(t, 4);
  const first = state().team;
  clue(8);
  for (let i = 0; i < 9; i++) reveal(field(first));
  assert.equal(state().sub, 'over');
  assert.equal(state().winner, first);
  assert.equal(state().remaining[first], 0);
});

test('Ein Hinweis startet keine neue Uhr; vier Runden ohne Treffer enden bei Gleichstand unentschieden', t => {
  const { state, clue, results } = setup(t, 4);
  const first = state().team;
  t.mock.timers.tick(GEHEIMCODE.TURN_MS - 100);
  clue(1);
  assert.equal(state().sub, 'guess');
  assert.equal(state().endsIn, 100);
  t.mock.timers.tick(100);
  assert.equal(state().team, other(first));
  assert.equal(state().sub, 'clue');
  for (let i = 1; i < GEHEIMCODE.MAX_EMPTY_TURNS; i++) t.mock.timers.tick(GEHEIMCODE.TURN_MS);
  assert.equal(state().sub, 'over');
  assert.equal(state().winner, null);
  t.mock.timers.tick(GEHEIMCODE.RESULT_MS);
  assert.equal(results.length, 1);
  assert.equal(results[0].groups[0].length, 4);
});

test('Eine Bestätigung an oder nach der Zugfrist bleibt auch bei verspätetem Timer wirkungslos', t => {
  const { state, clue, field, act } = setup(t, 4);
  for (const delay of [0, 1]) {
    const team = state().team;
    const deadline = Date.now() + state().endsIn;
    clue();
    const captain = state().captain!;
    const index = field(team);
    t.mock.timers.setTime(deadline - 1);
    act(captain, 'vote', { index });
    assert.equal(state().proposals[captain], index);
    t.mock.timers.setTime(deadline + delay);
    act(captain, 'confirm', { index });
    assert.equal(state().cards[index].color, null);
    assert.equal(state().team, other(team));
    assert.equal(state().sub, 'clue');
    assert.deepEqual(state().proposals, {});
    const nextTurn = state().turn;
    t.mock.timers.tick(0);
    assert.equal(state().turn, nextTurn, 'Der überfällige Callback darf den nächsten Zug nicht überspringen');
  }
});

test('Wiederverbundene Hinweisgeber erhalten nach einer Übergabe kein Stimmrecht', t => {
  const { game, state, phone, clue, act, field, connected } = setup(t);
  const team = state().team;
  const old = state().leaders[team];
  connected.delete(old);
  game.playerDisconnected(old);
  const replacement = state().leaders[team];
  assert.notEqual(replacement, old);
  assert.ok(phone(replacement).key);
  connected.add(old);
  assert.equal(phone(old).role, 'watch');
  assert.equal(phone(old).key, null);
  act(old, 'clue', { word: 'Schatzkammer', count: 1 });
  assert.equal(state().sub, 'clue');
  clue();
  const index = field(team);
  act(old, 'vote', { index });
  assert.deepEqual(state().proposals, {});
  const captain = state().captain!;
  act(captain, 'vote', { index });
  connected.delete(captain);
  game.playerDisconnected(captain);
  assert.notEqual(state().captain, captain);
  assert.ok(!(captain in state().proposals));
  connected.add(captain);
  act(captain, 'confirm', { index });
  assert.equal(state().cards[index].color, null);
});

test('Im Zweierteam bleibt ein einzelner Ratender ohne Schlüssel, bis der Hinweisgeber zurück ist', t => {
  const { game, state, phone, act, leader, connected } = setup(t, 4);
  const original = leader();
  const ratender = state().captain!;
  connected.delete(original);
  game.playerDisconnected(original);
  assert.equal(game.privateFor(original), null);
  assert.equal(phone(ratender).key, null);
  act(ratender, 'clue', { word: 'Schatzkammer', count: 1 });
  assert.equal(state().sub, 'clue');
  connected.add(original);
  assert.equal(phone(original).role, 'leader');
  act(original, 'clue', { word: 'Schatzkammer', count: 1 });
  assert.equal(state().sub, 'guess');
  assert.equal(state().captain, ratender);
});

test('Zwei überlappende WLAN-Aussetzer kosten den zurückkehrenden Ratenden nicht sein Stimmrecht', t => {
  const { game, state, phone, act, leader, clue, field, connected, offline } = setup(t, 6);
  const team = state().team;
  const original = leader();
  const [guesser] = state().teams[team].filter(id => id !== original);
  // Der Raum meldet den ersten Ausfall nach 3 s. Das andere Handy ist noch in seiner Gnadenfrist.
  connected.delete(original);
  offline.set(guesser, 1_500);
  game.playerDisconnected(original);
  assert.notEqual(leader(), guesser);
  connected.add(original);
  offline.delete(guesser);
  assert.equal(phone(original).role, 'leader');
  assert.equal(phone(guesser).role, 'guesser');
  assert.equal(phone(guesser).key, null);
  clue();
  const index = field(team);
  act(guesser, 'vote', { index });
  assert.equal(state().proposals[guesser], index);
});
