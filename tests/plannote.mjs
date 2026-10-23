// "In je eigen woorden" bij het schema: wat dE3p eruit haalt.
import { parsePlanNote, applyNote } from '../app/js/plannote.js';

const base = ['run', 'run', 'rest', 'run', 'rest', 'rest', 'long'];
const cases = [
  ['Lange duurloop op zaterdag of zondag, woensdag kan ik niet, max 45 minuten in de week', 'run,run,rest,run,rest,long,long', { longMode: 'either', maxMin: 45 }],
  ['geen intervallen. lange duurloop max 1u30', 'run,run,rest,run,rest,rest,long', { quality: 'tempo', maxLong: 90 }],
  ['maandag en donderdag rust, lange duurloop in het weekend om de week wisselen', 'rest,run,rest,rest,rest,long,long', { longMode: 'alt' }],
  ['Op zondag lang en zaterdag zwemmen', 'run,run,rest,run,rest,cross,long', {}],
  ['ik kan enkel lopen op ma wo vr en zo', 'run,rest,run,rest,run,rest,long', {}],
  ['ik heb wat last van mijn knie', 'run,run,rest,run,rest,rest,long', { build: 'easy', cutEvery: 3 }],
  ['ik wil 3 keer per week lopen', 'rest,run,rest,run,rest,rest,long', {}],
];
let bad = 0;
for (const [t, wk, want] of cases) {
  const r = parsePlanNote(t);
  const got = applyNote(base, r).join(',');
  const miss = Object.entries(want).filter(([k, v]) => r[k] !== v);
  if (got !== wk || miss.length) { bad += 1; console.log(`FOUT: ${t}\n  week ${got} (verwacht ${wk}) ${miss.map(([k, v]) => `${k}=${r[k]} i.p.v. ${v}`).join(' ')}`); }
}
console.log(`${cases.length} zinnen, ${bad} fout`);
