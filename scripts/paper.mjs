// Paris fictifs suivis en direct ("forward tests"), partagés par les
// différentes stratégies : prix réellement payé, règlement à la clôture et
// statistiques avec marge d'erreur.

import { CLOB, GAMMA } from "../site/js/api.js";
import { normalizeMarket, winnerIndex } from "../site/js/normalize.js";
import { bootstrapCI } from "./backtest-lib.mjs";
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
//  - les frais Polymarket (preneur), présents sur certains marchés :
//    taux × min(prix, 1 − prix) par part, d'après la grille de Polymarket.
// Ne sont pas comptés : le réseau (Polygon, payé par Polymarket), le dépôt
// et le retrait d'argent (une fois, pas à chaque pari).

export const STAKE = 100; // mise de référence pour le glissement

// Taux de frais preneur d'un marché (0 sur la plupart des marchés)
export function feeRate(raw) {
  const bps = num(raw?.takerBaseFee ?? raw?.taker_base_fee ?? raw?.takerFee);
  return bps != null && bps > 0 ? bps / 10000 : 0;
}

export const feePerShare = (rate, price) => rate * Math.min(price, 1 - price);

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

// Coût réel par part de 1 $ pour acheter l'issue `side` avec `stake` $ :
//  { cost, best, fee, filled, slippage } ; repli sur le meilleur prix
// vendeur (sans glissement) si le carnet d'ordres ne répond pas.
export async function realCost(raw, side, stake = STAKE) {
  const rate = feeRate(raw);
  const best = askPrices(raw)[side];
  const token = tokenIds(raw)[side];
  let walked = null;
  if (token) {
    const book = await getJSON(`${CLOB}/book?token_id=${encodeURIComponent(token)}`, 2).catch(() => null);
    const asks = (book?.asks ?? [])
      .map((o) => ({ price: num(o.price), size: num(o.size) }))
      .filter((o) => o.price > 0 && o.price < 1 && o.size > 0)
      .sort((a, b) => a.price - b.price);
    walked = walkAsks(asks, stake);
  }
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
    const w = winnerIndex(m);
    if (w == null) continue;
    b.winner = w;
    b.won = w === b.side;
    // Sans prix d'achat connu, seul le gain au prix affiché est calculable
    b.roi = b.cost != null ? roiAt(b.cost, b.won) : null;
    if (b.mid != null) b.roiMid = roiAt(b.mid, b.won);
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
