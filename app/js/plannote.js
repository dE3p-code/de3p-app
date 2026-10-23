// Je schema in je eigen woorden: "lange duurloop op zaterdag of zondag, woensdag kan ik niet,
// max 45 minuten in de week". Haalt eruit wat in het schemaformulier past; de rest negeren we.
// Werkt zonder internet of AI: gewone patronen, in het Nederlands.

const DAY_WORDS = [
  [/\b(maandag|maandags|ma)\b/, 0], [/\b(dinsdag|dinsdags|di)\b/, 1], [/\b(woensdag|woensdags|wo)\b/, 2],
  [/\b(donderdag|donderdags|do)\b/, 3], [/\b(vrijdag|vrijdags|vr)\b/, 4], [/\b(zaterdag|zaterdags|za)\b/, 5],
  [/\b(zondag|zondags|zo)\b/, 6],
];
const list = (xs, w) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} ${w} ${xs[xs.length - 1]}` : xs[0] || '');
const DAG = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

function daysIn(t) {
  const out = [];
  DAY_WORDS.forEach(([re, d]) => { if (re.test(t)) out.push(d); });
  if (/\bweekend\b/.test(t)) out.push(5, 6);
  if (/\b(in de week|weekdagen|door de week|op werkdagen)\b/.test(t) && !/\b(max|hooguit|niet langer)/.test(t)) out.push(0, 1, 2, 3, 4);
  const range = /\b(ma|di|wo|do|vr|za|zo)\w*\s*(?:t\/m|tot( en met)?|-)\s*(ma|di|wo|do|vr|za|zo)\w*/.exec(t);
  if (range) {
    const ix = (w) => ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].indexOf(w);
    for (let d = ix(range[1]); d <= ix(range[3]); d += 1) out.push(d);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function minutes(t) {
  const m = /(\d+(?:[,.]\d+)?)\s*(?:u|uur|h)(?![a-z])(?:\s*(\d+))?/.exec(t);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60 + (m[2] ? Number(m[2]) : 0));
  if (/anderhalf uur/.test(t)) return 90;
  if (/\bhalf uur\b/.test(t)) return 30;
  if (/\been uur\b|\bén uur\b/.test(t)) return 60;
  const mm = /(\d+)\s*(min|minuten|minuutjes|')/.exec(t);
  return mm ? Number(mm[1]) : null;
}

const nearest = (v, opts) => opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// tekst → { week: { dag: soort }, longMode, maxMin, maxLong, quality, build, cutEvery, runDays, said: [...] }
export function parsePlanNote(text) {
  const r = { week: {}, said: [] };
  const all = String(text || '').toLowerCase();
  if (!all.trim()) return r;
  const parts = all.split(/[.;!\n]+|,\s*(?=[a-z])|\s+maar\s+|\s+en\s+(?=(?:op|de|mijn|ik|lange|rust|fiets|geen|max|hooguit|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b)/);
  let pending = '';                                             // "maandag en donderdag rust": dagen zonder soort gaan mee naar het volgende stuk
  for (const raw of parts) {
    const t = `${pending} ${raw || ''}`.trim();
    pending = '';
    if (!t) continue;
    const days = daysIn(t);
    const isLong = /\blange?\b|\blang(e)? (duur)?loop|duurloop/.test(t) && !/niet lang/.test(t);
    const isRest = /\b(rust|rustdag|vrij|kan (ik )?niet|geen tijd|niet lopen|nooit|werk(en)? laat|niet op)\b/.test(t);
    const isCross = /\b(fiets|fietsen|zwem|zwemmen|fitness|gym|crossfit|spinning|cross)\w*/.test(t);
    const isRun = /\b(lopen|loop|kan ik|wel)\b/.test(t);
    const min = /\b(max|maximaal|maximum|hooguit|niet langer dan|ten hoogste|tot)\b/.test(t) ? minutes(t) : null;

    if (min) {                                                  // tijdsgrens
      if (isLong) { r.maxLong = nearest(min, [60, 90, 120, 150, 180]); r.said.push(`lange duurloop hooguit ${fmtMin(r.maxLong)}`); }
      else { r.maxMin = nearest(min, [30, 45, 60, 75, 90]); r.said.push(`in de week hooguit ${fmtMin(r.maxMin)}`); }
      continue;
    }
    if (days.length) {
      const kind = isCross ? 'cross' : isLong ? 'long' : isRest ? 'rest' : isRun ? 'run' : null;
      if (kind) {
        days.forEach((d) => { r.week[d] = kind; });
        if (kind === 'long' && days.length > 1) {
          r.longMode = /\bof\b/.test(t) ? 'either' : /wissel|om de (andere )?week/.test(t) ? 'alt' : 'mid';
        }
        const names = list(days.map((d) => DAG[d]), kind === 'long' && r.longMode === 'either' ? 'of' : 'en');
        if (kind === 'run' && /\b(enkel|alleen|maar|uitsluitend)\b/.test(t)) r.only = days;   // de andere dagen: rust
        r.said.push({ cross: `${names}: fietsen, zwemmen of iets anders (geen loop)`,
          long: r.longMode === 'alt' ? `lange duurloop om de week op ${days.map((d) => DAG[d]).join(' of ')}` : `lange duurloop op ${names}`,
          rest: `${names}: rust`, run: `${r.only === days ? 'enkel ' : ''}${names}: lopen` }[kind]);
        continue;
      }
      if (t.split(/\s+/).length <= 3) { pending = t; continue; }
    }
    if (/wissel|om de (andere )?week/.test(t) && isLong) { r.longMode = 'alt'; r.said.push('lange duurloop elke week op een andere dag'); continue; }
    if (/geen (snelle|zware) trainingen|alles rustig|enkel rustig|geen tempo|geen interval(len)? (en|of) (geen )?tempo/.test(t)) { r.quality = 'none'; r.said.push('geen snelle trainingen'); continue; }
    if (/geen interval/.test(t)) { r.quality = 'tempo'; r.said.push('geen intervallen'); continue; }
    if (/\b(voorzichtig|rustig opbouwen|langzaam|blessure|geblesseerd|pijn|knie|scheen|achilles)\b/.test(t)) {
      r.build = 'easy'; r.cutEvery = 3; r.said.push('voorzichtig opbouwen, elke 3e week een herstelweek'); continue;
    }
    if (/herstelweek/.test(t) && /\b(3|drie)\b/.test(t)) { r.cutEvery = 3; r.said.push('elke 3e week een herstelweek'); continue; }
    const n = /\b([2-6]|twee|drie|vier|vijf|zes)\s*(keer|x|×|dagen|maal)\b/.exec(t);
    if (n && /\b(lopen|loop|per week|trainen|week)\b/.test(t)) {
      r.runDays = { twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6 }[n[1]] || Number(n[1]);
      r.said.push(`${r.runDays} keer lopen per week`);
    }
  }
  return r;
}

const fmtMin = (m) => (m % 60 ? (m > 60 ? `${Math.floor(m / 60)}u${String(m % 60).padStart(2, '0')}` : `${m} min`) : `${m / 60} uur`);

// je week aanpassen met wat je schreef; bij "4 keer per week" zonder dagen: dagen erbij of eraf
export function applyNote(week, note) {
  const wk = week.slice();
  Object.entries(note.week).forEach(([d, k]) => { wk[d] = k === 'run' && wk[d] === 'long' ? 'long' : k; });   // "lopen" op je lange dag: blijft lang
  if (note.only) wk.forEach((k, d) => { if ((k === 'run' || k === 'long') && !note.only.includes(d)) wk[d] = 'rest'; });
  if (note.only && !wk.includes('long')) wk[[6, 5, ...note.only.slice().reverse()].find((d) => note.only.includes(d))] = 'long';
  if (note.runDays) {
    const isRun = (k) => k === 'run' || k === 'long';
    const fixed = new Set(Object.keys(note.week).map(Number));
    let n = wk.filter(isRun).length;
    for (const d of [1, 3, 6, 5, 2, 0, 4]) { if (n >= note.runDays) break; if (wk[d] === 'rest' && !fixed.has(d)) { wk[d] = 'run'; n += 1; } }
    for (const d of [4, 0, 2, 5, 3, 1, 6]) { if (n <= note.runDays) break; if (wk[d] === 'run' && !fixed.has(d)) { wk[d] = 'rest'; n -= 1; } }
  }
  if (!wk.includes('rest')) {                                   // altijd minstens één rustdag
    const d = [4, 0, 2, 3, 1].find((x) => wk[x] === 'run' && note.week[x] == null);
    if (d != null) wk[d] = 'rest';
  }
  return wk;
}
