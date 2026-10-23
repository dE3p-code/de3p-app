// Kleine helpers: Nederlandse opmaak, datums (altijd lokale 'JJJJ-MM-DD'-strings), escapen.

export const DAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
export const DAYS_SHORT = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
export const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

const pad = (n) => String(n).padStart(2, '0');

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- tempo / tijd / afstand ------------------------------------------------
export function fmtPace(sec) {
  if (!sec || !isFinite(sec)) return '–';
  let m = Math.floor(sec / 60);
  let s = Math.round(sec - m * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${pad(s)}`;
}

export function fmtPaceRange(p) {
  if (!p) return '';
  const [lo, hi] = p;
  return lo === hi ? `${fmtPace(lo)}/km` : `${fmtPace(lo)}–${fmtPace(hi)}/km`;
}

export function fmtTime(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtKm(km, d = 1) {
  return (Number(km) || 0).toFixed(d).replace('.', ',');
}

export function parsePace(str) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(str || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function parseTime(str) {
  const parts = String(str || '').trim().split(/[:.]/).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// ---- datums ----------------------------------------------------------------
export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const today = () => ymd(new Date());

export function addDays(s, n) {
  const d = fromYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export const weekday = (s) => (fromYmd(s).getDay() + 6) % 7;   // ma = 0
export const mondayOf = (s) => addDays(s, -weekday(s));
export const daysBetween = (a, b) => Math.round((fromYmd(b) - fromYmd(a)) / 86400000);

export function nlDate(s) {
  const d = fromYmd(s);
  return `${DAYS[weekday(s)]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function nlShort(s) {
  const d = fromYmd(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function ddmmyyyy(s) {
  const [y, m, d] = s.split('-');
  return `${d}-${m}-${y}`;
}

export function relDay(s) {
  const n = daysBetween(today(), s);
  if (n === 0) return 'vandaag';
  if (n === 1) return 'morgen';
  if (n === -1) return 'gisteren';
  return n > 0 ? `over ${n} dagen` : `${-n} dagen geleden`;
}

// Bestandsnaam die overal werkt (Windows, macOS, iOS): ':' → '.', verboden tekens weg.
export function safeFilename(stem) {
  return stem.replace(/ [—–] /g, ' ').replace(/:/g, '.')
    .replace(/[\\/*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
