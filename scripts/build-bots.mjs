// Arène de bots : plusieurs robots fictifs, chacun avec une règle simple
// branchée sur un signal du site (alertes, traders, bookmakers, Kalshi,
// modèle crypto, mouvements de prix, favoris). Chacun mise 1 $ par signal
// (prix réel pour une mise de 100 $ : carnet d'ordres et frais), au plus
// une fois par issue. Le but : comparer, sur les mêmes marchés et la même
// période, ce qui rapporte vraiment.
// État : .state/bots-state.json ; résumé : site/data/bots.json
//
// BOTS_FAST=1 : passage rapide (toutes les minutes) — seuls les bots qui
// suivent les alertes et les traders cherchent de nouveaux paris, sans
// régler les anciens.
//
// Usage : node scripts/build-bots.mjs (après les autres étapes du passage)

import { normalizeMarket } from "../site/js/normalize.js";
import { loadState, mapLimit, readData, universeEvents, writeState } from "./lib.mjs";
import { paperStats, pnlCurve, realCost, settleBets } from "./paper.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const KEEP_FOR = 60 * DAY;
const NEW_PER_BOT = 8; // nouveaux paris au plus par bot et par passage
const FAST = process.env.BOTS_FAST === "1";

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

const now = Date.now();

// ---------- Les marchés ouverts, lus une fois en début de passage ----------

const byId = new Map();
const byCondition = new Map();
const universe = (await universeEvents()) ?? [];
for (const ev of universe) {
  for (const raw of ev.markets ?? []) {
    const hit = { raw, ev };
    byId.set(String(raw.id), hit);
    if (raw.conditionId) byCondition.set(raw.conditionId, hit);
  }
}

// ---------- Les signaux ----------

const alerts = (await readData("alerts.json").catch(() => null))?.alerts ?? [];
const freshAlerts = alerts.filter((a) => a.conditionId && now - a.ts * 1000 < 45 * 60000);
const binary = (hit) => {
  try {
    const o = Array.isArray(hit.raw.outcomes) ? hit.raw.outcomes : JSON.parse(hit.raw.outcomes ?? "[]");
    return o.length === 2;
  } catch {
    return false;
  }
};

const alertPick = (a, extra = {}) => ({ conditionId: a.conditionId, side: a.outcomeIndex, strength: a.score / 100, note: `alerte ${a.score}/100, ${Math.round(a.cash)} $ à ${Math.round(a.price * 100)} ¢`, ...extra });

// Les bots : { key, name, about, family, fast, pick() -> [{ marketId | conditionId, side, strength, note }] }
const BOTS = [
  {
    key: "copie70",
    name: "Copie des alertes 70+",
    family: "Alertes",
    about: "Achète la même issue que chaque alerte de score 70 et plus, dès que le site la voit.",
    fast: true,
    pick: () => freshAlerts.filter((a) => a.score >= 70).map((a) => alertPick(a)),
  },
  {
    key: "copieGros",
    name: "Copie des grosses mises",
    family: "Alertes",
    about: "Suit les alertes où le wallet suspect a misé 10 000 $ ou plus, quel que soit le score.",
    fast: true,
    pick: () => freshAlerts.filter((a) => a.cash >= 10000).map((a) => alertPick(a, { strength: a.cash / 1e6 })),
  },
  {
    key: "copieOutsider",
    name: "Copie des paris sur un outsider",
    family: "Alertes",
    about: "Suit les alertes (score 50+) sur une issue à moins de 30 ¢ : le pari suspect le plus « informé » en théorie.",
    fast: true,
    pick: () => freshAlerts.filter((a) => a.score >= 50 && a.price > 0 && a.price < 0.3).map((a) => alertPick(a)),
  },
  {
    key: "copieFavori",
    name: "Copie des paris sur un favori",
    family: "Alertes",
    about: "Suit les alertes (score 50+) sur une issue à 70 ¢ ou plus.",
    fast: true,
    pick: () => freshAlerts.filter((a) => a.score >= 50 && a.price >= 0.7).map((a) => alertPick(a)),
  },
  {
    key: "consensus",
    name: "Plusieurs wallets suspects d'accord",
    family: "Alertes",
    about: "Achète quand au moins 2 wallets différents déclenchent une alerte sur la même issue en 6 heures.",
    fast: true,
    pick: () => {
      const groups = new Map();
      for (const a of alerts) {
        if (!a.conditionId || now - a.ts * 1000 > 6 * HOUR) continue;
        const k = `${a.conditionId}:${a.outcomeIndex}`;
        if (!groups.has(k)) groups.set(k, { a, wallets: new Set() });
        groups.get(k).wallets.add(a.wallet);
      }
      return [...groups.values()]
        .filter((g) => g.wallets.size >= 2)
        .map((g) => alertPick(g.a, { strength: g.wallets.size, note: `${g.wallets.size} wallets suspects sur la même issue` }));
    },
  },
  {
    key: "contre",
    name: "Contre les alertes 70+",
    family: "Alertes",
    about: "Fait l'inverse des alertes 70+ (marchés à deux issues) : teste si les « initiés » se trompent plus qu'on ne croit.",
    fast: true,
    pick: () =>
      freshAlerts
        .filter((a) => a.score >= 70 && byCondition.has(a.conditionId) && binary(byCondition.get(a.conditionId)))
        .map((a) => alertPick(a, { side: 1 - a.outcomeIndex, note: `inverse d'une alerte ${a.score}/100` })),
  },
  {
    key: "traders",
    name: "Copie des meilleurs traders",
    family: "Traders",
    about: "Copie les achats (500 $ et plus, dernière heure) des 10 meilleurs traders de la semaine sur Polymarket.",
    fast: true,
    pick: async () => {
      const lb = await readData("leaders.json").catch(() => null);
      const top = new Set((lb?.week ?? []).slice(0, 10).map((r) => r.wallet));
      const out = [];
      for (const [wallet, trades] of Object.entries(lb?.trades ?? {})) {
        if (!top.has(wallet)) continue;
        for (const t of trades) {
          if (t.side !== "BUY" || !t.conditionId || !t.ts || now - t.ts * 1000 > HOUR || t.cash < 500) continue;
          const hit = byCondition.get(t.conditionId);
          if (!hit) continue;
          const side = normalizeMarket(hit.raw).outcomes.indexOf(t.outcome);
          if (side < 0) continue;
          out.push({ conditionId: t.conditionId, side, strength: t.cash / 1e5, note: `trader du top 10 : ${Math.round(t.cash)} $ à ${Math.round((t.price ?? 0) * 100)} ¢` });
        }
      }
      return out;
    },
  },
  {
    key: "bookmakers",
    name: "Moins cher que les bookmakers (3 pts)",
    family: "Sources externes",
    about: "Achète quand Polymarket vend une issue sport au moins 3 points moins cher que la probabilité Pinnacle (sans sa marge).",
    pick: async () => {
      const odds = await readData("odds.json").catch(() => null);
      return (odds?.rows ?? [])
        .filter((r) => r.edge != null && r.edge >= 0.03 && r.commence > now)
        .map((r) => ({ marketId: r.marketId, side: r.side, strength: r.edge, note: `bookmakers ${Math.round(r.book * 100)} %, Polymarket ${Math.round((r.ask ?? 0) * 100)} ¢` }));
    },
  },
  {
    key: "kalshi",
    name: "Moins cher que Kalshi (3 pts)",
    family: "Sources externes",
    about: "Achète quand Polymarket vend une issue au moins 3 points moins cher que Kalshi, sur une question très ressemblante (70 %+).",
    pick: async () => {
      const cross = await readData("cross.json").catch(() => null);
      return (cross?.pairs ?? [])
        .filter((p) => p.edge != null && p.edge >= 0.03 && p.sim >= 0.7)
        .map((p) => ({ marketId: p.marketId, side: p.side, strength: p.edge, note: `Kalshi ${Math.round(p.kalshi.mid * 100)} % pour « Oui »` }));
    },
  },
  {
    key: "crypto",
    name: "Modèle crypto (10 pts d'écart)",
    family: "Sources externes",
    about: "Suit le modèle des options Deribit quand il s'écarte d'au moins 10 points du prix Polymarket.",
    pick: async () => {
      const c = await readData("crypto.json").catch(() => null);
      return (c?.markets ?? [])
        .filter((m) => Math.abs(m.edge) >= 0.1)
        .map((m) => ({ marketId: m.marketId, side: m.edge > 0 ? 0 : 1, strength: Math.abs(m.edge), note: `modèle ${Math.round(m.model * 100)} %, Polymarket ${Math.round(m.poly * 100)} %` }));
    },
  },
  {
    key: "momentum",
    name: "Suivre la tendance",
    family: "Mouvements de prix",
    about: "Après une hausse d'au moins 15 points en 24 h (prix entre 20 et 80 %), achète l'issue qui monte.",
    pick: () => moves().map((m) => ({ ...m, side: m.up ? 0 : 1, note: `${m.up ? "+" : "−"}${Math.round(Math.abs(m.change) * 100)} pts en 24 h` })),
  },
  {
    key: "retour",
    name: "Parier sur un retour en arrière",
    family: "Mouvements de prix",
    about: "Après une hausse d'au moins 15 points en 24 h, achète l'issue qui vient de baisser (l'inverse du bot « tendance »).",
    pick: () => moves().map((m) => ({ ...m, side: m.up ? 1 : 0, note: `retour après ${m.up ? "+" : "−"}${Math.round(Math.abs(m.change) * 100)} pts en 24 h` })),
  },
  {
    key: "favori",
    name: "Favoris proches de la fin",
    family: "Favoris et outsiders",
    about: "Achète le favori (85 à 95 %) des marchés à deux issues qui se terminent dans 2 à 48 heures (10 000 $ échangés au moins).",
    pick: () => nearEnd().map((m) => ({ marketId: m.id, side: m.fav, strength: m.volume / 1e7, note: `favori à ${Math.round(m.p * 100)} %` })),
  },
  {
    key: "outsider",
    name: "Outsiders proches de la fin",
    family: "Favoris et outsiders",
    about: "Achète l'outsider (5 à 15 %) des mêmes marchés : l'inverse du bot « favoris ».",
    pick: () => nearEnd().map((m) => ({ marketId: m.id, side: 1 - m.fav, strength: m.volume / 1e7, note: `outsider à ${Math.round((1 - m.p) * 100)} %` })),
  },
];

// Marchés qui ont bougé d'au moins 15 points en 24 h (prix actuel 20-80 %)
let movesCache = null;
function moves() {
  if (movesCache) return movesCache;
  movesCache = [];
  for (const [id, { raw }] of byId) {
    const change = num(raw.oneDayPriceChange);
    if (change == null || Math.abs(change) < 0.15) continue;
    const m = normalizeMarket(raw);
    if (m.outcomes.length !== 2 || !(m.prices[0] >= 0.2 && m.prices[0] <= 0.8) || m.volume < 5000) continue;
    movesCache.push({ marketId: id, up: change > 0, change, strength: Math.abs(change) });
  }
  return movesCache;
}

// Marchés à deux issues qui se terminent dans 2 à 48 h, avec un favori à 85-95 %
let nearCache = null;
function nearEnd() {
  if (nearCache) return nearCache;
  nearCache = [];
  for (const [id, { raw, ev }] of byId) {
    const end = Date.parse(raw.endDate ?? ev.endDate ?? "");
    if (!(end - now >= 2 * HOUR && end - now <= 48 * HOUR)) continue;
    const m = normalizeMarket(raw);
    if (m.outcomes.length !== 2 || m.volume < 10000) continue;
    const fav = m.prices[0] >= m.prices[1] ? 0 : 1;
    const p = m.prices[fav];
    if (p >= 0.85 && p <= 0.95) nearCache.push({ id, fav, p, volume: m.volume });
  }
  return nearCache;
}

// ---------- Programme principal ----------

async function main(prev) {
  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR);
  const taken = new Set(bets.map((b) => `${b.bot}:${b.marketId}:${b.side}`));
  const costCache = new Map(); // un seul carnet lu par issue et par passage
  const added = {};

  for (const bot of BOTS) {
    if (FAST && !bot.fast) continue;
    let picks = [];
    try {
      picks = (await bot.pick()) ?? [];
    } catch (err) {
      console.log(`::warning::Bot ${bot.name} : signal illisible (${err.message})`);
      continue;
    }
    const todo = [];
    for (const p of picks.sort((a, b) => b.strength - a.strength)) {
      const hit = p.marketId != null ? byId.get(String(p.marketId)) : byCondition.get(p.conditionId);
      if (!hit || !(p.side === 0 || p.side === 1)) continue;
      const key = `${bot.key}:${hit.raw.id}:${p.side}`;
      if (taken.has(key)) continue;
      const end = Date.parse(hit.raw.endDate ?? hit.ev.endDate ?? "");
      if (Number.isFinite(end) && end < now) continue;
      if (hit.raw.closed === true || hit.raw.acceptingOrders === false) continue;
      taken.add(key);
      todo.push({ p, hit, end });
      if (todo.length >= NEW_PER_BOT) break;
    }
    const placed = await mapLimit(todo, 6, async ({ p, hit, end }) => {
      const ck = `${hit.raw.id}:${p.side}`;
      if (!costCache.has(ck)) costCache.set(ck, realCost(hit.raw, p.side).catch(() => null));
      const rc = await costCache.get(ck);
      // Prix trop extrêmes : rien à gagner ou carnet vide
      if (!rc || !(rc.cost > 0.02 && rc.cost < 0.97)) return null;
      const m = normalizeMarket(hit.raw);
      return {
        bot: bot.key,
        id: `${bot.key}:${hit.raw.id}:${p.side}`,
        marketId: String(hit.raw.id),
        event: String(hit.ev.id),
        eventTitle: hit.ev.title ?? "",
        slug: hit.ev.slug ?? "",
        question: m.question,
        outcome: m.outcomes[p.side] ?? "",
        side: p.side,
        mid: m.prices[p.side] ?? null,
        cost: rc.cost,
        best: rc.best,
        fee: rc.fee,
        slippage: rc.slippage,
        filled: rc.filled,
        ladder: rc.ladder ?? null,
        hold: rc.hold ?? 0,
        note: p.note,
        placedAt: now,
        end: Number.isFinite(end) ? end : null,
      };
    });
    const ok = placed.filter(Boolean);
    bets.push(...ok);
    added[bot.key] = ok.length;
  }

  if (!FAST) await settleBets(bets, now, { max: 400 });
  bets.sort((a, b) => b.placedAt - a.placedAt);

  const view = { updatedAt: new Date(now).toISOString(), bots: [] };
  BOTS.forEach((bot, i) => {
    const mine = bets.filter((b) => b.bot === bot.key);
    const settled = mine.filter((b) => b.won != null);
    view.bots.push({
      key: bot.key,
      name: bot.name,
      family: bot.family,
      about: bot.about,
      summary: { ...paperStats(settled, { seed: 101 + i }), pending: mine.length - settled.length, total: mine.length },
      curve: pnlCurve(settled),
      recent: mine.slice(0, 12).map(({ ladder, best, filled, ...b }) => b),
    });
  });
  const line = BOTS.filter((b) => added[b.key] != null)
    .map((b) => `${b.key} +${added[b.key]}`)
    .join(", ");
  console.log(`Bots${FAST ? " (passage rapide)" : ""} : ${line || "aucun"} · ${bets.length} paris en mémoire, ${bets.filter((b) => b.won != null).length} réglés`);
  return { state: { bets }, view };
}

const prev = (await loadState("bots")) ?? {};
try {
  const { state, view } = await main(prev);
  await writeState("bots", state, view);
} catch (err) {
  console.log(`::warning::Arène des bots en échec : ${err.message}`);
}
