import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { Room } from '../server/room';
import type { GameLive, GameMeta, HostInfo, JoinResponse } from '../shared/types';

// host:hello liefert info, meta und state in dieser Reihenfolge, auch zwischen zwei regulären Updates.
function view(socket: Socket): Promise<{ info: HostInfo; meta: GameMeta; state: GameLive }> {
  return new Promise((resolve) => {
    socket.once('host:info', (info: HostInfo) => {
      socket.once('meta', (meta: GameMeta) => {
        socket.once('state', (state: GameLive) => resolve({ info, meta, state }));
      });
    });
    socket.emit('host:hello');
  });
}

async function join(socket: Socket, name: string, playerId?: string) {
  const res: JoinResponse = await socket.timeout(2000).emitWithAck('player:join', { name, playerId });
  assert.ok(res.ok && res.playerId, res.error);
  return res.playerId;
}

// Der Ping quittiert, dass der Server die vorherige Aktion dieses Handys verarbeitet hat.
async function action(socket: Socket, event: string, ...args: unknown[]) {
  socket.emit(event, ...args);
  await socket.timeout(2000).emitWithAck('time:ping', 0);
}

function handoff(socket: Socket, target: string): Promise<{ ok: boolean; error?: string }> {
  return socket.timeout(2000).emitWithAck('host:vip', target);
}

test('Laptop übergibt den VIP in der Lobby, im Spiel und bei einem Verbindungsabbruch', { timeout: 10_000 }, async (t) => {
  const http = createServer();
  const io = new Server(http);
  const room = new Room(io, '', '');
  io.on('connection', (socket) => room.handle(socket));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  assert.ok(addr && typeof addr === 'object');
  const url = `http://127.0.0.1:${addr.port}`;
  const sockets: Socket[] = [];
  function client(laptop = false) {
    const socket = connect(url, {
      transports: ['websocket'], reconnection: false,
      // Online-Handys kommen wie beim regulären Tunnel mit Proxy-Header am Laptop an.
      extraHeaders: laptop ? {} : { 'x-forwarded-for': '192.0.2.10' },
    });
    sockets.push(socket);
    return socket;
  }
  const tv = client(true);
  t.after(async () => {
    try {
      if (tv.connected) await tv.timeout(2000).emitWithAck('host:cmd', 'abort');
    } finally {
      sockets.forEach((socket) => socket.disconnect());
      await io.close();
    }
  });
  async function expectVip(id: string) {
    const { meta } = await view(tv);
    assert.deepEqual(meta.players.filter((p) => p.isVip).map((p) => p.id), [id]);
  }

  const ada = client();
  const ben = client();
  const adaId = await join(ada, 'Ada');
  const benId = await join(ben, 'Ben');
  assert.equal((await view(tv)).info.local, true);
  assert.equal((await view(ben)).info.local, false);
  await expectVip(adaId);
  assert.equal((await handoff(ben, benId)).ok, false);
  assert.equal((await handoff(tv, 'unbekannt')).ok, false);
  await expectVip(adaId);

  assert.equal((await handoff(tv, benId)).ok, true);
  await expectVip(benId);
  await action(ada, 'vip:mode', 'turnier');
  assert.equal((await view(tv)).state.mode, 'party');
  await action(ben, 'vip:mode', 'arcade');
  assert.equal((await view(tv)).state.mode, 'arcade');

  await action(ben, 'vip:start', { mode: 'wwe' });
  await action(ben, 'vip:continue');
  const game = (await view(tv)).state;
  assert.equal(game.phase, 'mini');
  assert.equal(game.mini?.kind, 'wwe');
  assert.equal((await handoff(tv, adaId)).ok, true);
  await expectVip(adaId);
  await action(ben, 'vip:lobby');
  const after = (await view(tv)).state;
  assert.equal(after.phase, 'mini');
  assert.equal(after.miniSeq, game.miniSeq);
  await action(ada, 'vip:lobby');
  assert.equal((await view(tv)).state.phase, 'lobby');

  const offline = new Promise<void>((resolve) => {
    function onMeta(meta: GameMeta) {
      if (!meta.players.some((p) => p.id === adaId && !p.connected)) return;
      tv.off('meta', onMeta);
      resolve();
    }
    tv.on('meta', onMeta);
  });
  ada.disconnect();
  await offline;
  assert.equal((await handoff(tv, adaId)).ok, false);
  assert.equal((await handoff(tv, benId)).ok, true);
  assert.equal(await join(client(), 'Ada', adaId), adaId);
  await expectVip(benId);
});
