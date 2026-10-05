// Accès aux données : on tente d'abord l'API publique de Polymarket en
// direct, et si elle est injoignable (blocage FAI, CORS, panne), on se
// rabat sur l'instantané data/events.json généré par la GitHub Action.

import { normalizeEvents, normalizeMarket, winnerIndex } from "./normalize.js";

export const GAMMA = "https://gamma-api.polymarket.com";
export const CLOB = "https://clob.polymarket.com";

const PAGE_SIZE = 100;
const LIVE_PAGES = 3;

async function fetchJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function eventsUrl(offset) {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    archived: "false",
    order: "volume24hr",
    ascending: "false",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `${GAMMA}/events?${params}`;
}

async function loadLive() {
  const pages = await Promise.all(
    Array.from({ length: LIVE_PAGES }, (_, i) => fetchJSON(eventsUrl(i * PAGE_SIZE)))
  );
  const events = normalizeEvents(pages.flat());
  if (events.length === 0) throw new Error("Réponse vide");
  return { events, histories: {}, source: "live", updatedAt: new Date().toISOString() };
}

async function loadSnapshot() {
  const data = await fetchJSON(`data/events.json?t=${Date.now()}`, 15000);
  return {
    events: data.events ?? [],
    histories: data.histories ?? {},
    source: "snapshot",
    updatedAt: data.updatedAt,
  };
}

// Garde l'instantané en mémoire pour récupérer ses historiques de prix
// même quand la liste des marchés vient de l'API en direct.
let snapshotCache = null;

export async function loadEvents({ preferLive = true } = {}) {
  const snapshotPromise = loadSnapshot().then((s) => (snapshotCache = s));
  snapshotPromise.catch(() => {});
  if (preferLive) {
    try {
      const live = await loadLive();
      // Les sparklines viennent de l'instantané s'il est disponible
      const snap = await snapshotPromise.catch(() => null);
      if (snap) live.histories = snap.histories;
      return live;
    } catch (err) {
      console.info("API Polymarket injoignable, utilisation de l'instantané :", err.message);
    }
  }
  return snapshotPromise;
}

// Historique de prix d'un token (probabilité entre 0 et 1).
export async function loadHistory(tokenId, interval = "1w") {
  const fidelity = { "1d": 15, "1w": 120, "1m": 720, max: 1440 }[interval] ?? 120;
  try {
    const params = new URLSearchParams({ market: tokenId, interval, fidelity: String(fidelity) });
    const data = await fetchJSON(`${CLOB}/prices-history?${params}`, 6000);
    const points = (data.history ?? []).map((pt) => ({ t: pt.t * 1000, p: pt.p }));
    if (points.length > 1) return { points, source: "live" };
  } catch {
    // on tente l'instantané ci-dessous
  }
  const cached = snapshotCache?.histories?.[tokenId];
  if (cached && cached.length > 1) {
    return { points: cached.map(([t, p]) => ({ t: t * 1000, p })), source: "snapshot" };
  }
  return { points: [], source: "none" };
}

// Alertes de paris suspects, générées par la GitHub Action.
export async function loadAlerts() {
  const data = await fetchJSON(`data/alerts.json?t=${Date.now()}`, 15000);
  return { alerts: data.alerts ?? [], updatedAt: data.updatedAt };
}

// État (prix, clôture, gagnant) de marchés précis, pour le portefeuille.
// Retourne { marketId: { p: [prix], x: 0|1, w: index gagnant|null } }.
export async function loadMarketStates(ids) {
  const states = {};
  if (ids.length === 0) return states;

  try {
    const snap = await fetchJSON(`data/markets.json?t=${Date.now()}`, 15000);
    for (const id of ids) if (snap.markets?.[id]) states[id] = snap.markets[id];
  } catch {
    // pas d'instantané : on compte sur l'API en direct
  }

  // L'API en direct est plus à jour que l'instantané quand elle répond.
  const query = async (list, extra = "") => {
    const qs = list.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    return fetchJSON(`${GAMMA}/markets?${qs}&limit=${list.length}${extra}`, 6000);
  };
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      let rows = await query(batch);
      const got = new Set(rows.map((r) => String(r.id)));
      const missing = batch.filter((id) => !got.has(id));
      if (missing.length) rows = rows.concat(await query(missing, "&closed=true").catch(() => []));
      for (const r of rows) {
        const m = normalizeMarket(r);
        states[m.id] = { p: m.prices, x: m.closed ? 1 : 0, w: winnerIndex(m) };
      }
    }
  } catch {
    // API injoignable : on garde l'instantané
  }
  return states;
}

// Modèle crypto (options Deribit vs Polymarket), généré par la GitHub Action.
export async function loadCrypto() {
  return fetchJSON(`data/crypto.json?t=${Date.now()}`, 15000);
}
