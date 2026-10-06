// Détecteur d'anomalies de prix : événements « une seule issue gagne » où
// la somme des prix ne fait pas 100 %. Acheter toutes les issues donne
// alors un gain connu d'avance, quel que soit le résultat.
//
// Les prix affichés par Gamma servent à repérer les candidats ; on vérifie
// ensuite dans les carnets d'ordres (CLOB) combien on aurait vraiment pu
// acheter avec un gain. Résultat : site/data/arbs.json
//
// Usage : node scripts/build-arbs.mjs

import { CLOB, GAMMA } from "../site/js/api.js";
import { asksOf, eventPrices, walkBooks } from "./arb-lib.mjs";
import { parseTime } from "./backtest-lib.mjs";
import { getJSON, loadPrevious, mapLimit, writeData } from "./lib.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const PAGES = 5; // 500 événements les plus actifs
const MIN_EDGE = 0.005; // écart minimum (prix affichés) pour vérifier les carnets
const MAX_CHECK = 25; // événements vérifiés dans les carnets à chaque passage
const MAX_LEGS = 40;
const KEEP_HISTORY = 30 * DAY;
const MIN_MARGIN = 0.005; // chaque lot doit rapporter au moins 0,5 % de sa mise
const MIN_PROFIT = 1; // et l'ensemble au moins 1 $

async function openEvents() {
  const out = [];
  for (let page = 0; page < PAGES; page++) {
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      archived: "false",
      order: "volume24hr",
      ascending: "false",
      limit: "100",
      offset: String(page * 100),
    });
    const batch = await getJSON(`${GAMMA}/events?${params}`);
    out.push(...batch);
    if (batch.length < 100) break;
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
  const r = walkBooks(books, payout, { minMargin: MIN_MARGIN });
  return { ...c, checked: true, ...r };
}

async function main(prev) {
  const now = Date.now();
  const events = await openEvents();
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
