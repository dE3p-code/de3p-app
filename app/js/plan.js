// Schema-generator: opbouw (max +10%/week, herstelweek elke 4e week) → piek →
// taper → wedstrijdweek. Tempo's worden afgeleid van het doeltempo.
// Alles blijft per dag aanpasbaar in de app.

import { addDays, mondayOf, weekday, daysBetween, today, fmtPace, fmtTime } from './util.js';

export const DISTANCES = {
  marathon: { km: 42.195, label: 'Marathon', taper: [0.75, 0.6], raceWeek: 0.35,
    peakMul: 1.6, peakCap: 95, longShare: 0.42, longMin: 12, longCap: 32 },
  half: { km: 21.0975, label: 'Halve marathon', taper: [0.7], raceWeek: 0.45,
    peakMul: 1.45, peakCap: 75, longShare: 0.33, longMin: 10, longCap: 21 },
  '10k': { km: 10, label: '10 km', taper: [0.85], raceWeek: 0.55,
    peakMul: 1.35, peakCap: 65, longShare: 0.28, longMin: 8, longCap: 16 },
  '5k': { km: 5, label: '5 km', taper: [0.85], raceWeek: 0.6,
    peakMul: 1.3, peakCap: 55, longShare: 0.26, longMin: 6, longCap: 13 },
};

// Tempozones als factor t.o.v. het wedstrijdtempo (sec/km).
const ZONES = {
  marathon: { recovery: [1.25, 1.35], easy: [1.18, 1.27], long: [1.14, 1.23], tempo: [0.94, 0.96], interval: [0.87, 0.89] },
  half: { recovery: [1.28, 1.38], easy: [1.18, 1.28], long: [1.15, 1.25], tempo: [0.98, 1.0], interval: [0.92, 0.94] },
  '10k': { recovery: [1.34, 1.46], easy: [1.24, 1.36], long: [1.22, 1.33], tempo: [1.04, 1.06], interval: [0.96, 0.98] },
  '5k': { recovery: [1.4, 1.53], easy: [1.29, 1.42], long: [1.27, 1.39], tempo: [1.08, 1.1], interval: [0.98, 1.0] },
};

export const KINDS = {
  recovery: { label: 'Herstel', title: 'Herstelloop' },
  easy: { label: 'Rustig', title: 'Rustige duurloop' },
  strides: { label: 'Rustig', title: 'Rustige duurloop' },
  long: { label: 'Lang', title: 'Lange duurloop' },
  tempo: { label: 'Tempo', title: 'Tempoduurloop' },
  interval: { label: 'Interval', title: 'Intervaltraining' },
  mp: { label: 'Wedstrijdtempo', title: 'Wedstrijdtempo-blok' },
  race: { label: 'Wedstrijd', title: 'Wedstrijd' },
  rest: { label: 'Rust', title: 'Rust' },
  cross: { label: 'Fiets', title: 'Fiets' },
};

// Beginnen vanaf nul: eerst lopen en wandelen afwisselen tot je 30 minuten aan één stuk loopt
// (3 keer per week), pas daarna kilometers. Je moet je doelafstand dus nog niet kunnen lopen.
export const LADDER = [
  { reps: 8, run: 1, walk: 2 }, { reps: 6, run: 2, walk: 2 }, { reps: 5, run: 3, walk: 2 },
  { reps: 4, run: 5, walk: 2 }, { reps: 3, run: 8, walk: 2 }, { reps: 2, run: 12, walk: 2 },
  { run: 20 }, { run: 25 }, { run: 30 },
];
export const RUN_LEVELS = {
  walk: { label: 'Ik loop nog niet', hint: 'Je begint met 1 minuut lopen en 2 minuten wandelen.', from: 0 },
  run15: { label: 'Ik kan 10 à 15 minuten lopen', hint: 'Je begint met 2 keer 12 minuten lopen, met wandelen ertussen.', from: 5 },
  km: { label: 'Ik loop al', hint: 'Het schema begint bij je kilometers van nu.', from: null },
};
// geen doeltijd (weet je nog niet): rustige tempo's, zodat het schema toch werkt
export const EASY_GOAL = { '5k': 34 * 60, '10k': 72 * 60, half: 2.75 * 3600, marathon: 5.75 * 3600 };

export const RUN_KINDS = new Set(['recovery', 'easy', 'strides', 'long', 'tempo', 'interval', 'mp', 'race']);
export const isRunDay = (day) => RUN_KINDS.has(day.kind);

const r05 = (x) => Math.round(x * 2) / 2;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- weekindeling ----------------------------------------------------------
function layout(cfg) {
  const rest = Number(cfg.restDay ?? 4);
  const long = Number(cfg.longDay ?? 5);
  const cross = cfg.crossDay === '' || cfg.crossDay == null ? null : Number(cfg.crossDay);
  const nRun = clamp(Number(cfg.runDays) || 5, 3, 6);
  const pref = [1, 3, 0, 2, 6, 4, 5].filter((d) => d !== rest && d !== long && d !== cross);
  const runs = pref.slice(0, nRun - 1).sort((a, b) => a - b);

  let recovery = null;
  for (let i = 1; i < 7; i += 1) {
    const d = (long + i) % 7;
    if (runs.includes(d)) { recovery = d; break; }
  }
  const dayBeforeLong = (long + 6) % 7;
  const qualPref = [1, 3, 2, 0, 6, 4, 5];
  const nQual = nRun >= 5 ? 2 : 1;
  let quality = qualPref.filter((d) => runs.includes(d) && d !== recovery && d !== dayBeforeLong);
  if (quality.length < nQual) quality = qualPref.filter((d) => runs.includes(d) && d !== recovery);
  quality = quality.slice(0, nQual).sort((a, b) => a - b);

  return { rest, long, cross, runs, recovery, quality };
}

// ---- hoofdfunctie ----------------------------------------------------------
export function generatePlan(cfg) {
  const D = DISTANCES[cfg.distance] || DISTANCES.marathon;
  const Z = ZONES[cfg.distance] || ZONES.marathon;
  const rp = cfg.goalSec / D.km;                          // wedstrijdtempo sec/km
  const zone = (z) => Z[z].map((f) => Math.round(rp * f));
  const single = (sec) => [Math.round(sec), Math.round(sec)];
  const isMarathon = cfg.distance === 'marathon';
  const mpTitle = isMarathon ? 'Marathonpace-blok' : 'Wedstrijdtempo-blok';

  const start = cfg.startDate || today();
  const firstMon = mondayOf(start);
  const raceMon = mondayOf(cfg.raceDate);
  const nPre = Math.max(0, Math.round(daysBetween(firstMon, raceMon) / 7));
  const t = Math.min(D.taper.length, Math.max(0, nPre - 1));
  const taperCurve = t ? D.taper.slice(-t) : [];
  const nBuild = nPre - t;

  // beginner: eerst de wandel-loopweken, stap voor stap (nooit een stap overslaan). Is er te weinig
  // tijd, dan gaat de ladder door tot de wedstrijd en loop je die met wandelen ertussen.
  const from = RUN_LEVELS[cfg.level]?.from;
  const need = from != null ? LADDER.length - from : 0;
  const allWalk = from != null && need >= nBuild;            // geen tijd voor km-weken: ook geen taper
  const ladder = from == null ? [] : LADDER.slice(from, from + (allWalk ? nPre : need));
  const easyPace = zone('easy')[1];
  const walkKm = (st) => r05(Math.max(1, ((st.reps || 1) * st.run * 60) / easyPace + ((st.reps || 0) * (st.walk || 0) * 60 + 600) / 600));
  const nRun = allWalk ? 0 : nBuild - ladder.length;                     // daarna: gewone opbouw in kilometers

  // opbouw richting piek
  const base = ladder.length ? Math.max(8, walkKm(ladder[ladder.length - 1]) * 3) : Math.max(8, Number(cfg.baseKm) || 30);
  const peak = Math.max(base, Math.min(base * D.peakMul, D.peakCap));
  const cutWeeks = nRun >= 5 ? Math.floor((nRun - 1) / 4) : 0;
  const steps = Math.max(1, nRun - 1 - cutWeeks);
  const g = Math.min(1.1, (peak / base) ** (1 / steps));
  const weeks = ladder.map((st, i) => ({ km: walkKm(st) * 3, phase: 'Start', walk: st, i }));
  let v = base;
  for (let k = 0; k < nRun; k += 1) {
    const i = ladder.length + k;
    const cut = nRun >= 5 && (k + 1) % 4 === 0 && k < nRun - 1;
    if (k > 0 && !cut) v = Math.min(peak, v * g);
    const late = k >= nRun - 2;                            // laatste 2 opbouwweken = piek
    const phase = cut ? 'Herstelweek' : late && (nRun >= 3 || t > 0) ? 'Piek'
      : nRun >= 6 && k < Math.floor(nRun * 0.25) ? 'Basis' : 'Opbouw';
    weeks.push({ km: cut ? v * 0.8 : v, phase, i });
  }
  const reached = Math.max(nRun ? base : 0, ...weeks.map((w) => w.km));
  if (!allWalk) taperCurve.forEach((f, j) => weeks.push({ km: reached * f, phase: 'Taper', i: nBuild + j }));
  const beginner = from != null;
  const walkRace = allWalk && ladder[ladder.length - 1]?.reps;   // nog niet aan één stuk: wedstrijd met wandelen

  const L = layout(cfg);
  const out = [];

  // gewone weken (opbouw + taper)
  weeks.forEach((w, wi) => {
    const monday = addDays(firstMon, wi * 7);
    const days = w.walk ? buildWalkWeek(monday, w.walk) : buildWeek(monday, w, wi);
    // weektotaal = wat er echt in de week staat (zo klopt het getal met de trainingen)
    out.push({ monday, phase: w.phase, km: r05(days.filter(isRunDay).reduce((x, d) => x + d.km, 0)), days });
  });

  // wedstrijdweek
  const raceWeekDays = buildRaceWeek(raceMon, reached * D.raceWeek);
  out.push({ monday: raceMon, phase: 'Wedstrijdweek', km: r05(reached * D.raceWeek), days: raceWeekDays });

  // dagen vóór de startdatum weglaten
  out.forEach((w) => { w.days = w.days.filter((d) => d.date >= start); });
  const plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    config: { ...cfg, startDate: start },
    weeks: out.filter((w) => w.days.length).map((w, i) => ({ ...w, index: i + 1 })),
  };
  return plan;

  // ---- wandel-loopweek: 3 keer, nooit twee dagen na elkaar ------------------
  function buildWalkWeek(monday, st) {
    const near = (a, b) => Math.min((a - b + 7) % 7, (b - a + 7) % 7) <= 1;
    const pick = [L.long];
    for (const d of [1, 3, 2, 0, 4, 6, 5].filter((x) => L.runs.includes(x))) {
      if (pick.length < 3 && !pick.some((x) => near(x, d))) pick.push(d);
    }
    for (const d of L.runs) if (pick.length < 3 && !pick.includes(d)) pick.push(d);
    const title = st.reps ? 'Lopen en wandelen' : `${st.run} min rustig lopen`;
    const detail = st.reps ? `${st.reps}× ${st.run} min lopen + ${st.walk} min wandelen, op praattempo`
      : `${st.run} min aan één stuk, op praattempo. Wandelen mag altijd.`;
    const byDow = {};
    for (const d of L.runs.concat(L.long)) {
      byDow[d] = pick.includes(d)
        ? { kind: d === L.long ? 'long' : 'easy', title, detail, km: walkKm(st), pace: zone('easy'), walk: true }
        : { kind: 'rest', km: 0, pace: null, detail: 'Rust, of een wandeling van 30 min' };
    }
    byDow[L.rest] = { kind: 'rest', km: 0, pace: null, detail: 'Volledig herstel' };
    if (L.cross != null) byDow[L.cross] = { kind: 'cross', km: 0, pace: null, detail: '30–45 min rustig' };
    return toDays(monday, byDow);
  }

  // ---- weekopbouw ----------------------------------------------------------
  function buildWeek(monday, w, wi) {
    const vol = w.km;
    const late = w.phase === 'Piek';
    const taper = w.phase === 'Taper';
    const basis = w.phase === 'Basis';
    const cut = w.phase === 'Herstelweek';

    // lange duurloop
    const longKm = r05(clamp(Math.min(vol * D.longShare, vol * 0.5), Math.min(D.longMin, vol * 0.5), D.longCap));
    const longDay = { kind: 'long', km: longKm, pace: zone('long') };
    if ((late || (taper && isMarathon && wi === weeks.length - t)) && (isMarathon || cfg.distance === 'half')) {
      const fin = r05(longKm * (isMarathon ? 0.25 : 0.2));
      longDay.title = isMarathon ? 'Lange duurloop met MP-finish' : 'Lange duurloop met tempo-finish';
      longDay.detail = `${fmt(longKm)} km, laatste ${fmt(fin)} km @ ${fmtPace(rp)}`;
    } else {
      longDay.detail = `${fmt(longKm)} km rustig`;
    }

    // kwaliteitstrainingen
    const q = [];
    const nQ = L.quality.length;
    if (basis) {
      q.push('strides', 'easy');
    } else if (cut) {
      q.push('strides', 'tempo');
    } else if (taper) {
      q.push('interval', 'mp');
    } else {
      q.push('interval', (late && (isMarathon || cfg.distance === 'half')) ? 'mp' : 'tempo');
    }
    if (nQ === 1) q.splice(0, 2, wi % 2 === 0 ? q[0] : q[1]);
    // weinig kilometers = beginner: nog geen intervallen of tempo, enkel rustig + versnellingen
    // beginner: na de wandel-loopweken eerst nog 4 weken enkel rustig
    if (vol < 20 || (beginner && w.i < ladder.length + 4)) q.splice(0, q.length, 'strides', 'easy');
    const shrink = taper ? 0.7 : cut ? 0.8 : 1;
    const wu = vol < 30 ? 1 : 2;                           // in- en uitlopen (km), korter bij weinig volume
    const iu = (km) => `${wu} km IL + ${km} + ${wu} km UL`;

    const qualityDays = L.quality.map((d, k) => {
      const kind = q[k] || 'easy';
      if (kind === 'interval') {
        const reps = Math.round(clamp(vol * 0.1 * shrink, 3, 10));
        return { dow: d, kind, km: reps + 2 * wu, pace: zone('interval'),
          detail: iu(`${reps}×1 km @ ${fmtPace(zone('interval')[0])} (90s rust)`) };
      }
      if (kind === 'tempo') {
        const tk = r05(clamp(vol * 0.12 * shrink, 2, 12));
        return { dow: d, kind, km: tk + 2 * wu, pace: zone('tempo'),
          detail: iu(`${fmt(tk)} km @ ${fmtPace(zone('tempo')[0])}`) };
      }
      if (kind === 'mp') {
        const mk = r05(clamp(vol * 0.15 * shrink, vol < 30 ? 2 : 4, 16));
        return { dow: d, kind, km: mk + 2 * wu, pace: single(rp), title: mpTitle,
          detail: iu(`${fmt(mk)} km @ ${fmtPace(rp)}`) };
      }
      return { dow: d, kind, km: 0, pace: zone('easy'), detail: kind === 'strides' ? '+ 6 versnellingen van 20 s' : '' };
    });

    // rustige dagen vullen de rest van het volume
    const fixed = longKm + qualityDays.reduce((s, x) => s + x.km, 0);
    const easyDows = L.runs.filter((d) => !L.quality.includes(d));
    const fillers = [
      ...easyDows.map((d) => ({ dow: d, kind: d === L.recovery ? 'recovery' : 'easy', w: d === L.recovery ? 0.8 : 1 })),
      ...qualityDays.filter((x) => x.km === 0).map((x) => ({ ...x, w: 1 })),
    ];
    const sumW = fillers.reduce((s, f) => s + f.w, 0) || 1;
    const rest = Math.max(0, vol - fixed);
    const minEasy = vol < 25 ? 3 : 4;
    let fillKm = (f) => r05(Math.max(minEasy, (rest * f.w) / sumW));
    // toch boven het weekvolume (vaste trainingen + minimumlopen)? De lange duurloop korter,
    // zodat de opbouw van max. +10% per week klopt
    const total = fixed + fillers.reduce((s, f) => s + fillKm(f), 0);
    if (total > vol * 1.08 + 0.5) {
      const over = total - vol;
      longDay.km = r05(Math.max(Math.min(D.longMin, vol * 0.4), longKm - over));
      if (!longDay.title) longDay.detail = `${fmt(longDay.km)} km rustig`;
      else longDay.detail = longDay.detail.replace(/^[\d,]+ km/, `${fmt(longDay.km)} km`);
    }

    const byDow = {};
    byDow[L.long] = longDay;
    qualityDays.filter((x) => x.km > 0).forEach((x) => { byDow[x.dow] = x; });
    // geen rustige loop langer dan de lange duurloop: herstel hooguit 60%, rustig hooguit 80%
    // ervan. Wat er niet in past, gaat naar lopen met nog ruimte en valt anders weg (liever
    // iets minder dan een te zware week).
    const kms = fillers.map(fillKm);
    const capOf = (f) => Math.max(minEasy, r05(longDay.km * (f.kind === 'recovery' ? 0.6 : 0.8)));
    for (let round = 0; round < 3; round += 1) {
      let over = 0;
      fillers.forEach((f, i) => { const c = capOf(f); if (kms[i] > c) { over += kms[i] - c; kms[i] = c; } });
      const room = fillers.map((f, i) => (kms[i] < capOf(f) ? i : -1)).filter((i) => i >= 0);
      if (!over || !room.length) break;
      room.forEach((i) => { kms[i] = r05(kms[i] + over / room.length); });
    }
    fillers.forEach((f, i) => {
      byDow[f.dow] = { kind: f.kind, km: kms[i], pace: zone(f.kind === 'recovery' ? 'recovery' : 'easy'),
        detail: f.detail || '' };
    });
    byDow[L.rest] = { kind: 'rest', km: 0, pace: null, detail: 'Volledig herstel' };
    if (L.cross != null) byDow[L.cross] = { kind: 'cross', km: 0, pace: null, detail: '60–90 min rustig' };

    return toDays(monday, byDow);
  }

  function buildRaceWeek(monday, vol) {
    const raceDow = weekday(cfg.raceDate);
    const byDow = {};
    const before = L.runs.concat(L.long).filter((d) => d < raceDow - 1 && !(beginner && d === 0)).sort((a, b) => a - b);   // beginner: maandag rust na het weekend
    const tuneUp = before.find((d) => d <= raceDow - 3 && d !== L.recovery) ?? null;
    // beginner: nooit twee dagen na elkaar lopen, en verder rust
    const strideDay = before.filter((d) => d !== tuneUp && !(beginner && tuneUp != null && Math.abs(d - tuneUp) <= 1)).pop() ?? null;
    const easyKm = r05(clamp(vol / Math.max(1, before.length), 2, 10));

    for (let d = 0; d < 7; d += 1) {
      if (d === raceDow) {
        byDow[d] = { kind: 'race', title: cfg.raceName || D.label, km: D.km, pace: single(rp),
          detail: walkRace ? 'Lopen en wandelen afwisselen, zoals op training. Uitlopen is het doel.'
            : cfg.goalAuto ? 'Doel: uitlopen in je eigen tempo. Wandelen mag altijd.' : `Doel ${fmtTime(cfg.goalSec)} · ${fmtPace(rp)}/km` };
      } else if (d > raceDow || d === raceDow - 1) {
        byDow[d] = { kind: 'rest', km: 0, pace: null, detail: d > raceDow ? 'Herstel na de wedstrijd' : 'Rust voor de wedstrijd' };
      } else if ((d === tuneUp || d === strideDay) && walkRace) {   // nog niet aan één stuk: zoals op training, iets korter
        const st = ladder[ladder.length - 1];
        byDow[d] = { kind: 'easy', title: 'Lopen en wandelen', km: r05(walkKm(st) * 0.7), pace: zone('easy'), walk: true,
          detail: `${Math.max(2, st.reps - 2)}× ${st.run} min lopen + ${st.walk} min wandelen, heel rustig` };
      } else if (d === tuneUp && beginner) {
        byDow[d] = { kind: 'easy', title: '20 min rustig lopen', km: Math.min(3, easyKm), pace: zone('easy'), detail: 'Op praattempo, benen los voor de wedstrijd', walk: true };
      } else if (d === tuneUp) {
        const small = reached < 25;                          // beginner: korter blok
        byDow[d] = { kind: 'mp', title: mpTitle, km: small ? 4 : 6, pace: single(rp),
          detail: small ? `1 km IL + 2 km @ ${fmtPace(rp)} + 1 km UL` : `2 km IL + 3 km @ ${fmtPace(rp)} + 1 km UL` };
      } else if (d === strideDay) {
        byDow[d] = beginner ? { kind: 'easy', title: '15 min rustig lopen', km: Math.min(2.5, easyKm), pace: zone('easy'), detail: 'Heel rustig, wandelen mag', walk: true }
          : { kind: 'strides', km: Math.min(5, easyKm), pace: zone('easy'), detail: '+ 3 versnellingen, benen wakker' };
      } else if (before.includes(d) && beginner) {
        byDow[d] = { kind: 'rest', km: 0, pace: null, detail: 'Rust, of een wandeling van 30 min' };
      } else if (before.includes(d)) {
        byDow[d] = { kind: d === L.recovery ? 'recovery' : 'easy', km: easyKm,
          pace: zone(d === L.recovery ? 'recovery' : 'easy'), detail: '' };
      } else if (d === L.cross) {
        byDow[d] = { kind: 'cross', km: 0, pace: null, detail: '30–45 min heel rustig' };
      } else {
        byDow[d] = { kind: 'rest', km: 0, pace: null, detail: 'Volledig herstel' };
      }
    }
    return toDays(monday, byDow);
  }

  function toDays(monday, byDow) {
    const days = [];
    for (let d = 0; d < 7; d += 1) {
      const x = byDow[d] || { kind: 'rest', km: 0, pace: null, detail: '' };
      days.push({
        date: addDays(monday, d),
        kind: x.kind,
        title: x.title || KINDS[x.kind].title,
        detail: x.detail || '',
        km: x.km ? r05(x.km) : 0,
        pace: x.pace || null,
        ...(x.walk ? { walk: true } : {}),
      });
    }
    return days.filter((day) => day.date <= cfg.raceDate || day.kind === 'rest');
  }
}

function fmt(km) {
  return String(km).replace('.', ',');
}

// ---- koppeling runs ↔ schema ----------------------------------------------
export function runsByDate(runs) {
  const map = new Map();
  for (const r of runs) {
    const d = r.start_date_local.slice(0, 10);
    const prev = map.get(d);
    if (!prev || r.distance > prev.distance) map.set(d, r);
  }
  return map;
}

export function allDays(plan) {
  return plan ? plan.weeks.flatMap((w) => w.days) : [];
}

export function dayFor(plan, date) {
  return allDays(plan).find((d) => d.date === date) || null;
}

export function status(day, run, todayStr = today()) {
  if (!isRunDay(day)) return run ? 'extra' : 'rest';
  if (run) return 'done';
  if (day.date < todayStr) return 'missed';
  if (day.date === todayStr) return 'today';
  return 'planned';
}

export function weekTotals(week, byDate) {
  let planned = 0;
  let done = 0;
  for (const d of week.days) {
    if (isRunDay(d)) planned += d.km;
    const r = byDate.get(d.date);
    if (r) done += r.distance / 1000;
  }
  return { planned, done };
}

// Naam op Strava: trainingstype, en bij kwaliteit/lange duurloop ook de structuur.
// Bv. "Herstelloop" of "Marathonpace-blok — 2 km IL + 4 km @ 4:16 + 2 km UL".
export const stravaName = (day) => (
  (day.walk || ['interval', 'tempo', 'mp', 'long'].includes(day.kind)) && day.detail
    ? `${day.title} — ${day.detail}` : day.title);
