// dE3p op de gsm: dezelfde schermen als het programma (app.js). Op de computer praat app.js met
// Python (window.pywebview.api); hier doet deze "motor" dat werk in de browser:
//  - gekoppeld met je computer: de versleutelde kopie die het programma na elke sync doorstuurt
//    (trainingen, schema, kaarten, gezondheid), enkel te openen met de sleutel van de koppelcode;
//  - Strava rechtstreeks op de gsm (eigen Strava-sleutel), ook zonder computer;
//  - of allebei: dan komen je nieuwste runs van Strava, de rest van je computer.
// In de echte iPhone-app (Capacitor) komt daar Apple Gezondheid bij (web/health.js): dan werkt alles
// met enkel je gsm.

import * as store from './store.js';
import * as strava from './strava.js';
import * as health from './health.js';
import * as lichaam from './lichaam.js';
import * as vorm from './vorm.js';
import * as kern from './kern.js';
import * as intervals from './intervals.js';
import { NATIVE } from './base.js';
import { pairWith, fetchSnapshot, fetchCard, normCode, sendInbox, snapTime } from './crypto.js';
import { runJson, uiWeeks, race, dayFor, paceText } from './model.js';
import { renderRecap } from './recap.js';

const HISTORY_WEEKS = 26;
const q = new URLSearchParams(location.search);
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoOf(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoOf(d); };
const nowMin = () => { const d = new Date(); return `${isoOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const standalone = () => NATIVE || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const browser = () => window.capacitorBrowser?.Browser;          // in de app: Strava en links in een venster in de app
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);
const RUN_KINDS = new Set(['recovery', 'easy', 'strides', 'long', 'tempo', 'interval', 'mp', 'race']);

const mem = { snap: undefined, acts: undefined, blobs: new Map(), urls: new Map(), cancel: false, recheck: null, install: null };
const hasStrava = () => Boolean(store.load().strava?.tokens);
const hasPc = () => Boolean(store.load().pc);
const isDemo = () => Boolean(store.load().demo);

// ---- voorbeeldgegevens (demo): dezelfde data als de handleiding, verschoven naar vandaag ----------
function shift(obj, days, months) {
  const moveDay = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); const x = new Date(y, m - 1, d + days); return isoOf(x) + s.slice(10); };
  const moveMonth = (s) => { const [y, m] = s.split('-').map(Number); const x = new Date(y, m - 1 + months, 1); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; };
  const walk = (v) => {
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return moveDay(v);
      if (/^\d{4}-\d{2}$/.test(v)) return moveMonth(v);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [/^\d{4}-\d{2}-\d{2}(T[\d:]+)?$/.test(k) ? moveDay(k) : k, walk(x)]));
    return v;
  };
  return walk(obj);
}
async function demoSnap() {
  const d = await (await fetch('web/demo.json')).json();
  const [y, m, dd] = d.today.split('-').map(Number);
  const t = new Date();
  // per hele week verschuiven, zodat het schema op dezelfde weekdagen blijft
  const days = Math.floor((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(y, m - 1, dd)) / 864e5 / 7) * 7;   // nooit in de toekomst
  const moved = new Date(y, m - 1, dd + days);
  const months = (moved.getFullYear() - y) * 12 + (moved.getMonth() - (m - 1));
  return { ...shift(d, days, months), made: nowMin() };
}

async function snap() {
  if (mem.snap === undefined) mem.snap = isDemo() ? await demoSnap() : (hasPc() ? (await store.get('snap')) || null : null);
  return mem.snap;
}
// Garmin haperde op de computer, of een nieuwe computer met minder dagen: wat de gsm al had blijft staan
function keepHealth(sn, old) {
  const h = sn.health;
  const o = old?.health || {};
  if (!h || (!h.rec && !h.months)) return sn;       // gezondheid uitgezet op de computer
  const good = (x) => x && !x.error;
  if (!good(h.rec) && good(o.rec)) h.rec = { ...o.rec, stale: true };
  else if (good(h.rec) && good(o.rec)) {
    const byDate = new Map((o.rec.history || []).map((d) => [d.date, d]));
    for (const d of h.rec.history || []) byDate.set(d.date, d);
    h.rec.history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
  }
  if (!good(h.months) && good(o.months)) h.months = { ...o.months, stale: true };
  return sn;
}
async function refreshSnap() {
  const pc = store.load().pc;
  if (!pc || isDemo()) return;
  let sn = await fetchSnapshot(pc);
  if (sn) {
    sn = keepHealth(sn, mem.snap !== undefined ? mem.snap : await store.get('snap'));
    mem.snap = sn;
    await store.put('snap', sn);
    forgetApplied(sn);
  }
  store.save({ snapAt: Date.now() });
}
// je doelen (meerdere tegelijk), zelfde vorm als localextra.py: { v: 2, goals: [{ id, profile, plans: { sport: plan } }] }
// Oud (tot 2.5): { swim: plan, …, goal: profiel } → vanzelf omgezet. Oude krachtschema's vallen weg (dE3p = duursporten).
const EXTRA_SPORTS = ['swim', 'run', 'ride'];
const KIND = { swim: 'zwemmen', run: 'lopen', ride: 'fietsen' };
const planOk = (p) => Array.isArray(p?.sessions) && p.sessions.length > 0;
function normExtra(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(x.goals)) {
    return { v: 2, goals: x.goals.filter((g) => g?.id && g.plans).map((g) => ({ ...g, profile: g.profile || {},
      plans: Object.fromEntries(Object.entries(g.plans).filter(([sp, p]) => EXTRA_SPORTS.includes(sp) && planOk(p))) }))
      .filter((g) => Object.keys(g.plans).length) };
  }
  const plans = Object.fromEntries(EXTRA_SPORTS.filter((sp) => planOk(x[sp])).map((sp) => [sp, x[sp]]));
  const goals = [];
  const mine = Object.fromEntries(Object.entries(plans).filter(([, p]) => p.config?.fromGoal));
  if (x.goal && Object.keys(mine).length) goals.push({ id: 'g1', profile: x.goal, plans: mine });
  for (const [sp, p] of Object.entries(plans)) {
    if (x.goal && p.config?.fromGoal) continue;
    goals.push({ id: `x-${sp}`, plans: { [sp]: p },
      profile: { kind: KIND[sp], standalone: true, startDate: p.config?.startDate || p.sessions[0].date, weeks: p.weeks, days: p.config?.days || [] } });
  }
  return { v: 2, goals };
}
const ownExtra = () => normExtra(store.load().extraOwn);
// Gekoppeld met je computer: je doelen staan op de computer. Wat je hier wijzigt, staat meteen op de gsm
// (in afwachting) en gaat versleuteld naar je computer; zodra die het verwerkte (goalsApplied), vergeet de gsm het.
const goalOps = () => (Array.isArray(store.load().goalOps) ? store.load().goalOps : []);
// gewicht, weegschaal, bloedsuiker en bloeddruk ingevuld op de gsm (ops weight, scale, glucose, bp, vitals)
const weightOps = () => (Array.isArray(store.load().weightOps) ? store.load().weightOps : []);
const pendingOps = () => [...goalOps(), ...weightOps()];     // de brievenbus heeft één vak: altijd alles samen sturen
async function flushGoals() {
  const ops = pendingOps();
  if (!ops.length || !hasPc()) return;
  await sendInbox(store.load().pc, { v: 1, ops });
}
// Bijwerken (met de hand): je computer meteen laten syncen en wachten op zijn nieuwe kopie. Werkt als dE3p op je
// computer openstaat (die kijkt elke 15 s); anders na ±75 s gewoon de laatste kopie. true = nieuwe kopie binnen.
const ASK_WAIT = 75e3;
async function askPc() {
  const pc = store.load().pc;
  const before = await snapTime(pc).catch(() => null);
  const oid = `s${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  await sendInbox(pc, { v: 1, ops: [...pendingOps(), { oid, op: 'sync', at: new Date().toISOString() }] });
  const end = Date.now() + ASK_WAIT;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 3000));
    const at = await snapTime(pc).catch(() => null);
    if (at && (!before || at > before)) return true;
  }
  return false;
}
function forgetApplied(sn) {
  const done = new Set(sn?.settings?.goalsApplied || []);
  if (done.size && goalOps().some((o) => done.has(o.oid))) store.save({ goalOps: goalOps().filter((o) => !done.has(o.oid)) });
  if (done.size && weightOps().some((o) => done.has(o.oid))) store.save({ weightOps: weightOps().filter((o) => !done.has(o.oid)) });
}
// je weegschaal: wat je computer weet, met wat je hier invulde en je computer nog niet verwerkte
function scaleWithPending(sc) {
  const b = weightOps().filter((o) => o.op === 'scale').slice(-1)[0];      // weegschaal gekozen op de gsm
  if (b) sc = { ...(sc || {}), brand: b.brand, brandName: lichaam.BRANDS[b.brand] || '' };
  const p = weightOps().filter((o) => o.op === 'weight').slice(-1)[0];
  if (!p) return sc || null;
  const last = sc?.last;
  if (last && last.date > p.date) return sc;
  return { ...(sc || {}), last: { date: p.date, kg: p.kg, fat: p.fat || null, src: 'zelf ingevuld (wordt verwerkt)' },
    delta: last?.kg && last.date < p.date ? Math.round((p.kg - last.kg) * 10) / 10 : sc?.delta ?? null };
}
// lichaamsleeftijd en BMI: Apple Gezondheid, dan je computer, dan wat je op de gsm zelf invulde
async function bodyOf(ss, s) {
  const apple = await health.body().catch(() => ({}));
  const own = s.body || {};
  return { ...apple, ...(ss.body || {}), ...own, source: own.birth ? 'eigen' : (ss.body?.source || ''),
    heightSrc: own.heightCm ? 'eigen' : ss.body?.heightCm ? (ss.body.heightSrc || 'garmin') : apple.heightCm ? 'apple' : '' };
}
// bloedsuiker en bloeddruk: wat je computer weet, met wat je hier aanzette of invulde en je computer nog niet verwerkte
const PENDING = 'zelf ingevuld (wordt verwerkt)';
function vitalsWithPending(v) {
  v = { ...(v || {}), track: { ...(v?.track || {}) } };
  const ops = weightOps();
  for (const o of ops.filter((x) => x.op === 'vitals')) v.track[o.kind] = o.on;
  const g = ops.filter((o) => o.op === 'glucose').slice(-1)[0];
  if (g && !(v.glucose?.last?.at > g.at)) v.glucose = { ...(v.glucose || {}), last: { at: g.at, mgdl: g.mgdl, ctx: g.ctx, src: PENDING } };
  const b = ops.filter((o) => o.op === 'bp').slice(-1)[0];
  if (b && !(v.bp?.last?.at > b.at)) v.bp = { ...(v.bp || {}), last: { at: b.at, sys: b.sys, dia: b.dia, pulse: b.pulse, src: PENDING } };
  const w = ops.filter((o) => o.op === 'waist').slice(-1)[0];
  if (w && !(v.waist?.last?.at > w.at)) v.waist = { ...(v.waist || {}), last: { at: w.at, cm: w.cm } };
  for (const o of ops.filter((x) => x.op === 'sweat')) {          // zweetverlies: meteen tonen, je computer bewaart het
    const item = lichaam.sweatItem(o.start, { before: o.before, after: o.after, drank: o.drank, secs: o.secs }, o.at);
    v.sweat = [...(v.sweat || []).filter((x) => x.start !== o.start), item];
  }
  return v;
}
// zonder computer: je metingen staan op deze gsm (lichaam.js), aangevuld met Apple Gezondheid
const localVitals = async () => lichaam.vitals(await health.lastVitals().catch(() => ({})));
const localScale = async () => lichaam.scale(await health.lastWeights().catch(() => []));
const vitalsOp = async (o) => {
  store.save({ weightOps: [...weightOps(), { oid: `v${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`, ...o }] });
  await flushGoals().catch(() => {});               // lukt het nu niet, dan bij de volgende keer Bijwerken
  return vitalsWithPending((await snap())?.settings?.vitals);
};
function withPending(goals) {                     // doelen van je computer + wat de gsm nog moet doorgeven
  let out = [...goals];
  for (const o of goalOps()) {
    out = out.filter((g) => g.id !== o.id);
    if (o.op === 'save') out.push(...goalsFrom({ goals: [{ id: o.id, profile: o.profile, plans: o.plans }] }));
  }
  return out;
}
function rowsWithPending(rows) {
  const ops = goalOps();
  if (!ops.length) return rows;
  const touched = new Set(ops.map((o) => o.id));
  const last = new Map(ops.map((o) => [o.id, o]));
  const saved = [...last.values()].filter((o) => o.op === 'save').map((o) => ({ id: o.id, profile: o.profile, plans: o.plans }));
  return [...rows.filter((x) => !touched.has(x.goal)), ...extraRowsFrom(normExtra({ goals: saved }))].sort((a, b) => a.date.localeCompare(b.date));
}
function extraRowsFrom(data) {
  return data.goals.flatMap((g) => Object.entries(g.plans).flatMap(([sp, p]) => p.sessions.map((s) => ({ ...s, sport: sp, goal: g.id, weeks: p.weeks }))))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function goalsFrom(data) {
  return data.goals.map((g) => ({ id: g.id, profile: g.profile || {}, sports: Object.fromEntries(Object.entries(g.plans).map(([sp, p]) => {
    const ss = p.sessions;
    return [sp, { config: p.config || {}, weeks: p.weeks, from: ss[0].date, to: ss[ss.length - 1].date, count: ss.length }];
  })) }));
}
// een computer met een oudere versie stuurt nog één doel + losse schema's
function legacyGoals(ss) {
  const xp = Object.fromEntries(Object.entries(ss.extraPlans || {}).filter(([sp]) => EXTRA_SPORTS.includes(sp))); const g = ss.goal;
  const mine = Object.fromEntries(Object.entries(xp).filter(([, p]) => p.config?.fromGoal));
  const out = g && Object.keys(mine).length ? [{ id: 'g1', profile: g, sports: mine }] : [];
  for (const [sp, p] of Object.entries(xp)) {
    if (g && p.config?.fromGoal) continue;
    out.push({ id: `x-${sp}`, sports: { [sp]: p }, profile: { kind: KIND[sp], standalone: true, startDate: p.config?.startDate || p.from, weeks: p.weeks, days: p.config?.days || [] } });
  }
  return out;
}
async function ownActs() {
  if (mem.acts === undefined) mem.acts = (await store.get('acts')) || [];
  return mem.acts;
}

// ---- de toestand voor app.js (zelfde vorm als build_state in app.py) -----------------------------
async function compose(extra = {}) {
  const s = store.load();
  const sn = await snap();
  const st = sn?.state || {};
  const today = todayIso();
  const byId = new Map((st.acts || st.runs || []).map((a) => [String(a.id), a]));
  const own = isDemo() ? [] : await ownActs();
  for (const a of own) if (!byId.has(String(a.id))) byId.set(String(a.id), a);
  const acts = [...byId.values()].sort((a, b) => (b.start || b.date).localeCompare(a.start || a.date));
  const plan = isDemo() ? null : s.plan;
  const copy = !hasPc() && !isDemo() && !plan ? await pcCopy() : null;    // schema meegenomen van je computer
  const cards = { ...(st.cards || {}) };
  if (hasStrava() && !isDemo()) {
    const since = daysAgo(60);
    for (const r of own) if (r.sport === 'run' && r.date >= since && !(cards[r.date] || []).length) cards[r.date] = [{ path: `web:${r.id}`, name: r.title }];
  }
  const lastSync = [st.lastSync, s.lastStrava].filter(Boolean).sort().pop() || null;
  return {
    generated: nowMin(), today,
    race: plan ? race(plan) : (st.race || copy?.race || null), source: plan ? 'plan' : (st.source || (copy ? 'kopie' : '')),
    schema: plan ? uiWeeks(plan, today) : (st.schema || copy?.schema || []),
    runs: acts.filter((a) => a.sport === 'run'), acts, extra: isDemo() ? [] : hasPc() ? rowsWithPending((st.extra || []).filter((x) => EXTRA_SPORTS.includes(x.sport))) : extraRowsFrom(ownExtra()), cards, cardsDir: '', sync: null, lastSync, problems: [], ...extra,
  };
}

// ---- Strava op de gsm ------------------------------------------------------------------------------
async function stravaSync() {
  const own = await ownActs();
  const newest = own.reduce((m, a) => ((a.start || '') > m ? a.start : m), '');
  const after = newest ? Math.floor(new Date(newest).getTime() / 1000) - 2 * 86400 : Math.floor(Date.now() / 1000) - HISTORY_WEEKS * 7 * 86400;
  const fresh = (await strava.listActivities(after)).map(runJson);
  const byId = new Map(own.map((a) => [String(a.id), a]));
  const added = fresh.filter((a) => a.sport === 'run' && !byId.has(String(a.id))).map((a) => a.id);   // nieuwe loopjes
  for (const a of fresh) byId.set(String(a.id), a);
  const cut = daysAgo(HISTORY_WEEKS * 7 + 7);
  mem.acts = [...byId.values()].filter((a) => a.date >= cut).sort((a, b) => (b.start || b.date).localeCompare(a.start || a.date));
  await store.put('acts', mem.acts);
  store.save({ lastStrava: nowMin() });
  return added;
}

// ---- je computer gaat weg: alles naar deze gsm --------------------------------------------------------
async function pcCopy() {
  if (mem.copy === undefined) mem.copy = (await store.get('pcSchema')) || null;
  return mem.copy;
}
async function takeover() {
  const sn = await snap();
  if (!sn) throw new Error('Je computer heeft nog niets gestuurd. Tik eerst op Nu ophalen.');
  const st = sn.state || {}; const ss = sn.settings || {};
  // 1. je schema (bv. uit Notion): een kopie, zodat je trainingen en uitleg blijven staan
  if ((st.schema || []).length) {
    mem.copy = { schema: st.schema, race: st.race || null, at: nowMin() };
    await store.put('pcSchema', mem.copy);
  }
  // 2. je doelen met hun trainingen
  const x = ownExtra();
  const goals = withPending(Array.isArray(ss.goals) ? ss.goals : legacyGoals(ss));
  const rows = rowsWithPending((st.extra || []).filter((r) => EXTRA_SPORTS.includes(r.sport)));
  for (const g of goals) {
    if (x.goals.some((y) => y.id === g.id)) continue;
    const plans = {};
    for (const [sp, conf] of Object.entries(g.sports || {})) {
      const sessions = rows.filter((r) => r.goal === g.id && r.sport === sp).map(({ sport, goal, weeks, ...rest }) => rest);
      if (sessions.length) plans[sp] = { config: conf.config || {}, weeks: conf.weeks, sessions };
    }
    if (Object.keys(plans).length) x.goals.push({ id: g.id, profile: g.profile || {}, plans });
  }
  store.save({ extraOwn: x });
  // 3. je lichaam: wegingen, bloedsuiker, bloeddruk, taille, zweet; geboortejaar, geslacht en lengte
  lichaam.importFrom({ days: sn.health?.rec?.history || [], vitals: ss.vitals || {}, scale: ss.scale || {} });
  const b = ss.body || {};
  store.save({ body: { ...Object.fromEntries(['birth', 'sex', 'heightCm'].filter((k) => b[k]).map((k) => [k, b[k]])), ...(store.load().body || {}) } });
  // 4. je records en loopschoenen als vertrekpunt
  await vorm.seed(ss.vorm);
  return { schema: (st.schema || []).length > 0, goals: x.goals.length };
}

// zonder computer, na de Strava-sync: per nieuwe loop één keer de details (records, schoenen) en, valt hij op
// een geplande dag en heeft hij nog een standaardnaam, de naam en uitleg uit je schema op Strava (zoals de computer)
async function afterStrava(ids) {
  if (!ids.length) return;
  const named = new Set(store.load().named || []);
  const rows = ((await compose()).schema || []).flatMap((w) => w.rows || []);
  const own = await ownActs();
  const now = ids.slice(0, 6); const later = ids.slice(6);
  for (const id of now) {
    const a = own.find((x) => String(x.id) === String(id));
    const detail = await strava.getActivity(id);
    await vorm.learnDetail(detail);
    if (!a || named.has(id) || a.date < daysAgo(3)) continue;
    named.add(id);
    const res = kern.autoName(detail, rows.find((r) => r.date === a.date && !r.rest));
    if (!res) continue;
    await strava.updateActivity(id, res.description ? { name: res.name, description: res.description } : { name: res.name });
    Object.assign(a, runJson({ ...detail, name: res.name }));      // meteen met de nieuwe naam op de gsm
    if (res.block) await store.put(`kern:${id}`, { structure: rows.find((r) => r.date === a.date && !r.rest)?.structure || '', b: res.block });
  }
  store.save({ named: [...named].slice(-300) });
  await store.put('acts', own);
  if (later.length) await vorm.learnNew(later);
}

// iPhone-beginscherm: een andere site opent in een venster in de app waar je in iOS 26 moeilijk uit raakt.
// x-safari-https:// opent Safari zelf; lukt dat niet (oudere iOS), dan na 3,5 s toch hier.
function openInSafari(url) {
  const t = setTimeout(() => { if (!document.hidden) location.href = url; }, 3500);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(t); }, { once: true });
  location.href = `x-safari-${url}`;
}
function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + 10 * 60e3;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (mem.cancel) { mem.cancel = false; reject(new Error('Geannuleerd.')); return; }
        const s = store.load().strava || {};
        if (s.tokens && !s.pendingState) { resolve(); return; }          // Android: zelfde opslag, al klaar
        const d = await strava.pickUp(state).catch(() => null);
        if (d) {
          if (d.error) reject(new Error('Je hebt de koppeling op Strava geannuleerd.'));
          else await strava.exchange(d.code, d.scope).then(resolve, reject);
          return;
        }
        if (Date.now() > until) { reject(new Error('Geen antwoord van Strava gekregen. Probeer het nog eens.')); return; }
        setTimeout(tick, 2000);
      } finally { busy = false; }
    };
    mem.recheck = tick;
    setTimeout(tick, 2000);
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) mem.recheck?.(); });

// ---- kaarten ---------------------------------------------------------------------------------------
async function makeWebCard(id, words) {
  const r = (await ownActs()).find((a) => String(a.id) === String(id));
  if (!r) throw new Error('Deze training staat niet op deze gsm.');
  const [detail, streams] = await Promise.all([strava.getActivity(id), strava.getStreams(id).catch(() => null)]);
  let text = words;
  if (!text) {
    const d = dayFor(store.load().plan, r.date);
    const planned = d && RUN_KINDS.has(d.kind) && (r.sport || 'run') === 'run';   // fietsrit op een loopdag houdt z'n eigen naam
    text = { title: planned ? d.title : r.title, subtitle: planned ? (d.detail || '') : r.structure, target: planned && d.pace ? paceText(d.pace) : '' };
  }
  const canvas = document.createElement('canvas');
  await renderRecap(canvas, { activity: detail, detail, streams, text });
  return new Promise((res) => { canvas.toBlob(res, 'image/jpeg', 0.9); });
}
async function cardBlob(path) {
  let blob = await store.get(`card:${path}`);
  if (!blob) {
    if (path.startsWith('pc:')) blob = await fetchCard(store.load().pc, path.slice(3));
    else if (path.startsWith('web:')) blob = await makeWebCard(path.slice(4));
    else if (path.startsWith('demo:')) blob = await (await fetch('web/demo-card.jpg')).blob();
    else throw new Error('Onbekende kaart.');
    if (!path.startsWith('demo:')) await store.put(`card:${path}`, blob);
  }
  return blob;
}
function remember(path, blob) {
  const old = mem.urls.get(path);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  mem.blobs.set(path, blob);
  mem.urls.set(path, url);
  return url;
}

// ---- terugkomen van Strava (OAuth) of via de QR-code van je computer --------------------------------
function handoffPage(ok) {
  document.body.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center">
    <div style="max-width:360px"><img src="logo.png" alt="dE3p" style="height:30px;margin:0 auto 22px;display:block">
    <div class="label">${ok ? 'Gelukt' : 'Oeps'}</div>
    <h1 style="font-size:28px;margin:10px 0 12px">${ok ? 'Ga terug naar de app' : 'Dat lukte niet'}</h1>
    <p class="muted">${ok ? (isIOS() ? 'Open <b>dE3p</b> weer via het icoon op je beginscherm. De koppeling is dan klaar.' : 'Sluit dit venster en ga terug naar dE3p. De koppeling is dan klaar.')
      : 'Ga terug naar de app en probeer nog eens.'}</p></div></main>`;
}
async function arrival() {
  if (q.has('code') || q.has('error')) {
    history.replaceState(null, '', location.pathname);
    const s = store.load().strava || {};
    const state = q.get('state') || '';
    if (state && s.pendingState !== state) {
      // ander venster dan de app (iPhone-beginscherm): code doorgeven
      const ok = await strava.handOff(state, q).then(() => true, () => false);
      handoffPage(ok);
      return 'handoff';
    }
    const after = store.load().after === 'settings' ? 'settings' : 'setup';
    if (q.get('error')) store.save({ resume: { view: after === 'settings' ? 'instellingen' : 'setup', step: 2, error: 'Je hebt de koppeling op Strava geannuleerd.' } });
    else {
      try {
        await strava.exchange(q.get('code'), q.get('scope'));
        store.save({ resume: after === 'settings' ? { view: 'overzicht', toast: 'Strava gekoppeld' } : { view: 'setup', step: 3 } });
      } catch (e) {
        store.save({ resume: { view: 'setup', step: 2, error: e.message } });
      }
    }
  }
  const s = store.load().strava || {};
  if (s.pendingState && !s.tokens) {
    const d = await strava.pickUp(s.pendingState).catch(() => null);
    if (d?.code && !d.error) {
      try {
        await strava.exchange(d.code, d.scope);
        const after = store.load().after;
        store.save({ after: null, resume: after === 'settings' ? { view: 'overzicht', toast: 'Strava gekoppeld' } : { view: 'setup', step: 3 } });
      } catch { /* dan gewoon opnieuw koppelen */ }
    }
  }
  if (q.has('koppel')) {
    store.save({ pairCode: normCode(q.get('koppel')) });
    history.replaceState(null, '', location.pathname);
  }
  return '';
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); mem.install = e; });

// ---- de API, zelfde namen als app.py -----------------------------------------------------------------
const nope = (what) => () => { throw new Error(`${what} doe je in het programma op je computer.`); };
const api = {
  async settings() {
    const s = store.load();
    const sn = await snap();
    const ss = sn?.settings || {};
    const pc = hasPc() || isDemo();
    const sv = hasStrava() && !isDemo();
    const resume = s.resume || null;
    if (resume) store.save({ resume: null });
    const last = [sn?.state?.lastSync, s.lastStrava].filter(Boolean).sort().pop() || null;
    return {
      autosync: Boolean(pc || sv) && (!s.syncedAt || Date.now() - s.syncedAt > 60e3), selftest: false,
      connected: pc || sv, legacy: false, athlete: ss.athlete || s.strava?.athlete || '', scopeOk: true,
      clientId: s.strava?.clientId || '', rename: false, cardsDir: '', notion: Boolean(ss.notion) && !s.plan,
      plan: (isDemo() ? null : s.plan?.config) || ss.plan || null, platform: 'web', version: ss.version || '', dataDir: '',
      theme: s.prefs?.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),   // standaard zoals je gsm
      histView: 'lijst', histSport: 'all', healthDays: s.prefs?.health_days || 'dag',
      canUpdate: false, cardSports: ['run'], cardChoices: null, lastSync: last, titleInstruction: '', titleTemplate: '',
      browsers: [], garmin: Boolean(ss.garmin), browser: '', phone: null, resume,
      body: await bodyOf(ss, s),   // lichaamsleeftijd en BMI
      // weegschaal, bloedsuiker/bloeddruk en je vorm: van je computer, of zonder computer op deze gsm zelf
      scale: hasPc() ? scaleWithPending(ss.scale) : isDemo() ? ss.scale || null : lichaam.scale(await health.lastWeights().catch(() => [])),
      vorm: hasPc() || isDemo() ? ss.vorm || null : sv ? await vorm.status() : null,
      vitals: hasPc() ? vitalsWithPending(ss.vitals) : isDemo() ? ss.vitals || null : lichaam.vitals(await health.lastVitals().catch(() => ({}))),
      // Apple Gezondheid (enkel in de iPhone-app) gaat voor: dan heb je je computer niet nodig
      // zonder computer: intervals.icu (je Garmin zet er je slaap, HRV en rustpols op) rechtstreeks op de gsm
      wear: { ...(ss.wear || {}), ...(health.available() ? { apple: health.connected() } : {}), ...(!hasPc() && !isDemo() ? { intervals: intervals.connected() } : {}) },
      health: health.connected() ? 'apple' : !hasPc() && !isDemo() && intervals.connected() ? 'intervals' : (ss.health || null),
      goals: isDemo() ? [] : hasPc() ? withPending(Array.isArray(ss.goals) ? ss.goals : legacyGoals(ss)) : goalsFrom(ownExtra()),
      web: {
        pc: hasPc(), demo: isDemo(), strava: sv, made: sn?.made || '', callback: NATIVE ? 'www.de3p.be' : location.hostname, standalone: standalone(),
        native: NATIVE ? health.platform() : '', apple: health.available(),
        ios: isIOS(), android: isAndroid(), canInstall: Boolean(mem.install), pairCode: s.pairCode || '', ownPlan: Boolean(s.plan),
        pcPlan: Boolean(ss.plan || sn?.state?.source), sharedStrava: Boolean(store.load().stravaShared?.id),
      },
    };
  },
  async cached() {
    return (hasPc() || hasStrava() || isDemo()) ? compose() : null;
  },
  async refresh() {
    const s = store.load();
    if (hasPc() && !isDemo() && !(Date.now() - (s.snapAt || 0) < 5 * 60e3)) await refreshSnap().catch(() => {});
    return compose();
  },
  async sync(now = false) {
    const before = new Set((await compose()).runs.map((r) => String(r.id)));
    const errors = [];
    // Bijwerken met de hand: je computer synct meteen (Strava, Body Battery…) en stuurt een nieuwe kopie
    const late = now && hasPc() && !isDemo() ? !(await askPc().catch(() => false)) : false;
    if (hasPc() && !isDemo()) await refreshSnap().catch((e) => errors.push(e.message));
    if (hasPc() && !isDemo()) await flushGoals().catch(() => {});      // nog niet bij je computer: opnieuw
    if (hasStrava() && !isDemo()) {
      const added = await stravaSync().catch((e) => { errors.push(e.message); return []; });
      if (!hasPc()) {                                // zonder computer: naam op Strava, kernblok, records en schoenen hier
        await afterStrava(added).catch((e) => errors.push(e.message));
        await vorm.backfill(now ? 8 : 20, now ? 5000 : 10000).catch(() => {});
      }
    }
    store.save({ syncedAt: Date.now() });
    const state = await compose();
    const events = state.runs.filter((r) => !before.has(String(r.id))).map((r) => ['run', r.title]);
    state.sync = { ok: !errors.length, error: errors.join(' · '), events };
    if (late && !errors.length) state.sync.late = true;     // je computer reageerde niet: het scherm zegt het
    if (errors.length) state.problems = [`Sync mislukt: ${errors.join(' · ')}`];
    return state;
  },

  // koppelen met je computer
  async pair_pc(code) {
    const pc = await pairWith(code);
    store.save({ pc, pairCode: null, demo: null, snapAt: null });
    mem.snap = undefined;
    await refreshSnap().catch(() => {});
    if (!(await snap())) throw new Error('Gekoppeld, maar je computer heeft nog niets gestuurd. Klik in het programma op Sync en probeer hier opnieuw.');
    return true;
  },
  async pc_takeover() { return takeover(); },
  async unpair_pc() {
    await takeover().catch(() => {});              // niets kwijt: wat van je computer kwam, blijft op de gsm
    store.save({ pc: null, snapAt: null });
    mem.snap = undefined;
    await store.del('snap');
    await store.delPrefix('card:pc:');
  },
  async demo(on) {
    store.save({ demo: on ? true : null });
    mem.snap = undefined;
  },
  async reset_all() {
    await store.clearAll();
    location.replace(location.pathname);
  },
  install() {
    if (!mem.install) return false;
    mem.install.prompt();
    mem.install = null;
    return true;
  },

  // Strava op de gsm
  async strava_connect(cid, csec, reconnect = false, shared = false) {
    const id = String(cid || '').trim(); const sec = shared ? '' : String(csec || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('De Client ID bestaat enkel uit cijfers.');
    if (!shared && sec.length < 20) throw new Error('Die Client Secret lijkt niet volledig. Tik op Strava eerst op "show".');
    const state = strava.newState();
    store.save({ strava: { ...(store.load().strava || {}), clientId: id, clientSecret: sec, shared, pendingState: state }, after: reconnect ? 'settings' : 'setup' });
    const url = strava.authorizeUrl(id, state);
    mem.cancel = false;
    if (!standalone()) {
      location.href = url;                       // de pagina gaat naar Strava en komt hier terug
      return new Promise(() => {});
    }
    const done = waitForCode(state);
    if (NATIVE && browser()) await browser().open({ url, presentationStyle: 'popover' });   // de app: venster in de app
    else if (isIOS()) openInSafari(url);         // iPhone-beginscherm: in Safari, je komt terug via het icoon
    else location.href = url;                    // Android: Strava opent in een apart venster
    try { await done; } finally { if (NATIVE) browser()?.close().catch(() => {}); }
    store.save({ after: null });
    return { scopeOk: true, athlete: store.load().strava?.athlete || '' };
  },
  // inloggen met Strava zonder eigen sleutel (de gedeelde dE3p-sleutel van de site)
  async strava_connect_shared(reconnect = false) {
    const id = await strava.sharedClient(true);
    if (!id) throw new Error('Inloggen met Strava kan nog niet. Maak voorlopig je eigen Strava-sleutel.');
    return api.strava_connect(id, '', reconnect, true);
  },
  strava_cancel() { mem.cancel = true; mem.recheck?.(); },
  async strava_disconnect() {
    store.save({ strava: null, lastStrava: null });
    mem.acts = undefined;
    await store.del('acts');
    await store.delPrefix('card:web:');
  },
  async strava_profile_url() {
    const id = store.load().strava?.athleteId;
    return id ? `https://www.strava.com/athletes/${id}` : 'https://www.strava.com/dashboard';
  },

  // schema (eigen schema op de gsm)
  async save_plan(plan) { store.save({ plan }); },
  // je doelen: op een gsm zonder computer hier bewaard (met computer komen ze van daar). Met id vervang je dat doel.
  async save_goal(profile, plans, gid = null) {
    const id = gid || `g${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
    if (hasPc() && !isDemo()) {                    // met computer: daar bewaren (via de brievenbus), hier meteen tonen
      const oid = `o${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
      store.save({ goalOps: [...goalOps(), { oid, op: 'save', id, profile, plans, at: new Date().toISOString() }] });
      await flushGoals().catch(() => {});
      return id;
    }
    const x = ownExtra();
    const goal = { id, profile, plans };
    const i = x.goals.findIndex((g) => g.id === id);
    if (i >= 0) x.goals[i] = goal; else x.goals.push(goal);
    store.save({ extraOwn: x });
    return id;
  },
  async delete_goal(gid) {
    if (hasPc() && !isDemo()) {
      const oid = `o${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
      store.save({ goalOps: [...goalOps(), { oid, op: 'delete', id: gid, at: new Date().toISOString() }] });
      await flushGoals().catch(() => {});
      return;
    }
    const x = ownExtra(); x.goals = x.goals.filter((g) => g.id !== gid); store.save({ extraOwn: x });
  },
  async delete_plan() { store.save({ plan: null }); },

  // Apple Gezondheid (iPhone-app): koppelen en ontkoppelen
  async apple_connect() { await health.connect(); return 'Apple Gezondheid'; },
  async apple_disconnect() { await health.disconnect(); },

  // gezondheid en kernblokken: van Apple Gezondheid (iPhone-app) of van je computer
  async garmin_recovery(force = false, days = 7) {
    if (health.connected()) {                       // zonder computer: met je eigen metingen (gewicht, bloeddruk …) erbij
      return health.recovery(days, force).then((r) => (hasPc() ? r : lichaam.withLocal(r)))
        .catch((e) => ({ error: e.message || 'Apple Gezondheid gaf geen antwoord.' }));
    }
    if (!hasPc() && !isDemo() && intervals.connected()) {
      return intervals.recovery(days, force).then((r) => lichaam.withLocal(r)).catch((e) => ({ error: e.message || 'intervals.icu gaf geen antwoord.' }));
    }
    if (force) await refreshSnap().catch(() => {});
    const rec = (await snap())?.health?.rec;
    if (!rec) return null;
    return rec.error ? rec : { ...rec, history: (rec.history || []).slice(-Math.max(1, Number(days) || 7)) };
  },
  async garmin_months(force = false) {
    if (health.connected()) return health.months(force).catch((e) => ({ error: e.message || 'Apple Gezondheid gaf geen antwoord.' }));
    if (!hasPc() && !isDemo() && intervals.connected()) return intervals.months(force).catch((e) => ({ error: e.message || 'intervals.icu gaf geen antwoord.' }));
    return (await snap())?.health?.months || null;
  },
  // je lichaam: met computer gaat het versleuteld daarheen (en staat het meteen hier), zonder computer blijft het hier
  async add_weight(kg, fat) {
    if (isDemo()) throw new Error('In het voorbeeld kan je niets bewaren.');
    const w = lichaam.parseWeight(kg, fat);
    if (!hasPc()) { lichaam.addWeight(kg, fat); return localScale(); }
    const oid = `w${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
    store.save({ weightOps: [...weightOps().filter((o) => o.op !== 'weight' || o.date !== todayIso()), { oid, op: 'weight', date: todayIso(), kg: w.kg, fat: w.fat, at: new Date().toISOString() }] });
    await flushGoals().catch(() => {});                 // lukt het nu niet, dan bij de volgende keer Bijwerken
    return scaleWithPending((await snap())?.settings?.scale);
  },
  // je weegschaal kiezen: met computer neemt die het over (Garmin/Withings moeten daar gekoppeld zijn);
  // zonder computer: Apple Gezondheid (iPhone-app) of zelf invullen
  async set_scale(brand) {
    if (isDemo()) throw new Error('In het voorbeeld kan je niets koppelen.');
    if (!hasPc()) { lichaam.setScale(brand); return localScale(); }
    const ss = (await snap())?.settings || {};
    if (brand === 'garmin' && !ss.garmin) throw new Error('Koppel eerst Garmin in dE3p op je computer.');
    if (brand === 'withings' && !ss.wear?.withings) throw new Error('Koppel eerst Withings in dE3p op je computer.');
    const oid = `b${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
    store.save({ weightOps: [...weightOps().filter((o) => o.op !== 'scale'), { oid, op: 'scale', brand: brand || '', at: new Date().toISOString() }] });
    await flushGoals().catch(() => {});
    return scaleWithPending(ss.scale);
  },
  // bloedsuiker en bloeddruk: volgen aan/uit en zelf invullen
  async set_vitals(kind, on) {
    if (!['glucose', 'bp'].includes(kind)) throw new Error('Onbekende meting.');
    if (isDemo()) throw new Error('In het voorbeeld kan je niets aanzetten.');
    if (!hasPc()) { lichaam.setTrack(kind, on); return localVitals(); }
    store.save({ weightOps: weightOps().filter((o) => !(o.op === 'vitals' && o.kind === kind)) });
    return vitalsOp({ op: 'vitals', kind, on: Boolean(on), at: nowMin() });
  },
  async add_glucose(mgdl, ctx = 'los') {
    if (isDemo()) throw new Error('In het voorbeeld kan je niets bewaren.');
    const g = lichaam.parseGlucose(mgdl, ctx);
    if (!hasPc()) { lichaam.addGlucose(mgdl, ctx); return localVitals(); }
    return vitalsOp({ op: 'glucose', ...g, at: nowMin() });
  },
  async add_bp(sys, dia, pulse) {
    if (isDemo()) throw new Error('In het voorbeeld kan je niets bewaren.');
    const b = lichaam.parseBp(sys, dia, pulse);
    if (!hasPc()) { lichaam.addBp(sys, dia, pulse); return localVitals(); }
    return vitalsOp({ op: 'bp', ...b, at: nowMin() });
  },
  async add_waist(cm) {
    if (isDemo()) throw new Error('In het voorbeeld kan je niets bewaren.');
    const w = lichaam.parseWaist(cm);
    if (!hasPc()) { lichaam.addWaist(cm); return localVitals(); }
    return vitalsOp({ op: 'waist', ...w, at: nowMin() });
  },
  async add_sweat(start, before, after, drank, secs) {
    if (isDemo()) throw new Error('In het voorbeeld kan je niets bewaren.');
    const x = lichaam.parseSweat(before, after, drank, secs);
    if (!hasPc()) { lichaam.addSweat(start, before, after, drank, secs); return localVitals(); }
    store.save({ weightOps: weightOps().filter((o) => !(o.op === 'sweat' && o.start === start)) });
    return vitalsOp({ op: 'sweat', start: String(start).slice(0, 19), ...x, at: nowMin() });
  },
  // hartslagzones van een training: van je computer (Garmin), of zonder computer uit Strava
  async hr_zones(start) {
    const z = (await snap())?.zones?.[start];
    if (z || !hasStrava() || isDemo()) return z || null;
    const own = await ownActs();
    const act = own.find((a) => a.start === String(start).slice(0, 19));
    const since = daysAgo(183);
    const maxHr = Math.max(0, ...own.filter((a) => a.date >= since && a.maxhr).map((a) => a.maxhr));
    return vorm.zones(act, Math.round(maxHr));
  },
  async fitness_session(start) {                    // je krachttraining, uitgelezen door je computer
    return (await snap())?.fitness?.[start] || null;
  },
  async garmin_feel(start) {
    const f = (await snap())?.feel?.[start];
    if (f) return f;
    throw new Error('niet op de gsm');
  },
  // kernblok: van je computer, of zonder computer hier berekend uit de tussentijden op Strava
  async run_block(id, structure) {
    const b = (await snap())?.blocks?.[String(id)];
    if (b && b.structure === structure) return b.result;
    if (!hasStrava() || isDemo() || !kern.has(structure)) throw new Error('niet op de gsm');
    const hit = await store.get(`kern:${id}`);
    if (hit && hit.structure === structure) return kern.view(hit.b);
    const res = kern.analyze(structure, await strava.getActivity(id));
    await store.put(`kern:${id}`, { structure, b: res });
    return kern.view(res);
  },

  // kaarten
  async card(path) {
    if (mem.urls.has(path)) return mem.urls.get(path);
    return remember(path, await cardBlob(path));
  },
  async make_card(id, title, target) {
    if (!hasStrava()) throw new Error('Kaarten maken kan als Strava op deze gsm gekoppeld is, of in het programma op je computer.');
    const [t, sub] = String(title || '').split(' — ');
    const blob = await makeWebCard(id, { title: t || 'Training', subtitle: sub || '', target: target || '' });
    const path = `web:${id}`;
    await store.put(`card:${path}`, blob);
    return { path, data: remember(path, blob) };
  },
  open_file(path) {                              // Delen (moet meteen in de klik gebeuren)
    const blob = mem.blobs.get(path);
    if (!blob) return undefined;
    const file = new File([blob], 'dE3p-kaart.jpg', { type: blob.type || 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] }).catch(() => {});
    const a = Object.assign(document.createElement('a'), { href: mem.urls.get(path), download: 'dE3p-kaart.jpg' });
    a.click();
    return undefined;
  },
  open_url(url) { if (NATIVE && browser()) browser().open({ url }); else window.open(url, '_blank', 'noopener'); },
  async open_manual() { api.open_url('https://www.de3p.be/download/'); },

  // lichaamsleeftijd: geboortejaar en geslacht, op deze gsm bewaard
  async set_body(birth, sex) {
    const b = String(birth || '').trim(); const x = String(sex || '').trim();
    if (!/^(19[2-9]\d|20[0-2]\d)(-\d{2}-\d{2})?$/.test(b) || !['m', 'f'].includes(x)) throw new Error('Vul je geboortejaar (bv. 1995) en man of vrouw in.');
    store.save({ body: { ...(store.load().body || {}), birth: b, sex: x } });
    return (await api.settings()).body;
  },
  async set_height(cm) {                            // je lengte voor je BMI; leeg = weer die van je computer / Apple Gezondheid
    const body = { ...(store.load().body || {}) };
    if (String(cm ?? '').trim() === '') delete body.heightCm;
    else {
      const x = Number(String(cm).replace(',', '.'));
      const v = Math.round(x < 3 ? x * 100 : x);      // 1,72 (meter) mag ook
      if (!(v >= 100 && v <= 230)) throw new Error('Vul je lengte in centimeter in, bv. 172.');
      body.heightCm = v;
    }
    store.save({ body });
    return (await api.settings()).body;
  },

  // instellingen
  async set_pref(key, value) { const s = store.load(); store.save({ prefs: { ...(s.prefs || {}), [key]: value } }); },
  async update_check() { return { current: '', latest: '', newer: false }; },
  async ai_status() { return { running: false, model: '', hasModel: false }; },
  async goal_ai() { return { ok: false }; },                // geen lokale AI op de gsm: trefwoorden
  async auto_sync() { return false; },
  async title_preview() { return { text: '' }; },
  async notion_url() { return ''; },
  async ready() {},
  async set_rename() {}, async set_card_sports() {}, async set_browser() {},
  open_folder() {}, open_data_folder() {},
  pick_folder: nope('Een kaartenmap kiezen'), make_shortcut: nope('Een snelkoppeling maken'), set_auto_sync: nope('Automatisch syncen'),
  update_install: nope('Bijwerken'), save_icon: nope('Het icoon bewaren'), title_suggest: nope('Een titel instellen'),
  title_save: nope('Een titel instellen'), title_clear: nope('Een titel instellen'), title_apply_last: nope('Een titel instellen'),
  garmin_login: nope('Garmin koppelen'), garmin_mfa: nope('Garmin koppelen'), garmin_disconnect: nope('Garmin ontkoppelen'),
  wear_connect: nope('Je horloge koppelen'),
  // intervals.icu op de gsm zonder computer (andere diensten: via je computer)
  async wear_connect_key(k, aid, key) {
    if (k !== 'intervals' || hasPc()) throw new Error('Dat koppel je in het programma op je computer.');
    await intervals.connect(aid, key);
    return 'intervals.icu';
  },
  async wear_disconnect(k) {
    if (k !== 'intervals' || hasPc()) throw new Error('Dat ontkoppel je in het programma op je computer.');
    await intervals.disconnect();
  },
};

document.body.classList.add('web');
// offline: de app opent ook zonder internet, met je laatste gegevens (web/sw.js)
if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
// Nieuwe versie op www.de3p.be? Dan vanzelf herladen. Een app op het iPhone-beginscherm blijft anders
// dagen de versie draaien waarmee ze startte (ze wordt enkel hervat, niet opnieuw geladen).
const running = (document.querySelector('script[src*="app.js?v="]')?.getAttribute('src') || '').split('v=')[1] || '';
let checkedAt = 0;
async function newVersion() {
  if (NATIVE || !running || !navigator.onLine || Date.now() - checkedAt < 5 * 60e3) return;
  checkedAt = Date.now();
  try {
    const html = await (await fetch(`./?versie=${Date.now()}`, { cache: 'no-store' })).text();
    const live = (html.match(/app\.js\?v=([\w.]+)/) || [])[1];
    if (live && live !== running) location.reload();
  } catch { /* offline: later opnieuw */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) newVersion(); });
setTimeout(newVersion, 8000);
if (NATIVE) document.body.classList.add('native', `native-${health.platform()}`);
if (standalone()) document.body.classList.add('standalone');
(async () => {
  if (await arrival() === 'handoff') return;
  await Promise.race([strava.sharedClient().catch(() => null), new Promise((r) => setTimeout(r, 1500))]);   // inloggen zonder eigen sleutel?
  window.pywebview = { api };
  window.dispatchEvent(new Event('pywebviewready'));
})();
