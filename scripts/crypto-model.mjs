// Modèle de probabilité pour les marchés crypto du type
// « Bitcoin au-dessus de 120 000 $ le 10 octobre ? ».
//
// Idée : les options sur Deribit donnent la volatilité que le marché des
// options anticipe (volatilité implicite). Avec un mouvement brownien
// géométrique, on en déduit la probabilité que le prix finisse au-dessus
// d'un seuil, entre deux seuils, ou touche un seuil avant une date.
// Ce sont des probabilités "neutres au risque" : une référence solide, pas
// une vérité absolue.

const YEAR_MS = 365 * 86400 * 1000;

// ---------- Maths ----------

// Fonction de répartition de la loi normale (approximation d'Abramowitz &
// Stegun, erreur < 1e-7).
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// P(S_T > K)
export function probAbove(spot, strike, sigma, tau) {
  if (tau <= 0) return spot > strike ? 1 : 0;
  const sd = sigma * Math.sqrt(tau);
  return normCdf((Math.log(spot / strike) - (sd * sd) / 2) / sd);
}

// P(A < S_T < B)
export function probBetween(spot, low, high, sigma, tau) {
  return Math.max(0, probAbove(spot, low, sigma, tau) - probAbove(spot, high, sigma, tau));
}

// P(le prix touche la barrière avant T), mouvement brownien avec dérive
// -σ²/2 sur le log du prix (formule du principe de réflexion).
// dir : "up" (atteindre par le haut), "down" (chuter jusqu'à), ou null
// pour déduire la direction de la position de la barrière.
export function probTouch(spot, barrier, sigma, tau, dir = null) {
  const direction = dir ?? (barrier >= spot ? "up" : "down");
  // Déjà au-delà de la barrière dans le sens demandé : c'est gagné
  if (direction === "up" ? spot >= barrier : spot <= barrier) return 1;
  const b = Math.log(barrier / spot);
  if (tau <= 0) return 0;
  const nu = (-sigma * sigma) / 2;
  const sd = sigma * Math.sqrt(tau);
  const k = Math.exp((2 * nu * b) / (sigma * sigma));
  const p =
    b > 0
      ? normCdf((-b + nu * tau) / sd) + k * normCdf((-b - nu * tau) / sd)
      : normCdf((b - nu * tau) / sd) + k * normCdf((b + nu * tau) / sd);
  return Math.min(1, Math.max(0, p));
}

export function yearsUntil(dateMs, nowMs = Date.now()) {
  return Math.max(0, (dateMs - nowMs) / YEAR_MS);
}

// ---------- Surface de volatilité ----------

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// "BTC-10OCT26-120000-C" → { asset, expiry (ms, 08:00 UTC), strike }
export function parseDeribitInstrument(name) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(name);
  if (!m || !(m[3] in MONTHS)) return null;
  const expiry = Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8);
  return { asset: m[1], expiry, strike: Number(m[5].replace("d", ".")), type: m[6] };
}

// Construit une surface { expiries: [{ expiry, points: [[logMoneyness, iv]] }] }
// à partir du résumé Deribit (get_book_summary_by_currency, kind=option).
export function buildSurface(summaries, spot) {
  const byExpiry = new Map();
  for (const s of summaries) {
    const inst = parseDeribitInstrument(s.instrument_name ?? "");
    const iv = Number(s.mark_iv) / 100;
    if (!inst || !(iv > 0.05 && iv < 5)) continue;
    const key = inst.expiry;
    if (!byExpiry.has(key)) byExpiry.set(key, new Map());
    const strikes = byExpiry.get(key);
    // Calls et puts d'un même prix d'exercice : on fait la moyenne
    const cur = strikes.get(inst.strike) ?? [];
    cur.push(iv);
    strikes.set(inst.strike, cur);
  }
  const expiries = [...byExpiry.entries()]
    .map(([expiry, strikes]) => ({
      expiry,
      points: [...strikes.entries()]
        .map(([k, ivs]) => [Math.log(k / spot), ivs.reduce((a, b) => a + b, 0) / ivs.length])
        .sort((a, b) => a[0] - b[0]),
    }))
    .filter((e) => e.points.length >= 3)
    .sort((a, b) => a.expiry - b.expiry);
  return { spot, expiries };
}

function interp(points, x) {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

// Volatilité implicite pour un seuil et une date donnés : interpolation
// selon le prix d'exercice, puis en variance totale selon la maturité.
export function surfaceVol(surface, strike, dateMs, nowMs = Date.now()) {
  const { expiries, spot } = surface;
  if (!expiries.length) return null;
  const x = Math.log(strike / spot);
  const tau = yearsUntil(dateMs, nowMs);
  const after = expiries.findIndex((e) => e.expiry >= dateMs);
  if (after === 0) return interp(expiries[0].points, x);
  if (after === -1) return interp(expiries[expiries.length - 1].points, x);
  const e0 = expiries[after - 1];
  const e1 = expiries[after];
  const t0 = yearsUntil(e0.expiry, nowMs);
  const t1 = yearsUntil(e1.expiry, nowMs);
  const v0 = interp(e0.points, x);
  const v1 = interp(e1.points, x);
  if (t1 <= t0 || tau <= 0) return v1;
  const w = v0 * v0 * t0 + ((v1 * v1 * t1 - v0 * v0 * t0) * (tau - t0)) / (t1 - t0);
  return Math.sqrt(Math.max(w, 1e-8) / tau);
}

// Volatilité réalisée annualisée à partir de prix de clôture journaliers
export function realizedVol(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 5) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 365);
}

// ---------- Lecture des questions Polymarket ----------

const ASSETS = [
  { asset: "BTC", re: /\b(bitcoin|btc)\b/i },
  { asset: "ETH", re: /\b(ethereum|eth|ether)\b/i },
];

// Questions qui parlent de crypto sans être un pari sur le prix
const NOT_PRICE = /\b(etf|market ?cap|dominance|inflows?|outflows?|reserve|treasury|microstrategy|strategy|saylor|holdings?|flip|all[- ]time high|ath|up or down|fdv|mstr|coinbase|binance listing)\b/i;

const NUM = String.raw`\$?\s*([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?`;

function toNumber(digits, suffix) {
  const n = parseFloat(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6 }[suffix?.toLowerCase()] ?? 1;
  return n * mult;
}

// Renvoie { asset, kind: "above" | "below" | "between" | "touch", strike,
// low, high } ou null si la question n'est pas un pari sur le prix.
export function parseCryptoQuestion(question) {
  const q = question ?? "";
  if (NOT_PRICE.test(q)) return null;
  const a = ASSETS.find((x) => x.re.test(q));
  if (!a) return null;

  let m = new RegExp(String.raw`\b(reach|hit|touch|go to|rise to|climb to|dip to|fall to|drop to|crash to|dip below|fall below)\s+${NUM}`, "i").exec(q);
  if (m) {
    const strike = toNumber(m[2], m[3]);
    const verb = m[1].toLowerCase();
    // "hit" / "touch" / "go to" : direction déduite plus tard (selon le prix actuel)
    const dir = /dip|fall|drop|crash/.test(verb) ? "down" : /reach|rise|climb/.test(verb) ? "up" : null;
    if (strike) return { asset: a.asset, kind: "touch", strike, dir };
  }

  m = new RegExp(String.raw`\bbetween\s+${NUM}\s+and\s+${NUM}`, "i").exec(q);
  if (m) {
    const low = toNumber(m[1], m[2]);
    const high = toNumber(m[3], m[4]);
    if (low && high && high > low) return { asset: a.asset, kind: "between", low, high };
  }

  m = new RegExp(String.raw`\b(above|greater than|over|higher than|more than)\s+${NUM}`, "i").exec(q);
  if (m) {
    const strike = toNumber(m[2], m[3]);
    if (strike) return { asset: a.asset, kind: "above", strike };
  }

  m = new RegExp(String.raw`\b(below|less than|under|lower than)\s+${NUM}`, "i").exec(q);
  if (m) {
    const strike = toNumber(m[2], m[3]);
    if (strike) return { asset: a.asset, kind: "below", strike };
  }

  return null;
}

// Probabilité "Oui" selon le modèle
export function modelProbability(parsed, { spot, vol, dateMs, nowMs = Date.now() }) {
  const tau = yearsUntil(dateMs, nowMs);
  const v = (k) => vol(k);
  switch (parsed.kind) {
    case "above":
      return probAbove(spot, parsed.strike, v(parsed.strike), tau);
    case "below":
      return 1 - probAbove(spot, parsed.strike, v(parsed.strike), tau);
    case "between": {
      const mid = Math.sqrt(parsed.low * parsed.high);
      return probBetween(spot, parsed.low, parsed.high, v(mid), tau);
    }
    case "touch":
      return probTouch(spot, parsed.strike, v(parsed.strike), tau, parsed.dir ?? null);
    default:
      return null;
  }
}
