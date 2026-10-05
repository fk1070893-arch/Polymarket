// Génère :
//  - site/data/events.json : instantané des marchés ouverts + historique
//    7 jours des marchés principaux (utilisé quand l'API est injoignable) ;
//  - site/data/markets.json : dernier prix connu et résultat final de tous
//    les marchés déjà vus, pour que le portefeuille fictif puisse calculer
//    les gains même quand un marché a disparu de la liste.
//
// Usage : node scripts/build-snapshot.mjs

import { CLOB, GAMMA, eventsUrl } from "../site/js/api.js";
import { mainMarket, normalizeEvents, normalizeMarket, winnerIndex } from "../site/js/normalize.js";
import { getJSON, loadPrevious, mapLimit, nowSec, writeData } from "./lib.mjs";

const EVENT_PAGES = 5; // 5 × 100 événements, triés par volume 24 h
const HISTORY_FOR_TOP = 150; // nombre d'événements dont on garde l'historique
const RECHECK_AFTER = 3600; // re-vérifie un marché sorti de la liste toutes les heures
const RECHECK_PER_RUN = 300;
const FORGET_AFTER = 120 * 86400; // oublie les marchés non vus depuis 120 jours

// ---------- Marchés ouverts ----------

const raw = [];
for (let page = 0; page < EVENT_PAGES; page++) {
  const batch = await getJSON(eventsUrl(page * 100));
  raw.push(...batch);
  if (batch.length < 100) break;
}
const events = normalizeEvents(raw);
if (events.length === 0) throw new Error("Aucun événement récupéré, instantané non écrit");
console.log(`${events.length} événements récupérés`);

const tokens = events
  .slice(0, HISTORY_FOR_TOP)
  .map((ev) => mainMarket(ev)?.tokenId)
  .filter(Boolean);

const histories = {};
let failed = 0;
await mapLimit(tokens, 8, async (token) => {
  try {
    const params = new URLSearchParams({ market: token, interval: "1w", fidelity: "120" });
    const data = await getJSON(`${CLOB}/prices-history?${params}`, 2);
    const points = (data.history ?? []).map((pt) => [pt.t, Math.round(pt.p * 10000) / 10000]);
    if (points.length > 1) histories[token] = points;
  } catch {
    failed++;
  }
});
console.log(`${Object.keys(histories).length} historiques récupérés (${failed} échecs)`);

await writeData("events.json", { updatedAt: new Date().toISOString(), events, histories });

// ---------- Suivi des marchés (prix et résultats) ----------

const now = nowSec();
const prev = (await loadPrevious("markets.json"))?.markets ?? {};
const markets = {};

for (const ev of events) {
  for (const m of ev.markets) {
    markets[m.id] = { s: now, c: now, p: m.prices, x: 0, w: null };
  }
}

for (const [id, entry] of Object.entries(prev)) {
  if (markets[id] || now - entry.s > FORGET_AFTER) continue;
  markets[id] = entry;
}

// Marchés qui ne sont plus dans la liste : clôturés, ou simplement moins
// actifs. On va chercher leur état directement.
const toCheck = Object.entries(markets)
  .filter(([, e]) => !e.x && e.c < now - RECHECK_AFTER)
  .sort((a, b) => a[1].c - b[1].c)
  .slice(0, RECHECK_PER_RUN)
  .map(([id]) => id);

async function fetchMarkets(ids, extra = "") {
  const qs = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  return getJSON(`${GAMMA}/markets?${qs}&limit=${ids.length}${extra}`, 2);
}

let resolved = 0;
const batches = [];
for (let i = 0; i < toCheck.length; i += 50) batches.push(toCheck.slice(i, i + 50));
await mapLimit(batches, 4, async (ids) => {
  try {
    let rows = await fetchMarkets(ids);
    // Selon les réglages de l'API, les marchés clôturés peuvent être exclus
    // par défaut : on les redemande explicitement.
    const got = new Set(rows.map((r) => String(r.id)));
    const missing = ids.filter((id) => !got.has(id));
    if (missing.length) rows = rows.concat(await fetchMarkets(missing, "&closed=true").catch(() => []));

    for (const r of rows) {
      const m = normalizeMarket(r);
      const entry = markets[m.id];
      if (!entry) continue;
      const w = winnerIndex(m);
      markets[m.id] = { s: entry.s, c: now, p: m.prices, x: m.closed ? 1 : 0, w };
      if (m.closed) resolved++;
    }
    for (const id of ids) markets[id].c = now;
  } catch (err) {
    console.log(`Vérification de marchés échouée : ${err.message}`);
  }
});
console.log(`${toCheck.length} marchés hors liste vérifiés, ${resolved} clôturés`);

await writeData("markets.json", { updatedAt: new Date().toISOString(), markets });
