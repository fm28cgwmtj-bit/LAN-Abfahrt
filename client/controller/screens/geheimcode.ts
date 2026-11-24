import { CODE_LABEL, CODE_SYMBOL, CODE_TEAM, GEHEIMCODE, type CodeFarbe, type GeheimcodeState } from '../../../shared/geheimcode';
import type { Team } from '../../../shared/types';
import { app, el, nameOf, q, send, store, timerText, type Screen } from '../core';
import './geheimcode.css';

const current = () => store.state?.mini?.kind === 'geheimcode' ? store.state.mini.state : null;
const mine = () => store.priv?.kind === 'geheimcode' ? store.priv.state : null;
const teamName = (t: Team) => CODE_SYMBOL[t] + ' ' + CODE_TEAM[t];
const privateKey = (s: GeheimcodeState) => {
  const p = mine();
  return p?.role === 'leader' && s.leaders[p.team] === store.playerId && p.key?.length === s.cards.length ? p.key : null;
};

export function pickGeheimcode(s: GeheimcodeState): Screen {
  const p = mine();
  // Beim Wechsel der Rolle, des Spiels oder des Teams den Lageplan wieder verdecken.
  return [`gc-${store.state?.miniSeq}-${s.sub}-${s.team}-${p?.role}-${p?.team}`, () => build(s)];
}

function build(initial: GeheimcodeState) {
  const root = el(`
    <section class="gc-game" aria-label="Geheimcode am Pool">
      <div class="gc-head"><b class="gc-role"></b><span class="gc-timer"></span></div>
      <div class="gc-score"><span data-team="A"></span><span data-team="B"></span></div>
      <div class="gc-turn" aria-live="polite"><b class="gc-heading"></b><span class="gc-instruction"></span></div>
      <form class="gc-form" hidden>
        <label>Hinweiswort<input class="gc-word" type="text" required autocomplete="off" autocapitalize="sentences"></label>
        <label>Anzahl<select class="gc-count"></select></label>
        <button type="submit" class="gc-submit">Hinweis geben</button>
      </form>
      <p class="gc-error" role="alert" hidden></p>
      <button type="button" class="gc-key secondary" aria-pressed="false" hidden>Lageplan aufdecken</button>
      <p class="gc-legend" hidden></p>
      <div class="gc-board" role="group" aria-label="Wortkarten"></div>
      <div class="gc-actions" hidden>
        <button class="gc-confirm" type="button"></button>
        <button class="gc-pass small secondary" type="button">Zug beenden</button>
      </div>
      <p class="gc-message"></p>
    </section>`);
  app.append(root);
  const form = q<HTMLFormElement>(root, '.gc-form');
  const word = q<HTMLInputElement>(root, '.gc-word');
  const count = q<HTMLSelectElement>(root, '.gc-count');
  const keyButton = q<HTMLButtonElement>(root, '.gc-key');
  const legend = q(root, '.gc-legend');
  const board = q(root, '.gc-board');
  const confirm = q<HTMLButtonElement>(root, '.gc-confirm');
  const pass = q<HTMLButtonElement>(root, '.gc-pass');
  const actions = q(root, '.gc-actions');
  const role = q(root, '.gc-role');
  const heading = q(root, '.gc-heading');
  const instruction = q(root, '.gc-instruction');
  const timer = q(root, '.gc-timer');
  const error = q(root, '.gc-error');
  const news = q(root, '.gc-message');
  const remaining = { A: q(root, '[data-team=A]'), B: q(root, '[data-team=B]') };
  let keyOpen = false;
  let lastState: GeheimcodeState | null = null;
  let lastPrivate = mine();
  const player = store.playerId!;
  word.maxLength = GEHEIMCODE.MAX_CLUE;
  for (let i = 1; i <= GEHEIMCODE.MAX_COUNT; i++) count.add(new Option(String(i), String(i)));
  legend.textContent = (['A', 'B', 'neutral', 'falle'] as CodeFarbe[]).map(c => CODE_SYMBOL[c] + ' ' + CODE_LABEL[c]).join(' · ');

  const tiles = initial.cards.map((card, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gc-card';
    button.dataset.index = String(index);
    const mark = document.createElement('span');
    mark.className = 'gc-mark';
    const label = document.createElement('strong');
    label.textContent = card.word;
    const votes = document.createElement('small');
    votes.className = 'gc-votes';
    button.append(mark, label, votes);
    button.addEventListener('click', () => {
      const s = current();
      if (s && !button.disabled) send('vote', { turn: s.turn, index });
    });
    board.append(button);
    return { button, mark, votes };
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const s = current();
    if (s && !form.hidden) send('clue', { turn: s.turn, word: word.value.trim(), count: Number(count.value) });
  });
  keyButton.addEventListener('click', () => {
    keyOpen = !keyOpen;
    lastState = null;
    update();
  });
  confirm.addEventListener('click', () => {
    const s = current();
    const index = s?.proposals[player];
    if (s && index !== undefined && !actions.hidden && !confirm.disabled) send('confirm', { turn: s.turn, index });
  });
  pass.addEventListener('click', () => {
    const s = current();
    if (s && !actions.hidden) send('pass', { turn: s.turn });
  });

  function update() {
    const s = current();
    if (!s) return;
    timer.textContent = s.sub === 'over' ? '' : timerText();
    const p = mine();
    if (s === lastState && p === lastPrivate) return;
    lastState = s;
    lastPrivate = p;
    const team = p?.team;
    const leading = !!team && p.role === 'leader' && s.leaders[team] === player;
    const guessing = !!team && p.role === 'guesser' && s.team === team && s.sub === 'guess';
    const captain = s.captain === player && guessing;
    const ownVote = s.proposals[player];
    const selected = ownVote === undefined ? undefined : s.cards[ownVote];
    role.textContent = team ? teamName(team) + ' · ' + (leading ? 'Hinweisgeber' : p.role === 'guesser' ? (captain ? 'Kapitän' : 'Rateteam') : 'Zuschauer') : 'Du schaust zu';
    for (const t of ['A', 'B'] as const) remaining[t].textContent = teamName(t) + ' · ' + s.remaining[t] + ' offen';
    if (s.sub === 'over') {
      heading.textContent = s.winner ? 'Team ' + teamName(s.winner) + ' gewinnt!' : 'Spiel beendet';
      instruction.textContent = '';
    } else if (s.sub === 'clue') {
      heading.textContent = 'Team ' + teamName(s.team) + ' gibt den Hinweis';
      instruction.textContent = leading && team === s.team ? 'Verbinde deine Wörter mit einem einzigen Hinweiswort.' : nameOf(s.leaders[s.team]) + ' überlegt.';
    } else {
      heading.textContent = s.clue ? s.clue.word + ' · ' + s.clue.count : 'Team ' + teamName(s.team) + ' rät';
      const left = s.guessesLeft === 1 ? '1 Tipp übrig.' : s.guessesLeft + ' Tipps übrig.';
      let action = 'Team ' + teamName(s.team) + ' berät sich.';
      if (captain) action = selected ? '„' + selected.word + '“ ist gewählt. Bestätige unten oder ändere deine Wahl.' : 'Tippe auf ein Wort und bestätige es unten.';
      else if (guessing) action = selected ? 'Dein Vorschlag ist „' + selected.word + '“. ' + nameOf(s.captain) + ' entscheidet.' : 'Tippe auf deinen Vorschlag. Du kannst ihn ändern.';
      instruction.textContent = left + ' ' + action;
    }
    news.textContent = s.message;
    error.textContent = p?.error ?? '';
    error.hidden = !p?.error;
    form.hidden = !(s.sub === 'clue' && leading && team === s.team);
    const key = privateKey(s);
    keyButton.hidden = !key || s.sub === 'over';
    if (keyButton.hidden) keyOpen = false;
    keyButton.setAttribute('aria-pressed', String(keyOpen));
    keyButton.textContent = keyOpen ? 'Lageplan verdecken' : 'Lageplan aufdecken';
    legend.hidden = !keyOpen;
    const votes = new Map<number, number>();
    for (const index of Object.values(s.proposals)) votes.set(index, (votes.get(index) ?? 0) + 1);
    s.cards.forEach((card, i) => {
      const { button, mark, votes: counter } = tiles[i];
      const color = card.color ?? (keyOpen ? key?.[i] : null);
      const n = votes.get(i) ?? 0;
      button.dataset.color = color ?? '';
      button.classList.toggle('gc-revealed', card.color !== null);
      button.classList.toggle('gc-picked', i === ownVote);
      button.disabled = !guessing || card.color !== null;
      button.setAttribute('aria-pressed', String(i === ownVote));
      const status = color ? CODE_LABEL[color] + (card.color ? ', aufgedeckt' : ', verdeckt') : 'verdeckt';
      button.setAttribute('aria-label', [card.word, status, n ? n + (n === 1 ? ' Stimme' : ' Stimmen') : ''].filter(Boolean).join(', '));
      mark.textContent = color ? CODE_SYMBOL[color] + (keyOpen && card.color !== null ? ' ✓' : '') : '';
      counter.textContent = n ? '● ' + n : '';
    });
    actions.hidden = !captain;
    confirm.disabled = !selected || selected.color !== null;
    confirm.textContent = !selected ? 'Wort zum Aufdecken wählen' : '„' + selected.word + '“ aufdecken';
  }
  return update;
}

// Beim Weiterreichen nach einem App-Wechsel ist die geheime Übersicht wieder verdeckt.
function coverKey() {
  if (document.hidden) app.querySelector<HTMLButtonElement>('.gc-key[aria-pressed="true"]')?.click();
}
document.addEventListener('visibilitychange', coverKey);
