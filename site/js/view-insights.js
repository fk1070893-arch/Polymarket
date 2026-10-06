// Fiche d'un marché : tout ce que les outils du site savent sur ce marché
// (bookmakers, Kalshi, modèle crypto, anomalies, paris des tests en direct).

import { cents, esc, pct } from "./format.js";
import { statusBadge, strategyStatus, strategySummaries } from "./status.js";
import { cryptoForMarket } from "./view-crypto.js";

const HOUR = 3600000;
const yesNo = (o) => (o === "Yes" ? "Oui" : o === "No" ? "Non" : o);
const pts = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} pts`;

export function marketInsights(state, ev, market) {
  const sums = strategySummaries(state);
  const id = market.id;
  const out = [];
  const line = (icon, title, text, sum) =>
    out.push(`<li><span class="ins-icon" aria-hidden="true">${icon}</span><div><b>${title}</b> ${text}${sum ? `<br />${statusBadge(strategyStatus(sum.s))}` : ""}</div></li>`);
  const p0 = market.prices[0];

  const book = state.odds?.bookByMarket?.[id];
  if (book && book[0] != null && Date.now() - book[2] < 12 * HOUR) {
    line("📊", "Bookmakers :", `${yesNo(market.outcomes[0])} ${pct(book[0])}, ${yesNo(market.outcomes[1])} ${pct(book[1])} (sans leur marge), contre ${pct(p0)} ici (${pts(p0 - book[0])}).`, sums.odds);
  }
  const k = state.cross?.kalshiByMarket?.[id];
  if (k) {
    line("🔁", "Kalshi :", `« Oui » à ${pct(k[0])}, contre ${pct(p0)} ici (${pts(p0 - k[0])}) · question rapprochée à ${Math.round(k[2] * 100)} %, à vérifier dans les règles.`, sums.cross);
  }
  const c = cryptoForMarket(state, id);
  if (c) {
    line("₿", "Modèle crypto :", `${pct(c.model)} d'après les options Deribit, contre ${pct(p0)} ici. Le backtest ne lui donne pas d'avantage sur Polymarket : à prendre comme une comparaison.`, null);
  }
  const arb = (state.arbs?.found ?? []).find((f) => f.eventId === ev.id);
  if (arb) {
    line("💰", "Anomalie de prix :", `acheter tous les « ${arb.side === "yes" ? "Oui" : "Non"} » de cet événement rapporte ${arb.profit.toFixed(2).replace(".", ",")} $ sûrs pour ${Math.round(arb.cost)} $ engagés (si les prix tiennent).`, null);
  }
  const tests = [
    ["strategy", "⚽", "Contre le favori", "fav24"],
    ["odds", "📊", "Moins cher que les bookmakers", "odds"],
    ["cross", "🔁", "Moins cher que Kalshi", "cross"],
    ["copy", "🕵️", "Copie d'un pari suspect", "copy"],
    ["fresh", "🆕", "Marché neuf à vrai prix", "fresh"],
  ];
  for (const [file, icon, name, key] of tests) {
    const bet = state[file]?.open?.[id];
    if (!bet) continue;
    const [side, cost] = bet;
    line(icon, `Pari fictif en cours (${name}) :`, `1 $ sur « ${esc(yesNo(market.outcomes[side] ?? ""))} »${cost != null ? ` à ${cents(cost)}` : ""}.`, sums[key]);
  }
  if (!out.length) return "";
  return `<section class="insights"><h3>Ce que le site sait sur ce marché</h3><ul>${out.join("")}</ul></section>`;
}
