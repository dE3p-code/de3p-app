// Je vorm op de gsm zonder computer, rechtstreeks uit Strava (zelfde idee als prestaties.py op de computer):
//  - records: je snelste 1 km, 5 km, 10 km, halve en hele marathon (best_efforts in de details van elke loop);
//  - loopschoenen: welke schoenen je droeg en hun kilometers (gear);
//  - voorspelling: met de formule van Riegel uit je snelste tijden van de laatste 8 weken (Garmin rekent op
//    de computer zelf; hier doen we het met wat Strava geeft);
//  - hartslagzones per training: uit je hartslag per seconde (streams), met zones volgens je hoogste hartslag.
// Oudere loopjes haalt backfill() stap voor stap op, binnen Strava's limiet. Alles blijft op de gsm (IndexedDB).

import * as store from './store.js';
import * as strava from './strava.js';

const DIST = { '1K': ['1 km', 1000], '5K': ['5 km', 5000], '10K': ['10 km', 10000], 'Half-Marathon': ['Halve marathon', 21097.5], Marathon: ['Marathon', 42195] };
const RUNS = new Set(['Run', 'TrailRun', 'VirtualRun']);
const SHOE_OLD = 600; const SHOE_DONE = 800; const SHOE_DAYS = 120;
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoOf(d); };
const isRun = (a) => RUNS.has(a.sport_type || a.type);

async function data() { return (await store.get('vorm')) || {}; }
const keep = (d) => store.put('vorm', d);

// één loop (Strava-details) verwerken
export function learn(detail, d) {
  if (!detail?.id || !isRun(detail)) return d;
  const when = String(detail.start_date_local || '').slice(0, 10);
  d.best ||= {}; d.recent ||= []; d.gear ||= {};
  for (const e of detail.best_efforts || []) {
    const k = e.name; const secs = e.elapsed_time;
    if (!(k in DIST) || !secs) continue;
    if (!d.best[k] || secs < d.best[k].secs) d.best[k] = { secs, date: when, id: detail.id };
    if (k !== '1K' && when >= daysAgo(180)) d.recent.push({ k, secs, date: when });     // voor de voorspelling
  }
  d.recent = d.recent.filter((x) => x.date >= daysAgo(180)).slice(-400);
  const g = detail.gear;
  if (g?.id && g.distance != null && (!d.gear[g.id] || when >= d.gear[g.id].last)) {
    d.gear[g.id] = { name: g.name || 'Schoenen', km: Math.round(g.distance / 100) / 10, last: when };
  }
  d.seen = [...new Set([...(d.seen || []), detail.id])];
  d.todo = (d.todo || []).filter((x) => x !== detail.id);
  return d;
}

// nieuwe en oudere loopjes ophalen; Strava-limiet (429) = een uur wachten
export async function backfill(limit = 20, budgetMs = 8000) {
  const d = await data();
  if (Date.now() < (d.pause || 0)) return (d.todo || []).length;
  const t0 = Date.now();
  try {
    if (!d.listed) {
      const acts = await strava.listActivities(0);                  // al je activiteiten (nieuwste eerst)
      const seen = new Set(d.seen || []);
      d.todo = acts.filter(isRun).sort((a, b) => b.start_date.localeCompare(a.start_date)).map((a) => a.id).filter((id) => !seen.has(id));
      d.listed = isoOf(new Date());
      await keep(d);
    }
    let n = 0;
    while ((d.todo || []).length && n < limit && Date.now() - t0 < budgetMs) {
      const id = d.todo[0];
      try { learn(await strava.getActivity(id), d); } catch (e) {
        if (/limiet/i.test(e.message)) throw e;
        d.todo = d.todo.slice(1);                                    // weg of privé: overslaan
      }
      n += 1;
    }
  } catch (e) {
    if (/limiet/i.test(e.message)) d.pause = Date.now() + 3600e3;
  }
  await keep(d);
  return (d.todo || []).length;
}
// één loop waarvan de gsm de details al heeft (bij de sync): meteen leren
export async function learnDetail(detail) {
  const d = await data();
  learn(detail, d);
  await keep(d);
}
// een nieuwe loop: meteen leren (de sync haalt alleen de samenvatting; hier de details)
export async function learnNew(ids) {
  const d = await data();
  if (!d.listed) return;                                           // de eerste keer doet backfill alles
  const seen = new Set(d.seen || []);
  d.todo = [...ids.filter((id) => !seen.has(id) && !(d.todo || []).includes(id)), ...(d.todo || [])];
  await keep(d);
}

// Riegel: tijd op afstand D uit een tijd t op afstand d = t × (D/d)^1,06. De snelste uitkomst telt.
function riegel(efforts) {
  const out = {};
  for (const [key, D] of [['5k', 5000], ['10k', 10000], ['half', 21097.5], ['marathon', 42195]]) {
    const ts = efforts.map((e) => e.secs * (D / DIST[e.k][1]) ** 1.06);
    if (ts.length) out[key] = Math.round(Math.min(...ts));
  }
  return out.marathon ? out : null;
}
export async function status() {
  const d = await data(); const today = new Date();
  const records = Object.entries(DIST).filter(([k]) => d.best?.[k]).map(([k, [label]]) => ({ k, label, ...d.best[k],
    new: (today - new Date(`${d.best[k].date}T12:00:00`)) / 864e5 <= 7 }));
  const since = daysAgo(SHOE_DAYS);
  const shoes = Object.entries(d.gear || {}).filter(([, v]) => v.last >= since).map(([id, v]) => ({ ...v, id,
    lvl: v.km >= SHOE_DONE ? 'bad' : v.km >= SHOE_OLD ? 'mid' : 'good' })).sort((a, b) => b.last.localeCompare(a.last));
  const rec = d.recent || [];
  const now = riegel(rec.filter((x) => x.date >= daysAgo(56)));
  const before = riegel(rec.filter((x) => x.date >= daysAgo(84) && x.date < daysAgo(28)));
  return { records, shoes, todo: (d.todo || []).length, listed: Boolean(d.listed),
    race: now ? { now: { date: isoOf(today), ...now }, before: before ? { ...before } : null, src: 'je snelste tijden' } : null, lt: null };
}

// hartslagzones van één training, uit je hartslag per seconde. Zones zoals Garmin standaard rekent:
// 50–60–70–80–90 % van je hoogste hartslag (de hoogste uit je trainingen van het laatste half jaar).
export async function zones(act, maxHr) {
  if (!act?.id || !(maxHr > 100)) return null;
  const key = `zones:${act.id}`;
  const hit = await store.get(key);
  if (hit) return hit;
  const s = await strava.getStreams(act.id).catch(() => null);
  const hr = s?.heartrate?.data; const t = s?.time?.data;
  if (!hr?.length || !t?.length) return null;
  const from = [50, 60, 70, 80, 90].map((p) => Math.round((maxHr * p) / 100));
  const secs = [0, 0, 0, 0, 0];
  for (let i = 1; i < hr.length; i += 1) {
    const dt = Math.min(10, t[i] - t[i - 1]);                    // pauzes tellen niet
    if (dt <= 0) continue;
    let z = 0;
    for (let j = 4; j >= 0; j -= 1) if (hr[i] >= from[j]) { z = j; break; }
    secs[z] += dt;
  }
  const out = { zones: secs.map((x, i) => ({ n: i + 1, secs: Math.round(x), from: from[i] })), lt: null, max: maxHr, src: 'Strava' };
  await store.put(key, out);
  return out;
}

// je computer gaat weg: zijn records en schoenen als vertrekpunt (de gsm vult daarna zelf aan)
export async function seed(v) {
  if (!v) return;
  const d = await data();
  d.best ||= {}; d.gear ||= {};
  for (const r of v.records || []) if (r.k in DIST && (!d.best[r.k] || r.secs < d.best[r.k].secs)) d.best[r.k] = { secs: r.secs, date: r.date, id: r.id };
  for (const s of v.shoes || []) if (s.id && (!d.gear[s.id] || s.last >= d.gear[s.id].last)) d.gear[s.id] = { name: s.name, km: s.km, last: s.last };
  await keep(d);
}
