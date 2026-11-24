import type { MurderPrivate, MurderState } from '../../../shared/types';
import { MURDER, ROOMS } from '../../../shared/games';
import { FERIEN_STEPS, ferienAufgabe, ferienStepCorrect } from '../../../shared/ferienaufgaben';
import { type Screen, app, el, escapeHtml, message, nameOf, playerButtons, q, send, socket, store, timerText } from '../core';

const murder = () => (store.state?.mini?.kind === 'murder' ? store.state.mini.state : null);
const priv = (): MurderPrivate | null => (store.priv?.kind === 'murder' ? store.priv.state : null);

export function pickMurder(m: MurderState, vip: boolean): Screen {
  const p = priv();
  if (!p) return ['m-wait', message('Moment ...')];
  switch (m.sub) {
    case 'roles':
      return ['m-roles', buildRoles];
    case 'tasks':
      return [`m-tasks-${m.phaseNo}`, buildTasks];
    case 'meeting':
      return [`m-meeting-${m.phaseNo}-${vip}`, () => buildMeeting(vip)];
    case 'vote':
      if (!p.alive) return [`m-vote-dead-${m.phaseNo}`, message('Abstimmung läuft', 'Tote stimmen nicht ab. Psst!')];
      return p.myVote ? [`m-voted-${m.phaseNo}`, message('Abgestimmt!', 'Warte auf die anderen ...')] : [`m-vote-${m.phaseNo}`, buildVote];
    case 'ejected':
      return [`m-ejected-${m.phaseNo}`, () => buildEjected(m)];
    case 'over': {
      const won = (m.winner === 'murderer') === (p.role === 'murderer');
      return ['m-over', message(won ? 'GEWONNEN!' : 'VERLOREN!', m.winReason ?? '')];
    }
  }
}

/** Rolle nur sichtbar, solange man den Button gedrückt hält – damit niemand mitliest. */
function roleHold(container: HTMLElement) {
  const btn = el(`<button class="secondary role-btn">Rolle ansehen (gedrückt halten)</button>`).firstElementChild as HTMLButtonElement;
  const show = () => {
    const p = priv();
    if (!p) return;
    const partners = p.partners.length ? ` – Komplize: ${p.partners.map(nameOf).join(', ')}` : '';
    btn.textContent = p.role === 'murderer' ? `MÖRDER${partners}` : 'Urlauber';
    btn.classList.toggle('danger', p.role === 'murderer');
  };
  const hide = () => {
    btn.textContent = 'Rolle ansehen (gedrückt halten)';
    btn.classList.remove('danger');
  };
  btn.addEventListener('pointerdown', (e) => (e.preventDefault(), show()));
  btn.addEventListener('pointerup', hide);
  btn.addEventListener('pointerleave', hide);
  btn.addEventListener('pointercancel', hide);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  container.append(btn);
}

function buildRoles() {
  const root = el(`
    <h1>MORD IM<br/>FERIENHAUS</h1>
    <p>Halte den Knopf gedrückt, damit niemand mitliest.</p>
    <div class="slot center"></div>
    <div class="panel">
      <p class="label-left">Urlauber erledigen Aufgaben. Fällt der Strom aus, repariert beide Stationen, bevor die Zeit abläuft.</p>
      <p class="label-left">Mörder können zuschlagen, wenn sie mit ihrem Opfer allein sind. Ihr Team kann einmal pro Tag den Strom abschalten.</p>
      <p class="label-left">Melde eine Leiche oder rufe einmal pro Partie eine Notfallsitzung ein.</p>
      <p class="label-left">Tote reden nicht!</p>
    </div>
  `);
  roleHold(q(root, '.slot'));
  app.append(root);
  return null;
}

function buildTasks() {
  const phaseNo = murder()!.phaseNo;
  const isMurderer = priv()!.role === 'murderer';
  const root = el(`
    <div class="top-row"><span class="timer"></span><span class="status"></span></div>
    <div class="dead-banner hidden">Du bist tot! Psst – nicht verraten. Als Geist kannst du weiter Aufgaben machen.</div>
    <div class="panel outage hidden">
      <h2>Stromausfall!</h2>
      <p class="repair-goal"></p>
      <div class="stations"><p></p><p></p></div>
    </div>
    <div class="rooms"></div>
    <button class="hidden repair-btn">Station reparieren</button>
    <div class="panel task-panel">
      <p class="task-text"></p>
      <h2 class="task-question"></h2>
      <div class="center task-choices"></div>
      <p class="task-feedback" role="status"></p>
    </div>
    ${isMurderer ? '<button class="danger hidden kill-btn"></button><button class="danger hidden sabotage-btn">Strom sabotieren</button>' : ''}
    <button class="report hidden report-btn">LEICHE MELDEN!</button>
    <button class="secondary hidden emergency-btn">Notfallsitzung einrufen</button>
    <div class="slot"></div>
  `);
  const roomsEl = q(root, '.rooms');
  const stationRows = root.querySelectorAll('.stations p');
  const roomBtns = ROOMS.map((r, i) => {
    const b = document.createElement('button');
    b.className = 'room-btn';
    b.textContent = r.name;
    b.addEventListener('click', () => {
      send('room', { room: i });
      navigator.vibrate?.(10);
    });
    roomsEl.append(b);
    return b;
  });
  const updateTask = roomTask(q(root, '.task-panel'), phaseNo);
  const killBtn = root.querySelector<HTMLButtonElement>('.kill-btn');
  killBtn?.addEventListener('click', () => {
    send('kill');
    navigator.vibrate?.([100, 50, 100]);
  });
  const sabotageBtn = root.querySelector<HTMLButtonElement>('.sabotage-btn');
  sabotageBtn?.addEventListener('click', () => send('sabotage', { phaseNo }));
  const emergencyBtn = q<HTMLButtonElement>(root, '.emergency-btn');
  emergencyBtn.addEventListener('click', () => send('emergency', { phaseNo }));
  const repairBtn = q<HTMLButtonElement>(root, '.repair-btn');
  repairBtn.addEventListener('click', () => send('repair', { phaseNo }));
  q(root, '.report-btn').addEventListener('click', () => send('report'));
  roleHold(q(root, '.slot'));
  app.append(root);

  return () => {
    const p = priv();
    const m = murder();
    if (!p || !m) return;
    const outage = m.sabotage;
    q(root, '.timer').textContent = timerText(sec => outage ? `Reparatur: ${sec}s` : `${sec}s`);
    q(root, '.status').textContent = `Aufgaben ${Math.round((m.taskProgress / Math.max(1, m.taskTarget)) * 100)}%`;
    q(root, '.dead-banner').classList.toggle('hidden', p.alive);
    q(root, '.outage').classList.toggle('hidden', !outage);
    updateTask(p, !!outage);
    if (outage) {
      q(root, '.repair-goal').textContent = p.alive ? 'Geh in einen Raum mit offener Station und repariere sie.' : 'Nur Lebende können den Strom wiederherstellen.';
      outage.stations.forEach((room, i) => {
        stationRows[i].textContent = `${ROOMS[room].name} · ${outage.repaired.includes(room) ? 'repariert' : 'offen'}`;
      });
    }
    const canRepair = p.alive && p.room !== null && outage?.stations.includes(p.room) && !outage.repaired.includes(p.room);
    repairBtn.classList.toggle('hidden', !canRepair);
    sabotageBtn?.classList.toggle('hidden', !p.canSabotage);
    emergencyBtn.classList.toggle('hidden', !p.canEmergency);
    roomBtns.forEach((b, i) => {
      b.classList.toggle('active', p.room === i);
      b.setAttribute('aria-pressed', String(p.room === i));
      b.classList.toggle('done', !outage && p.doneRooms.includes(i));
      const marker = outage && outage.stations.includes(i) ? (outage.repaired.includes(i) ? ' ✓' : ' ⚡') : '';
      b.textContent = ROOMS[i].name + marker;
    });
    if (killBtn) {
      killBtn.classList.toggle('hidden', !p.alive || !p.killTarget);
      if (p.killTarget) killBtn.textContent = `AUSSCHALTEN: ${nameOf(p.killTarget)}`;
    }
    q(root, '.report-btn').classList.toggle('hidden', !p.bodyHere);
  };
}

function roomTask(panel: HTMLElement, phaseNo: number) {
  const title = q(panel, '.task-text');
  const question = q(panel, '.task-question');
  const choices = q(panel, '.task-choices');
  const feedback = q(panel, '.task-feedback');
  let lastKey = '';
  return (p: MurderPrivate, paused: boolean) => {
    const room = p.room;
    const done = room !== null && p.doneRooms.includes(room);
    const step = Math.floor(p.taskTaps / (MURDER.TASK_TAPS / FERIEN_STEPS));
    const key = `${room}/${step}/${done}/${paused}`;
    if (key === lastKey) return;
    lastKey = key;
    choices.replaceChildren();
    feedback.textContent = '';
    question.textContent = '';
    panel.classList.toggle('hidden', paused);
    if (paused) return;
    if (room === null || done) {
      title.textContent = room === null ? 'Wähle einen Raum für deine Aufgabe.' : `${ROOMS[room].name} ist erledigt. Wähle einen anderen Raum.`;
      return;
    }
    const task = ferienAufgabe(room, step);
    title.textContent = `${ROOMS[room].name} · Schritt ${step + 1}/${FERIEN_STEPS}`;
    question.textContent = task.frage;
    task.optionen.forEach((label, choice) => {
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (!ferienStepCorrect(room, step, choice)) {
          feedback.textContent = 'Das passt noch nicht. Versuch es noch einmal.';
          return;
        }
        choices.querySelectorAll('button').forEach(b => { b.disabled = true; });
        send('taskStep', { phaseNo, room, step, choice });
        navigator.vibrate?.(10);
      });
      choices.append(button);
    });
  };
}

function buildMeeting(vip: boolean) {
  const m = murder()!;
  const reporter = escapeHtml(nameOf(m.reporter));
  const reason = m.meetingReason === 'emergency' ? `${reporter} hat die Notfallsitzung einberufen.`
    : m.meetingReason === 'body' ? `${reporter} hat eine Leiche gemeldet.` : 'Die Zeit für die Aufgaben ist um.';
  const deaths = m.deaths.length ? `Tot: ${escapeHtml(m.deaths.map(nameOf).join(', '))}` : 'Keine neuen Todesfälle.';
  const root = el(`
    <div class="center">
      <h1>${m.meetingReason === 'emergency' ? 'NOTFALLSITZUNG' : 'BESPRECHUNG'}</h1>
      <h2>${reason}</h2>
      <p>${deaths}</p>
      <p>${priv()?.alive ? 'Diskutiert am Tisch: Wer war wo? Wer lügt?' : 'Du bist ein Geist. Hör zu und behalte deinen Verdacht für dich.'}</p>
      <p class="timer"></p>
    </div>
  `);
  if (vip) {
    const b = el(`<button>Zur Abstimmung</button>`).firstElementChild as HTMLButtonElement;
    b.addEventListener('click', () => socket.emit('vip:mini', 'skip'));
    root.append(b);
  }
  app.append(root);
  return () => {
    q(root, '.timer').textContent = timerText((sec) => `Abstimmung in ${sec}s`);
  };
}

function buildVote() {
  const m = murder()!;
  const root = el(`<h2>Wen werft ihr raus?</h2><p class="timer"></p>`);
  const alive = (store.state?.players ?? []).filter((p) => m.alive[p.id] && p.id !== store.playerId);
  let sent = false;
  const vote = (target: string) => {
    if (sent) return;
    sent = true;
    send('vote', { target });
  };
  root.append(playerButtons(alive, vote));
  const skip = el(`<button class="secondary">Überspringen</button>`).firstElementChild as HTMLButtonElement;
  skip.addEventListener('click', () => vote('skip'));
  root.append(skip);
  app.append(root);
  return () => {
    q(root, '.timer').textContent = timerText();
  };
}

function buildEjected(m: MurderState) {
  const name = m.ejected ? nameOf(m.ejected) : null;
  const isMe = m.ejected === store.playerId;
  app.append(
    el(`
      <div class="center">
        <h1>${name ? `${escapeHtml(name)} fliegt raus!` : 'Niemand fliegt raus.'}</h1>
        ${isMe ? '<h2 class="pink">Das bist du! Ab jetzt bist du ein Geist.</h2>' : ''}
        ${name ? `<h2>${m.ejectedWasMurderer ? 'Das war der Mörder!' : 'Unschuldig ...'}</h2>` : ''}
      </div>
    `),
  );
  return null;
}
