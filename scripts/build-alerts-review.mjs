// Bilan des alertes : combien aurait-on gagné en suivant TOUTES les alertes
// des dernières 24 h (et des 7 derniers jours), avec 1 $ par alerte ?
//
//  - marché terminé : gain réel (1 / prix − 1 si l'issue a gagné, −1 sinon) ;
//  - marché en cours : valeur si on revendait maintenant (meilleur prix
//    acheteur actuel / prix d'achat − 1).
// Prix d'achat : celui réellement obtenu par le test « copier les alertes »
// quand il a pu copier l'alerte (mise de 100 $, glissement et frais compris),
// sinon celui du wallet suspect plus les frais du marché (impossible à avoir
// en vrai : c'est le cas le plus favorable, signalé comme tel). Revente au
// meilleur prix acheteur, frais déduits.
// Parts disponibles : la première fois que le site voit une alerte, il lit
// le carnet d'ordres de l'issue (parts au meilleur prix, au prix du wallet
// ou moins cher, et jusqu'à 5 ¢ au-dessus), gardé dans la mémoire.
// Résultat : site/data/alerts-review.json
//
// Usage : node scripts/build-alerts-review.mjs (après build-alerts et build-copy)

import { normalizeMarket, payoutOf } from "../site/js/normalize.js";
import { loadState, mapLimit, readData, readState, writeState } from "./lib.mjs";
import { bookDepth, feeParams, feePerShare, fetchMarketsByCondition } from "./paper.mjs";

const HOUR = 3600000;
const MAX_DEPTH_PER_RUN = 80; // lectures de carnet d'ordres par passage
const WINDOWS = { "24h": 24 * HOUR, "7j": 7 * 24 * HOUR };
const BUCKETS = [
  { key: "70", label: "Score 70 et plus", min: 70 },
  { key: "50", label: "Score 50 à 69", min: 50, max: 70 },
  { key: "35", label: "Score 35 à 49", min: 0, max: 50 },
];

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

// Prix auquel on pourrait revendre l'issue maintenant
function sellPrice(raw, side) {
  const bid = num(raw.bestBid);
  const ask = num(raw.bestAsk);
  if (side === 0) return bid != null && bid > 0 && bid < 1 ? bid : null;
  return ask != null && ask > 0 && ask < 1 ? 1 - ask : null;
}

function summarize(rows) {
  const done = rows.filter((r) => r.status === "won" || r.status === "lost");
  const open = rows.filter((r) => r.status === "open");
  const realized = done.reduce((s, r) => s + r.roi, 0);
  const unrealized = open.reduce((s, r) => s + r.roi, 0);
  return {
    n: rows.length,
    resolved: done.length,
    won: done.filter((r) => r.status === "won").length,
    open: open.length,
    unknown: rows.filter((r) => r.status === "unknown").length,
    realized,
    unrealized,
    total: realized + unrealized,
    // Part des alertes au prix réellement obtenu par le test de copie
    realPrice: rows.filter((r) => r.priceSource === "copie").length,
    bookPrice: rows.filter((r) => r.priceSource === "carnet").length,
  };
}

const now = Date.now();
try {
  const { alerts = [] } = await readData("alerts.json");
  const copy = await readState("copy");
  const copied = new Map((copy?.bets ?? []).map((b) => [b.id, b.cost]));
  const recent = alerts.filter((a) => a.conditionId && now - a.ts * 1000 < WINDOWS["7j"]);
  const markets = await fetchMarketsByCondition([...new Set(recent.map((a) => a.conditionId))]);

  // Carnet d'ordres au moment où le site voit l'alerte (une seule fois)
  const prevState = (await loadState("alerts-review")) ?? {};
  const keepIds = new Set(recent.map((a) => a.id));
  const depth = Object.fromEntries(Object.entries(prevState.depth ?? {}).filter(([id]) => keepIds.has(id)));
  const todo = recent.filter((a) => !depth[a.id] && markets.get(a.conditionId)).slice(0, MAX_DEPTH_PER_RUN);
  await mapLimit(todo, 6, async (a) => {
    const d = await bookDepth(markets.get(a.conditionId), a.outcomeIndex, a.price > 0 ? a.price : null).catch(() => null);
    if (d) depth[a.id] = { ...d, seenAt: now };
  });

  const rows = recent.map((a) => {
    const raw = markets.get(a.conditionId);
    const side = a.outcomeIndex;
    const cost = copied.get(a.id);
    const rate = feeParams(raw);
    // Prix d'achat, du plus réaliste au moins réaliste : celui du test de
    // copie, celui du carnet d'ordres quand le site a vu l'alerte (mise de
    // 100 $), sinon celui du wallet suspect
    const d = depth[a.id];
    // (seulement si le carnet a été lu peu après l'alerte)
    const bookAvg = d?.avg > 0 && d.avg < 1 && d.seenAt - a.ts * 1000 < 30 * 60000 ? d.avg : null;
    const basePrice = cost != null ? null : bookAvg ?? (a.price > 0 ? a.price : null);
    const entry = cost ?? (basePrice != null ? Math.min(0.999, basePrice + feePerShare(rate, basePrice)) : a.price);
    const priceSource = cost != null ? "copie" : bookAvg != null ? "carnet" : "wallet";
    const base = {
      id: a.id,
      ts: a.ts,
      score: a.score,
      title: a.title || a.eventTitle || "",
      eventTitle: a.eventTitle || "",
      eventSlug: a.eventSlug || "",
      conditionId: a.conditionId,
      outcome: a.outcome,
      cash: a.cash,
      price: a.price,
      small: a.small === true,
      tags: (a.tags ?? []).slice(0, 8),
      depth: depth[a.id] ? { ...depth[a.id], late: Math.round((depth[a.id].seenAt - a.ts * 1000) / 60000) } : null,
      entry,
      priceSource,
    };
    if (!raw || !(entry > 0 && entry < 1)) return { ...base, status: "unknown", roi: 0 };
    const m = normalizeMarket(raw);
    const pay = payoutOf({ ...m, closed: raw.closed === true }, side);
    if (pay != null) return { ...base, status: pay === 1 ? "won" : "lost", split: pay === 0.5 || undefined, roi: pay / entry - 1 };
    const bid = sellPrice(raw, side) ?? m.prices[side] ?? null;
    if (bid == null) return { ...base, status: "unknown", roi: 0 };
    const sell = Math.max(0, bid - feePerShare(rate, bid));
    return { ...base, status: "open", now: sell, roi: sell / entry - 1 };
  });

  const out = { updatedAt: new Date(now).toISOString(), windows: {} };
  for (const [key, ms] of Object.entries(WINDOWS)) {
    const inWindow = rows.filter((r) => now - r.ts * 1000 < ms);
    out.windows[key] = {
      ...summarize(inWindow),
      byScore: BUCKETS.map((b) => ({ ...b, ...summarize(inWindow.filter((r) => r.score >= b.min && (b.max == null || r.score < b.max))) })),
    };
  }
  out.rows = rows.sort((a, b) => b.ts - a.ts).slice(0, 400).map(({ depth: d, ...r }) => (d ? { ...r, depth: { ...d, seenAt: undefined } } : r));
  const d = out.windows["24h"];
  const p = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} $`;
  console.log(`Alertes des dernières 24 h : ${d.n} (dont ${d.resolved} terminées, ${d.won} gagnées) → réalisé ${p(d.realized)}, en cours ${p(d.unrealized)}, total ${p(d.total)} pour ${d.n} $ misés`);
  console.log(`Carnets d'ordres lus pour ${todo.length} nouvelle(s) alerte(s) (${Object.keys(depth).length} en mémoire)`);
  await writeState("alerts-review", { depth }, out);
} catch (err) {
  console.log(`::warning::Bilan des alertes en échec : ${err.message}`);
}
