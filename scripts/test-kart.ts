import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { KartGame } from '../server/kart';
import { KART } from '../shared/kart';
import type { KartCar } from '../shared/types';

function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
}

function race(t: TestContext, ids = ['Ada'], practice = false) {
  const connected = new Set(ids);
  const game = new KartGame(ids, {
    mode: 'arcade', practice,
    onChange() {}, finish() {},
    isConnected: (id) => connected.has(id),
    nameOf: (id) => id,
  }, 0);
  t.after(() => game.dispose());
  const state = () => {
    const snapshot = game.snapshot();
    assert.equal(snapshot.kind, 'kart');
    return snapshot.state;
  };
  const car = (id = 'Ada') => state().karts[id];
  const steer = (payload: object, id = 'Ada') => game.input(id, 'steer', payload);
  const drive = (ticks: number) => {
    for (let i = 0; i < ticks; i++) t.mock.timers.tick(KART.TICK_MS);
  };
  return { game, connected, state, car, steer, drive };
}

// Vorzeichen unterscheiden echtes Rückwärtsfahren von bloß langsamerem Vorwärtsrollen.
const speed = (c: KartCar) => c.vx * Math.cos(c.angle) + c.vy * Math.sin(c.angle);

test('GAS im Countdown einrasten, Gas loslassen und im Rennen mit freiem Daumen driften', (t) => {
  mockClock(t);
  const { car, state, steer, drive } = race(t);
  assert.equal(state().endsIn, 3000);
  assert.equal(car().autoGas, false);
  const start = car();
  steer({ autoGas: true });
  steer({ gas: false });
  t.mock.timers.tick(2999);
  assert.equal(state().sub, 'countdown');
  assert.deepEqual([car().x, car().y, car().autoGas], [start.x, start.y, true]);
  t.mock.timers.tick(1);
  assert.equal(state().sub, 'race');
  drive(9);
  assert.ok(speed(car()) > KART.DRIFT_MIN_SPEED);
  assert.ok(Math.hypot(car().x - start.x, car().y - start.y) > 1);

  steer({ x: 0.8 });
  steer({ drift: true });
  drive(1);
  assert.equal(car().steer, 0.8, 'Drift ändert die vorherige Lenkung nicht');
  assert.equal(car().drift, 1);
  steer({ drift: false });
  drive(1);
  assert.equal(car().drift, 0);
  assert.equal(car().autoGas, true);
});

test('Bremse löst GAS, fährt rückwärts und verlangt zum Weiterfahren einen neuen Tipp', (t) => {
  mockClock(t);
  const { game, car, steer, drive } = race(t);
  t.mock.timers.tick(KART.COUNTDOWN_MS);
  steer({ autoGas: true, gasSeq: 1 });
  drive(9);
  steer({ x: 0.7, drift: true });
  drive(1);
  assert.equal(car().drift, 1);
  steer({ brake: true, autoGas: true, gasSeq: 2 });
  assert.equal(car().autoGas, false, 'Bei gleichzeitiger Eingabe gewinnt BREMSE');
  steer({ x: 0, gasSeq: 3 });
  assert.equal(car().gasSeq, 2, 'Der Server bestätigt die bewusste Bremseingabe');
  drive(12);
  assert.ok(speed(car()) < 0, 'Auch aus einem Drift heraus bremsen und zurücksetzen');
  steer({ x: 0, brake: false, drift: false });
  drive(20);
  assert.equal(car().autoGas, false);
  assert.ok(Math.abs(speed(car())) < 0.5);
  steer({ autoGas: true });
  drive(2);
  assert.ok(speed(car()) > 0);
  game.input('Ada', 'brake', { on: true });
  game.input('Ada', 'brake', { on: false });
  assert.equal(car().autoGas, false, 'Auch der separate Bremsbefehl löst die Rastung');
});

test('Neutralstellung und Verbindungsverlust wirken nur auf das betroffene Kart', (t) => {
  mockClock(t);
  const { game, car, connected, steer, drive } = race(t, ['Ada', 'Ben']);
  steer({ autoGas: true, gasSeq: 1 });
  assert.equal(car('Ben').autoGas, false);
  steer({ autoGas: true }, 'Ben');
  steer({ reset: true });
  assert.equal(car().autoGas, false);
  assert.equal(car('Ben').autoGas, true);
  connected.delete('Ben');
  game.playerDisconnected('Ben');
  assert.equal(car('Ben').autoGas, false);
  connected.add('Ben');
  t.mock.timers.tick(KART.COUNTDOWN_MS);
  steer({ x: 0.2 });
  drive(1);
  steer({ x: 0.2 });
  steer({ drift: true });
  drive(3);
  assert.deepEqual([car().gasSeq, car().autoGas], [1, false], 'Der Wächter löst GAS, die letzte Tippnummer bleibt erhalten');
  assert.equal(speed(car()), 0, 'Lenken und DRIFT nach dem Timeout dürfen kein Gas geben');
  assert.equal(speed(car('Ben')), 0);
  steer({ gas: true, drift: false });
  drive(1);
  assert.ok(speed(car()) > 0, 'Bewusst gehaltenes Gas funktioniert auch bei gelöster Rastung');
  assert.equal(car().autoGas, false);
});

test('Ältere Controller geben nur beim Halten Gas und fahren nach einem Eingabe-Reset weiter', (t) => {
  mockClock(t);
  const { car, steer, drive } = race(t);
  t.mock.timers.tick(KART.COUNTDOWN_MS);
  steer({ gas: true });
  drive(2);
  const held = speed(car());
  assert.ok(held > 0);
  assert.equal(car().autoGas, false);
  steer({ gas: false });
  drive(1);
  assert.ok(speed(car()) < held);
  steer({ reset: true });
  drive(6);
  assert.ok(Math.abs(speed(car())) < 0.5);
  steer({ gas: true });
  drive(1);
  assert.ok(speed(car()) > 0);
});

test('Im Anschluss an die Aufwärmrunde startet jeder mit gelöstem Gas', (t) => {
  mockClock(t);
  const warmup = race(t, ['Ada'], true);
  warmup.steer({ autoGas: true });
  assert.equal(warmup.car().autoGas, true);
  warmup.game.dispose();
  const live = race(t);
  assert.equal(live.car().autoGas, false);
  t.mock.timers.tick(KART.COUNTDOWN_MS);
  live.drive(2);
  assert.equal(speed(live.car()), 0);
});
