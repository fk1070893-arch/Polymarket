// Lecture directe de blockchains compatibles Ethereum (Polygon, Ethereum,
// Base, Arbitrum, Optimism) par leurs serveurs publics gratuits, sans clé.
// Chaque serveur a sa propre limite de plage de blocs pour lire les
// journaux : on l'apprend en route (on double tant qu'il accepte, on divise
// par 4 s'il refuse) et on écarte les serveurs trop limités ou en panne.

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MIN_STEP = 1000;
const MAX_STEP = 200000;

export const topicOf = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
export const addrOf = (topic) => `0x${topic.slice(26)}`.toLowerCase();

// Dollars de chaque blockchain (6 décimales) : USDC, USDC « bridgé », USDT
export const CHAINS = {
  polygon: {
    name: "Polygon",
    explorer: "https://polygonscan.com/address/",
    blockTime: 2,
    servers: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.drpc.org",
      "https://polygon-rpc.com",
      "https://polygon.llamarpc.com",
      "https://polygon-mainnet.public.blastapi.io",
    ],
    stables: ["0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"],
  },
  ethereum: {
    name: "Ethereum",
    explorer: "https://etherscan.io/address/",
    blockTime: 12,
    servers: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
    stables: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
  },
  base: {
    name: "Base",
    explorer: "https://basescan.org/address/",
    blockTime: 2,
    servers: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org", "https://base.llamarpc.com"],
    stables: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  },
  arbitrum: {
    name: "Arbitrum",
    explorer: "https://arbiscan.io/address/",
    blockTime: 0.25,
    servers: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org", "https://arb1.arbitrum.io/rpc"],
    stables: ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"],
  },
  optimism: {
    name: "Optimism",
    explorer: "https://optimistic.etherscan.io/address/",
    blockTime: 2,
    servers: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org", "https://mainnet.optimism.io"],
    stables: ["0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"],
  },
};

export function makeChain(key) {
  const cfg = CHAINS[key];
  // pauseUntil : serveur mis de côté un moment (limite de débit, panne) ;
  // tooSmall : n'accepte que de toutes petites plages de blocs, inutile
  const servers = cfg.servers.map((url) => ({ url, step: 10000, pauseUntil: 0, tooSmall: false, fails: 0, lastError: "" }));
  let current = 0;
  let head = null;

  async function call(server, method, params, timeout = 15000) {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} sur ${new URL(server.url).host}`), { status: res.status });
    const data = await res.json();
    if (data.error) throw Object.assign(new Error(`${data.error.message ?? "erreur"} (${new URL(server.url).host})`), { rpcError: true });
    return data.result;
  }

  // Appel simple : on essaie les serveurs l'un après l'autre
  async function rpc(method, params) {
    let lastErr;
    for (let i = 0; i < servers.length; i++) {
      const s = servers[(current + i) % servers.length];
      try {
        const r = await call(s, method, params);
        current = (current + i) % servers.length;
        return r;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

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
    let guess = Math.max(1, Math.round(h.number - (h.ts - ts) / cfg.blockTime));
    for (let i = 0; i < 3; i++) {
      const b = await rpc("eth_getBlockByNumber", [`0x${guess.toString(16)}`, false]).catch(() => null);
      if (!b) break;
      const diff = ts - parseInt(b.timestamp, 16);
      if (Math.abs(diff) < 120) break;
      guess = Math.max(1, Math.min(h.number, Math.round(guess + diff / cfg.blockTime)));
    }
    return guess;
  }

  async function tsOf(blockHex) {
    const h = await latestBlock();
    return Math.round(h.ts - (h.number - parseInt(blockHex, 16)) * cfg.blockTime);
  }

  // Journaux entre deux instants (ms) pour un filtre donné. En cas d'échec,
  // on réduit d'abord la plage de blocs (la cause la plus fréquente, quel que
  // soit le message) ; un serveur qui refuse même une petite plage, limite
  // le débit ou ne répond pas est mis de côté une minute.
  async function scanLogs(filter, fromMs, toMs) {
    const from = await blockAt(Math.floor(fromMs / 1000));
    const to = Math.min((await latestBlock()).number, await blockAt(Math.floor(toMs / 1000)));
    const out = [];
    for (let start = from, tries = 0; start <= to; ) {
      const usable = servers.filter((x) => !x.tooSmall);
      const ready = usable.filter((x) => x.pauseUntil <= Date.now());
      if (!usable.length || tries > 40) {
        throw new Error(`serveurs ${cfg.name} injoignables : ${servers.map((x) => `${new URL(x.url).host} → ${x.lastError || "?"}`).join(" ; ")}`);
      }
      if (!ready.length) {
        // Tous en pause : on attend le premier qui revient
        const wait = Math.min(...usable.map((x) => x.pauseUntil)) - Date.now();
        await new Promise((r) => setTimeout(r, Math.max(200, Math.min(wait, 15000))));
        continue;
      }
      const server = ready[current % ready.length];
      const end = Math.min(to, start + server.step - 1);
      try {
        out.push(...((await call(server, "eth_getLogs", [{ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }], 20000)) ?? []));
        start = end + 1;
        tries = 0;
        server.fails = 0;
        server.step = Math.min(MAX_STEP, server.step * 2);
      } catch (err) {
        tries++;
        server.lastError = err.message.slice(0, 120);
        const rateOrAuth = [401, 403, 429].includes(err.status) || /rate|too many requests|limit exceeded|credits/i.test(err.message);
        if (!rateOrAuth && server.step > MIN_STEP) {
          server.step = Math.max(MIN_STEP, Math.floor(server.step / 4));
        } else if (!rateOrAuth && err.rpcError && /range|block/i.test(err.message)) {
          // Refuse même une petite plage : ce serveur ne sert à rien ici
          server.tooSmall = true;
        } else {
          server.fails++;
          server.pauseUntil = Date.now() + Math.min(60000, 5000 * server.fails);
          current++;
        }
      }
    }
    return out;
  }

  // Transferts de dollars reçus (to) ou envoyés (from) par une adresse
  async function stableTransfers(address, dir, fromMs, toMs) {
    const topics = dir === "in" ? [TRANSFER, null, topicOf(address)] : [TRANSFER, topicOf(address)];
    const logs = await scanLogs({ address: cfg.stables, topics }, fromMs, toMs);
    const out = [];
    for (const l of logs) {
      out.push({
        from: addrOf(l.topics[1]),
        to: addrOf(l.topics[2]),
        amount: Number(BigInt(l.data)) / 1e6,
        token: l.address.toLowerCase(),
        ts: (await tsOf(l.blockNumber)) * 1000,
        tx: l.transactionHash,
      });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  async function nonce(address) {
    const n = await rpc("eth_getTransactionCount", [address, "latest"]).catch(() => null);
    return n != null ? parseInt(n, 16) : null;
  }

  async function isContract(address) {
    const code = await rpc("eth_getCode", [address, "latest"]).catch(() => null);
    return typeof code === "string" && code.length > 2;
  }

  return { key, ...cfg, rpc, latestBlock, blockAt, tsOf, scanLogs, stableTransfers, nonce, isContract };
}
