// Rapprochement de questions entre sites (Polymarket, Kalshi, Metaculus) :
// la même question n'y est jamais écrite pareil. On compare les mots
// importants, et on refuse toute paire dont les nombres, les années ou le
// sens (« au-dessus » / « en dessous ») diffèrent : mieux vaut rater une
// paire que comparer deux questions différentes.

const STOP = new Set(
  "will the a an be of in on by to and or for at is are was who what which this that with from as it its into does do did has have get gets any before after end there their than".split(" ")
);
const MONTHS = {
  january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul",
  august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec",
};
// Sens de la question : deux questions de sens opposé ne sont jamais la
// même (« la Fed baisse » / « la Fed monte », « au-dessus » / « en dessous »)
const UP = /\b(above|over|more than|higher|at least|exceeds?|greater|or more|raises?|hikes?|increases?|rises?|up)\b/;
const DOWN = /\b(below|under|less than|lower|fewer|or less|cuts?|decreases?|reduces?|drops?|falls?|down)\b/;

function clean(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, "$1$2") // 100,000 -> 100000
    .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Number(n) * 1000))
    .replace(/(\d+(?:\.\d+)?)\s*(m|mn|million)\b/g, (_, n) => String(Number(n) * 1e6))
    .replace(/\bu\.s\.?\b/g, "us")
    .replace(/%/g, " pct ");
}

export function questionTokens(text) {
  return clean(text)
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map((t) => MONTHS[t] ?? t)
    // Pluriels et 3e personne : « cuts » = « cut », « rates » = « rate »
    .map((t) => (t.length > 3 && /[a-rt-z]s$/.test(t) ? t.slice(0, -1) : t))
    .map((t) => (/^\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t));
}

const isYear = (t) => /^(19|20)\d\d$/.test(t);
const isNum = (t) => /^\d+(\.\d+)?$/.test(t);

export function questionInfo(text) {
  const tokens = new Set(questionTokens(text));
  const c = clean(text);
  return {
    tokens,
    years: new Set([...tokens].filter(isYear)),
    numbers: new Set([...tokens].filter((t) => isNum(t) && !isYear(t))),
    // Les deux sens à la fois (« up or down ») : pas de sens
    dir: UP.test(c) && !DOWN.test(c) ? "up" : DOWN.test(c) && !UP.test(c) ? "down" : null,
  };
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Similarité entre 0 et 1 (0 = incompatibles)
export function similarity(a, b) {
  if (a.dir && b.dir && a.dir !== b.dir) return 0;
  if (a.years.size && b.years.size && ![...a.years].some((y) => b.years.has(y))) return 0;
  if ((a.numbers.size || b.numbers.size) && !sameSet(a.numbers, b.numbers)) return 0;
  let inter = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) inter++;
  const union = a.tokens.size + b.tokens.size - inter;
  return union ? inter / union : 0;
}

// Index des questions d'un site pour retrouver vite les candidates
export function buildIndex(items, textOf) {
  const infos = items.map((it) => questionInfo(textOf(it)));
  const byToken = new Map();
  infos.forEach((info, i) => {
    for (const t of info.tokens) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(i);
    }
  });
  return { items, infos, byToken };
}

// Meilleure question de l'index pour `text` : { item, sim } ou null.
// `accept(item)` filtre les candidates (dates compatibles…).
export function bestMatch(index, text, { min = 0.5, accept = () => true, maxPostings = 3000 } = {}) {
  const info = questionInfo(text);
  const counts = new Map();
  for (const t of info.tokens) {
    const list = index.byToken.get(t);
    if (!list || list.length > maxPostings) continue; // mot trop courant : peu informatif
    for (const i of list) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  const candidates = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30);
  let best = null;
  for (const [i] of candidates) {
    if (!accept(index.items[i])) continue;
    const sim = similarity(info, index.infos[i]);
    if (sim >= min && (!best || sim > best.sim)) best = { item: index.items[i], sim };
  }
  return best;
}
