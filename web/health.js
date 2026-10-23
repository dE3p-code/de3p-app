// Apple Gezondheid in de echte iPhone-app (koppeling "Apple Watch"): slaap, HRV, rustpols, stappen,
// gewicht, VO2max, intensiteit, bloedsuiker en bloeddruk uit HealthKit, in dezelfde vorm als garmin.day() / recovery() / months().
// Ook wat andere apps in Apple Gezondheid zetten (Garmin Connect, Oura, Whoop, Withings, Huawei Health ...)
// komt zo mee. Alles blijft op de gsm (IndexedDB 'apple').
// Werkt enkel in de app (Capacitor + @capgo/capacitor-health); in de browser is dit uit.

import * as store from './store.js';

const H = () => window.capacitorHealth?.Health;
export const native = () => Boolean(window.Capacitor?.isNativePlatform?.());
export const platform = () => window.Capacitor?.getPlatform?.() || 'web';
export const available = () => native() && platform() === 'ios' && Boolean(H());
export const connected = () => available() && Boolean(store.load().apple);

const READ = ['sleep', 'heartRateVariability', 'restingHeartRate', 'steps', 'distance', 'calories', 'exerciseTime',
  'weight', 'bodyFat', 'respiratoryRate', 'oxygenSaturation', 'vo2Max', 'height', 'bloodGlucose', 'bloodPressure', 'heartRate'];
const KEEP = 730;                 // twee jaar: per dag terugbladeren en 'Alles' per maand
const FRESH = 30 * 60e3;          // vandaag en de laatste dagen opnieuw na een half uur
const MONTHS = 24;                // zelfde als garmin.MONTHS
const LIMIT = 50000;

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (s) => iso(new Date(s));                                   // lokale datum van een ISO-tijd
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
const today = () => iso(new Date());
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v) => Math.round(v * 10) / 10;

export async function connect() {
  if (!available()) throw new Error('Apple Watch koppelen kan enkel in de dE3p-app op je iPhone.');
  const ok = await H().isAvailable().catch(() => ({ available: false }));
  if (!ok.available) throw new Error('Apple Gezondheid is niet beschikbaar op dit toestel.');
  // iOS zegt nooit of je 'lezen' toestond (privacy): we vragen het en kijken daarna of er gegevens zijn
  await H().requestAuthorization({ read: READ });
  store.save({ apple: true });
  await store.del('apple');
}
export async function disconnect() {
  store.save({ apple: null });
  await store.del('apple');
}

async function samples(dataType, a, b) {
  const r = await H().readSamples({ dataType, startDate: new Date(`${a}T00:00:00`).toISOString(),
    endDate: new Date(`${addDays(b, 1)}T00:00:00`).toISOString(), limit: LIMIT, ascending: true }).catch(() => ({ samples: [] }));
  return r?.samples || [];
}
async function perDay(dataType, a, b, aggregation = 'sum') {
  const r = await H().queryAggregated({ dataType, startDate: new Date(`${a}T00:00:00`).toISOString(),
    endDate: new Date(`${addDays(b, 1)}T00:00:00`).toISOString(), bucket: 'day', aggregation }).catch(() => ({ samples: [] }));
  const out = {};
  for (const s of r?.samples || []) if (s.value != null) out[dayOf(s.startDate)] = s.value;
  return out;
}

// slaap: per nacht (de dag waarop je wakker wordt) de bron met de meeste slaap; dutjes overdag tellen niet
function nights(list) {
  const by = {};
  for (const s of list) {
    const st = new Date(s.startDate); const h = st.getHours();
    if (h >= 12 && h < 18) continue;                                       // dutje
    const night = h >= 18 ? addDays(iso(st), 1) : iso(st);
    const src = s.sourceName || '?';
    const n = ((by[night] ||= {})[src] ||= { deep: 0, light: 0, rem: 0, asleep: 0, awake: 0 });
    const min = (new Date(s.endDate) - st) / 60e3;
    const k = s.sleepState === 'light' || s.sleepState === 'deep' || s.sleepState === 'rem' || s.sleepState === 'awake' ? s.sleepState
      : s.sleepState === 'asleep' ? 'asleep' : null;
    if (k) n[k] += min;
  }
  const out = {};
  for (const [night, srcs] of Object.entries(by)) {
    const best = Object.values(srcs).map((n) => ({ ...n, total: n.deep + n.light + n.rem + n.asleep })).sort((x, y) => y.total - x.total)[0];
    if (!best || best.total < 60) continue;
    const staged = best.deep + best.light + best.rem > 0;
    const s = (m) => Math.round(m * 60);
    out[night] = { score: null, secs: s(best.total), deep: staged ? s(best.deep) : null, light: staged ? s(best.light + best.asleep) : null,
      rem: staged ? s(best.rem) : null, awake: s(best.awake), resp: null, spo2: null };
  }
  return out;
}
// een waarde per dag: 's nachts gemeten gaat voor (HRV, ademhaling, zuurstof), anders het daggemiddelde
function nightly(list, scale = 1) {
  const by = {};
  for (const s of list) {
    const t = new Date(s.startDate); const d = iso(t);
    (by[d] ||= { night: [], all: [] }).all.push(s.value * scale);
    if (t.getHours() < 9) by[d].night.push(s.value * scale);
  }
  return Object.fromEntries(Object.entries(by).map(([d, v]) => [d, mean(v.night.length ? v.night : v.all)]));
}
const lastPerDay = (list, scale = 1) => Object.fromEntries(list.map((s) => [dayOf(s.startDate), s.value * scale]));
const pct = (v) => (v <= 1.5 ? v * 100 : v);                            // HealthKit geeft 0,15 voor 15 %

async function fetchDays(a, b) {
  const [sleep, hrv, rhr, resp, spo2, weight, fat, vo2] = await Promise.all(
    ['sleep', 'heartRateVariability', 'restingHeartRate', 'respiratoryRate', 'oxygenSaturation', 'weight', 'bodyFat', 'vo2Max'].map((t) => samples(t, a, b)));
  const [steps, dist, kcal, exer] = await Promise.all([perDay('steps', a, b), perDay('distance', a, b), perDay('calories', a, b), perDay('exerciseTime', a, b)]);
  const days = {};
  const day = (d) => (days[d] ||= { date: d });
  for (const [d, v] of Object.entries(nights(sleep))) day(d).sleep = v;
  for (const [d, v] of Object.entries(nightly(resp))) if (days[d]?.sleep) days[d].sleep.resp = r1(v);
  for (const [d, v] of Object.entries(nightly(spo2))) if (days[d]?.sleep && v) days[d].sleep.spo2 = Math.round(pct(v));
  // Apple meet HRV als SDNN (Garmin, Whoop en Oura als rMSSD): de trend klopt, de cijfers zijn anders
  for (const [d, v] of Object.entries(nightly(hrv))) day(d).hrv = { night: Math.round(v), week: null, status: '' };
  for (const [d, v] of Object.entries(lastPerDay(rhr))) day(d).rhr = Math.round(v);
  for (const [d, v] of Object.entries(steps)) if (v > 0) day(d).steps = { n: Math.round(v), goal: null, km: dist[d] ? r1(dist[d] / 1000) : null };
  for (const [d, v] of Object.entries(kcal)) if (v > 0) day(d).kcal = { total: null, active: Math.round(v) };
  for (const [d, v] of Object.entries(exer)) day(d).intensity = Math.round(v);
  for (const [d, v] of Object.entries(lastPerDay(vo2))) day(d).status = { label: null, vo2max: r1(v), load: null, ratio: null };
  for (const [d, v] of Object.entries(lastPerDay(weight))) day(d).weight = { kg: r1(v) };
  for (const [d, v] of Object.entries(lastPerDay(fat))) if (days[d]?.weight) days[d].weight.fat = r1(pct(v));
  // bloedsuiker (mg/dL, van een meter of sensor zoals FreeStyle Libre of Dexcom) en bloeddruk (Omron, Withings ...)
  const [glu, bp] = await Promise.all([samples('bloodGlucose', a, b), samples('bloodPressure', a, b)]);
  const hhmm = (s) => { const t = new Date(s); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
  const byDay = (list) => list.reduce((o, s) => { (o[dayOf(s.startDate)] ||= []).push(s); return o; }, {});
  for (const [d, xs] of Object.entries(byDay(glu.filter((s) => s.value > 0)))) {
    const last = xs[xs.length - 1];
    day(d).glucose = { avg: Math.round(mean(xs.map((s) => s.value))), last: Math.round(last.value), ctx: 'los', n: xs.length, at: hhmm(last.startDate) };
  }
  for (const [d, xs] of Object.entries(byDay(bp.filter((s) => s.systolic && s.diastolic)))) {
    const last = xs[xs.length - 1];
    day(d).bp = { sys: Math.round(last.systolic), dia: Math.round(last.diastolic), pulse: null, n: xs.length, at: hhmm(last.startDate), src: 'Apple Gezondheid' };
  }
  // Garmin zet geen rustpols in Apple Gezondheid, wel je hartslag: dan rekent dE3p hem zelf uit (laatste 60 dagen)
  const hrFrom = a > addDays(b, -60) ? a : addDays(b, -60);
  const hr = await samples('heartRate', hrFrom, b);
  for (const [d, v] of Object.entries(restingFrom(hr))) if (!days[d]?.rhr) day(d).rhr = v;
  return days;
}
// rustpols uit losse hartslagmetingen: het laagste gemiddelde van 5 opeenvolgende metingen 's nachts (0–8 u),
// anders over de hele dag. Zoals een horloge: je laagste rustige hartslag.
function restingFrom(list) {
  const by = {};
  for (const x of list) {
    if (!(x.value > 25 && x.value < 220)) continue;
    const t = new Date(x.startDate); const d = iso(t);
    ((by[d] ||= { night: [], all: [] })[t.getHours() < 8 ? 'night' : 'all']).push(x.value);
  }
  const low = (xs) => { let m = Infinity; for (let i = 0; i + 5 <= xs.length; i += 1) m = Math.min(m, mean(xs.slice(i, i + 5))); return Number.isFinite(m) ? Math.round(m) : null; };
  return Object.fromEntries(Object.entries(by).map(([d, v]) => [d, low(v.night.length >= 5 ? v.night : [...v.night, ...v.all])]).filter(([, v]) => v));
}
function weekAvg(days) {                                                  // HRV: ook het 7-daags gemiddelde, zoals bij Garmin
  const ds = Object.keys(days).sort();
  ds.forEach((d, i) => {
    const h = days[d].hrv;
    if (!h) return;
    const vals = ds.slice(Math.max(0, i - 6), i + 1).map((x) => days[x].hrv?.night).filter((v) => v != null);
    h.week = vals.length ? Math.round(mean(vals)) : null;
  });
}

let busy = null;
async function ensure(force = false) {
  if (busy) return busy;
  busy = (async () => {
    const cache = (await store.get('apple')) || {};
    const td = today(); const first = addDays(td, -(KEEP - 1));
    let span = null;
    if (!cache.from || cache.from > first) span = [first, td];
    else if (force || Date.now() - (cache.at || 0) > FRESH) span = [addDays(td, -3), td];
    if (!span) return cache;
    const fresh = await fetchDays(...span);
    const days = { ...(cache.days || {}) };
    for (let d = span[0]; d <= span[1]; d = addDays(d, 1)) delete days[d];   // opnieuw opgehaald: oude waarden weg
    Object.assign(days, fresh);
    weekAvg(days);
    const keep = Object.keys(days).sort().slice(-KEEP);
    // je lengte (laatste meting, voor je BMI bij je lichaamsleeftijd)
    const h = (await samples('height', addDays(td, -3650), td)).pop();
    const heightCm = h?.value ? Math.round(h.value > 3 ? h.value : h.value * 100) : cache.heightCm || null;
    const next = { from: cache.from && cache.from < first ? cache.from : first, at: Date.now(), heightCm,
      days: Object.fromEntries(keep.map((d) => [d, days[d]])) };
    await store.put('apple', next);
    return next;
  })();
  try { return await busy; } finally { busy = null; }
}

export async function recovery(days = 7, force = false) {
  const cache = await ensure(force);
  const td = today(); const all = cache.days || {};
  const n = Math.max(1, Math.min(Number(days) || 7, KEEP));
  const history = [];
  for (let i = n - 1; i >= 0; i -= 1) { const d = addDays(td, -i); if (all[d]) history.push(all[d]); }
  if (!history.length && !all[td]) return { error: 'Nog geen gegevens uit Apple Gezondheid. Kijk in Instellingen → Privacy → Gezondheid → dE3p of alles aan staat.' };
  return { today: all[td] || { date: td }, history, source: 'apple' };
}

// 'Alles': gemiddelde per maand, zelfde vorm als garmin._aggregate
export async function months(force = false) {
  const cache = await ensure(force);
  const now = new Date(); const td = today();
  const first = new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1), 1);
  const buckets = {};
  const add = (m, k, v) => { if (v != null) ((buckets[m] ||= {})[k] ||= []).push(v); };
  const weeks = {};
  for (const [d, v] of Object.entries(cache.days || {})) {
    const m = d.slice(0, 7);
    add(m, 'score', v.sleep?.score); add(m, 'secs', v.sleep?.secs); add(m, 'rhr', v.rhr); add(m, 'hrv', v.hrv?.night);
    add(m, 'vo2', v.status?.vo2max); add(m, 'steps', v.steps?.n);
    add(m, 'glu', v.glucose?.avg); add(m, 'sys', v.bp?.sys); add(m, 'dia', v.bp?.dia);
    if (v.intensity != null) {
      const t = new Date(`${d}T12:00:00`); const mon = addDays(d, -((t.getDay() + 6) % 7));
      weeks[mon] = (weeks[mon] || 0) + v.intensity;
    }
  }
  for (const [mon, im] of Object.entries(weeks)) {
    add(addDays(mon, 3).slice(0, 7), 'im', im);                            // maand van de donderdag
    add(addDays(mon, 3).slice(0, 7), 'imgoal', 150);
  }
  const out = [];
  for (let d = new Date(first); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const b = buckets[key] || {};
    out.push({ m: key, partial: key === td.slice(0, 7), v: Object.fromEntries(Object.entries(b).map(([k, xs]) => [k, r1(mean(xs))])),
      n: Object.fromEntries(Object.entries(b).map(([k, xs]) => [k, xs.length])) });
  }
  return { months: out, today: td, source: 'apple' };
}

// je wegingen uit Apple Gezondheid (voor je weegschaal en BMI), uit wat al opgehaald is
export async function lastWeights() {
  if (!connected()) return [];
  const days = (await store.get('apple'))?.days || {};
  return Object.values(days).filter((d) => d.weight?.kg).map((d) => ({ date: d.date, kg: d.weight.kg, fat: d.weight.fat || null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// je laatste bloedsuiker en bloeddruk (voor Instellingen → Bloedsuiker & bloeddruk), uit wat al opgehaald is
export async function lastVitals() {
  if (!connected()) return {};
  const days = Object.values((await store.get('apple'))?.days || {}).sort((x, y) => x.date.localeCompare(y.date));
  const g = days.filter((d) => d.glucose).pop(); const b = days.filter((d) => d.bp).pop();
  return {
    glucose: g ? { at: `${g.date}T${g.glucose.at}`, mgdl: g.glucose.last, ctx: 'los', src: 'Apple Gezondheid' } : null,
    bp: b ? { at: `${b.date}T${b.bp.at}`, sys: b.bp.sys, dia: b.bp.dia, pulse: null, src: 'Apple Gezondheid' } : null,
  };
}

// voor je lichaamsleeftijd: je lengte uit Apple Gezondheid (geboortedatum en geslacht vraagt dE3p zelf)
export async function body() {
  if (!connected()) return {};
  const cache = (await store.get('apple')) || {};
  return cache.heightCm ? { heightCm: cache.heightCm } : {};
}
