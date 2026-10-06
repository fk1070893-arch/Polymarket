// Pistes : d'où vient l'argent des wallets suspects qui gagnent ?
//
// Un compte Polymarket est un wallet sur la blockchain Polygon : les dollars
// (USDC) qu'il reçoit y sont publics. Pour chaque wallet récent (moins de
// 30 jours) dont les alertes ont gagné, on lit ses premiers dépôts et on
// regarde qui les a envoyés :
//  - une plateforme (échange, pont) : piste froide ;
//  - un autre compte Polymarket : sans doute le compte principal de la
//    même personne (pseudo public, nombre de paris, valeur) ;
//  - une adresse qui a financé plusieurs wallets suspects : probablement
//    une seule personne derrière ces wallets.
// On s'en tient aux adresses et aux pseudos publics Polymarket, jamais à
// l'identité réelle de quelqu'un. Un transfert ne prouve pas que ce soit la
// même personne (ça peut être un paiement).
//
// Source : serveurs publics des blockchains Polygon, Ethereum, Base,
// Arbitrum et Optimism (gratuits, sans clé), à chaque passage.
// Résultat : site/data/wallets.json (mémoire : .state/wallets-state.json)

import { CHAINS, addrOf, makeChain, topicOf } from "./chain-lib.mjs";
import { getJSON, loadState, mapLimit, readData, writeState } from "./lib.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_WALLETS = 10; // nouveaux wallets examinés par passage
const MAX_EXITS = 5; // wallets dont on regarde les retraits par passage
const BUDGET = 120000; // temps maximum de lecture de la blockchain (ms)
const RETRY = HOUR; // nouvel essai après une lecture en échec
const FUNDER_TTL = 7 * DAY;
const MAX_HOPS = 3; // étages remontés au plus derrière un wallet intermédiaire
const FRESH_TXS = 50; // un wallet qui a envoyé si peu de transactions est un simple relais
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const BLOCKSCOUT = "https://polygon.blockscout.com";
// Contrats de Polymarket : l'argent qu'ils envoient vient des paris (ventes,
// gains), pas d'un dépôt
const POLYMARKET_CONTRACTS = new Set([
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", // CTF Exchange
  "0xc5d563a36ae78145c45a50134d48a1215220f80a", // NegRisk CTF Exchange
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296", // NegRisk Adapter
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Conditional Tokens
]);

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const lc = (s) => String(s ?? "").toLowerCase();
const now = Date.now();

// ---------- Lecture des blockchains ----------

const chains = Object.fromEntries(Object.keys(CHAINS).map((k) => [k, makeChain(k)]));
const polygon = chains.polygon;
const OTHER_CHAINS = ["ethereum", "base", "arbitrum", "optimism"];

// Parts de pari envoyées directement par un autre wallet (pas un échange
// sur Polymarket, où c'est le contrat de Polymarket qui fait le transfert)
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
async function sharesReceived(address, fromMs, toMs) {
  const logs = await polygon.scanLogs({ address: CTF, topics: [[TRANSFER_SINGLE, TRANSFER_BATCH], null, null, topicOf(address)] }, fromMs, toMs);
  const out = [];
  for (const l of logs) {
    const operator = addrOf(l.topics[1]);
    const from = addrOf(l.topics[2]);
    // Envoyées par leur propriétaire lui-même, pas par un contrat d'échange
    if (operator !== from || /^0x0+$/.test(from) || POLYMARKET_CONTRACTS.has(operator)) continue;
    // Quantité : 2e mot des données pour TransferSingle (id, valeur), en parts de 1 $
    const value = l.topics[0] === TRANSFER_SINGLE ? Number(BigInt(`0x${l.data.slice(66, 130)}`)) / 1e6 : 0;
    out.push({ from, amount: value, ts: (await polygon.tsOf(l.blockNumber)) * 1000, tx: l.transactionHash });
  }
  return out;
}

// Propriétaire d'un wallet Polymarket de type « Safe » (le wallet qui signe
// ses ordres) : fonction getOwners() du contrat
async function safeOwner(address) {
  const data = await polygon.rpc("eth_call", [{ to: address, data: "0xa0e67e2b" }, "latest"]).catch(() => null);
  // Réponse : position, longueur, puis les adresses (32 octets chacune)
  if (typeof data !== "string" || data.length < 2 + 64 * 3) return null;
  const n = parseInt(data.slice(2 + 64, 2 + 128), 16);
  if (!(n >= 1 && n <= 10)) return null;
  return `0x${data.slice(2 + 128 + 24, 2 + 192)}`.toLowerCase();
}

// Ce qu'on sait d'une adresse sur une blockchain : contrat ou non, nombre de
// transactions envoyées (une plateforme en a des centaines de milliers), et
// son nom public sur l'explorateur Blockscout de Polygon quand il répond
async function addressInfo(address, chain) {
  const [contract, txs, info] = await Promise.all([
    chain.isContract(address),
    chain.nonce(address),
    chain === polygon ? getJSON(`${BLOCKSCOUT}/api/v2/addresses/${address}`, 1).catch(() => null) : null,
  ]);
  const tags = [info?.name, ...(info?.public_tags ?? []).map((t) => t.display_name ?? t.label), ...(info?.metadata?.tags ?? []).map((t) => t.name)].filter(Boolean);
  return { label: tags[0] ?? null, contract: info?.is_contract === true || contract, txs };
}

// Compte Polymarket lié à une adresse (pseudo public, wallet de jeu)
async function polymarketProfile(address) {
  const p = await getJSON(`${GAMMA}/public-profile?address=${address}`, 1).catch(() => null);
  if (!p || (!p.proxyWallet && !p.name && !p.pseudonym)) return null;
  const proxy = lc(p.proxyWallet || address);
  const [value, trades] = await Promise.all([
    getJSON(`${DATA_API}/value?user=${proxy}`, 1).catch(() => null),
    getJSON(`${DATA_API}/trades?user=${proxy}&limit=500&takerOnly=false`, 1).catch(() => null),
  ]);
  const v = Array.isArray(value) ? num(value[0]?.value) : num(value?.value);
  const list = Array.isArray(trades) ? trades : [];
  const first = list.reduce((m, t) => Math.min(m, Number(t.timestamp) || Infinity), Infinity);
  return {
    name: p.name || p.pseudonym || "",
    proxy,
    value: v != null ? Math.round(v) : null,
    trades: list.length,
    since: Number.isFinite(first) ? first * 1000 : null,
  };
}

function kindOf(info, pm) {
  if (pm) return "polymarket";
  if (info.label || (info.txs != null && info.txs > 5000)) return "plateforme";
  if (info.contract) return "contrat";
  // Un wallet neuf qui n'a presque rien fait d'autre : simple relais, on remonte
  if (info.txs != null && info.txs <= FRESH_TXS) return "relais";
  return "wallet";
}

// ---------- Remonter l'argent ----------

let funders = {}; // adresse (ou « chaîne:adresse » hors Polygon) -> { at, label, kind, txs, pm, contract }
const keyOf = (address, chain = polygon) => (chain === polygon ? address : `${chain.key}:${address}`);
const infoOf = (address, chain = polygon) => funders[keyOf(address, chain)] ?? {};

async function describe(address, chain = polygon) {
  const k = keyOf(address, chain);
  if (!funders[k]) {
    const [info, pm] = await Promise.all([addressInfo(address, chain), polymarketProfile(address)]);
    funders[k] = { at: now, ...info, pm, kind: kindOf(info, pm) };
  }
  return funders[k];
}

// Qui a envoyé des dollars (ou, sur Polygon, des parts de pari) à `address`
// dans une des fenêtres de temps [début, fin] (ms), essayées dans l'ordre
// jusqu'à trouver quelque chose : jusqu'à 5 expéditeurs, les plus anciens d'abord
async function fundersOf(address, windows, chain = polygon) {
  for (const [fromMs, toMs] of windows) {
    if (!(toMs > fromMs)) continue;
    const incoming = new Map();
    const add = (t, via) => {
      const from = t.from;
      if (from === address || POLYMARKET_CONTRACTS.has(from) || /^0x0+$/.test(from)) return;
      if (!incoming.has(from)) incoming.set(from, { address: from, amount: 0, count: 0, first: t.ts, tx: t.tx, via, chain: chain.key });
      const f = incoming.get(from);
      f.amount += t.amount;
      f.count++;
      f.first = Math.min(f.first, t.ts);
    };
    for (const t of await chain.stableTransfers(address, "in", fromMs, toMs)) add(t, "dollars");
    if (chain === polygon) for (const t of await sharesReceived(address, fromMs, toMs)) add(t, "parts");
    if (incoming.size)
      return [...incoming.values()]
        .sort((a, b) => a.first - b.first)
        .slice(0, 5)
        .map((f) => ({ ...f, amount: Math.round(f.amount) }));
  }
  return [];
}

// Le founder : celui qui a envoyé le plus (hors plateformes si possible)
function pickFounder(list, chain = polygon) {
  const own = list.filter((f) => infoOf(f.address, chain).kind !== "plateforme");
  return [...(own.length ? own : list)].sort((a, b) => b.amount - a.amount)[0] ?? null;
}

// Remonte depuis une liste d'expéditeurs : tant que le founder est un simple
// relais (wallet neuf), on regarde qui l'a financé juste avant
async function climb(direct, chain, seen, hops = MAX_HOPS) {
  for (const f of direct) await describe(f.address, chain);
  const steps = [];
  let cur = pickFounder(direct, chain);
  while (cur && !seen.has(`${chain.key}:${cur.address}`)) {
    seen.add(`${chain.key}:${cur.address}`);
    steps.push(cur);
    if (steps.length > hops || infoOf(cur.address, chain).kind !== "relais") break;
    const up = await fundersOf(cur.address, [[cur.first - 3 * DAY, cur.first + 60000], [cur.first - 14 * DAY, cur.first - 3 * DAY]], chain);
    for (const f of up) await describe(f.address, chain);
    cur = pickFounder(up, chain);
  }
  return steps;
}

// Où chercher l'argent d'un wallet : juste avant son premier pari, puis
// juste avant ses plus grosses mises suspectes, puis plus loin en arrière
function windowsFor(firstTrade, bigBets) {
  return [
    [firstTrade - 2 * DAY, firstTrade + 3 * HOUR],
    ...bigBets.map((t) => [Math.max(firstTrade + 3 * HOUR, t - 2 * DAY), t + 10 * 60000]),
    [firstTrade - 14 * DAY, firstTrade - 2 * DAY],
  ];
}

// Autres blockchains : quand l'argent arrive sur Polygon par un pont, il part
// presque toujours de la même adresse sur l'autre blockchain (on transfère
// ses propres fonds). On lit donc les dépôts de cette même adresse sur
// Ethereum, Base, Arbitrum et Optimism avant son arrivée sur Polygon.
async function otherChains(addresses, aroundMs, seen) {
  for (const address of addresses) {
    for (const key of OTHER_CHAINS) {
      const chain = chains[key];
      const sent = await chain.nonce(address);
      // Adresse jamais utilisée sur cette blockchain : rien à lire
      if (!sent) continue;
      const direct = await fundersOf(address, [[aroundMs - 3 * DAY, aroundMs + HOUR], [aroundMs - 30 * DAY, aroundMs - 3 * DAY]], chain);
      if (!direct.length) continue;
      const steps = await climb(direct, chain, seen, 2);
      if (steps.length) return { chain: key, address, steps };
    }
  }
  return null;
}

// Chaîne founder → … → origine sur Polygon ; si rien n'arrive directement au
// wallet, on cherche du côté de son propriétaire (le wallet qui signe ses
// ordres) ; si la piste s'arrête sur un pont ou une plateforme, on regarde
// les autres blockchains.
async function traceWallet(wallet, firstTrade, bigBets) {
  const windows = windowsFor(firstTrade, bigBets);
  const owner = await safeOwner(wallet);
  if (owner) await describe(owner);
  let direct = await fundersOf(wallet, windows);
  let viaOwner = false;
  if (!direct.length && owner && owner !== wallet) {
    direct = await fundersOf(owner, windows);
    viaOwner = direct.length > 0;
  }
  const seen = new Set([`polygon:${wallet}`, `polygon:${owner}`]);
  const chain = await climb(direct, polygon, seen);
  const origin = chain[chain.length - 1];
  let elsewhere = null;
  const kind = origin ? infoOf(origin.address).kind : null;
  if (kind !== "polymarket") {
    // Adresses qui ont pu faire le pont elles-mêmes : le propriétaire, et le
    // dernier wallet personnel de la chaîne
    const candidates = [owner, ...chain.filter((f) => ["relais", "wallet"].includes(infoOf(f.address).kind)).map((f) => f.address)].filter(Boolean);
    if (candidates.length) elsewhere = await otherChains([...new Set(candidates)].slice(0, 2), origin?.first ?? firstTrade, seen);
  }
  return { direct, chain, owner, viaOwner, elsewhere };
}

// ---------- Retraits vers une plateforme d'échange ----------
//
// Une plateforme donne à chaque client une adresse de dépôt à lui, qui
// renvoie tout ce qu'elle reçoit vers le grand wallet de la plateforme.
// Si un wallet suspect retire ses gains vers une adresse de dépôt, tous les
// autres wallets qui envoient vers cette même adresse alimentent le même
// compte client : c'est la méthode de « réutilisation d'adresse de dépôt »
// (Victor, 2020). On ne sait pas qui est le client, seulement quels wallets
// vont au même compte.
async function exchangeExits(wallet, owner, sinceMs) {
  const out = [];
  const sent = new Map();
  for (const from of [wallet, owner].filter(Boolean)) {
    for (const t of await polygon.stableTransfers(from, "out", sinceMs, now)) {
      if (POLYMARKET_CONTRACTS.has(t.to) || t.to === wallet || t.to === owner) continue;
      const x = sent.get(t.to) ?? { address: t.to, amount: 0, first: t.ts };
      x.amount += t.amount;
      sent.set(t.to, x);
    }
  }
  for (const r of [...sent.values()].sort((a, b) => b.amount - a.amount).slice(0, 3)) {
    const info = await describe(r.address);
    if (info.contract || info.kind === "plateforme" || info.kind === "polymarket") continue;
    // Adresse de dépôt : elle renvoie vite ce qu'elle reçoit vers une plateforme
    const forwards = (await polygon.stableTransfers(r.address, "out", r.first - HOUR, r.first + 3 * DAY)).filter((t) => t.ts >= r.first - HOUR);
    let hub = null;
    for (const t of forwards) {
      const d = await describe(t.to);
      if (d.kind === "plateforme") {
        hub = t.to;
        break;
      }
    }
    if (!hub) continue;
    // Les autres wallets qui alimentent ce même compte client
    const others = new Map();
    for (const t of await polygon.stableTransfers(r.address, "in", now - 60 * DAY, now)) {
      if (t.from === wallet || t.from === owner || POLYMARKET_CONTRACTS.has(t.from)) continue;
      const o = others.get(t.from) ?? { address: t.from, amount: 0, first: t.ts };
      o.amount += t.amount;
      others.set(t.from, o);
    }
    const list = [...others.values()].sort((a, b) => b.amount - a.amount).slice(0, 8);
    for (const o of list) await describe(o.address);
    out.push({ address: r.address, amount: Math.round(r.amount), hub, others: list.map((o) => ({ ...o, amount: Math.round(o.amount) })) });
  }
  return out;
}

// ---------- Programme principal ----------

const summary = (f, chain = polygon) => {
  if (!f) return null;
  const c = f.chain ? chains[f.chain] ?? chain : chain;
  const info = infoOf(f.address, c);
  return { address: f.address, chain: c.key, amount: f.amount, first: f.first, via: f.via ?? null, kind: info.kind ?? "wallet", label: info.label ?? null, txs: info.txs ?? null, pm: info.pm ?? null };
};

async function main(prev) {
  const alerts = (await readData("alerts.json").catch(() => null))?.alerts ?? [];
  const review = await readData("alerts-review.json").catch(() => null);
  const status = new Map((review?.rows ?? []).map((r) => [r.id, r]));

  // Tous les wallets récents (âge en secondes) des alertes, avec le résultat
  // de leurs alertes sur les marchés terminés
  const byWallet = new Map();
  for (const a of alerts) {
    if (!a.wallet || a.walletAge == null || a.walletAge > 30 * 86400) continue;
    const w = lc(a.wallet);
    if (!byWallet.has(w)) byWallet.set(w, { wallet: w, name: a.name || "", age: a.walletAge, firstTrade: Infinity, last: 0, bets: [], alerts: 0, won: 0, lost: 0, pnl: 0, cash: 0, best: 0 });
    const x = byWallet.get(w);
    // Premier pari connu du wallet : ses dépôts sont juste avant
    x.firstTrade = Math.min(x.firstTrade, (a.ts - a.walletAge) * 1000);
    x.last = Math.max(x.last, a.ts);
    x.bets.push({ ts: a.ts * 1000, cash: a.cash ?? 0 });
    x.alerts++;
    x.cash += a.cash ?? 0;
    x.best = Math.max(x.best, a.score ?? 0);
    const r = status.get(a.id);
    if (r?.status === "won") x.won++;
    if (r?.status === "lost") x.lost++;
    if (r && (r.status === "won" || r.status === "lost")) x.pnl += r.roi;
  }
  const all = [...byWallet.values()];
  const isWinner = (x) => x.won > 0 && x.pnl > 0;

  const traced = prev.traced ?? {}; // wallet -> { v, at, direct, chain, owner, viaOwner, elsewhere, exits, exitsAt, error }
  funders = prev.funders ?? {};
  for (const [k, v] of Object.entries(funders)) if (now - v.at > FUNDER_TTL) delete funders[k];

  // Chaque wallet n'est lu qu'une fois (son financement ne change pas), sauf
  // ceux lus avant l'ajout des autres blockchains (v < 3) ; les gagnants
  // d'abord, puis les alertes les plus fortes et les plus récentes
  const todo = all
    .filter((x) => !traced[x.wallet] || (traced[x.wallet].error && now - traced[x.wallet].at > RETRY) || (traced[x.wallet].v ?? 1) < 3)
    .sort((a, b) => Number(isWinner(b)) - Number(isWinner(a)) || b.best - a.best || b.last - a.last)
    .slice(0, MAX_WALLETS);
  let failures = 0;
  let done = 0;
  let lastError = "";
  const deadline = Date.now() + BUDGET;
  await mapLimit(todo, 3, async (x) => {
    // Plus le temps : ce wallet sera lu au prochain passage
    if (Date.now() > deadline) return;
    try {
      // Les 3 plus grosses mises suspectes : l'argent arrive souvent juste avant
      const bigBets = [...x.bets].sort((a, b) => b.cash - a.cash).slice(0, 3).map((b) => b.ts);
      const r = await traceWallet(x.wallet, x.firstTrade, bigBets);
      traced[x.wallet] = { ...traced[x.wallet], v: 3, at: now, ...r, error: undefined };
      done++;
    } catch (err) {
      failures++;
      lastError = err.message;
      traced[x.wallet] = { ...traced[x.wallet], at: now, error: err.message };
    }
  });

  // Retraits : les wallets gagnants ou très suspects, une fois par jour (les
  // gains sont retirés après la fin des marchés)
  const exitTodo = all
    .filter((x) => traced[x.wallet]?.v >= 3 && (isWinner(x) || x.best >= 70) && (!traced[x.wallet].exitsAt || now - traced[x.wallet].exitsAt > DAY))
    .sort((a, b) => b.pnl - a.pnl || b.best - a.best)
    .slice(0, MAX_EXITS);
  let exitsDone = 0;
  await mapLimit(exitTodo, 2, async (x) => {
    if (Date.now() > deadline) return;
    try {
      traced[x.wallet].exits = await exchangeExits(x.wallet, traced[x.wallet].owner, x.firstTrade);
      traced[x.wallet].exitsAt = now;
      exitsDone++;
    } catch (err) {
      lastError = err.message;
    }
  });
  // On oublie les wallets qui ne sont plus dans les alertes
  for (const w of Object.keys(traced)) if (!byWallet.has(w)) delete traced[w];

  // Adresses (hors plateformes) qu'on retrouve derrière plusieurs wallets
  // suspects, et adresses de dépôt (même compte d'échange) partagées
  const behind = new Map();
  const sameAccount = new Map();
  for (const [wallet, t] of Object.entries(traced)) {
    // Le propriétaire (wallet qui signe) compte aussi : deux wallets suspects
    // avec le même propriétaire sont à la même personne
    for (const f of [...(t.direct ?? []), ...(t.chain ?? []), ...(t.owner ? [{ address: t.owner }] : [])]) {
      if (infoOf(f.address).kind === "plateforme") continue;
      if (!behind.has(f.address)) behind.set(f.address, new Set());
      behind.get(f.address).add(wallet);
    }
    for (const e of t.exits ?? []) {
      if (!sameAccount.has(e.address)) sameAccount.set(e.address, new Set());
      sameAccount.get(e.address).add(wallet);
    }
  }
  const shared = (a) => behind.get(a)?.size ?? 1;
  const clusters = [
    ...[...behind.entries()].filter(([, ws]) => ws.size >= 2).map(([address, ws]) => ({ type: "founder", ...summary({ address }), wallets: [...ws] })),
    ...[...sameAccount.entries()].filter(([, ws]) => ws.size >= 2).map(([address, ws]) => ({ type: "exchange", ...summary({ address }), wallets: [...ws] })),
  ].sort((a, b) => b.wallets.length - a.wallets.length);

  const entry = (x) => {
    const t = traced[x.wallet] ?? {};
    const chain = (t.chain ?? []).map((f) => ({ ...summary(f), shared: shared(f.address) }));
    const away = t.elsewhere ? t.elsewhere.steps.map((f) => summary(f, chains[t.elsewhere.chain])) : [];
    const origin = away[away.length - 1] ?? chain[chain.length - 1] ?? null;
    const main = [...chain, ...away].reverse().find((f) => f.kind === "polymarket" && f.pm?.proxy && f.pm.proxy !== x.wallet);
    const owner = t.owner ? { ...summary({ address: t.owner }), shared: shared(t.owner) } : null;
    // Retraits vers un compte d'échange, et les autres wallets qui l'alimentent
    const exits = (t.exits ?? []).map((e) => ({
      address: e.address,
      amount: e.amount,
      hub: summary({ address: e.hub }),
      suspects: sameAccount.get(e.address)?.size ?? 1,
      others: e.others.map((o) => summary(o)),
    }));
    return {
      founder: chain[0] ?? away[0] ?? null,
      origin,
      hops: chain.length + away.length,
      // Wallets neufs qui n'ont servi qu'à faire passer l'argent
      relays: [...chain, ...away].filter((f) => f.kind === "relais").length,
      via: chain[0]?.via ?? null,
      bridge: t.elsewhere ? { chain: t.elsewhere.chain, name: CHAINS[t.elsewhere.chain].name, address: t.elsewhere.address } : null,
      owner,
      viaOwner: t.viaOwner === true,
      main: main ? { funder: main.address, ...main.pm } : null,
      exits,
      error: t.error ?? null,
    };
  };

  const view = {
    updatedAt: new Date(now).toISOString(),
    source: "serveurs publics Polygon, Ethereum, Base, Arbitrum et Optimism",
    explorers: Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [k, c.explorer])),
    candidates: all.filter(isWinner).length,
    // Pour la fiche de chaque alerte : founder, origine et retraits
    byWallet: Object.fromEntries(all.filter((x) => traced[x.wallet]).map((x) => [x.wallet, entry(x)])),
    // Détail des wallets récents gagnants
    wallets: all
      .filter((x) => isWinner(x) && traced[x.wallet])
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 60)
      .map(({ firstTrade, last, bets, ...x }) => {
        const t = traced[x.wallet];
        const away = t.elsewhere ? t.elsewhere.steps.map((f) => summary(f, chains[t.elsewhere.chain])) : [];
        return {
          ...x,
          ...entry(x),
          chain: [...(t.chain ?? []).map((f) => ({ ...summary(f), shared: shared(f.address) })), ...away],
          funders: (t.direct ?? []).map((f) => ({ ...summary(f), count: f.count, via: f.via, shared: shared(f.address) })),
        };
      }),
    clusters,
  };
  const entries = Object.values(view.byWallet);
  const count = (fn) => entries.filter(fn).length;
  console.log(
    `Pistes : ${all.length} wallets récents dans les alertes, ${done} lus ce passage (${failures} en échec), ${count((e) => e.origin)} founders trouvés, ${count((e) => e.relays > 0)} passés par un relais, ${count((e) => e.viaOwner || e.via === "parts")} par le propriétaire ou des parts, ${count((e) => e.bridge)} venus d'une autre blockchain, ${count((e) => e.main)} compte principal probable`
  );
  console.log(
    `Retraits : ${exitsDone} wallets lus, ${count((e) => e.exits.length)} retirent vers une adresse de dépôt d'échange, ${count((e) => e.exits.some((x) => x.others.length))} partagent ce compte avec d'autres wallets · ${clusters.length} groupe(s) de wallets liés`
  );
  if (failures && !done) console.log(`::warning::Blockchain illisible : ${lastError}`);
  else if (lastError) console.log(`Exemple d'échec : ${lastError}`);
  return { state: { traced, funders, at: now }, view };
}

const prev = (await loadState("wallets")) ?? {};
try {
  const { state, view } = await main(prev);
  await writeState("wallets", state, view);
} catch (err) {
  console.log(`::warning::Pistes des wallets en échec : ${err.message}`);
}
