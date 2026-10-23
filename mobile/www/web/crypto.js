// Koppelen met de computer en de versleutelde kopie openen. Het programma op je computer
// versleutelt alles zelf (mirror.py); enkel deze gsm krijgt de sleutel, via de koppelcode.

import { BASE } from './base.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function unb64(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}
async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 'D3P1' + 12 bytes nonce + AES-GCM
async function open(key, bytes) {
  if (bytes.length < 32 || dec.decode(bytes.slice(0, 4)) !== 'D3P1') throw new Error('Onbekend formaat.');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(4, 16) }, key, bytes.slice(16)));
}

export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Koppelcode → { id, key } van de computer
export async function pairWith(code) {
  const c = normCode(code);
  if (c.length !== 8) throw new Error('De code heeft 8 tekens, bijvoorbeeld K7QF-M2XD.');
  const look = await sha256hex(`dE3p-zoek:${c}`);
  let r;
  try { r = await fetch(`${BASE}/api/paar?look=${look}`, { cache: 'no-store' }); } catch { throw new Error('Geen verbinding. Ben je online?'); }
  if (r.status === 404) throw new Error('Die code kennen we niet (meer). Kijk in het programma op je computer bij Instellingen → tegel Gsm → "Toon koppelcode" welke code er nu geldt, en typ die over.');
  if (!r.ok) throw new Error('De website antwoordt niet. Probeer zo opnieuw.');
  const { blob } = await r.json();
  const base = await crypto.subtle.importKey('raw', enc.encode(c), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('dE3p-koppel'), iterations: 200000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let data;
  try { data = await open(key, unb64(blob)); } catch { throw new Error('Die code klopt niet. Typ hem nog eens over.'); }
  const pc = JSON.parse(dec.decode(data));
  if (!/^[a-f0-9]{32}$/.test(pc.id || '') || !pc.key) throw new Error('Onverwacht antwoord van je computer.');
  return pc;
}

const keyFor = (pc) => crypto.subtle.importKey('raw', unb64(pc.key), 'AES-GCM', false, ['decrypt', 'encrypt']);

// Naar je computer: wat je op de gsm wijzigde (bv. een nieuw doel), versleuteld met dezelfde sleutel.
// De computer haalt het op bij zijn volgende sync en neemt het over.
export async function sendInbox(pc, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(pc), enc.encode(JSON.stringify(obj))));
  const body = new Uint8Array(16 + ct.length);
  body.set(enc.encode('D3P1'), 0); body.set(iv, 4); body.set(ct, 16);
  const r = await fetch(`${BASE}/api/spiegel/${pc.id}/in`, { method: 'PUT', body, cache: 'no-store' });
  if (!r.ok) throw new Error('Je computer kon het niet krijgen. dE3p probeert het straks opnieuw.');
}

// De laatste kopie van je computer (of null als er nog geen is)
export async function fetchSnapshot(pc) {
  const r = await fetch(`${BASE}/api/spiegel/${pc.id}`, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('De kopie van je computer kon niet opgehaald worden.');
  const plain = await open(await keyFor(pc), new Uint8Array(await r.arrayBuffer()));
  const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

// Eén recap-kaart van je computer (JPEG)
export async function fetchCard(pc, name) {
  const r = await fetch(`${BASE}/api/spiegel/${pc.id}/k/${name}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('Kaart niet gevonden.');
  const plain = await open(await keyFor(pc), new Uint8Array(await r.arrayBuffer()));
  return new Blob([plain], { type: 'image/jpeg' });
}
