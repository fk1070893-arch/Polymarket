// Génère site/data/events.json : un instantané des marchés Polymarket
// ouverts + l'historique 7 jours des marchés principaux. Le site l'utilise
// quand l'API n'est pas joignable depuis le navigateur.
//
// Usage : node scripts/build-snapshot.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOB, eventsUrl } from "../site/js/api.js";
import { mainMarket, normalizeEvents } from "../site/js/normalize.js";

const EVENT_PAGES = 5; // 5 × 100 événements, triés par volume 24 h
const HISTORY_FOR_TOP = 150; // nombre d'événements dont on garde l'historique
const CONCURRENCY = 8;

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "data", "events.json");

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

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
await mapLimit(tokens, CONCURRENCY, async (token) => {
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

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), events, histories }));
console.log(`Écrit : ${OUT}`);
