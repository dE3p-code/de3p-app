// node tests/plan_matrix.mjs — controleert de schemamaker (app/js/plan.js) op veel situaties van nieuwe gebruikers.
import { generatePlan, RUN_KINDS } from '../app/js/plan.js';

const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7;   // ma=0
const START = '2026-10-23';
const goals = { '5k': [20 * 60, 25 * 60, 35 * 60], '10k': [42 * 60, 55 * 60, 70 * 60], half: [95 * 60, 120 * 60, 150 * 60], marathon: [3 * 3600, 3.75 * 3600, 4.75 * 3600] };
const issues = []; let n = 0;
const bad = (c, msg) => issues.push(`${c.distance} ${c.weeksOut}w base${c.baseKm} ${c.runDays}d rest${c.restDay} long${c.longDay}${c.crossDay != null ? ' cross' + c.crossDay : ''} goal${c.goalSec}: ${msg}`);

for (const distance of ['5k', '10k', 'half', 'marathon']) {
  for (const weeksOut of [1, 2, 3, 5, 8, 12, 16, 20]) {
    for (const baseKm of [10, 20, 35, 60]) {
      for (const runDays of [3, 4, 5, 6]) {
        for (const [restDay, longDay, crossDay] of [[4, 5, null], [0, 6, null], [4, 6, 2], [2, 5, 0]]) {
          for (const goalSec of goals[distance]) {
            for (const raceOff of [6, 5, 2]) {                      // wedstrijd op zondag / zaterdag / woensdag
              const raceDate = addDays(addDays(START, 7 * weeksOut - dow(START)), raceOff);
              const c = { distance, weeksOut, baseKm, runDays, restDay, longDay, crossDay, goalSec, raceDate, startDate: START, raceName: '' };
              n += 1;
              let p;
              try { p = generatePlan(c); } catch (e) { bad(c, 'CRASH ' + e.message); continue; }
              const days = p.weeks.flatMap((w) => w.days);
              const races = days.filter((d) => d.kind === 'race');
              if (races.length !== 1 || races[0].date !== raceDate) bad(c, `wedstrijd ${races.map((r) => r.date)} i.p.v. ${raceDate}`);
              if (days.some((d) => d.date < START)) bad(c, 'dagen vóór de start');
              if (days.some((d) => d.date > raceDate && d.kind !== 'rest')) bad(c, 'training na de wedstrijd');
              const dates = days.map((d) => d.date); if (new Set(dates).size !== dates.length) bad(c, 'dubbele datums');
              for (const w of p.weeks.slice(0, -1)) {                   // gewone weken
                const full = w.days.length === 7;
                const runs = w.days.filter((d) => RUN_KINDS.has(d.kind));
                if (full && !(runDays === 6 && crossDay != null) && runs.length !== runDays) bad(c, `week ${w.index}: ${runs.length} loopdagen i.p.v. ${runDays}`);
                const rd = w.days.find((d) => dow(d.date) === restDay);
                if (rd && rd.kind !== 'rest') bad(c, `week ${w.index}: rustdag is ${rd.kind}`);
                const ld = w.days.find((d) => dow(d.date) === longDay);
                if (ld && ld.kind !== 'long') bad(c, `week ${w.index}: lange-duurloopdag is ${ld.kind}`);
                const sum = runs.reduce((s, d) => s + d.km, 0);
                if (full && Math.abs(sum - w.km) > 0.01) bad(c, `week ${w.index}: som ${sum} km vs gepland ${w.km}`);
                for (const d of runs) {
                  if (!d.pace) bad(c, `${d.date} ${d.kind} zonder tempo`);
                  if (d.km <= 0) bad(c, `${d.date} ${d.kind} 0 km`);
                }
              }
              // groei: elke volle opbouwweek max ~10% boven de vorige volle week (herstelweken overgeslagen)
              const full = p.weeks.slice(0, -1).filter((w) => w.days.length === 7 && w.phase !== 'Taper');
              for (let i = 1; i < full.length; i += 1) {
                const a = full[i - 1].days.filter((d) => RUN_KINDS.has(d.kind)).reduce((s, d) => s + d.km, 0);
                const b = full[i].days.filter((d) => RUN_KINDS.has(d.kind)).reduce((s, d) => s + d.km, 0);
                if (full[i - 1].phase !== 'Herstelweek' && b > a * 1.12 + 1.5) bad(c, `week ${full[i].index}: +${Math.round((b / a - 1) * 100)}% (${a}→${b} km)`);
              }
              // tempo-logica
              const avg = (k) => { const x = days.filter((d) => d.kind === k && d.pace); return x.length ? x[0].pace[0] : null; };
              const [rec, easy, tempo, inter] = ['recovery', 'easy', 'tempo', 'interval'].map(avg);
              const rp = goalSec / { '5k': 5, '10k': 10, half: 21.0975, marathon: 42.195 }[distance];
              if (easy && easy <= rp) bad(c, 'rustig tempo sneller dan wedstrijdtempo');
              if (rec && easy && rec < easy) bad(c, 'herstel sneller dan rustig');
              if (inter && tempo && inter > tempo) bad(c, 'interval trager dan tempo');
            }
          }
        }
      }
    }
  }
}
const kinds = {};
for (const s of issues) { const k = s.split(': ').slice(1).join(': ').replace(/[\d,.]+/g, '#').slice(0, 60); kinds[k] = (kinds[k] || 0) + 1; }
console.log(`${n} schema's, ${issues.length} problemen`);
console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v}× ${k}`).join('\n'));
console.log('\nvoorbeelden:\n' + issues.slice(0, 12).join('\n'));
