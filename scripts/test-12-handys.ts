/** Lokaler Kart-Spieltest: zwölf Controller, drei Verbindungsunterbrechungen und ein gemeinsames Ergebnis. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { randomLook } from '../shared/avatar';
import { autopilot, getTrack, KART } from '../shared/kart';
import type { GameLive, GameMeta, JoinResponse, KartState } from '../shared/types';

const COUNT = 12;
const PAUSES = [2, 10, 60] as const;
const root = fileURLToPath(new URL('../', import.meta.url));

/** Eigener Prozess, unveränderte Raumlogik und ein freier Loopback-Port. */
async function serve() {
  const { Room } = await import('../server/room');
  const http = createServer();
  const sockets = new Server(http, { pingInterval: 10_000, pingTimeout: 12_000 });
  http.listen(0, '127.0.0.1', () => {
    const address = http.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const room = new Room(sockets, url, url);
    sockets.on('connection', (socket) => room.handle(socket));
    process.send!(url);
  });
  process.once('disconnect', () => process.exit());
}

function kart(live?: GameLive): KartState | undefined {
  return live?.phase === 'mini' && live.mini?.kind === 'kart' ? live.mini.state : undefined;
}

class Phone {
  readonly socket;
  readonly look = randomLook();
  readonly name: string;
  id = '';
  meta?: GameMeta;
  live?: GameLive;
  snapshots = 0;
  joined = false;
  lastGas?: boolean;

  constructor(url: string, index: number, measure?: (s: GameLive) => void) {
    this.name = `Handy ${index + 1}`;
    this.socket = io(url, { transports: ['websocket'], forceNew: true, autoConnect: false, reconnection: false });
    this.socket.on('meta', (m: GameMeta) => { this.meta = m; });
    this.socket.on('state', (s: GameLive) => {
      this.live = s;
      if (kart(s)?.sub === 'race') {
        this.snapshots++;
        measure?.(s);
      }
    });
  }

  async join() {
    this.joined = false;
    this.meta = undefined;
    this.live = undefined;
    this.socket.connect();
    const reply: JoinResponse = await this.socket.timeout(8000).emitWithAck('player:join', {
      name: this.name, look: this.look, playerId: this.id || undefined,
    });
    assert(reply.ok && reply.playerId, `${this.name}: ${reply.error ?? 'Beitritt fehlgeschlagen'}`);
    if (this.id) assert.equal(reply.playerId, this.id, 'Verbindung muss dieselbe ID wiederbekommen');
    this.id = reply.playerId;
    this.lastGas = undefined; // Auch nach Rückkehr erst wieder bewusst Gas antippen.
    this.joined = true;
  }
}

async function race(url: string, signal: AbortSignal) {
  const stop = new AbortController();
  const active = AbortSignal.any([signal, stop.signal]);
  async function until(label: string, check: () => boolean, ms = 10_000) {
    const limit = performance.now() + ms;
    while (!check()) {
      assert(performance.now() < limit, `Zeitlimit bei: ${label}`);
      await sleep(30, undefined, { signal: active });
    }
  }

  let first = 0, last = 0;
  const sizes: number[] = [];
  const phones = Array.from({ length: COUNT }, (_, i) => new Phone(url, i, i === 0 ? (state) => {
    last = performance.now();
    if (!sizes.length) first = last;
    sizes.push(Buffer.byteLength(JSON.stringify(state)));
  } : undefined));
  const ref = phones[0];
  let driving: NodeJS.Timeout | undefined;
  try {
    await ref.join(); // erster menschlicher Spieler wird VIP
    await Promise.all(phones.slice(1).map((p) => p.join()));
    const ids = new Set(phones.map((p) => p.id));
    assert.equal(ids.size, COUNT);
    await until('zwölf Spieler in der Lobby', () => ref.meta?.players.filter((p) => p.connected).length === COUNT);
    function checkRoster() {
      const players = ref.meta!.players;
      assert.equal(players.length, COUNT);
      assert.deepEqual(new Set(players.map((p) => p.id)), ids);
    }
    checkRoster();
    const original = new Map(ref.meta!.players.map((p) => [p.id, p]));
    ref.socket.emit('vip:start', { mode: 'kart' });
    await until('Aufwärmrunde auf allen Handys', () => phones.every((p) => p.live?.phase === 'intro' && p.live.intro?.kind === 'kart'));
    for (const p of phones) p.socket.emit('intro:ready');
    await until('Rennstart auf allen Handys', () => phones.every((p) => kart(p.live)?.sub === 'race'), 20_000);
    const seq = ref.live!.miniSeq;
    const track = getTrack(kart(ref.live)!.track);
    assert.deepEqual(new Set(Object.keys(kart(ref.live)!.karts)), ids);

    // Wer Runde 2 erreicht, wartet auf das Feld: Auch nach 60 s Pause soll jeder noch mitfahren können.
    driving = setInterval(() => {
      const field = kart(ref.live);
      if (!field) return;
      const allInLapTwo = Object.values(field.karts).every((c) => c.lap >= 2);
      for (const [i, p] of phones.entries()) {
        const k = kart(p.live);
        const c = k?.karts[p.id];
        if (!p.joined || !p.socket.connected || !k || k.sub !== 'race' || !c || c.finished) continue;
        const lane = ((i % 6) - 2.5) * 2;
        const { steer } = autopilot(track, c.x, c.y, c.angle, Math.hypot(c.vx, c.vy), lane);
        const gas = allInLapTwo || c.lap < 2;
        const pedal = p.lastGas === gas ? {} : { autoGas: gas, gas: false };
        p.socket.emit('mini:input', { action: 'steer', payload: { miniSeq: seq, x: steer, brake: false, drift: false, ...pedal } });
        p.lastGas = gas;
      }
    }, 120);

    await until('erste Bewegung', () => Object.values(kart(ref.live)!.karts).every((c) => Math.hypot(c.vx, c.vy) > 1));
    await Promise.all(PAUSES.map(async (seconds, index) => {
      const p = phones[COUNT - 1 - index];
      p.socket.disconnect();
      await until(`Offline-Anzeige für ${p.name}`, () => ref.meta?.players.find((o) => o.id === p.id)?.connected === false);
      await sleep(seconds * 1000, undefined, { signal: active });
      await p.join();
      await until(`Rückkehr von ${p.name}`, () => !!kart(p.live)?.karts[p.id] && ref.meta?.players.find((o) => o.id === p.id)?.connected === true);
      const player = ref.meta!.players.find((o) => o.id === p.id)!;
      assert.equal(p.live!.miniSeq, seq);
      assert.equal(player.name, p.name);
      assert.equal(player.color, original.get(p.id)!.color);
      assert.deepEqual(player.look, original.get(p.id)!.look);
      checkRoster();
      const lap = kart(p.live)!.karts[p.id].lap;
      await until(`GAS nach Wiederbeitritt von ${p.name}`, () => kart(p.live)?.karts[p.id].autoGas === true);
      await until(`Rundenfortschritt nach ${seconds} s Pause`, () => (kart(p.live)?.karts[p.id].lap ?? 0) > lap, KART.MAX_RACE_MS);
      console.log(`${p.name}: nach ${seconds} s mit derselben ID zurück und weitergefahren.`);
    }));
    await until('Ergebnis auf allen zwölf Handys', () => phones.every((p) => p.live?.phase === 'results'), KART.MAX_RACE_MS);
    checkRoster();
    assert(ref.meta!.players.every((p) => p.connected));
    const rows = ref.live!.results!.rows;
    assert.equal(rows.length, COUNT);
    assert.deepEqual(new Set(rows.map((r) => r.playerId)), ids);
    assert(rows.some((r) => r.detail.startsWith('Ziel:')), 'Mindestens ein Kart muss die Ziellinie erreicht haben');
    for (const p of phones) {
      assert.deepEqual(p.live!.results!.rows, rows);
      assert(p.snapshots > 0);
    }
    assert(sizes.length >= 2 && last > first);
    sizes.sort((a, b) => a - b);
    const duration = (last - first) / 1000;
    const percentile = (p: number) => sizes[Math.ceil(p * sizes.length) - 1];
    console.table([{
      Strecke: track.def.name, Spieler: COUNT, Ziel: rows.filter((r) => r.detail.startsWith('Ziel:')).length,
      'Messdauer (s)': +duration.toFixed(2), 'state an Handy 1': sizes.length,
      'state/s': +((sizes.length - 1) / duration).toFixed(2),
      'JSON P50 (B)': percentile(0.5), 'JSON P95 (B)': percentile(0.95), 'JSON Max (B)': sizes[sizes.length - 1],
      'state-Empfänge gesamt (12)': phones.reduce((n, p) => n + p.snapshots, 0),
    }]);
  } finally {
    stop.abort();
    clearInterval(driving);
    for (const p of phones) p.socket.disconnect();
  }
}

/** Der Raum speichert relativ zu server/. Die Testkopie besitzt ausschließlich eigene Daten. */
async function run() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lan-abfahrt-12-'));
  const interrupted = new AbortController();
  const cancel = () => interrupted.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(KART.MAX_RACE_MS + 60_000)]);
  let server: ReturnType<typeof fork> | undefined;
  try {
    const script = path.join(dir, 'scripts', 'test-12-handys.ts');
    await mkdir(path.dirname(script));
    await Promise.all([
      cp(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true }),
      cp(path.join(root, 'shared'), path.join(dir, 'shared'), { recursive: true }),
      cp(path.join(root, 'package.json'), path.join(dir, 'package.json')),
      cp(fileURLToPath(import.meta.url), script),
      symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction'),
    ]);
    server = fork(script, ['--room'], { cwd: dir, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const [url] = await once(server, 'message', { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    await race(url, signal);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit', { signal: AbortSignal.timeout(5000) });
      server.kill();
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

await (process.argv[2] === '--room' ? serve() : run());
