import type { MiniSnapshot, MurderPrivate, MurderState, PrivateState, SkipInfo } from '../shared/types';
import { FERIEN_STEPS, ferienStepCorrect } from '../shared/ferienaufgaben';
import { MURDER, ROOMS } from '../shared/games';
import { type MiniCtx, type MiniGame, Timers, asRecord, endsIn, phaseTimer, shuffle, waitLabel } from './minigame';

interface Body {
  victim: string;
  room: number;
  found: boolean;
  announced: boolean;
}

/**
 * Mord im Ferienhaus – Among-Us-light fürs Handy.
 *
 * Aufgabenphase: Jeder wählt am Handy einen Raum und erledigt dort Aufgaben.
 * Der Mörder kann jemanden ausschalten, wenn er mit genau einer Person allein im Raum ist.
 * Wer eine Leiche findet, kann sie melden → Besprechung → Abstimmung.
 * Urlauber gewinnen, wenn alle Aufgaben erledigt sind oder der Mörder rausgewählt wird.
 */
export class MurderGame implements MiniGame {
  readonly kind = 'murder' as const;
  private state: MurderState;
  private murderers: string[];
  private room = new Map<string, number | null>();
  private taps = new Map<string, number>();
  private done = new Map<string, Set<number>>();
  private killedThisPhase = new Set<string>();
  private bodies: Body[] = [];
  private emergencyUsed = new Set<string>();
  private sabotageUsed = false;
  private tasksLeft = 0;
  private votes = new Map<string, string>();
  private deadline = 0;
  private timers = new Timers();

  constructor(
    private ids: string[],
    private ctx: MiniCtx,
  ) {
    const count = ids.length >= 7 ? 2 : 1;
    this.murderers = shuffle(ids).slice(0, count);
    const urlauber = ids.length - count;
    this.state = {
      sub: 'roles',
      endsIn: 0,
      phaseNo: 0,
      alive: Object.fromEntries(ids.map((id) => [id, true])),
      roomCounts: ROOMS.map(() => 0),
      taskProgress: 0,
      taskTarget: urlauber * MURDER.TASKS_PER_PLAYER,
      deaths: [],
      sabotage: null,
      meetingReason: null,
      reporter: null,
      voted: [],
      voteTally: null,
      ejected: null,
      ejectedWasMurderer: null,
      winner: null,
      winReason: null,
      murderers: null,
      screamSeq: 0,
    };
    this.setDeadline(MURDER.ROLES_MS);
    this.timers.later(MURDER.ROLES_MS, () => this.startTasks());
  }

  snapshot(): MiniSnapshot {
    const alive = { ...this.state.alive };
    if (this.state.sub === 'tasks') {
      // Ein Schrei verrät keinen Namen. Erst in der Besprechung wird das Opfer öffentlich.
      for (const body of this.bodies) if (!body.announced) alive[body.victim] = true;
    }
    const counts = ROOMS.map(() => 0);
    for (const id of this.ids) {
      const r = this.room.get(id);
      if (this.state.alive[id] && r !== null && r !== undefined) counts[r] += 1;
    }
    return {
      kind: 'murder',
      state: { ...this.state, alive, roomCounts: counts, endsIn: endsIn(this.deadline) },
    };
  }

  privateFor(id: string): PrivateState {
    if (!this.ids.includes(id)) return null;
    const isMurderer = this.murderers.includes(id);
    const r = this.room.get(id) ?? null;
    const s = this.state;
    const priv: MurderPrivate = {
      role: isMurderer ? 'murderer' : 'urlauber',
      partners: isMurderer ? this.murderers.filter((m) => m !== id) : [],
      alive: s.alive[id],
      room: r,
      taskTaps: this.taps.get(id) ?? 0,
      doneRooms: [...(this.done.get(id) ?? [])],
      killTarget: s.sub === 'tasks' ? this.killTargetFor(id) : null,
      bodyHere: s.sub === 'tasks' && s.alive[id] && r !== null && this.bodies.some((b) => !b.found && b.room === r),
      canSabotage: this.canSabotage(id),
      canEmergency: this.canEmergency(id),
      myVote: this.votes.get(id) ?? null,
    };
    return { kind: 'murder', state: priv };
  }

  input(id: string, action: string, payload: unknown) {
    if (!this.ids.includes(id) || !this.ctx.isConnected(id)) return;
    const s = this.state;
    const p = asRecord(payload);

    if (p.phaseNo !== undefined && p.phaseNo !== s.phaseNo) return;
    if (s.sub === 'tasks') {
      // Auch bei verzögerten Timer-Callbacks entscheidet die Serverfrist über die letzte Eingabe.
      if (Date.now() >= this.deadline) {
        if (s.sabotage) this.blackoutExpired();
        else this.meeting(null, 'timeout');
        return;
      }
      if (action === 'sabotage') {
        if (this.canSabotage(id)) this.startBlackout();
      } else if (action === 'repair') {
        this.repair(id);
      } else if (action === 'emergency') {
        if (!this.canEmergency(id)) return;
        this.emergencyUsed.add(id);
        this.meeting(id, 'emergency');
      } else if (action === 'room') {
        const r = Number(p.room);
        if (!Number.isInteger(r) || r < 0 || r >= ROOMS.length || this.room.get(id) === r) return;
        this.room.set(id, r);
        this.taps.set(id, 0);
        this.ctx.onChange();
      } else if (action === 'task' || action === 'taskStep') {
        if (!s.sabotage) this.task(id, action === 'taskStep' ? p : undefined);
      } else if (action === 'kill') {
        this.kill(id);
      } else if (action === 'report') {
        const r = this.room.get(id);
        const body = this.bodies.find((b) => !b.found && b.room === r);
        if (s.alive[id] && body) this.meeting(id, 'body');
      }
    } else if (s.sub === 'vote' && action === 'vote') {
      if (!s.alive[id]) return;
      const target = String(p.target ?? '');
      if (target !== 'skip' && !(this.ids.includes(target) && s.alive[target])) return;
      this.votes.set(id, target);
      s.voted = [...this.votes.keys()];
      const voters = this.ids.filter((v) => s.alive[v] && this.ctx.isConnected(v));
      if (voters.every((v) => this.votes.has(v))) {
        this.timers.clear();
        this.tallyVotes();
      } else {
        this.ctx.onChange();
      }
    }
  }

  vipAction(action: string) {
    if (action === 'skip' && this.state.sub === 'meeting') {
      this.timers.clear();
      this.startVote();
    }
  }

  /** VIP/Laptop: Rollen-Screen, Diskussion, Abstimmung (fehlende Stimmen verfallen) und Rauswurf-Screen abkürzen */
  skippable(): SkipInfo | null {
    const s = this.state;
    if (s.sub === 'roles') return { label: 'Los geht’s', info: true };
    if (s.sub === 'meeting') return { label: 'Diskussion beenden', info: true };
    if (s.sub === 'vote') {
      const missing = this.ids.filter((v) => s.alive[v] && this.ctx.isConnected(v) && !this.votes.has(v));
      return { label: waitLabel(this.ctx, missing, 'Stimme', 'Abstimmung beenden') };
    }
    if (s.sub === 'ejected') return { label: 'Weiter', info: true };
    return null;
  }

  skip() {
    if (!this.skippable()) return;
    const s = this.state;
    this.timers.clear();
    if (s.sub === 'roles') this.startTasks();
    else if (s.sub === 'meeting') this.startVote();
    else if (s.sub === 'vote') this.tallyVotes();
    else if (s.sub === 'ejected' && !this.checkWin()) this.startTasks();
  }

  playerDisconnected() {
    // Spieler bleiben im Spiel – beim Wiederverbinden geht es weiter.
    // Läuft gerade eine Abstimmung, nicht auf Abwesende warten.
    const s = this.state;
    if (s.sub !== 'vote') return;
    const voters = this.ids.filter((v) => s.alive[v] && this.ctx.isConnected(v));
    if (voters.every((v) => this.votes.has(v))) {
      this.timers.clear();
      this.tallyVotes();
    }
  }

  dispose() {
    this.timers.clear();
  }

  // ---------------------------------------------------------------- Phasen

  private startTasks() {
    const s = this.state;
    s.sub = 'tasks';
    s.phaseNo += 1;
    s.deaths = [];
    s.reporter = null;
    s.meetingReason = null;
    s.voted = [];
    this.votes.clear();
    this.sabotageUsed = false;
    s.voteTally = null;
    s.ejected = null;
    s.ejectedWasMurderer = null;
    this.killedThisPhase.clear();
    for (const id of this.ids) {
      this.room.set(id, null);
      this.taps.set(id, 0);
      this.done.set(id, new Set());
    }
    this.runTaskClock(MURDER.TASKS_MS);
    this.ctx.onChange();
  }

  private runTaskClock(ms: number) {
    this.deadline = phaseTimer(this.timers, ms, () => this.meeting(null, 'timeout'));
  }

  private canEmergency(id: string) {
    const s = this.state;
    return s.sub === 'tasks' && s.alive[id] && !s.sabotage && !this.emergencyUsed.has(id);
  }

  private canSabotage(id: string) {
    const s = this.state;
    return s.sub === 'tasks' && s.alive[id] && !this.sabotageUsed && this.murderers.includes(id);
  }

  private startBlackout() {
    this.sabotageUsed = true;
    this.tasksLeft = endsIn(this.deadline);
    this.timers.clear();
    const [first, second] = shuffle(ROOMS.map((_, i) => i));
    this.deadline = phaseTimer(this.timers, MURDER.SABOTAGE_MS, () => this.blackoutExpired());
    this.state.sabotage = { stations: [first, second], repaired: [], endsAt: this.deadline };
    this.ctx.onChange();
  }

  private blackoutExpired() {
    this.end('murderer', 'Der Strom ist ausgefallen – die Reparatur kam zu spät!');
  }

  private repair(id: string) {
    const s = this.state;
    const outage = s.sabotage;
    const room = this.room.get(id);
    if (!outage || !s.alive[id] || room == null || !outage.stations.includes(room) || outage.repaired.includes(room)) return;
    const repaired = [...outage.repaired, room];
    if (repaired.length === outage.stations.length) {
      this.timers.clear();
      s.sabotage = null;
      this.runTaskClock(this.tasksLeft);
    } else {
      s.sabotage = { ...outage, repaired };
    }
    this.ctx.onChange();
  }

  private task(id: string, answer?: Record<string, unknown>) {
    const r = this.room.get(id);
    const done = this.done.get(id)!;
    if (r === null || r === undefined || done.has(r)) return;
    const previous = this.taps.get(id) ?? 0;
    let taps = previous + 1; // Ältere Handys schicken weiterhin einzelne Tipps.
    if (answer) {
      const tapsPerStep = MURDER.TASK_TAPS / FERIEN_STEPS;
      const step = Math.floor(previous / tapsPerStep);
      if (answer.phaseNo !== this.state.phaseNo || answer.room !== r || answer.step !== step || !ferienStepCorrect(r, step, answer.choice)) return;
      taps = (step + 1) * tapsPerStep;
    }
    if (taps < MURDER.TASK_TAPS) {
      this.taps.set(id, taps);
    } else {
      this.taps.set(id, 0);
      done.add(r);
      // Mörder tun nur so, als ob
      if (!this.murderers.includes(id)) {
        this.state.taskProgress += 1;
        if (this.state.taskProgress >= this.state.taskTarget) {
          return this.end('urlauber', 'Alle Aufgaben erledigt – das Haus ist blitzblank!');
        }
      }
    }
    this.ctx.onChange();
  }

  private killTargetFor(id: string): string | null {
    const s = this.state;
    if (!this.murderers.includes(id) || !s.alive[id] || this.killedThisPhase.has(id)) return null;
    const r = this.room.get(id);
    if (r === null || r === undefined) return null;
    const others = this.ids.filter((o) => o !== id && s.alive[o] && this.room.get(o) === r);
    if (others.length !== 1 || this.murderers.includes(others[0])) return null;
    return others[0];
  }

  private kill(id: string) {
    const victim = this.killTargetFor(id);
    if (!victim) return;
    const s = this.state;
    s.alive[victim] = false;
    this.killedThisPhase.add(id);
    this.bodies.push({ victim, room: this.room.get(id)!, found: false, announced: false });
    s.screamSeq += 1;
    if (!this.checkWin()) this.ctx.onChange();
  }

  private meeting(reporter: string | null, reason: NonNullable<MurderState['meetingReason']>) {
    const s = this.state;
    this.timers.clear();
    s.sub = 'meeting';
    s.sabotage = null;
    s.meetingReason = reason;
    s.reporter = reporter;
    s.deaths = [];
    for (const b of this.bodies) {
      b.found = true;
      if (!b.announced) {
        b.announced = true;
        s.deaths.push(b.victim);
      }
    }
    this.deadline = phaseTimer(this.timers, MURDER.MEETING_MS, () => this.startVote());
    this.ctx.onChange();
  }

  private startVote() {
    const s = this.state;
    s.sub = 'vote';
    s.voted = [];
    this.votes.clear();
    if (!this.ids.some((id) => s.alive[id] && this.ctx.isConnected(id))) return this.tallyVotes();
    this.deadline = phaseTimer(this.timers, MURDER.VOTE_MS, () => this.tallyVotes());
    this.ctx.onChange();
  }

  private tallyVotes() {
    const s = this.state;
    const tally: Record<string, number> = {};
    for (const t of this.votes.values()) tally[t] = (tally[t] ?? 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter((k) => tally[k] === max);
    s.voteTally = tally;
    s.ejected = max > 0 && top.length === 1 && top[0] !== 'skip' ? top[0] : null;
    s.ejectedWasMurderer = s.ejected ? this.murderers.includes(s.ejected) : null;
    if (s.ejected) s.alive[s.ejected] = false;
    s.sub = 'ejected';
    this.setDeadline(MURDER.EJECT_MS);
    this.ctx.onChange();
    this.timers.later(MURDER.EJECT_MS, () => {
      if (!this.checkWin()) this.startTasks();
    });
  }

  private checkWin(): boolean {
    const s = this.state;
    const aliveM = this.murderers.filter((m) => s.alive[m]).length;
    const aliveU = this.ids.filter((id) => s.alive[id] && !this.murderers.includes(id)).length;
    if (aliveM === 0) {
      this.end('urlauber', this.murderers.length > 1 ? 'Alle Mörder wurden enttarnt!' : 'Der Mörder wurde enttarnt!');
      return true;
    }
    if (aliveM >= aliveU) {
      this.end('murderer', 'Zu wenige Urlauber übrig – der Mörder hat gewonnen!');
      return true;
    }
    return false;
  }

  private end(winner: 'murderer' | 'urlauber', reason: string) {
    const s = this.state;
    this.timers.clear();
    s.sub = 'over';
    s.sabotage = null;
    s.meetingReason = null;
    s.winner = winner;
    s.winReason = reason;
    s.murderers = [...this.murderers];
    this.setDeadline(0);
    this.ctx.onChange();
    const urlauber = this.ids.filter((id) => !this.murderers.includes(id));
    const [win, lose] = winner === 'murderer' ? [this.murderers, urlauber] : [urlauber, this.murderers];
    this.timers.later(6000, () =>
      this.ctx.finish({
        groups: [win, lose],
        details: Object.fromEntries(
          this.ids.map((id) => [id, `${this.murderers.includes(id) ? 'Mörder' : 'Urlauber'}${s.alive[id] ? '' : ' · tot'}`]),
        ),
        subtitle: reason,
        coins: [10, 3],
      }),
    );
  }

  private setDeadline(ms: number) {
    this.deadline = Date.now() + ms;
  }
}
