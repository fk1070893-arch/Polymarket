// Sport : rapprochement entre les matchs Polymarket et les cotes des
// bookmakers (The Odds API). Calculs séparés du réseau pour les tester.

const STOP = new Set(["fc", "cf", "afc", "sc", "ac", "cd", "ud", "sv", "fk", "bk", "club", "the", "calcio", "de", "cfc", "if", "ss", "as"]);
const ALIAS = {
  man: ["manchester"],
  utd: ["united"],
  st: ["saint"],
  la: ["los", "angeles"],
  ny: ["new", "york"],
  nyc: ["new", "york", "city"],
  psg: ["paris", "saint", "germain"],
  spurs: ["tottenham", "hotspur"],
  wolves: ["wolverhampton", "wanderers"],
};

// "Manchester Utd FC" -> ["manchester", "united"]
export function teamTokens(name) {
  const base = String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (const t of base) {
    if (STOP.has(t)) continue;
    out.push(...(ALIAS[t] ?? [t]));
  }
  return out;
}

// Même équipe si les mots de l'un sont tous dans l'autre
// ("Chiefs" / "Kansas City Chiefs", "Man City" / "Manchester City")
export function sameTeam(a, b) {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (!ta.length || !tb.length) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  return ta.every((t) => sb.has(t)) || tb.every((t) => sa.has(t));
}

// "NFL: Chiefs vs. Bills" -> ["Chiefs", "Bills"]
export function titleTeams(title) {
  const t = String(title ?? "").replace(/^[^:]{1,40}:\s*/, "");
  const parts = t.split(/\s+(?:vs\.?|v\.?|@|at)\s+/i);
  if (parts.length !== 2) return null;
  return parts.map((p) => p.replace(/\s*\(.*\)\s*$/, "").trim());
}

// Cotes décimales d'un bookmaker -> probabilités sans la marge
export function devig(outcomes) {
  const inv = outcomes.map((o) => (o.price > 1 ? 1 / o.price : 0));
  const sum = inv.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || inv.some((v) => v === 0)) return null;
  return Object.fromEntries(outcomes.map((o, i) => [o.name, inv[i] / sum]));
}

const SHARP = ["pinnacle", "betfair_ex_eu", "matchbook"];

// Probabilités d'un match : Pinnacle (le bookmaker de référence) si
// disponible, sinon la moyenne des bookmakers présents.
export function gameProbs(game) {
  const books = (game.bookmakers ?? [])
    .map((b) => ({ key: b.key, probs: devig(b.markets?.find((m) => m.key === "h2h")?.outcomes ?? []) }))
    .filter((b) => b.probs);
  if (!books.length) return null;
  for (const k of SHARP) {
    const b = books.find((x) => x.key === k);
    if (b) return { source: k, probs: b.probs };
  }
  const names = Object.keys(books[0].probs);
  const probs = {};
  for (const n of names) {
    const vals = books.map((b) => b.probs[n]).filter((v) => v != null);
    probs[n] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return { source: `moyenne de ${books.length} bookmakers`, probs };
}

// Le titre de l'événement Polymarket désigne-t-il ce match ?
export function sameGame(title, game) {
  const teams = titleTeams(title);
  if (!teams) return false;
  const [a, b] = teams;
  return (sameTeam(a, game.home) && sameTeam(b, game.away)) || (sameTeam(a, game.away) && sameTeam(b, game.home));
}

// Marchés annexes (handicap, nombre de points, mi-temps…) : pas comparables
const NOT_WINNER = /spread|handicap|o\/u|\bover\b|\bunder\b|total|half|quarter|period|inning|\bset\b|\bmap\b|[(][+-]|by \d|points|goals|rounds|corners|cards|score|\b1h\b|\b2h\b|both teams/i;

// Pour un marché Polymarket d'un match reconnu, nom de l'issue bookmaker
// correspondant à chacune de ses deux issues (null si pas comparable).
export function marketTargets(raw, outcomes, game, bookNames) {
  if (raw.sportsMarketType && raw.sportsMarketType !== "moneyline") return null;
  const question = String(raw.question ?? "");
  if (NOT_WINNER.test(question)) return null;
  const teams = [game.home, game.away];
  const hasDraw = bookNames.some((n) => /^draw$/i.test(n));
  const yesNo = outcomes.length === 2 && /^yes$/i.test(outcomes[0]) && /^no$/i.test(outcomes[1]);
  if (yesNo) {
    // "Will Arsenal win?" / "Will Arsenal vs. Chelsea end in a draw?"
    if (/\bdraw\b|\btie\b/i.test(question)) return hasDraw ? { yes: "Draw" } : null;
    const label = raw.groupItemTitle || (question.match(/^will (.+?) win\b/i)?.[1] ?? "");
    const hits = teams.filter((t) => label && sameTeam(label, t));
    return hits.length === 1 ? { yes: hits[0] } : null;
  }
  // Deux équipes : impossible si le match peut finir nul
  if (hasDraw || outcomes.length !== 2) return null;
  const map = outcomes.map((o) => teams.filter((t) => sameTeam(o, t)));
  if (map.some((h) => h.length !== 1) || map[0][0] === map[1][0]) return null;
  return { teams: [map[0][0], map[1][0]] };
}

// Probabilité bookmaker de chaque issue Polymarket : [p0, p1]
export function sideProbs(targets, probs) {
  if (!targets || !probs) return null;
  if (targets.yes) {
    const p = probs[targets.yes];
    return p == null ? null : [p, 1 - p];
  }
  const p0 = probs[targets.teams[0]];
  const p1 = probs[targets.teams[1]];
  return p0 == null || p1 == null ? null : [p0, p1];
}
