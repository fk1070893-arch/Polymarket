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
// Source : explorateur Blockscout de Polygon (gratuit, sans clé), ou
// Etherscan si le secret ETHERSCAN_API_KEY existe. Une fois par heure.
// Résultat : site/data/wallets.json (mémoire : .state/wallets-state.json)

import { getJSON, loadState, mapLimit, readData, writeState } from "./lib.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_WALLETS = 25; // wallets examinés par passage
const RECHECK = DAY; // un wallet est réexaminé au plus une fois par jour
const FUNDER_TTL = 7 * DAY;
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

// Premiers transferts de jetons d'une adresse (du plus ancien au plus récent)
async function tokenTransfers(address) {
  const qs = `module=account&action=tokentx&address=${address}&sort=asc&page=1&offset=200`;
  const url = ETHERSCAN_KEY ? `https://api.etherscan.io/v2/api?chainid=137&${qs}&apikey=${ETHERSCAN_KEY}` : `${BLOCKSCOUT}/api?${qs}`;
  // Le message d'erreur contient l'adresse appelée : jamais la clé (publiée sinon)
  const data = await getJSON(url, 2).catch((err) => {
    throw new Error(err.message.replace(/apikey=[^&\s]+/gi, "apikey=***"));
  });
  if (Array.isArray(data?.result)) return data.result;
  // « No transactions found » : liste vide ; toute autre réponse est une panne
  if (/no (token )?transfers|no transactions/i.test(`${data?.message} ${data?.result}`)) return [];
  throw new Error(String(data?.message ?? "réponse inattendue"));
}

// Étiquette publique d'une adresse (nom d'échange, de pont…) et son activité
async function addressInfo(address) {
  const [info, counters] = await Promise.all([
    getJSON(`${BLOCKSCOUT}/api/v2/addresses/${address}`, 1).catch(() => null),
    getJSON(`${BLOCKSCOUT}/api/v2/addresses/${address}/counters`, 1).catch(() => null),
  ]);
  const tags = [info?.name, ...(info?.public_tags ?? []).map((t) => t.display_name ?? t.label), ...(info?.metadata?.tags ?? []).map((t) => t.name)].filter(Boolean);
  return {
    label: tags[0] ?? null,
    contract: info?.is_contract === true,
    txs: num(counters?.transactions_count),
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
  return "wallet";
}

// ---------- Programme principal ----------

async function main(prev) {
  const alerts = (await readData("alerts.json").catch(() => null))?.alerts ?? [];
  const review = await readData("alerts-review.json").catch(() => null);
  const status = new Map((review?.rows ?? []).map((r) => [r.id, r]));

  // Wallets récents (âge en secondes) dont les alertes ont gagné, d'après
  // le gain réel sur les marchés terminés
  const byWallet = new Map();
  for (const a of alerts) {
    if (!a.wallet || a.walletAge == null || a.walletAge > 30 * 86400) continue;
    const w = lc(a.wallet);
    if (!byWallet.has(w)) byWallet.set(w, { wallet: w, name: a.name || "", age: a.walletAge, alerts: 0, won: 0, lost: 0, pnl: 0, cash: 0, best: 0 });
    const x = byWallet.get(w);
    x.alerts++;
    x.cash += a.cash ?? 0;
    x.best = Math.max(x.best, a.score ?? 0);
    const r = status.get(a.id);
    if (r?.status === "won") x.won++;
    if (r?.status === "lost") x.lost++;
    if (r && (r.status === "won" || r.status === "lost")) x.pnl += r.roi;
  }
  const winners = [...byWallet.values()].filter((x) => x.won > 0 && x.pnl > 0).sort((a, b) => b.pnl - a.pnl);

  const traced = prev.traced ?? {}; // wallet -> { at, funders, error }
  const funders = prev.funders ?? {}; // adresse -> { at, label, kind, txs, pm }
  for (const [k, v] of Object.entries(funders)) if (now - v.at > FUNDER_TTL) delete funders[k];

  const todo = winners.filter((x) => !traced[x.wallet] || now - traced[x.wallet].at > RECHECK).slice(0, MAX_WALLETS);
  let failures = 0;
  let lastError = "";
  await mapLimit(todo, 3, async (x) => {
    try {
      const txs = await tokenTransfers(x.wallet);
      const incoming = new Map();
      for (const t of txs) {
        if (lc(t.to) !== x.wallet || !USDC.has(lc(t.contractAddress))) continue;
        const from = lc(t.from);
        if (from === x.wallet || POLYMARKET_CONTRACTS.has(from) || /^0x0+$/.test(from)) continue;
        const amount = (num(t.value) ?? 0) / 10 ** (num(t.tokenDecimal) ?? 6);
        if (!incoming.has(from)) incoming.set(from, { address: from, amount: 0, count: 0, first: Number(t.timeStamp) * 1000, tx: t.hash });
        const f = incoming.get(from);
        f.amount += amount;
        f.count++;
      }
      // Les premiers dépôts d'abord : c'est là que se trouve la source
      const list = [...incoming.values()].sort((a, b) => a.first - b.first).slice(0, 5);
      for (const f of list) {
        if (!funders[f.address]) {
          const [info, pm] = await Promise.all([addressInfo(f.address), polymarketProfile(f.address)]);
          funders[f.address] = { at: now, ...info, pm, kind: kindOf(info, pm) };
        }
      }
      traced[x.wallet] = { at: now, funders: list.map((f) => ({ ...f, amount: Math.round(f.amount) })) };
    } catch (err) {
      failures++;
      lastError = err.message;
      // Nouvel essai dans une heure
      traced[x.wallet] = { at: now - RECHECK + HOUR, funders: traced[x.wallet]?.funders ?? [], error: err.message };
    }
  });

  // Adresses (hors plateformes) qui ont financé plusieurs wallets suspects
  const fundedBy = new Map();
  for (const [wallet, t] of Object.entries(traced)) {
    for (const f of t.funders ?? []) {
      if (funders[f.address]?.kind === "plateforme") continue;
      if (!fundedBy.has(f.address)) fundedBy.set(f.address, new Set());
      fundedBy.get(f.address).add(wallet);
    }
  }
  const clusters = [...fundedBy.entries()]
    .filter(([, ws]) => ws.size >= 2)
    .map(([address, ws]) => ({ address, label: funders[address]?.label ?? null, kind: funders[address]?.kind ?? "wallet", pm: funders[address]?.pm ?? null, wallets: [...ws] }))
    .sort((a, b) => b.wallets.length - a.wallets.length);

  const view = {
    updatedAt: new Date(now).toISOString(),
    source: ETHERSCAN_KEY ? "Etherscan" : "Blockscout",
    candidates: winners.length,
    wallets: winners
      .filter((x) => traced[x.wallet])
      .slice(0, 60)
      .map((x) => {
        const t = traced[x.wallet];
        const fs = (t.funders ?? []).map((f) => {
          const info = funders[f.address] ?? {};
          return { ...f, label: info.label ?? null, kind: info.kind ?? "wallet", txs: info.txs ?? null, pm: info.pm ?? null, shared: fundedBy.get(f.address)?.size ?? 1 };
        });
        const main = fs.find((f) => f.kind === "polymarket" && f.pm?.proxy && f.pm.proxy !== x.wallet);
        return { ...x, error: t.error ?? null, funders: fs, main: main ? { funder: main.address, ...main.pm } : null };
      }),
    clusters,
  };
  const mains = view.wallets.filter((w) => w.main).length;
  console.log(
    `Pistes : ${winners.length} wallets récents gagnants, ${todo.length} examinés (${failures} en échec via ${view.source}), ${mains} compte principal probable, ${clusters.length} adresse(s) qui financent plusieurs suspects`
  );
  if (failures && failures === todo.length) console.log(`::warning::Explorateur Polygon injoignable : ${lastError}`);
  return { state: { traced, funders, at: now }, view };
}

const prev = (await loadState("wallets")) ?? {};
if (prev.at && now - prev.at < HOUR - 5 * 60000 && !process.env.WALLETS_FORCE) {
  console.log("Pistes récentes : republiées telles quelles");
  if (prev.view) await writeState("wallets", prev, prev.view);
} else {
  try {
    const { state, view } = await main(prev);
    await writeState("wallets", { ...state, view }, view);
  } catch (err) {
    console.log(`::warning::Pistes des wallets en échec : ${err.message}`);
  }
}
