// Études « de niche » du backtest : repérage des marchés et calculs, séparés
// du réseau pour pouvoir les tester.

import { normCdf } from "./crypto-model.mjs";

const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

// « Will X happen by December 31? », « … before 2027? », « … by end of Q3? »
// Les marchés de prix crypto (« Bitcoin above 100k by… ») ont leur propre
// étude : on les écarte.
const DEADLINE = new RegExp(`\\b(by|before)\\s+(the\\s+)?(end\\s+of\\s+)?(${MONTH}|q[1-4]\\b|20\\d\\d|\\d{1,2}/\\d{1,2}|end\\b)`, "i");
const PRICE = /\$\s?\d|\b(price|above|below|reach|hit|dip)\b/i;

export function isDeadline(question) {
  const q = String(question ?? "");
  return DEADLINE.test(q) && !PRICE.test(q);
}

// "3:00PM" -> minutes depuis minuit
function clock(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AP])M$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return h * 60 + Number(m[2] ?? 0);
}

// Marchés « Bitcoin Up or Down » : actif et durée de la fenêtre (minutes).
//  "Bitcoin Up or Down - October 5, 3:00PM-3:15PM ET" -> 15
//  "Ethereum Up or Down - October 5, 3PM ET"          -> 60
//  "Bitcoin Up or Down on October 5?"                  -> null (journalier, pas étudié)
export function parseUpDown(title) {
  const t = String(title ?? "");
  if (!/\bup or down\b/i.test(t)) return null;
  const asset = /\b(bitcoin|btc)\b/i.test(t) ? "BTC" : /\b(ethereum|eth)\b/i.test(t) ? "ETH" : null;
  if (!asset) return null;
  const range = t.match(/(\d{1,2}(?::\d{2})?\s*[AP]M)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*[AP]M)/i);
  if (range) {
    const a = clock(range[1]);
    const b = clock(range[2]);
    if (a == null || b == null) return null;
    const minutes = (b - a + 1440) % 1440;
    return minutes > 0 && minutes <= 240 ? { asset, minutes } : null;
  }
  if (/,\s*\d{1,2}\s*[AP]M\s*ET\b/i.test(t)) return { asset, minutes: 60 };
  return null;
}

// Probabilité que le prix finisse au-dessus du prix d'ouverture de la
// fenêtre, vu le prix actuel et la volatilité (annuelle) sur le temps
// restant (en années). Mouvement « log-normal » sans tendance.
export function probUp(open, spot, sigma, tau) {
  if (!(open > 0 && spot > 0 && sigma > 0 && tau > 0)) return null;
  return normCdf(Math.log(spot / open) / (sigma * Math.sqrt(tau)));
}
