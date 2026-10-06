// Paris fictifs suivis en direct ("forward tests"), partagés par les
// différentes stratégies : prix réellement payé, règlement à la clôture et
// statistiques avec marge d'erreur.

import { CLOB, GAMMA } from "../site/js/api.js";
import { normalizeMarket, payoutOf } from "../site/js/normalize.js";
import { bootstrapCI } from "./backtest-lib.mjs";
import { feeParams, feePerShare } from "./fee-lib.mjs";
import { getJSON } from "./lib.mjs";

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

// ---------- Coût réel d'un achat ----------
//
// Ce qu'on paie vraiment pour une mise de STAKE $, en plus du prix affiché :
//  - l'écart achat-vente : on achète au prix vendeur, pas au prix affiché ;
//  - le glissement : une grosse mise épuise les meilleures offres et descend
//    dans le carnet d'ordres, à des prix de plus en plus chers ;
//  - les frais Polymarket (preneur) : taux × (p × (1 − p))^exposant par
//    part, d'après la grille du marché (fee-lib.mjs).
// Ne sont pas comptés : le réseau (Polygon, payé par Polymarket), le dépôt
// et le retrait d'argent (une fois, pas à chaque pari).

export const STAKE = 100; // mise de référence pour le glissement

// Frais preneur : voir fee-lib.mjs
export { feeParams, feePerShare } from "./fee-lib.mjs";

// Prix moyen payé pour `stake` $ en descendant dans les offres de vente
// (triées du moins cher au plus cher). Retourne { avg, spent } ou null.
export function walkAsks(asks, stake) {
  let spent = 0;
  let shares = 0;
  for (const o of asks) {
    if (spent >= stake - 1e-9) break;
    const dollars = Math.min(o.price * o.size, stake - spent);
    spent += dollars;
    shares += dollars / o.price;
  }
  return shares > 0 ? { avg: spent / shares, spent } : null;
}

function tokenIds(raw) {
  try {
    const t = Array.isArray(raw.clobTokenIds) ? raw.clobTokenIds : JSON.parse(raw.clobTokenIds ?? "[]");
    return t.map(String);
  } catch {
    return [];
  }
}

// Offres de vente d'une issue, de la moins chère à la plus chère (null si
// le carnet d'ordres ne répond pas)
async function fetchAsks(token) {
  const book = await getJSON(`${CLOB}/book?token_id=${encodeURIComponent(token)}`, 2).catch(() => null);
  if (!book) return null;
  return (book.asks ?? [])
    .map((o) => ({ price: num(o.price), size: num(o.size) }))
    .filter((o) => o.price > 0 && o.price < 1 && o.size > 0)
    .sort((a, b) => a.price - b.price);
}

// Parts disponibles à l'achat d'après les offres de vente :
//  - au meilleur prix ;
//  - au prix `limit` ou moins cher (ex. le prix payé par un wallet suivi) ;
//  - jusqu'à 5 ¢ au-dessus du meilleur prix (et leur valeur en $).
export function depthOf(asks, limit = null) {
  if (!asks?.length) return { best: null, atBest: 0, atLimit: limit != null ? 0 : null, within5: 0, usd5: 0 };
  const best = asks[0].price;
  let atBest = 0;
  let atLimit = 0;
  let within5 = 0;
  let usd5 = 0;
  for (const o of asks) {
    if (o.price <= best + 1e-9) atBest += o.size;
    if (limit != null && o.price <= limit + 1e-9) atLimit += o.size;
    if (o.price <= best + 0.05 + 1e-9) {
      within5 += o.size;
      usd5 += o.size * o.price;
    }
  }
  const r = Math.round;
  return { best, atBest: r(atBest), atLimit: limit != null ? r(atLimit) : null, within5: r(within5), usd5: r(usd5) };
}

export async function bookDepth(raw, side, limit = null) {
  const token = tokenIds(raw)[side];
  if (!token) return null;
  const asks = await fetchAsks(token);
  if (!asks) return null;
  // Prix moyen pour une mise de STAKE $ en descendant dans les offres
  const walked = walkAsks(asks, STAKE);
  return { ...depthOf(asks, limit), avg: walked ? Math.round(walked.avg * 10000) / 10000 : null, filled: walked ? Math.round(walked.spent) : 0 };
}

// Coût réel par part de 1 $ pour acheter l'issue `side` avec `stake` $ :
//  { cost, best, fee, filled, slippage } ; repli sur le meilleur prix
// vendeur (sans glissement) si le carnet d'ordres ne répond pas.
export async function realCost(raw, side, stake = STAKE) {
  const rate = feeParams(raw);
  const best = askPrices(raw)[side];
  const token = tokenIds(raw)[side];
  const asks = token ? await fetchAsks(token) : null;
  const walked = asks ? walkAsks(asks, stake) : null;
  const price = walked?.avg ?? best;
  if (price == null) return null;
  const fee = feePerShare(rate, price);
  const r = (v) => Math.round(v * 10000) / 10000;
  return {
    cost: r(Math.min(0.999, price + fee)),
    best: best != null ? r(best + feePerShare(rate, best)) : null,
    fee: r(fee),
    feeRate: rate,
    // Montant réellement achetable (le carnet peut être trop mince)
    filled: walked ? Math.round(walked.spent * 100) / 100 : null,
    slippage: walked && best != null ? r(walked.avg - best) : null,
  };
}

// Prix auquel on peut ACHETER chaque issue d'un marché à deux issues.
// Gamma donne le meilleur prix acheteur / vendeur de la première issue ;
// acheter la seconde revient à vendre la première au prix acheteur.
// Retourne [prix issue 0, prix issue 1] (null si inconnu).
export function askPrices(raw) {
  const bid = num(raw.bestBid);
  const ask = num(raw.bestAsk);
  const ok = (v) => v != null && v > 0 && v < 1;
  return [ok(ask) ? ask : null, ok(bid) ? 1 - bid : null];
}

// Écart achat-vente (en probabilité), ou null
export function spreadOf(raw) {
  const bid = num(raw.bestBid);
  const ask = num(raw.bestAsk);
  if (bid == null || ask == null || !(bid > 0) || !(ask < 1) || ask < bid) return null;
  return ask - bid;
}

// Gain pour 1 $ misé au prix `cost` sur une issue qui gagne (won) ou non
export function roiAt(cost, won) {
  return won ? 1 / cost - 1 : -1;
}

// Marchés (bruts Gamma) par identifiant, ouverts ou fermés
export async function fetchMarketsById(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const qs = batch.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    for (const extra of ["", "&closed=true"]) {
      const rows = await getJSON(`${GAMMA}/markets?${qs}&limit=${batch.length}${extra}`).catch(() => []);
      for (const r of rows) out.set(String(r.id), r);
    }
  }
  return out;
}

// Marchés (bruts Gamma) par conditionId, ouverts ou fermés
export async function fetchMarketsByCondition(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const qs = batch.map((id) => `condition_ids=${encodeURIComponent(id)}`).join("&");
    for (const extra of ["", "&closed=true"]) {
      const rows = await getJSON(`${GAMMA}/markets?${qs}&limit=${batch.length}${extra}`).catch(() => []);
      for (const r of rows) if (r.conditionId) out.set(r.conditionId, r);
    }
  }
  return out;
}

// Règle les paris dont le marché est terminé. Chaque pari porte `marketId`
// (ou `id`), `side` (index de l'issue achetée) et `cost` (prix payé).
export async function settleBets(bets, now, { graceMs = 3600000, max = 300 } = {}) {
  const pending = bets.filter((b) => b.won == null && (b.end == null || now > b.end + graceMs)).slice(0, max);
  if (!pending.length) return 0;
  const rows = await fetchMarketsById([...new Set(pending.map((b) => b.marketId ?? b.id))]);
  let n = 0;
  for (const b of pending) {
    const raw = rows.get(String(b.marketId ?? b.id));
    if (!raw) continue;
    const m = normalizeMarket(raw);
    const pay = payoutOf(m, b.side);
    if (pay == null) continue;
    b.winner = pay === 0.5 ? null : pay === 1 ? b.side : 1 - b.side;
    b.won = pay === 1;
    // Marché annulé, réglé 50/50 : 0,50 $ par part
    if (pay === 0.5) b.split = true;
    // Sans prix d'achat connu, seul le gain au prix affiché est calculable
    b.roi = b.cost != null ? pay / b.cost - 1 : null;
    if (b.mid != null) b.roiMid = pay / b.mid - 1;
    b.finalVolume = Math.round(m.volume);
    b.resolvedAt = now;
    n++;
  }
  return n;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Statistiques des paris réglés. `roi` = gain au prix réellement payé
// (prix vendeur), `roiMid` = gain au prix affiché, pour comparer. Les
// paris d'un même événement sont regroupés pour la marge d'erreur.
export function paperStats(bets, { seed = 5 } = {}) {
  const xs = bets.filter((b) => b.won != null);
  if (!xs.length) return { n: 0 };
  const wins = xs.filter((b) => b.won).length;
  const ex = xs.filter((b) => Number.isFinite(b.roi));
  const md = xs.filter((b) => Number.isFinite(b.roiMid));
  return {
    n: xs.length,
    events: new Set(xs.map((b) => b.event ?? b.id)).size,
    wins,
    winRate: wins / xs.length,
    // Ce que le prix annonçait
    expectedWinRate: mean(xs.map((b) => b.mid ?? b.cost)),
    nExec: ex.length,
    roi: mean(ex.map((b) => b.roi)),
    pnl: ex.reduce((s, b) => s + b.roi, 0),
    ci: bootstrapCI(ex, (b) => b.roi, { seed }),
    roiMid: mean(md.map((b) => b.roiMid)),
    ciMid: bootstrapCI(md, (b) => b.roiMid, { seed: seed + 1 }),
  };
}

// Paris en attente, par marché, pour la fiche d'un marché sur le site :
// { marketId: [issue achetée, prix payé, date du pari] }
export function openByMarket(bets) {
  const out = {};
  for (const b of bets) if (b.won == null && (b.marketId ?? b.id)) out[b.marketId ?? String(b.id).split(":")[0]] = [b.side, b.cost ?? null, b.placedAt];
  return out;
}

// Courbe des gains cumulés (1 $ par pari, au prix payé), dans l'ordre des
// règlements, réduite à `max` points : [[date, gain cumulé, paris], …]
export function pnlCurve(bets, max = 120) {
  const xs = bets.filter((b) => b.won != null && Number.isFinite(b.roi) && b.resolvedAt).sort((a, b) => a.resolvedAt - b.resolvedAt);
  const pts = [];
  let cum = 0;
  xs.forEach((b, i) => {
    cum += b.roi;
    pts.push([b.resolvedAt, Math.round(cum * 100) / 100, i + 1]);
  });
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}
