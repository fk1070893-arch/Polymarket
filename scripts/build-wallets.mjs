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
// Source : serveurs publics de la blockchain Polygon (gratuits, sans clé),
// ou Etherscan si le secret ETHERSCAN_API_KEY existe. Une fois par heure.
// Résultat : site/data/wallets.json (mémoire : .state/wallets-state.json)

import { getJSON, loadState, mapLimit, readData, writeState } from "./lib.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_WALLETS = 12; // nouveaux wallets examinés par passage
const BUDGET = 90000; // temps maximum de lecture de la blockchain (ms)
const RETRY = HOUR; // nouvel essai après une lecture en échec
const FUNDER_TTL = 7 * DAY;
const MAX_HOPS = 3; // étages remontés au plus derrière un wallet intermédiaire
const FRESH_TXS = 50; // un wallet qui a envoyé si peu de transactions est un simple relais
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const BLOCKSCOUT = "https://polygon.blockscout.com";
const ETHERSCAN_KEY = (process.env.ETHERSCAN_API_KEY ?? "").trim();

// Dollars sur Polygon : USDC.e (utilisé par Polymarket) et USDC natif
const USDC = new Set(["0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"]);
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

// ---------- Explorateur Polygon ----------

// Serveurs publics de la blockchain Polygon (gratuits, sans clé) : on lit
// directement les transferts de dollars, sans passer par un explorateur
const RPCS = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://polygon-rpc.com", "https://1rpc.io/matic"];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BLOCK_TIME = 2; // secondes par bloc, à peu près
let rpcIndex = 0;

async function rpc(method, params) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIndex + i) % RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(url).host}`);
      const data = await res.json();
      if (data.error) throw Object.assign(new Error(`${data.error.message ?? "erreur"} (${new URL(url).host})`), { rpcError: true });
      rpcIndex = (rpcIndex + i) % RPCS.length; // garde le serveur qui répond
      return data.result;
    } catch (err) {
      lastErr = err;
      // Une plage de blocs trop grande se règle en la coupant, pas en changeant de serveur
      if (err.rpcError && /range|limit|too many|exceed/i.test(err.message)) throw err;
    }
  }
  throw lastErr;
}

let head = null; // dernier bloc connu : { number, ts }
async function latestBlock() {
  if (!head) {
    const b = await rpc("eth_getBlockByNumber", ["latest", false]);
    head = { number: parseInt(b.number, 16), ts: parseInt(b.timestamp, 16) };
  }
  return head;
}

// Numéro du bloc produit vers l'instant `ts` (secondes), à quelques blocs près
async function blockAt(ts) {
  const h = await latestBlock();
  let guess = Math.max(1, Math.round(h.number - (h.ts - ts) / BLOCK_TIME));
  for (let i = 0; i < 2; i++) {
    const b = await rpc("eth_getBlockByNumber", [`0x${guess.toString(16)}`, false]).catch(() => null);
    if (!b) break;
    const diff = ts - parseInt(b.timestamp, 16);
    if (Math.abs(diff) < 60) break;
    guess = Math.max(1, Math.min(h.number, Math.round(guess + diff / BLOCK_TIME)));
  }
  return guess;
}

// Journaux de la blockchain entre deux instants (ms) pour un filtre donné.
// La plage de blocs par requête grandit tant que le serveur l'accepte, et se
// réduit s'il la refuse : peu de requêtes même sur plusieurs semaines.
// Chaque serveur a sa propre limite de plage de blocs pour les journaux :
// on l'apprend en route (on double tant qu'il accepte, on divise par 4
// s'il refuse) et on écarte ceux qui n'acceptent que de toutes petites plages.
const LOG_SERVERS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
  "https://polygon.llamarpc.com",
  "https://polygon-mainnet.public.blastapi.io",
].map((url) => ({ url, step: 20000, dead: false, fails: 0 }));
let logServer = 0;
const MIN_STEP = 1000;

async function getLogsFrom(server, params) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(server.url).host}`);
  const data = await res.json();
  if (data.error) throw Object.assign(new Error(`${data.error.message ?? "erreur"} (${new URL(server.url).host})`), { rpcError: true });
  return data.result ?? [];
}

// Journaux de la blockchain entre deux instants (ms) pour un filtre donné
async function scanLogs(filter, fromMs, toMs) {
  const from = await blockAt(Math.floor(fromMs / 1000));
  const to = Math.min((await latestBlock()).number, await blockAt(Math.floor(toMs / 1000)));
  const out = [];
  let lastErr = null;
  for (let start = from, tries = 0; start <= to; ) {
    const alive = LOG_SERVERS.filter((x) => !x.dead);
    if (!alive.length || tries > 30) throw lastErr ?? new Error("aucun serveur Polygon ne répond");
    const server = alive[logServer % alive.length];
    const end = Math.min(to, start + server.step - 1);
    try {
      out.push(...(await getLogsFrom(server, [{ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }])));
      start = end + 1;
      tries = 0;
      server.fails = 0;
      server.step = Math.min(200000, server.step * 2);
    } catch (err) {
      lastErr = err;
      tries++;
      const rangeIssue = (err.rpcError && /range|limit|exceed|too many|block|large/i.test(err.message)) || err.name === "TimeoutError";
      if (rangeIssue && server.step > MIN_STEP) {
        server.step = Math.max(MIN_STEP, Math.floor(server.step / 4));
      } else {
        // Limite trop petite, ou serveur en panne : on passe au suivant
        if (rangeIssue || ++server.fails >= 3) server.dead = true;
        logServer++;
      }
    }
  }
  return out;
}

const topicOf = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const addrOf = (topic) => `0x${topic.slice(26)}`;
async function tsOf(blockHex) {
  const h = await latestBlock();
  return Math.round(h.ts - (h.number - parseInt(blockHex, 16)) * BLOCK_TIME);
}

// Dollars reçus par une adresse entre deux instants (ms)
async function rpcTransfers(address, fromMs, toMs) {
  const logs = await scanLogs({ address: [...USDC], topics: [TRANSFER, null, topicOf(address)] }, fromMs, toMs);
  const out = [];
  for (const l of logs) {
    out.push({
      from: addrOf(l.topics[1]),
      to: address,
      value: BigInt(l.data).toString(),
      tokenDecimal: "6",
      contractAddress: l.address,
      timeStamp: String(await tsOf(l.blockNumber)),
      hash: l.transactionHash,
    });
  }
  return out.sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp));
}

// Parts de pari envoyées directement par un autre wallet (pas un échange
// sur Polymarket, où c'est le contrat de Polymarket qui fait le transfert)
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
async function sharesReceived(address, fromMs, toMs) {
  const logs = await scanLogs({ address: CTF, topics: [[TRANSFER_SINGLE, TRANSFER_BATCH], null, null, topicOf(address)] }, fromMs, toMs);
  const out = [];
  for (const l of logs) {
    const operator = addrOf(l.topics[1]);
    const from = addrOf(l.topics[2]);
    // Envoyées par leur propriétaire lui-même, pas par un contrat d'échange
    if (operator !== from || /^0x0+$/.test(from) || POLYMARKET_CONTRACTS.has(operator)) continue;
    // Quantité : 2e mot des données pour TransferSingle (id, valeur), en parts de 1 $
    const value = l.topics[0] === TRANSFER_SINGLE ? Number(BigInt(`0x${l.data.slice(66, 130)}`)) / 1e6 : 0;
    out.push({ from, value, ts: (await tsOf(l.blockNumber)) * 1000, hash: l.transactionHash });
  }
  return out;
}

// Propriétaire d'un wallet Polymarket de type « Safe » (le wallet qui signe
// ses ordres) : fonction getOwners() du contrat
async function safeOwner(address) {
  const data = await rpc("eth_call", [{ to: address, data: "0xa0e67e2b" }, "latest"]).catch(() => null);
  // Réponse : position, longueur, puis les adresses (32 octets chacune)
  if (typeof data !== "string" || data.length < 2 + 64 * 3) return null;
  const n = parseInt(data.slice(2 + 64, 2 + 128), 16);
  if (!(n >= 1 && n <= 10)) return null;
  return `0x${data.slice(2 + 128 + 24, 2 + 192)}`.toLowerCase();
}

// Premiers transferts de dollars reçus par une adresse (du plus ancien au plus récent)
async function tokenTransfers(address, fromMs, toMs) {
  if (!ETHERSCAN_KEY) return rpcTransfers(address, fromMs, toMs);
  const qs = `module=account&action=tokentx&address=${address}&sort=asc&page=1&offset=200`;
  // Le message d'erreur contient l'adresse appelée : jamais la clé (publiée sinon)
  const data = await getJSON(`https://api.etherscan.io/v2/api?chainid=137&${qs}&apikey=${ETHERSCAN_KEY}`, 2).catch((err) => {
    throw new Error(err.message.replace(/apikey=[^&\s]+/gi, "apikey=***"));
  });
  if (Array.isArray(data?.result)) return data.result;
  // « No transactions found » : liste vide ; toute autre réponse est une panne
  if (/no (token )?transfers|no transactions/i.test(`${data?.message} ${data?.result}`)) return [];
  throw new Error(String(data?.message ?? "réponse inattendue").replace(/apikey=[^&\s]+/gi, "apikey=***"));
}

// Ce qu'on sait d'une adresse : contrat ou non, nombre de transactions
// envoyées (une plateforme en a des centaines de milliers), et son nom
// public sur l'explorateur Blockscout quand il répond
async function addressInfo(address) {
  const [code, nonce, info] = await Promise.all([
    rpc("eth_getCode", [address, "latest"]).catch(() => null),
    rpc("eth_getTransactionCount", [address, "latest"]).catch(() => null),
    getJSON(`${BLOCKSCOUT}/api/v2/addresses/${address}`, 1).catch(() => null),
  ]);
  const tags = [info?.name, ...(info?.public_tags ?? []).map((t) => t.display_name ?? t.label), ...(info?.metadata?.tags ?? []).map((t) => t.name)].filter(Boolean);
  return {
    label: tags[0] ?? null,
    contract: info?.is_contract === true || (typeof code === "string" && code.length > 2),
    txs: nonce != null ? parseInt(nonce, 16) : null,
  };
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

let funders = {}; // adresse -> { at, label, kind, txs, pm, contract }

async function describe(address) {
  if (!funders[address]) {
    const [info, pm] = await Promise.all([addressInfo(address), polymarketProfile(address)]);
    funders[address] = { at: now, ...info, pm, kind: kindOf(info, pm) };
  }
  return funders[address];
}

// Qui a envoyé des dollars à `address` entre deux instants : jusqu'à 5
// Qui a envoyé des dollars (ou des parts de pari) à `address` dans une des
// fenêtres de temps [début, fin] (ms), essayées dans l'ordre jusqu'à trouver
// quelque chose : jusqu'à 5 expéditeurs, des plus anciens aux plus récents
async function fundersOf(address, windows) {
  for (const [fromMs, toMs] of windows) {
    if (!(toMs > fromMs)) continue;
    const incoming = new Map();
    const add = (from, amount, ts, tx, via) => {
      if (from === address || POLYMARKET_CONTRACTS.has(from) || /^0x0+$/.test(from)) return;
      if (!incoming.has(from)) incoming.set(from, { address: from, amount: 0, count: 0, first: ts, tx, via });
      const f = incoming.get(from);
      f.amount += amount;
      f.count++;
      f.first = Math.min(f.first, ts);
    };
    for (const t of await tokenTransfers(address, fromMs, toMs)) {
      const ts = Number(t.timeStamp) * 1000;
      if (lc(t.to) !== address || !USDC.has(lc(t.contractAddress)) || ts < fromMs - 600000 || ts > toMs + 600000) continue;
      add(lc(t.from), (num(t.value) ?? 0) / 10 ** (num(t.tokenDecimal) ?? 6), ts, t.hash, "dollars");
    }
    // Parts de pari reçues directement (lecture directe de la blockchain seulement)
    if (!ETHERSCAN_KEY) for (const t of await sharesReceived(address, fromMs, toMs)) add(t.from, t.value, t.ts, t.hash, "parts");
    if (incoming.size)
      return [...incoming.values()]
        .sort((a, b) => a.first - b.first)
        .slice(0, 5)
        .map((f) => ({ ...f, amount: Math.round(f.amount) }));
  }
  return [];
}

// Le founder : celui qui a envoyé le plus (hors plateformes si possible)
function pickFounder(list) {
  const own = list.filter((f) => funders[f.address]?.kind !== "plateforme");
  return [...(own.length ? own : list)].sort((a, b) => b.amount - a.amount)[0] ?? null;
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

// Chaîne founder → … → origine : tant que le founder est un simple relais
// (wallet neuf), on regarde qui l'a financé juste avant qu'il envoie l'argent.
// Si rien n'arrive directement au wallet, on cherche du côté de son
// propriétaire (le wallet qui signe ses ordres).
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
  for (const f of direct) await describe(f.address);
  const chain = [];
  let cur = pickFounder(direct);
  const seen = new Set([wallet, owner]);
  while (cur && !seen.has(cur.address)) {
    seen.add(cur.address);
    chain.push(cur);
    if (chain.length > MAX_HOPS || funders[cur.address]?.kind !== "relais") break;
    const up = await fundersOf(cur.address, [
      [cur.first - 3 * DAY, cur.first + 60000],
      [cur.first - 14 * DAY, cur.first - 3 * DAY],
    ]);
    for (const f of up) await describe(f.address);
    cur = pickFounder(up);
  }
  return { direct, chain, owner, viaOwner };
}

// ---------- Programme principal ----------

const summary = (f) => {
  if (!f) return null;
  const info = funders[f.address] ?? {};
  return { address: f.address, amount: f.amount, first: f.first, via: f.via ?? null, kind: info.kind ?? "wallet", label: info.label ?? null, txs: info.txs ?? null, pm: info.pm ?? null };
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

  const traced = prev.traced ?? {}; // wallet -> { at, direct, chain, error }
  funders = prev.funders ?? {};
  for (const [k, v] of Object.entries(funders)) if (now - v.at > FUNDER_TTL) delete funders[k];

  // Chaque wallet n'est lu qu'une fois (son financement ne change pas), sauf
  // ceux lus avant l'ajout des autres chemins (v < 2) ; les gagnants d'abord,
  // puis les alertes les plus fortes et les plus récentes
  const todo = all
    .filter((x) => !traced[x.wallet] || (traced[x.wallet].error && now - traced[x.wallet].at > RETRY) || (traced[x.wallet].v ?? 1) < 2)
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
      const { direct, chain, owner, viaOwner } = await traceWallet(x.wallet, x.firstTrade, bigBets);
      traced[x.wallet] = { v: 2, at: now, direct, chain, owner, viaOwner };
      done++;
    } catch (err) {
      failures++;
      lastError = err.message;
      traced[x.wallet] = { ...traced[x.wallet], at: now, error: err.message };
    }
  });
  // On oublie les wallets qui ne sont plus dans les alertes
  for (const w of Object.keys(traced)) if (!byWallet.has(w)) delete traced[w];

  // Adresses (hors plateformes) qu'on retrouve derrière plusieurs wallets suspects
  const behind = new Map();
  for (const [wallet, t] of Object.entries(traced)) {
    // Le propriétaire (wallet qui signe) compte aussi : deux wallets suspects
    // avec le même propriétaire sont à la même personne
    for (const f of [...(t.direct ?? []), ...(t.chain ?? []), ...(t.owner ? [{ address: t.owner }] : [])]) {
      if (funders[f.address]?.kind === "plateforme") continue;
      if (!behind.has(f.address)) behind.set(f.address, new Set());
      behind.get(f.address).add(wallet);
    }
  }
  const shared = (a) => behind.get(a)?.size ?? 1;
  const clusters = [...behind.entries()]
    .filter(([, ws]) => ws.size >= 2)
    .map(([address, ws]) => ({ ...summary({ address }), wallets: [...ws] }))
    .sort((a, b) => b.wallets.length - a.wallets.length);

  const entry = (x) => {
    const t = traced[x.wallet] ?? {};
    const chain = (t.chain ?? []).map((f) => ({ ...summary(f), shared: shared(f.address) }));
    const origin = chain[chain.length - 1] ?? null;
    const main = [...chain].reverse().find((f) => f.kind === "polymarket" && f.pm?.proxy && f.pm.proxy !== x.wallet);
    const owner = t.owner ? { ...summary({ address: t.owner }), shared: shared(t.owner) } : null;
    return {
      founder: chain[0] ?? null,
      origin,
      hops: chain.length,
      via: chain[0]?.via ?? null,
      owner,
      viaOwner: t.viaOwner === true,
      main: main ? { funder: main.address, ...main.pm } : null,
      error: t.error ?? null,
    };
  };

  const view = {
    updatedAt: new Date(now).toISOString(),
    source: ETHERSCAN_KEY ? "Etherscan" : "serveurs publics Polygon",
    candidates: all.filter(isWinner).length,
    // Pour la fiche de chaque alerte : founder et origine de l'argent
    byWallet: Object.fromEntries(all.filter((x) => traced[x.wallet]).map((x) => [x.wallet, entry(x)])),
    // Détail des wallets récents gagnants
    wallets: all
      .filter((x) => isWinner(x) && traced[x.wallet])
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 60)
      .map(({ firstTrade, last, bets, ...x }) => {
        const t = traced[x.wallet];
        return {
          ...x,
          ...entry(x),
          chain: (t.chain ?? []).map((f) => ({ ...summary(f), shared: shared(f.address) })),
          funders: (t.direct ?? []).map((f) => ({ ...summary(f), count: f.count, via: f.via, shared: shared(f.address) })),
        };
      }),
    clusters,
  };
  const withOrigin = Object.values(view.byWallet).filter((e) => e.origin);
  const relays = Object.values(view.byWallet).filter((e) => e.hops > 1).length;
  const owners = Object.values(view.byWallet).filter((e) => e.owner).length;
  const viaOther = Object.values(view.byWallet).filter((e) => e.viaOwner || e.via === "parts").length;
  const mains = Object.values(view.byWallet).filter((e) => e.main).length;
  console.log(
    `Pistes : ${all.length} wallets récents dans les alertes, ${done} lus ce passage (${failures} en échec via ${view.source}), ${withOrigin.length} founders trouvés, ${relays} passés par un relais, ${viaOther} trouvés par le propriétaire ou des parts, ${owners} propriétaires lus, ${mains} compte principal probable, ${clusters.length} adresse(s) derrière plusieurs suspects`
  );
  if (failures && !done) console.log(`::warning::Blockchain Polygon illisible : ${lastError}`);
  else if (failures) console.log(`Exemple d'échec : ${lastError}`);
  return { state: { traced, funders, at: now }, view };
}

const prev = (await loadState("wallets")) ?? {};
try {
  const { state, view } = await main(prev);
  await writeState("wallets", state, view);
} catch (err) {
  console.log(`::warning::Pistes des wallets en échec : ${err.message}`);
}
