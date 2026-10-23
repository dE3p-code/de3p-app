// Extra schema's naast het loopschema: zwemmen, lopen en fietsen, elk met een doel.
// Zelfde vorm voor beide: { sport, version, createdAt, config, weeks, sessions: [{ date, week, phase, title, name, detail, minutes, meters }] }
// title  = korte naam in het schema ("Zwemmen · intervallen")
// name   = naam voor Strava en de recap-kaart ("Zwemmen — 6×100 m @ 2:05/100 m")
// detail = de hele training, stap voor stap
import { today, addDays, mondayOf, daysBetween, fmtPace } from './util.js';

export const SWIM_GOALS = {
  afstand: 'Een afstand aan één stuk zwemmen',
  sneller: 'Sneller zwemmen',
  wedstrijd: 'Een wedstrijd of triatlon',
};

const r50 = (m) => Math.max(50, Math.round(m / 50) * 50);
const p100 = (sec) => `${fmtPace(sec)}/100 m`;

// de gekozen weekdagen (ma = 0) van week w, vanaf de startdatum
function sessionDates(start, nWeeks, days) {
  const first = mondayOf(start);
  const out = [];
  for (let w = 0; w < nWeeks; w += 1) {
    for (const d of [...days].sort((a, b) => a - b)) {
      const date = addDays(first, w * 7 + d);
      if (date >= start) out.push({ date, w });
    }
  }
  return out;
}

function weeksFor(cfg, start) {
  if (cfg.raceDate) return Math.max(2, Math.round(daysBetween(mondayOf(start), mondayOf(cfg.raceDate)) / 7) + 1);
  return Math.max(2, Number(cfg.weeks) || 8);
}

// elke 4de week rustiger, behalve de laatste
const isDeload = (w, n) => n >= 6 && (w + 1) % 4 === 0 && w < n - 1;

// ---- zwemmen ---------------------------------------------------------------------------
export function swimPlan(cfg) {
  const start = cfg.startDate || today();
  const n = weeksFor(cfg, start);
  const target = Math.max(100, Number(cfg.distance) || 1500);
  const now = Math.max(100, Math.min(target, Number(cfg.current) || 400));
  const pace = Number(cfg.paceSec) || 150;                                   // nu, per 100 m
  // doeltempo: uit de doeltijd, of (sneller zwemmen) een haalbare winst van ±5 %
  const goalPace = cfg.goalSec ? cfg.goalSec / (target / 100)
    : cfg.goal === 'sneller' ? pace - Math.min(10, Math.round(pace * 0.05)) : pace;
  const perWeek = cfg.days.length;
  const types = perWeek >= 3 ? ['techniek', 'intervallen', 'lang'] : perWeek === 2 ? ['intervallen', 'lang'] : ['mix'];
  const dates = sessionDates(start, n, cfg.days);
  const sessions = dates.map(({ date, w }, i) => {
    const f = n > 1 ? w / (n - 1) : 1;
    const deload = isDeload(w, n);
    const testWeek = w === n - 1 && cfg.goal !== 'sneller';
    const k = deload ? 0.8 : testWeek ? 0.6 : 1;                           // testweek: fris aan de start
    const long = r50((now + (Math.max(target, now) * 1.05 - now) * f) * k);
    const ip = Math.round(pace + (goalPace - pace) * Math.min(1, f * 1.15));    // intervaltempo schuift naar het doel
    const easy = Math.round(pace + 8);
    const wu = long >= 800 ? 300 : long >= 400 ? 200 : 100;
    const cd = long >= 800 ? 200 : 100;
    const last = w === n - 1 && dates.filter((x) => x.w === w).at(-1)?.date === date;
    const phase = deload ? 'Rustige week' : w === n - 1 ? (cfg.raceDate ? 'Wedstrijdweek' : 'Testweek') : f < 0.34 ? 'Basis' : 'Opbouw';
    // laatste zwembeurt: de test (of de wedstrijd)
    if (last && cfg.goal !== 'sneller') {
      const race = cfg.raceDate && date === cfg.raceDate;
      return { date, week: w + 1, phase, title: race ? 'Wedstrijd' : 'Zwemtest', name: race ? `Wedstrijd — ${target} m` : `Zwemtest — ${target} m aan één stuk`,
        detail: `${wu} m rustig inzwemmen · ${target} m aan één stuk${cfg.goalSec ? `, doel ${p100(goalPace)}` : ''} · ${cd} m uitzwemmen`,
        meters: wu + target + cd, minutes: Math.round(((wu + cd) * easy + target * goalPace) / 6000) };
    }
    const type = types[(dates.slice(0, i).filter((x) => x.w === w).length) % types.length];
    if (type === 'intervallen' || type === 'mix') {
      const rep = target >= 1500 && f > 0.4 ? 200 : now < 400 ? 50 : 100;
      const vol = r50(Math.max(rep * 4, long * (type === 'mix' ? 0.6 : 0.85)));
      const reps = Math.max(4, Math.round(vol / rep));
      const rest = rep >= 200 ? 30 : 20;
      const main = `${reps}×${rep} m @ ${p100(ip)} (${rest} s rust)`;
      const extra = type === 'mix' ? ` · ${r50(long * 0.4)} m rustig aan één stuk` : '';
      const m = wu + reps * rep + (type === 'mix' ? r50(long * 0.4) : 0) + cd;
      return { date, week: w + 1, phase, title: 'Zwemmen · intervallen', name: `Zwemmen — ${reps}×${rep} m @ ${fmtPace(ip)}/100 m`,
        detail: `${wu} m inzwemmen · ${main}${extra} · ${cd} m uitzwemmen`, meters: m, minutes: Math.round((m * (ip + 12)) / 6000) };
    }
    if (type === 'techniek') {
      const mid = r50(long * 0.5);
      const m = wu + 400 + mid + cd;
      return { date, week: w + 1, phase, title: 'Zwemmen · techniek', name: 'Zwemmen — techniek',
        detail: `${wu} m inzwemmen · 8×50 m techniek (één arm, catch-up, vingertoppen; 15 s rust) · ${mid} m rustig aan één stuk · ${cd} m uitzwemmen`,
        meters: m, minutes: Math.round((m * (easy + 10)) / 6000) };
    }
    const m = wu + long + cd;
    return { date, week: w + 1, phase, title: 'Zwemmen · lange afstand', name: `Zwemmen — ${long} m aan één stuk`,
      detail: `${wu} m inzwemmen · ${long} m aan één stuk, rustig (± ${p100(easy)}) · ${cd} m uitzwemmen`, meters: m, minutes: Math.round((m * easy) / 6000) };
  });
  return { sport: 'swim', version: 1, createdAt: new Date().toISOString(), config: { ...cfg, startDate: start }, weeks: n, goalPace, sessions };
}

// ---- lopen of fietsen voor je conditie (zonder wedstrijd) -------------------------------------
export function cardioPlan(sport, cfg) {
  const start = cfg.startDate || today();
  const n = weeksFor(cfg, start);
  const lvl = cfg.level || 'soms';
  const max = Number(cfg.minutes) || 45;
  const dates = sessionDates(start, n, cfg.days);
  const sessions = dates.map(({ date, w }, i) => {
    const f = n > 1 ? w / (n - 1) : 1;
    const deload = isDeload(w, n);
    const nth = dates.slice(0, i).filter((x) => x.w === w).length;         // de hoeveelste van die week
    const hard = nth % 2 === 1 && !deload && !cfg.careful && !(cfg.runUntil && date <= cfg.runUntil);   // steviger om de andere sessie (niet bij een blessure, niet naast je loopschema)
    const easyP = cfg.perf?.easy ? ` (± ${fmtPace(cfg.perf.easy)}/km)` : '';
    const fastP = cfg.perf?.fast ? ` @ ± ${fmtPace(Math.max(150, cfg.perf.fast - 5))}/km` : cfg.perf?.easy ? ` @ ± ${fmtPace(cfg.perf.easy - 45)}/km` : '';
    if (sport === 'ride') {
      const min = Math.round(Math.min(max, (lvl === 'start' ? 30 : 40) + (max - 30) * f) * (deload ? 0.75 : 1) / 5) * 5;
      if (hard) {
        const reps = lvl === 'start' ? 3 : lvl === 'soms' ? 4 : 5;
        return { date, week: w + 1, phase: deload ? 'Rustige week' : 'Opbouw', title: 'Fietsen · blokken', name: `Rit met blokken — ${reps}×5 min stevig`,
          detail: `${min} min fietsen: 10 min rustig opwarmen · ${reps}×5 min stevig (praten lukt amper), 3 min rustig ertussen · rustig uitbollen`, minutes: min };
      }
      return { date, week: w + 1, phase: deload ? 'Rustige week' : 'Opbouw', title: 'Fietsen · rustig', name: `Rustige rit — ${min} min`,
        detail: `${min} min rustig fietsen: je kan vlot praten.`, minutes: min };
    }
    // lopen
    if (lvl === 'start' && f < 0.6) {                                         // eerst wandel-loop
      const run = Math.min(5, 1 + Math.floor(f * 8)); const walk = run >= 4 ? 1 : 2;
      const reps = Math.max(4, Math.round((Math.min(max, 45) - 10) / (run + walk)));   // + 10 min in- en uitwandelen
      return { date, week: w + 1, phase: deload ? 'Rustige week' : 'Basis', title: 'Lopen · wandel-loop', name: `Wandel-loop — ${reps}×(${run} min lopen, ${walk} min wandelen)`,
        detail: `5 min stevig wandelen · ${reps}× (${run} min rustig lopen, ${walk} min wandelen) · 5 min uitwandelen`, minutes: reps * (run + walk) + 10 };
    }
    const base = cfg.perf?.min ? Math.max(20, Math.min(max, Math.round((cfg.perf.min * 0.8) / 5) * 5)) : lvl === 'start' ? 20 : lvl === 'soms' ? 25 : 35;
    const min = Math.round(Math.min(max, base + (max - base) * f) * (deload ? 0.75 : 1) / 5) * 5;
    if (hard) {
      const [reps, on] = lvl === 'vaak' ? [5 + Math.round(f * 2), 3] : lvl === 'soms' ? [4 + Math.round(f * 2), 2] : [6, 1];
      return { date, week: w + 1, phase: 'Opbouw', title: 'Lopen · intervallen', name: `Intervallen — ${reps}×${on} min vlot`,
        detail: `${min} min in totaal: 10 min rustig inlopen · ${reps}× ${on} min vlot${fastP} (stevig maar gecontroleerd), ${on} min rustig ertussen · rustig uitlopen`, minutes: min };
    }
    return { date, week: w + 1, phase: deload ? 'Rustige week' : f < 0.34 ? 'Basis' : 'Opbouw', title: 'Lopen · rustig', name: `Rustige loop — ${min} min`,
      detail: `${min} min rustig lopen${easyP}: je kan vlot praten.${nth === 0 && !deload && lvl !== 'start' && !cfg.careful ? ' Op het einde 6×20 s versnellen.' : ''}`, minutes: min };
  });
  return { sport, version: 1, createdAt: new Date().toISOString(), config: { ...cfg, startDate: start }, weeks: n, sessions };
}

// ---- doel + vragenlijst → één schema met lopen, fietsen en zwemmen ------------------------------
export const GOALS = {
  slank: { t: 'Fitter en slanker', d: 'Je conditie verbeteren en vet verliezen, met lopen, fietsen of zwemmen.' },
  gezond: { t: 'Gezond en in vorm blijven', d: 'Regelmatig bewegen en in vorm blijven, zonder druk.' },
  lopen: { t: 'Beter lopen of een wedstrijd', d: 'Een loopschema naar je wedstrijd en doeltijd.' },
  zwemmen: { t: 'Beter zwemmen', d: 'Langer of sneller zwemmen.' },
};
// korte namen als je meer doelen tegelijk kiest ("Fitter en slanker + Gezond en in vorm")
const QS = { slank: 'Fitter en slanker', gezond: 'Gezond en in vorm' };
export const LEVELS = { start: 'Ik begin (bijna) van nul', soms: 'Ik sport af en toe', vaak: 'Ik sport regelmatig' };
export const CARDIO = { run: 'Lopen', ride: 'Fietsen', swim: 'Zwemmen' };

// lichter: korter (ook de minuten in de tekst), de uitleg komt achteraan
const lighter = (s, why) => {
  const min = s.minutes ? Math.max(15, Math.round((s.minutes * 0.7) / 5) * 5) : s.minutes;
  const detail = s.minutes ? s.detail.replace(new RegExp(`^${s.minutes} min\\b`), `${min} min`) : s.detail;   // '25 min rustig lopen' → '20 min …'
  return { ...s, phase: why, title: `${s.title} · licht`, name: `${s.name} (licht)`,
    minutes: min, meters: s.meters ? r50(s.meters * 0.7) : s.meters,
    detail: `${detail.replace(/\.?\s*$/, '.')} ${why}: lichter dan normaal (korter en rustig).` };
};
// ctx = { race: 'JJJJ-MM-DD' | null, taper: dagen vóór de raceweek (14 bij een (halve) marathon, anders 7) }
// rond je wedstrijd niets extra, in je raceweek kort en rustig, in je taper en de week erna lichter
export function fitToRace(plan, ctx) {
  const race = ctx?.race;
  if (!race || !plan?.sessions?.length) return plan;
  const rw = mondayOf(race);
  const taperFrom = addDays(rw, -(ctx.taper || 14));
  const out = [];
  for (const s of plan.sessions) {
    const d = s.date;
    if (d >= addDays(race, -2) && d <= addDays(race, 3)) continue;
    if (d >= rw && d < race) {
      out.push({ ...lighter(s, 'Raceweek'), minutes: Math.min(30, s.minutes || 30) });
      continue;
    }
    if (d >= taperFrom && d < rw) { out.push(lighter(s, 'Taper voor je wedstrijd')); continue; }
    if (d > addDays(race, 3) && d <= addDays(race, 10)) { out.push(lighter(s, 'Herstel na je wedstrijd')); continue; }
    out.push(s);
  }
  return { ...plan, sessions: out, config: { ...plan.config, race } };
}

export function goalPlan(a) {
  const days = [...a.days].sort((x, y) => x - y);
  const qs = (a.goals || [a.goal]).filter((g) => QS[g]);
  const base = { startDate: a.startDate || today(), weeks: Number(a.weeks) || 12, level: a.level, minutes: Number(a.minutes) || 45,
    perf: a.perf || null, careful: Boolean(a.careful), runUntil: a.runUntil || null };
  const plans = {};
  // dE3p = duursporten: elke dag lopen, fietsen of zwemmen, de gekozen sporten om de beurt
  let prefs = (a.cardio && a.cardio.length ? a.cardio : ['run']).filter((s) => CARDIO[s]);
  if (a.careful && prefs.length === 1 && prefs[0] === 'run') prefs = ['run', 'ride'];      // blessure: loopdagen afwisselen met fietsen
  const per = {};
  days.forEach((d, i) => { const s = prefs[i % prefs.length]; (per[s] ||= []).push(d); });
  for (const [s, ds] of Object.entries(per)) {
    plans[s] = s === 'swim'
      ? swimPlan({ ...base, days: ds, goal: 'afstand', distance: a.level === 'vaak' ? 1500 : a.level === 'soms' ? 1000 : 750,
        current: a.level === 'vaak' ? 800 : a.level === 'soms' ? 400 : 200, paceSec: a.level === 'vaak' ? 120 : a.level === 'soms' ? 135 : 150 })
      : cardioPlan(s, { ...base, days: ds });
  }
  if (a.runUntil && plans.run) {                       // je loopschema loopt nog: dan geen tweede loop op een dag
    plans.run.sessions = plans.run.sessions.filter((s) => s.date > a.runUntil);
    if (!plans.run.sessions.length) delete plans.run;
  }
  for (const s of Object.keys(plans)) {                // je wedstrijd: taper, raceweek en herstel
    plans[s] = fitToRace(plans[s], a.ctx);
    if (!plans[s].sessions.length) delete plans[s];
  }
  Object.values(plans).forEach((p) => { p.config.fromGoal = true; });
  const own = String(a.text || '').trim();
  const profile = { ...a, title: own ? `"${own.charAt(0).toUpperCase()}${own.slice(1)}"` : qs.length > 1 ? qs.map((g) => QS[g]).join(' + ') : GOALS[a.goal]?.t || 'Je doel',
    kind: GOALS[a.goal]?.t || '', startDate: base.startDate, weeks: base.weeks, createdAt: new Date().toISOString() };
  delete profile.ctx;
  return { profile, plans };
}
