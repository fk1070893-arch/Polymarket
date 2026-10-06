// Calculs du backtest, séparés du réseau pour pouvoir les tester.
import { feePerShare } from "./fee-lib.mjs";

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

// Plusieurs marchés d'un même événement (les seuils 100k / 105k / 110k
// d'un même jour, le vainqueur et le handicap d'un même match…) gagnent
// ou perdent ensemble : ils ne sont pas indépendants. Toutes les
// statistiques travaillent donc par événement : `event` sert de clé de
// regroupement (l'identifiant du marché à défaut).
export function clusterKey(s) {
  return s.event ?? s.id;
}

// Répartition stable en deux moitiés (A/B) à partir de l'identifiant
export function half(id) {
  return hashId(id) % 2 === 0 ? "A" : "B";
}

// Générateur pseudo-aléatoire reproductible (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Marge d'erreur d'une moyenne par "bootstrap par grappes" : on retire au
// hasard des événements entiers (avec remise) et on recalcule la moyenne,
// 1 000 fois. L'intervalle contient 90 % des moyennes obtenues. Si tout
// l'intervalle est au-dessus de zéro, le gain a peu de chances d'être dû
// au hasard.
export function bootstrapCI(items, value, { iters = 1000, seed = 7, level = 0.9, minClusters = 8 } = {}) {
  const groups = new Map();
  for (const it of items) {
    const k = clusterKey(it);
    const g = groups.get(k) ?? { sum: 0, n: 0 };
    g.sum += value(it);
    g.n++;
    groups.set(k, g);
  }
  const list = [...groups.values()];
  if (list.length < minClusters) return null;
  const rand = rng(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < list.length; j++) {
      const g = list[Math.floor(rand() * list.length)];
      sum += g.sum;
      n += g.n;
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const q = (x) => means[Math.min(means.length - 1, Math.max(0, Math.floor(x * means.length)))];
  return [q((1 - level) / 2), q(1 - (1 - level) / 2)];
}

// Gain pour 1 $ misé sur "Oui" (ou "Non") au prix p
export function roiYes(p, outcome) {
  return outcome === 1 ? 1 / p - 1 : -1;
}
export function roiNo(p, outcome) {
  return outcome === 0 ? 1 / (1 - p) - 1 : -1;
}

// Même chose au prix réellement payé : on achète au prix vendeur, soit le
// prix affiché + la moitié de l'écart achat-vente (s.hs), plus les frais
// preneur du marché s'il en a (grille s.fee, voir fee-lib.mjs).
const withFee = (cost, fee) => Math.min(0.999, cost + feePerShare(fee, cost));
export function roiYesExec(s) {
  return roiYes(withFee(Math.min(0.999, s.p + (s.hs ?? 0)), s.fee), s.outcome);
}
export function roiNoExec(s) {
  const costNo = withFee(Math.min(0.999, 1 - s.p + (s.hs ?? 0)), s.fee);
  return roiNo(1 - costNo, s.outcome);
}

function binIndex(p) {
  for (let i = 0; i < BINS.length - 1; i++) if (p >= BINS[i] && p < BINS[i + 1]) return i;
  return BINS.length - 2;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// samples : [{ id, event, p (prix "Oui" 24 h avant), outcome (1/0) }]
export function calibration(samples, { ci = true } = {}) {
  const per = BINS.slice(0, -1).map(() => []);
  for (const s of samples) {
    if (!(s.p > 0 && s.p < 1)) continue;
    per[binIndex(s.p)].push(s);
  }
  return per.map((list, i) => {
    const side = (h) => {
      const xs = list.filter((s) => half(clusterKey(s)) === h);
      return {
        n: xs.length,
        roiYes: mean(xs.map((s) => roiYes(s.p, s.outcome))),
        roiNo: mean(xs.map((s) => roiNo(s.p, s.outcome))),
        roiYesExec: mean(xs.map(roiYesExec)),
        roiNoExec: mean(xs.map(roiNoExec)),
      };
    };
    return {
      lo: BINS[i],
      hi: Math.min(1, BINS[i + 1]),
      n: list.length,
      events: new Set(list.map(clusterKey)).size,
      avgPrice: mean(list.map((s) => s.p)),
      freq: mean(list.map((s) => s.outcome)),
      roiYes: mean(list.map((s) => roiYes(s.p, s.outcome))),
      roiNo: mean(list.map((s) => roiNo(s.p, s.outcome))),
      ciYes: ci ? bootstrapCI(list, (s) => roiYes(s.p, s.outcome), { seed: 11 + i }) : null,
      ciNo: ci ? bootstrapCI(list, (s) => roiNo(s.p, s.outcome), { seed: 101 + i }) : null,
      roiYesExec: mean(list.map(roiYesExec)),
      roiNoExec: mean(list.map(roiNoExec)),
      ciYesExec: ci ? bootstrapCI(list, roiYesExec, { seed: 211 + i }) : null,
      ciNoExec: ci ? bootstrapCI(list, roiNoExec, { seed: 307 + i }) : null,
      halfSpread: mean(list.map((s) => s.hs ?? 0)),
      A: side("A"),
      B: side("B"),
    };
  });
}

export function brier(samples, key = "p") {
  if (!samples.length) return null;
  return samples.reduce((s, x) => s + (x[key] - x.outcome) ** 2, 0) / samples.length;
}

// Stratégie "suivre le modèle" : acheter Oui si modèle > marché + seuil,
// Non si modèle < marché − seuil. Par défaut, un seul pari par événement
// (celui où l'écart est le plus grand), pour ne pas compter dix fois le
// même mouvement du bitcoin.
export function followSignals(samples, threshold, { onePerEvent = true } = {}) {
  let signals = samples
    .filter((s) => Math.abs(s.model - s.p) >= threshold && s.p >= 0.03 && s.p <= 0.97)
    .map((s) => {
      const yes = s.model > s.p;
      return {
        ...s,
        roi: yes ? roiYes(s.p, s.outcome) : roiNo(s.p, s.outcome),
        roiExec: yes ? roiYesExec(s) : roiNoExec(s),
        won: yes ? s.outcome === 1 : s.outcome === 0,
      };
    });
  if (onePerEvent) {
    const best = new Map();
    for (const s of signals) {
      const k = clusterKey(s);
      const cur = best.get(k);
      if (!cur || Math.abs(s.model - s.p) > Math.abs(cur.model - cur.p)) best.set(k, s);
    }
    signals = [...best.values()];
  }
  const summary = (xs) => ({
    bets: xs.length,
    wins: xs.filter((s) => s.won).length,
    pnl: xs.reduce((a, s) => a + s.roi, 0),
    roi: mean(xs.map((s) => s.roi)),
    roiExec: mean(xs.map((s) => s.roiExec)),
  });
  return {
    all: {
      ...summary(signals),
      events: new Set(signals.map(clusterKey)).size,
      ci: bootstrapCI(signals, (s) => s.roi, { seed: 3 }),
      ciExec: bootstrapCI(signals, (s) => s.roiExec, { seed: 4 }),
    },
    A: summary(signals.filter((s) => half(clusterKey(s)) === "A")),
    B: summary(signals.filter((s) => half(clusterKey(s)) === "B")),
  };
}
