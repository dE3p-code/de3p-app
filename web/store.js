// Opslag op de gsm: kleine dingen in localStorage, grotere (trainingen, kaarten, kopie van je
// computer) in IndexedDB. Alles blijft op dit toestel.

const LS = 'dE3p:web1';

export function load() {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; }
}
export function save(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
  try { localStorage.setItem(LS, JSON.stringify(next)); } catch { /* vol of geblokkeerd */ }
  return next;
}
export function clearAll() {
  try { localStorage.removeItem(LS); } catch { /* */ }
  return dbClear();
}

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('dE3p', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const out = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });
}
export const get = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const put = (key, val) => tx('readwrite', (s) => s.put(val, key)).catch(() => undefined);
export const del = (key) => tx('readwrite', (s) => s.delete(key)).catch(() => undefined);
export async function delPrefix(prefix) {
  const keys = await tx('readonly', (s) => s.getAllKeys()).catch(() => []);
  await Promise.all((keys || []).filter((k) => String(k).startsWith(prefix)).map(del));
}
const dbClear = () => tx('readwrite', (s) => s.clear()).catch(() => undefined);
