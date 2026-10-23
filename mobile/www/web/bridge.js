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
import { NATIVE } from './base.js';
import { pairWith, fetchSnapshot, fetchCard, normCode, sendInbox } from './crypto.js';
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
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [/^\d{4}-\d{2}-\d{2}$/.test(k) ? moveDay(k) : k, walk(x)]));
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
async function flushGoals() {
  const ops = goalOps();
  if (!ops.length || !hasPc()) return;
  await sendInbox(store.load().pc, { v: 1, ops });
}
function forgetApplied(sn) {
  const done = new Set(sn?.settings?.goalsApplied || []);
  if (done.size && goalOps().some((o) => done.has(o.oid))) store.save({ goalOps: goalOps().filter((o) => !done.has(o.oid)) });
}
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
  const cards = { ...(st.cards || {}) };
  if (hasStrava() && !isDemo()) {
    const since = daysAgo(60);
    for (const r of own) if (r.sport === 'run' && r.date >= since && !(cards[r.date] || []).length) cards[r.date] = [{ path: `web:${r.id}`, name: r.title }];
  }
  const lastSync = [st.lastSync, s.lastStrava].filter(Boolean).sort().pop() || null;
  return {
    generated: nowMin(), today,
    race: plan ? race(plan) : (st.race || null), source: plan ? 'plan' : (st.source || ''),
    schema: plan ? uiWeeks(plan, today) : (st.schema || []),
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
  for (const a of fresh) byId.set(String(a.id), a);
  const cut = daysAgo(HISTORY_WEEKS * 7 + 7);
  mem.acts = [...byId.values()].filter((a) => a.date >= cut).sort((a, b) => (b.start || b.date).localeCompare(a.start || a.date));
  await store.put('acts', mem.acts);
  store.save({ lastStrava: nowMin() });
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
    <p class="muted">${ok ? (isIOS() ? 'Tik linksboven op <b>Gereed</b>. De app maakt de koppeling vanzelf af.' : 'Sluit dit venster. De app maakt de koppeling vanzelf af.')
      : 'Ga terug naar de app en probeer nog eens.'}</p></div></main>`;
}
async function arrival() {
  if (q.has('code') || q.has('error')) {
    history.replaceState(null, '', location.pathname);
    const s = store.load().strava || {};
    const state = q.get('state') || '';
    if (state && (!s.clientSecret || (s.pendingState && s.pendingState !== state))) {
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
      body: { ...(await health.body().catch(() => ({}))), ...(ss.body || {}), ...(s.body || {}), source: s.body?.birth ? 'eigen' : (ss.body?.source || '') },   // lichaamsleeftijd
      // Apple Gezondheid (enkel in de iPhone-app) gaat voor: dan heb je je computer niet nodig
      wear: { ...(ss.wear || {}), ...(health.available() ? { apple: health.connected() } : {}) },
      health: health.connected() ? 'apple' : (ss.health || null),
      goals: isDemo() ? [] : hasPc() ? withPending(Array.isArray(ss.goals) ? ss.goals : legacyGoals(ss)) : goalsFrom(ownExtra()),
      web: {
        pc: hasPc(), demo: isDemo(), strava: sv, made: sn?.made || '', callback: NATIVE ? 'www.de3p.be' : location.hostname, standalone: standalone(),
        native: NATIVE ? health.platform() : '', apple: health.available(),
        ios: isIOS(), android: isAndroid(), canInstall: Boolean(mem.install), pairCode: s.pairCode || '', ownPlan: Boolean(s.plan),
        pcPlan: Boolean(ss.plan || sn?.state?.source),
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
  async sync() {
    const before = new Set((await compose()).runs.map((r) => String(r.id)));
    const errors = [];
    if (hasPc() && !isDemo()) await refreshSnap().catch((e) => errors.push(e.message));
    if (hasPc() && !isDemo()) await flushGoals().catch(() => {});      // nog niet bij je computer: opnieuw
    if (hasStrava() && !isDemo()) await stravaSync().catch((e) => errors.push(e.message));
    store.save({ syncedAt: Date.now() });
    const state = await compose();
    const events = state.runs.filter((r) => !before.has(String(r.id))).map((r) => ['run', r.title]);
    state.sync = { ok: !errors.length, error: errors.join(' · '), events };
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
  async unpair_pc() {
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
  async strava_connect(cid, csec, reconnect = false) {
    const id = String(cid || '').trim(); const sec = String(csec || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('De Client ID bestaat enkel uit cijfers.');
    if (sec.length < 20) throw new Error('Die Client Secret lijkt niet volledig. Tik op Strava eerst op "show".');
    const state = strava.newState();
    store.save({ strava: { ...(store.load().strava || {}), clientId: id, clientSecret: sec, pendingState: state }, after: reconnect ? 'settings' : 'setup' });
    const url = strava.authorizeUrl(id, state);
    mem.cancel = false;
    if (!standalone()) {
      location.href = url;                       // de pagina gaat naar Strava en komt hier terug
      return new Promise(() => {});
    }
    const done = waitForCode(state);
    if (NATIVE && browser()) await browser().open({ url, presentationStyle: 'popover' });   // de app: venster in de app
    else location.href = url;                    // iPhone-beginscherm: Strava opent in een apart venster
    try { await done; } finally { if (NATIVE) browser()?.close().catch(() => {}); }
    store.save({ after: null });
    return { scopeOk: true, athlete: store.load().strava?.athlete || '' };
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
  async apple_connect() { await health.connect(); return 'Apple Watch'; },
  async apple_disconnect() { await health.disconnect(); },

  // gezondheid en kernblokken: van Apple Gezondheid (iPhone-app) of van je computer
  async garmin_recovery(force = false, days = 7) {
    if (health.connected()) return health.recovery(days, force).catch((e) => ({ error: e.message || 'Apple Gezondheid gaf geen antwoord.' }));
    if (force) await refreshSnap().catch(() => {});
    const rec = (await snap())?.health?.rec;
    if (!rec) return null;
    return rec.error ? rec : { ...rec, history: (rec.history || []).slice(-Math.max(1, Number(days) || 7)) };
  },
  async garmin_months(force = false) {
    if (health.connected()) return health.months(force).catch((e) => ({ error: e.message || 'Apple Gezondheid gaf geen antwoord.' }));
    return (await snap())?.health?.months || null;
  },
  async garmin_feel(start) {
    const f = (await snap())?.feel?.[start];
    if (f) return f;
    throw new Error('niet op de gsm');
  },
  async run_block(id, structure) {
    const b = (await snap())?.blocks?.[String(id)];
    if (b && b.structure === structure) return b.result;
    throw new Error('niet op de gsm');
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
    store.save({ body: { birth: b, sex: x } });
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
  wear_connect: nope('Je horloge koppelen'), wear_disconnect: nope('Je horloge ontkoppelen'),
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
  window.pywebview = { api };
  window.dispatchEvent(new Event('pywebviewready'));
})();
