// Je lichaam op de gsm, ook zonder computer: weegschaal en gewicht, bloedsuiker, bloeddruk, taille en zweetverlies.
// Met computer gaat alles via de versleutelde brievenbus naar je computer (bridge.js); zonder computer blijft het
// hier (store 'lichaam', klein genoeg voor localStorage). Dezelfde regels en grenzen als vitals.py / app.py.

import * as store from './store.js';

const KEEP = 1000;
const L = () => store.load().lichaam || {};
const save = (patch) => store.save({ lichaam: { ...L(), ...patch } });
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowMin = () => { const d = new Date(); return `${isoOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const num = (x) => Number(String(x ?? '').trim().replace(',', '.'));
const bySort = (k) => (a, b) => String(a[k]).localeCompare(String(b[k]));
export const BRANDS = { garmin: 'Garmin-weegschaal', withings: 'Withings', apple: 'Apple Gezondheid', manual: 'Zelf invullen' };
export const CTX = { nuchter: 'nuchter', voor: 'voor het eten', na: 'na het eten (2 u)', los: 'willekeurig' };

// ---- invoer nakijken (ook gebruikt als de gsm het naar je computer stuurt) ------------------------
export function parseWeight(kg, fat) {
  const n = (v) => (String(v ?? '').trim() === '' ? null : Math.round(num(v) * 10) / 10);
  const k = n(kg); const f = n(fat);
  if (!(k >= 25 && k <= 300) || (f != null && !(f >= 2 && f <= 70))) throw new Error('Dat gewicht of vetpercentage klopt niet. Kijk het nog eens na.');
  return { kg: k, fat: f };
}
export function parseGlucose(mgdl, ctx) {
  const x = num(mgdl);
  if (!Number.isFinite(x) || String(mgdl ?? '').trim() === '') throw new Error('Vul je bloedsuiker in als getal in mg/dL, bv. 92.');
  const v = Math.round(x >= 1 && x < 35 ? x * 18.016 : x);      // 5,4 is mmol/L: omrekenen naar mg/dL
  if (!(v >= 20 && v <= 600)) throw new Error('Dat lijkt geen bloedsuiker in mg/dL (normaal tussen 70 en 140). Kijk het nog eens na.');
  return { mgdl: v, ctx: ctx in CTX ? ctx : 'los' };
}
export function parseBp(sys, dia, pulse) {
  const s = Math.round(num(sys)); const d = Math.round(num(dia));
  const p = String(pulse ?? '').trim() === '' ? null : Math.round(num(pulse));
  if (!(s >= 70 && s <= 260 && d >= 40 && d <= 160 && s > d) || (p != null && !(p >= 30 && p <= 220))) {
    throw new Error('Die bloeddruk klopt niet (bovendruk is het hoogste getal, bv. 122/78). Kijk het nog eens na.');
  }
  return { sys: s, dia: d, pulse: p };
}
export function parseWaist(cm) {
  const v = Math.round(num(cm) * 10) / 10;
  if (!(v >= 40 && v <= 200)) throw new Error('Vul je taille in centimeter in, bv. 78.');
  return { cm: v };
}
export function parseSweat(before, after, drank, secs) {
  const b = num(before); const a = num(after); const ml = String(drank ?? '').trim() ? num(drank) : 0;
  if (!(b >= 25 && b <= 300 && a >= 25 && a <= 300 && a <= b + 1 && ml >= 0 && ml <= 5000)) {
    throw new Error('Dat klopt niet: je gewicht na de training is meestal lager dan ervoor. Kijk het nog eens na.');
  }
  if (!(Number(secs) >= 900)) throw new Error('Zweetverlies meten heeft pas zin vanaf een training van een kwartier.');
  return { before: Math.round(b * 10) / 10, after: Math.round(a * 10) / 10, drank: Math.round(ml), secs: Math.round(Number(secs)) };
}
// zweet per uur (L) en verlies in % van je gewicht, zoals vitals.add_sweat
export function sweatItem(start, x, at = nowMin()) {
  const h = x.secs / 3600;
  return { start: String(start).slice(0, 19), at, ...x, rate: Math.max(0, Math.round(((x.before - x.after + x.drank / 1000) / h) * 100) / 100),
    pct: Math.round(((x.before - x.after) / x.before) * 1000) / 10 };
}

// ---- zonder computer: hier bewaren ----------------------------------------------------------------
export function setScale(brand) {
  if (brand && !['apple', 'manual'].includes(brand)) throw new Error('Garmin of Withings koppel je in het programma op je computer.');
  save({ brand: brand || '' });
}
export function addWeight(kg, fat) {
  const w = parseWeight(kg, fat); const date = isoOf(new Date());
  save({ weights: [...(L().weights || []).filter((x) => x.date !== date), { date, ...w, at: nowMin() }].slice(-KEEP) });
}
export function setTrack(kind, on) {
  if (!['glucose', 'bp'].includes(kind)) throw new Error('Onbekende meting.');
  save({ track: { ...(L().track || {}), [kind]: Boolean(on) } });
}
const add = (key, item) => save({ [key]: [...(L()[key] || []), item].slice(-KEEP) });
export const addGlucose = (mgdl, ctx) => add('glucose', { at: nowMin(), ...parseGlucose(mgdl, ctx), src: 'zelf ingevuld' });
export const addBp = (s, d, p) => add('bp', { at: nowMin(), ...parseBp(s, d, p), src: 'zelf ingevuld' });
export const addWaist = (cm) => add('waist', { at: nowMin(), ...parseWaist(cm) });
export function addSweat(start, before, after, drank, secs) {
  const it = sweatItem(start, parseSweat(before, after, drank, secs));
  save({ sweat: [...(L().sweat || []).filter((x) => x.start !== it.start), it].slice(-200) });
}

// je weegschaal (zelfde vorm als app.Api.scale): eigen wegingen + die uit Apple Gezondheid
export function scale(appleWeights = []) {
  const brand = L().brand || '';
  const own = (L().weights || []).map((w) => ({ ...w, src: 'zelf ingevuld' }));
  const byDate = new Map(appleWeights.map((w) => [w.date, { ...w, src: 'Apple Gezondheid' }]));
  for (const w of own) byDate.set(w.date, w);                     // wat je zelf invult gaat voor
  const all = [...byDate.values()].sort(bySort('date'));
  const last = all[all.length - 1] || null; const prev = all[all.length - 2] || null;
  return { brand, brandName: BRANDS[brand] || '', last, delta: last && prev ? Math.round((last.kg - prev.kg) * 10) / 10 : null,
    n: all.length, garmin: false, withings: false, list: all };
}
// bloedsuiker, bloeddruk, taille, zweet (zelfde vorm als vitals.status)
export function vitals(appleLast = {}) {
  const l = L();
  const last = (xs) => [...(xs || [])].sort(bySort('at')).pop() || null;
  const g = [last(l.glucose), appleLast.glucose].filter(Boolean).sort(bySort('at')).pop() || null;
  const b = [last(l.bp), appleLast.bp].filter(Boolean).sort(bySort('at')).pop() || null;
  const sw = [...(l.sweat || [])].sort(bySort('start'));
  const recent = sw.slice(-5);
  return { track: { glucose: false, bp: false, ...(l.track || {}) }, garmin: false, apple: Boolean(appleLast.glucose || appleLast.bp), ctx: CTX,
    glucose: { last: g, n: (l.glucose || []).length }, bp: { last: b, n: (l.bp || []).length },
    waist: { last: last(l.waist), n: (l.waist || []).length }, sweat: sw.slice(-30),
    sweatAvg: recent.length ? Math.round((recent.reduce((a, x) => a + x.rate, 0) / recent.length) * 100) / 100 : null };
}
// je eigen metingen in de dagen van Gezondheid (zoals with_scale + with_vitals op de computer)
export function withLocal(rec) {
  if (!rec || rec.error) return rec;
  const l = L();
  const per = (xs, k) => (xs || []).reduce((m, x) => { (m[x[k].slice(0, 10)] ||= []).push(x); return m; }, {});
  const w = per(l.weights, 'date'); const g = per(l.glucose, 'at'); const b = per(l.bp, 'at');
  for (const d of [rec.today || {}, ...(rec.history || [])]) {
    const day = d.date;
    if (w[day]) d.weight = { kg: w[day][0].kg, ...(w[day][0].fat ? { fat: w[day][0].fat } : {}) };
    if (g[day] && !d.glucose) {
      const xs = g[day].sort(bySort('at')); const lst = xs[xs.length - 1];
      d.glucose = { avg: Math.round(xs.reduce((a, x) => a + x.mgdl, 0) / xs.length), last: lst.mgdl, ctx: lst.ctx, n: xs.length, at: lst.at.slice(11, 16) };
    }
    if (b[day] && !d.bp) {
      const xs = [...b[day]].sort(bySort('at')); const lst = xs[xs.length - 1];
      d.bp = { sys: lst.sys, dia: lst.dia, pulse: lst.pulse, n: xs.length, at: lst.at.slice(11, 16), src: 'zelf ingevuld' };
    }
  }
  return rec;
}

// je computer gaat weg: zijn metingen naar deze gsm (dubbels vallen weg; wat hier al stond blijft)
export function importFrom({ days = [], vitals = {}, scale = {} } = {}) {
  const l = L();
  const weights = new Map((l.weights || []).map((w) => [w.date, w]));
  const glucose = new Map((l.glucose || []).map((g) => [g.at, g]));
  const bp = new Map((l.bp || []).map((b) => [b.at, b]));
  for (const d of days) {
    if (d.weight?.kg && !weights.has(d.date)) weights.set(d.date, { date: d.date, kg: d.weight.kg, fat: d.weight.fat || null, at: `${d.date}T08:00` });
    if (d.glucose?.last) { const at = `${d.date}T${d.glucose.at || '08:00'}`; if (!glucose.has(at)) glucose.set(at, { at, mgdl: d.glucose.last, ctx: d.glucose.ctx || 'los', src: 'van je computer' }); }
    if (d.bp?.sys) { const at = `${d.date}T${d.bp.at || '08:00'}`; if (!bp.has(at)) bp.set(at, { at, sys: d.bp.sys, dia: d.bp.dia, pulse: d.bp.pulse ?? null, src: d.bp.src || 'van je computer' }); }
  }
  const w = vitals.waist?.last;
  const waist = [...(l.waist || [])];
  if (w && !waist.some((x) => x.at === w.at)) waist.push({ at: w.at, cm: w.cm });
  const sweat = new Map([...(vitals.sweat || []), ...(l.sweat || [])].map((x) => [x.start, x]));
  save({
    brand: l.brand || (scale.brand ? (scale.brand === 'apple' ? 'apple' : 'manual') : ''),   // Garmin/Withings: voortaan zelf invullen
    track: { ...(vitals.track || {}), ...(l.track || {}) },
    weights: [...weights.values()].sort(bySort('date')).slice(-KEEP),
    glucose: [...glucose.values()].sort(bySort('at')).slice(-KEEP),
    bp: [...bp.values()].sort(bySort('at')).slice(-KEEP),
    waist, sweat: [...sweat.values()].sort(bySort('start')).slice(-200),
  });
}
