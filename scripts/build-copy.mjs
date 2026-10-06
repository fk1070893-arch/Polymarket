// Test en direct : copier les paris suspects (alertes « initiés »).
//
// À chaque nouvelle alerte détectée par build-alerts.mjs, on achète
// fictivement 1 $ de la même issue, au prix vendeur du moment : c'est ce
// qu'on aurait vraiment payé en copiant le pari après l'avoir vu (le pari
// suspect, lui, a souvent déjà fait monter le prix). On note aussi le prix
// payé par le wallet suspect, pour voir ce que la copie fait perdre.
// Les paris sont réglés à la clôture du marché. Résultat : site/data/copy.json
//
// Usage : node scripts/build-copy.mjs (après build-alerts.mjs)

import { normalizeMarket } from "../site/js/normalize.js";
import { parseTime } from "./backtest-lib.mjs";
import { loadState, readData, writeState } from "./lib.mjs";
import { askPrices, fetchMarketsByCondition, paperStats, pnlCurve, roiAt, settleBets } from "./paper.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const FRESH = 2 * HOUR; // une alerte plus vieille arrive trop tard pour être copiée
const MIN_SCORE = 50;
const MAX_COST = 0.97; // au-delà, plus rien à gagner
const KEEP_FOR = 180 * DAY;

const RULE = {
  description:
    "À chaque alerte de score 50 ou plus, 1 $ fictif sur la même issue, au prix vendeur du moment où le site la détecte (au plus 2 h après le pari suspect). Un seul pari par marché et par issue.",
  minScore: MIN_SCORE,
};

const key = (conditionId, outcomeIndex) => `${conditionId}:${outcomeIndex}`;

async function main(prev, alerts) {
  const now = Date.now();
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR);
  const known = new Set(bets.map((b) => key(b.conditionId, b.side)));

  // Alertes récentes, la plus suspecte d'abord pour chaque marché / issue
  const fresh = alerts
    .filter((a) => a.score >= MIN_SCORE && a.conditionId && now - a.ts * 1000 < FRESH)
    .sort((a, b) => b.score - a.score)
    .filter((a) => {
      const k = key(a.conditionId, a.outcomeIndex);
      if (known.has(k)) return false;
      known.add(k);
      return true;
    });

  const rows = fresh.length ? await fetchMarketsByCondition(fresh.map((a) => a.conditionId)) : new Map();
  let added = 0;
  let skipped = 0;
  for (const a of fresh) {
    const raw = rows.get(a.conditionId);
    const m = raw ? normalizeMarket(raw) : null;
    if (!m || m.closed || m.outcomes.length !== 2) {
      skipped++;
      continue;
    }
    const cost = askPrices(raw)[a.outcomeIndex];
    if (cost == null || cost > MAX_COST) {
      skipped++;
      continue;
    }
    bets.push({
      id: a.id,
      marketId: m.id,
      conditionId: a.conditionId,
      event: raw.events?.[0]?.id != null ? String(raw.events[0].id) : a.eventSlug || m.id,
      eventTitle: a.eventTitle || "",
      question: m.question,
      side: a.outcomeIndex,
      outcome: a.outcome,
      score: a.score,
      small: a.small === true,
      insiderPrice: a.price,
      insiderCash: a.cash,
      cost,
      mid: m.prices[a.outcomeIndex] ?? null,
      end: parseTime(raw.endDate),
      placedAt: now,
      won: null,
      roi: null,
    });
    added++;
  }

  // Un marché peut finir avant sa date prévue : on vérifie tout ce qui est en attente
  await settleBets(bets, now, { graceMs: -Infinity });
  for (const b of bets) if (b.won != null && b.roiInsider == null) b.roiInsider = roiAt(b.insiderPrice, b.won);

  const settled = bets.filter((b) => b.won != null);
  const summary = {
    ...paperStats(settled),
    pending: bets.length - settled.length,
    insider: paperStats(settled.map((b) => ({ ...b, roi: b.roiInsider, roiMid: null }))),
    hot: paperStats(settled.filter((b) => b.score >= 70), { seed: 9 }),
    warm: paperStats(settled.filter((b) => b.score < 70), { seed: 13 }),
    small: paperStats(settled.filter((b) => b.small), { seed: 17 }),
    curve: pnlCurve(settled),
  };
  console.log(`${fresh.length} alertes à copier : ${added} paris fictifs, ${skipped} ignorées (marché fermé ou sans prix)`);
  console.log(`${summary.pending} en attente, ${summary.n ?? 0} réglés`);
  if (summary.n) {
    const p = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`);
    console.log(
      `Copie : ${summary.wins}/${summary.n} gagnés, gain/pari ${p(summary.roi)}${summary.ci ? ` [${p(summary.ci[0])} ; ${p(summary.ci[1])}]` : ""}` +
        ` | au prix du wallet suspect ${p(summary.insider.roi)} | score 70+ ${p(summary.hot.roi)} (${summary.hot.n ?? 0})`
    );
  }
  bets.sort((a, b) => b.placedAt - a.placedAt);
  const base = {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? new Date(now).toISOString(),
    rule: RULE,
    summary,
  };
  return { state: { ...base, bets }, view: { ...base, bets: bets.slice(0, 30) } };
}

const prev = await loadState("copy");
try {
  const { alerts } = await readData("alerts.json");
  const { state, view } = await main(prev ?? {}, alerts ?? []);
  await writeState("copy", state, view);
} catch (err) {
  console.log(`::warning::Test « copier les alertes » en échec : ${err.message}`);
  if (prev) await writeState("copy", prev, { ...prev, bets: (prev.bets ?? []).slice(0, 30) });
}
