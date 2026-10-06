// Anomalies de prix sur les événements à plusieurs issues exclusives
// (« Qui va gagner l'élection ? ») : exactement une issue gagne, donc les
// « Oui » doivent valoir 100 % au total. Calculs séparés du réseau pour
// pouvoir les tester.

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

function list(v) {
  if (Array.isArray(v)) return v;
  try {
    const x = JSON.parse(v ?? "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

// Prix des marchés d'un événement « une seule issue gagne » (negRisk).
// Retourne null si l'événement ne s'y prête pas.
//  - yes : acheter le « Oui » de chaque issue coûte sumAsk et rapporte 1 $
//    à coup sûr ; possible seulement si TOUTES les issues sont achetables
//    et que la liste ne peut plus s'allonger.
//  - no : acheter le « Non » de chaque issue coûte n − sumBid et rapporte
//    au moins n − 1 $ (une seule issue gagne) ; marche sur n'importe quel
//    sous-ensemble d'issues.
export function eventPrices(ev) {
  const markets = ev.markets ?? [];
  const flagged = ev.negRisk === true || ev.enableNegRisk === true || markets.some((m) => m.negRisk === true);
  if (!flagged || markets.some((m) => m.negRisk === false)) return null;
  const closed = markets.filter((m) => m.closed === true);
  // Une issue déjà gagnante : l'événement est joué
  if (closed.some((m) => (num(list(m.outcomePrices)[0]) ?? 0) >= 0.98)) return null;
  const open = markets.filter((m) => m.closed !== true && m.active !== false);
  if (open.length < 2) return null;

  const legs = open.map((m) => {
    const tokens = list(m.clobTokenIds).map(String);
    const bid = num(m.bestBid);
    const ask = num(m.bestAsk);
    return {
      id: String(m.id),
      label: m.groupItemTitle || m.question || "",
      yesToken: tokens[0] ?? null,
      noToken: tokens[1] ?? null,
      bid: bid != null && bid > 0 && bid < 1 ? bid : null,
      ask: ask != null && ask > 0 && ask < 1 ? ask : null,
      tradable: m.acceptingOrders !== false && m.enableOrderBook !== false,
      // Frais preneur du marché (0 sur la plupart), en fraction : seulement
      // si feesEnabled, Gamma remplit takerBaseFee même sans frais
      fee: m.feesEnabled === true && (num(m.takerBaseFee) ?? 0) > 0 ? num(m.takerBaseFee) / 10000 : 0,
    };
  });

  // Liste figée : pas d'issue « à venir » ajoutable plus tard (negRiskAugmented)
  const complete = ev.negRiskAugmented !== true && legs.every((l) => l.tradable && l.ask != null && l.yesToken);
  const yesLegs = complete ? legs : [];
  const noLegs = legs.filter((l) => l.tradable && l.bid != null && l.noToken);
  const sumAsk = yesLegs.reduce((s, l) => s + l.ask, 0);
  const sumBid = noLegs.reduce((s, l) => s + l.bid, 0);
  return {
    legs,
    yes: complete ? { legs: yesLegs, cost: sumAsk, edge: 1 - sumAsk } : null,
    no: noLegs.length >= 2 ? { legs: noLegs, cost: noLegs.length - sumBid, edge: sumBid - 1 } : null,
  };
}

// Carnet d'ordres CLOB -> offres de vente triées du meilleur prix au pire
export function asksOf(book) {
  return (book?.asks ?? [])
    .map((o) => ({ price: num(o.price), size: num(o.size) }))
    .filter((o) => o.price != null && o.size > 0)
    .sort((a, b) => a.price - b.price);
}

// Combien de « lots » (une part de chaque jambe) peut-on acheter en
// gardant un gain positif, en descendant dans les carnets d'ordres ?
// payout = ce que rapporte un lot à coup sûr (1 $ pour les « Oui »,
// n − 1 $ pour les « Non »). On s'arrête quand un lot de plus rapporte
// moins de `minMargin` de sa mise : au-delà, on immobilise beaucoup
// d'argent pour presque rien.
// fees[i] : taux de frais de chaque jambe (frais par part = taux × min(p, 1 − p)).
export function walkBooks(books, payout, { minMargin = 0, fees = [] } = {}) {
  const levels = books.map((b) => b.map((o) => ({ ...o })));
  const idx = levels.map(() => 0);
  let sets = 0;
  let cost = 0;
  for (let guard = 0; guard < 10000; guard++) {
    if (levels.some((l, i) => idx[i] >= l.length)) break;
    const unit = levels.reduce((s, l, i) => {
      const p = l[idx[i]].price;
      return s + p + (fees[i] ?? 0) * Math.min(p, 1 - p);
    }, 0);
    if (payout - unit <= unit * minMargin) break;
    const q = Math.min(...levels.map((l, i) => l[idx[i]].size));
    sets += q;
    cost += q * unit;
    levels.forEach((l, i) => {
      l[idx[i]].size -= q;
      if (l[idx[i]].size <= 1e-9) idx[i]++;
    });
  }
  return { sets, cost, profit: sets * payout - cost };
}
