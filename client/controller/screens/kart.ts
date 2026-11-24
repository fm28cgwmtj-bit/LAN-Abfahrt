import { HOLD_TIMEOUT_MS, type KartItem, type KartState } from '../../../shared/types';
import { KART, KART_TRACKS, type KartInput, wrapAngle } from '../../../shared/kart';
import { itemIcon } from '../../art/kartsprites';
import { kartAssets, Mode7Renderer } from '../../kart3d/render';
import { KartWorld } from '../../kart3d/world';
import { localPoint } from '../stick';
import { type Screen, LS, app, colorOfId, el, message, q, secondsLeft, send, socket, store, toast } from '../core';
import { enableMotion, motionSupport, onMotion } from '../motion';
import { steerFromRoll, tiltLabel, tiltRoll } from '../tilt';
import { haptic } from '../haptic';

/**
 * Kart-Rennen am Handy (quer halten):
 *   links  – schwebender Stick (Daumen irgendwo aufsetzen, nach links/rechts schieben) oder Kipp-Lenkung
 *   rechts – GAS einmal antippen, dann ist der Daumen frei für DRIFT oder ITEM. BREMSE löst das Gas.
 * Ansicht „Handy“: das Handy rendert seine eigene Verfolger-Ansicht (Mode 7) hinter den Knöpfen.
 * Ansicht „TV“: der TV zeigt den Splitscreen, das Handy nur Platz/Runde/Item.
 * Bis 4 Spieler wählt jeder selbst (Knopf oben in der Mitte, gespeichert für die nächsten Rennen) – das Umschalten
 * baut den Screen nicht neu, damit gehaltene Finger (GAS, Stick) nicht verloren gehen. Ab 5 Spielern immer „Handy“.
 */

const OFFROAD = { beach: 'Sand bremst!', harbor: 'Pflaster bremst!', pool: 'Rasen bremst!' };
const ITEM_LABEL: Record<KartItem, string> = { coconut: 'Kokosnuss', banana: 'Banane', ice: 'Turbo-Eis', gull: 'Möwe' };
const LS_TILT = 'lanabfahrt.kartTilt';

// Beim Wechsel Stick ↔ Kippen wird der Screen ersetzt. Nur dieser bewusste Umbau
// übernimmt den lokalen Gaswunsch; neue Spiele und neue Verbindungen starten neutral.
let steeringHandoff: { seq: number | undefined; on: boolean; gasSeq: number } | null = null;
let gasCommandNumber = 0;

/** Kipp-Lenkung bleibt über Bildschirmwechsel hinweg aktiv (auch für Auto-Fußball) */
export const tilt = { on: false, center: 0, roll: 0, smooth: 0, lastSample: 0, unsub: null as (() => void) | null };

/** Rückmeldung (Android: Vibration, iPhone: Klick + Rand-Blitz) – auch von Auto-Fußball genutzt */
export const vibrate = (pattern: number | number[]) => haptic(pattern);

function screenAngle(): number {
  const a = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  return ((Number(a) % 360) + 360) % 360;
}

export async function startTilt(): Promise<boolean> {
  if (!(await enableMotion())) {
    toast('Bewegungssensor nicht erlaubt – Stick-Lenkung');
    return false;
  }
  tilt.unsub?.();
  let first = true;
  tilt.unsub = onMotion((s) => {
    tilt.roll = tiltRoll(s.beta, s.gamma, screenAngle());
    tilt.lastSample = performance.now();
    if (first) {
      first = false;
      tilt.center = tilt.roll;
    }
  });
  const started = performance.now();
  await new Promise((r) => setTimeout(r, 900));
  if (tilt.lastSample < started) {
    tilt.unsub?.();
    tilt.unsub = null;
    toast('Kein Bewegungssensor gefunden');
    return false;
  }
  tilt.on = true;
  localStorage.setItem(LS_TILT, '1');
  return true;
}

export function stopTilt() {
  tilt.unsub?.();
  tilt.unsub = null;
  tilt.on = false;
  localStorage.removeItem(LS_TILT);
}

export function pickKart(s: KartState): Screen {
  const car = s.karts[store.playerId!];
  if (!car) return ['spectate', message('Du schaust zu')];
  // Vollbild/Quer-Sperre bleibt nach dem Rennen bestehen (orientation.ts) – kein Verlassen mehr pro Rennen
  if (s.sub === 'over') return ['kart-over', message('Rennen vorbei!', 'Schau auf den Fernseher!')];
  if (car.finished) {
    return [`kart-fin-${car.place}`, message(`Im Ziel – Platz ${car.place}!`, 'Ehrenrunde fährt von allein. Schau auf den Fernseher!')];
  }
  const mode = tilt.on ? 'tilt' : 'touch';
  // Die Ansicht (TV/Handy) gehört absichtlich nicht in den Key – sie wird im laufenden Screen umgeschaltet.
  // Im TV-Splitscreen ist hochkant erlaubt (Handy zeigt nur Platz/Knöpfe), mit eigener Ansicht muss es quer sein.
  return [`kart3-${mode}`, () => buildDrive(mode, () => window.dispatchEvent(new Event('kart-rerender'))), car.phoneView ? undefined : 'any'];
}

// ------------------------------------------------------------------ Fahr-Screen

function buildDrive(mode: 'tilt' | 'touch', rerender: () => void) {
  const st0 = store.state?.mini?.kind === 'kart' ? store.state.mini.state : null;
  if (!st0) return null;
  const miniSeq = store.state?.miniSeq;
  const practice = store.state?.phase === 'intro' && store.state.intro?.warm;
  const carry = steeringHandoff?.seq === miniSeq ? steeringHandoff : null;
  steeringHandoff = null;
  // Die Strecke wird pro Index zwischengespeichert. Bereits vor der ersten Eingabe
  // malen, damit ein späterer Wechsel zur Handyansicht keinen Heartbeat blockiert.
  kartAssets(st0.track);
  const world = new KartWorld(st0.track, store.playerId!);
  world.onSnapshot(st0);
  const support = motionSupport();
  const canTilt = support === 'ok' || support === 'needs-permission';
  const root = el(`
    <div class="k3 k3-${mode}">
      <div class="k3-hud">
        <div class="k3-place">–</div>
        <div class="k3-lap"></div>
        <p class="k3-tv">Dein Kart läuft auf dem TV</p>
        <div class="k3-msg"></div>
      </div>
      <div class="k3-center"></div>
      <button class="k3-viewsw" aria-label="Ansicht wechseln"><span class="k3-seg k3-seg-tv">📺 TV</span><span class="k3-seg k3-seg-phone">📱 Handy</span></button>
      <div class="k3-viewnote">📱 Ab 5 Spielern fährt jeder am Handy</div>
      <div class="k3-top">
        ${canTilt ? `<button class="k3-small k3-tilt">${mode === 'tilt' ? 'STICK' : 'KIPPEN'}</button>` : '<span></span>'}
      </div>
      <div class="k3-left">
        ${
          mode === 'tilt'
            ? '<div class="k3-wheel"><div class="k3-wheel-in"></div><b class="k3-tiltdeg">0°</b></div><div class="k3-leftlabel">Handy kippen = lenken<br/>Tippen = Mitte setzen</div>'
            : '<div class="k3-stick"><div class="k3-base"></div><div class="k3-knob"></div></div><div class="k3-leftlabel">◀ Daumen schieben ▶</div>'
        }
      </div>
      <div class="k3-right">
        <button type="button" class="k3-btn k3-item" aria-label="Item einsetzen" disabled><canvas width="16" height="16"></canvas><small>ITEM</small></button>
        <button type="button" class="k3-btn k3-drift" aria-label="Drift halten">DRIFT<small>halten + lenken</small></button>
        <button type="button" class="k3-btn k3-brake" aria-label="Bremsen, im Stand rückwärts fahren">BREMSE<small>auch rückwärts</small></button>
        <button type="button" class="k3-btn k3-gas" aria-label="Dauergas" aria-pressed="false"><span>GAS</span><small>antippen</small></button>
      </div>
      ${practice ? '<p class="k3-lesson" role="status"></p>' : ''}
    </div>
  `);
  app.append(root);
  const rootEl = q(root, '.k3');
  rootEl.addEventListener('contextmenu', (e) => e.preventDefault());
  rootEl.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  rootEl.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // ---- Eingaben
  const inp: KartInput = { steer: 0, gas: false, autoGas: false, brake: false, drift: false };
  let last = { ...inp, t: performance.now() };
  let lastGasSeq = carry?.gasSeq ?? 0;
  const gasBtn = q<HTMLButtonElement>(root, '.k3-gas');
  const gasLabel = q(root, '.k3-gas span');
  const gasHint = q(root, '.k3-gas small');
  const setGas = (on: boolean) => {
    inp.autoGas = on;
    gasBtn.setAttribute('aria-pressed', String(on));
    gasLabel.textContent = on ? 'GAS ●' : 'GAS';
    gasHint.textContent = on ? 'bis zur Bremse' : 'antippen';
  };
  if (carry?.on) setGas(true);
  const push = (force = false, edge?: { autoGas: boolean; reset?: boolean }) => {
    const now = performance.now();
    if (!socket.connected || !root.isConnected || store.state?.miniSeq !== miniSeq) return;
    const boolChanged = inp.autoGas !== last.autoGas || inp.brake !== last.brake || inp.drift !== last.drift;
    const steerChanged = Math.abs(inp.steer - last.steer) >= 0.03 && now - last.t >= 33;
    if (!force && !boolChanged && !steerChanged && now - last.t < 300) return;
    last = { ...inp, t: now };
    // Ein Keepalive bestätigt nur die Verbindung. Ausschließlich ein neuer Tipp
    // darf Gas nach Verbindungsverlust oder abgelaufenem Server-Wächter einrasten.
    const command = edge && { ...edge, gasSeq: ++gasCommandNumber };
    if (command) lastGasSeq = command.gasSeq;
    send('steer', { miniSeq, x: inp.steer, gas: false, brake: inp.brake, drift: inp.drift, ...command });
  };

  // Linke Hälfte: schwebender Stick bzw. Kipp-Lenkung
  const left = q(root, '.k3-left');
  let releaseStick = () => {};
  if (mode === 'touch') {
    const stick = q(root, '.k3-stick');
    const knob = q(root, '.k3-knob');
    let active: number | null = null;
    let baseX = 0;
    const DEAD = 6;
    const FULL = 58;
    left.addEventListener('pointerdown', (e) => {
      if (active !== null) return;
      e.preventDefault();
      left.setPointerCapture(e.pointerId);
      active = e.pointerId;
      const p = localPoint(left, e);
      baseX = p.x;
      stick.style.left = `${p.x}px`;
      stick.style.top = `${p.y}px`;
      stick.classList.add('on');
      knob.style.transform = '';
    });
    left.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active) return;
      const px = localPoint(left, e).x;
      const d = px - baseX;
      const mag = Math.max(0, Math.abs(d) - DEAD) / (FULL - DEAD);
      inp.steer = Math.round(Math.sign(d) * Math.min(1, mag) * 100) / 100;
      knob.style.transform = `translateX(${Math.max(-FULL, Math.min(FULL, d))}px)`;
      // Stick „wandert“ mit, wenn der Daumen weit über den Anschlag hinausgeht
      if (Math.abs(d) > FULL + 24) baseX = px - Math.sign(d) * (FULL + 24);
      push();
    });
    releaseStick = () => {
      active = null;
      inp.steer = 0;
      stick.classList.remove('on');
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      releaseStick();
      push(true);
    };
    left.addEventListener('pointerup', up);
    left.addEventListener('lostpointercapture', up);
  } else {
    left.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tilt.center = tilt.roll;
      toast('Mitte gesetzt');
    });
  }
  // `.k3` unterdrückt touchstart → Handys feuern kein `click`. `touchend` zählt auf iOS sicher
  // als Nutzergeste (nötig für die Sensor-Erlaubnis in enableMotion); Maus über pointerup.
  const tiltBtn = root.querySelector<HTMLElement>('.k3-tilt');
  tiltBtn?.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const r = tiltBtn.getBoundingClientRect();
    if (t && (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom)) return;
    e.preventDefault();
    void toggleTilt();
  });
  tiltBtn?.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    void toggleTilt();
  });
  async function toggleTilt() {
    if (mode === 'tilt') stopTilt();
    else {
      if (!(await startTilt())) return;
      toast('Handy wie ein Lenkrad drehen!');
    }
    if (!root.isConnected || !socket.connected || store.state?.miniSeq !== miniSeq) return;
    steeringHandoff = { seq: miniSeq, on: !!inp.autoGas, gasSeq: lastGasSeq };
    rerender();
  }

  // Jeder Knopf reagiert nur auf den dort begonnenen Druck. Ein Finger kann über
  // die Nachbartaste rutschen, ohne einen weiteren Befehl auszulösen.
  const brakeBtn = q<HTMLButtonElement>(root, '.k3-brake');
  const driftBtn = q<HTMLButtonElement>(root, '.k3-drift');
  const itemBtn = q<HTMLButtonElement>(root, '.k3-item');
  const held: Record<'brake' | 'drift', Set<number>> = { brake: new Set(), drift: new Set() };
  const latchGas = () => {
    if (inp.brake || inp.autoGas) return;
    setGas(true);
    push(true, { autoGas: true });
    haptic('tap');
  };
  const useItem = () => {
    if (itemBtn.disabled || !socket.connected || store.state?.miniSeq !== miniSeq) return;
    send('item', { miniSeq });
    vibrate(25);
  };
  for (const [button, tap] of [[gasBtn, latchGas], [itemBtn, useItem]] as const) {
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tap();
    });
    // Tastatur bzw. Aktivierung über eine Bedienungshilfe.
    button.addEventListener('click', (e) => { if (e.detail === 0) tap(); });
  }
  for (const [action, button] of [['brake', brakeBtn], ['drift', driftBtn]] as const) {
    const press = (id: number) => {
      if (action === 'drift' && inp.brake) return;
      if (action === 'brake') {
        setGas(false);
        held.drift.clear();
        inp.drift = false;
        const own = world.ownPhys;
        if (own) {
          own.driftDir = 0;
          own.driftCharge = 0;
          own.boostMs = 0;
        }
        driftBtn.classList.remove('down');
      }
      held[action].add(id);
      inp[action] = true;
      button.classList.add('down');
      push(true, action === 'brake' ? { autoGas: false } : undefined);
    };
    const release = (id: number) => {
      if (!held[action].delete(id) || held[action].size > 0) return;
      inp[action] = false;
      button.classList.remove('down');
      push(true);
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      press(e.pointerId);
    });
    button.addEventListener('pointerup', (e) => release(e.pointerId));
    button.addEventListener('lostpointercapture', (e) => release(e.pointerId));
    button.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (!e.repeat) press(-1);
    });
    button.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') release(-1);
    });
    button.addEventListener('blur', () => release(-1));
  }

  const releaseHeld = () => {
    releaseStick();
    held.brake.clear();
    held.drift.clear();
    inp.steer = 0;
    inp.brake = inp.drift = false;
    // Eine unterbrochene Geste darf in der Vorhersage keinen Mini-Turbo auslösen.
    const own = world.ownPhys;
    if (own) {
      own.driftDir = 0;
      own.driftCharge = 0;
    }
    brakeBtn.classList.remove('down');
    driftBtn.classList.remove('down');
  };
  const resetInputs = () => {
    steeringHandoff = null;
    releaseHeld();
    setGas(false);
    push(true, { autoGas: false, reset: true });
  };
  // Beim Lenkmodus-Wechsel lediglich die zuvor gehaltenen Pedale und den Stick lösen.
  push(true, carry ? undefined : { autoGas: false });
  const onHide = () => { if (document.hidden) resetInputs(); };
  rootEl.addEventListener('pointercancel', resetInputs);
  window.addEventListener('input-reset', resetInputs);
  window.addEventListener('blur', resetInputs);
  document.addEventListener('visibilitychange', onHide);
  socket.on('disconnect', resetInputs);
  const cleanup: (() => void)[] = [() => {
    window.removeEventListener('input-reset', resetInputs);
    window.removeEventListener('blur', resetInputs);
    document.removeEventListener('visibilitychange', onHide);
    socket.off('disconnect', resetInputs);
  }];

  // ---- Ansicht am Handy: Mode-7-Renderer + Vorhersage (die Vorhersage läuft immer – auch für Haptik/Drift-Anzeige)
  let renderer: Mode7Renderer | null = null;
  let camA = st0.karts[store.playerId!]?.angle ?? 0;
  let lastFrame = performance.now();
  let frameMs = 0;
  const fit = () => {
    if (!renderer) return;
    const W = rootEl.clientWidth || 320;
    const H = rootEl.clientHeight || 148;
    const base = W >= H ? 320 : 224;
    renderer.resize(base, Math.round((base * H) / W));
  };
  window.addEventListener('resize', fit);
  cleanup.push(() => window.removeEventListener('resize', fit));

  /** Eigene Verfolger-Ansicht ein-/ausschalten – ohne den Screen neu zu bauen (gehaltene Finger bleiben gültig) */
  let phoneOn: boolean | null = null;
  const viewBtn = q<HTMLButtonElement>(root, '.k3-viewsw');
  const setPhoneView = (on: boolean) => {
    if (on === phoneOn) return;
    phoneOn = on;
    rootEl.classList.toggle('k3-phone', on);
    rootEl.classList.toggle('k3-split', !on);
    viewBtn.classList.toggle('on-phone', on);
    if (on && !renderer) {
      renderer = new Mode7Renderer(st0.track, 320, 148);
      renderer.canvas.className = 'k3-view';
      rootEl.prepend(renderer.canvas);
      fit();
      // Kamera direkt hinter das Kart setzen statt von der alten Richtung einzuschwenken
      const mine = world.poses().find((p) => p.id === store.playerId);
      if (mine) camA = mine.angle;
    } else if (!on && renderer) {
      renderer.canvas.remove();
      renderer = null;
    }
  };
  /** Gerade angetippt, Server hat's noch nicht bestätigt */
  let pending: { on: boolean; until: number } | null = null;
  const effectiveView = (st: KartState) => {
    const server = !!st.karts[store.playerId!]?.phoneView;
    if (pending && (server === pending.on || performance.now() > pending.until || !st.splitOk)) pending = null;
    return pending ? pending.on : server;
  };
  setPhoneView(effectiveView(st0));
  // Antippen = Finger auf der Pille aufsetzen UND dort loslassen (ein Daumen, der beim Lenken drüberrutscht, schaltet nicht um).
  // Kein 'click': .k3 unterdrückt touchstart, dann feuern Handys keinen click.
  let swPointer: number | null = null;
  viewBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    swPointer = e.pointerId;
    viewBtn.classList.add('down');
  });
  viewBtn.addEventListener('pointercancel', () => {
    swPointer = null;
    viewBtn.classList.remove('down');
  });
  viewBtn.addEventListener('pointerup', (e) => {
    if (e.pointerId !== swPointer) return;
    swPointer = null;
    viewBtn.classList.remove('down');
    const r = viewBtn.getBoundingClientRect();
    if (e.clientX < r.left - 8 || e.clientX > r.right + 8 || e.clientY < r.top - 8 || e.clientY > r.bottom + 8) return;
    const st = store.state?.mini?.kind === 'kart' ? store.state.mini.state : null;
    if (!st?.splitOk || st.sub === 'over') return;
    const want = !phoneOn;
    localStorage.setItem(LS.kartView, want ? 'phone' : 'tv');
    socket.emit('kart:view', want ? 'phone' : 'tv');
    pending = { on: want, until: performance.now() + 2500 };
    setPhoneView(want);
    // Kein Toast: der würde mitten im Rennen über BREMSE/GAS liegen – die Pille zeigt den Zustand
    vibrate(12);
  });
  // Diagnose (Playwright): Renderzeit pro Frame und Korrekturen der Vorhersage
  (window as unknown as { __kartDebug?: () => unknown }).__kartDebug = () => ({ frameMs, corrections: [...world.corrections], diag: { ...world.diag } });
  const lookOf = (id: string) => store.state?.players.find((p) => p.id === id)?.look;
  // Kart-Farbe = Spielerfarbe des Abends (wie am TV, `KartScene`)
  const colorOf = (id: string) => colorOfId(id).hex;

  let lastSnapT = 0;
  let wasCharged = false;
  let wasDrift = 0;
  let seenEvent = st0.events[st0.events.length - 1]?.seq ?? 0;
  let centerUntil = 0;
  const center = q(root, '.k3-center');
  const flash = (text: string, cls = '', ms = 900) => {
    center.textContent = text;
    center.className = `k3-center ${cls}`;
    centerUntil = performance.now() + ms;
  };

  const frame = () => {
    if (!root.isConnected) {
      for (const fn of cleanup) fn();
      return;
    }
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;
    const st = store.state?.mini?.kind === 'kart' ? store.state.mini.state : null;
    if (!st || store.state?.miniSeq !== miniSeq || !socket.connected || document.hidden) return;
    if (st.t !== lastSnapT) {
      lastSnapT = st.t;
      world.onSnapshot(st);
    }
    // Kipp-Lenkung
    if (mode === 'tilt') {
      const target = steerFromRoll(tilt.roll, tilt.center);
      tilt.smooth += (target - tilt.smooth) * Math.min(1, dt / 40);
      inp.steer = Math.round(tilt.smooth * 100) / 100;
      const wheel = root.querySelector('.k3-wheel-in') as HTMLElement | null;
      if (wheel) wheel.style.transform = `rotate(${inp.steer * 90}deg)`;
      const degEl = root.querySelector('.k3-tiltdeg');
      const lbl = tiltLabel(tilt.roll, tilt.center);
      if (degEl && degEl.textContent !== lbl) degEl.textContent = lbl;
    }
    // Unterbrochene Haltegesten nicht erneut senden. Ob das Dauergas noch gilt,
    // meldet der Server mit der Nummer des letzten Gasbefehls zurück.
    if (now - last.t >= HOLD_TIMEOUT_MS && (inp.brake || inp.drift || inp.steer)) releaseHeld();
    push();
    // Vorhersage + Haptik
    const fired = world.predict(inp, dt);
    const own = world.ownPhys;
    if (own) {
      const charged = own.driftDir !== 0 && own.driftCharge >= KART.DRIFT_CHARGE_S;
      if (own.driftDir && !wasDrift) vibrate(8);
      if (charged && !wasCharged) vibrate([15, 40, 15]);
      wasCharged = charged;
      wasDrift = own.driftDir;
    }
    if (fired) {
      vibrate(30);
      lessonDone = true;
      flash('TURBO!', 'turbo', 600);
    }
    if (!renderer) return;
    const t0 = performance.now();
    const poses = world.poses();
    const mine = poses.find((p) => p.id === store.playerId);
    if (mine) {
      camA += wrapAngle(mine.angle - camA) * (1 - Math.exp(-dt / 160));
      renderer.render(Mode7Renderer.chase(mine, camA), st, poses, { lookOf, colorOf, now });
    }
    frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
  };
  requestAnimationFrame(frame);

  // ---- HUD (wird bei jedem Server-Stand und alle 250 ms aufgerufen)
  const icon = q<HTMLCanvasElement>(root, '.k3-item canvas');
  let shownItem: string | undefined;
  const lesson = root.querySelector<HTMLElement>('.k3-lesson');
  let lessonDone = false;
  let lastSub = '';
  return () => {
    const st = store.state?.mini?.kind === 'kart' ? store.state.mini.state : null;
    const c = st?.karts[store.playerId!];
    if (!st || !c) return;
    // Nur eine Rückmeldung zum jüngsten Befehl darf den lokalen Gaswunsch lösen.
    // So bleibt ein neuer Tipp auch hinter verspäteten Gas-/Brems-Ständen erhalten.
    if (inp.autoGas && c.gasSeq === lastGasSeq && !c.autoGas) setGas(false);
    const n = Object.keys(st.karts).length;
    setPhoneView(effectiveView(st));
    // Umschalter nur, wenn es TV-Splitscreen gibt (≤ 4 Spieler); sonst einmal kurz der Hinweis im Countdown
    rootEl.classList.toggle('k3-nosplit', !st.splitOk);
    rootEl.classList.toggle('k3-racing', st.sub !== 'countdown');
    q(root, '.k3-place').innerHTML = `${c.place}.<small>/${n}</small>`;
    q(root, '.k3-lap').textContent = `Runde ${Math.max(1, c.lap)}/${st.laps}`;
    if (shownItem !== (c.item ?? '')) {
      shownItem = c.item ?? '';
      const ctx = icon.getContext('2d')!;
      ctx.clearRect(0, 0, 16, 16);
      ctx.drawImage(itemIcon(c.item).canvas, 0, 0);
      q(root, '.k3-item small').textContent = c.item ? ITEM_LABEL[c.item] : 'ITEM';
      itemBtn.disabled = !c.item;
      itemBtn.classList.toggle('has', !!c.item);
      if (c.item) vibrate(15);
    }
    // Eigene Treffer
    const ev = st.events[st.events.length - 1];
    if (ev && ev.seq !== seenEvent) {
      seenEvent = ev.seq;
      if (ev.who === store.playerId && (ev.kind === 'hit' || ev.kind === 'gull')) {
        flash(ev.kind === 'gull' ? 'KRAH!' : 'AUA!', 'hit');
        vibrate([40, 30, 40]);
      }
    }
    // Mitte: Countdown / LOS / Meldungen
    const now = performance.now();
    if (st.sub === 'countdown') {
      const s = secondsLeft();
      center.textContent = String(Math.max(1, Math.min(KART.COUNTDOWN_MS / 1000, s)));
      center.className = 'k3-center count';
    } else if (lastSub === 'countdown') {
      flash('LOS!', 'go', 800);
    } else if (centerUntil && now > centerUntil) {
      center.textContent = '';
      centerUntil = 0;
    }
    lastSub = st.sub;
    const own = world.ownPhys;
    const drifting = own ? own.driftDir !== 0 : c.drift !== 0;
    const charged = own ? own.driftDir !== 0 && own.driftCharge >= KART.DRIFT_CHARGE_S : c.charged;
    const msg =
      st.sub === 'countdown'
        ? mode === 'tilt'
          ? 'Handy gerade halten – links tippen setzt die Mitte'
          : 'GAS antippen zum Start'
        : c.spin > 0
          ? 'Uiii – du drehst dich!'
          : charged
            ? 'Turbo bereit – DRIFT loslassen!'
            : drifting
              ? 'Drift …'
              : c.offroad
                ? OFFROAD[KART_TRACKS[st.track]?.theme ?? 'beach']
                : st.closing
                  ? `Noch ${Math.ceil(st.endsIn / 1000)}s!`
                  : '';
    if (lesson) {
      const step = lessonDone ? '' : !inp.autoGas ? 'gas' : charged ? 'turbo' : 'drift';
      if (rootEl.dataset.lesson !== step) {
        rootEl.dataset.lesson = step;
        lesson.hidden = !step;
        lesson.textContent = step === 'gas' ? 'GAS antippen · fährt von allein' : step === 'drift' ? 'In der Kurve DRIFT halten' : 'DRIFT loslassen · Mini-Turbo!';
      }
    }
    q(root, '.k3-msg').textContent = msg;
    rootEl.classList.toggle('charged', charged);
    rootEl.classList.toggle('drifting', drifting);
  };
}

/** Die Seite baut den Screen neu, wenn sich der Lenk-Modus ändert (Key wechselt) */
export function onKartRerender(fn: () => void) {
  window.addEventListener('kart-rerender', fn);
}
