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
import { isDeadline, parseUpDown, probUp } from "./niche-lib.mjs";
import { getJSON, loadPrevious, mapLimit, writeData } from "./lib.mjs";
import { feeParams, median, spreadOf } from "./paper.mjs";

const DERIBIT = "https://www.deribit.com/api/v2/public";
const DAY = 86400000;
const HOUR = 3600000;
const LOOKBACK = 24 * HOUR; // on se place 24 h avant la fin
const MONTHS = 6; // profondeur de l'étude de calibration
const CRYPTO_MONTHS = 4;
const MAX_PER_BUCKET = 1500; // marchés par tranche de volume (calibration)
const MAX_CRYPTO_PER_BUCKET = 700;
const MIN_VOLUME = 1000; // en dessous, le prix ne veut plus dire grand-chose
// Une fois par semaine, sur un échantillon plus large (marges d'erreur plus serrées)
const REFRESH_EVERY = 7 * 24 * HOUR;
const TIME_BUDGET = 16 * 60 * 1000; // on s'arrête proprement au bout de 16 min
const MAX_NICHE_PER_BUCKET = 300; // études de niche : marchés par tranche de volume

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

// Marchés binaires terminés avec un gagnant clair, avec leurs dates
// (création, fin prévue, clôture réelle)
function resolvedMarkets(rawEvents) {
  const out = [];
  for (const ev of rawEvents) {
    const tags = (ev.tags ?? []).map((t) => t.slug).filter(Boolean);
    for (const raw of ev.markets ?? []) {
      const m = normalizeMarket(raw);
      if (m.outcomes.length !== 2 || NOISE.test(m.question)) continue;
      const w = winnerIndex({ ...m, closed: raw.closed === true || m.closed });
      if (w == null || !m.tokenId) continue;
      const end = parseTime(raw.endDate) ?? parseTime(ev.endDate);
      if (!Number.isFinite(end)) continue;
      out.push({
        id: m.id,
        event: String(ev.id),
        question: m.question,
        eventTitle: ev.title ?? "",
        tags,
        group: groupOf(tags),
        tokenId: m.tokenId,
        outcome: w === 0 ? 1 : 0,
        ref: end,
        end,
        start: parseTime(raw.startDate) ?? parseTime(raw.createdAt) ?? parseTime(ev.startDate),
        closedAt: parseTime(raw.closedTime),
        volume: m.volume,
        bucket: volumeBucket(m.volume),
        fee: feeParams(raw),
      });
    }
  }
  return out;
}

// Un marché est jouable à l'instant t0 s'il existait déjà et n'était pas
// encore clôturé. On se place toujours par rapport à la date de fin PRÉVUE,
// jamais la clôture réelle : pour un marché terminé en avance (« BTC a
// touché 130k le 12 »), elle dépend du résultat, et se placer « la veille de
// la clôture » reviendrait à regarder toujours la veille du succès. Les
// marchés déjà clôturés à t0 sont écartés : ça, on l'aurait su en vrai.
function openAt(m, t0) {
  return t0 < m.end && !(m.start && t0 < m.start) && !(m.closedAt != null && m.closedAt <= t0);
}

// Marchés jouables 24 h avant leur fin prévue
function closedMarkets(rawEvents) {
  return resolvedMarkets(rawEvents).filter((m) => openAt(m, m.ref - LOOKBACK));
}

// Prix "Oui" d'un marché à un instant donné (dernier point connu avant)
async function priceAt(tokenId, ts, fidelity = 10) {
  const params = new URLSearchParams({
    market: tokenId,
    // Fenêtre large : sur un petit marché, le dernier échange peut dater
    // (sauf à la minute près, où 2 h suffisent et allègent la réponse)
    startTs: String(Math.floor((ts - (fidelity <= 1 ? 2 : 48) * HOUR) / 1000)),
    endTs: String(Math.floor(ts / 1000)),
    fidelity: String(fidelity),
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

// Prix "Oui" de chaque marché à l'instant t0(m) ; renvoie des copies
async function withPricesAt(list, t0, { fidelity = 10 } = {}) {
  let done = 0;
  const out = await mapLimit(list, 8, async (m) => {
    if (outOfTime()) return null;
    const p = await priceAt(m.tokenId, t0(m), fidelity);
    if (++done % 250 === 0) console.log(`  ${done}/${list.length} prix historiques`);
    return { ...m, p };
  });
  return out.filter((m) => m && m.p != null && m.p > 0 && m.p < 1);
}

const withPrices = (list) => withPricesAt(list, (m) => m.ref - LOOKBACK);

// ---------- Écart achat-vente ----------

// L'historique ne garde pas les carnets d'ordres : on mesure l'écart
// achat-vente actuel des marchés ouverts, par tranche de volume, et on
// l'applique aux marchés passés de la même tranche. C'est une estimation :
// la veille de la fin, l'écart peut être un peu différent.
async function spreadStudy() {
  const out = {};
  for (const b of VOLUME_BUCKETS) {
    const spreads = [];
    for (let page = 0; page < 3; page++) {
      const params = new URLSearchParams({
        active: "true",
        closed: "false",
        volume_num_min: String(Math.max(b.min, MIN_VOLUME)),
        limit: "100",
        offset: String(page * 100),
      });
      if (b.max < Infinity) params.set("volume_num_max", String(b.max));
      const rows = await getJSON(`${GAMMA}/markets?${params}`).catch(() => []);
      for (const r of rows) {
        const sp = spreadOf(r);
        // On écarte les marchés quasi joués (prix extrêmes) et les carnets vides
        if (sp != null && sp < 0.5 && Number(r.bestBid) > 0.02 && Number(r.bestAsk) < 0.98) spreads.push(sp);
      }
      if (rows.length < 100) break;
    }
    out[b.key] = { n: spreads.length, median: median(spreads) };
  }
  console.log(`Écart achat-vente médian : ${Object.entries(out).map(([k, v]) => `${k} ${v.median == null ? "?" : (v.median * 100).toFixed(1) + " pts"} (${v.n})`).join(", ")}`);
  return out;
}

// Moitié de l'écart = ce qu'on paie en plus du prix affiché
function withHalfSpread(samples, spreads) {
  for (const s of samples) s.hs = (spreads?.[s.bucket]?.median ?? 0) / 2;
  return samples;
}

// ---------- Étude 1 : calibration ----------

let calibEvents = []; // réutilisés par les études de niche

async function calibrationStudy(spreads) {
  // Les plus gros événements, puis une requête par tranche de volume pour
  // avoir aussi des petits marchés
  const all = new Map();
  for (const ev of await closedEvents({ months: MONTHS, pagesPerMonth: 3 })) all.set(String(ev.id), ev);
  for (const b of VOLUME_BUCKETS) {
    const extra = { volume_min: b.min, ...(b.max < Infinity ? { volume_max: b.max } : {}) };
    for (const ev of await closedEvents({ months: MONTHS, pagesPerMonth: 2, extra })) all.set(String(ev.id), ev);
  }
  const events = [...all.values()];
  calibEvents = events;
  const markets = closedMarkets(events).filter((m) => m.volume >= MIN_VOLUME);
  const counts = VOLUME_BUCKETS.map((b) => `${b.key}: ${markets.filter((m) => m.bucket === b.key).length}`).join(", ");
  console.log(`Calibration : ${events.length} événements, ${markets.length} marchés exploitables (${counts})`);
  const samples = withHalfSpread(await withPrices(sampleByBucket(markets, MAX_PER_BUCKET)), spreads);
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

async function cryptoStudy(spreads) {
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
  withHalfSpread(samples, spreads);
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

// ---------- Études de niche ----------

// Calibration d'une sélection de marchés à plusieurs instants. Chaque
// horizon a son propre échantillon : seuls les marchés ouverts à cet
// instant-là comptent.
async function horizonStudy(name, markets, horizons, spreads) {
  const out = {};
  for (const h of horizons) {
    if (outOfTime()) break;
    const ok = markets.filter((m) => openAt(m, h.t0(m)));
    const samples = withHalfSpread(await withPricesAt(sampleByBucket(ok, MAX_NICHE_PER_BUCKET), h.t0), spreads);
    console.log(`${name} ${h.key} : ${ok.length} marchés jouables, ${samples.length} avec un prix`);
    if (samples.length >= 30)
      out[h.key] = { label: h.label, n: samples.length, events: new Set(samples.map((x) => x.event)).size, brier: brier(samples), bins: calibration(samples) };
  }
  return out;
}

// « X arrivera-t-il avant telle date ? » : 7 jours, 3 jours et 1 jour avant
async function deadlineStudy(spreads) {
  const markets = resolvedMarkets(calibEvents).filter(
    (m) => m.volume >= MIN_VOLUME && isDeadline(m.question) && m.start && m.end - m.start >= 14 * DAY
  );
  console.log(`Échéances : ${markets.length} marchés « avant telle date »`);
  return horizonStudy("Échéances", markets, [
    { key: "7d", label: "7 jours avant", t0: (m) => m.end - 7 * DAY },
    { key: "3d", label: "3 jours avant", t0: (m) => m.end - 3 * DAY },
    { key: "1d", label: "1 jour avant", t0: (m) => m.end - DAY },
  ], spreads);
}

// Sport : le biais sur les favoris existe-t-il encore près du match, quand
// le volume est plus gros et l'écart achat-vente plus serré ?
async function sportTimingStudy(spreads) {
  const markets = resolvedMarkets(calibEvents).filter((m) => m.volume >= MIN_VOLUME && m.group === "sport");
  console.log(`Sport (moment du pari) : ${markets.length} marchés`);
  return horizonStudy("Sport", markets, [
    { key: "24h", label: "24 h avant", t0: (m) => m.end - DAY },
    { key: "6h", label: "6 h avant", t0: (m) => m.end - 6 * HOUR },
    { key: "2h", label: "2 h avant", t0: (m) => m.end - 2 * HOUR },
  ], spreads);
}

// Marchés tout neufs : 6 h et 24 h après leur création
async function newMarketStudy(spreads) {
  const markets = resolvedMarkets(calibEvents).filter((m) => m.volume >= MIN_VOLUME && m.start && m.end - m.start >= 3 * DAY);
  console.log(`Marchés neufs : ${markets.length} marchés d'au moins 3 jours`);
  return horizonStudy("Marchés neufs", markets, [
    { key: "6h", label: "6 h après l'ouverture", t0: (m) => m.start + 6 * HOUR },
    { key: "24h", label: "24 h après l'ouverture", t0: (m) => m.start + DAY },
  ], spreads);
}

// Bougies d'une minute Deribit : prix d'ouverture à `from`, dernier prix connu à `to`
async function minuteCandles(asset, from, to) {
  const qs = new URLSearchParams({
    instrument_name: `${asset}-PERPETUAL`,
    resolution: "1",
    start_timestamp: String(from - 60000),
    end_timestamp: String(to),
  });
  const r = (await getJSON(`${DERIBIT}/get_tradingview_chart_data?${qs}`, 2).catch(() => null))?.result;
  if (!r?.ticks?.length) return null;
  const i0 = r.ticks.findIndex((t) => t >= from);
  // Une bougie commencée à t se termine à t + 1 min : seules les bougies finies avant `to` comptent
  let i1 = -1;
  r.ticks.forEach((t, i) => {
    if (t + 60000 <= to) i1 = i;
  });
  if (i0 < 0 || i1 < 0 || i0 - 1 > i1) return null;
  return { open: r.open[i0], spot: r.close[i1] };
}

// « Bitcoin Up or Down » à l'heure et au quart d'heure : à mi-fenêtre, le
// modèle (prix d'ouverture, prix actuel, volatilité DVOL) contre Polymarket.
async function updownStudy(spreads) {
  const now = Date.now();
  const events = await closedEvents({ months: 1, pagesPerMonth: 6, tag: "crypto" });
  const markets = [];
  for (const ev of events) {
    for (const raw of ev.markets ?? []) {
      const u = parseUpDown(raw.question || ev.title);
      if (!u) continue;
      const m = normalizeMarket(raw);
      const up = m.outcomes.findIndex((o) => /^up$/i.test(o));
      const tokens = (() => {
        try {
          return Array.isArray(raw.clobTokenIds) ? raw.clobTokenIds : JSON.parse(raw.clobTokenIds ?? "[]");
        } catch {
          return [];
        }
      })();
      const w = winnerIndex({ ...m, closed: true });
      const end = parseTime(raw.endDate);
      if (up < 0 || w == null || !tokens[up] || !end) continue;
      const start = end - u.minutes * 60000;
      const t0 = start + (u.minutes * 60000) / 2;
      const closedAt = parseTime(raw.closedTime);
      if (closedAt != null && closedAt <= t0) continue;
      markets.push({ id: m.id, event: String(end), asset: u.asset, minutes: u.minutes, tokenId: String(tokens[up]), outcome: w === up ? 1 : 0, start, t0, end, volume: m.volume, bucket: volumeBucket(m.volume) });
    }
  }
  const sample = markets.sort((a, b) => hashId(`${a.id}:ud`) - hashId(`${b.id}:ud`)).slice(0, 400);
  console.log(`Up or Down : ${events.length} événements, ${markets.length} marchés BTC/ETH (15 min / 1 h), ${sample.length} tirés au sort`);
  if (!sample.length) return null;

  const dvol = {};
  for (const a of ["BTC", "ETH"]) dvol[a] = await deribitSeries("get_volatility_index_data", { currency: a, resolution: "3600" }, now - 35 * DAY, now);
  const priced = await withPricesAt(sample, (m) => m.t0, { fidelity: 1 });
  const samples = [];
  await mapLimit(priced, 6, async (m) => {
    if (outOfTime()) return;
    const c = await minuteCandles(m.asset, m.start, m.t0);
    const v = valueAt(dvol[m.asset], m.t0);
    if (!c || !v) return;
    const model = probUp(c.open, c.spot, v / 100, (m.end - m.t0) / (365.25 * DAY));
    if (model == null) return;
    samples.push({ ...m, model });
  });
  withHalfSpread(samples, spreads);
  console.log(`Up or Down : ${samples.length} marchés rejoués`);
  if (samples.length < 30) return { n: samples.length };
  const byWindow = {};
  for (const w of [15, 60]) {
    const s = samples.filter((x) => x.minutes === w);
    if (s.length >= 20) byWindow[w] = { n: s.length, brierModel: brier(s, "model"), brierPoly: brier(s, "p"), signals: followSignals(s, 0.05) };
  }
  const thresholds = {};
  for (const t of [0.03, 0.05, 0.1]) thresholds[t] = followSignals(samples, t);
  return {
    n: samples.length,
    events: new Set(samples.map((x) => x.event)).size,
    brierModel: brier(samples, "model"),
    brierPoly: brier(samples, "p"),
    thresholds,
    byWindow,
  };
}

// Résumé lisible dans les logs de l'Action
function logSummary(calib, crypto, niche = {}) {
  const p = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`);
  const ci = (c) => (c ? `[${p(c[0])} ; ${p(c[1])}]` : "[—]");
  const rows = (bins) =>
    bins
      .filter((b) => b.n > 0)
      .map(
        (b) =>
          `  ${Math.round(b.lo * 100)}-${Math.round(b.hi * 100)}% n=${b.n} év=${b.events} prix=${Math.round(b.avgPrice * 100)}% réel=${Math.round(b.freq * 100)}% ` +
          `Oui=${p(b.roiYes)} ${ci(b.ciYes)} (A ${p(b.A.roiYes)} / B ${p(b.B.roiYes)}) Non=${p(b.roiNo)} ${ci(b.ciNo)} (A ${p(b.A.roiNo)} / B ${p(b.B.roiNo)})` +
          ` | prix payé : Oui=${p(b.roiYesExec)} ${ci(b.ciYesExec)} Non=${p(b.roiNoExec)} ${ci(b.ciNoExec)} (A ${p(b.A.roiNoExec)} / B ${p(b.B.roiNoExec)})`
      )
      .join("\n");
  console.log(`\n=== Calibration (${calib.n} marchés, ${calib.events} événements, Brier ${calib.brier?.toFixed(3)}) ===\n${rows(calib.bins)}`);
  for (const [g, r] of Object.entries(calib.byGroup)) console.log(`--- ${g} (${r.n}, Brier ${r.brier.toFixed(3)}) ---\n${rows(r.bins)}`);
  for (const [g, r] of Object.entries(calib.byVolume ?? {})) console.log(`--- volume ${g} (${r.n}, Brier ${r.brier.toFixed(3)}) ---\n${rows(r.bins)}`);
  if (crypto?.n) {
    console.log(`\n=== Modèle crypto (${crypto.n} marchés, ${crypto.events} événements) Brier modèle ${crypto.brierModel.toFixed(3)} / Polymarket ${crypto.brierPoly.toFixed(3)} ===`);
    for (const [t, r] of Object.entries(crypto.thresholds))
      console.log(
        `  écart ≥ ${Math.round(t * 100)} pts, 1 pari/événement : ${r.all.bets} paris, ${r.all.wins} gagnés, gain/pari ${p(r.all.roi)} ${ci(r.all.ci)} (A ${p(r.A.roi)} / B ${p(r.B.roi)}), au prix payé ${p(r.all.roiExec)} ${ci(r.all.ciExec)}` +
          ` | tous les signaux : ${crypto.thresholdsAll[t].all.bets} paris, ${p(crypto.thresholdsAll[t].all.roi)}`
      );
    for (const [k, r] of Object.entries(crypto.byVolume ?? {}))
      console.log(`  volume ${k} : n=${r.n} (${r.events} év.) Brier modèle ${r.brierModel.toFixed(3)} / Polymarket ${r.brierPoly.toFixed(3)}, signaux ${r.signals.all.bets}, gain/pari ${p(r.signals.all.roi)} ${ci(r.signals.all.ci)}`);
    for (const [k, r] of Object.entries(crypto.byKind ?? {}))
      console.log(`  ${k} : n=${r.n} (${r.events} év.) Brier modèle ${r.brierModel.toFixed(3)} / Polymarket ${r.brierPoly.toFixed(3)}, signaux ${r.signals.all.bets}, gain/pari ${p(r.signals.all.roi)} ${ci(r.signals.all.ci)} (A ${p(r.signals.A.roi)} / B ${p(r.signals.B.roi)})`);
  }
  for (const [name, study] of [["Sport", niche.sportTiming], ["Échéances", niche.deadline], ["Marchés neufs", niche.fresh]]) {
    for (const [k, r] of Object.entries(study ?? {})) console.log(`\n=== ${name} ${k} (${r.n} marchés, ${r.events} événements, Brier ${r.brier.toFixed(3)}) ===\n${rows(r.bins)}`);
  }
  const ud = niche.updown;
  if (ud?.thresholds) {
    console.log(`\n=== Up or Down (${ud.n} marchés) Brier modèle ${ud.brierModel.toFixed(3)} / Polymarket ${ud.brierPoly.toFixed(3)} ===`);
    for (const [t, r] of Object.entries(ud.thresholds))
      console.log(`  écart ≥ ${Math.round(t * 100)} pts : ${r.all.bets} paris, gain/pari ${p(r.all.roi)} ${ci(r.all.ci)}, au prix payé ${p(r.all.roiExec)} ${ci(r.all.ciExec)} (A ${p(r.A.roi)} / B ${p(r.B.roi)})`);
    for (const [w, r] of Object.entries(ud.byWindow ?? {}))
      console.log(`  ${w} min : n=${r.n} Brier modèle ${r.brierModel.toFixed(3)} / Polymarket ${r.brierPoly.toFixed(3)}, signaux ${r.signals.all.bets}, ${p(r.signals.all.roiExec)} ${ci(r.signals.all.ciExec)}`);
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
    const spreads = await spreadStudy();
    const calib = await calibrationStudy(spreads);
    const crypto = outOfTime() ? null : await cryptoStudy(spreads);
    // Études de niche : chacune peut échouer sans faire tomber le reste
    const niche = {};
    for (const [k, fn] of [["sportTiming", sportTimingStudy], ["deadline", deadlineStudy], ["fresh", newMarketStudy], ["updown", updownStudy]]) {
      if (outOfTime()) break;
      niche[k] = await fn(spreads).catch((err) => {
        console.log(`::warning::Étude ${k} en échec : ${err.message}`);
        return null;
      });
    }
    await writeData("backtest.json", {
      updatedAt: new Date().toISOString(),
      lookbackHours: LOOKBACK / HOUR,
      partial: outOfTime(),
      spreads,
      calibration: calib,
      crypto,
      ...niche,
    });
    console.log(`Backtest terminé en ${Math.round((Date.now() - started) / 1000)} s`);
    logSummary(calib, crypto, niche);
  } catch (err) {
    console.log(`::warning::Backtest en échec : ${err.message}`);
    if (prev) await writeData("backtest.json", prev);
  }
}
