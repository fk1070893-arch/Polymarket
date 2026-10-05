// Compare les marchés crypto de Polymarket (« BTC au-dessus de X $ le … »)
// aux probabilités tirées des options Deribit. Résultat : site/data/crypto.json
//
// Le fichier garde aussi un historique : pour chaque marché, les
// probabilités (modèle et Polymarket) 24 h avant l'échéance, puis le
// résultat final. Ça permet de mesurer qui a raison le plus souvent.
//
// Usage : node scripts/build-crypto.mjs (après build-snapshot.mjs)

import { GAMMA } from "../site/js/api.js";
import { normalizeEvents, normalizeMarket, winnerIndex, yesPrice } from "../site/js/normalize.js";
import { buildSurface, modelProbability, parseCryptoQuestion, realizedVol, surfaceVol } from "./crypto-model.mjs";
import { getJSON, loadPrevious, nowSec, readData, writeData } from "./lib.mjs";

const DERIBIT = "https://www.deribit.com/api/v2/public";
const COINBASE = "https://api.exchange.coinbase.com";
const ASSETS = ["BTC", "ETH"];
const SIGNAL = 0.05; // écart minimum (5 points) pour parler de signal
const HISTORY_DAYS = 120;

// ---------- Prix et volatilité ----------

async function fromDeribit(asset) {
  const [index, book] = await Promise.all([
    getJSON(`${DERIBIT}/get_index_price?index_name=${asset.toLowerCase()}_usd`),
    getJSON(`${DERIBIT}/get_book_summary_by_currency?currency=${asset}&kind=option`),
  ]);
  const spot = Number(index?.result?.index_price);
  if (!(spot > 0)) throw new Error("prix Deribit invalide");
  const surface = buildSurface(book?.result ?? [], spot);
  if (surface.expiries.length === 0) throw new Error("aucune option Deribit exploitable");
  const atm = surfaceVol(surface, spot, Date.now() + 30 * 86400000);
  return { spot, source: "deribit", atmVol: atm, vol: (strike, dateMs) => surfaceVol(surface, strike, dateMs) };
}

// Solution de repli : volatilité réalisée sur 30 jours (Coinbase)
async function fromCoinbase(asset) {
  const candles = await getJSON(`${COINBASE}/products/${asset}-USD/candles?granularity=86400`);
  const closes = candles
    .slice(0, 31)
    .reverse()
    .map((c) => Number(c[4]));
  const ticker = await getJSON(`${COINBASE}/products/${asset}-USD/ticker`).catch(() => null);
  const spot = Number(ticker?.price) || closes[closes.length - 1];
  const sigma = realizedVol(closes);
  if (!(spot > 0) || !sigma) throw new Error("données Coinbase invalides");
  return { spot, source: "realized", atmVol: sigma, vol: () => sigma };
}

async function marketData(asset) {
  try {
    return await fromDeribit(asset);
  } catch (err) {
    console.log(`Deribit indisponible pour ${asset} (${err.message}), repli sur Coinbase`);
    return fromCoinbase(asset);
  }
}

// ---------- Marchés crypto de Polymarket ----------

async function cryptoEvents() {
  const { events } = await readData("events.json");
  const byId = new Map(events.map((e) => [e.id, e]));
  const known = new Set(byId.keys());
  // Les marchés crypto ne sont pas forcément dans le top 500 : on les
  // demande explicitement.
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      tag_slug: "crypto",
      active: "true",
      closed: "false",
      archived: "false",
      order: "volume24hr",
      ascending: "false",
      limit: "100",
      offset: String(page * 100),
    });
    const raw = await getJSON(`${GAMMA}/events?${params}`).catch(() => []);
    for (const ev of normalizeEvents(raw)) if (!byId.has(ev.id)) byId.set(ev.id, ev);
    if (raw.length < 100) break;
  }
  return { events: [...byId.values()], known };
}

// ---------- Historique et résultats ----------

async function resolveOutcomes(history) {
  const now = Date.now();
  const pending = Object.entries(history)
    .filter(([, h]) => h.outcome == null && new Date(h.date).getTime() < now - 3600000)
    .map(([id]) => id)
    .slice(0, 200);
  for (let i = 0; i < pending.length; i += 50) {
    const ids = pending.slice(i, i + 50);
    const qs = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    const rows = [
      ...(await getJSON(`${GAMMA}/markets?${qs}&limit=50`).catch(() => [])),
      ...(await getJSON(`${GAMMA}/markets?${qs}&limit=50&closed=true`).catch(() => [])),
    ];
    for (const r of rows) {
      const m = normalizeMarket(r);
      const w = winnerIndex(m);
      if (history[m.id] && w != null) history[m.id].outcome = w === 0 ? 1 : 0;
    }
  }
}

// Score de Brier : erreur quadratique moyenne des probabilités (0 = parfait,
// 0,25 = pile ou face). Plus c'est bas, mieux c'est.
function trackRecord(history) {
  const done = Object.values(history).filter((h) => h.outcome != null && h.at24);
  const n = done.length;
  if (n === 0) return { resolved: 0 };
  const brier = (key) => done.reduce((s, h) => s + (h.at24[key] - h.outcome) ** 2, 0) / n;

  // Si on avait suivi chaque signal (1 $ par signal, 24 h avant l'échéance)
  let bets = 0;
  let pnl = 0;
  let wins = 0;
  for (const h of done) {
    const { model, poly } = h.at24;
    const edge = model - poly;
    if (Math.abs(edge) < SIGNAL || poly < 0.03 || poly > 0.97) continue;
    bets++;
    const won = edge > 0 ? h.outcome === 1 : h.outcome === 0;
    const price = edge > 0 ? poly : 1 - poly;
    if (won) wins++;
    pnl += won ? 1 / price - 1 : -1;
  }
  return { resolved: n, brierModel: brier("model"), brierPoly: brier("poly"), signalBets: bets, signalWins: wins, signalPnl: pnl };
}

// ---------- Programme principal ----------

const prev = (await loadPrevious("crypto.json")) ?? {};
const history = prev.history ?? {};

async function main() {
  const assets = {};
  for (const a of ASSETS) {
    try {
      assets[a] = await marketData(a);
      console.log(`${a} : ${Math.round(assets[a].spot)} $, volatilité ${(assets[a].atmVol * 100).toFixed(0)} % (${assets[a].source})`);
    } catch (err) {
      console.log(`::warning::Pas de données de prix pour ${a} : ${err.message}`);
    }
  }

  const { events, known } = await cryptoEvents();
  const now = Date.now();
  const markets = [];
  const extraEvents = new Map();

  for (const ev of events) {
    for (const m of ev.markets) {
      const parsed = parseCryptoQuestion(m.question) ?? parseCryptoQuestion(`${ev.title} ${m.label}`);
      if (!parsed || !assets[parsed.asset]) continue;
      const { spot, vol } = assets[parsed.asset];
      const ref = parsed.strike ?? Math.sqrt(parsed.low * parsed.high);
      if (ref < spot * 0.2 || ref > spot * 5) continue;
      const date = m.endDate ?? ev.endDate;
      const dateMs = new Date(date).getTime();
      if (!Number.isFinite(dateMs) || dateMs < now || dateMs > now + 400 * 86400000) continue;

      const model = modelProbability(parsed, { spot, vol: (k) => vol(k, dateMs), dateMs, nowMs: now });
      if (model == null || !Number.isFinite(model)) continue;
      const poly = yesPrice(m);
      const row = {
        marketId: m.id,
        eventId: ev.id,
        eventSlug: ev.slug,
        eventTitle: ev.title,
        question: m.question,
        label: m.label,
        asset: parsed.asset,
        kind: parsed.kind,
        dir: parsed.dir ?? null,
        strike: parsed.strike ?? null,
        low: parsed.low ?? null,
        high: parsed.high ?? null,
        date,
        poly: Math.round(poly * 10000) / 10000,
        model: Math.round(model * 10000) / 10000,
        edge: Math.round((model - poly) * 10000) / 10000,
        sigma: Math.round(vol(ref, dateMs) * 10000) / 10000,
        volume: Math.round(m.volume),
        liquidity: Math.round(ev.liquidity),
      };
      markets.push(row);
      if (!known.has(ev.id)) extraEvents.set(ev.id, ev);

      // Historique : on fige les probabilités à 24 h de l'échéance
      const h = history[m.id] ?? { date, asset: parsed.asset, question: m.question, first: { model: row.model, poly: row.poly, at: now } };
      h.last = { model: row.model, poly: row.poly, at: now };
      if (!h.at24 && dateMs - now <= 24 * 3600000) h.at24 = { model: row.model, poly: row.poly, at: now };
      history[m.id] = h;
    }
  }
  markets.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  console.log(`${markets.length} marchés crypto analysés, ${markets.filter((m) => Math.abs(m.edge) >= SIGNAL).length} écarts ≥ 5 pts`);

  await resolveOutcomes(history).catch((err) => console.log(`Résultats non récupérés : ${err.message}`));
  for (const [id, h] of Object.entries(history)) {
    if (now - new Date(h.date).getTime() > HISTORY_DAYS * 86400000) delete history[id];
  }
  const record = trackRecord(history);
  console.log(`Historique : ${Object.keys(history).length} marchés suivis, ${record.resolved} terminés`);

  await writeData("crypto.json", {
    updatedAt: new Date().toISOString(),
    generatedAt: nowSec(),
    signal: SIGNAL,
    assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, { spot: v.spot, source: v.source, atmVol: v.atmVol }])),
    markets,
    events: [...extraEvents.values()],
    record,
    history,
  });
}

try {
  await main();
} catch (err) {
  // En cas de panne, on republie l'état précédent pour ne pas perdre
  // l'historique accumulé.
  console.log(`::warning::Modèle crypto en échec : ${err.message}`);
  if (prev.updatedAt) await writeData("crypto.json", prev);
}
