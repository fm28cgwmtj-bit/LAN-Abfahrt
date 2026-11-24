import { GEHEIMCODE, type CodeFarbe, type GeheimcodeState } from '../shared/geheimcode';
import type { Bot } from './botclient';
import { CODE_WORTGRUPPEN } from './geheimcodeWords';

const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];
const normalize = (s: string) => s.trim().toLocaleLowerCase('de').normalize('NFC');

/** Nur der aktuelle Hinweisgeber kennt die Farben. Selten riskieren, der Gegenseite zu helfen. */
function chooseClue(st: GeheimcodeState, key: CodeFarbe[]) {
  const boardWords = new Set(st.cards.map((c) => normalize(c.word)));
  let bestScore = -Infinity;
  let best: { word: string; count: number } | null = null;
  for (const [word, members] of Object.entries(CODE_WORTGRUPPEN)) {
    if (boardWords.has(normalize(word))) continue;
    let own = 0;
    let foreign = 0;
    let neutral = 0;
    let traps = 0;
    st.cards.forEach((card, i) => {
      if (card.color || !members.includes(card.word)) return;
      if (key[i] === st.team) own++;
      else if (key[i] === 'falle') traps++;
      else if (key[i] === 'neutral') neutral++;
      else foreign++;
    });
    if (!own) continue;
    const score = own - neutral * 10 - foreign * 20 - traps * 100 + Math.random() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = { word, count: Math.min(own, GEHEIMCODE.MAX_COUNT) };
    }
  }
  return best;
}

/** Ein Ratender sieht nur die offenen Wörter sowie aufgedeckte Farben und die Vorschläge seines Teams. */
function candidates(st: GeheimcodeState) {
  if (!st.clue) return [];
  const clue = normalize(st.clue.word);
  const matches = new Set<string>();
  for (const [group, members] of Object.entries(CODE_WORTGRUPPEN)) {
    if (normalize(group) === clue || members.some((word) => normalize(word) === clue)) {
      for (const word of members) matches.add(word);
    }
  }
  return st.cards.flatMap((card, i) => !card.color && matches.has(card.word) ? [i] : []);
}

export function geheimcodeBot(bot: Bot, st: GeheimcodeState) {
  if (st.sub === 'over' || !st.teams[st.team].includes(bot.id)) return;
  const leader = st.leaders[st.team] === bot.id;
  if ((st.sub === 'clue') !== leader) return;
  const seq = bot.state?.miniSeq;
  bot.once('geheimcode', async () => {
    // Mit fremden Hinweisen bekommt das Team Zeit für eigene Vorschläge.
    const unknownClue = st.sub === 'guess' && !candidates(st).length;
    const wait = unknownClue && st.captain === bot.id ? 5200 : 650 + Math.random() * 700;
    await new Promise((resolve) => setTimeout(resolve, wait));
    const game = bot.state;
    if (!bot.socket.connected || game?.phase !== 'mini' || game.miniSeq !== seq || game.mini?.kind !== 'geheimcode') return;
    const live = game.mini.state;
    const p = bot.priv?.kind === 'geheimcode' ? bot.priv.state : null;
    if (!p || p.team !== live.team || live.turn !== st.turn || live.sub !== st.sub) return;
    const turn = live.turn;
    if (live.sub === 'clue' && p.role === 'leader' && live.leaders[live.team] === bot.id && p.key) {
      const clue = chooseClue(live, p.key);
      if (clue) bot.send('clue', { turn, ...clue });
      return;
    }
    if (live.sub !== 'guess' || p.role !== 'guesser') return;
    const options = candidates(live);
    const captain = live.captain === bot.id;
    // Die angekündigte Anzahl ist erreicht. Weitere Wörter derselben Gruppe wären bloß geraten.
    if (live.guessesLeft === 1) {
      if (captain) bot.send('pass', { turn });
      return;
    }
    const votes = new Map<number, number>();
    for (const index of Object.values(live.proposals)) {
      if (live.cards[index]?.color === null && (options.includes(index) || unknownClue)) {
        votes.set(index, (votes.get(index) ?? 0) + 1);
      }
    }
    // Einen freien Hinweis eines Menschen kennt der Bot oft nicht. Dann hört er auf sein Team.
    if (captain && votes.size) {
      const [index] = [...votes].sort((a, b) => b[1] - a[1])[0];
      return bot.send('confirm', { turn, index });
    }
    if (options.length && live.proposals[bot.id] === undefined) {
      return bot.send('vote', { turn, index: pick(options) });
    }
    if (captain && !options.length) bot.send('pass', { turn });
  });
}
