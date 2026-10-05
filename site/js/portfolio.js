// Portefeuille fictif : on "achète" des parts d'une issue au prix du marché
// avec de l'argent fictif. Une part rapporte 1 $ si l'issue gagne, 0 sinon,
// exactement comme sur Polymarket. Tout est stocké dans le navigateur.

const KEY = "pm-portfolio";
export const START_CASH = 1000;

function fresh() {
  return { version: 1, cash: START_CASH, startedAt: Date.now(), positions: [] };
}

function valid(p) {
  return p && typeof p.cash === "number" && Array.isArray(p.positions);
}

export function loadPortfolio() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (valid(p)) return p;
  } catch {
    // stockage indisponible ou données corrompues
  }
  return fresh();
}

export function savePortfolio(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

export function resetPortfolio() {
  const p = fresh();
  savePortfolio(p);
  return p;
}

export function buy(p, { event, market, outcomeIndex, amount }) {
  const price = market.prices[outcomeIndex];
  if (!(amount > 0)) throw new Error("Montant invalide");
  if (amount > p.cash + 1e-9) throw new Error("Solde fictif insuffisant");
  if (!(price > 0 && price < 1)) throw new Error("Ce marché n'a pas de prix exploitable");
  const pos = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    eventId: event.id,
    eventSlug: event.slug,
    eventTitle: event.title,
    image: event.image,
    marketId: market.id,
    marketLabel: event.markets.length > 1 ? market.label || market.question : "",
    outcomeIndex,
    outcome: market.outcomes[outcomeIndex] ?? "",
    price,
    stake: Math.round(amount * 100) / 100,
    shares: amount / price,
    status: "open",
  };
  p.cash = Math.round((p.cash - pos.stake) * 100) / 100;
  p.positions.unshift(pos);
  savePortfolio(p);
  return pos;
}

export function sell(p, posId, price) {
  const pos = p.positions.find((x) => x.id === posId && x.status === "open");
  if (!pos || !(price >= 0)) return null;
  pos.status = "sold";
  pos.exitPrice = price;
  pos.payout = Math.round(pos.shares * price * 100) / 100;
  pos.closedAt = Date.now();
  p.cash = Math.round((p.cash + pos.payout) * 100) / 100;
  savePortfolio(p);
  return pos;
}

// Règle les positions dont le marché est terminé.
// states : { marketId: { x: clôturé (0/1), w: index gagnant ou null } }
export function settle(p, states) {
  let changed = 0;
  for (const pos of p.positions) {
    if (pos.status !== "open") continue;
    const st = states[pos.marketId];
    if (!st?.x || st.w == null) continue;
    const won = st.w === pos.outcomeIndex;
    pos.status = won ? "won" : "lost";
    pos.exitPrice = won ? 1 : 0;
    pos.payout = won ? Math.round(pos.shares * 100) / 100 : 0;
    pos.closedAt = Date.now();
    p.cash = Math.round((p.cash + pos.payout) * 100) / 100;
    changed++;
  }
  if (changed) savePortfolio(p);
  return changed;
}

export function stats(p, priceOf) {
  const open = p.positions.filter((x) => x.status === "open");
  const resolved = p.positions.filter((x) => x.status === "won" || x.status === "lost");
  const openValue = open.reduce((s, x) => s + x.shares * (priceOf(x) ?? x.price), 0);
  const total = p.cash + openValue;

  // "Battre le marché" : si tu achètes des issues à 30 % en moyenne, le
  // marché s'attend à ce que tu gagnes 30 % du temps. Faire mieux = tu as vu
  // quelque chose que le marché n'avait pas vu.
  const n = resolved.length;
  const wins = resolved.filter((x) => x.status === "won").length;
  const expected = n ? resolved.reduce((s, x) => s + x.price, 0) / n : null;
  const actual = n ? wins / n : null;

  return {
    cash: p.cash,
    openValue,
    total,
    pnl: total - START_CASH,
    roi: (total - START_CASH) / START_CASH,
    openCount: open.length,
    resolvedCount: n,
    wins,
    expected,
    actual,
    edge: n ? actual - expected : null,
  };
}

export function exportPortfolio(p) {
  return new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
}

export function importPortfolio(text) {
  const p = JSON.parse(text);
  if (!valid(p)) throw new Error("Fichier de portefeuille invalide");
  savePortfolio(p);
  return p;
}
