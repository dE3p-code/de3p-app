// dE3p — interface. Data en acties komen van app.py via window.pywebview.api.
import { generatePlan, DISTANCES } from './js/plan.js';
import { swimPlan, goalPlan, fitToRace, SWIM_GOALS, GOALS, LEVELS, CARDIO } from './js/extra.js';
import { parseTime, fmtTime } from './js/util.js';
import { bodyAge } from './js/bodyage.js';

const S = {
  data: null, view: 'overzicht', run: null, syncing: false, busy: '', settings: {},
  step: 1, connecting: false, setupError: '', reconnect: false, cid: '', csec: '', planInfo: '', onboarding: false,
  wkOpen: new Map(), wkFocus: '',
  garminStep: '', garminBusy: false, garminError: '', healthDays: 'dag', health: null, update: null, ai: null, autoSync: null,
  titleDraft: null, titleBusy: false, titleNow: '', phoneCode: null, phoneBusy: false, pairBusy: false,
};
const $main = document.getElementById('main');
const api = () => window.pywebview.api;
// Op de gsm (www.de3p.be) draait dit scherm in de browser, met web/bridge.js in plaats van Python.
const WEB = () => S.settings.platform === 'web';
const OS = () => (S.settings.platform === 'darwin' ? 'mac' : 'win');

// ---- helpers --------------------------------------------------------------
const DAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const DS = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
const MON = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const d8 = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const iso = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const todayIso = () => iso(new Date());
const addDays = (s, n) => { const x = d8(s); x.setDate(x.getDate() + n); return iso(x); };
const wd = (s) => (d8(s).getDay() + 6) % 7;
const mondayOf = (s) => addDays(s, -wd(s));
const nlDate = (s) => { const x = d8(s); return `${DAYS[wd(s)]} ${x.getDate()} ${MON[x.getMonth()]} ${x.getFullYear()}`; };
const nlShort = (s) => { const x = d8(s); return `${x.getDate()} ${MON[x.getMonth()]}`; };
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
const MONTHS_FULL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const ICON = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m8 12.3 2.7 2.7 5.5-5.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
};
function syncWhen(isoTs) {
  if (!isoTs) return '';
  const [d, t] = isoTs.split('T');
  const today = todayIso();
  const day = d === today ? 'vandaag' : d === addDays(today, -1) ? 'gisteren' : nlShort(d);
  return `${day} ${(t || '').slice(0, 5)}`;
}
function applyTheme() {
  const light = S.settings.theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#F6F6F5' : '#0A0A0A');   // statusbalk op de gsm
}
const themeBtn = () => {
  const light = S.settings.theme === 'light';
  const label = light ? 'Donkere modus' : 'Lichte modus';
  return `<button class="icon-btn" data-action="theme" title="${label}" aria-label="${label}">${light ? ICON.moon : ICON.sun}</button>`;
};
const km = (v, d = 1) => (Number(v) || 0).toFixed(d).replace('.', ',');
const pace = (sec) => {
  if (!sec) return '–';
  let m = Math.floor(sec / 60); let s = Math.round(sec - m * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${pad(s)}`;
};
const hms = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};
const kmOf = (str) => { const m = /(\d+(?:,\d+)?)\s*km/.exec(str || ''); return m ? parseFloat(m[1].replace(',', '.')) : null; };
const errMsg = (e) => (e && (e.message || e.toString())) || 'onbekende fout';

// ---- uitleg per trainingstype --------------------------------------------
const UITLEG = [
  { k: /versnelling/i, t: 'Versnellingen', d: 'Na je rustige kilometers 4–6 keer ±20 seconden (80–100 m) vlot versnellen tot ongeveer je 5 km-tempo: snel maar ontspannen, níét sprinten (±85–90% van je max). De eerste seconden opbouwen, de laatste uitlopen. Tussendoor 60–90 s wandelen of heel rustig joggen tot je ademhaling rustig is. Doel: soepele pas en scherpe benen, zonder vermoeidheid. Met restlast: vlakke, zachte ondergrond en stoppen bij pijn.' },
  { k: /\bIL\b|\bUL\b|inlopen|uitlopen/i, t: 'IL / UL', d: 'IL = inlopen (opwarmen), UL = uitlopen (afkoelen), allebei in rustig herstel-tempo. Ze horen bij de training: sla ze niet over.' },
  { k: /mp-finish|tempo-finish|laatste \d/i, t: 'Finish op wedstrijdtempo', d: 'De laatste kilometers van je lange duurloop op wedstrijdtempo. Je leert snel lopen op vermoeide benen, net zoals op het einde van de wedstrijd.' },
  { k: /marathonpace|\bmp-|wedstrijdtempo|marathonpace-scherpte|tune-up/i, t: 'Wedstrijdtempo', d: 'Het tempo dat je in de wedstrijd wil aanhouden. Gecontroleerd: je voelt dat je werkt, maar je zou het lang kunnen volhouden. Liever gelijkmatig dan te snel starten.' },
  { k: /tempo\/drempel|tempoduurloop|drempel|\btempo\b(?!-finish)/i, t: 'Tempo / drempel', d: '"Comfortabel hard" (±85–90% van je max hartslag): je kan nog een paar woorden zeggen, geen zinnen. Gelijkmatig lopen, niet versnellen op het einde.' },
  { k: /interval|×\s?1 ?km|kwaliteit/i, t: 'Intervallen', d: 'Herhalingen sneller dan wedstrijdtempo met herstel ertussen (bv. 90 s joggen). Loop de laatste even snel als de eerste: begin dus niet te snel.' },
  { k: /lange duurloop/i, t: 'Lange duurloop', d: 'De belangrijkste training voor lange afstanden. Rustig starten, gelijkmatig blijven, en oefen je voeding en drinken (elke 30–40 min iets).' },
  { k: /herstel/i, t: 'Herstelloop', d: 'Heel rustig om te herstellen van een zware dag: je moet vlot kunnen praten. Liever te traag dan te snel, dit is geen training om tempo te maken.' },
  { k: /rustige? duurloop|^rustig\b/i, t: 'Rustige duurloop', d: 'Je aerobe basis: gesprekstempo (±70–78% van je max hartslag). Het grootste deel van je kilometers hoort in dit tempo.' },
  { k: /fiets/i, t: 'Fiets / cross-training', d: 'Actief herstel zonder loopimpact: rustig trappen, benen doorbloeden zonder belasting.' },
];
function explain(text, max = 3) {
  const out = [];
  for (const u of UITLEG) { if (u.k.test(text) && out.length < max) out.push(u); }
  return out;
}
const howOpen = (text) => explain(text).map((u) => `<div class="how-item"><b>${esc(u.t)}</b><p>${esc(u.d)}</p></div>`).join('');
const howClosed = (text) => explain(text, 2).map((u) => `<details class="how-item"><summary>Uitleg · ${esc(u.t)}</summary><p>${esc(u.d)}</p></details>`).join('');

// ---- sporten ---------------------------------------------------------------
// S.data.acts = alle activiteiten (elke sport); S.data.runs = enkel lopen (overzicht en schema).
const ACTS = () => S.data.acts || S.data.runs;
const SPORT_TABS = [['all', 'Alles'], ['run', 'Lopen'], ['ride', 'Fietsen'], ['swim', 'Zwemmen'],
  ['walk', 'Wandelen'], ['racket', 'Racketsport'], ['other', 'Andere']];
const SPORT_ALWAYS = ['run', 'ride', 'swim'];
const sportOf = (r) => (r.sport === 'strength' ? 'other' : r.sport || 'run');   // kracht/yoga e.d. (oude gegevens) = Andere
const hasDist = (r) => ['run', 'ride', 'swim', 'walk'].includes(sportOf(r)) && r.km > 0.05;
const meters = (r) => `${Math.round(r.km * 1000).toLocaleString('nl-BE')}`;
// hoofdcijfer + eenheid, en het tweede cijfer dat bij de sport past
function mainVal(r) {
  if (sportOf(r) === 'swim' && r.km) return [meters(r), 'm'];
  return hasDist(r) ? [km(r.km, 2), 'km'] : [hms(r.time), ''];
}
function secondVal(r) {
  const s = sportOf(r);
  if (s === 'ride') return r.speed ? [km(r.speed, 1), 'km/u'] : ['–', ''];
  if (s === 'swim') return r.pace100 ? [pace(r.pace100), '/100 m'] : ['–', ''];
  if (s === 'run' || s === 'walk') return [pace(r.pace), '/km'];
  return ['', ''];                          // kracht, tennis, ...: de tijd staat al in de eerste kolom
}
const actSub = (r) => (sportOf(r) === 'run' ? (r.structure || hms(r.time)) : `${r.sportName || ''} · ${hms(r.time)}`);
const filtered = () => ACTS().filter((r) => !S.sport || S.sport === 'all' || sportOf(r) === S.sport);
const sumKm = (list) => list.filter(hasDist).reduce((a, r) => a + r.km, 0);
const sumTime = (list) => list.reduce((a, r) => a + (r.time || 0), 0);
const hoursMin = (sec) => { const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60); return h ? `${h} u ${pad(m)}` : `${m} min`; };
const nTrain = (n) => `${n} ${n === 1 ? 'training' : 'trainingen'}`;
function sportTabs() {
  const present = new Set(ACTS().map(sportOf));
  const tabs = SPORT_TABS.filter(([k]) => k === 'all' || SPORT_ALWAYS.includes(k) || present.has(k));   // tennis e.d. komt er vanzelf bij
  const cur = S.sport || 'all';
  return `<div class="seg sports" role="group" aria-label="Sport">${tabs.map(([k, l]) =>
    `<button data-sport="${k}" class="${cur === k ? 'on' : ''}" aria-pressed="${cur === k}">${l}</button>`).join('')}</div>`;
}

function cardSportsRow() {
  const st = S.settings; const on = new Set(st.cardSports || []);
  if (!st.cardChoices) return '';
  return `<div class="set-row"><div><div class="label">Recap-kaarten voor</div><div class="v">Bij elke sync een kaart van deze sporten</div>
    <small class="muted">Van andere trainingen maak je een kaart met de knop bij die training.</small>
    <div class="chips">${st.cardChoices.map((c) => `<label class="chip-check"><input type="checkbox" data-cardsport="${c.id}" ${on.has(c.id) ? 'checked' : ''}><span>${esc(c.label)}</span></label>`).join('')}</div></div></div>`;
}

// ---- afgeleide data ---------------------------------------------------------
const planRows = () => S.data.schema.flatMap((w) => w.rows.map((r) => ({ ...r, week: w })));
function cardFor(run) {
  const list = S.data.cards[run.date] || [];
  if (!list.length) return null;
  const t = run.title.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8);
  return list.find((c) => c.name.toLowerCase().replace(/[^a-z]/g, '').startsWith(t)) || list[0];
}

// ---- opstart --------------------------------------------------------------------
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  try {
    S.settings = await api().settings();
    S.sport = 'all';                  // filter geldt enkel tot je het programma sluit
    const hd = S.settings.healthDays;                 // vroeger: maand = 12 maanden, 7/30 dagen
    S.healthDays = hd === 'maand' ? 'alles' : hd === '7' ? 'wk' : hd === '30' ? 'kal' : ['dag', 'wk', 'kal', 'alles'].includes(hd) ? hd : 'dag';
    applyTheme();
    const rs = S.settings.resume;       // gsm: terug van Strava
    if (rs?.view === 'setup') {
      S.view = 'setup'; S.step = rs.step || 1; S.setupError = rs.error || ''; S.onboarding = !S.settings.web?.pc;
      render();
    } else if (!S.settings.connected) {
      S.view = 'setup';
      S.step = WEB() ? (S.settings.web?.pairCode ? 0 : 'intro') : 1;   // gsm: eerst wat dE3p voor je doet
      S.onboarding = true;              // menu en Sync pas na de laatste stap
      render();
    } else {
      if (rs?.view) S.view = SECTIONS[rs.view] ? 'overzicht' : rs.view;
      if (rs?.toast) toast(rs.toast);
      const cached = await api().cached();
      if (cached) { S.data = cached; render(); }
      if (S.settings.autosync) await doSync(true);
      else await doRefresh();
    }
    if (S.settings.selftest) await selftest();
  } catch (e) {
    toast(`Opstarten mislukt: ${errMsg(e)}`, 8000);
  }
  if (!WEB()) checkUpdate(false);
}
async function checkUpdate(force) {
  try { S.update = await api().update_check(force); } catch { return; }
  renderSide();
  if (S.view === 'instellingen') render();
}
if (window.pywebview?.api?.settings) boot();
else window.addEventListener('pywebviewready', boot);
// gsm: telkens je de app opent of weer online komt, het nieuwste ophalen (van je computer en/of Strava)
window.addEventListener('online', () => { if (booted && WEB() && S.settings.connected && !S.onboarding) doSync(true); });
let lastFocusSync = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !booted || !WEB() || !S.settings.connected || S.onboarding || S.syncing) return;
  if (Date.now() - lastFocusSync < 60e3) return;
  lastFocusSync = Date.now();
  doSync(true);
});

async function selftest() {
  await new Promise((r) => setTimeout(r, 2500));   // kaarten en kernblok laden asynchroon
  const base = { view: S.view, perf: document.querySelector('.perf-mini')?.textContent || '', garmin: (document.getElementById('sec-gezondheid')?.innerText || '').replace(/\s+/g, ' ').slice(0, 300) };
  go('trainingen');
  await new Promise((r) => setTimeout(r, 300));
  const trainingen = `${document.querySelectorAll('#main .hrow').length} rijen · ${document.querySelectorAll('#main .wkb.later').length} komende weken · ${(document.querySelector('#main .week-h')?.innerText || '').replace(/\s+/g, ' ')}`;
  let health = '';
  if (S.data && S.settings.health) {
    go('gezondheid');
    for (let k = 0; k < 120 && !S.health; k += 1) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 300));
    health = `${document.querySelectorAll('.hchart svg').length} grafieken · ${(document.querySelector('.mtiles.health')?.innerText || S.health?.rec?.error || '').replace(/\s+/g, ' ').slice(0, 400)}`;
  }
  api().ready({
    ...base, health, trainingen,
    viewNow: S.view, step: S.step, connected: !!S.settings.connected, legacy: !!S.settings.legacy,
    runs: S.data?.runs?.length || 0, weeks: (S.data?.schema || []).map((w) => w.num), source: S.data?.source ?? null,
    problems: S.data?.problems || [], heading: document.querySelector('#main h1')?.textContent || '',
    fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    logo: document.querySelector('.logo')?.naturalWidth > 0, cardImg: !!document.querySelector('#main img[src^="data:"]'),
  });
}

async function doRefresh() {
  S.busy = 'Bijwerken…';
  renderSide();
  try {
    S.data = await api().refresh();
    render();
  } catch (e) {
    toast(`Bijwerken mislukt: ${errMsg(e)}`, 8000);
    if (!S.data && !isFree()) $main.innerHTML = `<div class="alert">Kon de gegevens niet laden: ${esc(errMsg(e))}</div>`;
  } finally {
    S.busy = '';
    renderSide();
  }
}

async function doSync(auto = false) {
  if (S.syncing) return;
  if (WEB() && !navigator.onLine) {                     // gsm zonder internet: rustig je laatste gegevens tonen
    if (!S.data) S.data = await api().cached();
    if (!auto) toast('Je bent offline: je ziet je laatste gegevens.');
    render();
    return;
  }
  S.syncing = true;
  renderSide();
  if (!S.data && !isFree()) render();
  try {
    S.data = await api().sync();
    if (WEB()) S.settings = await api().settings();      // gsm: tijd van de nieuwste kopie
    if (WEB() && S.health && !S.health.rec?.error) {       // en de nieuwe gezondheid, zonder laadscherm
      const m = S.health.days;
      try {
        const rec = m === 'alles' ? await api().garmin_months(false) : await api().garmin_recovery(false, DAY_BACK);
        if (m !== 'alles' && rec && !rec.error) S.glance = rec;
        if (rec && !rec.error) S.health = { days: m, rec };
      } catch { /* de vorige blijven staan */ }
    }
    render();
    const ev = S.data.sync?.events || [];
    const runs = ev.filter(([k]) => k === 'run').length;
    toast(!S.data.sync?.ok ? 'Bijwerken mislukt, zie bovenaan' : runs ? `${runs} nieuwe ${runs === 1 ? 'run' : 'runs'} verwerkt` : 'Alles is bijgewerkt');
    if (!auto && runs) go('overzicht');
  } catch (e) {
    toast(`Bijwerken mislukt: ${errMsg(e)}`, 8000);
  } finally {
    S.syncing = false;
    renderSide();
  }
}

// ---- weergave ----------------------------------------------------------------------
const FREE = { setup: () => vSetup(), instellingen: () => vInstellingen(), planform: () => vPlanForm(), extraform: () => vExtraForm(), goalform: () => vGoalForm(),
  doelen: () => vDoelen() };
const isFree = () => S.view in FREE;

const ALIAS = { schema: 'trainingen', historie: 'trainingen' };
// alles staat op één pagina: 'trainingen' en 'gezondheid' zijn stukken ervan
const SECTIONS = { trainingen: 'sec-trainingen', gezondheid: 'sec-gezondheid' };
function go(view, run = null) {
  let v = ALIAS[view] || view;
  if (v === 'goalform' && S.view !== 'goalform') S.gq = null;
  if (v === 'goalform' && !S.ai && !WEB()) aiOn().then(() => { if (S.view === 'goalform') render(); });   // lokale AI? dan meer uitleg bij de eerste vraag
  if (v === 'doelen' && ['instellingen', 'overzicht'].includes(S.view)) S.doelenBack = S.view;   // terug naar waar je vandaan kwam
  if (v === 'instellingen' && S.view === 'instellingen') v = 'overzicht';     // tandwiel nog eens = terug
  const sec = SECTIONS[v];
  const target = sec ? 'overzicht' : v;
  if (S.view === 'overzicht' && target !== 'overzicht') S.homeY = $main.scrollTop;
  const back = S.view !== 'overzicht' && target === 'overzicht' && !sec;
  S.view = target;
  S.run = run;
  render();
  if (sec) scrollToSec(sec);
  else $main.scrollTop = back ? (S.homeY || 0) : 0;
}
function scrollToSec(id) {
  const el = document.getElementById(id);
  if (el) $main.scrollTop += el.getBoundingClientRect().top - $main.getBoundingClientRect().top - 12;
}
const scrollToNow = () => scrollToSec('sec-trainingen');

function renderSide() {
  document.body.classList.toggle('onboarding', S.onboarding);
  document.getElementById('gearBtn')?.classList.toggle('on', ['instellingen', 'planform', 'doelen', 'goalform', 'extraform'].includes(S.view));
  const btn = document.getElementById('syncBtn');
  btn.disabled = S.syncing || !S.settings.connected;
  btn.innerHTML = S.syncing ? '<span class="spinner"></span>Bezig…' : `${WEB() && S.settings.web?.pc ? PC_ICON : ICON.refresh}<span>Bijwerken</span>`;
  btn.title = WEB() && S.settings.web?.pc ? 'Haal de nieuwste gegevens van je computer' : 'Haal je nieuwste trainingen op';
  const when = syncWhen(S.data?.lastSync || S.settings.lastSync);
  document.getElementById('lastSync').innerHTML = S.busy ? esc(S.busy) : when ? `Bijgewerkt<b>${esc(when)}</b>` : '';
  const un = document.getElementById('updateNote');
  if (un) {
    un.hidden = !S.update?.newer || S.onboarding;
    un.dataset.action = S.settings.canUpdate ? 'update-install' : 'website';
    un.innerHTML = S.update?.newer ? `Nieuwe versie ${esc(S.update.latest)}<b>${S.settings.canUpdate ? 'Nu bijwerken' : 'Download'}</b>` : '';
  }
}

function render() {
  renderSide();
  if (isFree()) {
    $main.innerHTML = `<div class="page">${FREE[S.view]()}</div>`;
    const pf = $main.querySelector('form[data-form="plan"]');
    if (pf) updatePacePreview(pf);
    if (S.view === 'instellingen' && !WEB()) { refreshTitleNow(); loadAi(); loadAutoSync(); }
    return;
  }
  if (!S.data) {
    $main.innerHTML = `<div class="loading">${S.syncing ? '<span class="spinner"></span> Je runs worden opgehaald…' : 'Laden…'}</div>`;
    return;
  }
  const views = { overzicht: vHome, run: vRun };
  const alerts = (S.data.problems || []).map((p) => `<div class="alert">${esc(p)}</div>`).join('');
  $main.innerHTML = `<div class="page">${alerts}${(views[S.view] || vHome)()}</div>`;
  loadCards();
  loadPerf();
  loadGarmin();
  loadHealth();
  centerDayStrip();
  centerWeekStrip();
  watchStale();
}
// datum aantikken: kalender openen (iPhone/Android doen dat zelf, de computer via showPicker)
// een week open- of dichtgeklapt: onthouden zolang het venster open is
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d?.dataset?.wk) S.wkOpen.set(d.dataset.wk, d.open);
}, true);
document.addEventListener('click', (e) => {
  // uitleg-knopje: sluit als je ergens anders tikt
  document.querySelectorAll('details.tr-info[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  const p = e.target.closest?.('[data-hpick]');
  if (p) { try { p.showPicker(); } catch { /* opent al vanzelf */ } }
});
// strook met weken: de laatst gekozen week (of deze week) in het midden
function centerWeekStrip() {
  const strip = document.getElementById('wstrip');
  const on = strip?.querySelector(`[data-wkgo="${S.wkFocus || ''}"]`) || strip?.querySelector('.wchip.now');
  if (on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2;
  // pijltjes (gsm): grijs aan het begin of einde van de maand
  const upd = () => {
    const nav = strip?.parentElement; if (!nav) return;
    const [l, r] = nav.querySelectorAll('[data-wstrip]');
    if (l) l.disabled = strip.scrollLeft <= 2;
    if (r) r.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
  };
  if (strip) { strip.onscroll = upd; upd(); }
}
// strook met dagen: de gekozen dag in het midden (zonder de pagina te verschuiven)
function centerDayStrip() {
  const strip = document.getElementById('dstrip');
  const on = strip?.querySelector('.dchip.on');
  if (on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2;
}

// ---- kernblok: wat je echt liep naast het doel ("5 km @ 4:28 · doel 4:20") ----------
// "@ 4:20", maar ook "op MP-gevoel ±4:40" (zelfde regel als blocks.py)
const BLOCK_RE = /\d+\s*[×x]\s*\d+(?:[.,]\d+)?\s*(?:km|m)\b[^@+]*?\s*(?:@|\bop\b|\baan\b)[^\d±+,;()]{0,30}?±?\s*\d{1,2}:\d{2}|\d+(?:[.,]\d+)?\s*km\s*(?:@|\bop\b|\baan\b)[^\d±+,;()]{0,30}?±?\s*\d{1,2}:\d{2}/i;
const hasBlock = (s) => BLOCK_RE.test(s || '');
function blockSource(r, plan) {
  if (hasBlock(r.structure)) return r.structure;
  if (plan && !plan.done && hasBlock(plan.structure)) return plan.structure;
  return '';
}
function perfPanel(b) {
  const d = Math.round(b.delta);
  const big = Math.abs(b.delta) <= 3 ? 'Op doel' : `${d > 0 ? '+' : '−'}${Math.abs(d)} s`;
  return `<div class="label">Hoe liep het kernblok? · ${esc(b.where)}</div>
    <div class="perf-grid">
      <div><div class="big">${esc(b.paceTxt)}<small>/km</small></div><div class="muted small">gelopen · ${esc(b.label)} in ${esc(b.timeTxt)}</div></div>
      <div><div class="big">${esc(b.targetTxt)}<small>/km</small></div><div class="muted small">doel</div></div>
      <div><div class="big">${big}</div><div class="muted small">${Math.abs(b.delta) <= 3 ? 'binnen 3 s/km van je doel' : `per km ${d > 0 ? 'trager' : 'sneller'} dan doel`}</div></div>
      <div><div class="big">${b.hr ? b.hr : '–'}<small>bpm</small></div><div class="muted small">hartslag in het blok</div></div>
    </div>`;
}
function loadPerf() {
  document.querySelectorAll('[data-perf]').forEach(async (el) => {
    try {
      const b = await api().run_block(Number(el.dataset.perf), el.dataset.structure);
      if (!el.isConnected) return;
      if (!b || !b.found) {
        el.innerHTML = el.dataset.mini !== undefined ? '' : '<div class="label">Hoe liep het kernblok?</div><div class="muted small" style="margin-top:8px">Niet terug te vinden in je tussentijden (bij intervallen: druk op je horloge een ronde per herhaling).</div>';
        return;
      }
      el.innerHTML = el.dataset.mini !== undefined
        ? `Kernblok: <b>${esc(b.short)}/km</b> · doel ${esc(b.targetTxt)} · ${esc(b.verdict)}`
        : perfPanel(b);
    } catch {
      if (el.isConnected) el.remove();
    }
  });
}

const CARD_URL = new Map();
function loadCards() {
  document.querySelectorAll('img[data-card]').forEach(async (img) => {
    const hit = CARD_URL.get(img.dataset.card);
    if (hit) { img.src = hit; return; }
    try { img.src = await api().card(img.dataset.card); CARD_URL.set(img.dataset.card, img.src); } catch { img.replaceWith(Object.assign(document.createElement('div'), { className: 'card-empty', textContent: 'Kaart niet gevonden' })); }
  });
}

// ---- de pagina: overzicht, gezondheid en trainingen onder elkaar --------------------------
function vHome() {
  return `${vOverzicht()}
    <section class="sec" id="sec-gezondheid">${vGezondheid()}</section>
    <section class="sec" id="sec-trainingen">${vTrainingen()}</section>`;
}
function greeting() {
  const h = new Date().getHours();
  const first = String(S.settings.athlete || '').trim().split(/\s+/)[0];
  return `${h < 6 ? 'Goeienacht' : h < 12 ? 'Goeiemorgen' : h < 18 ? 'Goeiemiddag' : 'Goeienavond'}${first ? `, ${first}` : ''}`;
}

// ---- overzicht ------------------------------------------------------------------------
// wat er vandaag moet gebeuren (uit je herstel en je schema), meteen onder de begroeting
function todayTip() {
  const h = [...(S.glance?.history || [])].sort((a, b) => a.date.localeCompare(b.date));
  const t = h[h.length - 1];
  return t && t.date === todayIso() ? tipLine(advice(t)) : '';
}
function vOverzicht() {
  const today = S.data.today;
  // bovenaan enkel: de begroeting, wat je vandaag doet, en hoe het met je gaat (de rest staat bij Gezondheid en Trainingen)
  const fresh = WEB() && S.settings.web?.made ? ` · bijgewerkt ${syncWhen(S.settings.web.made)}${navigator.onLine ? '' : ' · offline'}` : '';
  const tip = todayTip();
  return `<div class="head"><div><div class="label">${esc(cap(nlDate(today)))}${esc(fresh)}</div><h1 class="title">${esc(greeting())}</h1></div></div>
    ${tip ? `<div class="hello-tip">${tip}</div>` : ''}
    ${glance()}`;
}

// kilometers per week: lopen, fietsen en zwemmen op elkaar gestapeld, met de km per sport in zijn kleur ernaast
function chart(monday, cur) {
  const sel = !S.sport || S.sport === 'all' ? KM_SPORTS : KM_SPORTS.filter((sp) => sp === S.sport);
  if (!sel.length) return '';
  const narrow = !window.matchMedia?.('(min-width: 641px)').matches;
  const wide = window.matchMedia?.('(min-width: 901px)').matches;
  const n = narrow ? 6 : 8;
  const all = ACTS();
  const weeks = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const m0 = addDays(monday, -7 * i);
    const inW = all.filter((r) => r.date >= m0 && r.date <= addDays(m0, 6));
    weeks.push({ m0, parts: sel.map((sp) => [sp, sumKm(inW.filter((r) => sportOf(r) === sp))]) });
  }
  const used = sel.filter((sp) => weeks.some((w) => w.parts.find(([s]) => s === sp)[1] > 0));
  const target = sel.includes('run') ? cur?.target || 0 : 0;
  if (!used.length && !target) return '';
  const tot = (w) => w.parts.reduce((x, [, k]) => x + k, 0);
  const top = Math.max(10, target, ...weeks.map(tot));
  const W = wide ? 1100 : narrow ? 420 : 640; const H = wide ? 210 : narrow ? 250 : 220;
  const base = H - 28; const slot = W / n; const hw = wide ? 22 : narrow ? 15 : 17; const room = base - 30;
  const y = (v) => base - (v / top) * room;
  const bars = weeks.map((w, i) => {
    const cx = slot * (i + 0.5) - (used.length > 1 ? hw * 0.5 : 0); const isCur = w.m0 === monday;
    let acc = 0; const segs = []; const labels = [];
    for (const [sp, k] of w.parts) {
      if (k <= 0) continue;
      const y1 = y(acc + k); const y0 = y(acc); acc += k;
      const gap = segs.length ? 2 : 0;                                // 2px tussen de stukken
      segs.push(`<rect class="seg ${sp}${isCur ? ' cur' : ''}" x="${cx - hw}" y="${y1}" width="${2 * hw}" height="${Math.max(1, y0 - y1 - gap)}" rx="4"><title>${XS[sp]}: ${km(k)} km</title></rect>`);
      labels.push({ sp, k, y: (y0 + y1) / 2 + 4 });
    }
    // labels naast de balk, in de kleur van de sport; minstens 13px uit elkaar (onderaan beginnen)
    let prev = Infinity;
    const lab = used.length > 1 ? labels.map((l) => { const ly = Math.min(l.y, prev - 13); prev = ly;
      return `<text class="lbl ${l.sp}" x="${cx + hw + 6}" y="${ly}">${Math.round(l.k)}</text>`; }).join('') : '';
    const t = tot(w);
    return `${isCur && target ? `<rect class="goal" x="${cx - hw - 3}" y="${y(target)}" width="${2 * hw + 6}" height="${base - y(target)}" rx="6"/>` : ''}
      ${segs.join('')}${lab}
      <text class="v" x="${cx}" y="${y(Math.max(t, isCur ? target : 0)) - 8}" text-anchor="middle">${Math.round(t)}</text>
      <text class="${isCur ? 'cur' : ''}" x="${slot * (i + 0.5)}" y="${H - 6}" text-anchor="middle">${esc(nlShort(w.m0))}</text>`;
  }).join('');
  const legend = used.length > 1 || sel.length === 1
    ? used.map((sp) => `<span class="spk ${sp}">${SPORT_ICON[sp]}${XS[sp]}</span>`).join('') : `<span class="spk run">${SPORT_ICON.run}${XS.run}</span>`;
  return `<section class="panel ov-chart"><div class="ov-h"><div class="label">Kilometers per week</div>
      <span class="ov-h-v ch-legend">${legend}${target ? '<span class="spk-t">┆ = gepland lopen</span>' : ''}</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Kilometers per week, per sport"><line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"/>${bars}</svg></section>`;
}

// ---- scherm: trainingen (je schema en wat je deed, samen per week) -------------------------
function doneRow(r, plan) {
  const card = cardFor(r);
  const [v1, u1] = mainVal(r); const [v2, u2] = secondVal(r);
  const planned = plan && !plan.rest && plan.title && plan.title !== r.title ? `Gepland: ${plan.title}` : '';
  return `<div class="hrow${sportOf(r) === 'run' && isRaceDay(r.date) ? ' race' : ''}" data-run="${r.id}">
    <div class="d"><b>${d8(r.date).getDate()}</b>${DS[wd(r.date)]}</div>
    <div style="min-width:0"><div class="t">${esc(r.title)}</div><div class="s">${esc(planned || actSub(r))}</div></div>
    <div class="v">${esc(v1)}<small>${u1}</small></div>
    <div class="v">${esc(v2)}<small>${u2}</small></div>
    <div class="v">${r.hr ? Math.round(r.hr) : '–'}<small>bpm</small></div>
    ${card ? '<div class="cardmark yes">Kaart ✓</div>' : WEB() && !(S.settings.web?.strava && sportOf(r) === 'run') ? '<div></div>'
      : `<button class="cardmark make" data-make="${r.id}" title="Maak de recap-kaart van deze training">Maak kaart</button>`}</div>`;
}
// icoontjes per sport (in de kleur van die sport), voor de kilometers per week
const SVG = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SPORT_ICON = {
  run: SVG('<circle cx="14.5" cy="4.5" r="2"/><path d="M7 21l3.5-6.5 3 2.5V21"/><path d="M5 11.5l3.5-3.5h5l2.5 3.5 3 1"/><path d="M10.5 14.5L13 8"/>'),
  ride: SVG('<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5L9 9h6.5l3 7.5"/><path d="M9 9l3 7.5h-6.5M14 6h2.5"/>'),
  swim: SVG('<circle cx="16" cy="6.5" r="2"/><path d="M3 18c1.8 0 1.8-1.5 3.6-1.5s1.8 1.5 3.6 1.5 1.8-1.5 3.6-1.5 1.8 1.5 3.6 1.5 1.8-1.5 3.6-1.5"/><path d="M6 13.5l4.5-3.5 3 2.5"/>'),
};
const KM_SPORTS = ['run', 'ride', 'swim'];
// waar je naartoe traint: je wedstrijd en het einde van elk doel. Die vallen op in Trainingen (goud).
const FLAG = '<svg class="ev-i" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>';
const TARGET = '<svg class="ev-i" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>';
function targets() {
  const out = [];
  const r = S.data?.race;
  if (r?.date) out.push({ date: r.date, kind: 'race', title: r.name || 'Wedstrijd', sub: r.goal ? `doel ${r.goal}` : '' });
  for (const g of goalsList()) out.push({ date: goalSpan(g)[1], kind: 'goal', title: goalName(g), sub: 'doel klaar' });
  return out;
}
const isRaceDay = (date) => Boolean(S.data?.race?.date) && S.data.race.date === date;
function planRow(p, today) {
  const day = `<div class="d"><b>${d8(p.date).getDate()}</b>${DS[wd(p.date)]}</div>`;
  if (p.rest) return `<div class="hrow plan rest">${day}<div class="t">Rust</div></div>`;
  const st = p.done ? 'done' : p.date < today ? 'missed' : p.date === today ? 'today' : 'planned';
  const race = isRaceDay(p.date);
  const chip = race && st !== 'done' ? `<span class="chip race">${FLAG}Wedstrijd</span>` : st === 'missed' ? '<span class="chip missed">Gemist</span>' : st === 'today' ? '<span class="chip today">Vandaag</span>' : st === 'done' ? '<span class="chip done">✓</span>' : '';
  const k = kmOf(p.km);
  const pace = p.pace && p.pace !== '—' && !(p.structure || '').includes(p.pace) ? p.pace : '';   // tempo niet dubbel
  return `<div class="hrow plan ${st}${race ? ' race' : ''}">${day}
    <div style="min-width:0"><div class="t">${esc(p.title)}</div>
      ${p.structure || pace ? `<div class="s">${esc([p.structure, pace].filter(Boolean).join(' · '))}</div>` : ''}
      ${p.details && st !== 'missed' ? `<div class="x">${esc(p.details)}</div>` : ''}
      ${st === 'today' ? howClosed(`${p.title} ${p.structure}`) : ''}</div>
    <div class="v">${k ? `${km(k)}<small>km</small>` : ''}</div><div></div><div></div>
    <div class="st">${chip}</div></div>`;
}
// 'Uitleg' bij een geplande zwemtraining: de training stap voor stap
function extraHow(x) {
  const title = cap(x.title.replace(/^(Zwemmen|Lopen|Fietsen) · /, ''));
  if (x.sport === 'swim') {
    const steps = String(x.detail || '').split(' · ').filter(Boolean);
    return steps.length > 1 ? `<details class="how-item"><summary>Uitleg · ${esc(title)}</summary>
      <ol class="ex-list">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <p>Rustig tempo = je kan na elke baan rustig ademen. Te zwaar? Neem wat meer rust tussen de stukken.</p></details>` : '';
  }
  return '';
}
// een geplande training van een doel in de lijst
function extraRow(x, today) {
  const st = x.date < today ? 'missed' : x.date === today ? 'today' : 'planned';
  const chip = st === 'missed' ? '<span class="chip missed">Gemist</span>' : st === 'today' ? '<span class="chip today">Vandaag</span>' : '';
  return `<div class="hrow plan extra ${st}"><div class="d"><b>${d8(x.date).getDate()}</b>${DS[wd(x.date)]}</div>
    <div style="min-width:0"><div class="t"><span class="xs-tag ${x.sport}">${XS[x.sport]}</span>${esc(cap(x.title.replace(/^(Zwemmen|Lopen|Fietsen) · /, '')))}</div>
      ${st === 'missed' ? '' : `<div class="x">${esc(x.detail)}</div>${extraHow(x)}`}</div>
    <div class="v">${x.meters ? `${nlNum(x.meters)}<small>m</small>` : `${x.minutes}<small>min</small>`}</div><div></div><div></div>
    <div class="st">${chip}</div></div>`;
}

function vTrainingen() {
  const D = S.data; const today = D.today;
  const notion = D.source === 'notion';
  const usePlan = !S.sport || S.sport === 'all' || S.sport === 'run';
  const acts = filtered();
  const plan = usePlan ? planRows() : [];
  const planBy = new Map(plan.map((p) => [p.date, p]));
  const extras = extraRows().filter((x) => !S.sport || S.sport === 'all' || S.sport === x.sport);
  const extraBy = new Map();
  for (const x of extras) { if (!extraBy.has(x.date)) extraBy.set(x.date, []); extraBy.get(x.date).push(x); }
  const actBy = new Map();
  for (const r of acts) { if (!actBy.has(r.date)) actBy.set(r.date, []); actBy.get(r.date).push(r); }
  const weekOf = new Map(usePlan ? D.schema.filter((w) => w.rows.length).map((w) => [mondayOf(w.rows[0].date), w]) : []);
  const cur = mondayOf(today);

  // één week: per dag wat je deed, of anders wat er gepland stond
  const week = (m, { current = false, future = false } = {}) => {
    const w = weekOf.get(m);
    const rows = [];
    let n = 0;
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(m, i);
      const runs = (actBy.get(date) || []).slice().sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      const p = planBy.get(date);
      const ex = extraBy.get(date) || [];
      const day = [];
      runs.forEach((r) => { day.push(doneRow(r, sportOf(r) === 'run' ? p : ex.find((x) => x.sport === sportOf(r)) || null)); n += 1; });
      const ran = runs.some((r) => sportOf(r) === 'run');
      if (p && (p.rest ? !runs.length && !ex.length : !ran) && (!p.rest || current || future)) day.push(planRow(p, today));
      ex.filter((x) => !x.done).forEach((x) => day.push(extraRow(x, today)));
      // meer dan één training op een dag: de datum enkel bij de eerste, zo zie je wat bij elkaar hoort
      day.forEach((h, j) => rows.push(j ? h.replace('<div class="hrow', '<div class="hrow cont').replace(/<div class="d">.*?<\/div>/, '<div class="d"></div>') : h));
    }
    const inWeek = acts.filter((r) => r.date >= m && r.date <= addDays(m, 6));
    const runKm = sumKm(inWeek.filter((r) => sportOf(r) === 'run'));   // het schema is een loopschema
    const label = w ? `${w.label}${w.marker ? ` · ${w.marker}` : ''}` : `${nlShort(m)} – ${nlShort(addDays(m, 6))}`;
    const title = w ? `Week ${w.num}${w.total ? ` <span class="muted">van ${w.total}</span>` : ''}` : (current ? 'Deze week' : nTrain(n));
    // km per sport met een icoontje (lopen tegenover je weekdoel), zodat fietsen niet bij je loopkilometers lijkt te horen
    const parts = KM_SPORTS.map((sp) => [sp, sumKm(inWeek.filter((r) => sportOf(r) === sp))]).filter(([sp, k]) => k > 0 || (sp === 'run' && w));
    const right = future ? (w?.target ? `<span class="spk run">${SPORT_ICON.run}${km(w.target, 0)} km gepland</span>` : '')
      : `${parts.map(([sp, k]) => `<span class="spk ${sp}" title="${XS[sp]}">${SPORT_ICON[sp]}${sp === 'run' && w ? `${km(runKm)}${w.target ? ` / ${km(w.target, 0)}` : ''}` : km(k)} km</span>`).join('')}${
        w ? '' : `<span class="spk-t">${hoursMin(sumTime(inWeek))}</span>`}`;
    const ev = targets().find((e) => e.date >= m && e.date <= addDays(m, 6));
    const evTag = ev ? `<span class="wk-tag ${ev.kind}">${ev.kind === 'race' ? FLAG : TARGET}${esc(ev.kind === 'race' ? ev.title : `Doel: ${ev.title}`)}</span>` : '';
    const head = `<div class="week-h ${current ? 'cur' : ''}${ev ? ` ev-${ev.kind}` : ''}"><div><div class="label">${esc(label)}</div><h2>${title}</h2>${evTag}</div>
      <div class="wk-r"><span class="soft">${right}</span><i class="wk-chev" aria-hidden="true"></i></div></div>`;
    const body = `<div class="wk-body">${w?.focus && current ? `<div class="focus">${esc(w.focus)}</div>` : ''}${rows.join('') || '<div class="muted small empty-week">Nog niets deze week.</div>'}</div>`;
    return { head, body };
  };

  // één tijdlijn: bovenaan het oudste, onderaan je komende weken; het scherm opent bij deze week
  const mondays = [...new Set([...acts.map((r) => mondayOf(r.date)), ...plan.map((p) => mondayOf(p.date)), ...extras.map((x) => mondayOf(x.date)), cur])].sort();
  // één strook met al je weken (zoals de dagen bij Gezondheid): ‹ › = vorige/volgende week, tik = die week.
  // Eronder staat enkel de gekozen week (standaard deze week), zodat het nooit druk wordt.
  const has = new Set(mondays);
  const allWeeks = [];
  for (let m = mondays[0]; m <= mondays[mondays.length - 1]; m = addDays(m, 7)) allWeeks.push(m);   // ook lege weken (pauze)
  const focus = has.has(S.wkFocus) ? S.wkFocus : cur;
  const withData = allWeeks.filter((m) => has.has(m));
  const fi = withData.indexOf(focus);
  const evs = targets();
  const kmOfWeek = (m) => sumKm(acts.filter((r) => r.date >= m && r.date <= addDays(m, 6) && sportOf(r) === 'run'));
  const big = Math.max(1, ...allWeeks.map((m) => Math.max(kmOfWeek(m), weekOf.get(m)?.target || 0)));
  const chip = (m) => {
    const w = weekOf.get(m);
    const n = acts.filter((r) => r.date >= m && r.date <= addDays(m, 6)).length;
    const k = kmOfWeek(m); const tgt = w?.target || 0;
    const sub = m > cur ? (tgt ? `${km(tgt, 0)} km` : '') : k ? `${km(k, 0)} km` : n ? `${n}×` : 'rust';
    const fill = m > cur ? tgt / big : k / big;
    const ok = has.has(m);
    const ev = evs.find((e) => e.date >= m && e.date <= addDays(m, 6));
    const evL = ev ? `${ev.kind === 'race' ? FLAG : TARGET}${ev.kind === 'race' ? 'Wedstrijd' : 'Doel'}` : '';
    return `<button class="wchip${m === cur ? ' now' : ''}${m > cur ? ' later' : ''}${m === focus ? ' on' : ''}${ev ? ` ev ${ev.kind}` : ''}" ${ok ? `data-wkgo="${m}"` : 'disabled'}
      aria-pressed="${m === focus}" aria-label="${esc(`${w ? `Week ${w.num}, ` : ''}${nlShort(m)} tot ${nlShort(addDays(m, 6))}${sub ? `, ${sub}` : ''}${ev ? `, ${ev.title}` : ''}`)}">
      <span class="wl">${evL || (m === cur ? 'Nu' : w ? `Wk ${w.num}` : '')}</span><b>${esc(nlShort(m))}</b><small>${/km/.test(sub) ? `<span class="spk run">${SPORT_ICON.run}</span>` : ''}${esc(sub)}</small>
      <i class="wbar"><i style="width:${Math.round(Math.min(1, fill) * 100)}%"></i></i></button>`;
  };
  // je wedstrijd en doelen die nog komen: goud, met hoeveel dagen nog
  const left = (d) => { const n = Math.round((d8(d) - d8(today)) / 864e5); return n > 1 ? `nog ${n} dagen` : n === 1 ? 'morgen' : 'vandaag'; };
  const upcoming = evs.filter((e) => e.date >= today).sort((x, y) => x.date.localeCompare(y.date)).slice(0, 3);
  const evHtml = upcoming.length ? `<div class="wk-evs">${upcoming.map((e) => `<button class="wk-ev ${e.kind}" data-wkgo="${mondayOf(e.date)}">${e.kind === 'race' ? FLAG : TARGET}
      <b>${esc(e.title)}</b><span>${esc([`${DS[wd(e.date)].toLowerCase()} ${nlShort(e.date)}`, left(e.date), e.sub].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>` : '';
  const picker = `${evHtml}<div class="wk-nav2">
      <button class="icon-btn" data-wkstep="${withData[fi - 1] || ''}" ${fi > 0 ? '' : 'disabled'} aria-label="Vorige week">${ICON.left}</button>
      <div class="wstrip" id="wstrip">${allWeeks.map(chip).join('')}</div>
      <button class="icon-btn" data-wkstep="${withData[fi + 1] || ''}" ${fi >= 0 && fi < withData.length - 1 ? '' : 'disabled'} aria-label="Volgende week">${ICON.right}</button></div>`;
  const list = picker + [focus].map((m) => {
    const w = week(m, { current: m === cur, future: m > cur });
    const open = S.wkOpen.has(m) ? S.wkOpen.get(m) : true;                  // de gekozen week staat open
    return `<details class="wkb${m === cur ? ' now' : m > cur ? ' later' : ''}" id="${m === cur ? 'nu' : `w-${m}`}" data-wk="${m}"${open ? ' open' : ''}>
        <summary>${w.head}</summary>${w.body}</details>`;
  }).join('');
  const cta = !D.schema.length && !notion && !goalsList().length
    ? `<section class="panel cta-row"><div><b>Heb je een doel?</b><div class="muted small">Een wedstrijd, fitter worden of beter zwemmen: dE3p maakt het schema. Meerdere doelen tegelijk kan ook.</div></div>
        <button class="btn primary" data-action="goal-new">Stel een doel in</button></section>` : '';
  const label = D.schema.length
    ? (notion ? 'Je schema uit Notion en je trainingen' : `${D.race?.name || 'Jouw schema'}${D.race ? ` · ${nlShort(D.race.date)}` : ''}`)
    : `${nTrain(ACTS().length)} · laatste 6 maanden`;
  return `<div class="sec-h"><div><div class="label">${esc(label)}</div><h2 class="sec-t">Trainingen</h2></div>
    <button class="link-btn" data-view="doelen">Je doelen ›</button></div>
    ${sportTabs()}${cta}${chart(cur, weekOf.get(cur))}${list}`;
}

// ---- scherm: één training -------------------------------------------------------------
function vRun() {
  const r = ACTS().find((x) => String(x.id) === String(S.run));
  if (!r) return '<button class="back" data-view="overzicht">← Terug</button><div class="alert">Training niet gevonden.</div>';
  const isRun = sportOf(r) === 'run';
  const plan = isRun ? planRows().find((p) => p.date === r.date && !p.rest) : null;
  const card = cardFor(r);
  const full = `${r.title}${r.structure ? ` — ${r.structure}` : ''}`;
  const hr = [['Gem. HR', r.hr ? Math.round(r.hr) : '–'], ['Max HR', r.maxhr ? Math.round(r.maxhr) : '–']];
  const sp = sportOf(r);
  const stats = sp === 'run' ? [['Afstand', `${km(r.km, 2)} km`], ['Looptijd', hms(r.time)], ['Tempo', `${pace(r.pace)}/km`],
    ...hr, ['Cadans', r.cadence ? Math.round(r.cadence) : '–'], ['Hoogte', `${Math.round(r.elev || 0)} m`], ['Dag', DAYS[wd(r.date)]]]
    : sp === 'ride' ? [['Afstand', `${km(r.km, 2)} km`], ['Tijd', hms(r.time)], ['Snelheid', r.speed ? `${km(r.speed, 1)} km/u` : '–'],
      ...hr, ['Vermogen', r.watts ? `${Math.round(r.watts)} W` : '–'], ['Hoogte', `${Math.round(r.elev || 0)} m`], ['Dag', DAYS[wd(r.date)]]]
    : sp === 'swim' ? [['Afstand', `${meters(r)} m`], ['Tijd', hms(r.time)], ['Tempo', r.pace100 ? `${pace(r.pace100)}/100 m` : '–'], ...hr, ['Dag', DAYS[wd(r.date)]]]
    : sp === 'walk' ? [['Afstand', `${km(r.km, 2)} km`], ['Tijd', hms(r.time)], ['Tempo', `${pace(r.pace)}/km`], ...hr,
      ['Hoogte', `${Math.round(r.elev || 0)} m`], ['Dag', DAYS[wd(r.date)]]]
    : [['Sport', r.sportName || 'Training'], ['Tijd', hms(r.time)], ...hr, ['Dag', DAYS[wd(r.date)]]];
  return `<button class="back" data-view="overzicht">← Terug</button>
    <div class="grid run-grid" style="margin-top:14px"><div class="col">
      <div class="rhead"><div class="label">${esc(nlDate(r.date))}${isRun ? '' : ` · ${esc(r.sportName || '')}`}</div><h1 class="title">${esc(r.title)}</h1>
        ${r.structure ? `<div class="muted" style="font-size:18px;margin-top:6px">${esc(r.structure)}</div>` : ''}</div>
      <div class="stats">${stats.map(([l, v]) => `<div><div class="label">${l}</div><div class="big">${esc(v)}</div></div>`).join('')}</div>
      ${plan ? `<section class="panel plan-box"><div class="label">Gepland volgens schema</div>
        <strong style="font-size:18px">${esc(plan.title)}</strong>${plan.structure && !plan.done ? `<span class="muted">${esc(plan.structure)}</span>` : ''}
        <span class="soft">${esc([plan.km, plan.pace].filter((x) => x && x !== '—').join(' · '))}</span></section>` : ''}
      ${S.settings.garmin && r.start ? `<section class="panel feel" data-feel="${esc(r.start)}" data-secs="${r.time || 0}" hidden></section>` : ''}
      ${isRun && blockSource(r, plan) ? `<section class="panel perf" data-perf="${r.id}" data-structure="${esc(blockSource(r, plan))}"><div class="label">Hoe liep het kernblok?</div><div class="muted small" style="margin-top:8px">Berekenen uit je tussentijden…</div></section>` : ''}
      ${isRun ? `<section class="panel"><h2>Wat hield deze training in?</h2><div class="how" style="margin-top:0">${howOpen(full) || '<div class="muted">Geen uitleg nodig.</div>'}</div></section>` : ''}
      <div class="btns" style="margin-top:0"><button class="btn" data-strava="${r.id}">Bekijk op Strava</button>${S.settings.health ? `<button class="btn" data-dayhealth="${r.date}">Herstel die dag</button>` : ''}</div>
    </div>
    <div class="col"><section class="panel rcard"><div class="label" style="margin-bottom:12px">Recap-kaart</div>
      ${card ? `<img class="card-img" data-card="${esc(card.path)}" data-zoom alt="">` : `<div class="card-empty">Nog geen kaart voor deze training.${!WEB() || (S.settings.web?.strava && isRun) ? '<br>Maak er een met de knop hieronder.' : ''}</div>`}
      <div class="btns">${card ? `<button class="btn primary" data-open="${esc(card.path)}">${WEB() ? 'Delen' : 'Open kaart'}</button>${WEB() ? '' : `<button class="btn" data-month="${esc(card.path)}">Open map</button>`}` : ''}
        ${!WEB() || (S.settings.web?.strava && isRun) ? `<button class="btn ${card ? '' : 'primary'}" data-make="${r.id}">${card ? 'Opnieuw maken' : 'Maak kaart'}</button>` : ''}</div>
    </section></div></div>`;
}

async function makeCard(id, btn) {
  const r = ACTS().find((x) => String(x.id) === String(id));
  const plan = sportOf(r) === 'run' ? planRows().find((p) => p.date === r.date && !p.rest) : null;
  const target = plan && plan.pace && plan.pace !== '—' ? plan.pace : '';
  btn.disabled = true;
  btn.textContent = 'Bezig…';
  try {
    const res = await api().make_card(r.id, `${r.title}${r.structure ? ` — ${r.structure}` : ''}`, target);
    const name = res.path.split(/[\\/]/).pop().replace(/\.png$/, '');
    const list = (S.data.cards[r.date] || []).filter((c) => c.path !== res.path);
    S.data.cards[r.date] = [{ path: res.path, name: name.slice(11) }, ...list];
    render();
    toast('Kaart gemaakt en in de maandmap gezet');
  } catch (e) {
    toast(`Kaart maken mislukt: ${errMsg(e)}`, 8000);
    btn.disabled = false;
  }
}

// ---- opstartwizard ------------------------------------------------------------------------
const STEPS = ['Strava-sleutel', 'Koppelen', 'Schema', 'Klaar'];
const STEP_TITLES = ['Maak je Strava-sleutel', 'Koppel je Strava', 'Train je voor een wedstrijd?', 'Laatste details'];
const STRAVA_FORM = [
  ['Application Name', 'dE3p', true],
  ['Category', 'Training (maakt niet uit)', false],
  ['Club', 'leeg laten', false],
  ['Website', 'http://localhost', true],
  ['Application Description', 'mag leeg blijven', false],
  ['Authorization Callback Domain', 'localhost', true],
];

function vSetup() {
  if (WEB() && S.step === 'intro') return vIntro();
  if (WEB() && (S.step === 0 || S.step === 'pc')) {
    const back = S.reconnect ? '<button class="back" data-action="cancel-reconnect">← Instellingen</button>'
      : S.step === 0 ? '<button class="back" data-step="intro">← Wat is dE3p?</button>' : '';
    return `<div class="setup-wrap">${back}
      <div class="head"><div><div class="label">Welkom bij dE3p</div>
        <h1 class="title">${S.step === 0 ? 'Hoe wil je dE3p gebruiken?' : 'Koppel met je computer'}</h1></div></div>
      ${S.step === 0 ? setupChoose() : setupPc()}</div>`;
  }
  const bar = `<ol class="stepper">${STEPS.map((t, i) => `<li class="${i + 1 === S.step ? 'on' : i + 1 < S.step ? 'done' : ''}"><span>${pad(i + 1)}</span>${t}</li>`).join('')}</ol>`;
  const body = [setupKey, setupConnect, setupPlan, setupDone][S.step - 1]();
  const back = S.reconnect ? '<button class="back" data-action="cancel-reconnect">← Instellingen</button>' : '';
  return `<div class="setup-wrap">${back}
    <div class="head"><div><div class="label">${S.settings.connected && S.settings.athlete && !S.reconnect ? `Welkom, ${esc(S.settings.athlete)}` : 'Welkom bij dE3p'}</div>
      <h1 class="title">${STEP_TITLES[S.step - 1]}</h1></div><div class="label">Stap ${S.step} van ${STEPS.length}</div></div>
    ${bar}${body}</div>`;
}

// ---- www.de3p.be voor wie dE3p nog niet kent: wat het voor je doet, en hoe het werkt ----
// de echte app in twee gsm's (zoals op de flyer): Overzicht en Trainingen met voorbeeldgegevens
// per scherm de juiste maat (vooraf verkleind en verscherpt): scherp op 1x, 2x en 3x
const IN_PHONE = (name, cls) => `<div class="in-phone ${cls}"><div class="scr"><div class="sb"><span>9:41</span><i></i></div><img src="web/${name}-760.jpg"
  srcset="web/${name}-380.jpg 380w, web/${name}-760.jpg 760w, web/${name}.jpg 1170w" sizes="(max-width: 640px) 210px, 350px" alt="" decoding="async"></div></div>`;
const IN_LINKS = [['Strava', '#FC4C02'], ['Garmin', '#007CC3'], ['Whoop'], ['Oura'], ['Polar'], ['Withings'], ['intervals.icu']];
function vIntro() {
  const why = [
    ['01', 'In één oogopslag', 'Herstel, slaap, HRV, rustpols, Body Battery en VO2max. Groen, oranje of rood: je weet meteen of je vandaag kan knallen.'],
    ['02', 'Een schema naar je doel', 'Van 5 km tot marathon, of fitter met lopen, fietsen en zwemmen. Een paar vragen en elke training staat klaar.'],
    ['03', 'Advies voor vandaag', 'Training al gedaan, rustdag, of toch wat moe? dE3p zegt wat je vandaag best doet.'],
    ['04', 'Strava, vanzelf netjes', 'Elke training krijgt de naam en uitleg uit je schema, en wordt afgevinkt.'],
    ['05', 'Een kaart van elke training', 'Een strakke zwart-witte kaart met je cijfers, klaar voor Instagram en TikTok.'],
    ['06', 'Zie of je vooruitgaat', 'Per dag, per maand of alles, met je eigen gemiddelden als maatstaf.'],
  ];
  const how = [['Koppel Strava en je horloge', 'Eén keer, ongeveer 5 minuten. Heb je dE3p op je computer, dan gaat het in 1 minuut.'],
    ['Kies je doel', 'Een wedstrijd, fitter worden of beter zwemmen: beantwoord een paar vragen.'],
    ['Train', 'dE3p doet de rest: naam op Strava, kaart, afvinken en advies.']];
  return `<div class="intro">
    <section class="in-hero">
      <div class="in-copy">
        <p class="label">Gratis · op je gsm en je computer</p>
        <h1 class="in-h1">Weet waar je staat.<br>Train naar je doel.</h1>
        <p class="in-lead">dE3p brengt je trainingen van Strava, je herstel van je horloge en je schema samen. In één oogopslag zie je hoe je ervoor staat, wat je vandaag doet en of je echt vooruitgaat.</p>
        <div class="btns"><button class="btn primary big" data-step="0">Begin</button><button class="btn big" data-action="web-demo">Bekijk een voorbeeld</button></div>
        <div class="in-works"><span class="label">Koppelt met</span>
          <div class="in-links">${IN_LINKS.map(([n, c]) => `<span class="in-lk"><i${c ? ` style="background:${c}"` : ''}></i>${n}</span>`).join('')}</div>
          <p class="muted small">Ander horloge? Via Strava komen je trainingen binnen.</p></div>
      </div>
      <div class="in-visual" aria-hidden="true">
        ${IN_PHONE('intro-home', 'p1')}${IN_PHONE('intro-weeks', 'p2')}
      </div>
    </section>
    <section class="in-why">
      <h2 class="sec-t">Wat dE3p voor je doet</h2>
      <div class="in-grid">${why.map(([n, t, d]) => `<div class="in-item"><span class="label">${n}</span><b>${t}</b><p>${d}</p></div>`).join('')}</div>
    </section>
    <section class="in-how">
      <h2 class="sec-t">Zo werkt het</h2>
      <ol class="in-steps">${how.map(([t, d], i) => `<li><span class="in-n">${i + 1}</span><div><b>${t}</b><p>${d}</p></div></li>`).join('')}</ol>
      <div class="btns"><button class="btn primary big" data-step="0">Begin</button><a class="btn big" href="/download/">dE3p voor je computer</a></div>
      <p class="muted small in-privacy">Privé: je gegevens blijven op je eigen toestel. Wat je computer naar je gsm stuurt, is versleuteld: zelfs dE3p kan het niet lezen.</p>
    </section>
  </div>`;
}

// Gsm: eerst kiezen (met je computer of enkel op de gsm), dan koppelen
function installHint() {
  const w = S.settings.web || {};
  if (w.standalone || !(w.ios || w.android)) return '';
  if (w.ios) {
    return `<div class="note install"><b>Eerst: zet dE3p op je beginscherm.</b> Tik onderaan op <i>⋯</i> of op <i>Deel</i> en kies <i>Zet op beginscherm</i>.
      Open dE3p daarna met het icoon en ga daar verder: zo blijft alles in de app.</div>`;
  }
  return `<div class="note install"><b>Zet dE3p op je beginscherm.</b> ${w.canInstall ? '<button class="btn" data-action="web-install">Installeer de app</button>'
    : 'Tik rechtsboven op <i>⋮</i> en kies <i>App installeren</i>.'}</div>`;
}
function setupChoose() {
  return `<section class="panel setup">
    ${installHint()}
    <div class="choices">
      <button class="choice" data-step="pc"><b>Met mijn computer</b>
        <span>Je hebt dE3p op je computer. Je gsm toont dan alles: trainingen, schema, kaarten en je gezondheid.</span><i class="label">1 minuut</i></button>
      <button class="choice" data-step="1"><b>Enkel op deze gsm</b>
        <span>Rechtstreeks van Strava, zonder computer. Je maakt één keer een Strava-sleutel.</span><i class="label">5 minuten</i></button>
    </div>
    <p class="muted small" style="margin:16px 0 0">Nog geen dE3p op je computer? <a href="/download/">Download dE3p</a> (Windows en Mac, gratis), met de handleiding.</p>
    <div class="btns"><button class="btn" data-action="web-demo">Bekijk een voorbeeld</button></div>
  </section>`;
}
const fmtCode = (c) => { const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); return x.length > 4 ? `${x.slice(0, 4)}-${x.slice(4)}` : x; };
function pairForm() {
  return `<form data-form="pair" class="pair-form" autocomplete="off">
      <input class="input code" name="code" value="${esc(fmtCode(S.settings.web?.pairCode))}" placeholder="XXXX-XXXX" aria-label="Koppelcode"
        autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" maxlength="9" required>
      <button class="btn primary" type="submit" ${S.pairBusy ? 'disabled' : ''}>${S.pairBusy ? '<span class="spinner"></span> Bezig…' : 'Koppel'}</button>
    </form>
    ${S.setupError ? `<div class="alert" style="margin:12px 0 0">${esc(S.setupError)}</div>` : ''}`;
}
function setupPc() {
  return `<section class="panel setup">
    ${installHint()}
    <ol class="todo">
      <li><b>Open dE3p op je computer</b> en klik rechtsboven op het tandwiel → <i>Gsm</i>.</li>
      <li><b>Klik op "Toon koppelcode".</b> Je ziet een code zoals <code>K7QF-M2XD</code>. Ze werkt 7 dagen, ook als je later opnieuw moet koppelen.</li>
      <li><b>Typ die code hier</b> en tik op <i>Koppel</i>.</li>
    </ol>
    ${pairForm()}
    <p class="muted small" style="margin:16px 0 0">Je computer versleutelt alles zelf. Enkel deze gsm krijgt de sleutel: dE3p kan je gegevens niet lezen.</p>
    <div class="btns"><button class="btn" data-step="0">← Vorige</button></div>
  </section>`;
}
async function pairSubmit(form) {
  const code = String(new FormData(form).get('code') || '');
  S.pairBusy = true; S.setupError = '';
  render();
  try {
    await api().pair_pc(code);
    S.settings = await api().settings();
    S.pairBusy = false; S.onboarding = false; S.reconnect = false; S.conn = ''; S.data = null;
    const w = S.settings.web || {};
    toast(w.ios && !w.standalone ? 'Gekoppeld in Safari. Zet dE3p op je beginscherm en typ daar dezelfde code nog eens.' : 'Gekoppeld met je computer', w.ios && !w.standalone ? 9000 : 3200);
    go('overzicht');
    await doRefresh();
  } catch (e) {
    S.pairBusy = false; S.setupError = errMsg(e);
    render();
  }
}

function setupKey() {
  const web = WEB();
  const form = web ? [['Application Name', 'dE3p', true], ['Category', 'Training (maakt niet uit)', false], ['Club', 'leeg laten', false],
    ['Website', 'https://www.de3p.be', true], ['Application Description', 'mag leeg blijven', false],
    ['Authorization Callback Domain', S.settings.web?.callback || 'www.de3p.be', true]] : STRAVA_FORM;
  const kv = form.map(([k, v, copy]) => `<div class="kv-row ${k.startsWith('Authorization') ? 'key' : ''}">
      <span class="k">${k}</span><span class="v">${esc(v)}</span>
      ${copy ? `<button class="copy" data-copy="${esc(v)}">Kopieer</button>` : '<span></span>'}</div>`).join('');
  return `<section class="panel setup">
    <p class="lead">Strava laat elk programma werken met een eigen sleutel. Die maak je één keer, gratis, in een paar minuten. Zo blijven je gegevens van jou: ze gaan rechtstreeks van Strava naar ${web ? 'deze gsm' : 'deze computer'}.</p>
    <ol class="todo">
      <li><b>Open de Strava-pagina voor ontwikkelaars</b> en log in met je gewone Strava-account.
        <div class="btns"><button class="btn primary" data-action="strava-api">Open strava.com/settings/api</button></div></li>
      <li><b>Vul het formulier zo in</b>, vink het akkoord aan en klik op <i>Create</i>.
        <div class="kv">${kv}</div>
        <div class="note">Het belangrijkste veld is <b>Authorization Callback Domain</b>: daar moet exact <code>${esc(web ? (S.settings.web?.callback || 'www.de3p.be') : 'localhost')}</code> staan, anders lukt het koppelen niet.${web ? ' Heb je al een Strava-sleutel van het programma op je computer? Gebruik die en verander enkel dit veld: je computer blijft werken.' : ''}</div>
        ${web ? '' : `<figure class="setup-pic"><img src="img/strava-form-${OS()}.webp" alt="Zo vul je het formulier op Strava in: localhost, het vinkje en Create omcirkeld"><figcaption class="label">Zo ziet het eruit op Strava (vereenvoudigd)</figcaption></figure>`}</li>
      ${web ? '<li><b>Vraagt Strava een icoon?</b> Kies eender welke foto.</li>' : `<li><b>Vraagt Strava een icoon?</b> Kies eender welke afbeelding, of gebruik het dE3p-icoon.
        <div class="btns"><button class="btn" data-action="icon">Bewaar dE3p-icoon in Downloads</button></div></li>`}
    </ol>
    <div class="btns end">${web && !S.reconnect ? '<button class="btn" data-step="0">← Vorige</button>' : ''}<button class="btn primary" data-step="2">Klaar, volgende stap</button></div>
  </section>`;
}

function setupConnect() {
  const st = S.settings;
  const cid = S.cid || st.clientId || '';
  return `<section class="panel setup">
    <p class="lead">Op dezelfde Strava-pagina staat nu <b>My API Application</b>. Kopieer daar deze twee waarden:</p>
    ${WEB() ? '' : `<figure class="setup-pic"><img src="img/strava-keys-${OS()}.webp" alt="Op Strava: de Client ID en, na show, de Client Secret omcirkeld"><figcaption class="label">Waar je ze vindt op Strava (vereenvoudigd)</figcaption></figure>`}
    <form data-form="connect" class="form form-2" autocomplete="off">
      <label class="field"><span class="label">Client ID</span>
        <input class="input" name="clientId" inputmode="numeric" required placeholder="bv. 123456" value="${esc(cid)}">
        <small>Een getal van een paar cijfers.</small></label>
      <label class="field"><span class="label">Client Secret</span>
        <input class="input" name="clientSecret" type="password" required placeholder="lange code" value="${esc(S.csec)}">
        <small>Klik op Strava eerst op <i>show</i> om hem te zien.</small></label>
      ${WEB() ? '' : `<label class="toggle span2"><input type="checkbox" name="rename" ${st.rename !== false ? 'checked' : ''}><span class="knob"></span>
        <span><b>Runs hernoemen naar je training</b><small>Staat er in je schema een training gepland, dan wordt "Ochtendloop" op Strava bv. "Tempoduurloop — 2 km IL + 6 km @ 4:03 + 2 km UL". Enkel bij runs die nog hun standaardnaam hebben.</small></span></label>`}
      ${S.setupError ? `<div class="alert span2">${esc(S.setupError)}</div>` : ''}
      ${S.connecting ? `<div class="waiting span2"><span class="spinner"></span>
          <div>${WEB() ? `<b>Strava gaat open.</b><br>Tik op de oranje knop <i>Authorize</i>.${S.settings.web?.ios ? ' Kom je niet vanzelf terug? Tik linksboven op <i>Gereed</i>.' : ''}`
            : '<b>Je browser opent Strava.</b><br>Klik daar op de oranje knop <i>Authorize</i> en kom daarna terug naar dit venster.'}</div>
          <button class="btn" type="button" data-action="cancel-connect">Annuleren</button></div>
          ${WEB() ? '' : `<figure class="setup-pic span2"><img src="img/strava-auth-${OS()}.webp" alt="Op Strava: de oranje knop Authorize omcirkeld"></figure>`}`
        : `<div class="btns span2">${S.reconnect ? '' : '<button class="btn" type="button" data-step="1">← Vorige</button>'}<button class="btn strava" type="submit">Koppel met Strava</button></div>`}
    </form>
    <p class="muted small" style="margin:18px 0 0">Je sleutel blijft op ${WEB() ? 'deze gsm' : 'deze computer'}. Niemand anders, ook dE3p niet, krijgt je gegevens te zien.</p>
  </section>`;
}

function setupPlan() {
  return `<section class="panel setup">
    <p class="lead">Geef je wedstrijd op en de app maakt een schema op maat: rustig opbouwen, herstelweken, piek en taper, met het doeltempo voor elke training. Liever gewoon je runs en kaarten? Sla dit dan over, je kan later altijd nog een schema maken.</p>
    ${planFormHtml(true)}
  </section>`;
}

function setupDone() {
  const st = S.settings;
  return `<section class="panel setup">
    ${S.planInfo ? `<div class="done-line">✓ ${esc(S.planInfo)}</div>` : ''}
    ${WEB() ? `<div class="set-row"><div><div class="label">Recap-kaarten</div><div class="v">Van elke run een kaart</div>
      <small class="muted">Tik op een training en dan op <i>Delen</i>: naar Instagram, TikTok of je foto's.</small></div></div>`
    : `<div class="set-row"><div><div class="label">Recap-kaarten komen in</div><div class="path">${esc(st.cardsDir)}</div>
      <small class="muted">Per maand een map, elke kaart met de datum vooraan.</small></div>
      <button class="btn" data-action="pick-folder">Andere map</button></div>`}
    ${st.platform === 'win32' ? `<label class="toggle"><input type="checkbox" id="mkShortcut" checked><span class="knob"></span>
      <span><b>Snelkoppeling op het bureaublad en in het Startmenu</b><small>Zo open je het programma met één klik. Op je taakbalk: rechtsklik op dE3p in het Startmenu → Aan taakbalk vastmaken.</small></span></label>` : ''}
    ${['win32', 'darwin'].includes(st.platform) ? `<label class="toggle"><input type="checkbox" id="mkAutoSync" checked><span class="knob"></span>
      <span><b>Automatisch syncen, elk half uur</b><small>Ook als het programma dicht is. Je kan dit later uitzetten bij Instellingen.</small></span></label>` : ''}
    <div class="set-row"><div><div class="label">Horloge of ring · optioneel</div><div class="v">Heb je een Garmin, Whoop, Oura of Polar?</div>
      <small class="muted">${WEB() ? 'Die koppel je in het programma op je computer. Koppel dE3p daarna met je computer (Instellingen → Computer): dan zie je hier ook je slaap, herstel en gezondheid.'
        : 'Koppel die straks bij Instellingen → Koppelingen. Dan zie je ook je slaap, herstel en gezondheid per maand.'}</small></div></div>
    <div class="btns end"><button class="btn" data-step="3">← Vorige</button><button class="btn primary" data-action="finish">Klaar, haal mijn runs op</button></div>
  </section>`;
}

// ---- schemaformulier -------------------------------------------------------------------------
function planFormHtml(inSetup) {
  const c = { ...(S.settings.plan || {}), ...(inSetup ? {} : nonNull(S.planPrefill)) };   // uit je tekst (lokale AI) gaat voor
  const opt = (v, label, sel) => `<option value="${v}" ${String(sel) === String(v) ? 'selected' : ''}>${label}</option>`;
  const dayOpts = (sel) => DAYS.map((d, i) => opt(i, cap(d), sel)).join('');
  const t = todayIso();
  const btns = inSetup
    ? `<button class="btn" type="button" data-step="2">← Vorige</button><button class="btn" type="button" data-step="4">Overslaan, geen schema</button><button class="btn primary" type="submit">Maak mijn schema</button>`
    : `<button class="btn" type="button" data-view="doelen">Annuleren</button><button class="btn primary" type="submit">${S.settings.plan ? 'Vervang mijn schema' : 'Maak mijn schema'}</button>`;
  return `<form data-form="plan" class="form form-3" autocomplete="off">
    <label class="field"><span class="label">Wedstrijd</span>
      <input class="input" name="raceName" placeholder="bv. Marathon Antwerpen" value="${esc(c.raceName || '')}"></label>
    <label class="field"><span class="label">Datum</span>
      <input class="input" type="date" name="raceDate" required min="${addDays(t, 7)}" value="${esc(c.raceDate && c.raceDate > t ? c.raceDate : '')}"></label>
    <label class="field"><span class="label">Afstand</span>
      <select class="input" name="distance">${Object.entries(DISTANCES).map(([k, v]) => opt(k, v.label, c.distance || 'marathon')).join('')}</select></label>
    <label class="field"><span class="label">Doeltijd (u:mm:ss)</span>
      <input class="input" name="goal" required placeholder="3:30:00" value="${esc(c.goalSec ? fmtTime(c.goalSec) : '')}"><small data-pace></small></label>
    <label class="field"><span class="label">Km per week nu</span>
      <input class="input" type="number" name="baseKm" min="10" max="200" required value="${esc(c.baseKm ?? 30)}"><small>Wat loop je de laatste weken gemiddeld?</small></label>
    <label class="field"><span class="label">Loopdagen per week</span>
      <select class="input" name="runDays">${[3, 4, 5, 6].map((n) => opt(n, `${n} dagen`, c.runDays ?? 4)).join('')}</select></label>
    <label class="field"><span class="label">Lange duurloop op</span>
      <select class="input" name="longDay">${dayOpts(c.longDay ?? 6)}</select></label>
    <label class="field"><span class="label">Vaste rustdag</span>
      <select class="input" name="restDay">${dayOpts(c.restDay ?? 4)}</select></label>
    <label class="field"><span class="label">Fietsen / cross-training</span>
      <select class="input" name="crossDay">${opt('', 'Geen', c.crossDay ?? '')}${dayOpts(c.crossDay ?? '')}</select></label>
    ${S.settings.plan && !inSetup ? '<div class="note span3">Dit vervangt je huidige schema.</div>' : ''}
    <div class="btns span3 end">${btns}</div>
  </form>`;
}

function vPlanForm() {
  return `<div class="setup-wrap"><button class="back" data-view="doelen">← Je doelen</button>
    <div class="head"><div><div class="label">Doel · wedstrijd</div><h1 class="title">${S.settings.plan ? 'Nieuw loopschema' : 'Voor welke wedstrijd train je?'}</h1></div></div>
    ${S.planPrefill ? '<div class="note gq-ai">Ingevuld uit je tekst door de AI. Kijk de datum en je doeltijd even na.</div>' : ''}${queueNote()}
    <section class="panel setup">${planFormHtml(false)}</section></div>`;
}

function updatePacePreview(form) {
  const f = new FormData(form);
  const sec = parseTime(f.get('goal'));
  const D = DISTANCES[f.get('distance')];
  const out = form.querySelector('[data-pace]');
  if (out) out.textContent = sec && D ? `= ${pace(sec / D.km)}/km gemiddeld` : 'Bv. 3:30:00, of 45:00 voor een 10 km';
}

async function savePlanForm(form) {
  const f = new FormData(form);
  const goalSec = parseTime(f.get('goal'));
  if (!goalSec) return toast('Doeltijd als u:mm:ss, bv. 3:30:00 (of 45:00)', 5000);
  const cfg = {
    raceName: String(f.get('raceName') || '').trim(),
    raceDate: f.get('raceDate'),
    distance: f.get('distance'),
    goalSec,
    baseKm: Number(f.get('baseKm')),
    runDays: Number(f.get('runDays')),
    longDay: Number(f.get('longDay')),
    restDay: Number(f.get('restDay')),
    crossDay: f.get('crossDay') === '' ? null : Number(f.get('crossDay')),
    startDate: todayIso(),
  };
  if (!cfg.raceDate || cfg.raceDate <= addDays(cfg.startDate, 6)) return toast('Kies een wedstrijd die minstens een week verder ligt.', 5000);
  if (cfg.longDay === cfg.restDay) return toast('Lange duurloop en rustdag vallen op dezelfde dag.', 5000);
  if (cfg.crossDay !== null && [cfg.longDay, cfg.restDay].includes(cfg.crossDay)) return toast('Kies een andere dag om te fietsen.', 5000);
  const plan = generatePlan(cfg);
  try {
    await api().save_plan(plan);
    S.settings = await api().settings();
  } catch (e) {
    return toast(`Schema bewaren mislukt: ${errMsg(e)}`, 8000);
  }
  const peak = Math.max(...plan.weeks.map((w) => w.km));
  S.planInfo = `Schema gemaakt: ${plan.weeks.length} weken tot ${cfg.raceName || DISTANCES[cfg.distance].label}, piek ${km(peak, 0)} km per week, wedstrijdtempo ${pace(goalSec / DISTANCES[cfg.distance].km)}/km.`;
  if (S.view === 'setup') { S.step = 4; render(); return undefined; }
  S.planPrefill = null;
  toast('Loopschema gemaakt');
  if (await continueQueue()) return undefined;
  S.view = 'doelen';
  if (S.data) await doRefresh(); else render();
  $main.scrollTop = 0;
  return undefined;
}

// ---- instellingen -----------------------------------------------------------------------------
// ---- koppelingen: één tegel per dienst; klik voor de details ------------------------------
const PHONE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>';
const PC_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/></svg>';
const APPLE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-3.9z"/><path d="M14.1 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4z"/></svg>';
const CONNS = [
  { k: 'gsm', n: 'Gsm', m: PHONE_ICON, b: '#0A0A0A', desk: true },
  { k: 'pc', n: 'Computer', m: PC_ICON, b: '#0A0A0A', web: true },
  { k: 'strava', n: 'Strava', m: 'S', b: '#FC4C02' },
  { k: 'apple', n: 'Apple Watch', m: APPLE_ICON, b: '#1C1C1E', app: true },
  { k: 'garmin', n: 'Garmin', m: 'G', b: '#007CC3' },
  { k: 'notion', n: 'Notion', m: 'N', b: '#2F2F2F' },
  { k: 'whoop', n: 'Whoop', m: 'W', b: '#1C1C1C', wear: true },
  { k: 'oura', n: 'Oura', m: 'O', b: '#4A4A4A', wear: true },
  { k: 'polar', n: 'Polar', m: 'P', b: '#D10027', wear: true },
  { k: 'withings', n: 'Withings', m: 'Wi', b: '#0B6E6E', wear: true },
  { k: 'intervals', n: 'intervals.icu', m: 'i', b: '#2F6FB0', wear: true, key: true },
];
function connState(c) {
  const st = S.settings;
  if (c.k === 'gsm') return st.phone?.paired ? { on: true, txt: 'Gekoppeld' } : { on: false, txt: 'Koppelen' };
  if (c.k === 'pc') return st.web?.pc ? { on: true, txt: 'Gekoppeld' } : { on: false, txt: 'Koppelen' };
  if (c.k === 'apple') return st.wear?.apple ? { on: true, txt: 'Gekoppeld' } : { on: false, txt: 'Koppelen' };
  if (WEB() && c.k === 'strava') return st.web?.strava ? { on: true, txt: `Op deze gsm${st.athlete ? ` · ${st.athlete}` : ''}` } : { on: false, txt: 'Koppelen' };
  if (WEB()) return { on: true, txt: 'Via je computer' };
  if (c.k === 'strava') return { on: true, txt: st.legacy ? 'Gekoppeld' : `Gekoppeld${st.athlete ? ` · ${st.athlete}` : ''}` };
  if (c.k === 'garmin') return st.garmin ? { on: true, txt: 'Gekoppeld' } : { on: false, txt: 'Koppelen' };
  if (c.k === 'notion') return { on: true, txt: 'Gekoppeld' };
  return st.wear?.[c.k] ? { on: true, txt: 'Gekoppeld' } : { on: false, txt: 'Koppelen' };
}
function connDetail(c) {
  const st = S.settings;
  if (c.k === 'gsm') return phoneRow();
  if (c.k === 'apple') return appleRow();
  if (c.k === 'pc') {
    if (!st.web?.pc) {
      return `<div class="set-row stack"><div><div class="v">Koppel met je computer</div>
        <small class="muted">Open dE3p op je computer → tandwiel → <i>Gsm</i> → <i>Toon koppelcode</i>, en typ die code hier. Dan zie je ook je schema, kaarten en gezondheid van je computer.</small></div>
        ${pairForm()}</div>`;
    }
    return `<div class="set-row"><div><div class="v">Gekoppeld met dE3p op je computer</div>
      <small class="muted">${st.web.made ? `Laatste kopie van je computer: ${esc(syncWhen(st.web.made))}. ` : ''}Na elke sync op je computer komt er een nieuwe. Versleuteld: dE3p kan ze niet lezen.</small></div>
      <div class="btns tight"><button class="btn" data-action="sync">Nu ophalen</button><button class="btn" data-action="web-unpair">Ontkoppelen</button></div></div>`;
  }
  if (WEB() && c.k === 'strava') {
    if (st.web?.strava) {
      return `<div class="set-row"><div><div class="v">Gekoppeld${st.athlete ? ` als ${esc(st.athlete)}` : ''}, rechtstreeks op deze gsm</div>
        <small class="muted">Je nieuwste runs komen meteen van Strava, ook als je computer uit staat.</small></div>
        <div class="btns tight"><button class="btn" data-action="web-strava">Opnieuw koppelen</button><button class="btn" data-action="disconnect">Ontkoppelen</button></div></div>`;
    }
    return `<div class="set-row"><div><div class="v">Strava ook rechtstreeks op deze gsm</div>
      <small class="muted">Handig als je computer uit staat: je nieuwste run staat dan meteen hier. Je maakt één keer een Strava-sleutel (of gebruikt die van je computer).</small></div>
      <div class="btns tight"><button class="btn primary" data-action="web-strava">Koppelen</button></div></div>`;
  }
  if (WEB() && c.k === 'notion') {
    return `<div class="set-row"><div><div class="v">Gekoppeld op je computer</div>
      <small class="muted">Je loopschema komt uit Notion. Je computer leest het en stuurt het mee naar je gsm.</small></div></div>`;
  }
  if (WEB()) {
    return `<div class="set-row"><div><div class="v">Gekoppeld op je computer</div>
      <small class="muted">${esc(c.n)} koppel je in het programma op je computer. Je slaap, herstel en gezondheid komen mee met de kopie van je computer.</small></div></div>`;
  }
  if (c.k === 'strava') {
    if (st.legacy) return '<div class="set-row"><div><div class="v">Strava · ontwikkelmap</div><small class="muted">De sleutels komen uit <code>.env</code> naast de code.</small></div></div>';
    return `<div class="set-row"><div><div class="v">Gekoppeld${st.athlete ? ` als ${esc(st.athlete)}` : ''}</div>
      ${st.scopeOk ? '<small class="muted">Mag je trainingen lezen (ook privé) en hernoemen.</small>' : '<small class="warn">Niet alle vinkjes stonden aan op Strava: privé-trainingen lezen of hernoemen lukt niet. Koppel opnieuw en laat alles aangevinkt.</small>'}</div>
      <div class="btns tight"><button class="btn" data-action="reconnect">Opnieuw koppelen</button><button class="btn" data-action="disconnect">Ontkoppelen</button></div></div>`;
  }
  if (c.k === 'garmin') return garminRow();
  if (c.wear) return wearRow(c);
  return '<div class="set-row"><div><div class="v">Je schema komt uit Notion</div><small class="muted">De weken, trainingen en uitleg van je Notion-pagina staan bij Trainingen en in de agenda.</small></div><div class="btns tight"><button class="btn" data-action="notion">Open in Notion</button></div></div>';
}
const WEAR = {"whoop": {"site": "developer-dashboard.whoop.com", "url": "https://developer-dashboard.whoop.com/", "tip": "Vink bij de rechten (scopes) alles aan."}, "oura": {"site": "cloud.ouraring.com", "url": "https://cloud.ouraring.com/oauth/applications", "tip": "Vragen ze een website, privacybeleid of voorwaarden: vul https://www.de3p.be/download/ in."}, "polar": {"site": "admin.polaraccesslink.com", "url": "https://admin.polaraccesslink.com/", "tip": "Je logt in met je Polar Flow-account. Polar bewaart slaap en Nightly Recharge 28 dagen voor andere apps."}, "withings": {"site": "developer.withings.com", "url": "https://developer.withings.com/dashboard/", "tip": "Kies 'Public API' en vul als website https://www.de3p.be/download/ in. Je weegschaal, slaap en stappen komen mee."}, "intervals": {"site": "intervals.icu", "url": "https://intervals.icu/settings"}};
// Whoop, Oura, Polar, Withings: eigen app per gebruiker (zoals de Strava-sleutel), daarna in de browser toestemming geven;
// intervals.icu: enkel je atleet-ID en API-sleutel
function wearRow(c) {
  const st = S.settings; const w = WEAR[c.k];
  if (st.wear?.[c.k]) {
    const used = st.health === c.k;
    return `<div class="set-row"><div><div class="v">Gekoppeld</div>
      <small class="muted">${used ? `Je slaap, HRV, rusthartslag en herstel van ${esc(c.n)} staan bij Gezondheid en op het Overzicht.`
        : `${esc(SRC[st.health] || 'Een andere koppeling')} gaat voor bij Gezondheid. Ontkoppel die om ${esc(c.n)} te gebruiken.`}</small></div>
      <div class="btns tight"><button class="btn" data-action="wear-off" data-k="${c.k}">Ontkoppelen</button></div></div>`;
  }
  if (S.wearBusy === c.k) {
    return `<div class="set-row"><div><div class="v"><span class="spinner"></span> Je browser opent ${esc(c.n)}</div>
      <small class="muted">Log in en klik op toestaan. Kom daarna terug naar dit venster.</small></div>
      <div class="btns tight"><button class="btn" data-action="cancel-connect">Annuleren</button></div></div>`;
  }
  if (c.key) {
    return `<div class="set-row stack"><div><div class="v">Koppel ${esc(c.n)}</div>
        <small class="muted">Geen app nodig. Je fitheid en vorm uit intervals.icu komen bij Gezondheid, en ook je slaap, HRV, rusthartslag en gewicht als je horloge, ring of weegschaal die naar intervals.icu stuurt.</small></div>
      <ol class="wsteps">
        <li>Open <b>${esc(w.site)}</b> → <i>Settings</i> en scroll naar <i>Developer Settings</i>. <button class="btn" type="button" data-action="wear-portal" data-k="${c.k}">Open ${esc(c.n)}</button></li>
        <li>Kopieer je <b>Athlete ID</b> (bv. i123456) en je <b>API Key</b> hieronder en klik op koppelen.</li>
      </ol>
      <form class="garmin-form" data-form="wearkey" data-k="${c.k}" autocomplete="off">
        <input class="input" name="aid" placeholder="Athlete ID (bv. i123456)" aria-label="Athlete ID" required>
        <input class="input" name="key" type="password" placeholder="API Key" aria-label="API Key" required>
        <button class="btn primary" type="submit">Koppel ${esc(c.n)}</button>
      </form>
      ${S.wearError ? `<div class="alert" style="margin:0">${esc(S.wearError)}</div>` : ''}</div>`;
  }
  const rows = [['Naam', 'dE3p'], ['Redirect-URL', 'http://localhost:8721/callback']];
  return `<div class="set-row stack"><div><div class="v">Koppel je ${esc(c.n)}</div>
      <small class="muted">${esc(c.n)} laat elke gebruiker een eigen app maken, net zoals je Strava-sleutel. Dat duurt een paar minuten en alles blijft op deze computer.</small></div>
    <ol class="wsteps">
      <li>Open <b>${esc(w.site)}</b> en log in met je ${esc(c.n)}-account. <button class="btn" type="button" data-action="wear-portal" data-k="${c.k}">Open ${esc(c.n)}</button></li>
      <li>Maak een nieuwe app met deze gegevens. ${esc(w.tip)}
        <div class="kv">${rows.map(([kk, v]) => `<div><span class="label">${kk}</span><code>${esc(v)}</code><button class="copy" type="button" data-copy="${esc(v)}">Kopieer</button></div>`).join('')}</div></li>
      <li>Kopieer de <b>Client ID</b> en <b>Client Secret</b> van je nieuwe app hieronder en klik op koppelen.</li>
    </ol>
    <form class="garmin-form" data-form="wear" data-k="${c.k}" autocomplete="off">
      <input class="input" name="cid" placeholder="Client ID" aria-label="Client ID" required>
      <input class="input" name="sec" type="password" placeholder="Client Secret" aria-label="Client Secret" required>
      <button class="btn primary" type="submit">Koppel ${esc(c.n)}</button>
    </form>
    ${S.wearError ? `<div class="alert" style="margin:0">${esc(S.wearError)}</div>` : ''}</div>`;
}
// Apple Watch (enkel in de iPhone-app): Apple Gezondheid lezen, zonder computer
function appleRow() {
  if (S.settings.wear?.apple) {
    return `<div class="set-row"><div><div class="v">Gekoppeld met Apple Gezondheid</div>
      <small class="muted">Je slaap, HRV, rustpols, stappen, VO2max en gewicht van je Apple Watch staan bij Gezondheid en op het Overzicht. Ook wat Garmin, Oura, Whoop, Withings of Huawei in Apple Gezondheid zetten komt mee. Alles blijft op je iPhone.</small></div>
      <div class="btns tight"><button class="btn" data-action="apple-off">Ontkoppelen</button></div></div>`;
  }
  return `<div class="set-row stack"><div><div class="v">Koppel je Apple Watch</div>
      <small class="muted">dE3p leest je slaap, HRV, rustpols, stappen, VO2max en gewicht uit Apple Gezondheid op deze iPhone. Je hebt geen computer nodig en alles blijft op je iPhone.</small></div>
    <ol class="wsteps"><li>Tik op <b>Geef toegang</b>.</li><li>Zet in het venster van Apple alles aan en tik op <b>Sta toe</b>.</li></ol>
    <div class="btns tight"><button class="btn primary" data-action="apple-connect" ${S.appleBusy ? 'disabled' : ''}>${S.appleBusy ? '<span class="spinner"></span>Bezig…' : 'Geef toegang'}</button></div>
    ${S.wearError ? `<div class="alert" style="margin:0">${esc(S.wearError)}</div>` : ''}</div>`;
}
async function bodySubmit(form) {
  const f = new FormData(form);
  S.bodyError = '';
  try {
    await api().set_body(String(f.get('birth') || ''), String(f.get('sex') || ''));
    S.settings = await api().settings();
    S.bodyEdit = false; S.bageOpen = false;
  } catch (e) { S.bodyError = errMsg(e); }
  render();
}
async function wearSubmit(form) {
  const k = form.dataset.k; const f = new FormData(form);
  S.wearBusy = k; S.wearError = '';
  render();
  try {
    const name = form.dataset.form === 'wearkey'
      ? await api().wear_connect_key(k, String(f.get('aid') || ''), String(f.get('key') || ''))
      : await api().wear_connect(k, String(f.get('cid') || ''), String(f.get('sec') || ''));
    S.settings = await api().settings();
    S.health = null;
    toast(`${name} gekoppeld`);
  } catch (e) {
    S.wearError = errMsg(e);
  } finally {
    S.wearBusy = '';
    render();
  }
}

// Computer: je gsm koppelen met een code (10 minuten geldig) of QR-code
function phoneRow() {
  const ph = S.settings.phone || {};
  const code = S.phoneCode;
  const codeHtml = code ? `<div class="pair-show">
      <div class="qr">${code.qr}</div>
      <div><div class="label">Koppelcode · werkt 7 dagen, op elke gsm</div><div class="pair-code">${esc(code.code)}</div>
        <small class="muted">Open <b>www.de3p.be</b> op je gsm, kies <i>Met mijn computer</i> en typ deze code. Of richt de camera van je gsm op de QR-code. Je mag de code meer dan eens gebruiken: zolang je computer synct, blijft ze werken.</small></div></div>` : '';
  if (ph.paired) {
    return `<div class="set-row stack"><div><div class="v">Je gsm is gekoppeld</div>
      <small class="muted">Na elke sync gaat er een versleutelde kopie naar je gsm (trainingen, schema, kaarten en gezondheid). dE3p kan ze niet lezen.${ph.last ? ` Laatst verstuurd: ${esc(syncWhen(ph.last))}.` : ''}${ph.error ? ` <span class="warn">Laatste poging mislukt (${esc(ph.error)}).</span>` : ''}</small></div>
      ${codeHtml}
      <div class="btns tight"><button class="btn" data-action="phone-push" ${S.phoneBusy ? 'disabled' : ''}>${S.phoneBusy ? '<span class="spinner"></span> Bezig…' : 'Nu versturen'}</button>
        ${code ? '<button class="btn" data-action="phone-pair" data-new="1">Nieuwe code</button>' : '<button class="btn" data-action="phone-pair">Toon koppelcode</button>'}<button class="btn" data-action="phone-off">Ontkoppelen</button></div></div>`;
  }
  return `<div class="set-row stack"><div><div class="v">Je trainingen ook op je gsm</div>
      <small class="muted">Met de gsm-app <b>dE3p</b> zie je op je gsm hetzelfde als hier: trainingen, schema, kaarten en je gezondheid. Alles wordt hier versleuteld; enkel je gsm krijgt de sleutel.</small></div>
    ${codeHtml || `<ol class="wsteps"><li>Open <b>www.de3p.be</b> op je gsm en zet de app op je beginscherm.</li><li>Kies daar <i>Met mijn computer</i>.</li><li>Klik hier op <i>Toon koppelcode</i> en typ de code op je gsm.</li></ol>`}
    <div class="btns tight">${code ? '' : `<button class="btn primary" data-action="phone-pair" ${S.phoneBusy ? 'disabled' : ''}>Toon koppelcode</button>`}</div></div>`;
}

const CONN_ORDER = ['gsm', 'strava', 'apple', 'notion', 'garmin', 'whoop', 'oura', 'polar', 'withings', 'intervals'];   // vaste volgorde: gsm, Strava, Notion, de rest
function connList() {
  const st = S.settings;
  const list = CONNS.filter((c) => c.k !== 'pc' && (c.k !== 'notion' || st.notion) && (!c.app || st.web?.apple)
      && (WEB() ? !c.desk && (c.app || c.k === 'strava' || c.k === 'notion' || (c.k === 'garmin' ? st.garmin : st.wear?.[c.k])) : !c.web))
    .sort((a, b) => CONN_ORDER.indexOf(a.k) - CONN_ORDER.indexOf(b.k));
  // horloges, ringen, weegschaal en intervals.icu die je (nog) niet gebruikt: samen onder één rij
  const spare = list.filter((c) => c.wear && !connState(c).on);
  const shown = S.connMore || spare.length < 2 ? list : list.filter((c) => !spare.includes(c));
  const more = !S.connMore && spare.length >= 2 ? `<button class="crow" data-action="conn-more"><span class="mark" style="--b:#2a2a2a">+</span>
      <span class="crow-t"><b>Meer koppelingen</b><small>${spare.map((c) => c.n).join(', ')}</small></span><span class="chev">${ICON.down}</span></button>` : '';
  return `<section class="panel clist">${shown.map((c) => {
    const s = connState(c); const open = S.conn === c.k;
    return `<button class="crow${open ? ' open' : ''}" data-conn="${c.k}" aria-expanded="${open}">
        <span class="mark" style="--b:${c.b}">${c.m}</span>
        <span class="crow-t"><b>${esc(c.n)}</b><small class="${s.on ? 'on' : ''}">${esc(s.txt)}</small></span>
        <span class="chev">${ICON.down}</span></button>
      ${open ? `<div class="crow-d settings">${connDetail(c)}</div>` : ''}`;
  }).join('')}${more}</section>`;
}
function connGrid() {
  const sel = CONNS.find((c) => c.k === S.conn);
  const st = S.settings;
  // enkel wat je echt kan koppelen; Notion enkel als je schema er al uit komt. Op de gsm: horloges enkel als je computer ze heeft.
  const tiles = CONNS.filter((c) => (c.k !== 'notion' || st.notion) && (!c.app || st.web?.apple) && (WEB() ? !c.desk && (c.app || c.k === 'strava' || (c.k === 'garmin' ? st.garmin : st.wear?.[c.k]))
    : !c.web)).map((c) => {
    const s = connState(c);
    return `<button class="conn${s.on ? ' on' : ''}${S.conn === c.k ? ' sel' : ''}" data-conn="${c.k}" aria-expanded="${S.conn === c.k}">
      <span class="mark" style="--b:${c.b}">${c.m}</span><b>${esc(c.n)}</b><small>${esc(s.txt)}</small></button>`;
  }).join('');
  return `<div class="conns">${tiles}</div>${sel ? `<section class="panel settings conn-detail">${connDetail(sel)}</section>` : ''}`;
}

// gsm: de koppeling met je computer is de belangrijkste, dus altijd open bovenaan
function pcCard() {
  const w = S.settings.web || {};
  const head = (txt, on) => `<div class="pc-head"><span class="mark">${PC_ICON}</span><div><div class="v">dE3p op je computer</div>
    <small class="pc-state${on ? ' on' : ''}">${txt}</small></div></div>`;
  if (w.pc) {
    return `<section class="panel pc-card">${head(`Gekoppeld${w.made ? ` · laatste kopie ${esc(syncWhen(w.made))}` : ''}`, true)}
      <p class="muted small">Je computer stuurt elk half uur een nieuwe kopie van je trainingen, schema, kaarten en gezondheid. Meteen de nieuwste? Tik rechtsboven op <i>Bijwerken</i>. Versleuteld: dE3p kan niets lezen.</p>
      <button class="link-btn danger" data-action="web-unpair">Ontkoppelen</button></section>`;
  }
  return `<section class="panel pc-card">${head('Niet gekoppeld', false)}
    <p class="muted small">Open dE3p op je computer → tandwiel → <i>Gsm</i> → <i>Toon koppelcode</i>, en typ die code hier. Dan zie je hier alles van je computer.</p>
    ${pairForm()}</section>`;
}

// gsm, nog niet als app op het beginscherm: dat eerst (een iPhone-app heeft zijn eigen opslag)
function installCard() {
  const w = S.settings.web || {};
  if (w.standalone || !(w.ios || w.android)) return '';
  const steps = w.ios
    ? ['Tik onderaan in Safari op <b>⋯</b> of op <b>Deel</b> (het vierkantje met de pijl).', 'Kies <b>Zet op beginscherm</b> en tik op <b>Voeg toe</b>.', 'Open dE3p voortaan met het icoon op je beginscherm.']
    : ['Tik rechtsboven in Chrome op <b>⋮</b>.', 'Kies <b>App installeren</b> (of <b>Toevoegen aan startscherm</b>).', 'Open dE3p voortaan met het icoon op je startscherm.'];
  return `<section class="panel install-card"><div class="v">Zet dE3p op je beginscherm</div>
    <small class="muted">Dan opent het als een echte app: volledig scherm, zonder adresbalk.${w.ios && !w.pc ? ' Doe dit eerst en koppel daarna in de app.' : ''}</small>
    <ol class="steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    ${w.canInstall ? '<button class="btn primary" data-action="web-install">Installeer dE3p</button>' : ''}</section>`;
}

function vInstellingenWeb() {
  const st = S.settings; const w = st.web || {};
  return `<button class="back" data-view="overzicht">← Terug</button>
    <div class="head"><div><div class="label">dE3p</div><h1 class="title">Instellingen</h1></div></div>
    ${w.demo ? `<section class="panel settings"><div class="set-row"><div><div class="v">Je bekijkt voorbeeldgegevens</div><small class="muted">Niets hiervan is van jou. Koppel je computer of Strava om je eigen trainingen te zien.</small></div>
      <div class="btns tight"><button class="btn primary" data-action="web-demo-stop">Stoppen</button></div></div></section>` : ''}
    ${installCard()}
    <h2 class="set-h">Je computer</h2>
    ${pcCard()}
    <h2 class="set-h">Koppelingen</h2>
    ${connList()}
    <h2 class="set-h">Schema's</h2>
    <section class="panel settings">${goalsRow()}</section>
    <h2 class="set-h">Weergave en hulp</h2>
    <section class="panel settings">
      <div class="set-row"><div><div class="v">Weergave</div><small class="muted">Alles in het zwart of in het wit.</small></div>
        <div class="seg" role="group" aria-label="Weergave">${[['dark', 'Donker'], ['light', 'Licht']].map(([k, l]) =>
          `<button data-theme-set="${k}" class="${(st.theme || 'dark') === k ? 'on' : ''}" aria-pressed="${(st.theme || 'dark') === k}">${l}</button>`).join('')}</div></div>
      <div class="set-row"><div><div class="v">Handleiding</div><small class="muted">Alle stappen met prentjes.</small></div>
        <div class="btns tight"><button class="btn" data-action="website">Open</button></div></div>
    </section>
    <h2 class="set-h">Op deze gsm</h2>
    <section class="panel settings">
      <div class="set-row"><div><div class="v">Alles wissen</div><small class="muted">Koppelingen, schema en gegevens op deze gsm. Je computer en Strava blijven zoals ze zijn.</small></div>
        <div class="btns tight"><button class="btn" data-action="web-reset">Wissen</button></div></div>
    </section>`;
}

function vInstellingen() {
  if (WEB()) return vInstellingenWeb();
  const st = S.settings;
  return `<button class="back" data-view="overzicht">← Terug</button>
    <div class="head"><div><div class="label">dE3p ${esc(st.version || '')}</div><h1 class="title">Instellingen</h1></div></div>
    <h2 class="set-h">Koppelingen</h2>
    ${connList()}
    <h2 class="set-h">Schema's</h2>
    <section class="panel settings">${goalsRow()}</section>
    <h2 class="set-h">Namen op Strava</h2>
    <section class="panel settings">
      <label class="set-row toggle"><div><div class="v">Trainingen hernoemen naar je schema</div>
        <small class="muted">Enkel trainingen met een standaardnaam ("Ochtendloop") op een dag met een geplande training.</small></div>
        <input type="checkbox" id="renameToggle" ${st.rename !== false ? 'checked' : ''}><span class="knob"></span></label>
      ${titleBlock()}
    </section>
    <h2 class="set-h">Recap-kaarten</h2>
    <section class="panel settings">
      <div class="set-row"><div><div class="v">Kaartenmap</div><div class="path">${esc(st.cardsDir)}</div>
        <small class="muted">Per maand een map. Kies je een andere map, dan blijven bestaande kaarten in de oude.</small></div>
        <div class="btns tight"><button class="btn" data-action="folder">Open map</button><button class="btn" data-action="pick-folder">Andere map</button></div></div>
      ${cardSportsRow()}
    </section>
    <h2 class="set-h">Programma</h2>
    <section class="panel settings">
      ${autoSyncRow()}
      <div class="set-row"><div><div class="v">Weergave</div><small class="muted">Het hele programma in het zwart of in het wit.</small></div>
        <div class="seg" role="group" aria-label="Weergave">${[['dark', 'Donker'], ['light', 'Licht']].map(([k, l]) =>
          `<button data-theme-set="${k}" class="${(st.theme || 'dark') === k ? 'on' : ''}" aria-pressed="${(st.theme || 'dark') === k}">${l}</button>`).join('')}</div></div>
      ${versionRow()}
    </section>
    <h2 class="set-h">Hulp</h2>
    <section class="panel settings">
      <div class="set-row"><div><div class="v">Handleiding</div><small class="muted">Alle stappen met schermafbeeldingen, voor Windows, Mac en je gsm.</small></div>
        <div class="btns tight"><button class="btn" data-action="manual">Open</button><button class="btn" data-action="website">Website</button></div></div>
    </section>
    <details class="adv"${S.advOpen ? ' open' : ''}><summary class="set-h">Geavanceerd</summary>
    <section class="panel settings">
      ${aiRow()}
      ${browserRow()}
      ${st.platform === 'win32' ? '<div class="set-row"><div><div class="label">Snelkoppeling</div><div class="v">Bureaublad en Startmenu</div><small class="muted">Opnieuw maken als je ze kwijt bent. Op je taakbalk: rechtsklik op <i>dE3p</i> in het Startmenu → <i>Aan taakbalk vastmaken</i>.</small></div><div class="btns tight"><button class="btn" data-action="shortcut">Maak snelkoppeling</button></div></div>' : ''}
      <div class="set-row"><div><div class="label">Gegevens</div><div class="path">${esc(st.dataDir)}</div>
        <small class="muted">Je sleutels, instellingen en schema. Blijven op deze computer.</small></div>
        <div class="btns tight"><button class="btn" data-action="data-folder">Open map</button></div></div>
    </section></details>`;
}

// formulier: zwemschema
function vExtraForm() {
  const sp = 'swim';
  const eg = S.xEdit ? goalsList().find((g) => g.id === S.xEdit) : null;          // wijzigen: dat doel invullen
  const c = { ...(eg?.sports?.[sp]?.config || {}), ...nonNull(S.xPrefill) };   // uit je tekst (lokale AI) gaat voor
  const opt = (v, l, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const days = c.days || [2, 5];
  const busy = busyDays(eg?.id);
  const dayBoxes = DS.map((d, i) => `<label class="daybox"><input type="checkbox" name="days" value="${i}"${days.includes(i) ? ' checked' : ''}><span>${d}${busy[i].length
    ? `<small class="bds">${[...new Set(busy[i].map((b) => b.sp))].map((s) => `<i class="bd ${s}"></i>`).join('')}</small>` : ''}</span></label>`).join('');
  const busyNote = busy.some((b) => b.length) ? `<p class="muted small gq-busy">Al gepland: ${[...new Map(busy.flat().map((b) => [`${b.sp}|${b.from}`, b])).values()]
    .map((b) => `<span class="bd-l"><i class="bd ${b.sp}"></i>${esc(XS[b.sp])} · ${esc(b.from)}</span>`).join('')}</p>` : '';
  const t = todayIso();
  const swim = `
    <label class="field span3"><span class="label">Doel</span>
      <select class="input" name="goal">${Object.entries(SWIM_GOALS).map(([k, l]) => opt(k, l, c.goal || 'afstand')).join('')}</select></label>
    <label class="field"><span class="label">Doelafstand</span>
      <select class="input" name="distance">${[400, 750, 1000, 1500, 1900, 2000, 3000, 3800].map((m) => opt(m, `${nlNum(m)} m`, c.distance || 1500)).join('')}</select></label>
    <label class="field"><span class="label">Nu zonder stoppen</span>
      <input class="input" type="number" name="current" min="50" max="5000" step="50" required value="${esc(c.current ?? 400)}"><small>Hoeveel meter zwem je nu aan één stuk?</small></label>
    <label class="field"><span class="label">Je tempo nu (per 100 m)</span>
      <input class="input" name="pace" placeholder="2:30" value="${esc(c.paceSec ? fmtPaceS(c.paceSec) : '2:30')}"><small>Rustig tempo, mm:ss</small></label>
    <label class="field"><span class="label">Doeltijd (optioneel)</span>
      <input class="input" name="goalTime" placeholder="bv. 30:00" value="${esc(c.goalSec ? fmtTime(c.goalSec) : '')}"><small>Voor die afstand, mm:ss of u:mm:ss</small></label>
    <label class="field"><span class="label">Wedstrijddatum (optioneel)</span>
      <input class="input" type="date" name="raceDate" min="${addDays(t, 14)}" value="${esc(c.raceDate && c.raceDate > t ? c.raceDate : '')}"><small>Anders: aantal weken hieronder</small></label>`;
  return `<div class="setup-wrap"><button class="back" data-view="doelen">← Je doelen</button>
    <div class="head"><div><div class="label">Doel · ${XS[sp].toLowerCase()}</div><h1 class="title">Je zwemschema</h1></div></div>
    ${queueNote()}
    <section class="panel setup"><form data-form="extra" data-sport="${sp}" class="form form-3" autocomplete="off">
      ${swim}
      <div class="field span3"><span class="label">Op welke dagen?</span><div class="daypick">${dayBoxes}</div>
        <small>1 tot 3 zwembeurten per week.</small>${busyNote}</div>
      <label class="field"><span class="label">Hoe lang</span>
        <select class="input" name="weeks">${[6, 8, 10, 12, 16].map((w) => opt(w, `${w} weken`, c.weeks || 8)).join('')}</select></label>
      ${goalNote(eg?.id, { [sp]: { config: { days } } }, 'span3')}
      <div class="btns span3 end"><button class="btn" type="button" data-view="doelen">Annuleren</button><button class="btn primary" type="submit">${eg ? 'Bewaar' : 'Maak mijn schema'}</button></div>
    </form></section></div>`;
}
// ---- lokale AI bij je doel: is ze er (enkel op de computer), en wat ze uit je tekst haalde invullen ----------
async function aiOn() {
  if (WEB()) return false;
  if (!S.ai) { try { S.ai = await api().ai_status(); } catch { S.ai = { running: false }; } }
  return Boolean(S.ai?.running && S.ai?.hasModel);
}
const AI_KEYS = ['goal', 'level', 'days', 'minutes', 'place', 'cardio', 'weeks'];
function applyAi(st, note, ans) {
  const a = st.a;
  st.fromText = {};
  a.notes = { ...(a.notes || {}), goal: note };                         // wat je schreef blijft zichtbaar; de titel wordt het doel zelf
  a.text = ''; a.guessed = false; a.ai = true;
  for (const k of AI_KEYS) {
    if (ans[k] == null) continue;
    a[k] = ans[k]; st.fromText[k] = true;
    if (st.fromData) st.fromData[k] = false;
  }
  if (ans.careful) a.careful = true;
  if (ans.until) a.until = ans.until;
  // meerdere doelen in één zin ("fitter én een halve marathon"): elk wordt een doel
  const goals = new Set([ans.goal].filter(Boolean));
  const low = note.toLowerCase();
  if (ans.race) goals.add('lopen');
  if (/afval|slank|fitter|kilo/.test(low)) goals.add('slank');
  if (/zwem/.test(low)) goals.add('zwemmen');
  if (goals.has('lopen')) {                                              // wedstrijd: het loopschema, alvast ingevuld
    const r = ans.race || {};
    S.planPrefill = { distance: r.distance, raceDate: r.date, goalSec: r.goalSec, raceName: r.name,
      runDays: ans.days ? Math.min(6, Math.max(3, ans.days.length)) : undefined, baseKm: st.prof?.run?.km ? Math.round(st.prof.run.km) : undefined };
  }
  S.xPrefill = { days: ans.days, weeks: ans.weeks };   // zwemmen: alvast ingevuld
  if (startGoals(st, [...goals])) return undefined;                      // geen vragenlijst nodig: meteen de formulieren
  st.fromText.goal = true;
  const steps = gqSteps();
  const i = steps.findIndex((s, j) => j > st.step && s.type !== 'info' && !known(st, s.k));
  st.step = i < 0 ? steps.length : i;                                   // naar de eerste vraag die nog open staat
  render(); $main.scrollTop = 0;
  return undefined;
}
// volgende vraag; wat je lokale AI al uit je tekst haalde, wordt overgeslagen (met Vorige kan je het nog aanpassen)
const known = (st, k) => Boolean(st.fromText?.[k] || st.fromData?.[k]);   // al ingevuld uit je trainingen of je tekst
function nextStep(st) {
  const steps = gqSteps();
  if (st.jumpBack) { st.jumpBack = false; return steps.length; }           // via 'Wijzig' gekomen: terug naar de samenvatting
  let i = st.step + 1;
  while (i < steps.length && known(st, steps[i].k)) i += 1;
  return i;
}
// meer doelen tegelijk: fitter/gezond gaan samen in de vragenlijst; een wedstrijd of zwemmen krijgt daarna
// elk zijn eigen formulier, één voor één (S.goalQueue)
const Q_GOALS = ['slank', 'gezond'];
const QUEUE_NAME = { lopen: 'je wedstrijd', zwemmen: 'je zwemschema' };
function startGoals(st, goals) {
  const q = Q_GOALS.filter((x) => goals.includes(x));
  S.goalQueue = ['lopen', 'zwemmen'].filter((x) => goals.includes(x));
  if (q.length) { st.a.goals = q; st.a.goal = q[0]; return false; }
  return nextQueued();
}
// na het bewaren van een doel: eerst je gegevens opnieuw (zodat het volgende formulier de nieuwe dagen kent), dan het volgende
async function continueQueue() {
  if (!S.goalQueue?.length) return false;
  if (S.data) { try { S.data = await api().refresh(); } catch { /* het formulier werkt ook zonder */ } }
  return nextQueued();
}
function nextQueued() {
  const k = (S.goalQueue || []).shift();
  if (!k) return false;
  goalForm(k);
  return true;
}
const queueNote = () => (S.goalQueue?.length ? `<div class="note">Hierna nog: ${esc(S.goalQueue.map((k) => QUEUE_NAME[k]).join(' en '))}.</div>` : '');
// ---- een nieuw doel naast je loopschema: wat is zwaar, wanneer is je wedstrijd -------------------
function planLoad() {
  const load = {};
  for (const r of S.data?.schema?.length ? planRows() : []) {
    const t = `${r.title} ${r.structure || ''}`.toLowerCase();
    load[r.date] = r.rest ? 'rest' : r.kind === 'race' || isRaceDay(r.date) ? 'race'
      : r.kind === 'long' || /lange/.test(t) ? 'long'
        : ['tempo', 'interval', 'mp', 'threshold'].includes(r.kind) || /interval|tempo|marathonpace|mp-|wedstrijdtempo|tune-up|drempel|fartlek|heuvel/.test(t) ? 'hard' : 'easy';
  }
  return load;
}
function goalCtx() {
  const race = S.data?.race?.date && S.data.race.date >= todayIso() ? S.data.race.date : null;
  const long = /marathon|halve|half|21|42/i.test(`${S.data?.race?.name || ''} ${S.settings.plan?.distance || ''}`);
  return { race, taper: long ? 14 : 7, load: planLoad() };
}
// in de samenvatting: hoe dit doel rekening houdt met je loopschema en je wedstrijd
function fitNote(plans) {
  const c = goalCtx(); const bits = [];
  if ((plans?.ride || plans?.run || plans?.swim) && runPlanEnd() >= todayIso()) bits.push('fietsen en zwemmen naast je loopschema enkel rustig');
  if (c.race) bits.push(`in je taper lichter, in je raceweek kort en rustig, en rond je wedstrijd (${nlShort(c.race)}) niets extra`);
  return bits.length ? `<div class="note">Afgestemd op je loopschema: ${esc(bits.join('; '))}.</div>` : '';
}
// wat er die dag al staat (loopschema en je andere doelen), om naast je nieuwe trainingen te tonen
function besides(date) {
  if (!S.data) return [];
  const names = new Map(goalsList().map((g) => [g.id, goalName(g)]));
  return [
    ...planRows().filter((r) => r.date === date && !r.rest).map((r) => ({ sp: 'run', t: r.title, from: S.data.race?.name || 'loopschema' })),
    ...extraRows().filter((x) => x.date === date && x.goal !== S.gqEdit).map((x) => ({ sp: x.sport, t: cap(x.title.replace(/^(Zwemmen|Lopen|Fietsen) · /, '')), from: names.get(x.goal) || '' })),
  ];
}
const nonNull = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null));
// ---- Doel: dE3p kijkt eerst naar je trainingen, vult de vragen alvast in, en je kan overal zelf typen ----------
const GQ_ALL = [
  { k: 'profile', q: 'Dit zien we van jou', type: 'info', ph: 'bv. knie wat gevoelig, of: weinig tijd in de week' },
  { k: 'goal', q: 'Wat wil je bereiken?', type: 'multi', sub: 'Kies er één of meer: elk wordt een doel, en ze lopen samen.', opts: () => Object.entries(GOALS).map(([v, g]) => [v, g.t, g.d]), ph: 'bv. fitter worden en een paar kilo kwijt tegen de zomer', area: true },
  { k: 'level', q: 'Hoe fit ben je nu?', opts: () => Object.entries(LEVELS).map(([v, t]) => [v, t]), ph: 'bv. ik loop 3 keer per week 10 km' },
  { k: 'days', q: 'Op welke dagen kan je trainen?', type: 'days', sub: 'Kies 2 tot 6 dagen. Een rustdag tussendoor is goed: daar word je sterker.', ph: 'bv. maandag, woensdag en in het weekend' },
  { k: 'minutes', q: 'Hoeveel tijd heb je per training?', opts: () => [[30, '30 minuten'], [45, '45 minuten'], [60, 'Een uur'], [75, 'Langer dan een uur']], ph: 'bv. hooguit 40 minuten' },
  { k: 'cardio', q: 'Wat doe je graag voor je conditie?', type: 'multi', opts: () => Object.entries(CARDIO), sub: 'Kies er één of meer: dE3p wisselt af.', ph: 'bv. fietsen en af en toe zwemmen' },
  { k: 'weeks', q: 'Hoe lang wil je ervoor gaan?', opts: () => [[8, '8 weken', 'Een eerste blok'], [12, '12 weken', 'Genoeg om echt verschil te zien'], [16, '16 weken', 'Voor een grote verandering'], [52, 'Doorlopend', 'Een vaste routine: een heel jaar, daarna vernieuw je het']], ph: 'bv. tot de zomer, 10 weken, of: altijd, een routine' },
];
const gqSteps = () => GQ_ALL.filter((g) => g.k !== 'profile' || S.gq?.prof);
// wat je laatste 8 weken zeggen: hoe actief, welke dagen, hoe lang, welke sporten, welk tempo.
// Na een pauze van 2 weken of meer telt enkel de tijd sinds je herstart (anders tellen de pauzeweken mee als 0).
function activityProfile() {
  if (!S.data) return null;
  const td = todayIso();
  const all = ACTS().filter((a) => a.date > addDays(td, -56) && a.date <= td);
  const dates = [...new Set(all.map((a) => a.date))].sort();
  let start = addDays(td, -55);
  [addDays(td, -56), ...dates].forEach((d, i, arr) => {
    const next = arr[i + 1];
    const gap = next ? Math.round((d8(next) - d8(d)) / 864e5) : 0;
    if (gap >= 15) start = next;                                         // pauze (of nog niet begonnen): vanaf de eerste training erna
  });
  const acts = all.filter((a) => a.date >= start);
  if (acts.length < 2) return null;
  const W = Math.max(1, (Math.round((d8(td) - d8(start)) / 864e5) + 1) / 7);   // weken sinds de start (vandaag meegeteld)
  const since = start > addDays(td, -55) ? start : null;
  const before = since ? ACTS().filter((a) => a.date < start).map((a) => a.date).sort().pop() : null;
  const pause = before ? Math.round((d8(start) - d8(before)) / 864e5) - 1 : 0;   // hoe lang je pauze was (in dagen)
  const med = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const n = {}; for (const a of acts) n[sportOf(a)] = (n[sportOf(a)] || 0) + 1;
  const days = [...new Set(acts.map((a) => a.date))];
  const dow = DS.map((_, i) => days.filter((d) => wd(d) === i).length);
  const usual = dow.map((c, i) => [c, i]).filter(([c]) => c >= Math.max(2, Math.round(W * 0.375))).sort((p, q) => q[0] - p[0]).slice(0, 6).map(([, i]) => i).sort((p, q) => p - q);
  const runs = acts.filter((a) => sportOf(a) === 'run' && a.km > 1);
  const fastRuns = runs.filter((a) => a.km >= 4 && a.pace);
  const h = (S.glance?.history || []).filter((d) => d.status?.vo2max);
  const vo2 = h.length ? h[h.length - 1].status.vo2max : null;
  const perWeek = days.length / W;
  return {
    perWeek, sessions: acts.length / W, hours: acts.reduce((x, a) => x + (a.time || 0), 0) / 3600 / W, minMed: med(acts.map((a) => (a.time || 0) / 60)),
    usual, n, level: perWeek >= 3 ? 'vaak' : perWeek >= 1 ? 'soms' : 'start',
    cardio: ['run', 'ride', 'swim'].filter((sp) => (n[sp] || 0) >= 2).sort((p, q) => n[q] - n[p]),
    run: runs.length ? { perWeek: runs.length / W, km: runs.reduce((x, a) => x + a.km, 0) / W, longest: Math.max(...runs.map((a) => a.km)),
      easy: med(runs.map((a) => a.pace)), fast: fastRuns.length ? Math.min(...fastRuns.map((a) => a.pace)) : null, min: med(runs.map((a) => a.time / 60)) } : null,
    vo2, since, pause, weeks: W,
    span: since ? `sinds ${nlShort(since)}` : '8 weken',
  };
}
const nearest = (opts, v) => opts.reduce((p, q) => (Math.abs(q - v) < Math.abs(p - v) ? q : p));
// je doel in je eigen woorden → het doel dat het best past
function guessGoal(text) {
  const s = String(text || '').toLowerCase();
  if (/zwem/.test(s)) return 'zwemmen';
  const slank = /afval|slank|vet|gewicht|kilo|\bkg\b|buik|lichter/.test(s);
  if (!slank && /marathon|wedstrijd|\d+\s?km|\b\d+k\b|halve|sneller lopen|loop|lopen|run/.test(s)) return 'lopen';
  if (slank) return 'slank';
  if (/fit|conditie|uithouding/.test(s)) return 'slank';
  return 'gezond';
}
// wat je zelf typt bij een vraag → het antwoord (of null als dE3p het niet begrijpt)
const WDN = [['maandag', 0], ['dinsdag', 1], ['woensdag', 2], ['donderdag', 3], ['vrijdag', 4], ['zaterdag', 5], ['zondag', 6],
  ['ma', 0], ['di', 1], ['wo', 2], ['do', 3], ['vr', 4], ['za', 5], ['zo', 6]];
const SPREAD = { 2: [1, 4], 3: [0, 2, 5], 4: [0, 2, 4, 6], 5: [0, 1, 3, 4, 6], 6: [0, 1, 2, 4, 5, 6] };
const MONTH_IX = { jan: 0, feb: 1, maa: 2, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };
function parseNote(k, text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s) return null;
  if (k === 'profile') return /blessure|pijn|knie|enkel|rug|heup|scheen|achilles|kuit|hamstring|voet/.test(s) ? { careful: true } : null;
  if (k === 'goal') return { goal: guessGoal(s) };
  if (k === 'level') {
    const m = s.match(/(\d+)\s*(x|keer|maal|dagen)/);
    if (m) return { level: Number(m[1]) >= 3 ? 'vaak' : Number(m[1]) >= 1 ? 'soms' : 'start' };
    if (/begin|nul|nooit|start|lang niet/.test(s)) return { level: 'start' };
    if (/regelmatig|vaak|elke dag|dagelijks|veel|marathon/.test(s)) return { level: 'vaak' };
    if (/soms|af en toe|weinig|nu en dan/.test(s)) return { level: 'soms' };
    return null;
  }
  if (k === 'days') {
    const set = new Set();
    for (const [w, i] of WDN) if (new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(s)) set.add(i);
    if (/weekend/.test(s)) { set.add(5); set.add(6); }
    if (/weekdag|werkdag|in de week/.test(s)) [0, 1, 2, 3, 4].forEach((i) => set.add(i));
    const m = s.match(/(\d)\s*(dagen|keer|x)/);
    if (!set.size && m) return { days: SPREAD[Math.max(2, Math.min(6, Number(m[1])))] };
    return set.size >= 2 ? { days: [...set].sort((p, q) => p - q).slice(0, 6) } : null;
  }
  if (k === 'minutes') {
    let v = null;
    const m = s.match(/(\d+)\s*(min|')/); if (m) v = Number(m[1]);
    const u = s.match(/(\d+(?:[.,]\d+)?)\s*(u\b|uur)/); if (u) v = parseFloat(u[1].replace(',', '.')) * 60;
    if (/half uur/.test(s)) v = 30; if (/kwartier/.test(s)) v = 15; if (!v && /(een|1) uur/.test(s)) v = 60;
    return v ? { minutes: nearest([30, 45, 60, 75], v) } : null;
  }
  if (k === 'place') {
    if (/(?<!geen )(?<!zonder )(fitness|gym|sportschool|basic.?fit|zaal)/.test(s)) return { place: 'fitness' };
    if (/(zonder|geen)\s+(\S+\s+)?(gewicht|halter|materiaal|toestel)/.test(s)) return { place: 'thuis' };   // 'thuis zonder gewichten'
    if (/halter|kettlebell|gewicht|dumbbell|stang|elastiek/.test(s)) return { place: 'halters' };
    if (/thuis|geen materiaal|zonder/.test(s)) return { place: 'thuis' };
    return null;
  }
  if (k === 'cardio') {
    const c = [];
    if (/lop|run|jog/.test(s)) c.push('run'); if (/fiets|wielren|mtb|bike|koers/.test(s)) c.push('ride'); if (/zwem/.test(s)) c.push('swim');
    return c.length ? { cardio: c } : null;
  }
  if (k === 'weeks') {
    if (/altijd|routine|doorlopend|blijvend|onbeperkt|geen einde|hele jaar|jaar rond|levenslang|gewoonte|vast ritme/.test(s)) return { weeks: 52 };
    let m = s.match(/(\d+)\s*(weken|week|wk)/); if (m) return { weeks: Math.max(4, Math.min(52, Number(m[1]))) };
    m = s.match(/(\d+)\s*maand/); if (m) return { weeks: Math.max(4, Math.min(52, Math.round(Number(m[1]) * 4.35))) };
    let target = null;
    m = s.match(/(\d{1,2})\s*(jan|feb|maa|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)/);
    const now = new Date();
    if (m) target = new Date(now.getFullYear(), MONTH_IX[m[2]], Number(m[1]));
    else if (/zomer/.test(s)) target = new Date(now.getFullYear(), 5, 21);
    else if (/kerst/.test(s)) target = new Date(now.getFullYear(), 11, 25);
    if (target) {
      if (target < now) target.setFullYear(target.getFullYear() + 1);
      return { weeks: Math.max(4, Math.min(40, Math.round((target - now) / (7 * 864e5)))), until: target };
    }
    return null;
  }
  return null;
}
function describeParse(k, r) {
  if (!r) return '';
  if (r.careful) return 'We houden rekening met je blessure: geen harde loopintervallen, meer fietsen of zwemmen.';
  if (r.goal) return GOALS[r.goal]?.t || '';
  if (r.level) return LEVELS[r.level];
  if (r.days) return r.days.map((d) => DAYS[d]).join(', ');
  if (r.minutes) return `${r.minutes} minuten per training`;
  if (r.cardio) return r.cardio.map((c) => CARDIO[c].toLowerCase()).join(' en ');
  if (r.weeks >= 52) return 'doorlopend, een vaste routine';
  if (r.weeks) return `${r.weeks} weken${r.until ? ` (tot ${r.until.getDate()} ${MON[r.until.getMonth()]})` : ''}`;
  return '';
}
function gqState() {
  if (!S.gq) {
    const g = S.gqEdit ? goalsList().find((x) => x.id === S.gqEdit)?.profile : null;   // wijzigen: dat doel; anders een nieuw
    const prof = activityProfile();
    const a = g ? { goal: g.goal, goals: g.goals || (g.goal ? [g.goal] : []), level: g.level, days: g.days, minutes: g.minutes, place: g.place, cardio: g.cardio, weeks: g.weeks, text: g.text, notes: { ...(g.notes || {}) } }
      : { days: [0, 2, 4], cardio: ['run'], notes: {} };
    const fromData = {};
    if (prof && !g) {                                        // vragen alvast invullen met wat je trainingen zeggen
      a.level = prof.level; fromData.level = true;
      if (prof.usual.length >= 2) { a.days = prof.usual; fromData.days = true; }
      if (prof.minMed) { a.minutes = nearest([30, 45, 60, 75], prof.minMed); fromData.minutes = true; }
      if (prof.cardio.length) { a.cardio = prof.cardio; fromData.cardio = true; }
    }
    S.gq = { step: 0, a, prof, fromData };
  }
  return S.gq;
}
// wat dE3p uit je laatste 8 weken haalt, in gewone zinnen
function profileHtml(p) {
  const nl = (v, d = 1) => (Number.isInteger(v) ? String(v) : v.toFixed(d).replace('.', ','));
  const sp = Object.entries(p.n).sort((x, y) => y[1] - x[1]).map(([k, c]) => `${(SPORT_TABS.find(([s]) => s === k)?.[1] || k).toLowerCase()} ${c}×`).join(', ');
  const items = [
    ['Hoe actief', `${nl(p.perWeek)} trainingsdagen per week · ${hm(p.hours * 3600)} per week`],
    p.since ? ['Sinds', `${nlShort(p.since)}${p.pause ? `: je herstart na ${Math.round(p.pause / 7)} ${Math.round(p.pause / 7) === 1 ? 'week' : 'weken'} pauze` : ''} (${String(Math.round(p.weeks * 10) / 10).replace('.', ',')} weken)`] : null,
    [`Sporten (${p.span})`, sp],
    p.usual.length ? ['Je traint meestal op', p.usual.map((d) => DAYS[d]).join(', ')] : null,
    p.minMed ? ['Een training duurt', `gemiddeld ${Math.round(p.minMed)} minuten`] : null,
    p.run ? ['Lopen', `${nl(p.run.perWeek)}× per week · ${nl(p.run.km)} km per week · langste ${nl(p.run.longest)} km`] : null,
    p.run?.easy ? ['Je tempo', `rustig ± ${pace(p.run.easy)}/km${p.run.fast ? ` · snelste (4 km of meer) ${pace(p.run.fast)}/km` : ''}`] : null,
    p.vo2 ? ['VO2max', nlv(p.vo2)] : null,
  ].filter(Boolean);
  return `<section class="panel gq-prof">${items.map(([k, v]) => `<div class="gq-pr"><span class="label">${k}</span><b>${esc(v)}</b></div>`).join('')}</section>
    <p class="muted gq-sub">Daarmee vullen we de vragen alvast in. Klopt iets niet? Pas het aan of typ het zelf.</p>`;
}
function vGoalForm() {
  const st = gqState(); const a = st.a;
  const steps = gqSteps();
  const asked = steps.filter((g) => g.k !== 'profile' && !known(st, g.k));
  const N = asked.length;
  const done = st.step >= steps.length;
  const head = (i, q, sub = '') => {
    const g = steps[i]; const qn = g ? asked.indexOf(g) + 1 : 0;
    const lab = done ? 'Je schema' : g?.k === 'profile' ? 'Eerst: je trainingen' : qn ? `Vraag ${qn} van ${N}` : 'Aanpassen';
    return `<div class="gq-prog"><i style="width:${Math.round((100 * (i + 1)) / (steps.length + 1))}%"></i></div>
    <div class="head"><div><div class="label">${lab}</div><h1 class="title">${q}</h1></div></div>${sub ? `<p class="muted gq-sub">${sub}</p>` : ''}`;
  };
  if (done) {
    const { plans, profile: pv } = goalPlan({ ...a, perf: st.prof?.run || null, startDate: todayIso(), runUntil: runPlanEnd(), ctx: goalCtx() });
    const all = Object.values(plans).flatMap((p) => p.sessions.map((x) => ({ ...x, sport: p.sport })));
    const w2 = all.filter((x) => x.week === Math.min(2, Number(a.weeks))).sort((x, y) => x.date.localeCompare(y.date));
    const wkMon = mondayOf(w2[0]?.date || addDays(todayIso(), 7));
    const weekDays = DS.map((_, i) => addDays(wkMon, i));
    const re = runPlanEnd();
    const runNote = re && re >= todayIso() && (a.cardio || []).includes('run')
      ? `<div class="note">Lopen: tot ${esc(nlShort(re))} volg je je loopschema${plans.run ? '; daarna plant dit doel je loopjes' : ''}. Zo loop je nooit twee keer op een dag.</div>` : '';
    const notes = Object.entries(a.notes || {}).filter(([, v]) => v && v.trim()).map(([, v]) => `"${esc(v.trim())}"`);
    return `<div class="setup-wrap gq"><button class="back" data-gq-prev>← Vorige</button>${head(steps.length, 'Zo ziet je week eruit', `${esc(pv.title)} · ${a.days.length}× per week · ${a.weeks >= 52 ? 'doorlopend' : `${a.weeks} weken`}. Elke training staat klaar in je pagina; doe je ze, dan vinkt dE3p ze af.`)}
      ${answersHtml(st, pv)}
      ${st.prof ? `<p class="note">Afgestemd op je trainingen ${st.prof.since ? `sinds ${esc(nlShort(st.prof.since))}` : 'van de laatste 8 weken'}${st.prof.run?.easy && plans.run ? `: je rustige looptempo (± ${pace(st.prof.run.easy)}/km)${st.prof.run.fast && !a.careful ? ' en je snelste tempo' : ''} zit in elke loop` : ''}.${a.careful ? ' Omdat je een blessure noemde: geen loopintervallen, en waar het kan fietsen in plaats van lopen.' : ''}${notes.length ? ` Wat je schreef: ${notes.join(' · ')}.` : ''}</p>` : notes.length ? `<p class="note">Wat je schreef: ${notes.join(' · ')}.</p>` : ''}
      <section class="panel gq-week">${weekDays.map((date) => {
        const mine = w2.filter((x) => x.date === date); const other = besides(date);
        if (!mine.length && !other.length) return '';
        return `<div class="gq-day"><div class="d"><b>${DS[wd(date)]}</b><span class="muted small">${d8(date).getDate()}</span></div>
        <div>${mine.map((x) => `<div class="gq-new"><span class="xs-tag ${x.sport}">${XS[x.sport]}</span><b>${esc(x.name.replace(/ — .*/, ''))}</b>
          <span class="muted small"> · ${x.minutes} min</span><div class="muted small">${esc(x.detail)}</div></div>`).join('')}
          ${other.length ? `<div class="gq-other">${other.map((o) => `<span><i class="bd ${o.sp}"></i>${esc(o.t)}${o.from ? ` <em>· ${esc(o.from)}</em>` : ''}</span>`).join('')}</div>` : ''}</div></div>`;
      }).join('')}</section>
      <p class="muted small gq-legend">Vet = dit nieuwe doel. Met een bolletje: wat er die dag al staat.</p>
      ${fitNote(plans)}
      ${a.ai ? `<div class="note gq-ai">De AI las je tekst en vulde ${Object.keys(st.fromText || {}).length} vragen in. Ze draait op je eigen computer: je tekst gaat nergens naartoe. De trainingen zelf maakt dE3p met vaste regels.</div>` : ''}${runNote}${goalNote(S.gqEdit, plans)}${queueNote()}
      <div class="btns end"><button class="btn" data-gq-prev>Vorige</button><button class="btn primary" data-action="goal-save">${S.gqEdit ? 'Bewaar dit doel' : 'Maak mijn schema'}</button></div></div>`;
  }
  const g = steps[st.step];
  const note = a.notes?.[g.k] || (g.k === 'goal' ? a.text || '' : '');
  const parsed = describeParse(g.k, parseNote(g.k, note));
  const ai = g.k === 'goal' && S.ai?.running && S.ai?.hasModel;
  const free = `<label class="field gq-free"><span class="label">${g.k === 'profile' ? 'Iets wat dE3p moet weten? (mag leeg blijven)' : ai ? 'Of zeg alles in je eigen woorden: de AI vult de vragen in' : g.k === 'goal' ? 'Of zeg het in je eigen woorden' : 'Of typ het zelf'}</span>
    ${g.area ? `<textarea class="input" name="gqnote" data-k="${g.k}" rows="${ai ? 3 : 2}" maxlength="${ai ? 500 : 200}" placeholder="${esc(ai ? 'bv. tegen de zomer fitter, 3 dagen per week lopen en fietsen, een uur, mijn knie is soms gevoelig' : g.ph)}">${esc(note)}</textarea>`
      : `<input class="input" name="gqnote" data-k="${g.k}" maxlength="160" placeholder="${esc(g.ph)}" value="${esc(note)}">`}
    <small class="gq-parsed" id="gqParsed">${parsed ? `dE3p begrijpt: <b>${esc(parsed)}</b>` : ''}</small></label>`;
  const dataHint = st.fromData?.[g.k] && st.prof ? `<div class="note gq-data">${{
    level: `Ingevuld uit je trainingen: ${String(st.prof.perWeek.toFixed(1)).replace('.', ',')} trainingsdagen per week.`,
    days: `Ingevuld uit je trainingen: je traint meestal op ${st.prof.usual.map((d) => DAYS[d]).join(', ')}.`,
    minutes: `Ingevuld uit je trainingen: gemiddeld ${Math.round(st.prof.minMed)} minuten per training.`,
    cardio: `Ingevuld uit je trainingen: ${st.prof.cardio.map((c) => `${CARDIO[c].toLowerCase()} ${st.prof.n[c]}×`).join(', ')} ${st.prof.since ? `sinds ${nlShort(st.prof.since)}` : 'in 8 weken'}.`,
  }[g.k]}</div>` : '';
  const textHint = st.fromText?.[g.k] ? `<div class="note gq-data gq-ai">Uit je tekst, ingevuld door de AI: <b>${esc(describeParse(g.k, { [g.k]: a[g.k] }))}</b>. Klopt het niet? Kies zelf.</div>` : '';
  let body = '';
  if (g.type === 'info') body = profileHtml(st.prof);
  else if (g.type === 'days') {
    const busy = busyDays(S.gqEdit);
    body = `<div class="daypick big">${DS.map((d, i) => `<button class="dayb${a.days?.includes(i) ? ' on' : ''}" data-gq-toggle="days|${i}" aria-pressed="${Boolean(a.days?.includes(i))}">${d}${busy[i].length ? `<small class="bds">${[...new Set(busy[i].map((b) => b.sp))].map((sp) => `<i class="bd ${sp}"></i>`).join('')}</small>` : ''}</button>`).join('')}</div>
      ${busy.some((b) => b.length) ? `<p class="muted small gq-busy">Al gepland: ${[...new Map(busy.flat().map((b) => [`${b.sp}|${b.from}`, b])).values()].map((b) => `<span class="bd-l"><i class="bd ${b.sp}"></i>${esc(XS[b.sp])} · ${esc(b.from)}</span>`).join('')}<br>Kies liefst andere dagen, of combineer bewust.</p>` : ''}`;
  } else {
    body = `<div class="gq-opts">${g.opts().map(([v, t, d]) => {
      const key = g.k === 'goal' ? 'goals' : g.k;                         // doelen: meer dan één tegelijk
      const on = g.type === 'multi' ? (a[key] || []).includes(v) : String(a[g.k]) === String(v);
      return `<button class="choice${on ? ' on' : ''}" ${g.type === 'multi' ? `data-gq-toggle="${key}|${v}"` : `data-gq-set="${g.k}|${v}"`} aria-pressed="${on}"><b>${esc(t)}</b>${d ? `<span>${esc(d)}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }
  const guess = g.k === 'level' && a.text && a.guessed ? `<div class="note gq-guess">Je schreef: "${esc(a.text)}". Daarbij past: <b>${esc(GOALS[a.goal]?.t || '')}</b>. Klopt het niet? Ga terug en kies zelf.</div>` : '';
  return `<div class="setup-wrap gq">${st.step ? '<button class="back" data-gq-prev>← Vorige</button>' : '<button class="back" data-view="doelen">← Je doelen</button>'}
    ${head(st.step, g.q, g.sub || '')}${guess}${textHint || dataHint}${body}${free}
    <div class="btns end">${st.step ? '<button class="btn" data-gq-prev>Vorige</button>' : ''}<button class="btn primary" data-gq-next ${gqOk(g, a) && !st.thinking ? '' : 'disabled'}>${st.thinking ? '<span class="spinner"></span>dE3p leest je tekst…' : 'Volgende'}</button></div></div>`;
}
// de antwoorden op een rij, met waar ze vandaan komen en 'Wijzig' (ook wat dE3p zelf invulde en dus niet vroeg)
function answersHtml(st, pv) {
  const a = st.a;
  const rows = [
    ['goal', 'Doel', pv.title],
    ['level', 'Hoe fit', LEVELS[a.level]],
    ['days', 'Dagen', (a.days || []).map((d) => DAYS[d]).join(', ')],
    ['minutes', 'Per training', a.minutes ? `${a.minutes} minuten` : ''],
    ['cardio', 'Conditie', (a.cardio || []).map((c) => CARDIO[c].toLowerCase()).join(', ')],
    ['weeks', 'Hoe lang', a.weeks >= 52 ? 'doorlopend (een jaar, daarna vernieuwen)' : a.weeks ? `${a.weeks} weken` : ''],
  ].filter(([k, , v]) => v && gqSteps().some((g) => g.k === k));
  const src = (k) => (st.fromData?.[k] ? 'uit je trainingen' : st.fromText?.[k] ? 'uit je tekst' : '');
  return `<section class="panel gq-ans">${rows.map(([k, l, v]) => `<div class="gq-a"><span class="label">${l}</span>
    <div><b>${esc(v)}</b>${src(k) ? `<small class="muted">${src(k)}</small>` : ''}</div><button class="link-btn" data-gq-jump="${k}">Wijzig</button></div>`).join('')}</section>`;
}
function gqOk(g, a) {
  const note = (a.notes?.[g.k] || (g.k === 'goal' ? a.text : '') || '').trim();
  if (g.type === 'info') return true;
  if (note && parseNote(g.k, note)) return true;
  if (g.type === 'days') return (a.days || []).length >= 2 && a.days.length <= 6;
  if (g.k === 'goal') return (a.goals || []).length > 0 || a.goal != null || Boolean(note);
  if (g.type === 'multi') return (a[g.k] || []).length > 0;
  return a[g.k] != null;
}
async function saveGoal() {
  const st = gqState(); const a = st.a;
  const { profile, plans } = goalPlan({ ...a, perf: st.prof?.run || null, startDate: todayIso(), runUntil: runPlanEnd(), ctx: goalCtx() });
  if (st.prof) profile.basis = { perWeek: st.prof.perWeek, runKm: st.prof.run?.km ?? null, easy: st.prof.run?.easy ?? null, vo2: st.prof.vo2 };
  try {
    await api().save_goal(profile, plans, S.gqEdit || null);
    S.settings = await api().settings();
  } catch (e) {
    return toast(`Doel bewaren mislukt: ${errMsg(e)}`, 8000);
  }
  const edited = Boolean(S.gqEdit);
  S.gq = null; S.gqEdit = null;
  const n = Object.values(plans).reduce((x, p) => x + p.sessions.length, 0);
  toast(edited ? `Doel bijgewerkt: ${n} trainingen in ${profile.weeks} weken` : `Doel erbij: ${n} trainingen in ${profile.weeks} weken`, 6000);
  if (await continueQueue()) return undefined;                           // nog een doel: dat formulier
  S.view = 'doelen';
  if (S.data) await doRefresh(); else render();
  $main.scrollTop = 0;
  return undefined;
}

const fmtPaceS = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

async function saveExtraForm(form) {
  const sp = form.dataset.sport;
  const f = new FormData(form);
  const days = f.getAll('days').map(Number);
  if (!days.length || days.length > 3) return toast('Kies 1 tot 3 dagen per week.', 5000);
  const cfg = { days, weeks: Number(f.get('weeks')), startDate: todayIso(), goal: f.get('goal') };
  let plan;
  {
    const paceSec = parseTime(f.get('pace'));
    if (!paceSec || paceSec < 50 || paceSec > 400) return toast('Tempo per 100 m als m:ss, bv. 2:30', 5000);
    Object.assign(cfg, { distance: Number(f.get('distance')), current: Number(f.get('current')), paceSec,
      goalSec: parseTime(f.get('goalTime')) || null, raceDate: f.get('raceDate') || null });
    if (cfg.raceDate) cfg.goal = 'wedstrijd';
    plan = fitToRace(swimPlan(cfg), goalCtx());
  }
  const c = plan.config;
  const profile = { kind: 'zwemmen', standalone: true, startDate: cfg.startDate, weeks: plan.weeks, days,
    title: `${SWIM_GOALS[c.goal] || 'Zwemmen'}${c.distance ? ` · ${nlNum(Number(c.distance))} m` : ''}`,
    createdAt: new Date().toISOString() };
  try {
    await api().save_goal(profile, { [sp]: plan }, S.xEdit || null);
    S.settings = await api().settings();
  } catch (e) {
    return toast(`Schema bewaren mislukt: ${errMsg(e)}`, 8000);
  }
  toast(`${XPLAN[sp]} ${S.xEdit ? 'bijgewerkt' : 'erbij'}: ${plan.sessions.length} zwembeurten in ${plan.weeks} weken`, 6000);
  S.xEdit = null; S.xPrefill = null;
  if (await continueQueue()) return undefined;
  S.view = 'doelen';
  if (S.data) await doRefresh(); else render();
  $main.scrollTop = 0;
  return undefined;
}

function versionRow() {
  const st = S.settings; const u = S.update;
  let v = `Versie ${esc(st.version || '')}`;
  let sub = 'Het programma kijkt zelf of er een nieuwe versie is.';
  let btn = '<button class="btn" data-action="update-check">Kijk nu</button>';
  if (u?.newer && st.canUpdate) {
    v = `Nieuwe versie ${esc(u.latest)} beschikbaar`;
    sub = `Je hebt ${esc(st.version || '')}. Met <i>Nu bijwerken</i> haalt het programma de nieuwe versie op, vervangt zichzelf en start opnieuw (±1 minuut). Je koppelingen, schema en instellingen blijven bewaard.`;
    btn = '<button class="btn primary" data-action="update-install">Nu bijwerken</button><button class="btn" data-action="website">Wat is nieuw?</button>';
  } else if (u?.newer) {
    v = `Nieuwe versie ${esc(u.latest)} beschikbaar`;
    sub = `Je hebt ${esc(st.version || '')}. Download de nieuwe versie op de website en vervang het oude programma: je koppelingen, schema en instellingen blijven bewaard.`;
    btn = '<button class="btn primary" data-action="website">Download</button>';
  } else if (u?.latest) {
    sub = 'Je hebt de nieuwste versie.';
  }
  return `<div class="set-row"><div><div class="v">${v}</div><small class="muted">${sub}</small></div>
    <div class="btns tight">${btn}</div></div>`;
}
let autoPending = false;
async function loadAutoSync() {
  const st = S.settings;
  if (!['win32', 'darwin'].includes(st.platform) || st.legacy || S.autoSync !== null || autoPending) return;
  autoPending = true;
  try { S.autoSync = await api().auto_sync(); } catch { S.autoSync = false; }
  autoPending = false;
  if (S.view === 'instellingen') render();
}
function autoSyncRow() {
  const st = S.settings;
  if (!['win32', 'darwin'].includes(st.platform) || st.legacy) return '';
  return `<label class="set-row toggle"><div><div class="v">Automatisch syncen, elk half uur</div>
    <small class="muted">Ook als het programma dicht is: nieuwe trainingen krijgen hun naam op Strava en hun kaart zonder dat je iets moet openen.</small></div>
    <input type="checkbox" id="autoSyncToggle" ${S.autoSync ? 'checked' : ''} ${S.autoSync === null ? 'disabled' : ''}><span class="knob"></span></label>`;
}
// lokale AI (Ollama): voor de titel-zin en om je doel in je eigen woorden te begrijpen; zonder werkt alles met vaste regels
let aiPending = false;
async function loadAi(force = false) {
  if ((S.ai && !force) || aiPending) return;
  aiPending = true;
  try { S.ai = await api().ai_status(); } catch { S.ai = { running: false, model: '' }; }
  aiPending = false;
  if (S.view === 'instellingen') render();
}
function aiRow() {
  const a = S.ai;
  const model = (a?.model || 'mistral-nemo').replace(/:latest$/, '');
  let v = 'Even kijken…'; let sub = ''; let btn = '';
  if (a && !a.running) {
    v = 'Niet geïnstalleerd';
    sub = `Niet nodig: alles werkt zonder (met vaste regels). Met Ollama (gratis) begrijpt dE3p je titel-zin en je doel in je eigen woorden beter: installeer het en daarna het model met <code>ollama pull ${esc(model)}</code>.`;
    btn = '<button class="btn" data-action="ollama">ollama.com</button>';
  } else if (a && !a.hasModel) {
    v = 'Ollama draait, het model ontbreekt';
    sub = `Typ in een terminal <code>ollama pull ${esc(model)}</code> en kijk daarna opnieuw.`;
    btn = `<button class="btn" data-copy="ollama pull ${esc(model)}">Kopieer</button>`;
  } else if (a) {
    v = `Ollama · ${esc(model)}`;
    sub = 'Draait op deze computer: je titel-zin en je doel in je eigen woorden gaan nergens naartoe.';
  }
  return `<div class="set-row"><div><div class="label">AI op deze computer</div><div class="v">${v}</div><small class="muted">${sub}</small></div>
    <div class="btns tight">${btn}<button class="btn" data-action="ai-check">Opnieuw kijken</button></div></div>`;
}

const TITLE_FIELDS = ['training', 'structuur', 'km', 'tijd', 'tempo', 'snelheid', 'hr', 'maxhr', 'hoogte', 'cadans', 'dagdeel', 'weekdag', 'datum'];
// ---- Garmin: herstel (slaap, Body Battery, HRV, gereedheid) en gevoel na een training ----
const SRC = { apple: 'Apple Watch', garmin: 'Garmin', whoop: 'Whoop', oura: 'Oura', polar: 'Polar', withings: 'Withings', intervals: 'intervals.icu' };
const srcName = () => SRC[S.settings.health] || 'Garmin';
const hm = (secs) => (secs ? `${Math.floor(secs / 3600)}u${pad(Math.floor((secs % 3600) / 60))}` : '–');
function garminPanel() {
  if (!S.settings.health) {
    return `<section class="panel garmin-cta"><div><div class="label">Herstel</div>
      <div class="muted small" style="margin-top:4px">Koppel je horloge of ring (Garmin, Whoop, Oura of Polar) om hier je slaap, HRV en herstel te zien.</div></div>
      <button class="btn" data-view="instellingen">Koppelen</button></section>`;
  }
  return `<section class="panel garmin" id="garminPanel"><div class="label">Herstel · ${srcName()}</div><div class="muted small" style="margin-top:8px">Ophalen bij ${srcName()}…</div></section>`;
}
// [niveau, tekst]: good / mid / bad
// extra schema's (zwemmen, lopen, fietsen): gedaan als er die dag een activiteit van die sport is
const XS = { swim: 'Zwemmen', run: 'Lopen', ride: 'Fietsen' };
const XPLAN = { swim: 'Zwemschema', run: 'Loopschema', ride: 'Fietsschema' };
// extra schema's maken: op de computer, of op een gsm zonder computer (met computer komen ze van daar)
const canPlan = () => !WEB() || !S.settings.web?.pc;
const canGoals = () => !WEB() || !S.settings.web?.demo;       // ook met computer: de gsm geeft ze door

// ---- je doelen: meerdere tegelijk, allemaal op één pagina ---------------------------------------
const goalsList = () => (Array.isArray(S.settings.goals) ? S.settings.goals : []);
const goalName = (g) => goalTitle(g).replace(/^"|"$/g, '');
// laatste trainingsdag van je loopschema (Notion of eigen): tot dan plant een doel geen extra loopjes
function runPlanEnd() {
  const ds = (S.data?.schema || []).flatMap((w) => w.rows.filter((r) => !r.rest).map((r) => r.date)).sort();
  return ds.length ? ds[ds.length - 1] : null;
}
function goalSpan(g) {
  const s = Object.values(g.sports || {});
  return [s.map((x) => x.from).sort()[0] || g.profile?.startDate || todayIso(), s.map((x) => x.to).sort().pop() || todayIso()];
}
function goalWeek(g, today = todayIso()) {
  const [from, to] = goalSpan(g);
  const wks = Math.max(1, Math.round((d8(mondayOf(to)) - d8(mondayOf(from))) / (7 * 864e5)) + 1);
  return [Math.min(wks, Math.max(1, Math.floor((d8(today) - d8(mondayOf(from))) / (7 * 864e5)) + 1)), wks];
}
function goalTitle(g) {
  const p = g.profile || {};
  if (p.title) return p.title;
  const [sp, s] = Object.entries(g.sports || {})[0] || [];
  const c = s?.config || {};
  if (sp === 'swim') return `${SWIM_GOALS[c.goal] || 'Zwemmen'}${c.distance ? ` · ${nlNum(Number(c.distance))} m` : ''}`;
  return GOALS[p.goal]?.t || 'Je doel';
}
const goalSportsLine = (g) => `${Object.entries(g.sports || {}).map(([sp, s]) => `${(s.config?.days || []).length}× ${XS[sp].toLowerCase()}`).join(' · ')} per week`;
// per weekdag (ma = 0) wat er al gepland staat: je andere doelen en je loopschema
function busyDays(exceptId) {
  const out = DS.map(() => []);
  for (const g of goalsList()) {
    if (g.id === exceptId) continue;
    for (const [sp, s] of Object.entries(g.sports || {})) (s.config?.days || []).forEach((d) => out[d]?.push({ sp, from: goalName(g) }));
  }
  if (S.data?.schema?.length) {
    const m = mondayOf(todayIso());
    const runs = planRows().filter((r) => !r.rest && r.date >= m && r.date <= addDays(m, 13));
    new Set(runs.map((r) => wd(r.date))).forEach((d) => out[d].push({ sp: 'run', from: S.data.race?.name || 'je loopschema' }));
  }
  return out;
}
// onder een formulier: komt het erbij of past het één doel aan, en botst het met een ander doel?
function goalNote(editId, plans, cls = '') {
  const others = goalsList().filter((g) => g.id !== editId);
  const clash = [];
  for (const [sp, p] of Object.entries(plans || {})) {
    const mine = p.config?.days || [];
    for (const o of others) {
      const both = mine.filter((d) => (o.sports?.[sp]?.config?.days || []).includes(d));
      if (both.length) clash.push(`${XS[sp].toLowerCase()} op ${both.map((d) => DS[d].toLowerCase()).join(', ')} (${goalName(o)})`);
    }
  }
  const lines = [];
  if (editId) lines.push('Dit past enkel dit doel aan. Je andere doelen blijven staan.');
  else if (others.length) lines.push(`Komt erbij. Je andere doelen blijven staan: ${others.map(goalName).join(', ')}.`);
  if (clash.length) lines.push(`Let op, op dezelfde dag staat al: ${clash.join('; ')}.`);
  return lines.length ? `<div class="note ${cls}">${esc(lines.join(' '))}</div>` : '';
}
// doelen met een eigen formulier: een wedstrijd (loopschema) of zwemmen
const GOAL_FORM = { lopen: 'planform', zwemmen: 'swim' };
function goalForm(kind) {
  const f = GOAL_FORM[kind];
  S.gq = null;
  if (f === 'planform') { S.gqEdit = null; return go('planform'); }
  S.extraSport = f; S.xEdit = S.gqEdit || null; S.gqEdit = null;          // wijzig je een doel naar zwemmen: dat doel vervangen
  return go('extraform');
}
// Instellingen: één rij naar 'Je doelen'
function goalsRow() {
  const D = S.data; const st = S.settings;
  const run = D?.race?.name || (st.plan ? st.plan.raceName || DISTANCES[st.plan.distance]?.label : st.notion ? 'Loopschema uit Notion' : '');
  const names = [run, ...goalsList().map(goalName)].filter(Boolean);
  return `<div class="set-row"><div><div class="v">Je doelen${names.length > 1 ? ` <span class="muted">(${names.length})</span>` : ''}</div>
    <small class="muted">${names.length ? esc(names.join(' · ')) : 'Nog geen doel. Een wedstrijd, fitter worden of zwemmen: meerdere tegelijk kan.'}</small></div>
    <div class="btns tight"><button class="btn${names.length ? '' : ' primary'}" data-view="doelen">${names.length ? 'Open' : 'Stel een doel in'}</button></div></div>`;
}
function goalCardHtml({ kind, title, sub, sports, prog, btns }) {
  const chips = sports.map(([sp, days]) => `<span class="dl-sp"><span class="xs-tag ${sp}">${XS[sp]}</span>${esc(days.map((d) => DS[d].toLowerCase()).join(' '))}</span>`).join('');
  return `<article class="panel dl-card">
    <div class="dl-top"><div class="dl-txt"><div class="label">${esc(kind)}</div><h3>${esc(title)}</h3>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>
      ${btns ? `<div class="btns tight">${btns}</div>` : ''}</div>
    ${chips ? `<div class="dl-sports">${chips}</div>` : ''}
    ${prog ? `<div class="ov-prog"><div class="weekline"><span>${esc(prog[0])}</span><span>${esc(prog[1] || '')}</span></div>
      ${prog[2] != null ? `<div class="bar"><i style="width:${Math.round(Math.min(100, prog[2]))}%"></i></div>` : ''}</div>` : ''}
  </article>`;
}
// de pagina 'Je doelen': je loopschema en al je andere doelen naast elkaar, en deze week alles samen
function vDoelen() {
  const D = S.data; const st = S.settings; const w = st.web || {};
  const td = D?.today || todayIso(); const mon = mondayOf(td); const sun = addDays(mon, 6);
  const edit = canGoals();
  const rows = D ? extraRows() : [];
  const cards = [];
  if (D?.race || st.plan || st.notion) {
    const plan = st.plan;
    const fromPc = WEB() && (w.pc || w.demo) && !w.ownPlan;
    const cur = D?.schema?.find((x) => x.rows.some((r) => r.date >= mon && r.date <= sun));
    const kmDone = D ? sumKm(D.runs.filter((r) => r.date >= mon && r.date <= sun)) : 0;
    const runDays = cur ? [...new Set(cur.rows.filter((r) => !r.rest).map((r) => wd(r.date)))].sort((a, b) => a - b) : [];
    const target = D?.race?.goal || (plan?.goalSec ? fmtTime(plan.goalSec) : '');
    cards.push(goalCardHtml({
      kind: 'Wedstrijd', title: D?.race?.name || plan?.raceName || DISTANCES[plan?.distance]?.label || 'Wedstrijd',
      sub: [D?.race?.date || plan?.raceDate ? nlDate(D?.race?.date || plan.raceDate) : '', target ? `doel ${target}` : '', st.notion ? 'uit Notion' : fromPc ? 'van je computer' : ''].filter(Boolean).join(' · '),
      sports: [['run', runDays]],
      prog: cur ? [`Week ${cur.num}${cur.total ? ` van ${cur.total}` : ''}`, `${km(kmDone)}${cur.target ? ` / ${km(cur.target, 0)}` : ''} km`, cur.target ? (100 * kmDone) / cur.target : null] : null,
      btns: st.notion && !WEB() ? '<button class="btn" data-action="notion">Open in Notion</button>'
        : plan && !fromPc ? '<button class="btn" data-view="planform">Wijzig</button><button class="btn" data-action="delete-plan">Verwijderen</button>' : '',
    }));
  }
  for (const g of goalsList()) {
    const [from, to] = goalSpan(g); const [wk, wks] = goalWeek(g, td);
    const mine = rows.filter((x) => x.date >= mon && x.date <= sun && (x.goal ? x.goal === g.id : g.sports[x.sport]));
    const doneN = mine.filter((x) => x.done).length;
    const p = g.profile || {};
    cards.push(goalCardHtml({
      kind: p.standalone ? XPLAN[Object.keys(g.sports)[0]] : 'Doel', title: goalTitle(g),
      sub: [!p.standalone && GOALS[p.goal] && p.title !== GOALS[p.goal].t ? GOALS[p.goal].t : '', `${nlShort(from)} – ${nlShort(to)}`].filter(Boolean).join(' · '),
      sports: Object.entries(g.sports).map(([sp, s]) => [sp, s.config?.days || []]),
      prog: [from > td ? `Start ${nlShort(from)}` : to < td ? 'Afgelopen' : `Week ${wk} van ${wks}`, mine.length ? `${doneN} / ${mine.length} deze week` : '', mine.length ? (100 * doneN) / mine.length : null],
      btns: edit ? `<button class="btn" data-goal-edit="${esc(g.id)}">Wijzig</button><button class="btn" data-action="goal-delete" data-goal="${esc(g.id)}">Verwijderen</button>` : '',
    }));
  }
  const add = edit ? '<button class="btn primary" data-action="goal-new">+ Nieuw doel</button>' : '';
  const empty = cards.length ? '' : `<section class="panel dl-empty"><b>Nog geen doel</b>
      <p class="muted">Een wedstrijd lopen, fitter en slanker worden, gezond in vorm blijven of beter zwemmen: kies wat je wil en dE3p maakt het schema. Meerdere doelen tegelijk kan ook.</p>${add}</section>`;
  return `<button class="back" data-view="${S.doelenBack || 'overzicht'}">← Terug</button>
    <div class="head dl-head"><div><div class="label">Schema's</div><h1 class="title">Je doelen</h1></div>${cards.length ? add : ''}</div>
    <p class="muted dl-sub">${cards.length > 1 ? `${cards.length} doelen tegelijk.` : 'Je kan meerdere doelen tegelijk hebben.'} Elke training staat in je pagina; doe je ze, dan vinkt dE3p ze af.</p>
    ${edit ? '' : '<div class="note">Je doelen komen van je computer. Pas ze daar aan; na de volgende keer bijwerken staan ze ook hier.</div>'}
    <div class="dl-list">${cards.join('')}${empty}</div>
    ${D && cards.length ? weekAll(mon) : ''}`;
}
// deze week, alle doelen samen: per dag wat er gepland staat en wat al gedaan is
function weekAll(mon) {
  const td = S.data?.today || todayIso();
  const names = new Map(goalsList().map((g) => [g.id, goalName(g)]));
  const plan = planRows().filter((p) => p.date >= mon && p.date <= addDays(mon, 6) && !p.rest);
  const ex = extraRows().filter((x) => x.date >= mon && x.date <= addDays(mon, 6));
  const ran = (date) => ACTS().some((a) => a.date === date && sportOf(a) === 'run');
  const days = DS.map((d, i) => {
    const date = addDays(mon, i);
    const items = [
      ...plan.filter((p) => p.date === date).map((p) => ({ sp: 'run', t: p.title, v: kmOf(p.km) ? `${km(kmOf(p.km))} km` : '', done: p.done || ran(date), from: S.data.race?.name || 'loopschema' })),
      ...ex.filter((x) => x.date === date).map((x) => ({ sp: x.sport, t: x.title.replace(/^(Zwemmen|Lopen|Fietsen) · /, ''),
        v: x.meters ? `${nlNum(x.meters)} m` : x.minutes ? `${x.minutes} min` : '', done: x.done, from: names.get(x.goal) || '' })),
    ];
    return `<div class="dl-day${date === td ? ' today' : ''}${date < td ? ' past' : ''}"><div class="d"><b>${d}</b><span>${d8(date).getDate()}</span></div>
      <div class="dl-items">${items.length ? items.map((it) => `<div class="dl-it${it.done ? ' done' : ''}"><span class="xs-tag ${it.sp}">${XS[it.sp]}</span>
        <b>${esc(cap(it.t))}</b><span class="muted small">${esc([it.v, it.from].filter(Boolean).join(' · '))}</span>${it.done ? '<span class="chip done">✓</span>' : ''}</div>`).join('') : '<span class="muted small">Rust</span>'}</div></div>`;
  }).join('');
  return `<h2 class="set-h">Deze week, alles samen</h2><section class="panel dl-week">${days}</section>`;
}
function extraRows() {
  return (S.data?.extra || []).map((x) => ({ ...x, done: ACTS().some((a) => a.date === x.date && sportOf(a) === x.sport) }));
}
const extraOn = (date) => extraRows().filter((x) => x.date === date);
// vandaag: staat er een training gepland, en is die (of een andere activiteit) al gedaan?
function todayState() {
  if (!S.data) return null;
  const td = todayIso();
  const row = planRows().find((r) => r.date === td && !r.rest);
  const did = ACTS().filter((a) => a.date === td);
  const ex = extraOn(td);
  const runDone = Boolean(row?.done) || did.some((a) => sportOf(a) === 'run');
  return { planned: Boolean(row) || ex.length > 0, any: did.length > 0,
    done: (row ? runDone : ex.length ? ex.some((x) => x.done) : did.length > 0) && ex.every((x) => x.done || !row),
    pending: ex.filter((x) => !x.done).map((x) => x.title) };
}
function advice(t) {
  const r = t.readiness?.score; const sl = t.sleep?.score;
  if (r == null && sl == null) return null;
  const lvl = HEAVY.includes(t.status?.label) || (r != null && r < 40) || (sl != null && sl < 50) ? 'bad'
    : (r != null && r < 70) || (sl != null && sl < 70) ? 'mid' : 'good';
  const ts = t.date === todayIso() ? todayState() : null;
  if (ts?.done && ts.pending.length) return ['mid', `Je run zit erop. Nog op de planning: ${ts.pending.join(' en ')}.`];
  if (ts?.done) return [lvl === 'good' ? 'good' : 'mid', lvl === 'good' ? 'Je training van vandaag zit erop. Goed bezig!' : 'Je training van vandaag zit erop. Rust nu goed en slaap op tijd.'];
  if (ts && !ts.planned) return [lvl === 'bad' ? 'mid' : 'good', lvl === 'bad' ? 'Rustdag: precies wat je lichaam nu nodig heeft.' : 'Rustdag vandaag. Geniet ervan.'];
  if (HEAVY.includes(t.status?.label)) return ['bad', t.status.label === 'Gespannen' ? 'Je herstel loopt achter op je belasting: vandaag rustig of rust.' : 'Je belasting is te hoog: vandaag rustig of rust.'];
  if (lvl === 'bad') return ['bad', 'Herstel eerst: vandaag rustig lopen, fietsen of rust.'];
  if (lvl === 'mid') return ['mid', 'Train zoals gepland, maar houd de rustige dagen echt rustig.'];
  return ['good', 'Klaar voor je training van vandaag.'];
}
// tegel met de kleur van de meting (dezelfde kleur als in de grafieken van Gezondheid)
// trainingsstatus van Garmin: wat het betekent, in één regel (namen zoals in de Garmin-handleiding)
const HEAVY = ['Te intensief', 'Gespannen', 'Overbelast'];
const STATUS_TIP = {
  Productief: 'Je conditie gaat vooruit', Aanhouden: 'Je conditie blijft op peil', Piek: 'Klaar voor een wedstrijd',
  Herstel: 'Lichter: je lichaam herstelt', 'Niet productief': 'Belasting goed, maar je conditie daalt', Onttrainen: 'Je conditie zakt: minder getraind',
  'Te intensief': 'Te zware belasting: neem wat rust', Gespannen: 'Herstel en belasting uit balans', 'Geen status': 'Nog te weinig metingen',
};
const mtile = (c, label, value, sub, extra = '', wide = false) => `<div class="mtile c-${c}${wide ? ' wide' : ''}"><div class="label"><i class="mdot"></i>${label}</div>
  <div class="big">${value}</div><div class="muted small">${sub}</div>${extra}</div>`;
const tipLine = (tip) => (tip ? `<div class="rec-tip ${tip[0]}">${tip[0] === 'good' ? ICON.check : ICON.alert}<span>${esc(tip[1])}</span></div>` : '');
function renderGarmin(el, rec) {
  const head = `<div class="ov-h"><div class="label">Herstel · ${srcName()}</div><button class="link-btn" data-view="gezondheid">Gezondheid ›</button></div>`;
  if (!rec || rec.error) {
    el.innerHTML = `${head}<div class="muted small" style="margin-top:8px">${esc(rec?.error || `Geen gegevens van ${srcName()}.`)}</div>`;
    return;
  }
  const t = rec.today || {};
  const stat = (c, label, v, unit, sub) => `<div class="ov-stat c-${c}"><div class="label"><i class="mdot"></i>${label}</div>
    <div class="ov-stat-v">${v ?? '–'}${v != null && unit ? `<small>${unit}</small>` : ''}</div>${sub ? `<div class="muted small">${sub}</div>` : ''}</div>`;
  const r = t.readiness;
  el.innerHTML = `${head}
    <button class="ov-stats" data-view="gezondheid" aria-label="Naar Gezondheid">
      ${stat('sleep', 'Slaap', t.sleep?.score, '', t.sleep?.secs ? hm(t.sleep.secs) : '')}
      ${stat('hrv', 'HRV', t.hrv?.night, 'ms', esc(t.hrv?.status || ''))}
      ${stat('rhr', 'Rust', t.rhr, 'bpm', '')}
      ${t.battery || !r ? stat('bb', 'Battery', t.battery?.now ?? t.battery?.high, '', t.battery?.high != null ? `max ${t.battery.high}` : '')
        : stat('vo2', S.settings.health === 'whoop' ? 'Herstel' : 'Klaar', r.score, S.settings.health === 'whoop' ? '%' : '', esc(r.level || ''))}
    </button>
    ${tipLine(advice(t))}`;
}
async function loadGarmin() {
  const el = document.getElementById('garminPanel');
  if (el) {
    try { renderGarmin(el, await api().garmin_recovery(false)); } catch (e) { renderGarmin(el, { error: errMsg(e) }); }
  }
  document.querySelectorAll('[data-feel]').forEach(async (box) => {
    try {
      const f = await api().garmin_feel(box.dataset.feel, Number(box.dataset.secs || 0));
      if (!box.isConnected || !f || (!f.feel && !f.rpe)) return;
      box.innerHTML = `<div class="label">Hoe voelde het? · volgens je Garmin</div>
        <div class="feel-row">${f.feel ? `<div><div class="big">${esc(f.feel)}</div><div class="muted small">gevoel</div></div>` : ''}
        ${f.rpe ? `<div><div class="big">${f.rpe}<small>/10</small></div><div class="muted small">inspanning</div></div>` : ''}</div>`;
      box.hidden = false;
    } catch { /* geen gevoel ingevuld */ }
  });
}
function garminRow() {
  const st = S.settings;
  if (st.garmin) {
    return `<div class="set-row"><div><div class="label">Garmin</div><div class="v">Gekoppeld</div>
      <small class="muted">Slaap, HRV, rusthartslag, Body Battery, VO2max, stappen en stress (zie Gezondheid), en hoe je trainingen voelden. Onofficiële koppeling: als Garmin iets verandert, kan ze even stoppen.</small></div>
      <div class="btns tight"><button class="btn" data-action="garmin-refresh">Nu bijwerken</button><button class="btn" data-action="garmin-off">Ontkoppelen</button></div></div>`;
  }
  const mfa = S.garminStep === 'mfa';
  return `<div class="set-row stack"><div><div class="label">Garmin</div><div class="v">Koppel je Garmin</div>
      <small class="muted">Log één keer in met je Garmin Connect-account. Je wachtwoord gaat enkel naar Garmin en wordt niet bewaard; op deze computer blijft alleen de sleutel die Garmin teruggeeft.</small></div>
    <form class="garmin-form" data-form="${mfa ? 'garmin-mfa' : 'garmin'}" autocomplete="off">
      ${mfa ? `<input class="input" name="code" inputmode="numeric" placeholder="Code uit je mail of sms" aria-label="Code van Garmin" required>`
        : `<input class="input" name="email" type="email" placeholder="E-mail van je Garmin-account" aria-label="E-mail" required>
           <input class="input" name="password" type="password" placeholder="Wachtwoord" aria-label="Wachtwoord" required>`}
      <button class="btn primary" type="submit" ${S.garminBusy ? 'disabled' : ''}>${S.garminBusy ? '<span class="spinner"></span> Bezig…' : mfa ? 'Bevestig code' : 'Koppel Garmin'}</button>
    </form>
    ${S.garminError ? `<div class="alert" style="margin:0">${esc(S.garminError)}</div>` : ''}</div>`;
}
async function garminSubmit(form) {
  const f = new FormData(form);
  S.garminBusy = true; S.garminError = '';
  render();
  try {
    if (form.dataset.form === 'garmin-mfa') await api().garmin_mfa(String(f.get('code') || ''));
    else {
      const st = await api().garmin_login(String(f.get('email') || ''), String(f.get('password') || ''));
      if (st === 'mfa') { S.garminStep = 'mfa'; return; }
    }
    S.garminStep = '';
    S.settings = await api().settings();
    toast('Garmin gekoppeld');
  } catch (e) {
    S.garminError = errMsg(e);
  } finally {
    S.garminBusy = false;
    render();
  }
}

// ---- Gezondheid: per maand (laatste 12 maanden) of per dag (7 / 30 dagen) ---------------
const nlNum = (n) => Math.round(n).toLocaleString('nl-BE');
const nl1 = (v) => v.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nlv = (v) => (Number.isInteger(v) ? String(v) : nl1(v));      // 59 blijft 59, 59.2 wordt 59,2
const mean = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const STRESS = (v) => (v == null ? '' : v <= 25 ? 'rust' : v <= 50 ? 'laag' : v <= 75 ? 'gemiddeld' : 'hoog');
const lastOf = (hist, f) => { for (let i = hist.length - 1; i >= 0; i -= 1) { const v = f(hist[i]); if (v != null) return [v, hist[i]]; } return [null, null]; };
const dayWord = (d, today) => (d === today ? 'vandaag' : d === addDays(today, -1) ? 'gisteren' : nlShort(d));
const monthName = (m, year = true) => { const [y, mm] = m.split('-').map(Number); return year ? `${MONTHS_FULL[mm - 1]} ${y}` : MONTHS_FULL[mm - 1]; };
const monthShort = (m) => { const [y, mm] = m.split('-').map(Number); return `${MON[mm - 1]} ${y}`; };
const isMonth = () => S.healthDays === 'alles';
// Dag → Maand → Alles: inzoomen of uitzoomen
const HMODES = [['dag', 'Dag'], ['wk', 'Week'], ['kal', 'Maand'], ['alles', 'Alles']];
const DAY_BACK = 400;                // zoveel dagen kan je per dag terugbladeren (garmin.KEEP)

// Eén grafiek per meting (nooit twee schalen in één grafiek). c = kleur (zelfde in tegels en grafieken),
// up = hoger is beter, eps = kleiner verschil telt als gelijk, nk/minN = vanaf hoeveel metingen een maand telt.
// mv/mlo/mgoal = waarde per maand, dv/dv2/dlo/dgoal = waarde per dag.
const HEALTH = [
  { k: 'score', t: 'Slaapscore', c: 'sleep', kind: 'bar', fixed: [0, 100], up: true, eps: 2, nk: 'score', minN: 7,
    mv: (x) => x.v.score, dv: (d) => d.sleep?.score,
    big: (v) => nlv(v), fmt: (v) => `score ${nlv(v)}`, dfmt: (v) => nlv(v),
    dtip: (d) => [d.sleep ? `${hm(d.sleep.secs)} geslapen` : '', d.sleep?.deep != null ? `diep ${hm(d.sleep.deep)} · REM ${hm(d.sleep.rem)}` : ''],
    dhead: (h, td) => { const [v, d] = lastOf(h, (x) => x.sleep?.score); return [mean(h.map((x) => x.sleep?.score)), 'gemiddeld', v != null ? `${dayWord(d.date, td)} ${v}` : '']; } },
  { k: 'dur', t: 'Slaapduur', c: 'sleep', kind: 'bar', zero: true, up: true, eps: 1 / 6, nk: 'secs', minN: 7,
    mv: (x) => (x.v.secs ? x.v.secs / 3600 : null), dv: (d) => (d.sleep?.secs ? d.sleep.secs / 3600 : null),
    big: (v) => hm(v * 3600), fmt: (v) => `${hm(v * 3600)} geslapen`, dfmt: (v) => `${Math.round(v * 60)} min`, axis: (v) => `${v}u`,
    dtip: (d) => [d.sleep?.score != null ? `score ${d.sleep.score}` : '', d.sleep?.awake ? `${Math.round(d.sleep.awake / 60)} min wakker` : ''],
    dhead: (h, td) => { const [v, d] = lastOf(h, (x) => x.sleep?.secs); const m = mean(h.map((x) => x.sleep?.secs)); return [m == null ? null : hm(m), 'gemiddeld', v ? `${dayWord(d.date, td)} ${hm(v)}` : '']; } },
  { k: 'hrv', t: 'HRV', c: 'hrv', kind: 'line', up: true, eps: 2, nk: 'hrv', minN: 7,
    mv: (x) => x.v.hrv, dv: (d) => d.hrv?.night, dv2: (d) => d.hrv?.week, dlegend: ['nacht', '7-daags gemiddelde'],
    big: (v) => `${nlv(v)}<small>ms</small>`, fmt: (v) => `${nlv(v)} ms`, dfmt: (v) => `${nlv(v)} ms`,
    dtip: (d) => [d.hrv?.week ? `7-daags gemiddelde ${d.hrv.week} ms` : '', d.hrv?.status || ''],
    dhead: (h) => { const [, d] = lastOf(h, (x) => x.hrv?.status); return [mean(h.map((x) => x.hrv?.night)), 'ms gemiddeld', d ? d.hrv.status : '']; } },
  { k: 'rhr', t: 'Rusthartslag', c: 'rhr', kind: 'line', up: false, eps: 1, nk: 'rhr', minN: 7,
    mv: (x) => x.v.rhr, dv: (d) => d.rhr,
    big: (v) => `${nlv(v)}<small>bpm</small>`, fmt: (v) => `${nlv(v)} bpm`, dfmt: (v) => `${nlv(v)} bpm`,
    dhead: (h, td) => { const [v, d] = lastOf(h, (x) => x.rhr); return [mean(h.map((x) => x.rhr)), 'bpm gemiddeld', v ? `${dayWord(d.date, td)} ${v}` : '']; } },
  { k: 'bb', t: 'Body Battery', c: 'bb', kind: 'range', fixed: [0, 100], up: true, eps: 3, nk: 'bb', minN: 7,
    mv: (x) => x.v.bb, mlo: (x) => x.v.bblo, dv: (d) => d.battery?.high, dlo: (d) => d.battery?.low,
    big: (v) => nlv(v), fmt: (v) => `hoogste ${nlv(v)}`, dfmt: (v) => nlv(v),
    mtip: (x) => [x.v.bblo != null ? `laagste ${Math.round(x.v.bblo)} (gemiddeld)` : ''], dtip: (d) => [d.battery?.low != null ? `laagste ${d.battery.low}` : ''],
    dhead: (h, td) => { const t = h.find((x) => x.date === td); return [mean(h.map((x) => x.battery?.high)), 'gemiddeld hoogste', t?.battery?.now != null ? `nu ${t.battery.now}` : '']; } },
  { k: 'stress', t: 'Stress', c: 'stress', kind: 'bar', fixed: [0, 100], up: false, eps: 2, nk: 'stress', minN: 2, weekly: true,
    mv: (x) => x.v.stress, dv: (d) => d.stress,
    big: (v) => nlv(v), fmt: (v) => `${nlv(v)} · ${STRESS(v)}`, dfmt: (v) => nlv(v),
    dhead: (h, td) => { const [v, d] = lastOf(h, (x) => x.stress); const m = mean(h.map((x) => x.stress)); return [m, `gemiddeld · ${STRESS(m)}`, v != null ? `${dayWord(d.date, td)} ${v}` : '']; } },
  { k: 'steps', t: 'Stappen', mt: 'Stappen per dag', c: 'steps', kind: 'bar', zero: true, up: true, eps: 500, nk: 'steps', minN: 7,
    mv: (x) => x.v.steps, mgoal: (x) => x.v.goal, dv: (d) => d.steps?.n, dgoal: (d) => d.steps?.goal,
    dlegend: ['stappen', 'dagdoel'], mlegend: ['gemiddeld per dag', 'dagdoel'],
    big: (v) => nlNum(v), fmt: (v) => `${nlNum(v)} stappen`, dfmt: (v) => nlNum(v), axis: (v) => (v >= 1000 ? `${v / 1000}k` : v),
    mtip: (x) => [x.v.goal ? `doel gemiddeld ${nlNum(x.v.goal)}` : '', x.v.hit != null ? `doel gehaald op ${Math.round(x.v.hit)}% van de dagen` : ''],
    dtip: (d) => [d.steps?.goal ? `doel ${nlNum(d.steps.goal)}` : '', d.steps?.km ? `${km(d.steps.km)} km` : ''],
    dhead: (h, td) => { const t = h.find((x) => x.date === td); const m = mean(h.map((x) => x.steps?.n)); return [m == null ? null : nlNum(m), 'per dag', t?.steps ? `vandaag ${nlNum(t.steps.n)}` : '']; } },
  { k: 'im', t: 'Intensiteitsminuten', mt: 'Intensiteitsminuten per week', c: 'im', kind: 'bar', zero: true, up: true, eps: 15, nk: 'im', minN: 2, weekly: true, day: false,
    mv: (x) => x.v.im, mgoal: (x) => x.v.imgoal, mlegend: ['gemiddeld per week', 'weekdoel'],
    big: (v) => `${Math.round(v)}<small>min/week</small>`, fmt: (v) => `${Math.round(v)} min per week`, dfmt: (v) => `${Math.round(v)} min` },
  // herstel/gereedheid (Whoop, Oura, sommige Garmins), 0–100
  { k: 'ready', t: 'Herstel', c: 'bb', kind: 'bar', fixed: [0, 100], up: true, eps: 3, nk: 'ready', minN: 7,
    mv: (x) => x.v.ready, dv: (d) => d.readiness?.score,
    big: (v) => String(Math.round(v)), fmt: (v) => `herstel ${Math.round(v)}`, dfmt: (v) => String(Math.round(v)),
    dtip: (d) => [d.readiness?.level || ''],
    dhead: (h, td) => { const [v, d] = lastOf(h, (x) => x.readiness?.score); return [mean(h.map((x) => x.readiness?.score)), 'gemiddeld', v != null ? `${dayWord(d.date, td)} ${v}` : '']; } },
  // VO2max verandert traag: enkel per maand, niet per dag
  { k: 'vo2', t: 'VO2max', c: 'vo2', kind: 'line', up: true, eps: 0.3, nk: 'vo2', minN: 1, day: false,
    mv: (x) => x.v.vo2, big: (v) => nl1(v), fmt: (v) => `VO2max ${nl1(v)}`, dfmt: (v) => nl1(v) },
];
// volgorde van tegels en grafieken: zo staan kleuren die op elkaar lijken nooit naast elkaar (ook niet bij kleurenblindheid)
const HORDER = ['score', 'dur', 'rhr', 'bb', 'ready', 'vo2', 'steps', 'stress', 'hrv', 'im'];
HEALTH.sort((a, b) => HORDER.indexOf(a.k) - HORDER.indexOf(b.k));
const HM = Object.fromEntries(HEALTH.map((m) => [m.k, m]));

// deze maand (of de laatste maand met genoeg metingen) en de eerste maand van het jaar ervoor
function monthPick(m, months) {
  const ok = months.filter((x) => m.mv(x) != null && (x.n[m.nk] || 0) >= m.minN);
  return { now: ok[ok.length - 1] || null, base: ok.length > 1 ? ok[0] : null };
}
function deltaHtml(m, a, b) {
  if (a == null || b == null) return '';
  const d = a - b;
  if (Math.abs(d) < m.eps) return '<span class="delta same">≈ gelijk</span>';
  const better = (d > 0) === m.up;
  return `<span class="delta ${better ? 'good' : 'bad'}">${d > 0 ? ICON.up : ICON.down}${esc(m.dfmt(Math.abs(d)))} ${better ? 'beter' : 'minder goed'}</span>`;
}
const monthWhen = (x) => (x.partial ? `${monthName(x.m, false)} tot nu` : monthName(x.m, false));

function healthTiles(rec) {
  if (isMonth()) {
    const ms = rec.months || [];
    const tiles = HORDER.filter((k) => k !== 'dur' && monthPick(HM[k], ms).now).map((k) => {
      const m = HM[k];
      const { now, base } = monthPick(m, ms);
      if (!now) return mtile(m.c, m.t, '–', 'nog geen gegevens');
      const v = m.mv(now);
      const trend = base ? `<div class="trend">${deltaHtml(m, v, m.mv(base))}<span class="muted small">sinds ${monthShort(base.m)}</span></div>` : '';
      return mtile(m.c, m.t, m.big(v), `${k === 'steps' ? 'per dag · ' : ''}${monthWhen(now)}`, trend);
    });
    tiles.push(bodyAgeTile());
    return `<div class="mtiles health">${tiles.join('')}</div>`;
  }
  const td = rec.today?.date || todayIso();
  const h = rec.history || [];
  const t = rec.today || {};
  const week = h.filter((d) => d.date >= mondayOf(td));
  const imin = week.reduce((a, d) => a + (d.intensity || 0), 0);
  const igoal = lastOf(h, (d) => d.intensity_goal)[0] || 150;
  const [vo2, vd] = lastOf(h, (d) => d.status?.vo2max);
  const has = (f) => h.some((d) => f(d) != null);
  const tiles = [
    [has((d) => d.sleep), mtile('sleep', 'Slaap', t.sleep?.score ?? '–', t.sleep ? `score · ${hm(t.sleep.secs)} geslapen` : 'nog geen slaapdata')],
    [has((d) => d.rhr), mtile('rhr', 'Rusthartslag', t.rhr ? `${t.rhr}<small>bpm</small>` : '–', h.length > 1 ? `gemiddeld ${Math.round(mean(h.map((d) => d.rhr)))} bpm` : '')],
    [has((d) => d.battery), mtile('bb', 'Body Battery', t.battery?.now ?? '–', t.battery ? `nu · hoogste ${t.battery.high}` : '–')],
    [has((d) => d.readiness), mtile('vo2', S.settings.health === 'whoop' ? 'Herstel' : 'Klaar voor training', t.readiness?.score ?? '–', t.readiness ? esc(t.readiness.level || '') : '')],
    [vo2 != null, mtile('vo2', 'VO2max', vo2 != null ? nlv(vo2) : '–', vd?.status?.label ? `${esc(vd.status.label)}${vd.status.load ? ` · ${esc(vd.status.load)}` : ''}` : '')],
    [has((d) => d.steps), mtile('steps', 'Stappen', t.steps ? nlNum(t.steps.n) : '–', t.steps?.goal ? `van ${nlNum(t.steps.goal)} · ${Math.round((100 * t.steps.n) / t.steps.goal)}%` : '')],
    [has((d) => d.stress), mtile('stress', 'Stress', t.stress ?? '–', t.stress != null ? `gemiddeld vandaag · ${STRESS(t.stress)}` : '')],
    [has((d) => d.hrv), mtile('hrv', 'HRV', t.hrv?.night ? `${t.hrv.night}<small>ms</small>` : '–', t.hrv ? esc(t.hrv.status) : '–')],
    [has((d) => d.intensity), mtile('im', 'Intensiteitsminuten', imin, `deze week · doel ${igoal}`)],
    [true, bodyAgeTile()],
  ];
  return `<div class="mtiles health">${tiles.filter(([ok]) => ok).map(([, html]) => html).join('')}</div>`;
}

function healthTable(rec) {
  const f = (v, fn) => (v == null ? '–' : fn(v));
  if (isMonth()) {
    const rows = [...(rec.months || [])].reverse().map((x) => `<tr><td>${esc(cap(monthName(x.m)))}${x.partial ? ' <span class="muted">(tot nu)</span>' : ''}</td>
      <td>${f(x.v.score, nl1)}</td><td>${f(x.v.secs, hm)}</td><td>${f(x.v.hrv, nl1)}</td><td>${f(x.v.rhr, nl1)}</td>
      <td>${x.v.bb != null ? `${nl1(x.v.bblo)}–${nl1(x.v.bb)}` : '–'}</td><td>${f(x.v.stress, nl1)}</td><td>${f(x.v.steps, nlNum)}</td>
      <td>${f(x.v.im, Math.round)}</td><td>${f(x.v.vo2, nl1)}</td></tr>`).join('');
    return `<details class="panel htable"><summary>Alle maanden in een tabel</summary><div class="table-wrap"><table>
      <thead><tr><th>Maand</th><th>Slaap</th><th>Duur</th><th>HRV</th><th>Rust-HS</th><th>Body Battery</th><th>Stress</th><th>Stappen/dag</th><th>Int.-min/week</th><th>VO2max</th></tr></thead>
      <tbody>${rows}</tbody></table></div></details>`;
  }
  const rows = [...(rec.history || [])].reverse().map((d) => `<tr><td>${esc(nlShort(d.date))}</td>
    <td>${d.sleep?.score ?? '–'}</td><td>${d.sleep ? hm(d.sleep.secs) : '–'}</td><td>${d.hrv?.night ?? '–'}</td><td>${d.rhr ?? '–'}</td>
    <td>${d.battery ? `${d.battery.low}–${d.battery.high}` : '–'}</td><td>${d.stress ?? '–'}</td><td>${d.steps ? nlNum(d.steps.n) : '–'}</td>
    <td>${d.intensity ?? '–'}</td><td>${d.kcal?.total ? nlNum(d.kcal.total) : '–'}</td></tr>`).join('');
  return `<details class="panel htable"><summary>Alle dagen in een tabel</summary><div class="table-wrap"><table>
    <thead><tr><th>Datum</th><th>Slaap</th><th>Duur</th><th>HRV</th><th>Rust-HS</th><th>Body Battery</th><th>Stress</th><th>Stappen</th><th>Int.-min</th><th>kcal</th></tr></thead>
    <tbody>${rows}</tbody></table></div></details>`;
}

function healthChartPanel(m, rec) {
  let big; let sub; let side;
  if (isMonth()) {
    const { now, base } = monthPick(m, rec.months || []);
    big = now ? m.big(m.mv(now)) : '–';
    sub = now ? monthWhen(now) : '';
    side = base ? `${deltaHtml(m, m.mv(now), m.mv(base))} <span class="muted small">sinds ${monthShort(base.m)}</span>` : '';
  } else {
    const [b, s, sd] = m.dhead(rec.history || [], rec.today?.date || todayIso());
    big = b == null ? '–' : typeof b === 'number' ? nlv(Math.round(b * 10) / 10) : b;
    sub = s;
    side = `<span class="muted small">${esc(sd)}</span>`;
  }
  const leg = isMonth() ? m.mlegend : m.dlegend;
  const lg = leg ? `<div class="hlegend"><span><i class="sw ${m.kind === 'line' ? 'dot' : 'bar'}"></i>${leg[0]}</span><span><i class="sw ${m.dv2 && !isMonth() ? 'dash' : 'tick'}"></i>${leg[1]}</span></div>` : '';
  return `<section class="panel hpanel c-${m.c}"><div class="hhead"><div><div class="label"><i class="mdot"></i>${esc(isMonth() && m.mt ? m.mt : m.t)}</div>
    <div class="hval">${big}<small>${esc(sub)}</small></div></div><div class="hside">${side}</div></div>${lg}<div class="hchart" data-chart="${m.k}"></div></section>`;
}

// ---- per dag: één dag in detail, terugbladeren met ‹ › of vegen -------------------------------
const STAGES = [['deep', 'Diep', 'var(--c-sleep)'], ['light', 'Licht', 'color-mix(in srgb, var(--c-sleep) 55%, var(--panel))'],
  ['rem', 'REM', 'var(--c-hrv)'], ['awake', 'Wakker', 'var(--dim)']];
function sleepStages(s) {
  const parts = STAGES.filter(([k]) => s[k]).map(([k, l, c]) => [k, l, c, s[k]]);
  const tot = parts.reduce((a, p) => a + p[3], 0);
  if (!tot) return '';
  return `<div class="stages" role="img" aria-label="Slaapfases">${parts.map(([, l, c, v]) => `<i style="flex:${v};background:${c}" title="${l} ${hm(v)}"></i>`).join('')}</div>
    <div class="stage-leg">${parts.map(([, l, c, v]) => `<span><i style="background:${c}"></i>${l} ${hm(v)}</span>`).join('')}</div>`;
}
function dayDelta(v, avg, up, unit = '') {
  if (v == null || avg == null) return '';
  const d = v - avg;
  if (Math.abs(d) < 1) return '<span class="delta same">≈ normaal</span>';
  const better = (d > 0) === up;
  return `<span class="delta ${better ? 'good' : 'bad'}">${d > 0 ? ICON.up : ICON.down}${Math.round(Math.abs(d))}${unit} ${d > 0 ? 'boven' : 'onder'} normaal</span>`;
}
// intensiteitsminuten tellen per week (Garmin: doel 150 per week): het weektotaal tot die dag, en die dag zelf
function imTile(d, days, isToday) {
  const mon = mondayOf(d.date);
  const wk = days.filter((x) => x.date >= mon && x.date <= d.date);
  const whole = wk.length === Math.round((d8(d.date) - d8(mon)) / 864e5) + 1 && wk.every((x) => x.intensity != null);
  const goal = d.intensity_goal || 150;
  if (!whole) return mtile('im', 'Intensiteit', `${d.intensity}<small>min</small>`, `die dag · doel ${goal} per week`);
  const sum = wk.reduce((a, x) => a + (x.intensity || 0), 0);
  return mtile('im', 'Intensiteit', `${sum}<small>min</small>`, `${isToday ? 'deze week' : 'die week tot dan'} · doel ${goal}${sum >= goal ? ' ✓' : ''}`,
    `<div class="muted small">${isToday ? 'vandaag' : 'die dag'} ${d.intensity} min</div>`);
}
function healthDay(rec) {
  const days = [...(rec.history || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return '<section class="panel"><div class="muted">Nog geen dagen van je horloge.</div></section>';
  const td = todayIso();
  if (!S.hday || !days.some((d) => d.date === S.hday)) S.hday = days[days.length - 1].date;
  const i = days.findIndex((d) => d.date === S.hday);
  const d = days[i];
  const prev7 = days.slice(Math.max(0, i - 7), i);
  const avg = (f) => mean(prev7.map(f));
  const isToday = d.date === td;
  const strip = days.map((x) => `<button class="dchip${x.date === d.date ? ' on' : ''}" data-hday="${x.date}" aria-pressed="${x.date === d.date}">
      <span>${DS[wd(x.date)]}</span><b>${d8(x.date).getDate()}</b><i class="dot" style="opacity:${x.sleep?.score != null ? Math.max(0.25, x.sleep.score / 100) : 0}"></i></button>`).join('');
  const nav = `<section class="daynav">
      <button class="icon-btn" data-hday="${days[i - 1]?.date || ''}" ${i ? '' : 'disabled'} aria-label="Vorige dag">${ICON.left}</button>
      <label class="dn-mid dn-pick"><div class="label">${isToday ? 'Vandaag' : d.date === addDays(td, -1) ? 'Gisteren' : `${td > d.date ? Math.round((d8(td) - d8(d.date)) / 864e5) : 0} dagen geleden`}</div>
        <div class="dn-date">${esc(cap(d.date.slice(0, 4) === td.slice(0, 4) ? nlDate(d.date).replace(/ \d{4}$/, '') : nlDate(d.date)))}<span class="dn-cal">${ICON.down}</span></div>
        <input type="date" data-hpick min="${days[0].date}" max="${days[days.length - 1].date}" value="${d.date}" aria-label="Kies een dag"></label>
      <button class="icon-btn" data-hday="${days[i + 1]?.date || ''}" ${i < days.length - 1 ? '' : 'disabled'} aria-label="Volgende dag">${ICON.right}</button>
    </section><div class="dstrip" id="dstrip">${strip}</div>`;
  const s = d.sleep; const b = d.battery; const st = d.status; const r = d.readiness;
  const tiles = [
    s && `<div class="mtile c-sleep wide"><div class="label"><i class="mdot"></i>Slaap</div>
      <div class="big">${s.score ?? '–'}<small>${s.score != null ? ' score' : ''}</small> <span class="big-sub">${hm(s.secs)}</span></div>
      ${sleepStages(s)}${[s.spo2 ? `SpO2 ${Math.round(s.spo2)}%` : '', s.resp ? `ademhaling ${Math.round(s.resp)}/min` : ''].filter(Boolean).length
        ? `<div class="muted small">${[s.spo2 ? `SpO2 ${Math.round(s.spo2)}%` : '', s.resp ? `ademhaling ${Math.round(s.resp)}/min` : ''].filter(Boolean).join(' · ')}</div>` : ''}</div>`,
    d.hrv && mtile('hrv', 'HRV', `${d.hrv.night}<small>ms</small>`, esc(cap(d.hrv.status || '')),
      `<div class="trend">${dayDelta(d.hrv.night, avg((x) => x.hrv?.night), true, ' ms')}</div>`),
    d.rhr && mtile('rhr', 'Rusthartslag', `${d.rhr}<small>bpm</small>`, '',
      `<div class="trend">${dayDelta(d.rhr, avg((x) => x.rhr), false, ' bpm')}</div>`),
    // vandaag: groot wat je nu hebt, klein enkel wanneer je horloge dat doorgaf
    b && (isToday && b.now != null
      ? mtile('bb', 'Body Battery', `${b.now}<small> nu</small>`,
        d.synced && d.synced.slice(0, 10) === d.date ? `bijgewerkt om ${d.synced.slice(11, 16)}` : '')
      : mtile('bb', 'Body Battery', `${b.low ?? '–'}–${b.high ?? '–'}`, 'laagste – hoogste van die dag')),
    r && mtile('vo2', S.settings.health === 'whoop' ? 'Herstel' : 'Klaar voor training', `${r.score}${S.settings.health === 'whoop' ? '<small>%</small>' : ''}`,
      esc([r.level, r.recovery_h ? `herstel ${r.recovery_h} u` : ''].filter(Boolean).join(' · '))),
    st && st.vo2max && mtile('vo2', 'VO2max', nlv(st.vo2max), esc([st.label ? `Trainingsstatus: ${st.label}` : '', st.load || ''].filter(Boolean).join(' · ')),
      STATUS_TIP[st.label] ? `<div class="muted small">${esc(STATUS_TIP[st.label])}</div>` : ''),
    st && !st.vo2max && st.label && mtile('vo2', 'Trainingsstatus', `<span class="big-txt">${esc(st.label)}</span>`, esc(STATUS_TIP[st.label] || st.load || '')),
    st && !st.vo2max && !st.label && st.load && mtile('vo2', 'Fitheid en vorm', `<span class="big-txt">${esc(st.load)}</span>`, 'uit intervals.icu'),
    d.weight?.kg && mtile('weight', 'Gewicht', `${nlv(d.weight.kg)}<small>kg</small>`, d.weight.fat ? `vet ${nlv(d.weight.fat)}%` : ''),
    d.stress != null && d.stress >= 0 && mtile('stress', 'Stress', d.stress, cap(STRESS(d.stress))),
    d.steps && mtile('steps', 'Stappen', nlNum(d.steps.n), [d.steps.goal ? `${Math.round((100 * d.steps.n) / d.steps.goal)}% van ${nlNum(d.steps.goal)}` : '', d.steps.km ? `${km(d.steps.km)} km` : ''].filter(Boolean).join(' · ')),
    d.intensity != null && imTile(d, days, isToday),
    d.kcal?.total && mtile('steps', 'Calorieën', `${nlNum(d.kcal.total)}<small>kcal</small>`, d.kcal.active ? `${nlNum(d.kcal.active)} actief` : ''),
    bodyAgeTile(),
  ].filter(Boolean);
  const stale = rec.stale ? `<div class="muted small dn-stale">${esc(srcName())} was even niet bereikbaar. Je ziet de laatst opgehaalde gegevens.</div>` : '';
  const lite = d.lite ? '<p class="muted small hintro">Van verder terug bewaart het programma minder details: slaap, HRV, rusthartslag, Body Battery en stappen.</p>' : '';
  return `${nav}${stale}<div class="dayview" id="dayview"><div class="mtiles health day">${tiles.join('')}</div>${lite}</div>`;
}

function vGezondheid() {
  const mode = S.healthDays;
  const when = WEB() && S.settings.web?.made ? ` · bijgewerkt ${syncWhen(S.settings.web.made)}` : '';
  const head = `<div class="sec-h"><div><div class="label">${S.settings.health ? srcName() : 'Slaap, HRV en herstel'}${when}</div><h2 class="sec-t">Gezondheid</h2></div>
    <div class="btns tight" style="margin:0">${S.settings.health ? `<div class="seg" role="group" aria-label="Periode">${HMODES.map(([k, l]) =>
      `<button data-hdays="${k}" class="${mode === k ? 'on' : ''}" aria-pressed="${mode === k}">${l}</button>`).join('')}</div>
      ${WEB() ? '' : `<button class="icon-btn" data-action="health-refresh" aria-label="Nu bijwerken bij ${esc(srcName())}" title="Nu bijwerken">${ICON.refresh}</button>`}` : ''}</div></div>`;
  if (!S.settings.health) {
    return `${head}<section class="panel garmin-cta"><div><div class="label">Gezondheid</div>
      <div class="muted small" style="margin-top:4px">Koppel je horloge of ring (Garmin, Whoop, Oura of Polar) om je slaap, HRV, rusthartslag en meer te volgen.</div></div>
      <button class="btn" data-view="instellingen">Koppelen</button></section>`;
  }
  const rec = S.health?.days === mode ? S.health.rec : null;
  if (!rec) {
    return `${head}<section class="panel"><div class="muted"><span class="spinner"></span> Ophalen bij ${srcName()}…${mode === 'alles' ? ' De eerste keer alles: ongeveer een halve minuut.' : ''}</div></section>`;
  }
  if (rec.error) return `${head}<div class="alert">${esc(rec.error)}</div>`;
  if (mode === 'dag') return `${head}${healthDay(rec)}`;
  if (mode === 'kal' || mode === 'wk') return `${head}${healthPeriod(rec, mode)}`;
  const has = (m) => (rec.months || []).some((x) => m.mv(x) != null);
  const first = rec.months?.find((x) => HEALTH.some((m) => m.mv(x) != null));
  const intro = `<p class="muted small hintro">Gemiddelde per maand${first ? `, sinds ${monthName(first.m)}` : ''}. De pijl vergelijkt je laatste maand met de eerste: zo zie je of je echt vooruitgaat.</p>`;
  return `${head}${healthTiles(rec)}${intro}<div class="hgrid">${HEALTH.filter(has).map((m) => healthChartPanel(m, rec)).join('')}</div>${healthTable(rec)}`;
}

// ---- in één oogopslag, bovenaan de pagina: één grafiek die zegt wat beter gaat, stabiel blijft of slechter gaat ----
// Per cijfer: nu (je laatste meting), gemiddeld week (laatste 7 dagen) en gemiddeld maand (laatste 30 dagen).
// De balk vergelijkt je week met je maand: zo zie je of het nu beter of slechter gaat dan normaal voor jou.
// De balk loopt vanuit het midden naar rechts (beter) of links (slechter); de lengte = hoe groot de verandering is.
const TRENDS = [
  { k: 'sleep', l: 'Slaap', what: 'score van de nacht', f: (d) => d.sleep?.score, up: true, eps: 2, scale: 8, u: '', night: true },
  { k: 'hrv', l: 'HRV', what: 'gemiddeld in de nacht', f: (d) => d.hrv?.night, up: true, eps: 2, scale: 8, u: 'ms', night: true },
  { k: 'rhr', l: 'Rustpols', what: 'laagste in rust', f: (d) => d.rhr, up: false, eps: 1, scale: 4, u: 'bpm' },
  { k: 'bb', l: 'Body Battery', what: 'hoogste van de dag', f: (d) => d.battery?.high, up: true, eps: 3, scale: 12, u: '' },
  { k: 'stress', l: 'Stress', what: 'gemiddeld per dag', f: (d) => (d.stress >= 0 ? d.stress : null), up: false, eps: 2, scale: 8, u: '' },
  { k: 'vo2', l: 'VO2max', what: 'volgens je horloge', f: (d) => d.status?.vo2max, up: true, eps: 0.3, scale: 1.5, u: '' },
];
function glance() {
  const rec = S.glance;
  if (!S.settings.health || !rec || rec.error) return '';
  const h = [...(rec.history || [])].filter((d) => d.sleep || d.hrv || d.battery || d.rhr).sort((a, b) => a.date.localeCompare(b.date));
  const t = h[h.length - 1];
  if (!t) return '';
  const td = todayIso();
  const week = h.filter((d) => d.date > addDays(t.date, -7));
  const base = h.filter((d) => d.date > addDays(t.date, -30));                  // de maand: laatste 30 dagen
  const f1 = (v) => (v == null ? '–' : nlv(Math.round(v * 10) / 10));
  const rows = TRENDS.map((m) => {
    const now = mean(week.map(m.f)); const was = mean(base.map(m.f));
    const lastD = [...h].reverse().find((d) => m.f(d) != null);
    if (now == null || was == null || !lastD) return null;
    const last = m.f(lastD);
    const d = Math.round((now - was) * 10) / 10;
    const better = m.up ? d : -d;
    const lvl = Math.abs(d) < m.eps ? 'same' : better > 0 ? 'good' : 'bad';
    const frac = Math.max(-1, Math.min(1, better / m.scale));
    const w = lvl === 'same' ? 0 : Math.max(8, Math.abs(frac) * 50);
    const bar = lvl === 'same' ? '<i class="tr-same"></i>' : `<i class="tr-bar ${lvl}" style="${frac > 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i>`;
    const word = { good: 'beter', same: 'stabiel', bad: 'slechter' }[lvl];
    const icon = { good: '▲', same: '●', bad: '▼' }[lvl];
    // wanneer is die laatste meting: vannacht, vandaag (tot nu), gisteren of een datum
    const day = lastD.date === td ? (m.night ? 'vannacht' : m.k === 'vo2' ? 'vandaag' : 'vandaag tot nu')
      : lastD.date === addDays(td, -1) ? (m.night ? 'nacht van gisteren' : 'gisteren') : nlShort(lastD.date);
    // Body Battery vandaag: gewoon laagste → hoogste, en eronder hoeveel je nog had toen je horloge het laatst doorgaf
    const bbToday = m.k === 'bb' && lastD.date === td && t.battery?.low != null && t.battery?.high != null;
    const extra = m.k === 'bb' && lastD.date === td && t.battery?.now != null
      ? `<small class="tr-now">${t.synced && t.synced.slice(0, 10) === td ? `om ${t.synced.slice(11, 16)}` : 'nu'} nog <b>${t.battery.now}</b></small>` : '';
    const unit = m.u ? `<small>${m.u}</small>` : '';
    const lastCell = bbToday ? `<b>${t.battery.low} → ${t.battery.high}</b>${extra || '<small>vandaag</small>'}`
      : `<b>${f1(last)}${unit}</b><small>${day}</small>${extra}`;
    return `<div class="tr-row ${lvl}">
      <div class="tr-name"><b>${m.l}</b><small>${m.what}</small></div>
      <div class="tr-num tr-last">${lastCell}</div>
      <div class="tr-num"><b>${f1(now)}</b><small>gem. week</small></div>
      <div class="tr-num tr-was"><b>${f1(was)}</b><small>gem. maand</small></div>
      <div class="tr-track" role="img" aria-label="${m.l}: ${word}, gemiddeld ${f1(now)} tegenover ${f1(was)}">${bar}</div>
      <div class="tr-verdict"><b>${icon} ${word}</b><small>${lvl === 'same' ? `± ${f1(Math.abs(d))}` : `${d > 0 ? '+' : '−'}${f1(Math.abs(d))}${m.u ? ` ${m.u}` : ''}`}</small></div></div>`;
  }).filter(Boolean);
  if (!rows.length) return '';
  // herstel van vandaag als kop: gereedheid, of slaap + HRV
  const r = t.readiness?.score; const sl = t.sleep?.score; const hs = t.hrv?.status || '';
  const her = r != null ? (r >= 70 ? 'good' : r >= 40 ? 'mid' : 'bad')
    : /laag|uit balans/i.test(hs) || (sl != null && sl < 55) ? 'bad' : sl != null && sl < 70 ? 'mid' : 'good';
  const when = t.date === td ? 'Vandaag' : t.date === addDays(td, -1) ? 'Gisteren' : cap(nlDate(t.date).replace(/ \d{4}$/, ''));
  return `<section class="glance panel" aria-label="Hoe gaat het met je gezondheid">
    <div class="tr-head"><div><span class="label">${esc(when)} · ${esc(srcName())}</span>
      <div class="tr-her ${her}"><i></i>Herstel: <b>${{ good: 'goed', mid: 'half', bad: 'moe' }[her]}</b></div></div>
      <div class="tr-acts"><details class="tr-info"><summary aria-label="Hoe lees je dit?">i</summary>
        <div class="tr-pop"><b>Hoe lees je dit?</b>
          <p><b>Nu</b> is je meest recente meting. <b>Gemiddeld week</b> is je gemiddelde van de laatste 7 dagen, <b>gemiddeld maand</b> dat van de laatste 30 dagen.</p>
          <p>De balk vergelijkt je week met je maand: groen naar rechts = beter, rood naar links = slechter, bolletje = stabiel.</p>
          <p>Rustpols en stress: lager is beter. Body Battery: de hoogste van de dag, en hoeveel je nog hebt op het moment dat je horloge het laatst synchroniseerde.</p></div></details>
      <button class="link-btn" data-view="gezondheid">Meer ›</button></div></div>
    <div class="tr-axis"><span></span><span>Nu</span><span>Gemiddeld week</span><span>Gemiddeld maand</span><span></span><span></span></div>
    ${rows.join('')}${staleNote(t, td)}
  </section>`;
}
// zolang je horloge niets doorgaf sinds je training: om de 3 minuten opnieuw kijken (enkel vandaag, snel), tot het klopt
let staleTimer = null;
function watchStale() {
  if (staleTimer || !document.querySelector('.tr-stale')) return;
  staleTimer = setTimeout(async () => {
    staleTimer = null;
    try {
      // gsm: de nieuwste kopie van je computer halen; computer: Garmin opnieuw vragen (enkel vandaag)
      const was = S.glance?.today?.synced;
      const rec = await api().garmin_recovery(WEB(), DAY_BACK);
      if (rec && !rec.error) {
        if (!WEB() && rec.today?.synced && rec.today.synced !== was) api().phone_push().catch(() => {});   // gsm meteen mee
        S.glance = rec;
        if (S.health && S.health.days !== 'alles') S.health = { days: S.health.days, rec };
        if (S.view === 'overzicht') render();
      }
    } catch { /* volgende keer opnieuw */ }
    watchStale();
  }, 180000);
}
// je horloge gaf je dagwaarden nog niet door sinds je training: dan zie je je waarden van ervoor (bv. Body Battery 100)
function staleNote(t, td) {
  const at = t.date === td && t.synced && t.synced.slice(0, 10) === td ? t.synced : null;
  if (!at || !S.data) return '';
  const after = ACTS().filter((x) => x.date === td && x.start && x.start.slice(0, 16) > at);
  if (!after.length) return '';
  return `<p class="tr-stale">${ICON.alert}<span>Je horloge gaf je dagwaarden (Body Battery, stress, stappen) het laatst door om <b>${at.slice(11, 16)}</b>, vóór je ${esc(after[0].title.toLowerCase())}.
    Open Garmin Connect op je gsm om te synchroniseren: dE3p kijkt vanzelf om de paar minuten opnieuw.</span></p>`;
}

// ---- Week en Maand: elke dag van die periode, met gemiddelden tegenover de periode ervoor ----
const periodKey = (date, mode) => (mode === 'wk' ? mondayOf(date) : date.slice(0, 7));
function healthRec() {
  const rec = S.health?.rec;
  const mode = S.healthDays;
  const sel = mode === 'wk' ? S.hweek : mode === 'kal' ? S.hmonth : null;
  if (!rec || !sel) return rec;
  return { ...rec, history: (rec.history || []).filter((d) => periodKey(d.date, mode) === sel) };
}
function healthPeriod(rec, mode) {
  const wk = mode === 'wk';
  const all = [...(rec.history || [])].sort((a, b) => a.date.localeCompare(b.date));
  const keys = [...new Set(all.map((d) => periodKey(d.date, mode)))];
  if (!keys.length) return '<section class="panel"><div class="muted">Nog geen dagen van je horloge.</div></section>';
  const cur = wk ? S.hweek : S.hmonth;
  const sel = keys.includes(cur) ? cur : keys[keys.length - 1];
  if (wk) S.hweek = sel; else S.hmonth = sel;
  const i = keys.indexOf(sel);
  const sub = all.filter((d) => periodKey(d.date, mode) === sel);
  const prev = i > 0 ? all.filter((d) => periodKey(d.date, mode) === keys[i - 1]) : [];
  const back = keys.length - 1 - i;
  const name = wk ? `${nlShort(sel)} – ${nlShort(addDays(sel, 6))}` : cap(monthName(sel));
  const ago = back === 0 ? (wk ? 'Deze week' : 'Deze maand') : `${back} ${wk ? (back === 1 ? 'week' : 'weken') : (back === 1 ? 'maand' : 'maanden')} geleden`;
  const attr = wk ? 'data-hweek' : 'data-hmonth';
  const nav = `<section class="daynav">
      <button class="icon-btn" ${attr}="${keys[i - 1] || ''}" ${i ? '' : 'disabled'} aria-label="${wk ? 'Vorige week' : 'Vorige maand'}">${ICON.left}</button>
      <div class="dn-mid"><div class="label">${ago}</div><div class="dn-date">${esc(name)}</div></div>
      <button class="icon-btn" ${attr}="${keys[i + 1] || ''}" ${i < keys.length - 1 ? '' : 'disabled'} aria-label="${wk ? 'Volgende week' : 'Volgende maand'}">${ICON.right}</button>
    </section>`;
  const vs = i > 0 ? (wk ? 'vorige week' : MON[Number(keys[i - 1].slice(5)) - 1]) : '';
  const avg = (arr, m) => mean(arr.map((d) => m.dv(d)));
  const tiles = ['score', 'dur', 'hrv', 'rhr', 'bb', 'steps', 'stress'].map((k) => HM[k]).filter((m) => sub.some((d) => m.dv(d) != null)).map((m) => {
    const v = avg(sub, m); const p = prev.length ? avg(prev, m) : null;
    const trend = p != null ? `<div class="trend">${deltaHtml(m, v, p)}<span class="muted small">t.o.v. ${vs}</span></div>` : '';
    return mtile(m.c, m.t, m.big(m.k === 'dur' ? v : Math.round(v * 10) / 10), `gemiddeld${m.k === 'steps' ? ' per dag' : ''}`, trend);
  });
  const [vo2] = lastOf(sub, (d) => d.status?.vo2max);
  if (vo2 != null) tiles.push(mtile('vo2', 'VO2max', nlv(vo2), 'laatste meting'));
  tiles.push(bodyAgeTile());
  const r = { ...rec, history: sub };
  const charts = HEALTH.filter((m) => m.day !== false && sub.some((d) => m.dv(d) != null)).map((m) => healthChartPanel(m, r)).join('');
  return `${nav}<div class="mtiles health month">${tiles.join('')}</div><div class="hgrid">${charts}</div>${healthTable(r)}`;
}

let healthReq = 0; let healthPending = '';
async function loadHealth(force = false) {
  if (S.view !== 'overzicht' || !S.settings.health) return;
  const mode = S.healthDays;
  if (!force && S.health?.days === mode) { drawHealth(); return; }
  if (!force && healthPending === mode) return;
  const req = ++healthReq;
  healthPending = mode;
  let rec;
  try { rec = mode === 'alles' ? await api().garmin_months(force) : await api().garmin_recovery(force, DAY_BACK); } catch (e) { rec = { error: errMsg(e) }; }
  if (req !== healthReq) return;
  healthPending = '';
  S.health = { days: mode, rec: rec || { error: 'Geen gegevens van Garmin.' } };
  if (mode !== 'alles') S.glance = S.health.rec;
  else if (!S.glance) { try { S.glance = await api().garmin_recovery(false, DAY_BACK); } catch { /* geen oogopslag */ } }
  if (force) toast('Garmin bijgewerkt');
  if (S.view === 'overzicht') render();
}

// ---- grafiek (SVG) ----
function niceStep(span, n) {
  const raw = span / n; const p = 10 ** Math.floor(Math.log10(raw)); const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
function yScale(vals, m) {
  if (m.fixed) return { a: m.fixed[0], b: m.fixed[1], ticks: [m.fixed[0], (m.fixed[0] + m.fixed[1]) / 2, m.fixed[1]] };
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  if (m.zero) lo = 0;
  if (hi - lo < 2) { hi += 1; lo = m.zero ? 0 : lo - 1; }
  const step = niceStep(hi - lo, 3);
  const a = Math.floor(lo / step) * step; const b = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { a, b, ticks };
}
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
// balk met afgeronde bovenkant (data-einde) en rechte basis
const topBar = (x, y, w, h, r = 4) => { r = Math.min(r, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

// punten voor de grafiek: per maand of per dag, zelfde vorm
function chartPoints(m, rec) {
  if (isMonth()) {
    return (rec.months || []).map((x, i) => {
      const [y, mm] = x.m.split('-').map(Number);
      const v = m.mv(x) ?? null;
      const n = x.n[m.nk] || 0;
      const what = m.k === 'vo2' ? (n === 1 ? 'meting' : 'metingen') : m.weekly ? (n === 1 ? 'week' : 'weken') : (n === 1 ? 'dag' : 'dagen');
      return { v, lo: m.mlo?.(x) ?? null, goal: m.mgoal?.(x) ?? null, part: x.partial, now: x.partial,
        x1: MON[mm - 1], x2: i === 0 || mm === 1 ? String(y) : '', yr: String(y),
        title: `${cap(monthName(x.m))}${x.partial ? ' · tot nu' : ''}`,
        lines: v == null ? ['geen gegevens'] : [m.fmt(v), ...(m.mtip?.(x) || []), `${n} ${what} gemeten`] };
    });
  }
  const h = rec.history || []; const td = rec.today?.date || todayIso(); const n = h.length; const every = n <= 10 ? 1 : 7;
  return h.map((d, i) => {
    const v = m.dv(d) ?? null;
    return { v, v2: m.dv2?.(d) ?? null, lo: m.dlo?.(d) ?? null, goal: m.dgoal?.(d) ?? null, now: d.date === td,
      x1: (n - 1 - i) % every ? '' : n <= 10 ? `${DS[wd(d.date)]} ${d8(d.date).getDate()}` : nlShort(d.date), x2: '',
      title: cap(nlDate(d.date).replace(/ \d{4}$/, '')), lines: v == null ? ['geen gegevens'] : [m.fmt(v), ...(m.dtip?.(d) || [])] };
  });
}

function drawChart(el, m, pts) {
  const W = el.clientWidth; const H = 176;
  if (!W || !pts.length) return;
  const L = 42; const R = 10; const T = 10; const B = pts.some((p) => p.x2) ? 36 : 24;
  const n = pts.length; const slot = (W - L - R) / n;
  const vals = pts.flatMap((p) => [p.v, p.v2, p.goal, p.lo]).filter((v) => v != null);
  if (!vals.length) return;
  const sc = yScale(vals, m);
  const y = (v) => T + (H - T - B) * (1 - (v - sc.a) / (sc.b - sc.a));
  const cx = (i) => L + slot * (i + 0.5);
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${m.t}, ${isMonth() ? 'per maand' : `laatste ${n} dagen`}` });
  const hover = svgEl('rect', { class: 'hcol', x: 0, y: T, width: slot, height: H - T - B, rx: 6, opacity: 0 });
  svg.append(hover);
  for (const t of sc.ticks) {
    svg.append(svgEl('line', { class: 'hgridline', x1: L, x2: W - R, y1: y(t), y2: y(t) }));
    const lab = svgEl('text', { class: 'haxis', x: L - 8, y: y(t) + 3.5, 'text-anchor': 'end' });
    lab.textContent = m.axis ? m.axis(t) : String(t).replace('.', ',');
    svg.append(lab);
  }
  const base = H - B;
  // passen niet alle namen (bv. 12 maanden op een gsm): om de 2 of 3 tonen, de laatste altijd,
  // en het jaartal onder de eerste getoonde maand van elk jaar
  const labeled = pts.map((p, i) => (p.x1 ? i : -1)).filter((i) => i >= 0);
  const gap = labeled.length > 1 ? Math.min(...labeled.slice(1).map((v, k) => v - labeled[k])) : n;
  const labW = Math.max(...pts.map((p) => (p.x1 || '').length)) * 6.6 + 8;
  const step = Math.max(1, Math.ceil(labW / (gap * slot)));
  const keep = new Set(labeled.filter((_, k) => (labeled.length - 1 - k) % step === 0));
  let shownYr = '';
  pts.forEach((p, i) => {
    if (step > 1) {
      const show = keep.has(i);
      p = { ...p, x1: show ? p.x1 : '', x2: p.yr ? (show && p.yr !== shownYr ? p.yr : '') : p.x2 };
      if (show && p.yr) shownYr = p.yr;
    }
    if (p.x1) {
      const lab = svgEl('text', { class: `haxis${p.now ? ' now' : ''}`, x: cx(i), y: base + 16, 'text-anchor': 'middle' });
      lab.textContent = p.x1;
      svg.append(lab);
    }
    if (p.x2) {
      const lab = svgEl('text', { class: 'haxis yr', x: cx(i), y: base + 29, 'text-anchor': 'middle' });
      lab.textContent = p.x2;
      svg.append(lab);
    }
  });
  const bw = Math.max(3, Math.min(24, slot - 4));
  if (m.kind === 'bar' || m.kind === 'range') {
    pts.forEach((p, i) => {
      if (p.v == null) return;
      const x = cx(i) - bw / 2;
      const cls = `hmark${p.part ? ' part' : ''}`;
      if (m.kind === 'range') {
        const lo = p.lo ?? sc.a;
        svg.append(svgEl('rect', { class: cls, x, y: y(p.v), width: bw, height: Math.max(2, y(lo) - y(p.v)), rx: Math.min(4, bw / 2) }));
      } else {
        svg.append(svgEl('path', { class: cls, d: topBar(x, y(p.v), bw, Math.max(1, y(sc.a) - y(p.v))) }));
      }
      if (p.goal) svg.append(svgEl('line', { class: 'hgoal', x1: x - 3, x2: x + bw + 3, y1: y(p.goal), y2: y(p.goal) }));
    });
  } else {
    const path = (f, cls) => {
      let dstr = ''; let pen = false;
      pts.forEach((p, i) => { const v = f(p); if (v == null) { pen = isMonth() ? pen : false; return; } dstr += `${pen ? 'L' : 'M'}${cx(i)},${y(v)}`; pen = true; });
      if (dstr) svg.append(svgEl('path', { class: cls, d: dstr }));
    };
    if (pts.some((p) => p.v2 != null)) path((p) => p.v2, 'hline2');
    path((p) => p.v, 'hline');
    const lastI = pts.map((p) => p.v != null).lastIndexOf(true);
    pts.forEach((p, i) => {
      if (p.v != null && (n <= 12 || i === lastI)) svg.append(svgEl('circle', { class: `hdot${p.part ? ' part' : ''}`, cx: cx(i), cy: y(p.v), r: 4 }));
    });
  }
  const focus = svgEl('circle', { class: 'hdot', r: 5, opacity: 0 });
  svg.append(focus);
  el.replaceChildren(svg);
  const tip = document.createElement('div');
  tip.className = 'htip';
  tip.hidden = true;
  el.append(tip);
  el.onpointermove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.floor((ev.clientX - rect.left - L) / slot);
    if (i < 0 || i >= n) { el.onpointerleave(); return; }
    const p = pts[i];
    hover.setAttribute('x', L + slot * i); hover.setAttribute('width', slot); hover.setAttribute('opacity', 1);
    if (m.kind === 'line' && p.v != null) { focus.setAttribute('cx', cx(i)); focus.setAttribute('cy', y(p.v)); focus.setAttribute('opacity', 1); } else focus.setAttribute('opacity', 0);
    tip.replaceChildren(...[p.title, ...p.lines].filter(Boolean).map((s, k) => Object.assign(document.createElement(k ? 'div' : 'b'), { textContent: s })));
    tip.hidden = false;
    // boven de meting; is daar geen plaats, dan naast de kolom (nooit over de meting heen)
    let top = (p.v == null ? T : y(p.v)) - tip.offsetHeight - 12; let left = cx(i) - tip.offsetWidth / 2;
    if (top < 0) {
      top = T;
      left = cx(i) + slot / 2 + 6;
      if (left + tip.offsetWidth > W) left = cx(i) - slot / 2 - 6 - tip.offsetWidth;
    }
    tip.style.left = `${Math.min(Math.max(left, 0), W - tip.offsetWidth)}px`;
    tip.style.top = `${top}px`;
  };
  el.onpointerleave = () => { hover.setAttribute('opacity', 0); focus.setAttribute('opacity', 0); tip.hidden = true; };
}
// ---- lichaamsleeftijd (zoals WHOOP Age): bovenaan Gezondheid ------------------------------------
const ageFrom = (birth) => { const [y, m = 7, d = 1] = String(birth).split('-').map(Number); return (Date.now() - new Date(y, m - 1, d)) / (365.25 * 864e5); };
function bodyForm(b) {
  const y = String(b.birth || '').slice(0, 4);
  return `<section class="mtile c-age bage-open"><div class="bage-x"><div class="label"><i class="mdot"></i>Lichaamsleeftijd</div><button class="link-btn" data-action="bage-close">Sluit</button></div>
    <p class="muted small" style="margin:0 0 10px">Vul je geboortejaar in (blijft op je toestel).</p>
    <form class="bage-form" data-form="body" autocomplete="off">
      <input class="input" name="birth" inputmode="numeric" maxlength="4" placeholder="Geboortejaar, bv. 1995" value="${esc(y)}" aria-label="Geboortejaar" required>
      <select class="input" name="sex" aria-label="Geslacht"><option value="m"${b.sex === 'f' ? '' : ' selected'}>Man</option><option value="f"${b.sex === 'f' ? ' selected' : ''}>Vrouw</option></select>
      <button class="btn primary" type="submit">Bewaar</button>
    </form>${S.bodyError ? `<div class="alert" style="margin:10px 0 0">${esc(S.bodyError)}</div>` : ''}</section>`;
}
// één tegel, minimalistisch: je lichaamsleeftijd en hoeveel jaar jonger (of ouder) je bent
function bodyAgeTile() {
  const b = S.settings.body || {};
  if (!b.birth || !b.sex) {
    if (S.bageOpen) return bodyForm(b);
    return `<button class="mtile c-age bage-t" data-action="bage-open"><div class="label"><i class="mdot"></i>Lichaamsleeftijd</div>
      <div class="big">?</div><div class="muted small">Tik en vul je geboortejaar in.</div></button>`;
  }
  const res = bodyAge({ age: ageFrom(b.birth), sex: b.sex, days: S.glance?.history || [], body: { weightKg: b.weightKg, heightCm: b.heightCm } });
  if (!res) return mtile('age', 'Lichaamsleeftijd', '–', 'nog te weinig gegevens');
  const d = res.floor ? res.raw : res.diff;                      // onder 18: hoeveel jaar je beter scoort dan je leeftijd
  const sub = Math.abs(d) < 0.5 ? 'zo oud als je bent' : `<b class="${d < 0 ? 'good' : 'bad'}">${nl1(Math.abs(d))} jaar ${d < 0 ? 'jonger' : 'ouder'}</b>`;
  return mtile('age', 'Lichaamsleeftijd', `${res.floor ? '18' : nl1(res.body)}<small> jaar</small>`, sub);
}
const r1x = (v) => Math.round(v * 10) / 10;
function drawHealth() {
  const rec = healthRec();
  if (!rec || rec.error) return;
  document.querySelectorAll('.hchart[data-chart]').forEach((el) => { const m = HM[el.dataset.chart]; if (m) drawChart(el, m, chartPoints(m, rec)); });
}
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S.view === 'overzicht') drawHealth(); }, 120); });

function browserRow() {
  const st = S.settings;
  const list = st.browsers || [];
  if (!list.length) return '';
  const opts = [`<option value="">Standaardbrowser</option>`,
    ...list.map((b) => `<option value="${esc(b.id)}" ${st.browser === b.id ? 'selected' : ''}>${esc(b.label)}</option>`)].join('');
  return `<div class="set-row"><div><div class="label">Browser</div><div class="v">Strava en Notion openen in</div>
      <small class="muted">Kies het browserprofiel waarin je op Strava bent ingelogd.</small></div>
    <select class="input" id="browserSel" aria-label="Browserprofiel" style="width: auto; min-width: 230px">${opts}</select></div>`;
}

function titleBlock() {
  const st = S.settings; const d = S.titleDraft; const saved = st.titleTemplate;
  let extra = '';
  if (d) {
    extra = `<div class="title-box">
      <div class="label">Voorbeeld op je laatste run · ${d.source === 'ai' ? 'gemaakt door de AI' : 'gemaakt met vaste regels (AI niet bereikbaar)'}</div>
      <div class="title-preview" id="titlePreview">${esc(d.preview)}</div>
      <label class="field"><span class="label">Sjabloon · mag je aanpassen</span>
        <input class="input mono" id="titleTpl" value="${esc(d.template)}" spellcheck="false" autocomplete="off"></label>
      <small class="muted">Velden: ${TITLE_FIELDS.map((f) => `{${f}}`).join(' ')}</small>
      <div class="title-err" id="titleErr"></div>
      <div class="btns" style="margin-top:4px"><button class="btn primary" data-action="title-save">Gebruik deze titel</button><button class="btn" data-action="title-cancel">Annuleren</button></div></div>`;
  } else if (saved) {
    extra = `<div class="title-box">
      <div class="label">Nu actief · voorbeeld op je laatste run</div>
      <div class="title-preview" id="titleNow">${esc(S.titleNow || saved)}</div>
      <code class="tpl">${esc(saved)}</code>
      <div class="btns" style="margin-top:4px"><button class="btn" data-action="title-apply">Zet ook op mijn laatste run</button><button class="btn" data-action="title-clear">Terug naar standaard</button></div></div>`;
  }
  const instr = d ? d.instruction : (st.titleInstruction || '');
  return `<div class="set-row stack"><div><div class="label">Titel op Strava</div><div class="v">Zeg wat je in de titel wil</div>
      <small class="muted">Bij elke sync krijgt een nieuwe run met een standaardnaam ("Ochtendloop") deze titel. De AI maakt van je zin een sjabloon; de cijfers komen altijd uit Strava.</small></div>
    <form class="title-form" data-form="title" autocomplete="off">
      <input class="input" id="titleInstr" name="instr" placeholder="bv. de kilometers, de tijd en mijn gemiddelde hartslag" value="${esc(instr)}">
      <button class="btn primary" type="submit" ${S.titleBusy ? 'disabled' : ''}>${S.titleBusy ? '<span class="spinner"></span> AI denkt na…' : 'Maak titel'}</button></form>
    ${extra}</div>`;
}

async function titleSuggest(form) {
  const instr = String(new FormData(form).get('instr') || '').trim();
  if (!instr) return toast('Schrijf eerst wat je in de titel wil.');
  S.titleBusy = true;
  render();
  try {
    S.titleDraft = { instruction: instr, ...(await api().title_suggest(instr)) };
  } catch (e) {
    toast(`Titel maken mislukt: ${errMsg(e)}`, 8000);
  } finally {
    S.titleBusy = false;
    render();
  }
  return undefined;
}

let titleTimer;
function titleLivePreview(tpl) {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    const res = await api().title_preview(tpl);
    const err = document.getElementById('titleErr');
    if (res.ok) { document.getElementById('titlePreview').textContent = res.preview; S.titleDraft.template = tpl; S.titleDraft.preview = res.preview; }
    if (err) err.textContent = res.ok ? '' : res.error;
  }, 250);
}

async function refreshTitleNow() {
  const tpl = S.settings.titleTemplate;
  if (!tpl || S.titleDraft) return;
  try {
    const res = await api().title_preview(tpl);
    S.titleNow = res.ok ? res.preview : '';
    const el = document.getElementById('titleNow');
    if (el && S.titleNow) el.textContent = S.titleNow;
  } catch { /* enkel voorbeeld */ }
}

async function finishSetup(btn) {
  btn.disabled = true;
  if (document.getElementById('mkShortcut')?.checked) {
    try { await api().make_shortcut(); toast('Snelkoppeling staat op je bureaublad en in het Startmenu'); } catch (e) { toast(errMsg(e), 6000); }
  }
  if (document.getElementById('mkAutoSync')?.checked) {
    try { S.autoSync = await api().set_auto_sync(true); } catch (e) { toast(errMsg(e), 6000); }
  }
  S.settings = await api().settings();
  S.planInfo = '';
  S.onboarding = false;
  S.view = 'overzicht';
  S.data = null;
  await doSync(true);
}

async function connect(form) {
  const f = new FormData(form);
  S.cid = String(f.get('clientId') || '').trim();
  S.csec = String(f.get('clientSecret') || '').trim();
  const rename = f.get('rename') === 'on';
  S.setupError = '';
  S.connecting = true;
  render();
  try {
    const res = WEB() ? await api().strava_connect(S.cid, S.csec, S.reconnect) : await api().strava_connect(S.cid, S.csec);
    await api().set_rename(rename);
    S.settings = await api().settings();
    S.connecting = false;
    S.csec = '';
    toast(res.scopeOk ? `Gekoppeld${res.athlete ? ` als ${res.athlete}` : ''}` : 'Gekoppeld, maar niet alle vinkjes stonden aan: privé-runs of hernoemen lukken niet.', res.scopeOk ? 3200 : 9000);
    if (S.reconnect) {
      S.reconnect = false;
      S.data = null;
      go('overzicht');
      await doRefresh();
      return;
    }
    S.step = 3;
    render();
  } catch (e) {
    S.connecting = false;
    S.setupError = errMsg(e);
    render();
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`Gekopieerd: ${text}`);
}

// ---- klikken & formulieren ------------------------------------------------------------------
const CONFIRM = new Set(['disconnect', 'delete-plan', 'goal-delete', 'title-apply', 'title-clear', 'garmin-off', 'wear-off', 'apple-off', 'web-unpair', 'web-reset', 'phone-off']);

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-run], [data-zoom], .zoom');
  if (!t) return;
  if (t.classList.contains('zoom-share')) { api().open_file(t.dataset.open); return; }
  if (t.classList.contains('zoom')) { t.remove(); return; }
  if (t.dataset.zoom !== undefined && t.src) {
    const z = Object.assign(document.createElement('div'), { className: 'zoom' });
    z.innerHTML = `<img src="${t.src}" alt="">${WEB() && t.dataset.card ? `<button class="btn primary zoom-share" data-open="${esc(t.dataset.card)}">Delen</button>` : ''}`;
    document.body.append(z);
    return;
  }
  if (t.dataset.sport) {
    S.sport = t.dataset.sport;
    render();
    try { await api().set_pref('hist_sport', S.sport); } catch { /* enkel onthouden */ }
    return undefined;
  }
  if (t.dataset.conn) {
    S.conn = S.conn === t.dataset.conn ? '' : t.dataset.conn;
    S.garminError = ''; S.wearError = '';
    return render();
  }
  if (t.dataset.extraNew) { S.extraSport = t.dataset.extraNew; S.xEdit = null; return go('extraform'); }
  if (t.dataset.goalEdit) {                                // een doel wijzigen: vragenlijst, of het zwemformulier
    const g = goalsList().find((x) => x.id === t.dataset.goalEdit);
    if (!g) return undefined;
    if (g.profile?.standalone) { S.extraSport = Object.keys(g.sports)[0]; S.xEdit = g.id; return go('extraform'); }
    S.gqEdit = g.id; return go('goalform');
  }
  if (t.dataset.gqSet) {
    const [k, v] = t.dataset.gqSet.split('|');
    const st = gqState();
    st.a[k] = /^\d+$/.test(v) ? Number(v) : v;
    if (st.a.notes) delete st.a.notes[k];                  // zelf gekozen: je getypte tekst geldt niet meer
    if (k === 'goal') { st.a.guessed = false; st.a.text = ''; }
    if (st.fromData) st.fromData[k] = false;
    if (k === 'goal' && GOAL_FORM[v]) return goalForm(v);                              // wedstrijd of zwemmen: eigen formulier
    st.step = nextStep(st);
    render(); $main.scrollTop = 0;
    return undefined;
  }
  if (t.dataset.gqToggle) {
    const [k, v] = t.dataset.gqToggle.split('|');
    const st = gqState(); const val = k === 'days' ? Number(v) : v;
    const cur = new Set(st.a[k] || []);
    if (cur.has(val)) cur.delete(val); else cur.add(val);
    st.a[k] = [...cur].sort((x, y) => (typeof x === 'number' ? x - y : 0));
    if (k === 'goals') { st.a.goal = Q_GOALS.find((x) => cur.has(x)) || st.a.goals[0] || null; st.a.text = ''; st.a.guessed = false; }
    if (st.fromData) st.fromData[k] = false;
    render();
    return undefined;
  }
  if (t.dataset.gqNext !== undefined) {
    const st = gqState(); const g = gqSteps()[st.step];
    const note = (st.a.notes?.[g.k] || (g.k === 'goal' ? st.a.text : '') || '').trim();
    if (g.k === 'goal' && note && !st.thinking && await aiOn()) {        // lokale AI: je tekst vult meteen alle vragen in
      st.thinking = true; render();
      let res = null;
      try { res = await api().goal_ai(note); } catch { res = null; }
      st.thinking = false;
      if (res?.ok && Object.keys(res.answers || {}).length) return applyAi(st, note, res.answers);
      render();                                                          // geen AI-antwoord: trefwoorden, zoals vroeger
    }
    const r = note ? parseNote(g.k, note) : null;
    if (r) {                                                // wat je zelf typte, gaat voor
      if (g.k === 'goal') { st.a.text = note; st.a.guessed = true; }
      Object.assign(st.a, r);
      if (st.fromData) st.fromData[g.k] = false;
    }
    if (g.k === 'goal' && startGoals(st, [...new Set([...(st.a.goals || []), ...(r?.goal ? [r.goal] : [])])])) return undefined;
    st.step = nextStep(st); render(); $main.scrollTop = 0; return undefined;
  }
  if (t.dataset.gqJump) {                                // één antwoord aanpassen, daarna terug naar de samenvatting
    const st = gqState(); const i = gqSteps().findIndex((g) => g.k === t.dataset.gqJump);
    if (i >= 0) { st.step = i; st.jumpBack = true; render(); $main.scrollTop = 0; }
    return undefined;
  }
  if (t.dataset.gqPrev !== undefined) { const st = gqState(); st.step = Math.max(0, st.step - 1); render(); $main.scrollTop = 0; return undefined; }
  if (t.dataset.hweek !== undefined) {
    if (!t.dataset.hweek) return undefined;
    S.hweek = t.dataset.hweek;
    render();
    return undefined;
  }
  if (t.dataset.hmonth !== undefined) {
    if (!t.dataset.hmonth) return undefined;
    S.hmonth = t.dataset.hmonth;
    render();
    return undefined;
  }
  if (t.dataset.hday !== undefined) {
    if (!t.dataset.hday) return undefined;
    S.hday = t.dataset.hday;
    render();
    return undefined;
  }
  if (t.dataset.hdays) {
    S.healthDays = t.dataset.hdays;
    render();
    try { await api().set_pref('health_days', S.healthDays); } catch { /* enkel onthouden */ }
    return undefined;
  }
  if (t.dataset.wkgo || t.dataset.wkstep) {              // een week kiezen (tik of ‹ ›): die week eronder, de strook blijft staan
    const m = t.dataset.wkgo || t.dataset.wkstep;
    const y0 = document.getElementById('wstrip')?.getBoundingClientRect().top;
    S.wkOpen.set(m, true); S.wkFocus = m;
    render();
    const y1 = document.getElementById('wstrip')?.getBoundingClientRect().top;
    if (y0 != null && y1 != null) $main.scrollTop += y1 - y0;
    return undefined;
  }
  if (t.dataset.wstrip) {
    const s = document.getElementById('wstrip');
    const c = s?.querySelector('.wchip');                                  // telkens één week opschuiven
    s?.scrollBy({ left: Number(t.dataset.wstrip) * (c ? c.offsetWidth + 6 : s.clientWidth / 3), behavior: 'smooth' });
    return undefined;
  }
  if (t.dataset.themeSet || t.dataset.action === 'theme') {
    S.settings.theme = t.dataset.themeSet || (S.settings.theme === 'light' ? 'dark' : 'light');
    applyTheme();
    render();
    try { await api().set_pref('theme', S.settings.theme); } catch { /* enkel onthouden */ }
    return undefined;
  }
  if (t.dataset.dayhealth) {
    S.hday = t.dataset.dayhealth;
    S.healthDays = 'dag';
    try { await api().set_pref('health_days', 'dag'); } catch { /* enkel onthouden */ }
    return go('gezondheid');
  }
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.run) return go('run', t.dataset.run);
  if (t.dataset.step) { S.step = ['pc', 'intro'].includes(t.dataset.step) ? t.dataset.step : Number(t.dataset.step); S.setupError = ''; render(); $main.scrollTop = 0; return; }
  if (t.dataset.copy) return copyText(t.dataset.copy);
  const a = t.dataset.action;
  if (CONFIRM.has(a) && !t.dataset.armed) {
    t.dataset.armed = '1';
    const label = t.textContent;
    t.textContent = 'Zeker? Klik nog eens';
    setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.textContent = label; } }, 4000);
    return;
  }
  try {
    if (t.dataset.open) return await api().open_file(t.dataset.open);
    if (t.dataset.month) return await api().open_folder(t.dataset.month);
    if (t.dataset.strava) return await api().open_url(`https://www.strava.com/activities/${t.dataset.strava}`);
    if (t.dataset.make) return await makeCard(t.dataset.make, t);
    if (a === 'sync') return await doSync(false);
    if (a === 'folder') return await api().open_folder('');
    if (a === 'conn-more') { S.connMore = true; render(); return undefined; }
    if (a === 'goal-save') return saveGoal();
    if (a === 'goal-new') { S.gqEdit = null; S.xEdit = null; S.planPrefill = null; S.xPrefill = null; S.goalQueue = []; return go('goalform'); }
    if (a === 'goal-delete') {
      const g = goalsList().find((x) => x.id === t.dataset.goal);
      await api().delete_goal(t.dataset.goal);
      S.settings = await api().settings();
      toast(`${g ? goalTitle(g).replace(/^"|"$/g, '') : 'Doel'} verwijderd. Je andere doelen blijven.`);
      return S.data ? doRefresh() : render();
    }
    if (a === 'notion') { const u = await api().notion_url(); if (u) await api().open_url(u); return undefined; }
    if (a === 'strava-api') return await api().open_url('https://www.strava.com/settings/api');
    if (a === 'icon') { await api().save_icon(); return toast('dE3p-icoon staat in je Downloads'); }
    if (a === 'cancel-connect') return await api().strava_cancel();
    if (a === 'finish') return await finishSetup(t);
    if (a === 'reconnect') { S.reconnect = true; S.step = 2; S.setupError = ''; return go('setup'); }
    if (a === 'cancel-reconnect') { S.reconnect = false; S.setupError = ''; return go('instellingen'); }
    if (a === 'disconnect') {
      await api().strava_disconnect();
      S.settings = await api().settings();
      if (WEB() && S.settings.connected) { toast('Strava ontkoppeld op deze gsm'); render(); return await doRefresh(); }
      S.data = null; S.step = WEB() ? 'intro' : 1; S.cid = ''; S.csec = ''; S.onboarding = true;
      return go('setup');
    }
    if (a === 'web-demo') { await api().demo(true); S.settings = await api().settings(); S.onboarding = false; S.data = null; go('overzicht'); return await doRefresh(); }
    if (a === 'web-demo-stop') { await api().demo(false); S.settings = await api().settings(); S.data = null; S.conn = '';
      if (!S.settings.connected) { S.step = 0; S.onboarding = true; return go('setup'); }
      render(); return await doRefresh(); }
    if (a === 'web-install') { if (!api().install()) toast('Gebruik het menu van je browser: App installeren'); return undefined; }
    if (a === 'web-strava') { S.reconnect = true; S.step = 1; S.setupError = ''; return go('setup'); }
    if (a === 'web-unpair') { await api().unpair_pc(); S.settings = await api().settings(); S.data = null; toast('Ontkoppeld van je computer');
      if (!S.settings.connected) { S.step = 0; S.onboarding = true; return go('setup'); }
      render(); return await doRefresh(); }
    if (a === 'web-reset') return await api().reset_all();
    if (a === 'phone-pair') {
      S.phoneBusy = true; render();
      try { S.phoneCode = await api().phone_pair(Boolean(t.dataset.new)); S.settings = await api().settings(); } finally { S.phoneBusy = false; render(); }
      return undefined;
    }
    if (a === 'phone-push') {
      S.phoneBusy = true; render();
      try { S.settings.phone = await api().phone_push(); toast(S.settings.phone.error ? 'Versturen mislukt' : 'Verstuurd naar je gsm'); } finally { S.phoneBusy = false; render(); }
      return undefined;
    }
    if (a === 'phone-off') { await api().phone_unpair(); S.phoneCode = null; S.settings = await api().settings(); render(); return toast('Gsm ontkoppeld'); }
    if (a === 'delete-plan') {
      await api().delete_plan();
      S.settings = await api().settings();
      toast('Schema verwijderd');
      render();
      if (S.data) await doRefresh();
      return undefined;
    }
    if (a === 'pick-folder') {
      const p = await api().pick_folder();
      if (p) { S.settings = await api().settings(); toast('Kaartenmap aangepast'); render(); if (S.data) await doRefresh(); }
      return undefined;
    }
    if (a === 'shortcut') { await api().make_shortcut(); return toast('Snelkoppeling staat op je bureaublad en in het Startmenu', 5000); }
    if (a === 'update-install') {
      t.disabled = true;
      t.innerHTML = '<span class="spinner"></span> Downloaden…';
      try {
        const v = await api().update_install();
        toast(`Versie ${v} wordt geïnstalleerd: het programma start zo opnieuw`, 15000);
      } catch (err) {
        t.disabled = false; renderSide(); render();
        toast(`Bijwerken lukte niet (${errMsg(err)}). Download de nieuwe versie op de website.`, 9000);
      }
      return undefined;
    }
    if (a === 'data-folder') return await api().open_data_folder();
    if (a === 'manual') return await api().open_manual();
    if (a === 'garmin-off') { await api().garmin_disconnect(); S.settings = await api().settings(); S.health = null; render(); return toast('Garmin ontkoppeld'); }
    if (a === 'garmin-refresh') { await api().garmin_recovery(true); S.health = null; toast('Garmin bijgewerkt'); return undefined; }
    if (a === 'health-refresh') { t.disabled = true; t.classList.add('busy'); return await loadHealth(true); }
    if (a === 'website') { await api().open_url('https://www.de3p.be/download/'); return undefined; }
    if (a === 'wear-portal') { await api().open_url(WEAR[t.dataset.k].url); return undefined; }
    if (a === 'wear-off') { await api().wear_disconnect(t.dataset.k); S.settings = await api().settings(); S.health = null; render(); return toast('Ontkoppeld'); }
    if (a === 'body-edit') { S.bodyEdit = true; S.bodyError = ''; render(); return undefined; }
    if (a === 'body-cancel') { S.bodyEdit = false; S.bodyError = ''; render(); return undefined; }
    if (a === 'bage-open') { S.bageOpen = true; render(); document.querySelector('.bage-open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return undefined; }
    if (a === 'bage-close') { S.bageOpen = false; S.bodyEdit = false; render(); return undefined; }
    if (a === 'apple-off') { await api().apple_disconnect(); S.settings = await api().settings(); S.health = null; S.glance = null; render(); return toast('Ontkoppeld'); }
    if (a === 'apple-connect') {
      S.appleBusy = true; S.wearError = ''; render();
      try {
        await api().apple_connect();
        S.settings = await api().settings(); S.health = null; S.glance = null;
        toast('Apple Watch gekoppeld');
      } catch (e) { S.wearError = errMsg(e); } finally { S.appleBusy = false; render(); }
      return undefined;
    }
    if (a === 'ollama') { await api().open_url('https://ollama.com/download'); return undefined; }
    if (a === 'ai-check') { S.ai = null; render(); return await loadAi(true); }
    if (a === 'update-check') { t.disabled = true; t.textContent = 'Bezig…'; await checkUpdate(true); return toast(S.update?.newer ? `Nieuwe versie ${S.update.latest} beschikbaar` : 'Je hebt de nieuwste versie'); }
    if (a === 'strava-profile') { await api().open_url(await api().strava_profile_url()); return undefined; }
    if (a === 'title-cancel') { S.titleDraft = null; return render(); }
    if (a === 'title-save') {
      const tpl = document.getElementById('titleTpl')?.value || S.titleDraft.template;
      S.titleNow = await api().title_save(S.titleDraft.instruction, tpl);
      S.settings = await api().settings();
      S.titleDraft = null;
      render();
      return toast('Nieuwe runs krijgen deze titel bij de volgende sync');
    }
    if (a === 'title-clear') {
      await api().title_clear();
      S.settings = await api().settings();
      S.titleNow = '';
      render();
      return toast('Terug naar de standaardtitel');
    }
    if (a === 'title-apply') {
      t.disabled = true;
      t.textContent = 'Bezig…';
      const name = await api().title_apply_last();
      toast(`Op Strava: ${name}`, 6000);
      render();
      if (S.data) await doRefresh();
      return undefined;
    }
  } catch (err) {
    toast(errMsg(err), 6000);
  }
  return undefined;
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  e.preventDefault();
  if (form.dataset.form === 'connect') connect(form);
  if (form.dataset.form === 'pair') pairSubmit(form);
  if (form.dataset.form === 'plan') savePlanForm(form);
  if (form.dataset.form === 'extra') saveExtraForm(form);
  if (form.dataset.form === 'title') titleSuggest(form);
  if (form.dataset.form === 'garmin' || form.dataset.form === 'garmin-mfa') garminSubmit(form);
  if (form.dataset.form === 'wear' || form.dataset.form === 'wearkey') wearSubmit(form);
  if (form.dataset.form === 'body') bodySubmit(form);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'titleTpl') titleLivePreview(e.target.value);
  if (e.target.matches('input.code')) { const v = fmtCode(e.target.value); if (v !== e.target.value) e.target.value = v; }
  if (e.target.name === 'gqnote' && S.gq) {
    const k = e.target.dataset.k;
    (S.gq.a.notes ||= {})[k] = e.target.value;
    if (k === 'goal') S.gq.a.text = e.target.value;
    const r = parseNote(k, e.target.value); const d = describeParse(k, r);
    const out = document.getElementById('gqParsed');
    if (out) out.innerHTML = d ? `dE3p begrijpt: <b>${esc(d)}</b>` : e.target.value.trim() && k !== 'profile' ? 'Nog niet duidelijk: kies hierboven, of typ het anders.' : '';
    const nb = document.querySelector('[data-gq-next]');
    const g = gqSteps()[S.gq.step];
    if (nb && g) nb.disabled = !gqOk(g, S.gq.a);
  }
  const pf = e.target.closest('form[data-form="plan"]');
  if (pf) updatePacePreview(pf);
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset.hpick !== undefined) {         // datumkiezer: die dag, of de dichtstbijzijnde ervoor
    const ds = (S.health?.rec?.history || []).map((x) => x.date).sort();
    const v = e.target.value;
    if (v && ds.length) { S.hday = ds.filter((x) => x <= v).pop() || ds[0]; render(); }
    return;
  }
  if (e.target.id === 'browserSel') {
    try {
      await api().set_browser(e.target.value);
      S.settings.browser = e.target.value;
      toast(e.target.value ? `Strava opent voortaan in ${e.target.selectedOptions[0].text}` : 'Strava opent in je standaardbrowser');
    } catch (err) { toast(errMsg(err), 6000); }
    return;
  }
  if (e.target.dataset.cardsport) {
    const keys = [...document.querySelectorAll('[data-cardsport]')].filter((x) => x.checked).map((x) => x.dataset.cardsport);
    try { await api().set_card_sports(keys); S.settings.cardSports = keys; toast('Opgeslagen: kaarten bij de volgende sync'); } catch (err) { toast(errMsg(err), 6000); }
    return;
  }
  if (e.target.id === 'autoSyncToggle') {
    try {
      S.autoSync = await api().set_auto_sync(e.target.checked);
      toast(S.autoSync ? 'Synct voortaan elk half uur op de achtergrond' : 'Automatisch syncen staat uit');
    } catch (err) { e.target.checked = !e.target.checked; toast(errMsg(err), 6000); }
    return;
  }
  if (e.target.id !== 'renameToggle') return;
  try {
    await api().set_rename(e.target.checked);
    S.settings.rename = e.target.checked;
    toast(e.target.checked ? 'Runs worden hernoemd naar je training' : 'Namen op Strava blijven zoals ze zijn');
  } catch (err) { toast(errMsg(err), 6000); }
});

document.addEventListener('toggle', (e) => { if (e.target.classList?.contains('adv')) S.advOpen = e.target.open; }, true);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.zoom')?.remove(); });

let toastTimer;
function toast(msg, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Gezondheid per dag: vegen naar rechts = vorige dag, naar links = volgende dag
let swipeX = null; let swipeY = null;
document.addEventListener('touchstart', (e) => {
  if (!e.target.closest('#dayview')) { swipeX = null; return; }
  swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (swipeX == null) return;
  const dx = e.changedTouches[0].clientX - swipeX; const dy = e.changedTouches[0].clientY - swipeY;
  swipeX = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const btn = document.querySelectorAll('.daynav .icon-btn')[dx > 0 ? 0 : 1];
  if (btn && !btn.disabled) btn.click();
}, { passive: true });
