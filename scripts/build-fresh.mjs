// Test en direct : contre les marchés tout neufs cotés autour de 50 %.
//
// Le backtest trouve que les marchés affichés 40-60 % six heures après leur
// ouverture se réalisent bien moins souvent que ça. Soupçon : c'est un prix
// « fantôme » (50 % par défaut, faute d'échanges), impossible à obtenir en
// vrai. On le vérifie : pour chaque marché de 5 à 7 h coté 40-60 %, on note
// le vrai prix d'achat du « Non » dans le carnet d'ordres et on parie
// fictivement 1 $ à ce prix. S'il n'y a pas de vendeur, on le compte aussi :
// c'est la preuve directe du prix fantôme. Résultat : site/data/fresh.json
//
// Usage : node scripts/build-fresh.mjs

import { GAMMA } from "../site/js/api.js";
import { normalizeMarket } from "../site/js/normalize.js";
import { parseTime } from "./backtest-lib.mjs";
import { getJSON, loadPrevious, writeData } from "./lib.mjs";
import { askPrices, median, paperStats, settleBets, spreadOf } from "./paper.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const AGE = [5 * HOUR, 7 * HOUR]; // âge du marché au moment du pari
const BAND = [0.4, 0.6]; // prix « Oui » affiché
const MIN_LIFE = 3 * DAY; // comme dans le backtest : marchés d'au moins 3 jours
const MIN_VOLUME = 1000; // volume final, vérifié à la clôture comme dans le backtest
const KEEP_FOR = 180 * DAY;
const NOISE = /\bup or down\b/i;

const RULE = {
  description:
    "Marchés de 5 à 7 h, prévus pour durer au moins 3 jours, dont le « Oui » est affiché entre 40 et 60 % : 1 $ fictif sur « Non » au vrai prix vendeur du carnet d'ordres. Résultat compté sur les marchés finis avec au moins 1 000 $ de volume, comme dans le backtest.",
};

async function youngMarkets(now) {
  const out = new Map();
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      start_date_min: new Date(now - AGE[1] - HOUR).toISOString(),
      start_date_max: new Date(now - AGE[0] + HOUR).toISOString(),
      limit: "100",
      offset: String(page * 100),
    });
    const batch = await getJSON(`${GAMMA}/markets?${params}`);
    for (const r of batch) out.set(String(r.id), r);
    if (batch.length < 100) break;
  }
  return [...out.values()];
}

async function main(prev) {
  const now = Date.now();
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR);
  const known = new Set([...bets.map((b) => b.marketId), ...(prev.skipped ?? []).map((s) => s.marketId)]);
  const skipped = (prev.skipped ?? []).filter((s) => now - s.seenAt < 30 * DAY);
  const seen = { markets: 0, age: 0, band: 0, quoted: 0, noQuote: 0 };

  for (const raw of await youngMarkets(now)) {
    seen.markets++;
    const m = normalizeMarket(raw);
    const start = parseTime(raw.startDate) ?? parseTime(raw.createdAt);
    const end = parseTime(raw.endDate);
    if (!start || !end || m.closed || m.outcomes.length !== 2 || NOISE.test(m.question)) continue;
    const age = now - start;
    if (age < AGE[0] || age > AGE[1] || end - start < MIN_LIFE) continue;
    seen.age++;
    const p = m.prices[0];
    if (!(p >= BAND[0] && p <= BAND[1]) || known.has(m.id)) continue;
    seen.band++;
    known.add(m.id);
    const ev = raw.events?.[0];
    const info = {
      marketId: m.id,
      event: ev?.id != null ? String(ev.id) : m.id,
      eventTitle: ev?.title ?? "",
      slug: ev?.slug ?? "",
      question: m.question,
      p,
      // Événement à plusieurs issues exclusives : suspect n°1 du prix fantôme
      multi: raw.negRisk === true,
      spread: spreadOf(raw),
    };
    const cost = askPrices(raw)[1];
    if (cost == null) {
      seen.noQuote++;
      skipped.push({ ...info, seenAt: now });
      continue;
    }
    seen.quoted++;
    bets.push({ ...info, id: m.id, side: 1, mid: 1 - p, cost, end, placedAt: now, won: null, roi: null });
  }
  console.log(
    `Filtres : ${seen.markets} marchés récents, ${seen.age} de 5-7 h prévus pour 3 jours ou plus, ${seen.band} cotés 40-60 % : ` +
      `${seen.quoted} avec un vendeur de « Non », ${seen.noQuote} sans aucun vendeur`
  );

  // Les marchés peuvent se régler avant leur date prévue : tout ce qui est
  // en attente est revérifié une fois par heure
  await settleBets(bets, now, { graceMs: new Date(now).getUTCMinutes() < 5 ? -Infinity : HOUR });

  const settled = bets.filter((b) => b.won != null);
  const done = settled.filter((b) => (b.finalVolume ?? 0) >= MIN_VOLUME);
  // Ce qu'on a vraiment payé, comparé au prix affiché
  const premium = bets.map((b) => b.cost - b.mid).filter(Number.isFinite);
  const summary = {
    ...paperStats(done),
    pending: bets.length - settled.length,
    lowVolume: settled.length - done.length,
    all: paperStats(settled),
    multi: paperStats(done.filter((b) => b.multi), { seed: 21 }),
    single: paperStats(done.filter((b) => !b.multi), { seed: 23 }),
    quoted: bets.length,
    noQuote: skipped.length,
    medianCost: median(bets.map((b) => b.cost)),
    medianPremium: median(premium),
  };
  const pc = (v) => (v == null ? "—" : `${Math.round(v * 100)}`);
  console.log(
    `${bets.length} paris (${summary.pending} en attente, ${summary.n ?? 0} réglés), ${skipped.length} marchés sans vendeur ; ` +
      `prix payé médian ${pc(summary.medianCost)} ¢, soit ${pc(summary.medianPremium)} ¢ de plus que le prix affiché`
  );

  bets.sort((a, b) => b.placedAt - a.placedAt);
  return {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? new Date(now).toISOString(),
    rule: RULE,
    summary,
    bets,
    skipped: skipped.slice(-500),
  };
}

const prev = await loadPrevious("fresh.json");
try {
  await writeData("fresh.json", await main(prev ?? {}));
} catch (err) {
  console.log(`::warning::Test « marchés neufs » en échec : ${err.message}`);
  if (prev) await writeData("fresh.json", prev);
}
