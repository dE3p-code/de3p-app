// Lichaamsleeftijd (zoals WHOOP Age): je echte leeftijd, bijgestuurd met wat onderzoek koppelt aan gezond
// ouder worden. Haal je de richtlijnen (7-9 u slaap, ±8.000 stappen, 150-300 actieve minuten per week, een
// gewone rustpols en VO2max voor je leeftijd), dan is je lichaamsleeftijd je echte leeftijd; beter is jonger.
// Een schatting, geen medisch advies.
//
// VO2max-normen: Loe e.a. 2013 (3.816 gezonde Noren): 20-29 jaar 54,4 (man) en 43,0 (vrouw) ml/kg/min,
// daarna ±3,5 minder per 10 jaar. Rustpols, slaap, stappen en actieve minuten: gangbare richtlijnen (WHO,
// slaapaanbevelingen), met per factor een begrensde bijdrage in jaren.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const MIN_AGE = 18;
export const MAX_SHIFT = 10;                       // nooit meer dan 10 jaar jonger of ouder dan je echte leeftijd

export function vo2Norm(age, sex) {
  return (sex === 'f' ? 43.0 : 54.4) - 0.35 * Math.max(0, age - 25);
}

// age = echte leeftijd (jaren, met komma), sex = 'm' | 'f', days = dagen in garmin-vorm (oud → nieuw),
// body = { weightKg, heightCm } (mag ontbreken). Geeft null als er te weinig gegevens zijn.
export function bodyAge({ age, sex, days, body = {}, end = null, only = null }) {
  if (!age || !['m', 'f'].includes(sex)) return null;
  const all = (days || []).filter((d) => d && d.date && (!end || d.date <= end));
  const last = all.slice(-30);
  const pick = (f) => last.map(f).filter((v) => v != null && Number.isFinite(v));
  const factors = [];

  // 1. VO2max (laatste meting van de laatste 90 dagen): het zwaarst, want het sterkst gelinkt aan gezond ouder worden
  const vo2 = all.slice(-90).map((d) => d.status?.vo2max).filter((v) => v).pop();
  if (vo2) {
    const norm = vo2Norm(age, sex);
    factors.push({ k: 'vo2', label: 'VO2max', value: vo2, ref: r1(norm), years: clamp(((norm - vo2) / 0.35) * 0.5, -8, 8),
      tip: `Normaal voor ${sex === 'f' ? 'een vrouw' : 'een man'} van jouw leeftijd: ${String(r1(norm)).replace('.', ',')}. Hoger = jonger.` });
  }
  // 2. rustpols (gemiddelde van 30 dagen): 60 is gewoon; elke 10 slagen lager ±1,5 jaar jonger
  const rhr = mean(pick((d) => d.rhr));
  if (rhr != null && pick((d) => d.rhr).length >= 7) {
    factors.push({ k: 'rhr', label: 'Rustpols', value: Math.round(rhr), ref: 60, years: clamp(((rhr - 60) / 10) * 1.5, -3, 4),
      tip: 'Gemiddeld 60 is gewoon. Lager = een sterker hart.' });
  }
  // 3. slaap: 7 tot 9 uur is goed; minder telt het zwaarst
  const sl = mean(pick((d) => (d.sleep?.secs ? d.sleep.secs / 3600 : null)));
  if (sl != null && pick((d) => d.sleep?.secs).length >= 7) {
    const y = sl < 7 ? clamp((7 - sl) * 1.5, 0, 3) : sl > 9 ? clamp(sl - 9, 0, 2) : 0;
    factors.push({ k: 'sleep', label: 'Slaap', value: r1(sl), ref: '7-9', years: y, tip: '7 tot 9 uur per nacht is de richtlijn.' });
  }
  // 4. stappen: ±8.000 per dag is de maatstaf; meer helpt tot ±12.000
  const st = mean(pick((d) => d.steps?.n));
  if (st != null && pick((d) => d.steps?.n).length >= 7) {
    const y = st < 8000 ? clamp((8000 - st) / 2000, 0, 3) : -clamp((st - 8000) / 4000, 0, 1);
    factors.push({ k: 'steps', label: 'Stappen', value: Math.round(st), ref: 8000, years: y, tip: 'Rond 8.000 per dag is de maatstaf.' });
  }
  // 5. actieve minuten per week (matig + 2× zwaar, zoals Garmin): de WHO raadt 150 tot 300 aan
  const im = pick((d) => d.intensity);
  if (im.length >= 14) {
    const wk = mean(im) * 7;
    const y = wk < 150 ? clamp(((150 - wk) / 150) * 2, 0, 2) : -clamp((wk - 150) / 100, 0, 1.5);
    factors.push({ k: 'im', label: 'Actieve minuten', value: Math.round(wk), ref: 150, years: y, tip: 'Per week. De WHO raadt 150 tot 300 aan.' });
  }
  // 6. BMI (gewicht uit je weegschaal of profiel): 18,5 tot 25 is gezond
  const kg = all.map((d) => d.weight?.kg).filter((v) => v).pop() || body.weightKg;
  if (kg && body.heightCm) {
    const bmi = kg / (body.heightCm / 100) ** 2;
    const y = bmi > 25 ? clamp((bmi - 25) * 0.5, 0, 3) : bmi < 18.5 ? 1 : 0;
    factors.push({ k: 'bmi', label: 'BMI', value: r1(bmi), ref: '18,5-25', years: y, tip: 'Gewicht ten opzichte van je lengte. 18,5 tot 25 is gezond.' });
  }

  if (only) factors.splice(0, factors.length, ...factors.filter((f) => only.has(f.k)));   // trend: enkel wat elke periode heeft
  // genoeg om iets te zeggen: VO2max, of minstens drie van de andere
  if (!factors.some((f) => f.k === 'vo2') && factors.length < 3) return null;
  factors.forEach((f) => { f.years = r1(f.years); });
  const raw = factors.reduce((a, f) => a + f.years, 0);         // som van alle factoren, zonder grenzen
  const shift = clamp(raw, -MAX_SHIFT, MAX_SHIFT);
  const bodyAgeVal = r1(Math.max(MIN_AGE, age + shift));
  return { age: r1(age), body: bodyAgeVal, diff: r1(bodyAgeVal - age), raw: r1(raw), factors: factors.sort((a, b) => a.years - b.years),
    floor: age + shift < MIN_AGE, capped: Math.abs(raw) > MAX_SHIFT };
}

// hoe je lichaamsleeftijd bewoog: nu en 1, 3 en 6 maanden geleden (met je leeftijd van toen)
export function bodyAgeTrend({ age, sex, days, body }) {
  const ds = (days || []).filter((d) => d && d.date);
  if (!ds.length) return [];
  const lastDate = ds[ds.length - 1].date;
  const back = (n) => { const [y, m, d] = lastDate.split('-').map(Number); const x = new Date(y, m - 1, d - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  // eerst kijken welke factoren elke periode heeft, en enkel die vergelijken (anders springt de lijn door ontbrekende gegevens)
  const pts = [180, 90, 30, 0].map((n) => {
    const end = back(n);
    const enough = ds.filter((d) => d.date <= end && d.date > back(n + 30)).length >= 21;
    const res = enough ? bodyAge({ age: age - n / 365.25, sex, days: ds, body, end }) : null;
    return res ? { n, end, keys: new Set(res.factors.map((f) => f.k)) } : null;
  }).filter(Boolean);
  if (pts.length < 2) return [];
  const only = new Set([...pts[0].keys].filter((k) => pts.every((x) => x.keys.has(k))));
  if (!only.size) return [];
  return pts.map(({ n, end }) => {
    const res = bodyAge({ age: age - n / 365.25, sex, days: ds, body, end, only });
    return res ? { daysAgo: n, end, body: res.body, diff: res.diff, raw: res.raw, limited: res.floor || res.capped, keys: [...only] } : null;
  }).filter(Boolean);
}
