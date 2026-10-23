// Op de gsm zonder computer, zoals blocks.py en strava_sync.py op de computer:
//  - het kernblok: wat je in het belangrijkste deel van een training echt liep, naast het doel
//    ("2 km IL + 5 km @ ±4:20 + 2 km UL" → 5 km @ 4:28/km, km 3–7, 8 s/km trager dan doel);
//  - de naam en beschrijving op Strava: een loop met een standaardnaam ("Ochtendloop") die op een geplande
//    dag valt, krijgt de naam uit je schema; liep je de kerntraining niet, dan "Rustige duurloop".

const PACE = '±?\\s*(\\d{1,2}:\\d{2})';
const NUM = '(\\d+(?:[.,]\\d+)?)';
const SEP = '\\s*(?:@|\\bop\\b|\\baan\\b)[^\\d±+,;()]{0,30}?';
const RE_REPS = new RegExp(`(\\d+)\\s*[×x]\\s*${NUM}\\s*(km|m)\\b[^@+]*?${SEP}${PACE}`, 'i');
const RE_FINISH = new RegExp(`laatste\\s+${NUM}\\s*km${SEP}${PACE}`, 'i');
const RE_BLOCK = new RegExp(`${NUM}\\s*km${SEP}${PACE}`, 'i');
const SKIP_SLOWER = 15;   // s/km trager dan het doel ...
const SKIP_EFFORT = 15;   // ... en niet zoveel sneller dan de rest van je loop = kerntraining niet gelopen

const sec = (mmss) => { const [m, s] = mmss.split(':').map(Number); return m * 60 + s; };
const num = (v) => Number(String(v).replace(',', '.'));
const pad = (n) => String(n).padStart(2, '0');
export const fmtPace = (s) => { let m = Math.floor(Math.round(s) / 60); let x = Math.round(s) - m * 60; if (x === 60) { m += 1; x = 0; } return `${m}:${pad(x)}`; };
const fmtTime = (s) => { s = Math.round(s); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
const paceOf = (x) => x.moving_time / (x.distance / 1000);

export const has = (structure) => RE_REPS.test(structure || '') || RE_FINISH.test(structure || '') || RE_BLOCK.test(structure || '');

function result(kind, label, parts, target, where) {
  const secs = parts.reduce((a, p) => a + (p.moving_time || 0), 0);
  const dist = parts.reduce((a, p) => a + (p.distance || 0), 0);
  const hrT = parts.filter((p) => p.average_heartrate).map((p) => [p.average_heartrate, p.moving_time || 0]);
  const tot = hrT.reduce((a, [, t]) => a + t, 0);
  const hr = tot ? hrT.reduce((a, [h, t]) => a + h * t, 0) / tot : null;
  const pace = dist ? secs / (dist / 1000) : 0;
  return { kind, label, where, km: Math.round(dist / 10) / 100, secs, pace: Math.round(pace * 10) / 10, hr: hr ? Math.round(hr) : null,
    target, delta: Math.round((pace - target) * 10) / 10, splits: parts.map((p) => p.split).filter(Boolean) };
}
// het blok begint waar je echt versnelt (halfweg tussen je rustige tempo en het doel), zie blocks._real_start
function realStart(splits, best, n, target) {
  const outside = splits.filter((_, i) => !(best <= i && i < best + n)).map(paceOf).sort((a, b) => a - b);
  if (!outside.length) return best;
  const thr = (outside[Math.floor(outside.length / 2)] + target) / 2;
  const starts = [];
  for (let s = Math.max(1, best - 2); s <= Math.min(splits.length - n, best + 2); s += 1) {
    if (paceOf(splits[s]) <= thr && thr < paceOf(splits[s - 1])) starts.push(s);
  }
  return starts.length ? starts.reduce((a, b) => (Math.abs(b - best) < Math.abs(a - best) ? b : a)) : best;
}

export function analyze(structure, detail) {
  const s = structure || '';
  const splits = (detail?.splits_metric || []).filter((x) => (x.distance || 0) >= 900 && x.moving_time);
  let m = RE_REPS.exec(s);
  if (m) {
    const reps = Number(m[1]); const repM = num(m[2]) * (m[3].toLowerCase() === 'km' ? 1000 : 1);
    const laps = (detail?.laps || []).filter((x) => x.moving_time && Math.abs((x.distance || 0) - repM) <= repM * 0.2);
    if (laps.length < reps) return null;
    const fastest = [...laps].sort((a, b) => a.moving_time / a.distance - b.moving_time / b.distance).slice(0, reps)
      .sort((a, b) => (a.lap_index || 0) - (b.lap_index || 0));
    return result('reps', `${reps}×${m[2]} ${m[3]}`, fastest, sec(m[4]), `${reps} snelste ronden`);
  }
  m = RE_FINISH.exec(s);
  if (m) {
    const n = Math.max(1, Math.trunc(num(m[1])));
    if (splits.length < n) return null;
    const part = splits.slice(-n);
    return result('finish', `laatste ${n} km`, part, sec(m[2]), `km ${part[0].split}–${part[part.length - 1].split}`);
  }
  m = RE_BLOCK.exec(s);
  if (m) {
    const n = Math.max(1, Math.trunc(num(m[1])));
    if (splits.length < n) return null;
    let best = 0; let bestPace = Infinity;
    for (let i = 0; i + n <= splits.length; i += 1) {
      const w = splits.slice(i, i + n);
      const p = w.reduce((a, x) => a + x.moving_time, 0) / w.reduce((a, x) => a + x.distance, 0);
      if (p < bestPace) { bestPace = p; best = i; }
    }
    best = realStart(splits, best, n, sec(m[2]));
    const part = splits.slice(best, best + n);
    return result('blok', `${n} km`, part, sec(m[2]), n > 1 ? `km ${part[0].split}–${part[part.length - 1].split}` : `km ${part[0].split}`);
  }
  return null;
}

const verdict = (b) => (Math.abs(b.delta) <= 3 ? 'op doel' : `${Math.abs(Math.round(b.delta))} s/km ${b.delta > 0 ? 'trager' : 'sneller'}`);
// zelfde vorm als app.block_view
export function view(b) {
  if (!b) return { found: false };
  return { ...b, found: true, paceTxt: fmtPace(b.pace), targetTxt: fmtPace(b.target), timeTxt: fmtTime(b.secs), verdict: verdict(b), short: `${b.label} @ ${fmtPace(b.pace)}` };
}
const descriptionLine = (b) => `Kernblok: ${b.label} @ ${fmtPace(b.pace)}/km in ${fmtTime(b.secs)}${b.hr ? ` · ${b.hr} bpm` : ''} (${b.where}) · doel ${fmtPace(b.target)}, ${verdict(b)}`;

// ---- naam op Strava ----------------------------------------------------------------------------------
const DEFAULT_NAME = new RegExp('^(ochtend|namiddag|middag|avond|nacht|lunch|morning|afternoon|evening|night|lunch)'
  + '\\s*(loop|rit|run|ride|walk|wandeling|hardloopsessie|fietsrit|workout|activiteit|training)?$', 'i');
export const isDefaultName = (name) => !String(name || '').trim() || DEFAULT_NAME.test(String(name).trim());

// liep je de geplande kerntraining niet (rustig gelopen)? zie strava_sync.skipped_plan
function skipped(b, detail) {
  if (!b || b.delta == null || b.delta <= SKIP_SLOWER) return false;
  const restKm = detail.distance / 1000 - (b.km || 0);
  if (restKm >= 0.5 && (detail.moving_time - b.secs) / restKm - b.pace >= SKIP_EFFORT) return false;
  return true;
}
// { name, description } voor een loop met een standaardnaam op een dag met een geplande training, anders null
export function autoName(detail, planned) {
  if (!detail || !planned || planned.rest || !isDefaultName(detail.name)) return null;
  const full = `${planned.title}${planned.structure ? ` — ${planned.structure}` : ''}`;
  const b = has(planned.structure) ? analyze(planned.structure, detail) : null;
  if (skipped(b, detail)) return { name: 'Rustige duurloop', description: `Rustig gelopen i.p.v. gepland: ${full}`, block: null };
  const lines = [`Gepland: ${full}`, b ? descriptionLine(b) : ''].filter(Boolean);
  return { name: full.slice(0, 250), description: (detail.description || '').trim() ? null : `${lines.join('\n')}\n— dE3p`, block: b };
}
