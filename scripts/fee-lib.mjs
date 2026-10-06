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
