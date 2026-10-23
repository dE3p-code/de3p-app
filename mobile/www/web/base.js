// Waar de dE3p-diensten (/api/strava, /api/koppel, /api/paar, /api/spiegel) staan. Op www.de3p.be
// zelf is dat dezelfde site; in de echte app (Capacitor, capacitor://localhost) het volle adres.
export const NATIVE = Boolean(window.Capacitor?.isNativePlatform?.());
export const SITE = 'https://www.de3p.be';
export const BASE = NATIVE ? SITE : '';
