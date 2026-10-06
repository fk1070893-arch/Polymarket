// Backtest sur les marchés déjà terminés. Deux études :
//
//  1. Calibration de Polymarket : quand un marché affichait 10 % la veille
//     de sa fin, combien de fois l'issue s'est-elle vraiment produite ?
//     Par tranche de prix et par catégorie, avec le gain qu'aurait donné
//     l'achat systématique de « Oui » ou de « Non ».
//  2. Modèle crypto rejoué : pour chaque marché BTC/ETH terminé, ce
//     qu'aurait dit le modèle 24 h avant la fin (prix et volatilité DVOL
//     de Deribit à ce moment-là), comparé au prix Polymarket.
//
// Tous les prix sont pris 24 h AVANT la fin du marché, pour ne jamais
// utiliser une information qu'on n'aurait pas eue à l'époque.
// Chaque résultat est aussi calculé sur deux moitiés (A/B) tirées au sort :
// un effet qui n'apparaît que dans une moitié est probablement du hasard.
//
// Lourd (plusieurs milliers d'appels) : recalculé au plus une fois par jour,
// ou à la demande (BACKTEST_FORCE=true).

import { CLOB, GAMMA } from "../site/js/api.js";
import { normalizeMarket, winnerIndex } from "../site/js/normalize.js";
import { VOLUME_BUCKETS, brier, calibration, followSignals, groupOf, hashId, parseTime, volumeBucket } from "./backtest-lib.mjs";
import { modelProbability, parseCryptoQuestion } from "./crypto-model.mjs";
import { getJSON, loadPrevious, mapLimit, writeData } from "./lib.mjs";

const DERIBIT = "https://www.deribit.com/api/v2/public";
const DAY = 86400000;
const HOUR = 3600000;
const LOOKBACK = 24 * HOUR; // on se place 24 h avant la fin
const MONTHS = 6; // profondeur de l'étude de calibration
const CRYPTO_MONTHS = 4;
const MAX_PER_BUCKET = 700; // marchés par tranche de volume (calibration)
const MAX_CRYPTO_PER_BUCKET = 700;
const MIN_VOLUME = 1000; // en dessous, le prix ne veut plus dire grand-chose
const REFRESH_EVERY = 24 * HOUR;
const TIME_BUDGET = 12 * 60 * 1000; // on s'arrête proprement au bout de 12 min

const started = Date.now();
const outOfTime = () => Date.now() - started > TIME_BUDGET;
const NOISE = /\bup or down\b/i;

// ---------- Marchés terminés ----------

// Événements terminés, mois par mois, triés par volume
async function closedEvents({ months, pagesPerMonth, tag, extra = {} }) {
  const out = new Map();
  const now = Date.now();
  for (let m = 0; m < months; m++) {
    const max = new Date(now - m * 30 * DAY).toISOString();
    const min = new Date(now - (m + 1) * 30 * DAY).toISOString();
    for (let page = 0; page < pagesPerMonth; page++) {
      const params = new URLSearchParams({
        closed: "true",
        end_date_min: min,
        end_date_max: max,
        order: "volume",
        ascending: "false",
        limit: "100",
        offset: String(page * 100),
      });
      if (tag) params.set("tag_slug", tag);
      for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
      const batch = await getJSON(`${GAMMA}/events?${params}`).catch((err) => {
        console.log(`Événements terminés indisponibles (${err.message})`);
        return [];
      });
      for (const ev of batch) out.set(String(ev.id), ev);
      if (batch.length < 100) break;
    }
  }
  return [...out.values()];
}

// Marchés binaires terminés avec un gagnant clair + date de référence
function closedMarkets(rawEvents) {
  const out = [];
  for (const ev of rawEvents) {
    const tags = (ev.tags ?? []).map((t) => t.slug).filter(Boolean);
    for (const raw of ev.markets ?? []) {
      const m = normalizeMarket(raw);
      if (m.outcomes.length !== 2 || NOISE.test(m.question)) continue;
      const w = winnerIndex({ ...m, closed: raw.closed === true || m.closed });
      if (w == null || !m.tokenId) continue;
      const end = parseTime(raw.endDate) ?? parseTime(ev.endDate);
      const closed = parseTime(raw.closedTime);
      // Un marché peut se terminer avant sa date prévue (événement arrivé
      // plus tôt) : on prend la première des deux dates.
      const ref = Math.min(...[end, closed].filter((x) => x != null));
      const start = parseTime(raw.startDate) ?? parseTime(raw.createdAt) ?? parseTime(ev.startDate);
      if (!Number.isFinite(ref) || (start && ref - LOOKBACK < start)) continue;
      out.push({
        id: m.id,
        event: String(ev.id),
        question: m.question,
        eventTitle: ev.title ?? "",
        tags,
        group: groupOf(tags),
        tokenId: m.tokenId,
        outcome: w === 0 ? 1 : 0,
        ref,
        end: end ?? ref,
        volume: m.volume,
        bucket: volumeBucket(m.volume),
      });
    }
  }
  return out;
}

// Prix "Oui" d'un marché à un instant donné (dernier point connu avant)
async function priceAt(tokenId, ts) {
  const params = new URLSearchParams({
    market: tokenId,
    // Fenêtre large : sur un petit marché, le dernier échange peut dater
    startTs: String(Math.floor((ts - 48 * HOUR) / 1000)),
    endTs: String(Math.floor(ts / 1000)),
    fidelity: "10",
  });
  const data = await getJSON(`${CLOB}/prices-history?${params}`, 2).catch(() => null);
  const pts = (data?.history ?? []).filter((x) => x.t * 1000 <= ts);
  return pts.length ? Number(pts[pts.length - 1].p) : null;
}

// Au plus `perBucket` marchés par tranche de volume, tirés au hasard (de
// façon reproductible) pour ne pas favoriser les plus gros.
function sampleByBucket(markets, perBucket) {
  const key = (m) => hashId(`${m.id}:tirage`);
  const out = [];
  for (const b of VOLUME_BUCKETS) {
    const inBucket = markets.filter((m) => m.bucket === b.key).sort((x, y) => key(x) - key(y));
    out.push(...inBucket.slice(0, perBucket));
  }
  return out;
}

async function withPrices(list) {
  let done = 0;
  await mapLimit(list, 8, async (m) => {
    if (outOfTime()) return;
    m.p = await priceAt(m.tokenId, m.ref - LOOKBACK);
    if (++done % 250 === 0) console.log(`  ${done}/${list.length} prix historiques`);
  });
  return list.filter((m) => m.p != null && m.p > 0 && m.p < 1);
}

// ---------- Étude 1 : calibration ----------

async function calibrationStudy() {
  // Les plus gros événements, puis une requête par tranche de volume pour
  // avoir aussi des petits marchés
  const all = new Map();
  for (const ev of await closedEvents({ months: MONTHS, pagesPerMonth: 3 })) all.set(String(ev.id), ev);
  for (const b of VOLUME_BUCKETS) {
    const extra = { volume_min: b.min, ...(b.max < Infinity ? { volume_max: b.max } : {}) };
    for (const ev of await closedEvents({ months: MONTHS, pagesPerMonth: 2, extra })) all.set(String(ev.id), ev);
  }
  const events = [...all.values()];
  const markets = closedMarkets(events).filter((m) => m.volume >= MIN_VOLUME);
  const counts = VOLUME_BUCKETS.map((b) => `${b.key}: ${markets.filter((m) => m.bucket === b.key).length}`).join(", ");
  console.log(`Calibration : ${events.length} événements, ${markets.length} marchés exploitables (${counts})`);
  const samples = await withPrices(sampleByBucket(markets, MAX_PER_BUCKET));
  console.log(`Calibration : ${samples.length} marchés avec un prix 24 h avant`);

  const byGroup = {};
  for (const g of ["politique", "crypto", "sport", "eco", "autre"]) {
    const s = samples.filter((x) => x.group === g);
    if (s.length >= 30) byGroup[g] = { n: s.length, brier: brier(s), bins: calibration(s) };
  }
  const byVolume = {};
  for (const b of VOLUME_BUCKETS) {
    const s = samples.filter((x) => x.bucket === b.key);
    if (s.length >= 30) byVolume[b.key] = { n: s.length, brier: brier(s), bins: calibration(s) };
  }
  return { n: samples.length, events: new Set(samples.map((x) => x.event)).size, brier: brier(samples), bins: calibration(samples), byGroup, byVolume };
}

// ---------- Étude 2 : modèle crypto rejoué ----------

// Série horaire Deribit, par tranches de 30 jours
async function deribitSeries(path, params, from, to) {
  const points = new Map();
  for (let a = from; a < to; a += 30 * DAY) {
    const b = Math.min(to, a + 30 * DAY);
    const qs = new URLSearchParams({ ...params, start_timestamp: String(a), end_timestamp: String(b) });
    const data = await getJSON(`${DERIBIT}/${path}?${qs}`).catch((err) => {
      console.log(`Deribit ${path} indisponible (${err.message})`);
      return null;
    });
    const r = data?.result;
    if (Array.isArray(r?.data)) for (const [t, , , , c] of r.data) points.set(t, c); // DVOL : [t, o, h, l, c]
    if (Array.isArray(r?.ticks)) r.ticks.forEach((t, i) => points.set(t, r.close[i])); // chart data
  }
  return [...points.entries()].sort((x, y) => x[0] - y[0]);
}

function valueAt(series, ts) {
  let lo = 0;
  let hi = series.length - 1;
  if (hi < 0 || series[0][0] > ts) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= ts) lo = mid;
    else hi = mid - 1;
  }
  return ts - series[lo][0] < 6 * HOUR ? series[lo][1] : null;
}

async function cryptoStudy() {
  const now = Date.now();
  const from = now - CRYPTO_MONTHS * 30 * DAY - 2 * DAY;
  const market = {};
  for (const asset of ["BTC", "ETH"]) {
    const [spot, dvol] = await Promise.all([
      deribitSeries("get_tradingview_chart_data", { instrument_name: `${asset}-PERPETUAL`, resolution: "60" }, from, now),
      deribitSeries("get_volatility_index_data", { currency: asset, resolution: "3600" }, from, now),
    ]);
    console.log(`Crypto ${asset} : ${spot.length} prix horaires, ${dvol.length} points DVOL`);
    market[asset] = { spot, dvol };
  }

  const events = await closedEvents({ months: CRYPTO_MONTHS, pagesPerMonth: 4, tag: "crypto" });
  const parsed = [];
  for (const m of closedMarkets(events)) {
    const q = parseCryptoQuestion(m.question);
    if (q && market[q.asset]?.spot.length) parsed.push({ ...m, q });
  }
  console.log(`Crypto : ${events.length} événements, ${parsed.length} marchés de prix BTC/ETH`);

  const priced = await withPrices(sampleByBucket(parsed.filter((m) => m.volume >= MIN_VOLUME), MAX_CRYPTO_PER_BUCKET));
  const samples = [];
  for (const m of priced) {
    const t0 = m.ref - LOOKBACK;
    const { spot, dvol } = market[m.q.asset];
    const s = valueAt(spot, t0);
    const v = valueAt(dvol, t0);
    if (!s || !v) continue;
    const ref = m.q.strike ?? Math.sqrt(m.q.low * m.q.high);
    if (ref < s * 0.2 || ref > s * 5) continue;
    // Échéance du marché vue depuis t0 (la date prévue, pas la clôture réelle)
    const model = modelProbability(m.q, { spot: s, vol: () => v / 100, dateMs: m.end, nowMs: t0 });
    if (model == null || !Number.isFinite(model)) continue;
    samples.push({ id: m.id, event: m.event, kind: m.q.kind, asset: m.q.asset, bucket: m.bucket, p: m.p, model, outcome: m.outcome });
  }
  console.log(`Crypto : ${samples.length} marchés rejoués`);

  const byKind = {};
  for (const k of ["above", "below", "between", "touch"]) {
    const s = samples.filter((x) => x.kind === k);
    if (s.length >= 10)
      byKind[k] = { n: s.length, events: new Set(s.map((x) => x.event)).size, brierModel: brier(s, "model"), brierPoly: brier(s, "p"), signals: followSignals(s, 0.05) };
  }
  const byVolume = {};
  for (const b of VOLUME_BUCKETS) {
    const s = samples.filter((x) => x.bucket === b.key);
    if (s.length >= 10)
      byVolume[b.key] = { n: s.length, events: new Set(s.map((x) => x.event)).size, brierModel: brier(s, "model"), brierPoly: brier(s, "p"), signals: followSignals(s, 0.05) };
  }
  const thresholds = {};
  // Un pari par événement (la mesure honnête) ; et tous les signaux, pour comparer
  const thresholdsAll = {};
  for (const t of [0.03, 0.05, 0.1, 0.15]) {
    thresholds[t] = followSignals(samples, t);
    thresholdsAll[t] = followSignals(samples, t, { onePerEvent: false });
  }

  return {
    n: samples.length,
    brierModel: brier(samples, "model"),
    brierPoly: brier(samples, "p"),
    modelBins: calibration(samples.map((x) => ({ id: x.id, p: x.model, outcome: x.outcome }))),
    polyBins: calibration(samples),
    events: new Set(samples.map((x) => x.event)).size,
    thresholds,
    thresholdsAll,
    byKind,
    byVolume,
  };
}

// Résumé lisible dans les logs de l'Action
function logSummary(calib, crypto) {
  const p = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`);
  const ci = (c) => (c ? `[${p(c[0])} ; ${p(c[1])}]` : "[—]");
  const rows = (bins) =>
    bins
      .filter((b) => b.n > 0)
      .map(
        (b) =>
          `  ${Math.round(b.lo * 100)}-${Math.round(b.hi * 100)}% n=${b.n} év=${b.events} prix=${Math.round(b.avgPrice * 100)}% réel=${Math.round(b.freq * 100)}% ` +
          `Oui=${p(b.roiYes)} ${ci(b.ciYes)} (A ${p(b.A.roiYes)} / B ${p(b.B.roiYes)}) Non=${p(b.roiNo)} ${ci(b.ciNo)} (A ${p(b.A.roiNo)} / B ${p(b.B.roiNo)})`
      )
      .join("\n");
  console.log(`\n=== Calibration (${calib.n} marchés, ${calib.events} événements, Brier ${calib.brier?.toFixed(3)}) ===\n${rows(calib.bins)}`);
  for (const [g, r] of Object.entries(calib.byGroup)) console.log(`--- ${g} (${r.n}, Brier ${r.brier.toFixed(3)}) ---\n${rows(r.bins)}`);
  for (const [g, r] of Object.entries(calib.byVolume ?? {})) console.log(`--- volume ${g} (${r.n}, Brier ${r.brier.toFixed(3)}) ---\n${rows(r.bins)}`);
  if (crypto?.n) {
    console.log(`\n=== Modèle crypto (${crypto.n} marchés, ${crypto.events} événements) Brier modèle ${crypto.brierModel.toFixed(3)} / Polymarket ${crypto.brierPoly.toFixed(3)} ===`);
    for (const [t, r] of Object.entries(crypto.thresholds))
      console.log(
        `  écart ≥ ${Math.round(t * 100)} pts, 1 pari/événement : ${r.all.bets} paris, ${r.all.wins} gagnés, gain/pari ${p(r.all.roi)} ${ci(r.all.ci)} (A ${p(r.A.roi)} / B ${p(r.B.roi)})` +
          ` | tous les signaux : ${crypto.thresholdsAll[t].all.bets} paris, ${p(crypto.thresholdsAll[t].all.roi)}`
      );
    for (const [k, r] of Object.entries(crypto.byVolume ?? {}))
      console.log(`  volume ${k} : n=${r.n} (${r.events} év.) Brier modèle ${r.brierModel.toFixed(3)} / Polymarket ${r.brierPoly.toFixed(3)}, signaux ${r.signals.all.bets}, gain/pari ${p(r.signals.all.roi)} ${ci(r.signals.all.ci)}`);
    for (const [k, r] of Object.entries(crypto.byKind))
      console.log(`  ${k} : n=${r.n} (${r.events} év.) Brier modèle ${r.brierModel.toFixed(3)} / Polymarket ${r.brierPoly.toFixed(3)}, signaux ${r.signals.all.bets}, gain/pari ${p(r.signals.all.roi)} ${ci(r.signals.all.ci)} (A ${p(r.signals.A.roi)} / B ${p(r.signals.B.roi)})`);
  }
}

// ---------- Programme principal ----------

const prev = await loadPrevious("backtest.json");
const force = process.env.BACKTEST_FORCE === "true";
const age = prev?.updatedAt ? Date.now() - new Date(prev.updatedAt).getTime() : Infinity;

if (prev && !force && age < REFRESH_EVERY) {
  console.log(`Backtest récent (${Math.round(age / HOUR)} h) : republié tel quel`);
  await writeData("backtest.json", prev);
} else {
  try {
    const calib = await calibrationStudy();
    const crypto = outOfTime() ? null : await cryptoStudy();
    await writeData("backtest.json", {
      updatedAt: new Date().toISOString(),
      lookbackHours: LOOKBACK / HOUR,
      partial: outOfTime(),
      calibration: calib,
      crypto,
    });
    console.log(`Backtest terminé en ${Math.round((Date.now() - started) / 1000)} s`);
    logSummary(calib, crypto);
  } catch (err) {
    console.log(`::warning::Backtest en échec : ${err.message}`);
    if (prev) await writeData("backtest.json", prev);
  }
}
