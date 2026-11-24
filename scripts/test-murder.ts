import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { MurderGame } from '../server/murder';
import type { MiniResult } from '../server/minigame';
import { FERIEN_STEPS, ferienAufgabe, ferienStepCorrect } from '../shared/ferienaufgaben';
import { MURDER, ROOMS } from '../shared/games';

function round(t: TestContext, n = 4) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const ids = Array.from({ length: n }, (_, i) => `Gast-${i}`);
  const online = new Set(ids);
  const results: MiniResult[] = [];
  const game = new MurderGame(ids, {
    mode: 'arcade', isConnected: id => online.has(id), nameOf: id => id,
    onChange() {}, finish: r => results.push(r),
  });
  t.after(() => game.dispose());
  const state = () => {
    const m = game.snapshot();
    assert.equal(m.kind, 'murder');
    return m.state;
  };
  const phone = (id: string) => {
    const p = game.privateFor(id);
    assert.ok(p?.kind === 'murder');
    return p.state;
  };
  const killers = ids.filter(id => phone(id).role === 'murderer');
  const guests = ids.filter(id => phone(id).role === 'urlauber');
  const act = (id: string, action: string, fields = {}) =>
    game.input(id, action, { phaseNo: state().phaseNo, ...fields });
  const choose = (id: string, room: number) => act(id, 'room', { room });
  return { game, state, phone, guests, killers, act, choose, online, results };
}

test('Sabotage bleibt anonym und pausiert die Aufgabenuhr bis zur zweiten Reparatur', t => {
  const { game, state, phone, guests, killers, act, choose, online } = round(t, 7);
  assert.equal(killers.length, 2);
  assert.equal(guests.length, 5);
  for (const id of killers) assert.deepEqual(phone(id).partners, killers.filter(k => k !== id));
  for (const id of guests) assert.deepEqual(phone(id).partners, []);
  assert.equal(game.privateFor('Zuschauer'), null);
  assert.equal(state().murderers, null);
  game.skip();
  const worker = guests[0];
  t.mock.timers.tick(12_000);
  const remaining = state().endsIn;
  act(worker, 'sabotage');
  assert.equal(state().sabotage, null);
  assert.equal(phone(killers[0]).canSabotage, true);
  act(killers[0], 'sabotage');
  const fault = state().sabotage!;
  assert.equal(new Set(fault.stations).size, 2);
  assert.ok(fault.stations.every(i => ROOMS[i]));
  assert.ok(!JSON.stringify(fault).includes('Gast-'), 'Die Störungsmeldung verrät den Auslöser nicht');
  act(killers[1], 'sabotage');
  assert.deepEqual(state().sabotage, fault);
  assert.equal(phone(killers[1]).canSabotage, false);

  choose(worker, ROOMS.findIndex((_, i) => !fault.stations.includes(i)));
  act(worker, 'repair');
  act(worker, 'emergency');
  for (let i = 0; i < MURDER.TASK_TAPS; i++) act(worker, 'task');
  assert.equal(state().sub, 'tasks');
  assert.equal(state().taskProgress, 0);
  assert.deepEqual(state().sabotage!.repaired, []);
  choose(worker, fault.stations[0]);
  act(worker, 'repair');
  act(worker, 'repair');
  assert.deepEqual(state().sabotage!.repaired, [fault.stations[0]]);
  online.delete(worker);
  game.playerDisconnected();
  t.mock.timers.tick(4500);
  online.add(worker);
  assert.equal(phone(worker).room, fault.stations[0], 'Das Handy findet nach dem Wiederbeitritt seinen Raum wieder');
  choose(worker, fault.stations[1]);
  act(worker, 'repair');
  assert.equal(state().sabotage, null);
  assert.equal(state().endsIn, remaining);
  t.mock.timers.tick(MURDER.SABOTAGE_MS);
  assert.equal(state().sub, 'tasks', 'Die bereits reparierte Störung kann später keinen Sieg mehr auslösen');
  act(killers[1], 'sabotage');
  assert.equal(state().sabotage, null);
  t.mock.timers.tick(remaining - MURDER.SABOTAGE_MS);
  assert.equal(state().meetingReason, 'timeout');
});

test('Leichenfund beendet eine Störung, Notruf zählt einmal und alte Aktionen bleiben wirkungslos', t => {
  const { game, state, phone, guests, killers, act, choose, online, results } = round(t);
  const [killer] = killers;
  const [victim, witness, other] = guests;
  game.skip();
  const old = state().phaseNo;
  choose(killer, 0);
  choose(victim, 0);
  choose(witness, 0);
  act(killer, 'kill');
  assert.equal(state().screamSeq, 0, 'Ein Zeuge verhindert den Mord');
  choose(witness, 1);
  act(killer, 'kill');
  act(killer, 'kill');
  assert.equal(state().screamSeq, 1);
  assert.equal(phone(victim).alive, false);
  act(killer, 'sabotage');
  choose(victim, state().sabotage!.stations[0]);
  act(victim, 'repair');
  act(victim, 'emergency');
  assert.deepEqual(state().sabotage!.repaired, []);
  choose(witness, 0);
  act(witness, 'report');
  assert.equal(state().meetingReason, 'body');
  assert.equal(state().reporter, witness);
  assert.deepEqual(state().deaths, [victim]);
  assert.equal(state().sabotage, null);
  game.skip();
  for (const id of [witness, killer, other]) act(id, 'vote', { target: 'skip' });
  game.skip();
  assert.equal(state().phaseNo, old + 1);
  act(killer, 'sabotage', { phaseNo: old });
  assert.equal(state().sabotage, null);
  act(witness, 'emergency');
  assert.equal(state().meetingReason, 'emergency');
  assert.equal(state().reporter, witness);
  game.skip();
  game.skip();
  game.skip();
  act(witness, 'emergency');
  assert.equal(state().sub, 'tasks');
  assert.equal(phone(witness).canEmergency, false);
  act(other, 'emergency');
  assert.equal(state().sub, 'meeting');
  game.skip();
  act(victim, 'vote', { target: killer });
  act(witness, 'vote', { target: killer });
  assert.equal(phone(witness).myVote, killer);
  assert.equal(phone(other).myVote, null);
  assert.equal(state().voteTally, null);
  assert.deepEqual(state().voted, [witness]);
  act(other, 'vote', { target: killer });
  online.delete(killer);
  game.playerDisconnected();
  assert.equal(state().ejected, killer, 'Die geheime Abstimmung wartet nicht auf Abwesende');
  game.skip();
  assert.equal(state().winner, 'urlauber');
  assert.deepEqual(state().murderers, [killer]);
  t.mock.timers.tick(6000);
  assert.deepEqual(new Set(results[0].groups[0]), new Set(guests));
});

test('Bis zur Bekanntgabe zeigt der TV ungemeldete Opfer als lebend, auch bei einem zweiten Mord', t => {
  const { game, state, phone, killers, guests, choose, act } = round(t, 7);
  const [first, second] = guests;
  game.skip();
  for (const [room, victim] of [first, second].entries()) {
    choose(killers[room], room);
    choose(victim, room);
    act(killers[room], 'kill');
  }
  const hidden = state();
  assert.equal(hidden.screamSeq, 2);
  assert.deepEqual(hidden.deaths, []);
  for (const [room, victim] of [first, second].entries()) {
    assert.equal(hidden.alive[victim], true);
    assert.equal(phone(victim).alive, false);
    assert.equal(hidden.roomCounts[room], 1, 'Die anonyme Raumzählung zählt nur den lebenden Täter');
  }
  act(guests[2], 'emergency');
  assert.deepEqual(new Set(state().deaths), new Set([first, second]));
  assert.equal(state().alive[first], false);
  assert.equal(state().alive[second], false);
  game.skip();
  game.skip();
  game.skip();
  assert.equal(state().sub, 'tasks');
  assert.equal(state().alive[first], false);
  assert.equal(state().alive[second], false);
  assert.equal(hidden.alive[first], true, 'Ein alter Snapshot bleibt unverändert');
});

test('Der Sabotage-Countdown läuft auch bei einem Verbindungsabbruch bis zum Mörder-Sieg', t => {
  const { game, state, killers, guests, choose, act, online, results } = round(t);
  game.skip();
  choose(killers[0], 0);
  choose(guests[0], 0);
  act(killers[0], 'kill');
  assert.equal(state().alive[guests[0]], true);
  act(killers[0], 'sabotage');
  online.delete(killers[0]);
  game.playerDisconnected();
  t.mock.timers.tick(MURDER.SABOTAGE_MS - 1);
  assert.equal(state().winner, null);
  t.mock.timers.tick(1);
  assert.equal(state().winner, 'murderer');
  assert.equal(state().sub, 'over');
  assert.equal(state().alive[guests[0]], false, 'Am Spielende sind auch ungemeldete Opfer öffentlich');
  act(killers[0], 'sabotage');
  t.mock.timers.tick(6000);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].groups[0], killers);
});

test('Geister helfen beim Aufgabensieg, Mörder und wiederholte Aufgaben erhöhen den Zähler nicht', t => {
  const { game, state, phone, killers, guests, choose, act } = round(t);
  const solveStep = (id: string, room: number, step: number, fields = {}) => {
    const options = ferienAufgabe(room, step).optionen;
    const choice = options.findIndex((_, i) => ferienStepCorrect(room, step, i));
    assert.notEqual(choice, -1);
    act(id, 'taskStep', { room, step, choice, ...fields });
  };
  const work = (id: string, room: number) => {
    choose(id, room);
    for (let step = 0; step < FERIEN_STEPS; step++) solveStep(id, room, step);
  };
  game.skip();
  assert.equal(state().taskTarget, guests.length * MURDER.TASKS_PER_PLAYER);
  const ghost = guests[0];
  choose(killers[0], 0);
  choose(ghost, 0);
  act(killers[0], 'kill');
  assert.equal(phone(ghost).alive, false);
  work(killers[0], 0);
  assert.deepEqual(phone(killers[0]).doneRooms, [0]);
  assert.equal(state().taskProgress, 0);
  solveStep(ghost, 0, 0, { choice: ferienAufgabe(0, 0).optionen.findIndex((_, i) => !ferienStepCorrect(0, 0, i)) });
  solveStep(ghost, 1, 0);
  solveStep(ghost, 0, 0, { phaseNo: state().phaseNo - 1 });
  solveStep(ghost, 0, 1);
  assert.equal(phone(ghost).taskTaps, 0);
  solveStep(ghost, 0, 0);
  const progress = phone(ghost).taskTaps;
  assert.ok(progress > 0);
  solveStep(ghost, 0, 0);
  assert.equal(phone(ghost).taskTaps, progress);
  solveStep(ghost, 0, 1);
  assert.equal(state().taskProgress, 0);
  solveStep(ghost, 0, 2);
  work(ghost, 0);
  assert.equal(state().taskProgress, 1);
  // Auf einem zweiten Handy erledigt ein älterer Client die Aufgabe weiterhin durch Antippen.
  choose(guests[1], 0);
  for (let i = 0; i < MURDER.TASK_TAPS; i++) game.input(guests[1], 'task', {});
  assert.equal(state().taskProgress, 2);
  for (const guest of guests) for (let room = 0; room < ROOMS.length; room++) work(guest, room);
  assert.equal(state().taskProgress, guests.length * ROOMS.length);
  t.mock.timers.tick(MURDER.TASKS_MS);
  game.skip();
  game.skip();
  game.skip();
  for (const id of guests) for (let room = 0; room < MURDER.TASKS_PER_PLAYER - ROOMS.length; room++) work(id, room);
  assert.equal(state().taskProgress, state().taskTarget);
  assert.equal(state().winner, 'urlauber');
});

test('Mörder gewinnen, sobald gleich viele Urlauber und Täter übrig sind', t => {
  const { game, state, killers, guests, choose, act } = round(t);
  const [killer] = killers;
  const [victim, witness, innocent] = guests;
  game.skip();
  choose(killer, 0);
  choose(victim, 0);
  act(killer, 'kill');
  choose(witness, 0);
  act(witness, 'report');
  game.skip();
  for (const id of [killer, witness, innocent]) act(id, 'vote', { target: innocent });
  assert.equal(state().ejected, innocent);
  t.mock.timers.tick(MURDER.EJECT_MS);
  assert.equal(state().winner, 'murderer', 'Ein Täter und ein Urlauber sind am Leben');
});
