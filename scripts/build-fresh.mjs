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
import { getJSON, loadState, universeEvents, writeState } from "./lib.mjs";
import { askPrices, paperStats, pnlCurve, settleBets, spreadOf } from "./paper.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const AGE = [5 * HOUR, 7 * HOUR]; // âge du marché au moment du pari
const BAND = [0.4, 0.6]; // prix « Oui » affiché
const MIN_LIFE = 3 * DAY; // comme dans le backtest : marchés d'au moins 3 jours
const MIN_VOLUME = 1000; // volume final, vérifié à la clôture comme dans le backtest
const MAX_COST = 0.7; // au-delà, le « Non » coûte bien plus que le prix affiché : prix fantôme
const KEEP_FOR = 180 * DAY;
const NOISE = /\bup or down\b/i;

const RULE = {
  description:
    "Marchés de 5 à 7 h, prévus pour durer au moins 3 jours, dont le « Oui » est affiché entre 40 et 60 % : 1 $ fictif sur « Non » au vrai prix vendeur du carnet d'ordres, seulement s'il est de 70 ¢ ou moins (sinon le prix affiché est un prix fantôme). Résultat compté sur les marchés finis avec au moins 1 000 $ de volume, comme dans le backtest.",
};


// Marchés bruts d'une page Gamma ; les événements sont dépliés en marchés
// (en leur rattachant l'événement, comme le fait /markets)
async function page(kind, params, offset) {
  const qs = new URLSearchParams({ active: "true", closed: "false", limit: "100", offset: String(offset), ...params });
  const rows = await getJSON(`${GAMMA}/${kind}?${qs}`);
  const markets = kind === "events" ? rows.flatMap((ev) => (ev.markets ?? []).map((m) => ({ ...m, events: [ev] }))) : rows;
  // Âge de chaque ligne, dans l'ordre du tri (l'événement lui-même, pas ses marchés)
  const created = (r) => parseTime(r.createdAt) ?? parseTime(r.startDate);
  const ages = rows.map((r) => (created(r) != null ? Date.now() - created(r) : Infinity));
  return { markets, ages, n: rows.length };
}

// L'API ne documente pas bien le tri par date de création : on essaie
// plusieurs façons et on garde la première qui renvoie des marchés récents.
// Les événements d'abord : ils regroupent les marchés et respectent le
// filtre de date de fin.
const QUERIES = [
  ["events", { order: "createdAt", ascending: "false" }],
  ["events", { order: "startDate", ascending: "false" }],
  ["markets", { order: "createdAt", ascending: "false" }],
];

async function youngMarkets(now) {
  // Lecture partagée du début du passage : les événements créés il y a moins de 8 h
  const shared = await universeEvents((ev) => {
    const created = parseTime(ev.createdAt) ?? parseTime(ev.startDate);
    return created != null && now - created <= AGE[1] + HOUR;
  });
  if (shared) {
    console.log(`  ${shared.length} événements récents (lecture partagée du début du passage)`);
    return shared.flatMap((ev) => (ev.markets ?? []).map((m) => ({ ...m, events: [ev] })));
  }
  // Des centaines de marchés courts (crypto au quart d'heure, matchs du jour)
  // sont créés chaque heure : on ne demande que ceux qui finissent dans plus
  // de 2,5 jours, sinon on n'atteint jamais les marchés de 5-7 h
  const longOnly = { end_date_min: new Date(now + MIN_LIFE - 12 * HOUR).toISOString() };
  for (const [kind, base] of QUERIES) {
    const params = { ...base, ...longOnly };
    const label = `${kind} trié par ${params.order}`;
    const first = await page(kind, params, 0).catch((err) => {
      console.log(`  ${label} : erreur (${err.message})`);
      return null;
    });
    if (!first?.markets.length) continue;
    const youngest = Math.min(...first.ages);
    console.log(`  ${label} : marché le plus récent ouvert il y a ${Math.round(youngest / 60000)} min`);
    if (youngest > AGE[1]) continue;
    // Tri du plus récent au plus ancien : on s'arrête une fois passé 7 h
    const out = new Map();
    let cur = first;
    let oldestSeen = 0;
    // L'API refuse d'aller au-delà de 2 000 résultats
    for (let offset = 0; offset < 1900; ) {
      for (const r of cur.markets) out.set(String(r.id), r);
      const oldest = Math.max(...cur.ages.filter(Number.isFinite), 0);
      oldestSeen = Math.max(oldestSeen, oldest);
      if (cur.n < 100 || oldest > AGE[1] + HOUR) break;
      offset += 100;
      cur = await page(kind, params, offset).catch(() => null);
      if (!cur?.markets.length) break;
    }
    console.log(`  → ${label} retenu, ${out.size} marchés lus, jusqu'à ${Math.round(oldestSeen / 60000)} min d'âge`);
    return [...out.values()];
  }
  console.log("Aucune requête ne renvoie de marchés récents");
  return [];
}

// Prix réellement payé pour le « Non », par tranche
const COST_BUCKETS = [
  { key: "none", label: "aucun vendeur" },
  { key: "le60", label: "60 ¢ ou moins", max: 0.6 },
  { key: "le70", label: "61 à 70 ¢", max: 0.7 },
  { key: "le90", label: "71 à 90 ¢", max: 0.9 },
  { key: "le97", label: "91 à 97 ¢", max: 0.97 },
  { key: "gt97", label: "plus de 97 ¢", max: Infinity },
];
const costBucket = (cost) => (cost == null ? "none" : COST_BUCKETS.find((x) => x.max != null && cost <= x.max).key);

async function main(prev) {
  const now = Date.now();
  // Premier passage (avant le seuil de prix) : on garde les chiffres, pas
  // les milliers de paris à 99 ¢
  const counts = prev.counts ?? Object.fromEntries(COST_BUCKETS.map((x) => [x.key, 0]));
  const seenIds = prev.seenIds ?? {};
  if (!prev.counts && prev.bets) {
    for (const b of prev.bets) {
      counts[costBucket(b.cost)]++;
      seenIds[b.marketId] = b.placedAt;
    }
    for (const x of prev.skipped ?? []) {
      counts.none++;
      seenIds[x.marketId] = x.seenAt;
    }
  }
  for (const [id, t] of Object.entries(seenIds)) if (now - t > 12 * HOUR) delete seenIds[id];
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR && b.cost <= MAX_COST);
  const seen = { markets: 0, age: 0, band: 0, bet: 0 };

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
    if (!(p >= BAND[0] && p <= BAND[1]) || seenIds[m.id]) continue;
    seen.band++;
    seenIds[m.id] = now;
    const cost = askPrices(raw)[1];
    counts[costBucket(cost)]++;
    // Prix fantôme : pas de vendeur, ou un « Non » bien plus cher qu'affiché
    if (cost == null || cost > MAX_COST) continue;
    seen.bet++;
    const ev = raw.events?.[0];
    bets.push({
      id: m.id,
      marketId: m.id,
      event: ev?.id != null ? String(ev.id) : m.id,
      eventTitle: ev?.title ?? "",
      slug: ev?.slug ?? "",
      question: m.question,
      p,
      // Événement à plusieurs issues exclusives
      multi: raw.negRisk === true,
      spread: spreadOf(raw),
      side: 1,
      mid: 1 - p,
      cost,
      end,
      placedAt: now,
      won: null,
      roi: null,
    });
  }
  console.log(
    `Filtres : ${seen.markets} marchés récents, ${seen.age} de 5-7 h prévus pour 3 jours ou plus, ${seen.band} nouveaux cotés 40-60 %, ` +
      `${seen.bet} avec un vrai prix (« Non » à ${MAX_COST * 100} ¢ ou moins)`
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Depuis le début : ${total} marchés, prix du « Non » : ${COST_BUCKETS.map((x) => `${x.label} ${counts[x.key]}`).join(", ")}`);

  // Les marchés peuvent se régler avant leur date prévue : tout ce qui est
  // en attente est revérifié une fois par heure
  await settleBets(bets, now, { graceMs: new Date(now).getUTCMinutes() < 5 ? -Infinity : HOUR });

  const settled = bets.filter((b) => b.won != null);
  const done = settled.filter((b) => (b.finalVolume ?? 0) >= MIN_VOLUME);
  const summary = {
    ...paperStats(done),
    pending: bets.length - settled.length,
    lowVolume: settled.length - done.length,
    all: paperStats(settled),
    multi: paperStats(done.filter((b) => b.multi), { seed: 21 }),
    single: paperStats(done.filter((b) => !b.multi), { seed: 23 }),
    total,
    counts: COST_BUCKETS.map((x) => ({ ...x, max: undefined, n: counts[x.key] })),
    curve: pnlCurve(done),
  };
  console.log(`${bets.length} paris (${summary.pending} en attente, ${summary.n ?? 0} réglés)`);

  bets.sort((a, b) => b.placedAt - a.placedAt);
  const base = {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? new Date(now).toISOString(),
    rule: RULE,
    summary,
  };
  return { state: { ...base, bets, counts, seenIds }, view: { ...base, bets: bets.slice(0, 30) } };
}

const prev = await loadState("fresh");
try {
  const { state, view } = await main(prev ?? {});
  await writeState("fresh", state, view);
} catch (err) {
  console.log(`::warning::Test « marchés neufs » en échec : ${err.message}`);
  if (prev) await writeState("fresh", prev, { ...prev, bets: (prev.bets ?? []).slice(0, 30), seenIds: undefined });
}
