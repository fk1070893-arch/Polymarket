// Test en direct ("forward test") de la stratégie trouvée par le backtest :
// en sport, les favoris cotés 60-90 % la veille gagnent moins souvent que
// leur prix ne le dit. On parie donc (fictivement) 1 $ contre eux.
//
// La règle reprend exactement celle du backtest :
//  - marchés sport à deux issues ;
//  - 24 h (± 4 h) avant la date de fin prévue ;
//  - si la première issue est cotée entre 60 % et 90 %, on achète l'autre.
// Les paris sont enregistrés au moment où ils auraient été pris, puis réglés
// à la clôture, au prix réellement payé (le meilleur prix vendeur du moment,
// pas le prix affiché), avec le gain au prix affiché à côté pour comparer.
// Le backtest ne gardait que les marchés ayant fini avec au
// moins 1 000 $ de volume ; ce volume final n'est pas connu au moment de
// parier (l'essentiel des échanges a lieu dans les dernières heures). On
// parie donc sans filtre de volume, on note le volume final à la clôture,
// et le résultat principal ne compte que les marchés comparables au
// backtest (volume final ≥ 1 000 $). Le résultat sur tous les marchés est
// gardé à côté. Ces marchés n'ont jamais été vus par le backtest : c'est le
// vrai test. Résultat : site/data/strategy.json
//
// Trois raffinements, suivis côte à côte sur les mêmes marchés :
//  - deux moments : 24 h avant la fin (la règle du backtest) et 2-6 h avant
//    (plus de volume, écart achat-vente plus serré) ;
//  - un prix plafond : le backtest dit ce que vaut vraiment le « Non » d'un
//    favori coté p (1 − fréquence réelle de victoire du favori) ; un pari
//    « à bon prix » est un pari acheté au moins 3 ¢ sous cette valeur ;
//  - l'avis des bookmakers (si la comparaison est active) : le favori
//    est-il plus cher sur Polymarket que chez Pinnacle ?
//
// Usage : node scripts/build-strategy.mjs

import { normalizeMarket } from "../site/js/normalize.js";
import { groupOf, parseTime } from "./backtest-lib.mjs";
import { allEventsBetween, loadPrevious, loadState, writeState } from "./lib.mjs";
import { askPrices, median, paperStats, pnlCurve, settleBets, spreadOf } from "./paper.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
// Temps restant avant la fin prévue, pour chaque variante
const WINDOWS = { "24h": [20 * HOUR, 28 * HOUR], "4h": [2 * HOUR, 6 * HOUR] };
const MARGIN = 0.03; // prix plafond : au moins 3 ¢ sous la valeur estimée
const OVERPRICED = 0.02; // favori plus cher que chez les bookmakers d'au moins 2 pts
const BOOK_MAX_AGE = 6 * HOUR;
const BAND = [0.6, 0.9]; // cote du favori (première issue)
const MIN_VOLUME = 1000;
const KEEP_FOR = 180 * DAY;
const NOISE = /\bup or down\b/i;

const RULE = {
  description:
    "Sport, deux issues, 24 h (ou 2-6 h) avant la fin prévue : si la première issue est cotée 60-90 %, 1 $ fictif sur l'autre issue. « À bon prix » : seulement si on l'achète au moins 3 ¢ sous la valeur estimée par le backtest. Résultat compté sur les marchés finis avec au moins 1 000 $ de volume, comme dans le backtest.",
  band: BAND,
  margin: MARGIN,
  minVolume: MIN_VOLUME,
};

// Marchés sport qui se terminent dans la fenêtre
async function candidates(now, key) {
  const WINDOW = WINDOWS[key];
  const out = [];
  // Décompte de chaque filtre, pour vérifier dans les logs que la règle
  // trouve bien des marchés
  const seen = { events: 0, sport: 0, binary: 0, volume: 0, window: 0, quoted: 0 };
  const events = await allEventsBetween(
    { tag_slug: "sports", active: "true", closed: "false" },
    now + WINDOW[0] - 6 * HOUR,
    now + WINDOW[1] + 6 * HOUR
  );
  for (const ev of events) {
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
      if (askPrices(raw)[1] != null) seen.quoted++;
      out.push({ ev, raw, m, end });
    }
  }
  console.log(
    `Filtres : ${seen.events} événements, ${seen.sport} sport, ${seen.binary} marchés à deux issues, ` +
      `${seen.volume} déjà à 1 000 $ de volume, ${seen.window} dans la fenêtre ${key} (${seen.quoted} avec un prix vendeur)`
  );
  return out;
}

// Anciens paris (avant le prix payé) : on garde leur résultat au prix affiché
function migrate(b) {
  if (b.side != null) return b;
  const out = { ...b, side: 1, mid: 1 - b.p, cost: null };
  if (b.outcome != null) {
    out.won = b.outcome === 0;
    out.roiMid = b.roi;
    out.roi = null;
  }
  delete out.outcome;
  return out;
}

// Valeur du « Non » selon le backtest sport : 1 − fréquence réelle de
// victoire des favoris de la même tranche de prix (tranches d'au moins 30
// marchés seulement)
// Pour les paris proches du match, on prend l'étude du backtest faite au
// même moment (6 h avant) : le biais n'y a pas la même taille.
function fairValues(backtest, key = "24h") {
  const bins = (key === "4h" ? backtest?.sportTiming?.["6h"]?.bins : null) ?? backtest?.calibration?.byGroup?.sport?.bins ?? [];
  return bins.filter((b) => b.n >= 30 && b.freq != null).map((b) => ({ lo: b.lo, hi: b.hi, fairNo: 1 - b.freq }));
}

function capFor(fair, p) {
  const bin = fair.find((b) => p >= b.lo && p < b.hi);
  return bin ? Math.round((bin.fairNo - MARGIN) * 1000) / 1000 : null;
}

function variantSummary(bets) {
  const settled = bets.filter((b) => b.won != null);
  // Même population que le backtest : volume final d'au moins 1 000 $
  const done = settled.filter((b) => (b.finalVolume ?? 0) >= MIN_VOLUME);
  const bands = [
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
  ].map(([lo, hi]) => ({ lo, hi, ...paperStats(done.filter((b) => b.p >= lo && b.p < hi)) }));
  const withBook = done.filter((b) => b.book != null);
  return {
    ...paperStats(done),
    total: bets.length,
    pending: bets.length - settled.length,
    lowVolume: settled.length - done.length,
    all: paperStats(settled),
    bands,
    value: { ...paperStats(done.filter((b) => b.value), { seed: 31 }), total: bets.filter((b) => b.value).length },
    overpriced: paperStats(withBook.filter((b) => b.overpriced), { seed: 37 }),
    fairlyPriced: paperStats(withBook.filter((b) => !b.overpriced), { seed: 41 }),
    withBook: bets.filter((b) => b.book != null).length,
    medianSpread: median(bets.map((b) => b.spread).filter((v) => v != null)),
    curve: pnlCurve(done),
    valueCurve: pnlCurve(done.filter((b) => b.value)),
  };
}

async function main(prev) {
  const now = Date.now();
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR).map(migrate);
  const known = new Set(bets.map((b) => b.id));
  const backtest = await loadPrevious("backtest.json");
  const fairBy = Object.fromEntries(Object.keys(WINDOWS).map((k) => [k, fairValues(backtest, k)]));
  const fair = fairBy["24h"];
  // Probabilités des bookmakers, publiées par build-odds.mjs au passage précédent
  const book = (await loadPrevious("odds.json"))?.bookByMarket ?? {};
  console.log(`Prix plafond : ${fair.length ? fair.map((b) => `${Math.round(b.lo * 100)}-${Math.round(b.hi * 100)}% → Non vaut ${Math.round(b.fairNo * 100)} ¢`).join(", ") : "backtest indisponible"}`);

  const added = {};
  for (const key of Object.keys(WINDOWS)) {
    added[key] = 0;
    for (const { ev, raw, m, end } of await candidates(now, key)) {
      // Les paris de la règle d'origine gardent l'identifiant du marché
      const id = key === "24h" ? m.id : `${m.id}:${key}`;
      if (known.has(id)) continue;
      const p = m.prices[0];
      if (!(p >= BAND[0] && p <= BAND[1])) continue;
      const cost = askPrices(raw)[1];
      const cap = capFor(fairBy[key], p);
      const b = book[m.id];
      const bookP = b && now - b[2] < BOOK_MAX_AGE ? b[0] : null;
      bets.push({
        id,
        marketId: m.id,
        when: key,
        event: String(ev.id),
        slug: ev.slug ?? "",
        eventTitle: ev.title ?? "",
        question: m.question,
        favorite: m.outcomes[0],
        bet: m.outcomes[1],
        p,
        side: 1,
        mid: 1 - p,
        // Prix réellement payé pour l'autre issue (null si pas d'offre)
        cost,
        cap,
        value: cost != null && cap != null && cost <= cap,
        book: bookP,
        overpriced: bookP != null ? p - bookP >= OVERPRICED : null,
        spread: spreadOf(raw),
        volume: Math.round(m.volume),
        end,
        placedAt: now,
        won: null,
        roi: null,
      });
      known.add(id);
      added[key]++;
    }
  }
  await settleBets(bets, now);

  const variants = {};
  for (const key of Object.keys(WINDOWS)) variants[key] = variantSummary(bets.filter((b) => (b.when ?? "24h") === key));
  const pc = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`);
  for (const [key, v] of Object.entries(variants)) {
    console.log(
      `[${key}] ${added[key]} nouveaux paris, ${v.pending} en attente, ${v.n ?? 0} réglés, gain/pari ${pc(v.roi)} ; ` +
        `à bon prix : ${v.value.total} paris, ${v.value.n ?? 0} réglés, ${pc(v.value.roi)} ; ` +
        `écart médian ${v.medianSpread == null ? "—" : (v.medianSpread * 100).toFixed(1) + " pts"} ; avec cotes bookmakers : ${v.withBook}`
    );
  }

  bets.sort((a, b) => b.placedAt - a.placedAt);
  const base = {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? new Date(now).toISOString(),
    rule: RULE,
    fair,
    fairBy,
    // La règle d'origine reste le résumé principal
    summary: variants["24h"],
    variants,
  };
  return { state: { ...base, bets }, view: { ...base, bets: bets.slice(0, 30) } };
}

const prev = await loadState("strategy");
try {
  const { state, view } = await main(prev ?? {});
  await writeState("strategy", state, view);
} catch (err) {
  // Ne jamais perdre les paris déjà enregistrés
  console.log(`::warning::Test de la stratégie en échec : ${err.message}`);
  if (prev) await writeState("strategy", prev, { ...prev, bets: (prev.bets ?? []).slice(0, 30) });
}
