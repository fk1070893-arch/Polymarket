// Test en direct ("forward test") de la stratégie trouvée par le backtest :
// en sport, les favoris cotés 60-90 % la veille gagnent moins souvent que
// leur prix ne le dit. On parie donc (fictivement) 1 $ contre eux.
//
// La règle reprend exactement celle du backtest :
//  - marchés sport à deux issues ;
//  - 24 h (± 4 h) avant la date de fin prévue ;
//  - si la première issue est cotée entre 60 % et 90 %, on achète l'autre.
// Les paris sont enregistrés au moment où ils auraient été pris, puis réglés
// à la clôture. Le backtest ne gardait que les marchés ayant fini avec au
// moins 1 000 $ de volume ; ce volume final n'est pas connu au moment de
// parier (l'essentiel des échanges a lieu dans les dernières heures). On
// parie donc sans filtre de volume, on note le volume final à la clôture,
// et le résultat principal ne compte que les marchés comparables au
// backtest (volume final ≥ 1 000 $). Le résultat sur tous les marchés est
// gardé à côté. Ces marchés n'ont jamais été vus par le backtest : c'est le
// vrai test. Résultat : site/data/strategy.json
//
// Usage : node scripts/build-strategy.mjs

import { GAMMA } from "../site/js/api.js";
import { normalizeMarket, winnerIndex } from "../site/js/normalize.js";
import { bootstrapCI, groupOf, parseTime, roiNo } from "./backtest-lib.mjs";
import { getJSON, loadPrevious, writeData } from "./lib.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WINDOW = [20 * HOUR, 28 * HOUR]; // temps restant avant la fin prévue
const BAND = [0.6, 0.9]; // cote du favori (première issue)
const MIN_VOLUME = 1000;
const KEEP_FOR = 180 * DAY;
const NOISE = /\bup or down\b/i;

const RULE = {
  description:
    "Sport, deux issues, 24 h avant la fin prévue : si la première issue est cotée 60-90 %, 1 $ fictif sur l'autre issue. Résultat compté sur les marchés finis avec au moins 1 000 $ de volume, comme dans le backtest.",
  band: BAND,
  windowHours: [WINDOW[0] / HOUR, WINDOW[1] / HOUR],
  minVolume: MIN_VOLUME,
};

// Marchés sport qui se terminent dans la fenêtre
async function candidates(now) {
  const out = [];
  // Décompte de chaque filtre, pour vérifier dans les logs que la règle
  // trouve bien des marchés
  const seen = { events: 0, sport: 0, binary: 0, volume: 0, window: 0 };
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      tag_slug: "sports",
      active: "true",
      closed: "false",
      end_date_min: new Date(now + WINDOW[0] - 6 * HOUR).toISOString(),
      end_date_max: new Date(now + WINDOW[1] + 6 * HOUR).toISOString(),
      limit: "100",
      offset: String(page * 100),
    });
    const batch = await getJSON(`${GAMMA}/events?${params}`);
    for (const ev of batch) {
      seen.events++;
      const tags = (ev.tags ?? []).map((t) => t.slug).filter(Boolean);
      if (groupOf(tags) !== "sport") continue;
      seen.sport++;
      for (const raw of ev.markets ?? []) {
        const m = normalizeMarket(raw);
        if (m.closed || !m.active || m.outcomes.length !== 2 || m.prices.length !== 2) continue;
        if (NOISE.test(m.question)) continue;
        seen.binary++;
        if (m.volume >= MIN_VOLUME) seen.volume++;
        const end = parseTime(raw.endDate) ?? parseTime(ev.endDate);
        if (end == null) continue;
        const left = end - now;
        if (left < WINDOW[0] || left > WINDOW[1]) continue;
        seen.window++;
        out.push({ ev, raw, m, end });
      }
    }
    if (batch.length < 100) break;
  }
  console.log(
    `Filtres : ${seen.events} événements, ${seen.sport} sport, ${seen.binary} marchés à deux issues, ` +
      `${seen.volume} déjà à 1 000 $ de volume, ${seen.window} dans la fenêtre 20-28 h`
  );
  return out;
}

async function resolve(bets, now) {
  const pending = bets.filter((b) => b.outcome == null && now > b.end + HOUR).slice(0, 300);
  for (let i = 0; i < pending.length; i += 40) {
    const ids = pending.slice(i, i + 40).map((b) => b.id);
    const qs = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    const rows = [
      ...(await getJSON(`${GAMMA}/markets?${qs}&limit=${ids.length}`).catch(() => [])),
      ...(await getJSON(`${GAMMA}/markets?${qs}&limit=${ids.length}&closed=true`).catch(() => [])),
    ];
    for (const r of rows) {
      const m = normalizeMarket(r);
      const w = winnerIndex(m);
      const bet = bets.find((b) => b.id === m.id);
      if (!bet || w == null || bet.outcome != null) continue;
      bet.outcome = w === 0 ? 1 : 0; // 1 = le favori (première issue) a gagné
      bet.finalVolume = Math.round(m.volume);
      bet.roi = roiNo(bet.p, bet.outcome);
      bet.resolvedAt = now;
    }
  }
}

function summarize(bets) {
  const settled = bets.filter((b) => b.outcome != null);
  // Même population que le backtest : volume final d'au moins 1 000 $
  const done = settled.filter((b) => (b.finalVolume ?? 0) >= MIN_VOLUME);
  const stats = (xs) => {
    if (!xs.length) return { n: 0 };
    const wins = xs.filter((b) => b.outcome === 0).length;
    return {
      n: xs.length,
      events: new Set(xs.map((b) => b.event)).size,
      wins,
      winRate: wins / xs.length,
      // Ce que le marché attendait : notre issue gagne avec une proba 1 - p
      expectedWinRate: xs.reduce((s, b) => s + (1 - b.p), 0) / xs.length,
      roi: xs.reduce((s, b) => s + b.roi, 0) / xs.length,
      pnl: xs.reduce((s, b) => s + b.roi, 0),
      ci: bootstrapCI(xs, (b) => b.roi, { seed: 5 }),
    };
  };
  const bands = [
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
  ].map(([lo, hi]) => ({ lo, hi, ...stats(done.filter((b) => b.p >= lo && b.p < hi)) }));
  return { ...stats(done), pending: bets.length - settled.length, lowVolume: settled.length - done.length, all: stats(settled), bands };
}

async function main(prev) {
  const now = Date.now();
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR);
  const known = new Set(bets.map((b) => b.id));

  let added = 0;
  for (const { ev, raw, m, end } of await candidates(now)) {
    if (known.has(m.id)) continue;
    const p = m.prices[0];
    if (!(p >= BAND[0] && p <= BAND[1])) continue;
    bets.push({
      id: m.id,
      event: String(ev.id),
      slug: ev.slug ?? "",
      eventTitle: ev.title ?? "",
      question: m.question,
      favorite: m.outcomes[0],
      bet: m.outcomes[1],
      p,
      volume: Math.round(m.volume),
      end,
      placedAt: now,
      outcome: null,
      roi: null,
    });
    known.add(m.id);
    added++;
  }
  await resolve(bets, now);
  const summary = summarize(bets);
  console.log(`${added} nouveaux paris fictifs, ${summary.pending} en attente, ${summary.n} réglés`);
  if (summary.n) {
    const p = (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`;
    console.log(
      `Résultat : ${summary.wins}/${summary.n} gagnés (attendu ${Math.round(summary.expectedWinRate * 100)}%), gain/pari ${p(summary.roi)}` +
        (summary.ci ? ` [${p(summary.ci[0])} ; ${p(summary.ci[1])}]` : "")
    );
  }
  bets.sort((a, b) => b.placedAt - a.placedAt);
  return {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? new Date(now).toISOString(),
    rule: RULE,
    summary,
    bets,
  };
}

const prev = await loadPrevious("strategy.json");
try {
  await writeData("strategy.json", await main(prev ?? {}));
} catch (err) {
  // Ne jamais perdre les paris déjà enregistrés
  console.log(`::warning::Test de la stratégie en échec : ${err.message}`);
  if (prev) await writeData("strategy.json", prev);
}
