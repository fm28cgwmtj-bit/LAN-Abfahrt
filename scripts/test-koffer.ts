import assert from 'node:assert/strict';
import test from 'node:test';
import { KofferGame } from '../server/koffer';
import type { MiniResult } from '../server/minigame';
import { KOFFER } from '../shared/koffer';

test('Nach 60 Sekunden schließt der Kofferraum auf dem Brett, in Arcade geht das Packen weiter', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  function start(board: boolean) {
    const results: MiniResult[] = [];
    const game = new KofferGame(['Ada', 'Ben'], {
      board, mode: board ? 'party' : 'arcade',
      onChange() {}, finish: (r) => results.push(r),
      isConnected: () => true, nameOf: (id) => id,
    });
    t.after(() => game.dispose());
    const state = () => {
      const snap = game.snapshot();
      assert.equal(snap.kind, 'koffer');
      return snap.state;
    };
    return { game, state, results };
  }
  const board = start(true);
  const arcade = start(false);
  t.mock.timers.tick(KOFFER.COUNTDOWN_MS);
  assert.equal(board.state().endsIn, 60_000);
  assert.equal(arcade.state().endsIn, 150_000);

  // Ein Gepäckstück bis zum Boden beschleunigen und vom Physik-Takt verbuchen lassen.
  board.game.input('Ada', 'drop', { on: true });
  for (let i = 0; i < 40; i++) t.mock.timers.tick(50);
  board.game.input('Ada', 'drop', { on: false });
  assert.ok(board.state().cars.find((c) => c.owners.includes('Ada'))!.liters > 0);

  t.mock.timers.tick(57_999);
  assert.equal(board.state().sub, 'play');
  t.mock.timers.tick(1);
  assert.equal(board.state().sub, 'settle');
  assert.equal(arcade.state().sub, 'play');
  assert.equal(arcade.state().endsIn, 90_000);
  t.mock.timers.tick(KOFFER.SETTLE_MS);
  assert.equal(board.state().sub, 'over');
  t.mock.timers.tick(KOFFER.OVER_MS);
  assert.equal(board.results.length, 1);
  assert.match(board.results[0].details.Ada, /^[1-9]\d* L/);
  assert.equal(arcade.results.length, 0);
});
