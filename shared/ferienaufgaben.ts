// Die drei Handgriffe jeder Aufgabe passen zum Raum in ROOMS (shared/games.ts).
// Die Reihenfolge der Antworten bleibt beim Wiederverbinden gleich.
const AUFGABEN = [
  [
    ['Was gehört ins Spülbecken?', ['Kissen', 'Teller', 'Buch'], 1],
    ['Womit schrubbst du den Teller?', ['Schwamm', 'Kamm', 'Kescher'], 0],
    ['Wohin mit dem nassen Teller?', ['Sofa', 'Wäschekorb', 'Abtropfgestell'], 2],
  ],
  [
    ['Was gehört aufs Sofa?', ['Kissen', 'Pfanne', 'Gießkanne'], 0],
    ['Wohin mit der Fernbedienung?', ['Kühlfach', 'Sofatisch', 'Blumentopf'], 1],
    ['Was faltest du zum Schluss?', ['Teetasse', 'Stehlampe', 'Wolldecke'], 2],
  ],
  [
    ['Was fehlt am Rollenhalter?', ['Seil', 'Papierrolle', 'Badetuch'], 1],
    ['Womit putzt du die Schüssel?', ['Klobürste', 'Handfeger', 'Wischmopp'], 0],
    ['Was drückst du zum Schluss?', ['Türklinke', 'Lichtschalter', 'Spülknopf'], 2],
  ],
  [
    ['Was kommt auf die Matratze?', ['Vorhang', 'Handtuch', 'Spannbettlaken'], 2],
    ['Was kommt in den Kissenbezug?', ['Kissen', 'Bettdecke', 'Pyjama'], 0],
    ['Was breitest du über dem Bett aus?', ['Teppich', 'Bettdecke', 'Badematte'], 1],
  ],
  [
    ['Womit fischst du das Laub?', ['Schneebesen', 'Kescher', 'Gabel'], 1],
    ['Was holst du aus dem Wasser?', ['Poolleiter', 'Abfluss', 'Blätter'], 2],
    ['Wohin kommt das Laub?', ['Biotonne', 'Bücherschrank', 'Kühlschrank'], 0],
  ],
  [
    ['Was reinigst du am kalten Grill?', ['Grillrost', 'Fahrrad', 'Zeltplane'], 0],
    ['Womit schrubbst du den Rost?', ['Pinsel', 'Feder', 'Grillbürste'], 2],
    ['Was schützt den sauberen Grill?', ['Sonnenhut', 'Abdeckhaube', 'Picknickkorb'], 1],
  ],
] as const;

export const FERIEN_STEPS = AUFGABEN[0].length;

export function ferienAufgabe(room: number, step: number) {
  const [frage, optionen] = AUFGABEN[room][step];
  return { frage, optionen };
}

export function ferienStepCorrect(room: number, step: number, choice: unknown): boolean {
  return Number.isInteger(room) && Number.isInteger(step) && typeof choice === 'number'
    && AUFGABEN[room]?.[step]?.[2] === choice;
}
