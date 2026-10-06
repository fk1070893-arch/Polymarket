// Lecture unique de tous les événements ouverts de Polymarket, partagée par
// les étapes suivantes du même passage (favoris sport, marchés neufs,
// anomalies de prix, Kalshi, bookmakers) au lieu que chacune relise l'API.
// Version allégée (seulement les champs utiles), gardée dans .cache/ et
// jamais publiée. Si cette étape échoue, chaque étape relit l'API elle-même.
//
// Usage : node scripts/build-universe.mjs

import { feeParams } from "./fee-lib.mjs";
import { allEventsBetween, writeCache } from "./lib.mjs";

const DAY = 86400000;

const EVENT_FIELDS = ["id", "slug", "title", "image", "icon", "endDate", "startDate", "startTime", "createdAt", "negRisk", "enableNegRisk", "negRiskAugmented", "volume", "volume24hr", "liquidity"];
const MARKET_FIELDS = [
  "id", "question", "conditionId", "groupItemTitle", "outcomes", "outcomePrices", "clobTokenIds", "bestBid", "bestAsk",
  "volumeNum", "volume", "endDate", "startDate", "createdAt", "closed", "active", "acceptingOrders", "enableOrderBook",
  "negRisk", "sportsMarketType", "gameStartTime", "closedTime", "feesEnabled", "feeSchedule", "feeType",
];

const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj[f] !== undefined).map((f) => [f, obj[f]]));

const started = Date.now();
const now = Date.now();
try {
  const events = await allEventsBetween({ active: "true", closed: "false", archived: "false" }, now - 30 * DAY, now + 5 * 365 * DAY, {
    deadline: started + 3 * 60000,
  });
  const slim = events.map((ev) => ({
    ...pick(ev, EVENT_FIELDS),
    tags: (ev.tags ?? []).map((t) => ({ slug: t.slug, label: t.label })).filter((t) => t.slug),
    markets: (ev.markets ?? []).map((m) => pick(m, MARKET_FIELDS)),
  }));
  await writeCache("universe.json", { readAt: now, complete: Date.now() < started + 3 * 60000, events: slim });
  const markets = slim.reduce((s, ev) => s + ev.markets.length, 0);
  const fees = { enabled: 0, rates: {} };
  for (const ev of slim)
    for (const m of ev.markets) {
      const f = feeParams(m);
      if (!f) continue;
      fees.enabled++;
      const k = `${m.feeType ?? "?"} ${f.rate}^${f.exp}`;
      fees.rates[k] = (fees.rates[k] ?? 0) + 1;
    }
  const rates = Object.entries(fees.rates).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} × ${n}`).join(", ");
  console.log(`${slim.length} événements ouverts (${markets} marchés, dont ${fees.enabled} avec frais${rates ? ` : ${rates}` : ""}) lus en ${Math.round((Date.now() - started) / 1000)} s`);
} catch (err) {
  console.log(`::warning::Lecture de Polymarket en échec : ${err.message} (chaque étape relira l'API)`);
}
