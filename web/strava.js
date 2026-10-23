// Strava rechtstreeks op de gsm, met je eigen Strava-sleutel (Client ID + Secret). Verzoeken lopen
// via /api/strava, een doorgeefluik dat niets bewaart (Strava's token-adres weigert browsers).
// Een app op het iPhone-beginscherm opent Strava in een apart venster met eigen opslag: dat venster
// zet de code kort klaar op /api/koppel en de app haalt ze daar op.

import * as store from './store.js';
import { BASE, NATIVE, SITE } from './base.js';

const PROXY = `${BASE}/api/strava`;
export const SCOPE = 'read,activity:read_all,activity:write';

// in de app: Strava komt terug op www.de3p.be, die de code doorgeeft (zoals bij de iPhone-beginschermapp)
export const redirectUri = () => (NATIVE ? `${SITE}/` : `${location.origin}${location.pathname}`);
export const newState = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const st = () => store.load().strava || {};
const setSt = (patch) => store.save({ strava: { ...st(), ...patch } });

export function authorizeUrl(clientId, state) {
  const p = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), approval_prompt: 'auto', scope: SCOPE, state });
  return `https://www.strava.com/oauth/authorize?${p}`;
}

// Inloggen zonder eigen sleutel: de site kent de gedeelde dE3p-sleutel (Client ID; het geheim blijft op de server).
// Eén keer per dag nagevraagd (dicht: elke minuut opnieuw). null = nog niet ingesteld: dan maak je zoals vroeger een eigen Strava-sleutel.
export async function sharedClient(fresh = false) {
  const c = store.load().stravaShared;
  if (!fresh && c && Date.now() - c.at < (c.id ? 864e5 : 6e4)) return c.id;
  try {
    const r = await fetch(`${PROXY}/config`, { cache: 'no-store' });
    const id = r.ok ? (await r.json())?.clientId || null : null;
    store.save({ stravaShared: { id, at: Date.now() } });
    return id;
  } catch { return c?.id || null; }
}

async function tokenRequest(params) {
  let r;
  const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v));     // gedeelde sleutel: geen geheim
  try {
    r = await fetch(`${PROXY}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch { throw new Error('Geen verbinding met Strava. Ben je online?'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (st().shared && /limit|capacity/i.test(JSON.stringify(data))) throw new Error('dE3p mag bij Strava nog maar een paar lopers koppelen. Gebruik voorlopig je eigen Strava-sleutel.');
    throw new Error(data?.errors?.[0]?.field === 'client_id' || r.status === 401 ? 'Strava weigert de sleutel: Client ID of Client Secret klopt niet.'
      : data?.message || 'Strava weigerde de aanvraag.');
  }
  return data;
}
const tokens = (d) => ({ access: d.access_token, refresh: d.refresh_token, expiresAt: d.expires_at });

export async function exchange(code, scope) {
  const s = st();
  const d = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, code, grant_type: 'authorization_code' });
  const a = d.athlete || {};
  setSt({ tokens: tokens(d), scope: scope || '', pendingState: '', athlete: [a.firstname, a.lastname].filter(Boolean).join(' '), athleteId: a.id || null });
}

async function accessToken() {
  const s = st();
  if (!s.tokens) throw new Error('Strava is niet gekoppeld op deze gsm.');
  if (s.tokens.expiresAt - 120 > Date.now() / 1000) return s.tokens.access;
  const d = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.tokens.refresh, grant_type: 'refresh_token' });
  setSt({ tokens: tokens(d) });
  return d.access_token;
}

async function api(path) {
  const token = await accessToken();
  let r;
  try { r = await fetch(`${PROXY}/api/v3${path}`, { headers: { Authorization: `Bearer ${token}` } }); } catch { throw new Error('Geen verbinding met Strava. Ben je online?'); }
  if (r.status === 429) throw new Error('Strava-limiet bereikt. Probeer het over een kwartier opnieuw.');
  if (r.status === 401) throw new Error('Strava-toegang verlopen. Koppel Strava opnieuw bij Instellingen.');
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.message || `Strava-fout (${r.status}).`);
  return data;
}

export async function listActivities(afterEpoch) {
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/athlete/activities?after=${afterEpoch}&per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}
export const getActivity = (id) => api(`/activities/${id}`);
// naam (en beschrijving) van een training aanpassen op Strava
export async function updateActivity(id, data) {
  const token = await accessToken();
  let r;
  try {
    r = await fetch(`${PROXY}/api/v3/activities/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } catch { throw new Error('Geen verbinding met Strava. Ben je online?'); }
  if (r.status === 429) throw new Error('Strava-limiet bereikt. Probeer het over een kwartier opnieuw.');
  if (!r.ok) throw new Error(`Strava liet de naam niet aanpassen (${r.status}).`);
  return r.json().catch(() => null);
}
export const getStreams = (id) => api(`/activities/${id}/streams?keys=heartrate,distance,time&key_by_type=true`);

export async function handOff(state, q) {
  await fetch(`${BASE}/api/koppel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, code: q.get('code') || '', scope: q.get('scope') || '', error: q.get('error') || '' }),
  });
}
export async function pickUp(state) {
  const r = await fetch(`${BASE}/api/koppel?state=${state}`, { cache: 'no-store' });
  return r.status === 200 ? r.json() : null;
}
