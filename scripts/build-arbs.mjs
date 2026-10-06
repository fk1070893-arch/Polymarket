// Détecteur d'anomalies de prix : événements « une seule issue gagne » où
// la somme des prix ne fait pas 100 %. Acheter toutes les issues donne
// alors un gain connu d'avance, quel que soit le résultat.
//
// Les prix affichés par Gamma servent à repérer les candidats ; on vérifie
// ensuite dans les carnets d'ordres (CLOB) combien on aurait vraiment pu
// acheter avec un gain. Résultat : site/data/arbs.json
//
// Usage : node scripts/build-arbs.mjs

import { CLOB } from "../site/js/api.js";
import { asksOf, eventPrices, walkBooks } from "./arb-lib.mjs";
import { parseTime } from "./backtest-lib.mjs";
import { allEventsBetween, getJSON, loadPrevious, mapLimit, universeEvents, writeCache, writeData } from "./lib.mjs";
import { normalizeMarket } from "../site/js/normalize.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN_EDGE = 0.005; // écart minimum (prix affichés) pour vérifier les carnets
const MAX_CHECK = 40; // événements vérifiés dans les carnets à chaque passage
const MAX_LEGS = 40;
const KEEP_HISTORY = 30 * DAY;
const MIN_MARGIN = 0.005; // chaque lot doit rapporter au moins 0,5 % de sa mise
const MIN_PROFIT = 1; // et l'ensemble au moins 1 $

// Tous les événements ouverts, pas seulement les plus actifs : c'est sur les
// petits événements, peu surveillés, que les écarts durent le plus.
async function openEvents(now) {
  const shared = await universeEvents();
  if (shared) {
    console.log(`${shared.length} événements ouverts (lecture partagée du début du passage)`);
    return shared;
  }
  const t = Date.now();
  // Au plus 3 minutes de lecture, pour laisser passer les autres étapes
  const deadline = t + 3 * 60000;
  const events = await allEventsBetween({ active: "true", closed: "false", archived: "false" }, now - 30 * DAY, now + 5 * 365 * DAY, { deadline });
  console.log(`${events.length} événements ouverts lus en ${Math.round((Date.now() - t) / 1000)} s${Date.now() > deadline ? " (lecture interrompue : limite de temps)" : ""}`);
  return events;
}

// Tous les marchés binaires ouverts, en version compacte, pour l'étape
// suivante (comparaison avec Kalshi et Metaculus) : évite de tout relire
function compactMarkets(events) {
  const out = [];
  for (const ev of events) {
    for (const raw of ev.markets ?? []) {
      const m = normalizeMarket(raw);
      if (m.closed || !m.active || m.outcomes.length !== 2 || !m.prices.length) continue;
      out.push({
        id: m.id,
        q: m.question,
        event: String(ev.id),
        eventTitle: ev.title ?? "",
        slug: ev.slug ?? "",
        outcomes: m.outcomes,
        p: m.prices[0],
        bid: raw.bestBid ?? null,
        ask: raw.bestAsk ?? null,
        tokens: raw.clobTokenIds ?? null,
        fee: raw.takerBaseFee ?? null,
        volume: Math.round(m.volume),
        end: parseTime(raw.endDate) ?? parseTime(ev.endDate),
      });
    }
  }
  return out;
}

async function book(tokenId) {
  return asksOf(await getJSON(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, 2).catch(() => null));
}

async function check(c) {
  const side = c.side === "yes" ? c.prices.yes : c.prices.no;
  const books = await mapLimit(side.legs, 6, (l) => book(c.side === "yes" ? l.yesToken : l.noToken));
  if (books.some((b) => !b.length)) return { ...c, checked: true, sets: 0, cost: 0, profit: 0 };
  const payout = c.side === "yes" ? 1 : side.legs.length - 1;
  // Frais de chaque jambe compris (0 sur la plupart des marchés)
  const r = walkBooks(books, payout, { minMargin: MIN_MARGIN, fees: side.legs.map((l) => l.fee ?? 0) });
  return { ...c, checked: true, ...r };
}

async function main(prev) {
  const now = Date.now();
  const events = await openEvents(now);
  await writeCache("pm-markets.json", compactMarkets(events));
  const candidates = [];
  let negRisk = 0;
  for (const ev of events) {
    const prices = eventPrices(ev);
    if (!prices) continue;
    negRisk++;
    const end = parseTime(ev.endDate);
    for (const side of ["yes", "no"]) {
      const s = prices[side];
      if (!s || s.legs.length > MAX_LEGS || s.edge < MIN_EDGE) continue;
      candidates.push({
        eventId: String(ev.id),
        slug: ev.slug ?? "",
        title: ev.title ?? "",
        side,
        legs: s.legs.length,
        listedCost: s.cost,
        listedEdge: s.edge,
        end,
        prices,
      });
    }
  }
  candidates.sort((a, b) => b.listedEdge - a.listedEdge);
  console.log(`${events.length} événements, ${negRisk} à issues exclusives, ${candidates.length} avec un écart affiché ≥ ${MIN_EDGE * 100} pt`);

  const checked = [];
  for (const c of candidates.slice(0, MAX_CHECK)) checked.push(await check(c));
  const found = checked
    .filter((c) => c.profit >= MIN_PROFIT)
    .map(({ prices, ...c }) => {
      const days = c.end ? Math.max(1, (c.end - now) / DAY) : null;
      return {
        ...c,
        legLabels: (c.side === "yes" ? prices.yes : prices.no).legs.map((l) => l.label).slice(0, 12),
        // Rendement du capital immobilisé jusqu'à la fin prévue, ramené à un an
        yearly: days && c.cost > 0 ? (c.profit / c.cost) * (365 / days) : null,
        seenAt: now,
      };
    })
    .sort((a, b) => b.profit - a.profit);
  console.log(
    `${checked.length} vérifiés dans les carnets : ${found.length} vraies anomalies (au moins ${MIN_MARGIN * 100} % et ${MIN_PROFIT} $)` +
      (found.length ? ` (meilleure : +${found[0].profit.toFixed(2)} $ sur ${found[0].cost.toFixed(0)} $ engagés)` : "")
  );

  // Historique : la meilleure occurrence de chaque anomalie (événement + sens)
  const history = new Map((prev.history ?? []).filter((h) => now - h.lastSeen < KEEP_HISTORY).map((h) => [`${h.eventId}:${h.side}`, h]));
  for (const f of found) {
    const k = `${f.eventId}:${f.side}`;
    const h = history.get(k);
    history.set(k, {
      eventId: f.eventId,
      slug: f.slug,
      title: f.title,
      side: f.side,
      firstSeen: h?.firstSeen ?? now,
      lastSeen: now,
      times: (h?.times ?? 0) + 1,
      bestProfit: Math.max(h?.bestProfit ?? 0, f.profit),
      bestEdge: Math.max(h?.bestEdge ?? 0, f.cost > 0 ? f.profit / f.cost : 0),
    });
  }

  return {
    updatedAt: new Date(now).toISOString(),
    scanned: events.length,
    exclusive: negRisk,
    candidates: candidates.length,
    checked: checked.length,
    found,
    // Écarts affichés qui ne tiennent pas dans les carnets (prix périmés)
    mirages: checked.filter((c) => !(c.profit >= MIN_PROFIT)).length,
    history: [...history.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 100),
  };
}

const prev = await loadPrevious("arbs.json");
try {
  await writeData("arbs.json", await main(prev ?? {}));
} catch (err) {
  console.log(`::warning::Détecteur d'anomalies en échec : ${err.message}`);
  if (prev) await writeData("arbs.json", prev);
}
