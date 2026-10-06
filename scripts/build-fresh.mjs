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

const ageOf = (raw, now) => now - (parseTime(raw.startDate) ?? parseTime(raw.createdAt) ?? now);

// Marchés bruts d'une page Gamma ; les événements sont dépliés en marchés
// (en leur rattachant l'événement, comme le fait /markets)
async function page(kind, params, offset) {
  const qs = new URLSearchParams({ active: "true", closed: "false", limit: "100", offset: String(offset), ...params });
  const rows = await getJSON(`${GAMMA}/${kind}?${qs}`);
  const markets = kind === "events" ? rows.flatMap((ev) => (ev.markets ?? []).map((m) => ({ ...m, events: [ev] }))) : rows;
  return { markets, n: rows.length };
}

// L'API ne documente pas bien le tri par date de création : on essaie
// plusieurs façons et on garde la première qui renvoie des marchés récents.
const QUERIES = [
  ["markets", { order: "createdAt", ascending: "false" }],
  ["markets", { order: "startDate", ascending: "false" }],
  ["events", { order: "createdAt", ascending: "false" }],
  ["events", { order: "startDate", ascending: "false" }],
];

async function youngMarkets(now) {
  for (const [kind, params] of QUERIES) {
    const label = `${kind} trié par ${params.order}`;
    const first = await page(kind, params, 0).catch((err) => {
      console.log(`  ${label} : erreur (${err.message})`);
      return null;
    });
    if (!first?.markets.length) continue;
    const youngest = Math.min(...first.markets.map((r) => ageOf(r, now)));
    console.log(`  ${label} : marché le plus récent ouvert il y a ${Math.round(youngest / 60000)} min`);
    if (youngest > AGE[1]) continue;
    // Tri du plus récent au plus ancien : on s'arrête une fois passé 7 h
    const out = new Map();
    let cur = first;
    for (let offset = 0; offset < 1000; ) {
      for (const r of cur.markets) out.set(String(r.id), r);
      const oldest = Math.max(...cur.markets.map((r) => ageOf(r, now)));
      if (cur.n < 100 || oldest > AGE[1] + HOUR) break;
      offset += 100;
      cur = await page(kind, params, offset);
    }
    console.log(`  → ${label} retenu, ${out.size} marchés lus`);
    return [...out.values()];
  }
  console.log("Aucune requête ne renvoie de marchés récents");
  return [];
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
