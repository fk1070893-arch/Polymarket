// Sport : Polymarket comparé aux bookmakers.
//
// Les cotes des bookmakers « pros » (Pinnacle en tête) sont la meilleure
// estimation connue des chances d'un match. On les récupère via The Odds
// API, on retire leur marge, et on compare au prix auquel on pourrait
// acheter sur Polymarket. Quand Polymarket est nettement moins cher, on
// enregistre un pari fictif de 1 $, réglé à la fin du match. On garde aussi
// les deux probabilités juste avant chaque match pour voir, avec le temps,
// laquelle se trompe le moins.
//
// Nécessite une clé gratuite The Odds API dans le secret GitHub
// ODDS_API_KEY. La clé n'est jamais écrite dans les logs ni dans les
// fichiers publiés. Le quota gratuit (500 requêtes / mois) est réparti sur
// le mois : une ligue est rafraîchie à la fois.
// Résultat : site/data/odds.json

import { normalizeMarket } from "../site/js/normalize.js";
import { parseTime } from "./backtest-lib.mjs";
import { allEventsBetween, loadState, writeState } from "./lib.mjs";
import { gameProbs, marketTargets, sameGame, sideProbs } from "./odds-lib.mjs";
import { askPrices, paperStats, pnlCurve, settleBets } from "./paper.mjs";

const ODDS = "https://api.the-odds-api.com/v4";
// Un espace ou un retour à la ligne collé avec la clé la ferait refuser
const KEY = (process.env.ODDS_API_KEY ?? "").trim();
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN_EDGE = 0.03; // Polymarket au moins 3 pts moins cher que les bookmakers
const MAX_ODDS_AGE = 3 * HOUR; // cotes trop vieilles : pas de pari
const BET_WINDOW = 24 * HOUR; // on parie dans les 24 h avant le match
const MAX_COST = 0.95;
const GAME_LENGTH = 4 * HOUR; // pour savoir quand chercher le résultat
const KEEP_FOR = 180 * DAY;
const MAX_TRACK = 3000;

// Ligues suivies, par ordre de priorité (clés The Odds API)
const WANTED = [
  "americanfootball_nfl",
  "basketball_nba",
  "soccer_epl",
  "soccer_uefa_champs_league",
  "icehockey_nhl",
  "baseball_mlb",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "americanfootball_ncaaf",
  "mma_mixed_martial_arts",
  "soccer_uefa_europa_league",
  "basketball_ncaab",
  "basketball_euroleague",
  // Ligues secondaires : moins surveillées sur Polymarket
  "soccer_netherlands_eredivisie",
  "soccer_portugal_primeira_liga",
  "soccer_usa_mls",
  "soccer_brazil_campeonato",
  "soccer_mexico_ligamx",
  "soccer_turkey_super_league",
];
// Tournois de tennis en cours (leur clé change à chaque tournoi)
const TENNIS = /^tennis_(atp|wta)_/;

// Appel à The Odds API sans jamais laisser la clé apparaître dans une erreur
const quota = { remaining: null, used: null };
async function odds(path, params = {}) {
  const qs = new URLSearchParams({ ...params, apiKey: KEY });
  let res;
  try {
    res = await fetch(`${ODDS}${path}?${qs}`, { headers: { accept: "application/json" } });
  } catch {
    throw new Error(`The Odds API injoignable (${path})`);
  }
  const rem = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  if (rem != null) quota.remaining = Number(rem);
  if (used != null) quota.used = Number(used);
  if (!res.ok) throw new Error(`The Odds API : HTTP ${res.status} sur ${path}`);
  return res.json();
}

// Combien de requêtes par jour pour tenir jusqu'à la fin du mois
function dailyBudget(remaining, now) {
  const d = new Date(now);
  const daysLeft = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) - now;
  return Math.max(1, Math.floor((remaining - 10) / Math.max(1, daysLeft / DAY)));
}

// Rafraîchit au plus une ligue, si le quota le permet
async function refreshOdds(state, now) {
  if (!KEY) return "pas de clé ODDS_API_KEY : comparaison désactivée";
  const remaining = state.quota?.remaining ?? 500;
  const budget = dailyBudget(remaining, now);
  const gap = DAY / budget;
  if (remaining <= 10) return `quota épuisé (${remaining} requêtes restantes)`;
  if (state.lastCall && now - state.lastCall < gap) {
    return `prochaine requête dans ${Math.round((gap - (now - state.lastCall)) / 60000)} min (budget ${budget}/jour, ${remaining} restantes)`;
  }

  // La liste des ligues ne consomme pas de quota
  const active = new Set((await odds("/sports")).filter((s) => s.active && !s.has_outrights).map((s) => s.key));
  const leagues = [...WANTED.filter((k) => active.has(k)), ...[...active].filter((k) => TENNIS.test(k))];
  if (!leagues.length) return "aucune ligue suivie en saison";
  // La ligue la moins fraîche, en sautant celles sans match à venir
  // (revues tous les 3 jours seulement)
  const cache = state.odds ?? {};
  const score = (k) => {
    const c = cache[k];
    if (!c) return Infinity;
    const age = now - c.fetchedAt;
    const upcoming = c.games.some((g) => g.commence > now && g.commence - now < 2 * DAY);
    return upcoming ? age : age > 3 * DAY ? age / 3 : -1;
  };
  const pick = leagues.map((k, i) => ({ k, s: score(k), i })).sort((a, b) => b.s - a.s || a.i - b.i)[0];
  if (pick.s < 0) return "aucune ligue à rafraîchir";

  const games = await odds(`/sports/${pick.k}/odds`, { regions: "eu", markets: "h2h", oddsFormat: "decimal" });
  state.lastCall = now;
  cache[pick.k] = {
    fetchedAt: now,
    games: games
      .map((g) => {
        const gp = gameProbs(g);
        return gp && { id: g.id, commence: parseTime(g.commence_time), home: g.home_team, away: g.away_team, probs: gp.probs, source: gp.source };
      })
      .filter(Boolean),
  };
  state.odds = cache;
  state.quota = { remaining: quota.remaining ?? remaining - 1, used: quota.used, at: now };
  return `${pick.k} : ${cache[pick.k].games.length} matchs (${state.quota.remaining} requêtes restantes)`;
}

// Tous les événements sport Polymarket des 4 prochains jours
async function polyGames(now) {
  return allEventsBetween({ tag_slug: "sports", active: "true", closed: "false" }, now, now + 4 * DAY);
}

function compare(state, events, now) {
  const games = Object.values(state.odds ?? {}).flatMap((c) => c.games.map((g) => ({ ...g, fetchedAt: c.fetchedAt })));
  const upcoming = games.filter((g) => g.commence > now - GAME_LENGTH && g.commence < now + 3 * DAY);
  const rows = [];
  let matched = 0;
  for (const g of upcoming) {
    const evs = events.filter((ev) => {
      const start = parseTime(ev.startTime) ?? parseTime(ev.markets?.[0]?.gameStartTime) ?? parseTime(ev.endDate);
      return start != null && Math.abs(start - g.commence) < 12 * HOUR && sameGame(ev.title, g);
    });
    if (evs.length) matched++;
    const names = Object.keys(g.probs);
    for (const ev of evs) {
      for (const raw of ev.markets ?? []) {
        const m = normalizeMarket(raw);
        if (m.closed || !m.active || m.outcomes.length !== 2) continue;
        const probs = sideProbs(marketTargets(raw, m.outcomes, g, names), g.probs);
        if (!probs) continue;
        const asks = askPrices(raw);
        for (const side of [0, 1]) {
          rows.push({
            marketId: m.id,
            event: String(ev.id),
            eventTitle: ev.title ?? "",
            slug: ev.slug ?? "",
            question: m.question,
            outcome: m.outcomes[side],
            side,
            book: probs[side],
            source: g.source,
            mid: m.prices[side] ?? null,
            ask: asks[side],
            edge: asks[side] != null ? probs[side] - asks[side] : null,
            commence: g.commence,
            oddsAge: now - g.fetchedAt,
          });
        }
      }
    }
  }
  return { rows, matched, upcoming: upcoming.length };
}

async function main(prev) {
  const now = Date.now();
  const state = { odds: prev.state?.odds ?? {}, quota: prev.state?.quota ?? null, lastCall: prev.state?.lastCall ?? 0 };
  // Supprime les matchs terminés depuis longtemps
  for (const c of Object.values(state.odds)) c.games = c.games.filter((g) => g.commence > now - DAY);

  let status;
  try {
    status = await refreshOdds(state, now);
  } catch (err) {
    status = `cotes indisponibles (${err.message})`;
  }
  console.log(`Cotes : ${status}`);

  const bets = (prev.bets ?? []).filter((b) => now - b.placedAt < KEEP_FOR);
  const track = prev.track ?? [];
  let rows = [];
  if (Object.keys(state.odds).length) {
    const events = await polyGames(now);
    const cmp = compare(state, events, now);
    rows = cmp.rows;
    console.log(`${events.length} événements sport Polymarket, ${cmp.upcoming} matchs bookmakers à venir, ${cmp.matched} rapprochés, ${rows.length / 2} marchés comparables`);

    // Paris : le plus gros écart de chaque match, si les cotes sont fraîches
    const known = new Set(bets.map((b) => b.event));
    const best = new Map();
    for (const r of rows) {
      if (r.edge == null || r.edge < MIN_EDGE || r.ask > MAX_COST || r.oddsAge > MAX_ODDS_AGE) continue;
      if (r.commence <= now || r.commence - now > BET_WINDOW || known.has(r.event)) continue;
      if (!best.has(r.event) || best.get(r.event).edge < r.edge) best.set(r.event, r);
    }
    for (const r of best.values()) {
      bets.push({
        id: `${r.marketId}:${r.side}`,
        marketId: r.marketId,
        event: r.event,
        eventTitle: r.eventTitle,
        question: r.question,
        outcome: r.outcome,
        side: r.side,
        book: r.book,
        source: r.source,
        cost: r.ask,
        mid: r.mid,
        edge: r.edge,
        end: r.commence + GAME_LENGTH,
        placedAt: now,
        won: null,
        roi: null,
      });
    }
    console.log(`${best.size} nouveaux paris fictifs`);

    // Suivi de précision : dernières probabilités avant le début du match
    const byId = new Map(track.map((t) => [t.marketId, t]));
    for (const r of rows) {
      if (r.side !== 0 || r.commence <= now || r.mid == null || r.oddsAge > 6 * HOUR) continue;
      const t = byId.get(r.marketId) ?? { marketId: r.marketId, event: r.event, side: 0, won: null, placedAt: now };
      Object.assign(t, { book: r.book, mid: r.mid, end: r.commence + GAME_LENGTH, cost: null });
      byId.set(r.marketId, t);
    }
    track.splice(0, track.length, ...[...byId.values()].filter((t) => now - t.placedAt < KEEP_FOR).slice(-MAX_TRACK));
  }

  await settleBets(bets, now);
  await settleBets(track, now);
  const scored = track.filter((t) => t.won != null);
  const brier = (k) => scored.reduce((s, t) => s + (t[k] - (t.won ? 1 : 0)) ** 2, 0) / scored.length;
  const summary = {
    ...paperStats(bets),
    pending: bets.filter((b) => b.won == null).length,
    accuracy: scored.length ? { n: scored.length, book: brier("book"), poly: brier("mid") } : { n: 0 },
    curve: pnlCurve(bets),
  };

  // Probabilité bookmaker de chaque marché comparable, pour les autres
  // stratégies (ex. : le favori est-il plus cher sur Polymarket ?) :
  // { marketId: [proba issue 0, proba issue 1, date des cotes] }
  const bookByMarket = {};
  for (const r of rows) {
    const e = (bookByMarket[r.marketId] ??= [null, null, now - r.oddsAge]);
    e[r.side] = Math.round(r.book * 1000) / 1000;
  }
  if (summary.n) console.log(`Paris réglés : ${summary.n}, gain/pari ${Math.round(summary.roi * 100)}%`);
  if (summary.accuracy.n) console.log(`Précision sur ${summary.accuracy.n} marchés : Brier bookmakers ${summary.accuracy.book.toFixed(3)} / Polymarket ${summary.accuracy.poly.toFixed(3)}`);

  bets.sort((a, b) => b.placedAt - a.placedAt);
  const base = {
    updatedAt: new Date(now).toISOString(),
    startedAt: prev.startedAt ?? (KEY ? new Date(now).toISOString() : null),
    enabled: Boolean(KEY),
    status,
    rule: {
      description: `Si Polymarket vend une issue au moins ${MIN_EDGE * 100} pts moins cher que la probabilité des bookmakers (sans leur marge), dans les 24 h avant le match et avec des cotes de moins de 3 h : 1 $ fictif sur cette issue, au prix vendeur. Un seul pari par match.`,
      minEdge: MIN_EDGE,
    },
    quota: state.quota,
    rows: rows.filter((r) => r.edge != null).sort((a, b) => b.edge - a.edge).slice(0, 100),
    bookByMarket,
    summary,
  };
  return { state: { ...base, bets, track, state }, view: { ...base, bets: bets.slice(0, 30) } };
}

const prev = await loadState("odds");
try {
  const { state, view } = await main(prev ?? {});
  await writeState("odds", state, view);
} catch (err) {
  console.log(`::warning::Comparaison bookmakers en échec : ${err.message}`);
  if (prev) await writeState("odds", prev, { ...prev, bets: (prev.bets ?? []).slice(0, 30), track: undefined, state: undefined });
}
