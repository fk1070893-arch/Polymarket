// Prix réellement obtenu dans le portefeuille fictif, comme sur Polymarket :
//  - on achète aux vendeurs (pas au prix affiché), en descendant dans leurs
//    offres si la mise dépasse ce que propose le meilleur (glissement) ;
//  - on revend aux acheteurs, de la même façon ;
//  - les frais preneur de la catégorie s'ajoutent à l'achat et se déduisent
//    à la revente (voir fees.js).
// Repli si le carnet d'ordres ne répond pas : meilleur prix vendeur /
// acheteur donné par Polymarket, sinon prix affiché.

import { loadBook } from "./api.js";
import { feePerShare } from "./fees.js";

const cache = new Map(); // token -> { at, book }
const TTL = 20000;

async function bookFor(token) {
  if (!token) return null;
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL) return hit.book;
  const book = await loadBook(token).catch(() => null);
  cache.set(token, { at: Date.now(), book });
  return book;
}

const r4 = (v) => Math.round(v * 10000) / 10000;

// Meilleurs prix connus sans le carnet : la 2e issue s'achète au prix
// « 1 − meilleur acheteur » de la 1re, et se revend à « 1 − meilleur vendeur »
function topOfBook(market, side) {
  const { bid, ask } = market;
  const ok = (v) => v != null && v > 0 && v < 1;
  if (side === 0) return { ask: ok(ask) ? ask : null, bid: ok(bid) ? bid : null };
  return { ask: ok(bid) ? 1 - bid : null, bid: ok(ask) ? 1 - ask : null };
}

// Achat de `amount` $ de l'issue `side`
export async function quoteBuy(market, side, amount) {
  const shown = market.prices[side];
  const book = await bookFor(market.tokens?.[side]);
  let spent = 0;
  let shares = 0;
  for (const o of book?.asks ?? []) {
    if (spent >= amount - 1e-9) break;
    const dollars = Math.min(o.price * o.size, amount - spent);
    spent += dollars;
    shares += dollars / o.price;
  }
  const best = book?.asks?.[0]?.price ?? topOfBook(market, side).ask;
  let price;
  let source;
  if (shares > 0 && spent >= amount - 0.01) {
    price = spent / shares;
    source = "carnet";
  } else if (shares > 0) {
    // Le carnet ne suffit pas : le reste serait acheté encore plus cher
    price = spent / shares;
    source = "carnet-court";
  } else if (best != null) {
    price = best;
    source = "meilleur";
  } else {
    price = shown;
    source = "affiché";
  }
  if (!(price > 0 && price < 1)) return null;
  const fee = feePerShare(market.fee, price);
  const cost = Math.min(0.999, price + fee);
  return {
    price: r4(price),
    best: best != null ? r4(best) : null,
    shown,
    fee: r4(fee),
    cost: r4(cost),
    shares: amount / cost,
    slippage: best != null ? r4(price - best) : 0,
    available: source === "carnet-court" ? Math.round(spent) : null,
    source,
  };
}

// Revente de `shares` parts de l'issue `side`
export async function quoteSell(market, side, shares) {
  const shown = market.prices?.[side] ?? null;
  const book = market.tokens ? await bookFor(market.tokens[side]) : null;
  let sold = 0;
  let got = 0;
  for (const o of book?.bids ?? []) {
    if (sold >= shares - 1e-9) break;
    const q = Math.min(o.size, shares - sold);
    sold += q;
    got += q * o.price;
  }
  const best = book?.bids?.[0]?.price ?? (market.tokens ? topOfBook(market, side).bid : null);
  let price;
  let source;
  if (sold >= shares - 1e-6) {
    price = got / sold;
    source = "carnet";
  } else if (sold > 0) {
    // Pas assez d'acheteurs : le reste ne trouverait preneur qu'à bas prix
    price = got / shares;
    source = "carnet-court";
  } else if (best != null) {
    price = best;
    source = "meilleur";
  } else {
    price = shown;
    source = "affiché";
  }
  if (!(price >= 0 && price <= 1)) return null;
  const fee = feePerShare(market.fee, price);
  const net = Math.max(0, price - fee);
  return { price: r4(price), best, shown, fee: r4(fee), net: r4(net), value: shares * net, source };
}

// Valeur d'une part si on revendait maintenant, sans lire le carnet : meilleur
// prix acheteur moins les frais (repli : prix affiché moins les frais)
export function exitEstimate(market, side, fee = market?.fee) {
  if (!market) return null;
  const shown = market.prices?.[side] ?? null;
  const bid = market.bid !== undefined || market.ask !== undefined ? topOfBook(market, side).bid : null;
  const price = bid ?? shown;
  if (price == null) return null;
  return Math.max(0, price - feePerShare(fee, price));
}
