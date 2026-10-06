// Frais preneur de Polymarket (grille de 2026) : par part achetée,
//   frais = taux × (p × (1 − p))^exposant
// avec un taux et un exposant par catégorie, donnés par le champ
// `feeSchedule` de chaque marché Gamma (ex. sport : 0,03 et 1, soit 0,75 $
// pour 100 parts à 50 ¢ ; géopolitique : sans frais). Les vendeurs qui
// laissent un ordre en attente (« makers ») ne paient rien.
// Un paramètre de frais est { rate, exp } ou null (marché sans frais).

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

// Taux par défaut quand Gamma dit « frais activés » sans donner la grille
// (valeur courante des catégories politique, finance, tech)
export const DEFAULT_FEE = { rate: 0.04, exp: 1 };

function schedule(raw) {
  let s = raw?.feeSchedule ?? raw?.fee_schedule;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  return s && typeof s === "object" ? s : null;
}

export function feeParams(raw) {
  const s = schedule(raw);
  if (s && num(s.rate) != null) {
    const rate = num(s.rate);
    return rate > 0 ? { rate, exp: num(s.exponent ?? s.exp) ?? 1 } : null;
  }
  if (raw?.feesEnabled === false) return null;
  return raw?.feesEnabled === true ? DEFAULT_FEE : null;
}

// Frais pour une part achetée au prix p (anciens formats numériques : 0)
export function feePerShare(f, p) {
  if (!f || typeof f !== "object" || !(f.rate > 0) || !(p > 0 && p < 1)) return 0;
  return f.rate * (p * (1 - p)) ** (f.exp ?? 1);
}

// Grille de secours quand un marché n'indique pas la sienne (marchés terminés
// avant 2026, données incomplètes) : d'après la catégorie de l'événement.
// Taux relevés sur les marchés Polymarket en octobre 2026.
const TAG_FEES = [
  [["geopolitics", "world"], null],
  [["sports", "soccer", "nba", "nhl", "mlb", "tennis", "ufc", "esports", "cricket", "golf", "f1"], { rate: 0.05, exp: 1 }],
  [["nfl", "cfb"], { rate: 0.03, exp: 1 }],
  [["crypto", "bitcoin", "ethereum", "solana", "crypto-prices"], { rate: 0.07, exp: 1 }],
  [["economy", "economics", "fed"], { rate: 0.03, exp: 0.5 }],
  [["weather"], { rate: 0.025, exp: 0.5 }],
  [["culture", "pop-culture", "movies", "music", "awards"], { rate: 0.05, exp: 1 }],
  [["politics", "elections", "finance", "business", "tech", "ai", "stocks"], { rate: 0.04, exp: 1 }],
];

export function feeForTags(tags = []) {
  const set = new Set(tags);
  // Le plus précis d'abord : NFL avant « sports », géopolitique avant tout
  for (const key of [0, 2, 1, 3, 4, 5, 6, 7]) {
    const [list, fee] = TAG_FEES[key];
    if (list.some((t) => set.has(t))) return fee;
  }
  return DEFAULT_FEE;
}
