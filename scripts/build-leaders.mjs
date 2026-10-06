// Classement des traders les plus rentables de Polymarket (semaine et mois)
// et leurs derniers paris. Recalculé une fois par heure, sinon republié tel
// quel. Résultat : site/data/leaders.json
//
// Usage : node scripts/build-leaders.mjs

import { getJSON, loadPrevious, mapLimit, writeData } from "./lib.mjs";

const DATA_API = "https://data-api.polymarket.com";
const TOP = 25;
const HOUR = 3600000;

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

// Le classement a changé d'adresse plusieurs fois : on essaie les deux connues
const SOURCES = [
  (period) => `${DATA_API}/v1/leaderboard?category=OVERALL&timePeriod=${period === "week" ? "WEEK" : "MONTH"}&orderBy=PNL&limit=${TOP}`,
  (period) => `https://lb-api.polymarket.com/profit?window=${period === "week" ? "7d" : "30d"}&limit=${TOP}`,
];

function parseRow(r, i) {
  const wallet = String(r.proxyWallet ?? r.proxy_wallet ?? r.address ?? r.user ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return null;
  return {
    rank: num(r.rank) ?? i + 1,
    wallet,
    name: r.userName ?? r.name ?? r.pseudonym ?? "",
    pnl: num(r.pnl ?? r.amount ?? r.profit),
    volume: num(r.vol ?? r.volume),
  };
}

async function leaderboard(period) {
  for (const url of SOURCES) {
    const data = await getJSON(url(period), 2).catch(() => null);
    const rows = Array.isArray(data) ? data : data?.data ?? data?.leaderboard ?? [];
    const out = rows.map(parseRow).filter(Boolean);
    if (out.length) return out.slice(0, TOP);
  }
  return [];
}

// Derniers paris d'un wallet (achats et ventes)
async function recentTrades(wallet) {
  const rows = await getJSON(`${DATA_API}/trades?user=${wallet}&limit=8&takerOnly=false`, 2).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((t) => ({
    ts: Number(t.timestamp) || null,
    side: t.side ?? "",
    title: t.title ?? "",
    outcome: t.outcome ?? "",
    price: num(t.price),
    cash: Math.round((num(t.price) ?? 0) * (num(t.size) ?? 0)),
    eventSlug: t.eventSlug ?? "",
    conditionId: t.conditionId ?? "",
  }));
}

const prev = await loadPrevious("leaders.json");
const now = Date.now();
if (prev?.updatedAt && now - new Date(prev.updatedAt).getTime() < HOUR - 5 * 60000) {
  console.log("Classement récent : republié tel quel");
  await writeData("leaders.json", prev);
} else {
  try {
    const [week, month] = [await leaderboard("week"), await leaderboard("month")];
    if (!week.length && !month.length) throw new Error("classement Polymarket indisponible");
    const wallets = [...new Set([...week, ...month].map((r) => r.wallet))];
    const trades = Object.fromEntries(await mapLimit(wallets, 4, async (w) => [w, await recentTrades(w)]));
    console.log(`Classement : ${week.length} traders (semaine), ${month.length} (mois), derniers paris de ${wallets.length} wallets`);
    await writeData("leaders.json", { updatedAt: new Date(now).toISOString(), week, month, trades });
  } catch (err) {
    console.log(`::warning::Classement des traders en échec : ${err.message}`);
    if (prev) await writeData("leaders.json", prev);
  }
}
