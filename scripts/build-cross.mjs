// Polymarket comparé à deux autres sources sur les MÊMES questions :
//
//  - Kalshi : site de paris régulé aux États-Unis, beaucoup de questions
//    communes (Fed, inflation, élections, sport). Quand Polymarket vend une
//    issue nettement moins cher que la probabilité Kalshi, on parie 1 $
//    fictif (test en direct). Quand acheter « Oui » sur un site et « Non »
//    sur l'autre coûte moins de 1 $ (frais Kalshi compris), c'est une
//    anomalie entre sites — à vérifier : les règles de résolution diffèrent
//    parfois.
//  - Metaculus : prévisions d'une communauté de prévisionnistes, réputées
//    bien calibrées en géopolitique, science et technologie. Second avis,
//    sans pari.
//
// Les questions sont rapprochées par leurs mots importants (match-lib.mjs) ;
// les paires douteuses sont écartées. Résultat : site/data/cross.json
//
// Usage : node scripts/build-cross.mjs (après build-arbs.mjs)

import { normalizeMarket } from "../site/js/normalize.js";
import { parseTime } from "./backtest-lib.mjs";
import { allEventsBetween, getJSON, loadState, readCache, writeState } from "./lib.mjs";
import { bestMatch, buildIndex } from "./match-lib.mjs";
import { paperStats, pnlCurve, settleBets } from "./paper.mjs";

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const DAY = 86400000;
const KALSHI_PAGES = 25; // 1 000 marchés par page
const MIN_SIM = 0.6; // similarité minimale pour comparer
const MIN_SIM_BET = 0.7; // … et pour parier
const MIN_GAP = 0.05; // écart minimum pour parier
const MAX_KALSHI_SPREAD = 0.1; // prix Kalshi trop flou au-delà
const MAX_COST = 0.95;
const KEEP_FOR = 180 * DAY;
const TIME_BUDGET = 90 * 1000;

const started = Date.now();
const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const quote = (v) => (v != null && v > 0 && v < 1 ? v : null);

// ---------- Polymarket ----------

async function polymarket(now) {
  const cached = await readCache("pm-markets.json");
  if (cached?.length) return cached;
  // Repli si l'étape des anomalies n'a pas tourné : on relit tout
  const events = await allEventsBetween({ active: "true", closed: "false" }, now - 30 * DAY, now + 5 * 365 * DAY, { deadline: started + 60000 });
  const out = [];
  for (const ev of events)
    for (const raw of ev.markets ?? []) {
      const m = normalizeMarket(raw);
      if (m.closed || !m.active || m.outcomes.length !== 2 || !m.prices.length) continue;
      out.push({ id: m.id, q: m.question, event: String(ev.id), eventTitle: ev.title ?? "", slug: ev.slug ?? "", outcomes: m.outcomes, p: m.prices[0], bid: raw.bestBid ?? null, ask: raw.bestAsk ?? null, volume: Math.round(m.volume), end: parseTime(raw.endDate) ?? parseTime(ev.endDate) });
    }
  return out;
}

// Prix d'achat de chaque issue sur Polymarket
function pmAsks(m) {
  const bid = quote(num(m.bid));
  const ask = quote(num(m.ask));
  return [ask, bid != null ? 1 - bid : null];
}

// ---------- Kalshi ----------

// Les prix Kalshi sont en centimes (yes_ask: 45) ou, dans les versions
// récentes de l'API, en dollars (yes_ask_dollars: "0.4500")
function kalshiPrice(m, field) {
  const d = num(m[`${field}_dollars`]);
  if (d != null) return quote(d);
  const c = num(m[field]);
  return c != null ? quote(c / 100) : null;
}

// Frais Kalshi (preneur) : environ 7 % × p × (1 − p) par contrat de 1 $
const kalshiFee = (p) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

async function kalshiMarkets() {
  const out = [];
  let cursor = "";
  for (let page = 0; page < KALSHI_PAGES && Date.now() - started < TIME_BUDGET; page++) {
    const qs = new URLSearchParams({ status: "open", limit: "1000", mve_filter: "exclude" });
    if (cursor) qs.set("cursor", cursor);
    const data = await getJSON(`${KALSHI}/markets?${qs}`, 2);
    for (const m of data?.markets ?? []) {
      const yesBid = kalshiPrice(m, "yes_bid");
      const yesAsk = kalshiPrice(m, "yes_ask");
      if (yesBid == null || yesAsk == null || yesAsk - yesBid > MAX_KALSHI_SPREAD) continue;
      const sub = m.yes_sub_title && !String(m.title ?? "").includes(m.yes_sub_title) ? ` ${m.yes_sub_title}` : "";
      out.push({
        ticker: m.ticker,
        event: m.event_ticker,
        text: `${m.title ?? ""}${sub}`.trim(),
        yesBid,
        yesAsk,
        mid: (yesBid + yesAsk) / 2,
        end: parseTime(m.close_time) ?? parseTime(m.expiration_time),
        volume: num(m.volume) ?? 0,
      });
    }
    cursor = data?.cursor ?? "";
    if (!cursor || !(data?.markets ?? []).length) break;
  }
  return out;
}

// ---------- Metaculus ----------

// L'API Metaculus demande désormais une clé (gratuite, compte Metaculus →
// paramètres → « API access »), dans le secret GitHub METACULUS_TOKEN.
// Jamais écrite dans les logs : les erreurs ne citent pas la requête.
const METACULUS_TOKEN = (process.env.METACULUS_TOKEN ?? "").trim();

async function metaculusGet(url) {
  const headers = { accept: "application/json" };
  if (METACULUS_TOKEN) headers.authorization = `Token ${METACULUS_TOKEN}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new Error("Metaculus injoignable");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// L'API Metaculus a changé plusieurs fois : on essaie la nouvelle puis l'ancienne
function metaculusProb(post) {
  const q = post.question ?? post;
  const paths = [
    q?.aggregations?.recency_weighted?.latest?.centers?.[0],
    q?.aggregations?.recency_weighted?.latest?.forecast_values?.[1],
    q?.community_prediction?.full?.q2,
    post?.community_prediction?.full?.q2,
  ];
  for (const v of paths) if (num(v) != null && v > 0 && v < 1) return num(v);
  return null;
}

async function metaculus() {
  const urls = [
    (o) => `https://www.metaculus.com/api/posts/?statuses=open&forecast_type=binary&order_by=-hotness&limit=100&offset=${o}`,
    (o) => `https://www.metaculus.com/api2/questions/?status=open&type=binary&order_by=-activity&limit=100&offset=${o}`,
  ];
  for (const url of urls) {
    const out = [];
    let error = null;
    for (let o = 0; o < 500; o += 100) {
      const data = await metaculusGet(url(o)).catch((err) => {
        error = err.message;
        return null;
      });
      const rows = data?.results ?? [];
      for (const post of rows) {
        const p = metaculusProb(post);
        const q = post.question ?? post;
        if (p == null) continue;
        out.push({
          id: post.id,
          text: post.title ?? q.title ?? "",
          p,
          end: parseTime(q.scheduled_resolve_time ?? q.resolve_time ?? q.scheduled_close_time),
          url: `https://www.metaculus.com/questions/${post.id}/`,
        });
      }
      if (rows.length < 100) break;
    }
    if (out.length) return { questions: out, status: `${out.length} questions avec une prévision` };
    if (error) console.log(`Metaculus : ${error}`);
  }
  return {
    questions: [],
    status: METACULUS_TOKEN ? "API Metaculus indisponible (clé refusée ?)" : "clé Metaculus manquante (secret METACULUS_TOKEN) : comparaison désactivée",
  };
}

// ---------- Programme principal ----------

async function main(prev) {
  const now = Date.now();
  const pm = await polymarket(now);
  const index = buildIndex(pm, (m) => m.q);
  console.log(`Polymarket : ${pm.length} marchés ouverts`);
  // Dates compatibles : à 3 jours près (Kalshi), à un mois près (Metaculus)
  const near = (end, days) => (m) => end == null || m.end == null || Math.abs(m.end - end) <= days * DAY;

  // Kalshi
  let kalshi = [];
  let kalshiStatus;
  try {
    kalshi = await kalshiMarkets();
    kalshiStatus = `${kalshi.length} marchés Kalshi avec un prix`;
  } catch (err) {
    kalshiStatus = `Kalshi indisponible (${err.message.replace(/ sur https?:\/\/\S+/, "")})`;
  }
  console.log(kalshiStatus);

  const pairs = [];
  const arbs = [];
  for (const k of kalshi) {
    const hit = bestMatch(index, k.text, { min: MIN_SIM, accept: near(k.end, 3) });
    if (!hit) continue;
    const m = hit.item;
    // Seulement les questions oui / non : « Oui » a alors le même sens des deux côtés
    if (!/^yes$/i.test(m.outcomes?.[0] ?? "")) continue;
    const [askYes, askNo] = pmAsks(m);
    // Probabilité Kalshi de chaque issue Polymarket (« Oui » = issue 0)
    const kp = [k.mid, 1 - k.mid];
    const edges = [askYes != null ? kp[0] - askYes : null, askNo != null ? kp[1] - askNo : null];
    const side = (edges[0] ?? -1) >= (edges[1] ?? -1) ? 0 : 1;
    pairs.push({
      marketId: m.id,
      event: m.event,
      eventTitle: m.eventTitle,
      slug: m.slug,
      question: m.q,
      outcomes: m.outcomes,
      kalshi: { ticker: k.ticker, text: k.text, mid: k.mid, yesBid: k.yesBid, yesAsk: k.yesAsk },
      sim: Math.round(hit.sim * 100) / 100,
      pmMid: m.p,
      gap: m.p - k.mid,
      side,
      edge: edges[side],
      ask: side === 0 ? askYes : askNo,
      end: m.end ?? k.end,
    });
    // Anomalie entre sites : « Oui » d'un côté + « Non » de l'autre < 1 $
    const kNo = 1 - k.yesBid;
    const combos = [
      { pm: 0, pmCost: askYes, kCost: kNo, label: "Oui sur Polymarket + Non sur Kalshi" },
      { pm: 1, pmCost: askNo, kCost: k.yesAsk, label: "Non sur Polymarket + Oui sur Kalshi" },
    ];
    for (const c of combos) {
      if (c.pmCost == null || c.kCost == null) continue;
      const cost = c.pmCost + c.kCost + kalshiFee(c.kCost);
      if (cost < 0.99 && hit.sim >= MIN_SIM_BET)
        arbs.push({ marketId: m.id, question: m.q, kalshiText: k.text, ticker: k.ticker, slug: m.slug, label: c.label, cost: Math.round(cost * 1000) / 1000, profit: Math.round((1 - cost) * 1000) / 1000, sim: hit.sim, end: m.end });
    }
  }
  console.log(`Kalshi : ${pairs.length} questions rapprochées de Polymarket, ${arbs.length} anomalies entre sites`);

  // Paris fictifs : Polymarket nettement moins cher que la probabilité Kalshi
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR);
  const known = new Set(bets.map((b) => b.marketId));
  let added = 0;
  for (const p of pairs) {
    if (known.has(p.marketId) || p.sim < MIN_SIM_BET || p.edge == null || p.edge < MIN_GAP || p.ask > MAX_COST) continue;
    if (p.end != null && p.end < now) continue;
    bets.push({
      id: p.marketId,
      marketId: p.marketId,
      event: p.event,
      eventTitle: p.eventTitle,
      question: p.question,
      outcome: p.outcomes[p.side],
      side: p.side,
      kalshi: p.side === 0 ? p.kalshi.mid : 1 - p.kalshi.mid,
      kalshiText: p.kalshi.text,
      sim: p.sim,
      cost: p.ask,
      mid: p.side === 0 ? p.pmMid : 1 - p.pmMid,
      edge: p.edge,
      end: p.end,
      placedAt: now,
      won: null,
      roi: null,
    });
    known.add(p.marketId);
    added++;
  }
  // Un marché peut se régler avant sa date prévue : tout est revérifié une fois par heure
  await settleBets(bets, now, { graceMs: new Date(now).getUTCMinutes() < 5 ? -Infinity : 3600000 });
  const settled = bets.filter((b) => b.won != null);
  console.log(`${added} nouveaux paris fictifs, ${bets.length - settled.length} en attente, ${settled.length} réglés`);

  // Metaculus
  const meta = await metaculus().catch((err) => ({ questions: [], status: `Metaculus indisponible (${err.message})` }));
  console.log(`Metaculus : ${meta.status}`);
  const metaPairs = [];
  for (const q of meta.questions) {
    const hit = bestMatch(index, q.text, { min: MIN_SIM, accept: near(q.end, 31) });
    if (!hit) continue;
    const m = hit.item;
    if (!/^yes$/i.test(m.outcomes?.[0] ?? "")) continue;
    metaPairs.push({
      marketId: m.id,
      slug: m.slug,
      question: m.q,
      metaculus: { id: q.id, text: q.text, p: q.p, url: q.url },
      sim: Math.round(hit.sim * 100) / 100,
      pmMid: m.p,
      gap: m.p - q.p,
    });
  }
  console.log(`Metaculus : ${metaPairs.length} questions rapprochées de Polymarket`);

  bets.sort((a, b) => b.placedAt - a.placedAt);
  const byGap = (a, b) => Math.abs(b.gap) - Math.abs(a.gap);
  const base = {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? new Date(now).toISOString(),
    rule: {
      description: `Questions rapprochées entre Polymarket et Kalshi (similarité d'au moins ${MIN_SIM_BET * 100} %, dates à 3 jours près) : si Polymarket vend une issue au moins ${MIN_GAP * 100} pts moins cher que la probabilité Kalshi, 1 $ fictif sur cette issue au prix vendeur. Un pari par marché.`,
    },
    kalshiStatus,
    metaculusStatus: meta.status,
    pmMarkets: pm.length,
    kalshiMarkets: kalshi.length,
    pairs: pairs.sort(byGap).slice(0, 60),
    pairCount: pairs.length,
    arbs: arbs.sort((a, b) => b.profit - a.profit).slice(0, 30),
    metaculus: metaPairs.sort(byGap).slice(0, 40),
    metaculusCount: metaPairs.length,
    summary: { ...paperStats(settled), pending: bets.length - settled.length, curve: pnlCurve(settled) },
  };
  return { state: { ...base, bets }, view: { ...base, bets: bets.slice(0, 30) } };
}

const prev = await loadState("cross");
try {
  const { state, view } = await main(prev ?? {});
  await writeState("cross", state, view);
} catch (err) {
  console.log(`::warning::Comparaison Kalshi / Metaculus en échec : ${err.message}`);
  if (prev) await writeState("cross", prev, { ...prev, bets: (prev.bets ?? []).slice(0, 30) });
}
