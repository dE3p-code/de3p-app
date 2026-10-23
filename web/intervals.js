// intervals.icu op de gsm zonder computer: je Garmin (of Coros, Suunto, Polar, Oura …) zet je slaap, HRV,
// rustpols, stappen en gewicht op intervals.icu, en de gsm leest ze daar (via /api/intervals, een doorgeefluik
// dat niets bewaart). Zelfde vorm als garmin.recovery() / months() en wearables.fetch_intervals op de computer.
// Je atleet-ID en API-sleutel blijven op de gsm; de dagen in IndexedDB ('intervals').

import * as store from './store.js';
import { BASE } from './base.js';

const PROXY = `${BASE}/api/intervals/api/v1`;
const KEEP = 400;                 // zoveel dagen terug (per dag terugbladeren en 'Alles')
const FRESH = 30 * 60e3;          // de laatste dagen opnieuw na een half uur
const MONTHS = 12;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
const today = () => iso(new Date());
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v) => Math.round(v * 10) / 10;

const key = () => store.load().intervals || null;
export const connected = () => Boolean(key()?.aid && key()?.key);

async function get(path, k = key()) {
  let r;
  try {
    r = await fetch(`${PROXY}${path}`, { headers: { Authorization: `Basic ${btoa(`API_KEY:${k.key}`)}`, Accept: 'application/json' } });
  } catch { throw new Error('Geen verbinding met intervals.icu. Ben je online?'); }
  if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error('intervals.icu kent die combinatie niet: controleer je atleet-ID (bv. i123456) en API-sleutel.');
  if (!r.ok) throw new Error(`intervals.icu gaf een fout (${r.status}).`);
  return r.json();
}

export async function connect(athleteId, apiKey) {
  let aid = String(athleteId || '').trim(); const k = String(apiKey || '').trim();
  if (/^\d+$/.test(aid)) aid = `i${aid}`;                       // intervals.icu toont 'i123456'
  if (!/^i?\d+$/.test(aid) || k.length < 10) throw new Error('Vul je atleet-ID (bv. i123456) en je API-sleutel in.');
  await get(`/athlete/${aid}`, { aid, key: k });
  store.save({ intervals: { aid, key: k } });
  await store.del('intervals');
}
export async function disconnect() {
  store.save({ intervals: null });
  await store.del('intervals');
}

const level = (v) => (v >= 70 ? 'Goed' : v >= 40 ? 'Matig' : 'Laag');
function toDay(w) {
  const x = { date: w.id };
  if (w.sleepSecs) x.sleep = { score: w.sleepScore ?? null, secs: w.sleepSecs, deep: null, light: null, rem: null, awake: null, resp: w.respiration ?? null, spo2: w.spO2 ?? null };
  if (w.hrv) x.hrv = { night: Math.round(w.hrv), week: null, status: '' };
  if (w.restingHR) x.rhr = Math.round(w.restingHR);
  if (w.steps) x.steps = { n: w.steps, goal: null, km: null };
  if (w.readiness != null) x.readiness = { score: Math.round(w.readiness), level: level(w.readiness), recovery_h: null };
  if (w.vo2max || w.ctl != null) {
    const load = w.ctl != null && w.atl != null ? `fitheid ${Math.round(w.ctl)} · vorm ${Math.round(w.ctl - w.atl) >= 0 ? '+' : ''}${Math.round(w.ctl - w.atl)}` : null;
    x.status = { label: null, vo2max: w.vo2max ? r1(w.vo2max) : null, load, ratio: null };
  }
  if (w.weight) x.weight = { kg: r1(w.weight), ...(w.bodyFat ? { fat: r1(w.bodyFat) } : {}) };
  if (w.systolic && w.diastolic) x.bp = { sys: Math.round(w.systolic), dia: Math.round(w.diastolic), pulse: null, n: 1, at: '', src: 'intervals.icu' };
  return Object.keys(x).length > 1 ? x : null;
}
function weekAvg(days) {                                        // HRV: ook het 7-daags gemiddelde
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
    const cache = (await store.get('intervals')) || {};
    const td = today(); const first = addDays(td, -(KEEP - 1));
    let span = null;
    if (!cache.from || cache.from > first) span = [first, td];
    else if (force || Date.now() - (cache.at || 0) > FRESH) span = [addDays(td, -3), td];
    if (!span) return cache;
    const list = await get(`/athlete/${key().aid}/wellness?oldest=${span[0]}&newest=${span[1]}`);
    const days = { ...(cache.days || {}) };
    for (let d = span[0]; d <= span[1]; d = addDays(d, 1)) delete days[d];
    for (const w of list || []) { const x = w?.id ? toDay(w) : null; if (x) days[x.date] = x; }
    weekAvg(days);
    const keep = Object.keys(days).sort().slice(-KEEP);
    const next = { from: cache.from && cache.from < first ? cache.from : first, at: Date.now(), days: Object.fromEntries(keep.map((d) => [d, days[d]])) };
    await store.put('intervals', next);
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
  if (!history.length) return { error: 'Nog geen gegevens op intervals.icu. Kijk of je horloge (bv. Garmin Connect) daar gekoppeld is bij Settings → Connections.' };
  return { today: all[td] || { date: td }, history, source: 'intervals' };
}

// 'Alles': gemiddelde per maand, zelfde vorm als garmin._aggregate
export async function months(force = false) {
  const cache = await ensure(force);
  const now = new Date(); const td = today();
  const buckets = {};
  const add = (m, k, v) => { if (v != null) ((buckets[m] ||= {})[k] ||= []).push(v); };
  for (const [d, v] of Object.entries(cache.days || {})) {
    const m = d.slice(0, 7);
    add(m, 'score', v.sleep?.score); add(m, 'secs', v.sleep?.secs); add(m, 'rhr', v.rhr); add(m, 'hrv', v.hrv?.night);
    add(m, 'vo2', v.status?.vo2max); add(m, 'steps', v.steps?.n); add(m, 'ready', v.readiness?.score); add(m, 'weight', v.weight?.kg);
    add(m, 'spo2', v.sleep?.spo2); add(m, 'sys', v.bp?.sys); add(m, 'dia', v.bp?.dia);
  }
  const out = [];
  for (let d = new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1), 1); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const b = buckets[k] || {};
    out.push({ m: k, partial: k === td.slice(0, 7), v: Object.fromEntries(Object.entries(b).map(([x, xs]) => [x, r1(mean(xs))])),
      n: Object.fromEntries(Object.entries(b).map(([x, xs]) => [x, xs.length])) });
  }
  return { months: out, today: td, source: 'intervals' };
}
