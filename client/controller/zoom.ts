// Die Lobby, Textfelder und die Zoomhilfe behalten das normale Browser-Verhalten.
const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
const normalViewport = viewport.content;
const lockedViewport = normalViewport + ', maximum-scale=1, user-scalable=no';
const help = document.querySelector<HTMLDialogElement>('#zoom-help')!;
const visual = window.visualViewport;
const html = document.documentElement;
let playing = false;
let locked = false;
let dismissed = false;
let resetTimer: number | undefined;

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type]), input:is([type=text], [type=search], [type=email], [type=url], [type=tel], [type=number], [type=password])');
}

// Nur die Browser-Standardaktion unterbinden. Pointer- und Touch-Handler für
// Sticks, Zeichnen und gleichzeitiges Drücken mehrerer Knöpfe bekommen ihre Ereignisse weiter.
function blockZoom(e: Event) {
  if (!isTextEntry(e.target) && e.cancelable) e.preventDefault();
}

function blockPinch(e: TouchEvent) {
  if (e.touches.length < 2) return;
  // Ein zweiter Finger darf auch click-basierte Spielknöpfe neben einem
  // gehaltenen Stick bedienen. Der native Pinch wird spätestens beim Bewegen abgefangen.
  if (e.type === 'touchstart' && e.target instanceof Element && e.target.closest('button, [role="button"], canvas')) return;
  blockZoom(e);
}

function setLocked(on: boolean) {
  if (locked === on) return;
  locked = on;
  html.classList.toggle('game-zoom-locked', on);
  const opts = { capture: true, passive: false };
  for (const name of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
    if (on) document.addEventListener(name, blockZoom, opts);
    else document.removeEventListener(name, blockZoom, true);
  }
  for (const name of ['touchstart', 'touchmove'] as const) {
    if (on) document.addEventListener(name, blockPinch, opts);
    else document.removeEventListener(name, blockPinch, true);
  }
}

function update() {
  const active = playing && !isTextEntry(document.activeElement);
  const magnified = !!visual && visual.scale > 1.01;
  if (!playing || !magnified) dismissed = false;
  const showHelp = active && magnified && !dismissed;
  // Wer bewusst vergrößert weiterspielt, kann später wieder herauszoomen.
  // Die normale Spielsperre greift, sobald das Bild seine Ausgangsgröße erreicht.
  setLocked(active && !magnified);

  // Bei offener Hilfe sind Meta-Vorgabe und Gesten frei: der manuelle Pinch
  // funktioniert auch auf Safari-Versionen, die den Reset per Meta-Tag ignorieren.
  if (!showHelp && resetTimer !== undefined) {
    clearTimeout(resetTimer);
    resetTimer = undefined;
  }
  const content = resetTimer !== undefined ? lockedViewport + ', minimum-scale=1' : locked ? lockedViewport : normalViewport;
  if (viewport.content !== content) viewport.content = content;

  if (showHelp && visual) {
    // Ein normales position:fixed orientiert sich am Layout-Viewport. Die Hilfe
    // muss auch dann im sichtbaren Ausschnitt bleiben, wenn man zur Ecke gezoomt hat.
    help.style.left = visual.offsetLeft + 'px';
    help.style.top = visual.offsetTop + 'px';
    help.style.width = visual.width * visual.scale + 'px';
    help.style.height = visual.height * visual.scale + 'px';
    help.style.transform = `scale(${1 / visual.scale})`;
    if (!help.open) {
      window.dispatchEvent(new Event('input-reset'));
      help.showModal();
    }
  } else if (help.open) help.close();
}

export function syncGameZoom(active: boolean) {
  const next = active && (navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches);
  if (playing === next) return;
  playing = next;
  html.classList.toggle('game-zoom-play', next);
  update();
}

help.querySelector('.zoom-reset')!.addEventListener('click', () => {
  clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    resetTimer = undefined;
    update();
  }, 300);
  update();
});

function continuePlaying() {
  dismissed = true;
  update();
}
help.querySelector('.zoom-continue')!.addEventListener('click', continuePlaying);
help.addEventListener('cancel', (e) => {
  e.preventDefault();
  continuePlaying();
});
visual?.addEventListener('resize', update);
visual?.addEventListener('scroll', update);
document.addEventListener('focusin', update);
document.addEventListener('focusout', () => requestAnimationFrame(update));
