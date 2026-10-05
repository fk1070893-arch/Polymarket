// Détecteur de paris suspects ("insiders") sur Polymarket.
//
// Tous les paris Polymarket sont publics. Ce script récupère les gros paris
// récents, regarde qui les a passés (âge du wallet, nombre de marchés déjà
// joués) et attribue un score de suspicion à chacun. Résultat :
// site/data/alerts.json, affiché dans l'onglet « Alertes » du site.
//
// Usage : node scripts/build-alerts.mjs (après build-snapshot.mjs)

import { getJSON, loadPrevious, mapLimit, nowSec, readData, writeData } from "./lib.mjs";

const DATA_API = "https://data-api.polymarket.com";

const MIN_CASH = 2000; // on ne regarde que les paris d'au moins 2 000 $
const MAX_PAGES = 10;
const PAGE_SIZE = 500;
const MIN_SCORE = 35; // en dessous, le pari n'est pas considéré comme suspect
const KEEP_ALERTS_FOR = 7 * 86400;
const MAX_ALERTS = 400;
const WALLET_TTL = 24 * 3600; // infos d'un wallet réutilisées pendant 24 h
const CLUSTER_WINDOW = 2 * 3600;

const DAY = 86400;

// Marchés crypto « Up or Down » de quelques minutes : beaucoup de robots,
// aucun intérêt pour la détection d'insiders.
const NOISE = /\bup or down\b/i;

function scoreTrade(t, wallet, clusterSize, endDate) {
  let score = 0;
  const reasons = [];

  const age = wallet.first ? t.ts - wallet.first : null;
  if (age !== null) {
    if (age < DAY) {
      score += 35;
      reasons.push("Wallet créé il y a moins de 24 h");
    } else if (age < 7 * DAY) {
      score += 25;
      reasons.push("Wallet créé il y a moins de 7 jours");
    } else if (age < 30 * DAY) {
      score += 10;
      reasons.push("Wallet récent (moins de 30 jours)");
    }
  }

  if (wallet.traded != null) {
    if (wallet.traded <= 1) {
      score += 20;
      reasons.push("Premier et seul marché joué");
    } else if (wallet.traded <= 3) {
      score += 15;
      reasons.push(`Seulement ${wallet.traded} marchés joués`);
    } else if (wallet.traded <= 10) {
      score += 5;
      reasons.push(`Peu de marchés joués (${wallet.traded})`);
    }
  }

  if (t.price <= 0.1) {
    score += 20;
    reasons.push(`Mise sur une issue très improbable (${Math.round(t.price * 100)} %)`);
  } else if (t.price <= 0.25) {
    score += 12;
    reasons.push(`Mise sur une issue peu probable (${Math.round(t.price * 100)} %)`);
  } else if (t.price <= 0.4) {
    score += 5;
    reasons.push(`Mise contre le favori (${Math.round(t.price * 100)} %)`);
  }

  if (t.cash >= 50000) {
    score += 20;
    reasons.push("Mise énorme (≥ 50 000 $)");
  } else if (t.cash >= 10000) {
    score += 12;
    reasons.push("Grosse mise (≥ 10 000 $)");
  } else if (t.cash >= 5000) {
    score += 6;
  }

  if (clusterSize >= 1) {
    score += clusterSize >= 2 ? 15 : 10;
    reasons.push(`${clusterSize + 1} wallets récents ont misé pareil en moins de 2 h`);
  }

  if (endDate) {
    const left = new Date(endDate).getTime() / 1000 - t.ts;
    if (left > 0 && left < 7 * DAY) {
      score += 5;
      reasons.push("Pari placé peu avant l'échéance");
    }
  }

  return { score: Math.min(100, score), reasons };
}

async function fetchRecentTrades(since) {
  const trades = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      takerOnly: "true",
      filterType: "CASH",
      filterAmount: String(MIN_CASH),
    });
    const batch = await getJSON(`${DATA_API}/trades?${params}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    trades.push(...batch);
    const oldest = Math.min(...batch.map((t) => Number(t.timestamp) || Infinity));
    if (oldest < since || batch.length < PAGE_SIZE) break;
  }
  return trades;
}

async function walletInfo(address) {
  const [activity, traded] = await Promise.all([
    getJSON(`${DATA_API}/activity?user=${address}&limit=1&sortBy=TIMESTAMP&sortDirection=ASC`, 2).catch(() => null),
    getJSON(`${DATA_API}/traded?user=${address}`, 2).catch(() => null),
  ]);
  const first = Array.isArray(activity) && activity[0] ? Number(activity[0].timestamp) || null : null;
  const count = traded && Number.isFinite(Number(traded.traded)) ? Number(traded.traded) : null;
  return { first, traded: count, checked: nowSec() };
}

async function main(prev) {
  const now = nowSec();
  const since = Math.max((prev.lastTs ?? 0) - 600, now - DAY);

  // Infos des événements (catégories, échéance) pour enrichir les alertes
  const { events } = await readData("events.json");
  const eventBySlug = new Map(events.map((ev) => [ev.slug, ev]));

  const rawTrades = await fetchRecentTrades(since);
  console.log(`${rawTrades.length} gros paris récupérés depuis ${new Date(since * 1000).toISOString()}`);

  const known = new Set(prev.alerts.map((a) => a.id));
  const trades = [];
  for (const t of rawTrades) {
    const ts = Number(t.timestamp);
    const price = Number(t.price);
    const size = Number(t.size);
    const cash = price * size;
    const id = `${t.transactionHash}:${t.asset}:${t.proxyWallet}`;
    if (!t.proxyWallet || !Number.isFinite(ts) || ts < since || known.has(id)) continue;
    if (t.side !== "BUY" || !(price > 0) || price > 0.85 || cash < MIN_CASH) continue;
    if (NOISE.test(t.title ?? "")) continue;
    known.add(id);
    trades.push({
      id,
      ts,
      wallet: String(t.proxyWallet).toLowerCase(),
      name: t.pseudonym || t.name || "",
      conditionId: t.conditionId ?? "",
      outcomeIndex: Number(t.outcomeIndex ?? 0),
      outcome: t.outcome ?? "",
      title: t.title ?? "",
      eventSlug: t.eventSlug ?? "",
      icon: t.icon ?? "",
      price,
      cash: Math.round(cash),
      tx: t.transactionHash ?? "",
    });
  }
  console.log(`${trades.length} nouveaux paris à analyser`);

  const wallets = { ...prev.wallets };
  const toFetch = [...new Set(trades.map((t) => t.wallet))].filter(
    (w) => !wallets[w] || now - wallets[w].checked > WALLET_TTL
  );
  await mapLimit(toFetch, 4, async (w) => {
    wallets[w] = await walletInfo(w);
  });
  console.log(`${toFetch.length} wallets analysés`);

  const isFresh = (t) => {
    const w = wallets[t.wallet];
    return w?.first && t.ts - w.first < 7 * DAY;
  };

  // Paris récents (nouveaux + alertes déjà connues) pour repérer les groupes
  // de wallets qui misent la même chose au même moment.
  const recent = [...trades, ...prev.alerts.filter((a) => a.walletAge != null && a.walletAge < 7 * DAY)];

  const fresh = [];
  for (const t of trades) {
    const cluster = new Set(
      recent
        .filter(
          (o) =>
            o.wallet !== t.wallet &&
            o.conditionId === t.conditionId &&
            o.outcomeIndex === t.outcomeIndex &&
            Math.abs(o.ts - t.ts) <= CLUSTER_WINDOW &&
            (o.walletAge != null ? o.walletAge < 7 * DAY : isFresh(o))
        )
        .map((o) => o.wallet)
    ).size;

    const ev = eventBySlug.get(t.eventSlug);
    const w = wallets[t.wallet] ?? {};
    const { score, reasons } = scoreTrade(t, w, cluster, ev?.endDate);
    if (score < MIN_SCORE) continue;

    fresh.push({
      ...t,
      score,
      reasons,
      walletAge: w.first ? t.ts - w.first : null,
      walletMarkets: w.traded ?? null,
      eventTitle: ev?.title ?? "",
      eventId: ev?.id ?? "",
      tags: ev ? ev.tags.map((tag) => tag.slug) : [],
    });
  }
  console.log(`${fresh.length} nouvelles alertes`);

  const alerts = [...fresh, ...prev.alerts]
    .filter((a) => now - a.ts < KEEP_ALERTS_FOR)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ALERTS);

  for (const [w, info] of Object.entries(wallets)) {
    if (now - info.checked > KEEP_ALERTS_FOR) delete wallets[w];
  }

  const lastTs = Math.max(prev.lastTs ?? 0, ...trades.map((t) => t.ts));
  return { updatedAt: new Date().toISOString(), lastTs, alerts, wallets };
}

const prev = (await loadPrevious("alerts.json")) ?? {};
prev.alerts ??= [];
prev.wallets ??= {};

try {
  await writeData("alerts.json", await main(prev));
} catch (err) {
  // En cas de panne de l'API, on republie les alertes précédentes plutôt
  // que de tout perdre.
  console.log(`::warning::Détection des alertes échouée : ${err.message}`);
  await writeData("alerts.json", { updatedAt: prev.updatedAt ?? null, lastTs: prev.lastTs ?? 0, ...prev });
}
