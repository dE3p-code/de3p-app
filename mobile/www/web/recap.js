// Overgenomen uit dE3p Run (gsm). Kaarten maken op de gsm zelf, als Strava daar gekoppeld is.
// Recap-kaart (1080×1920, zwart-wit) — zelfde ontwerp als de goedgekeurde
// matplotlib-versie, nu in de browser getekend zodat je hem overal kan downloaden
// of rechtstreeks delen (iPhone → Foto's/TikTok).

import { fmtPace, fmtPaceRange, fmtTime, nlDate, ddmmyyyy, safeFilename } from '../js/util.js';

const W = 1080;
const H = 1920;
const C = {
  bg: '#0A0A0A', panel: '#141414', border: '#2A2A2A', fg: '#FAFAFA',
  muted: '#8C8C8C', soft: '#CFCFCF', slow: '#484848', grid: '#1E1E1E',
};
const FONT = "'Archivo', 'Helvetica Neue', Arial, sans-serif";
const px = (pt) => Math.round(pt * (100 / 72));          // matplotlib-punten → pixels bij 100 dpi

// Welke titel/subtitel/doeltempo komt op de kaart?
export function recapText(activity, day) {
  const title = day?.title || String(activity.name || 'Duurloop').split(' — ')[0];
  const structured = day && (['interval', 'tempo', 'mp', 'strides'].includes(day.kind)
    || (day.kind === 'long' && /laatste/.test(day.detail)));
  return {
    title,
    subtitle: structured ? day.detail : '',
    target: day?.pace ? fmtPaceRange(day.pace) : '',
  };
}

export function recapFilename(activity, day) {
  const { title, subtitle } = recapText(activity, day);
  const date = activity.start_date_local.slice(0, 10);
  return `${safeFilename(`${ddmmyyyy(date)} ${title}${subtitle ? ` ${subtitle}` : ''}`)}.png`;
}

let logoCache = { src: null, img: null };
function loadImage(src) {
  if (logoCache.src === src && logoCache.img) return Promise.resolve(logoCache.img);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { logoCache = { src, img }; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export async function renderRecap(canvas, { activity, detail, streams, day, logo, text: words }) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  await Promise.all([
    document.fonts.load(`700 50px ${FONT}`),
    document.fonts.load(`400 28px ${FONT}`),
  ]).catch(() => {});

  const a = detail || activity;
  const distKm = (a.distance || 0) / 1000;
  const mtime = a.moving_time || 0;
  const avgPace = distKm ? mtime / distKm : 0;
  const avgHr = a.average_heartrate;
  const { title, subtitle, target } = words || recapText(activity, day);

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- titel + subtitel + doeltempo -------------------------------------
  text(ctx, title, W / 2, 109, { size: px(36), weight: 700, color: C.fg, align: 'center', maxWidth: 960 });
  if (subtitle) text(ctx, subtitle, W / 2, 177, { size: px(23), color: C.muted, align: 'center', maxWidth: 960 });
  if (target) {
    text(ctx, `Doeltempo · ${target}`, W / 2, subtitle ? 234 : 182,
      { size: px(22), color: C.soft, align: 'center', maxWidth: 960 });
  }

  // ---- hero: afstand ------------------------------------------------------
  panel(ctx, 76, 296, 929, 165);
  text(ctx, `${distKm.toFixed(2).replace('.', ',')} km`, W / 2, 378,
    { size: px(66), weight: 700, color: C.fg, align: 'center' });

  // ---- 6 tegels -----------------------------------------------------------
  const tiles = [
    [fmtTime(mtime), 'looptijd'],
    [avgHr ? String(Math.round(avgHr)) : '–', 'gem. HR (bpm)'],
    [a.max_heartrate ? String(Math.round(a.max_heartrate)) : '–', 'max HR (bpm)'],
    [a.average_cadence ? String(Math.round(a.average_cadence * 2)) : '–', 'cadans (spm)'],
    [String(Math.round(a.total_elevation_gain || 0)), 'hoogtemeters'],
    [fmtPace(avgPace), 'gem. tempo (/km)'],
  ];
  const tw = 298;
  const th = 150;
  tiles.forEach(([val, lab], i) => {
    const x = [76, 391, 706][i % 3];
    const y = i < 3 ? 513 : 693;
    panel(ctx, x, y, tw, th);
    text(ctx, val, x + tw / 2, y + th * 0.4, { size: px(42), weight: 700, color: C.fg, align: 'center' });
    text(ctx, lab, x + tw / 2, y + th * 0.76, { size: px(20), color: C.muted, align: 'center' });
  });

  // ---- grafiek 1: tempo per km (van onder naar boven) --------------------
  const splits = (a.splits_metric || []).filter((s) => s.average_speed > 0);
  paceChart(ctx, splits, avgPace, { x: 97, y: 912, w: 907, h: 307 });

  // ---- grafiek 2: hartslag (volledige stream) ----------------------------
  hrChart(ctx, streams, splits, avgHr, { x: 97, y: 1373, w: 907, h: 307 });

  // ---- datum + logo --------------------------------------------------------
  const date = activity.start_date_local.slice(0, 10);
  text(ctx, nlDate(date), W / 2, 1755, { size: px(20), color: C.muted, align: 'center' });
  const img = await loadImage(logo || 'logo.png');
  if (img) {
    const lw = 150;
    const lh = (lw * img.height) / img.width;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img, (W - lw) / 2, H - 42 - lh, lw, lh);
    ctx.globalAlpha = 1;
  }
}

// ---- tekenhulpjes -----------------------------------------------------------
function text(ctx, str, x, y, { size, weight = 400, color, align = 'left', maxWidth } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  let s = String(str);
  if (maxWidth) {
    while (s.length > 4 && ctx.measureText(s).width > maxWidth) s = `${s.slice(0, -2)}…`;
  }
  ctx.fillText(s, x, y);
}

function panel(ctx, x, y, w, h, r = 20) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.border;
  ctx.stroke();
}

function dashed(ctx, x1, y1, x2, y2, color, width) {
  ctx.save();
  ctx.setLineDash([9, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function chartTitle(ctx, str, box) {
  text(ctx, str, box.x, box.y - 24, { size: px(20), weight: 700, color: C.fg });
}

function paceChart(ctx, splits, avgPace, box) {
  chartTitle(ctx, 'Tempo per km  (min/km · hoger = sneller)', box);
  if (!splits.length) {
    text(ctx, 'Geen splits beschikbaar', box.x + box.w / 2, box.y + box.h / 2, { size: 24, color: C.muted, align: 'center' });
    return;
  }
  const speeds = splits.map((s) => s.average_speed * 3.6);
  const avgKmh = avgPace ? 3600 / avgPace : 0;
  const smin = Math.min(...speeds);
  const smax = Math.max(...speeds);
  const rng = smax - smin || 1;
  const base = smin - rng * 0.9;
  const top = smax + rng * 0.34;
  const yOf = (v) => box.y + box.h - ((v - base) / (top - base)) * box.h;
  const slot = box.w / speeds.length;
  const bw = slot * 0.78;

  if (avgKmh) dashed(ctx, box.x, yOf(avgKmh), box.x + box.w, yOf(avgKmh), C.muted, 2);
  // Labels mogen elkaar niet raken: kleiner bij veel km, bij heel lange lopen om de andere balk.
  const n = speeds.length;
  let fs = Math.min(13, 210 / n);
  let step = 1;
  if (fs < 10.5) { fs = Math.min(13, 420 / n); step = 2; }
  const tickFs = Math.min(13, 300 / n);
  speeds.forEach((sp, i) => {
    const cx = box.x + slot * (i + 0.5);
    const y = yOf(sp);
    ctx.fillStyle = sp >= avgKmh ? C.fg : C.slow;
    ctx.fillRect(cx - bw / 2, y, bw, box.y + box.h - y);
    if (i % step === 0) text(ctx, fmtPace(3600 / sp), cx, y - 14, { size: px(fs), weight: 700, color: C.fg, align: 'center' });
    text(ctx, String(i + 1), cx, box.y + box.h + 18, { size: px(tickFs), color: C.muted, align: 'center' });
  });
}

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function hrChart(ctx, streams, splits, avgHr, box) {
  chartTitle(ctx, 'Hartslag  (bpm · volledige registratie)', box);
  let xs = [];
  let ys = [];
  let points = false;
  const hr = streams?.heartrate?.data;
  const dist = streams?.distance?.data;
  if (hr?.length && dist?.length === hr.length) {
    xs = dist.map((d) => d / 1000);
    ys = hr.map(Number);
  } else {
    splits.forEach((s, i) => { if (s.average_heartrate) { xs.push(i + 1); ys.push(s.average_heartrate); } });
    points = true;
  }
  if (!ys.length) {
    text(ctx, 'Geen hartslag gemeten', box.x + box.w / 2, box.y + box.h / 2, { size: 24, color: C.muted, align: 'center' });
    return;
  }
  const lo0 = Math.min(...ys) - 4;
  const hi0 = Math.max(...ys);
  const pad = (hi0 - lo0) * 0.05;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const xmin = points ? Math.min(...xs) - 0.5 : 0;
  const xmax = points ? Math.max(...xs) + 0.5 : Math.max(...xs);
  const X = (v) => box.x + ((v - xmin) / (xmax - xmin || 1)) * box.w;
  const Y = (v) => box.y + box.h - ((v - lo) / (hi - lo || 1)) * box.h;

  // raster + y-labels
  const ys0 = niceStep(hi - lo);
  for (let v = Math.ceil(lo / ys0) * ys0; v <= hi; v += ys0) {
    ctx.fillStyle = C.grid;
    ctx.fillRect(box.x, Math.round(Y(v)), box.w, 1.2);
    text(ctx, String(Math.round(v)), box.x - 10, Y(v), { size: px(13), color: C.muted, align: 'right' });
  }
  // x-labels (km)
  const xs0 = points ? 1 : niceStep(xmax - xmin, 6);
  for (let v = Math.ceil(xmin / xs0) * xs0; v <= xmax + 1e-9; v += xs0) {
    text(ctx, String(Math.round(v * 10) / 10), X(v), box.y + box.h + 22, { size: px(13), color: C.muted, align: 'center' });
  }

  // vlak + lijn
  ctx.beginPath();
  ctx.moveTo(X(xs[0]), Y(lo0));
  xs.forEach((x, i) => ctx.lineTo(X(x), Y(ys[i])));
  ctx.lineTo(X(xs[xs.length - 1]), Y(lo0));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();

  ctx.beginPath();
  xs.forEach((x, i) => (i ? ctx.lineTo(X(x), Y(ys[i])) : ctx.moveTo(X(x), Y(ys[i]))));
  ctx.strokeStyle = C.fg;
  ctx.lineWidth = points ? 4 : 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (points) {
    xs.forEach((x, i) => { ctx.beginPath(); ctx.arc(X(x), Y(ys[i]), 8, 0, Math.PI * 2); ctx.fillStyle = C.fg; ctx.fill(); });
  }
  if (avgHr) dashed(ctx, box.x, Y(avgHr), box.x + box.w, Y(avgHr), C.muted, 1.8);
}
