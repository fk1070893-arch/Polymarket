// Calculs du backtest, séparés du réseau pour pouvoir les tester.

export const BINS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001];

export const GROUPS = [
  { key: "politique", label: "Politique", tags: ["politics", "elections", "us-election", "global-elections", "geopolitics", "world", "trump", "france"] },
  { key: "crypto", label: "Crypto", tags: ["crypto", "bitcoin", "ethereum", "solana", "crypto-prices"] },
  { key: "sport", label: "Sport", tags: ["sports", "soccer", "football", "nfl", "nba", "tennis", "mlb", "nhl", "ufc", "esports"] },
  { key: "eco", label: "Économie / Tech", tags: ["economy", "business", "finance", "fed", "tech", "ai", "stocks"] },
];

// Tranches de volume total échangé sur un marché
export const VOLUME_BUCKETS = [
  { key: "<10k", label: "Moins de 10 k$", min: 0, max: 10000 },
  { key: "10k-100k", label: "10 k$ à 100 k$", min: 10000, max: 100000 },
  { key: "100k-1M", label: "100 k$ à 1 M$", min: 100000, max: 1000000 },
  { key: ">1M", label: "Plus de 1 M$", min: 1000000, max: Infinity },
];

export function volumeBucket(volume) {
  return (VOLUME_BUCKETS.find((b) => volume >= b.min && volume < b.max) ?? VOLUME_BUCKETS[0]).key;
}

export function groupOf(tagSlugs) {
  for (const g of GROUPS) if (tagSlugs.some((t) => g.tags.includes(t))) return g.key;
  return "autre";
}

// Dates de l'API : "2025-10-03T12:00:00Z" ou "2025-10-03 12:00:00+00"
export function parseTime(v) {
  if (!v) return null;
  let s = String(v).trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(s)) s += ":00";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Empreinte numérique stable d'un identifiant (FNV-1a)
export function hashId(id) {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Répartition stable en deux moitiés (A/B) à partir de l'identifiant
export function half(id) {
  return hashId(id) % 2 === 0 ? "A" : "B";
}

// Gain pour 1 $ misé sur "Oui" (ou "Non") au prix p
export function roiYes(p, outcome) {
  return outcome === 1 ? 1 / p - 1 : -1;
}
export function roiNo(p, outcome) {
  return outcome === 0 ? 1 / (1 - p) - 1 : -1;
}

function binIndex(p) {
  for (let i = 0; i < BINS.length - 1; i++) if (p >= BINS[i] && p < BINS[i + 1]) return i;
  return BINS.length - 2;
}

function emptyBin(i) {
  return { lo: BINS[i], hi: Math.min(1, BINS[i + 1]), n: 0, sumP: 0, wins: 0, roiYes: 0, roiNo: 0, A: { n: 0, roiYes: 0, roiNo: 0 }, B: { n: 0, roiYes: 0, roiNo: 0 } };
}

// samples : [{ id, p (prix "Oui" 24 h avant), outcome (1/0) }]
export function calibration(samples) {
  const bins = BINS.slice(0, -1).map((_, i) => emptyBin(i));
  for (const s of samples) {
    if (!(s.p > 0 && s.p < 1)) continue;
    const b = bins[binIndex(s.p)];
    const ry = roiYes(s.p, s.outcome);
    const rn = roiNo(s.p, s.outcome);
    b.n++;
    b.sumP += s.p;
    b.wins += s.outcome;
    b.roiYes += ry;
    b.roiNo += rn;
    const h = b[half(s.id)];
    h.n++;
    h.roiYes += ry;
    h.roiNo += rn;
  }
  return bins.map((b) => ({
    lo: b.lo,
    hi: b.hi,
    n: b.n,
    avgPrice: b.n ? b.sumP / b.n : null,
    freq: b.n ? b.wins / b.n : null,
    roiYes: b.n ? b.roiYes / b.n : null,
    roiNo: b.n ? b.roiNo / b.n : null,
    A: { n: b.A.n, roiYes: b.A.n ? b.A.roiYes / b.A.n : null, roiNo: b.A.n ? b.A.roiNo / b.A.n : null },
    B: { n: b.B.n, roiYes: b.B.n ? b.B.roiYes / b.B.n : null, roiNo: b.B.n ? b.B.roiNo / b.B.n : null },
  }));
}

export function brier(samples, key = "p") {
  if (!samples.length) return null;
  return samples.reduce((s, x) => s + (x[key] - x.outcome) ** 2, 0) / samples.length;
}

// Stratégie "suivre le modèle" : acheter Oui si modèle > marché + seuil,
// Non si modèle < marché − seuil. Résultat par moitié A/B.
export function followSignals(samples, threshold) {
  const res = { all: acc(), A: acc(), B: acc() };
  function acc() {
    return { bets: 0, wins: 0, pnl: 0 };
  }
  for (const s of samples) {
    const edge = s.model - s.p;
    if (Math.abs(edge) < threshold || s.p < 0.03 || s.p > 0.97) continue;
    const yes = edge > 0;
    const r = yes ? roiYes(s.p, s.outcome) : roiNo(s.p, s.outcome);
    const won = yes ? s.outcome === 1 : s.outcome === 0;
    for (const k of ["all", half(s.id)]) {
      res[k].bets++;
      res[k].wins += won ? 1 : 0;
      res[k].pnl += r;
    }
  }
  for (const k of Object.keys(res)) res[k].roi = res[k].bets ? res[k].pnl / res[k].bets : null;
  return res;
}
