// Transforme les objets bruts de l'API Gamma de Polymarket en un format
// compact et stable. Utilisé à la fois par le navigateur (mode direct) et
// par le script Node qui génère l'instantané (mode hors-ligne).

// Certains champs de l'API sont des tableaux encodés en chaîne JSON
// (ex. outcomes: '["Yes","No"]'), d'autres sont déjà des tableaux.
function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function num(value) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : 0;
}

export function normalizeMarket(m) {
  const outcomes = parseList(m.outcomes).map(String);
  const prices = parseList(m.outcomePrices).map(num);
  const tokens = parseList(m.clobTokenIds).map(String);
  return {
    id: String(m.id ?? ""),
    conditionId: m.conditionId ?? "",
    question: m.question ?? "",
    label: m.groupItemTitle || "",
    outcomes,
    prices,
    tokenId: tokens[0] ?? null,
    change24h: num(m.oneDayPriceChange),
    volume: num(m.volumeNum ?? m.volume),
    active: m.active !== false,
    closed: m.closed === true,
  };
}

// Probabilité du premier résultat ("Oui" en général) d'un marché.
export function yesPrice(market) {
  return market.prices[0] ?? 0;
}

export function normalizeEvent(e) {
  const markets = (e.markets ?? [])
    .map(normalizeMarket)
    .filter((m) => m.active && !m.closed && m.prices.length > 0)
    .sort((a, b) => yesPrice(b) - yesPrice(a));

  const tags = (e.tags ?? [])
    .filter((t) => t && t.label && !t.forceHide)
    .map((t) => ({ label: t.label, slug: t.slug ?? t.label.toLowerCase() }));

  return {
    id: String(e.id ?? ""),
    slug: e.slug ?? "",
    title: e.title ?? "",
    description: (e.description ?? "").slice(0, 1500),
    image: e.image || e.icon || "",
    startDate: e.startDate ?? e.createdAt ?? null,
    endDate: e.endDate ?? null,
    volume: num(e.volume),
    volume24h: num(e.volume24hr),
    liquidity: num(e.liquidity),
    tags,
    markets,
  };
}

// Issue gagnante d'un marché clôturé (index dans outcomes), ou null si le
// résultat n'est pas encore connu.
export function winnerIndex(market) {
  if (!market.closed) return null;
  const i = market.prices.findIndex((p) => p >= 0.98);
  return i >= 0 ? i : null;
}

export function normalizeEvents(rawEvents) {
  const seen = new Set();
  const out = [];
  for (const raw of rawEvents) {
    const ev = normalizeEvent(raw);
    if (!ev.id || seen.has(ev.id) || ev.markets.length === 0) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out;
}

// Marché "principal" d'un événement : celui dont on affiche l'historique.
export function mainMarket(event) {
  return event.markets[0] ?? null;
}
