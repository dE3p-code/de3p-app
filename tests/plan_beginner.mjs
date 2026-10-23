// Beginnersschema's (lopen en wandelen): nooit twee dagen na elkaar, één wedstrijd, geen lege lopen.
import { generatePlan, EASY_GOAL, RUN_KINDS } from '../app/js/plan.js';

let n = 0; const bad = [];
for (const level of ['walk', 'run15']) for (const distance of ['5k', '10k', 'half', 'marathon'])
  for (const wk of [1, 2, 3, 5, 8, 9, 12, 16, 20]) for (const runDays of [3, 4, 5, 6])
    for (const [restDay, longDay, crossDay] of [[4, 5, null], [0, 6, null], [4, 6, 2], [2, 5, 0]]) for (const off of [6, 5, 2]) {
      const race = new Date(Date.parse('2026-10-26') + (wk * 7 - 7 + off) * 864e5).toISOString().slice(0, 10);
      n += 1;
      let p;
      try { p = generatePlan({ distance, level, goalSec: EASY_GOAL[distance], goalAuto: true, baseKm: 0, runDays, restDay, longDay, crossDay, startDate: '2026-10-23', raceDate: race }); } catch (e) { bad.push(`CRASH ${e.message}`); continue; }
      const days = p.weeks.flatMap((w) => w.days);
      const tag = `${level} ${distance} ${wk}w ${runDays}d`;
      if (days.filter((d) => d.kind === 'race').length !== 1) bad.push(`${tag}: wedstrijd`);
      for (let i = 1; i < days.length; i += 1) if (days[i].walk && days[i - 1].walk) bad.push(`${tag}: twee dagen na elkaar ${days[i].date}`);
      if (days.some((d) => RUN_KINDS.has(d.kind) && !(d.km > 0))) bad.push(`${tag}: loop van 0 km`);
    }
console.log(`${n} beginnersschema's, ${bad.length} problemen`);
console.log([...new Set(bad)].slice(0, 10).join('\n'));
