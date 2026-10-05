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
import { brier, calibration, followSignals, groupOf, parseTime } from "./backtest-lib.mjs";
import { modelProbability, parseCryptoQuestion } from "./crypto-model.mjs";
import { getJSON, loadPrevious, mapLimit, writeData } from "./lib.mjs";

const DERIBIT = "https://www.deribit.com/api/v2/public";
const DAY = 86400000;
const HOUR = 3600000;
const LOOKBACK = 24 * HOUR; // on se place 24 h avant la fin
const MONTHS = 6; // profondeur de l'étude de calibration
const CRYPTO_MONTHS = 4;
const MAX_CALIB = 2500;
const MAX_CRYPTO = 2500;
const MIN_VOLUME = 5000;
const REFRESH_EVERY = 24 * HOUR;
const TIME_BUDGET = 12 * 60 * 1000; // on s'arrête proprement au bout de 12 min

const started = Date.now();
const outOfTime = () => Date.now() - started > TIME_BUDGET;
const NOISE = /\bup or down\b/i;

// ---------- Marchés terminés ----------

// Événements terminés, mois par mois, triés par volume
async function closedEvents({ months, pagesPerMonth, tag }) {
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
        question: m.question,
        eventTitle: ev.title ?? "",
        tags,
        group: groupOf(tags),
        tokenId: m.tokenId,
        outcome: w === 0 ? 1 : 0,
        ref,
        end: end ?? ref,
        volume: m.volume,
      });
    }
  }
  return out;
}

// Prix "Oui" d'un marché à un instant donné (dernier point connu avant)
async function priceAt(tokenId, ts) {
  const params = new URLSearchParams({
    market: tokenId,
    startTs: String(Math.floor((ts - 6 * HOUR) / 1000)),
    endTs: String(Math.floor(ts / 1000)),
    fidelity: "10",
  });
  const data = await getJSON(`${CLOB}/prices-history?${params}`, 2).catch(() => null);
  const pts = (data?.history ?? []).filter((x) => x.t * 1000 <= ts);
  return pts.length ? Number(pts[pts.length - 1].p) : null;
}

async function withPrices(markets, limit) {
  const list = markets.sort((a, b) => b.volume - a.volume).slice(0, limit);
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
  const events = await closedEvents({ months: MONTHS, pagesPerMonth: 3 });
  const markets = closedMarkets(events).filter((m) => m.volume >= MIN_VOLUME);
  console.log(`Calibration : ${events.length} événements, ${markets.length} marchés exploitables`);
  const samples = await withPrices(markets, MAX_CALIB);
  console.log(`Calibration : ${samples.length} marchés avec un prix 24 h avant`);

  const byGroup = {};
  for (const g of ["politique", "crypto", "sport", "eco", "autre"]) {
    const s = samples.filter((x) => x.group === g);
    if (s.length >= 30) byGroup[g] = { n: s.length, brier: brier(s), bins: calibration(s) };
  }
  return { n: samples.length, brier: brier(samples), bins: calibration(samples), byGroup };
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

  const priced = await withPrices(parsed, MAX_CRYPTO);
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
    samples.push({ id: m.id, kind: m.q.kind, asset: m.q.asset, p: m.p, model, outcome: m.outcome });
  }
  console.log(`Crypto : ${samples.length} marchés rejoués`);

  const byKind = {};
  for (const k of ["above", "below", "between", "touch"]) {
    const s = samples.filter((x) => x.kind === k);
    if (s.length >= 10)
      byKind[k] = { n: s.length, brierModel: brier(s, "model"), brierPoly: brier(s, "p"), signals: followSignals(s, 0.05) };
  }
  const thresholds = {};
  for (const t of [0.03, 0.05, 0.1, 0.15]) thresholds[t] = followSignals(samples, t);

  return {
    n: samples.length,
    brierModel: brier(samples, "model"),
    brierPoly: brier(samples, "p"),
    modelBins: calibration(samples.map((x) => ({ id: x.id, p: x.model, outcome: x.outcome }))),
    polyBins: calibration(samples),
    thresholds,
    byKind,
  };
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
  } catch (err) {
    console.log(`::warning::Backtest en échec : ${err.message}`);
    if (prev) await writeData("backtest.json", prev);
  }
}
