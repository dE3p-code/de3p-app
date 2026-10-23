// Zelfde gegevensvorm als het programma op de computer (app.py, sports.py, localplan.py),
// zodat app.js op de gsm ongewijzigd dezelfde schermen kan tonen.

// ---- sporten (sports.py) ------------------------------------------------------------
const GROUPS = {
  run: ['Lopen', ['Run', 'TrailRun', 'VirtualRun']],
  ride: ['Fietsen', ['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'EMountainBikeRide', 'Velomobile', 'Handcycle']],
  swim: ['Zwemmen', ['Swim']],
  walk: ['Wandelen', ['Walk', 'Hike']],
  racket: ['Racketsport', ['Tennis', 'Padel', 'Squash', 'Badminton', 'Pickleball', 'TableTennis', 'Racquetball']],
};
const NAMES = {
  Run: 'Lopen', TrailRun: 'Traillopen', VirtualRun: 'Lopen (binnen)', Ride: 'Fietsen', VirtualRide: 'Fietsen (binnen)', GravelRide: 'Gravel',
  MountainBikeRide: 'Mountainbike', EBikeRide: 'E-bike', EMountainBikeRide: 'E-mountainbike', Velomobile: 'Velomobiel', Handcycle: 'Handbike',
  Swim: 'Zwemmen', Walk: 'Wandelen', Hike: 'Hiken', WeightTraining: 'Krachttraining', Crossfit: 'CrossFit', Workout: 'Workout',
  HighIntensityIntervalTraining: 'HIIT', Pilates: 'Pilates', Yoga: 'Yoga', StairStepper: 'Traploper', Elliptical: 'Crosstrainer',
  Tennis: 'Tennis', Padel: 'Padel', Squash: 'Squash', Badminton: 'Badminton', Pickleball: 'Pickleball', TableTennis: 'Tafeltennis',
  Racquetball: 'Racquetball', Rowing: 'Roeien', VirtualRow: 'Roeien (binnen)', Kayaking: 'Kajakken', Canoeing: 'Kanoën',
  StandUpPaddling: 'Suppen', Surfing: 'Surfen', Kitesurf: 'Kitesurfen', Windsurf: 'Windsurfen', AlpineSki: 'Skiën',
  BackcountrySki: 'Toerskiën', NordicSki: 'Langlaufen', Snowboard: 'Snowboarden', IceSkate: 'Schaatsen', InlineSkate: 'Skeeleren',
  RollerSki: 'Rolskiën', RockClimbing: 'Klimmen', Golf: 'Golf', Soccer: 'Voetbal', Basketball: 'Basketbal', Volleyball: 'Volleybal',
  Cricket: 'Cricket', Dance: 'Dansen', Boxing: 'Boksen', MartialArts: 'Vechtsport', Wheelchair: 'Rolstoel', Skateboard: 'Skateboarden', Sail: 'Zeilen',
};
const TYPE_GROUP = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, [, types]]) => types.map((t) => [t, g])));
const sportType = (a) => a.sport_type || a.type || '';
export const group = (a) => TYPE_GROUP[sportType(a)] || 'other';
export const sportName = (a) => NAMES[sportType(a)] || GROUPS[group(a)]?.[0] || sportType(a) || 'Training';

// ---- titels (dashboard.split_training + app.clean_name) -------------------------------
function splitTraining(t) {
  const s = String(t || '').replace(/^[\s✅🛑🚲🏁]+/u, '').trim();
  const m = s.split(/\s[—–]\s/);
  return [m[0].trim(), m.length > 1 ? m.slice(1).join(' — ').trim() : ''];
}
export function cleanName(name) {
  let [title, struct] = splitTraining(name);
  title = title.replace(/^[—–\s]+/, '').trim();
  if (/\d+[,.]\d+ km/.test(title)) title = title.split(/\s\d/)[0];
  title = title.replace(/[\s·|•,—–-]+$/, '');
  if (/PR'?s|bpm|onderbreking/.test(struct)) struct = '';
  return [title || 'Run', struct];
}

// ---- één activiteit voor de interface (app.run_json) -----------------------------------
export function runJson(a) {
  const grp = group(a);
  const km = (a.distance || 0) / 1000;
  const t = a.moving_time || 0;
  const [title, structure] = grp === 'run' ? cleanName(a.name) : [a.name || sportName(a), ''];
  return {
    id: a.id, date: a.start_date_local.slice(0, 10), start: a.start_date_local.slice(0, 19),
    name: a.name || '', sport: grp, sportName: sportName(a), title, structure, km: Math.round(km * 100) / 100,
    time: t, pace: km ? t / km : null, speed: km && t ? km / (t / 3600) : null,
    pace100: grp === 'swim' && km ? t / (km * 10) : null,
    hr: a.average_heartrate ?? null, maxhr: a.max_heartrate ?? null, elev: a.total_elevation_gain ?? null,
    cadence: grp === 'run' ? ((a.average_cadence || 0) * 2 || null) : null,
    watts: a.average_watts ?? null, kj: a.kilojoules ?? null,
  };
}

// ---- eigen schema (localplan.py) --------------------------------------------------------
const RUN_KINDS = new Set(['recovery', 'easy', 'strides', 'long', 'tempo', 'interval', 'mp', 'race']);
const DIST_LABEL = { marathon: 'Marathon', half: 'Halve marathon', '10k': '10 km', '5k': '5 km' };
const MON = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const PHASE_FOCUS = {
  Basis: 'Rustig volume opbouwen: vooral gesprekstempo, met versnellingen voor een soepele pas.',
  Opbouw: 'Kilometers geleidelijk omhoog (max. +10% per week) met één of twee kwaliteitstrainingen.',
  Herstelweek: 'Minder kilometers, zodat je lichaam de opbouw kan verwerken.',
  Piek: 'De zwaarste weken: lange duurloop met wedstrijdtempo op het einde.',
  Taper: 'Minder volume, tempo behouden: frisse benen voor de wedstrijd.',
  Wedstrijdweek: 'Rustig aan, benen wakker houden en goed slapen.',
};
const pad = (n) => String(n).padStart(2, '0');
const fmtPace = (sec) => { let m = Math.floor(Math.round(sec) / 60); let s = Math.round(sec) - m * 60; if (s === 60) { m += 1; s = 0; } return `${m}:${pad(s)}`; };
const fmtTime = (sec) => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };
const paceText = (p) => (!p ? '' : Math.round(p[0]) === Math.round(p[1]) ? `${fmtPace(p[0])}/km` : `${fmtPace(p[0])}–${fmtPace(p[1])}/km`);
const kmText = (km) => (km ? `${+km} km`.replace('.', ',') : '—');
const short = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}`; };
const mondayOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d); x.setDate(d - ((x.getDay() + 6) % 7)); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };

export function race(plan) {
  const c = plan?.config || {};
  if (!c.raceDate) return null;
  return { name: c.raceName || DIST_LABEL[c.distance] || 'Wedstrijd', date: c.raceDate, goal: c.goalSec && !c.goalAuto ? fmtTime(c.goalSec) : '' };
}

export function uiWeeks(plan, today) {
  if (!plan?.weeks) return [];
  const monday = mondayOf(today);
  const out = [];
  for (const w of plan.weeks) {
    if (w.monday < monday) continue;
    const rows = w.days.map((d) => {
      const run = RUN_KINDS.has(d.kind);
      return {
        date: d.date, title: d.title, kind: d.kind, structure: run ? (d.detail || '') : '',
        km: run ? kmText(d.km || 0) : '—', pace: paceText(d.pace) || '—', details: run ? '' : (d.detail || ''),
        done: false, rest: !run,
      };
    });
    out.push({
      num: w.index || out.length + 1, total: plan.weeks.length, label: w.phase,
      marker: w.days.length ? `${short(w.days[0].date)} – ${short(w.days[w.days.length - 1].date)}` : '',
      focus: PHASE_FOCUS[w.phase] || '', target: w.km, rows,
    });
  }
  return out;
}

// Geplande dag voor een datum: titel + structuur + doeltempo (voor de naam op de kaart)
export function dayFor(plan, iso) {
  for (const w of plan?.weeks || []) for (const d of w.days || []) if (d.date === iso) return d;
  return null;
}
export { fmtPace, fmtTime, paceText };
