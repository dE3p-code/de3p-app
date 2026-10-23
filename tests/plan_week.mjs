// Eigen week (per dag rust / lopen / lang / fiets): elke combinatie met 2–6 loopdagen en minstens 1 rustdag.
import { generatePlan, EASY_GOAL, RUN_KINDS, DAY_KINDS } from '../app/js/plan.js';

let n = 0; const bad = [];
const all = [];
for (let x = 0; x < 4 ** 7; x += 1) {
  const wk = [0, 1, 2, 3, 4, 5, 6].map((i) => DAY_KINDS[Math.floor(x / 4 ** i) % 4]);
  const runs = wk.filter((k) => k === 'run' || k === 'long').length;
  if (runs >= 2 && runs <= 6 && wk.includes('rest')) all.push(wk);
}
for (const [i, week] of all.entries()) {
  if (i % 7) continue;                                       // elke 7e: genoeg variatie, snel
  for (const level of ['km', 'walk']) for (const distance of ['5k', 'marathon']) {
    n += 1;
    const cfg = { distance, level, goalSec: EASY_GOAL[distance], baseKm: 30, week, startDate: '2026-10-23', raceDate: '2027-02-21' };
    let p;
    try { p = generatePlan(cfg); } catch (e) { bad.push(`CRASH ${week} ${e.message}`); continue; }
    const days = p.weeks.flatMap((w) => w.days);
    const tag = `${level} ${distance} ${week.join(',')}`;
    if (days.filter((d) => d.kind === 'race').length !== 1) bad.push(`${tag}: wedstrijd`);
    for (const w of p.weeks.slice(0, -1)) for (const d of w.days) {
      const dow = (new Date(`${d.date}T12:00:00Z`).getUTCDay() + 6) % 7;
      if (week[dow] === 'rest' && d.kind !== 'rest') bad.push(`${tag}: ${d.date} is rustdag maar ${d.kind}`);
      if (week[dow] === 'cross' && RUN_KINDS.has(d.kind)) bad.push(`${tag}: ${d.date} is fietsdag maar ${d.kind}`);
      if (RUN_KINDS.has(d.kind) && !(d.km > 0)) bad.push(`${tag}: ${d.date} 0 km`);
    }
  }
}
console.log(`${n} schema's met een eigen week, ${bad.length} problemen`);
console.log([...new Set(bad)].slice(0, 10).join('\n'));
