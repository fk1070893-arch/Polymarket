// Onglet « Alertes » : paris suspects détectés par scripts/build-alerts.mjs

import { cents, changeBadge, duration, esc, pct, shortAddress, timeAgo, translateOutcome, usd0 } from "./format.js";

const GROUPS = [
  { key: "all", label: "Tout" },
  { key: "politique", label: "Politique", tags: ["politics", "elections", "us-election", "global-elections", "geopolitics", "world", "trump", "france"] },
  { key: "crypto", label: "Crypto", tags: ["crypto", "bitcoin", "ethereum", "solana", "crypto-prices"] },
  { key: "eco", label: "Économie / Tech", tags: ["economy", "business", "finance", "fed", "tech", "ai", "stocks"] },
  { key: "sport", label: "Sport", tags: ["sports", "soccer", "football", "nfl", "nba", "tennis", "mlb", "nhl", "ufc"] },
  { key: "autre", label: "Autres" },
];

const filter = { min: 50, sort: "recent", group: "all", size: "all" };
// Bilan « si on avait suivi toutes les alertes »
const review = { window: "24h", stake: 10, min: 0, price: "all", size: "all", group: "all", buyable: false, realOnly: false };
let bound = false;

const $ = (id) => document.getElementById(id);

function groupOf(alert) {
  for (const g of GROUPS) if (g.tags && alert.tags?.some((t) => g.tags.includes(t))) return g.key;
  return "autre";
}

// Prix actuel de l'issue achetée, et événement correspondant s'il est ouvert
function liveInfo(ctx, a) {
  const hit = ctx.marketIndex().byCondition.get(a.conditionId);
  if (!hit) return { now: null, ev: null };
  return { now: hit.m.prices[a.outcomeIndex] ?? null, ev: hit.ev };
}

export function alertsForEvent(state, ev) {
  return (state.alerts ?? []).filter((a) => a.score >= 50 && (a.eventId === ev.id || (a.eventSlug && a.eventSlug === ev.slug)));
}

function scoreClass(s) {
  return s >= 70 ? "hot" : s >= 50 ? "warm" : "mild";
}

function walletLine(a) {
  const who = a.name ? esc(a.name) : shortAddress(a.wallet);
  const bits = [];
  if (a.walletAge != null) bits.push(`compte de ${duration(a.walletAge)}`);
  if (a.walletMarkets != null) bits.push(`${a.walletMarkets} marché${a.walletMarkets > 1 ? "s" : ""} joué${a.walletMarkets > 1 ? "s" : ""}`);
  return `<span class="who" title="${esc(a.wallet)}">${who}</span>${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

function marketLine(a) {
  if (a.marketLiquidity == null && a.marketVolume == null) return "";
  const k = (v) => (v == null ? "?" : usd0.format(v));
  return `<p class="alert-market">${a.small ? '<span class="flag small">Petit marché</span>' : ""}
    <span class="muted small">Liquidité ${k(a.marketLiquidity)} · volume total ${k(a.marketVolume)}</span></p>`;
}

// Résultat de l'alerte si on l'avait suivie (voir le bilan en haut de l'onglet)
function reviewLine(state, a) {
  const r = state.alertsReview?.rows?.find((x) => x.id === a.id);
  if (!r) return "";
  let out = "";
  if (r.status !== "unknown") {
    const sp = `${r.roi >= 0 ? "+" : ""}${Math.round(r.roi * 100)} %`;
    const txt = r.status === "won" ? `Gagné : ${sp}` : r.status === "lost" ? "Perdu" : `En cours : ${sp} si revendu maintenant`;
    out += ` <span class="flag ${r.roi >= 0 ? "good" : "alert"}">${txt}</span>`;
  }
  return out + depthLine(r);
}

const int = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

// Parts à vendre au moment où le site a vu l'alerte
function depthLine(r) {
  const d = r.depth;
  if (!d) return "";
  if (d.best == null) return `<span class="depth muted small">Aucune part à vendre quand le site a vu l'alerte</span>`;
  const late = d.late > 90 ? ` · carnet lu ${duration(d.late * 60)} après l'alerte` : "";
  const atWallet = d.atLimit != null && r.price > 0 ? ` · ${int.format(d.atLimit)} au prix du wallet (${cents(r.price)}) ou moins` : "";
  return `<span class="depth muted small">Parts à vendre : <b>${int.format(d.atBest)}</b> à ${cents(d.best)}, ${int.format(d.within5)} jusqu'à ${cents(Math.min(0.99, d.best + 0.05))} (${money2.format(d.usd5)})${atWallet}${late}</span>`;
}

const money2 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const signedUsd = (v) => `${v >= 0 ? "+" : "−"}${money2.format(Math.abs(v))}`;
const signedPct = (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)} %`;

const HOUR = 3600000;
const WINDOW_MS = { "24h": 24 * HOUR, "7j": 7 * 24 * HOUR };
const SCORES = [0, 50, 60, 70, 80, 90];
const PRICES = {
  all: { label: "Tous les prix", test: () => true },
  low: { label: "Moins de 30 ¢", test: (r) => r.price < 0.3 },
  mid: { label: "30 à 70 ¢", test: (r) => r.price >= 0.3 && r.price <= 0.7 },
  high: { label: "Plus de 70 ¢", test: (r) => r.price > 0.7 },
};
const SIZES = {
  all: { label: "Toutes les mises", min: 0 },
  "1k": { label: "Mise du wallet ≥ 1 000 $", min: 1000 },
  "5k": { label: "≥ 5 000 $", min: 5000 },
  "20k": { label: "≥ 20 000 $", min: 20000 },
};

function rowsIn(data, win) {
  const now = Date.now();
  return (data.rows ?? []).filter((r) => now - r.ts * 1000 < WINDOW_MS[win]);
}

// Assez de parts à vendre (à 5 ¢ près du meilleur prix) pour la mise choisie
const buyable = (r, stake) => r.depth?.best != null && r.depth.usd5 >= stake;

function matches(r, f, stake) {
  return (
    r.score >= f.min &&
    PRICES[f.price].test(r) &&
    (r.cash ?? 0) >= SIZES[f.size].min &&
    (f.group === "all" || groupOf(r) === f.group) &&
    (!f.buyable || buyable(r, stake)) &&
    (!f.realOnly || r.priceSource !== "wallet")
  );
}

function sumUp(rows) {
  const done = rows.filter((r) => r.status === "won" || r.status === "lost");
  const open = rows.filter((r) => r.status === "open");
  const realized = done.reduce((s, r) => s + r.roi, 0);
  const unrealized = open.reduce((s, r) => s + r.roi, 0);
  const unrealizedBest = open.reduce((s, r) => s + (r.roiBest ?? r.roi), 0);
  return {
    n: rows.length,
    resolved: done.length,
    won: done.filter((r) => r.status === "won").length,
    open: open.length,
    realized,
    unrealized,
    unrealizedBest,
    total: realized + unrealized,
    realPrice: rows.filter((r) => r.priceSource === "copie").length,
    bookPrice: rows.filter((r) => r.priceSource === "carnet").length,
    withDepth: rows.filter((r) => r.depth).length,
  };
}

function filterLabel(f) {
  const bits = [f.min ? `score ${f.min}+` : "tous les scores"];
  if (f.price !== "all") bits.push(PRICES[f.price].label.toLowerCase());
  if (f.size !== "all") bits.push(`mise du wallet ≥ ${int.format(SIZES[f.size].min)} $`);
  if (f.group !== "all") bits.push(GROUPS.find((g) => g.key === f.group).label.toLowerCase());
  if (f.buyable) bits.push("achetable");
  if (f.realOnly) bits.push("prix réels");
  return bits.join(" · ");
}

const MIN_N = 10; // en dessous, le résultat d'un filtre ne veut rien dire

// Toutes les combinaisons de filtres, classées par gain moyen par alerte
function bestFilters(data, stake) {
  const rows = rowsIn(data, review.window);
  const other = rowsIn(data, review.window === "24h" ? "7j" : "24h");
  const out = [];
  for (const min of SCORES)
    for (const price of Object.keys(PRICES))
      for (const size of Object.keys(SIZES))
        for (const group of GROUPS.map((g) => g.key)) {
          const f = { min, price, size, group, buyable: review.buyable, realOnly: review.realOnly };
          const sel = rows.filter((r) => matches(r, f, stake));
          if (sel.length < MIN_N) continue;
          const s = sumUp(sel);
          const o = sumUp(other.filter((r) => matches(r, f, stake)));
          out.push({ f, s, avg: s.total / s.n, other: o });
        }
  // Une même sélection d'alertes peut sortir de plusieurs combinaisons : on
  // garde la plus simple
  const seen = new Set();
  return out
    .sort((a, b) => b.avg - a.avg || a.s.n - b.s.n)
    .filter((x) => {
      const k = `${x.s.n}:${x.s.total.toFixed(6)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
}

function selectBox(id, options, value) {
  return `<select id="${id}">${options.map(([k, l]) => `<option value="${k}"${String(k) === String(value) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}

function renderReview(ctx) {
  const box = $("alerts-review");
  const data = ctx.state.alertsReview;
  if (!data?.rows) {
    box.innerHTML = "";
    return;
  }
  const k = review.stake;
  const all = rowsIn(data, review.window);
  const rows = all.filter((r) => matches(r, review, k));
  const w = sumUp(rows);
  const thresholds = SCORES.map((min) => ({ min, ...sumUp(all.filter((r) => matches(r, { ...review, min }, k))) }));
  const best = bestFilters(data, k);
  const otherLabel = review.window === "24h" ? "7 jours" : "24 h";
  box.innerHTML = `
    <section class="verdict live">
      <h2>Si on avait suivi toutes les alertes</h2>
      <div class="review-controls">
        <nav class="chips">
          ${[["24h", "Dernières 24 h"], ["7j", "7 derniers jours"]]
            .map(([key, l]) => `<button type="button" class="chip${key === review.window ? " active" : ""}" data-review-window="${key}" aria-pressed="${key === review.window}">${l}</button>`)
            .join("")}
        </nav>
        <label class="sort"><span>Mise par alerte</span>
          <span class="amount-input small"><input id="review-stake" type="number" min="1" step="1" value="${k}" inputmode="decimal" /><span>$</span></span></label>
      </div>
      <nav class="chips" aria-label="Score minimum">
        ${SCORES.map(
          (min) =>
            `<button type="button" class="chip${min === review.min ? " active" : ""}" data-review-min="${min}" aria-pressed="${min === review.min}">${min ? `Score ${min}+` : "Toutes"}</button>`
        ).join("")}
      </nav>
      <div class="review-controls review-filters">
        <label class="sort"><span>Prix</span>${selectBox("review-price", Object.entries(PRICES).map(([key, v]) => [key, v.label]), review.price)}</label>
        <label class="sort"><span>Mise du wallet</span>${selectBox("review-size", Object.entries(SIZES).map(([key, v]) => [key, key === "all" ? v.label : `≥ ${int.format(v.min)} $`]), review.size)}</label>
        <label class="sort"><span>Catégorie</span>${selectBox("review-group", GROUPS.map((g) => [g.key, g.label]), review.group)}</label>
        <label class="check"><input id="review-buyable" type="checkbox"${review.buyable ? " checked" : ""} /> Seulement si assez de parts à vendre pour ma mise</label>
        <label class="check"><input id="review-real" type="checkbox"${review.realOnly ? " checked" : ""} /> Seulement les prix réellement disponibles (pas celui du wallet)</label>
      </div>
      ${
        w.n
          ? `<div class="pf-stats review-stats">
              <div class="stat"><span>Misé</span><strong>${money2.format(w.n * k)}</strong><em class="muted">${w.n} alertes</em></div>
              <div class="stat"><span>Gagné / perdu (terminées)</span><strong class="${w.realized >= 0 ? "up" : "down"}">${signedUsd(w.realized * k)}</strong><em class="muted">${w.resolved} terminées, ${w.won} gagnées</em></div>
              <div class="stat"><span>En cours, si revendu maintenant</span><strong class="${w.unrealized >= 0 ? "up" : "down"}">${signedUsd(w.unrealized * k)}</strong><em class="muted">${w.open} en cours${
                w.unrealizedBest - w.unrealized > 0.005 ? ` · dont ${money2.format((w.unrealizedBest - w.unrealized) * k)} perdus en glissement à la revente` : ""
              }</em></div>
              <div class="stat big"><span>Total</span><strong class="${w.total >= 0 ? "up" : "down"}">${signedUsd(w.total * k)}</strong><em class="${w.total >= 0 ? "up" : "down"}">${signedPct(w.total / w.n)} de la mise</em></div>
            </div>`
          : `<p>Aucune alerte avec ces filtres sur cette période.</p>`
      }
      <h3>Selon le score minimum suivi</h3>
      <div class="table-wrap"><table class="bt-table">
        <thead><tr><th>Alertes suivies</th><th class="num">Nombre</th><th class="num">Terminées (gagnées)</th><th class="num">Total</th></tr></thead>
        <tbody>${thresholds
          .map(
            (t) => `<tr class="${t.min === review.min ? "active" : ""}"><td>${t.min ? `Score ${t.min} et plus` : "Toutes"}</td><td class="num">${t.n}</td><td class="num">${t.resolved} (${t.won})</td>
              <td class="num ${t.total >= 0 ? "up" : "down"}">${t.n ? `${signedUsd(t.total * k)} <span class="ci">${signedPct(t.total / t.n)}</span>` : "—"}</td></tr>`
          )
          .join("")}</tbody>
      </table></div>
      <h3>Les filtres qui auraient le mieux marché</h3>
      ${
        best.length
          ? `<div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Filtre</th><th class="num">Alertes</th><th class="num">Par alerte</th><th class="num">Total</th><th class="num">Même filtre sur ${otherLabel}</th><th></th></tr></thead>
              <tbody>${best
                .map(
                  (b, i) => `<tr><td>${esc(filterLabel(b.f))}</td><td class="num">${b.s.n} <span class="ci">${b.s.resolved} terminées</span></td>
                    <td class="num ${b.avg >= 0 ? "up" : "down"}">${signedPct(b.avg)}</td>
                    <td class="num ${b.s.total >= 0 ? "up" : "down"}">${signedUsd(b.s.total * k)}</td>
                    <td class="num ${b.other.total >= 0 ? "up" : "down"}">${b.other.n ? `${signedPct(b.other.total / b.other.n)} <span class="ci">${b.other.n} alertes</span>` : "—"}</td>
                    <td><button type="button" class="btn small" data-review-apply="${i}">Appliquer</button></td></tr>`
                )
                .join("")}</tbody>
            </table></div>
            <p class="muted small">Toutes les combinaisons (score × prix × mise du wallet × catégorie) sont essayées sur la période choisie, avec au moins ${MIN_N} alertes chacune.
              Attention : le meilleur filtre sur une période est souvent de la chance (on en essaie des centaines). Regarde la colonne « même filtre sur ${otherLabel} » :
              un filtre qui ne tient que sur une période ne vaut rien. Et la plupart de ces marchés ne sont pas terminés.</p>`
          : `<p class="muted small">Pas assez d'alertes (au moins ${MIN_N} par filtre) pour comparer des filtres.</p>`
      }
      <p class="muted small">Prix d'achat, pour une mise de 100 $ avec glissement et frais : celui obtenu par le test « copier les alertes » (${w.realPrice} alerte${w.realPrice > 1 ? "s" : ""}),
        sinon celui du carnet d'ordres lu par le site dans la demi-heure après l'alerte (${w.bookPrice}). Pour les ${w.n - w.realPrice - w.bookPrice} autres, celui payé par le wallet suspect plus les frais, impossible à obtenir en le copiant (résultat trop beau).
        Marché annulé (réglé 50/50) : 0,50 $ par part.
        « Si revendu maintenant » : revente de toutes les parts d'une mise de 100 $ aux acheteurs du carnet d'ordres (glissement compris), frais déduits.
        Parts à vendre : lues dans le carnet d'ordres quand le site voit l'alerte (${w.withDepth} alerte${w.withDepth > 1 ? "s" : ""} sur ${w.n} ; les plus anciennes n'en ont pas).
        Mis à jour ${timeAgo(new Date(data.updatedAt).getTime())}.</p>
    </section>`;
  bestCache = best;
}
let bestCache = [];

// ---------- Pistes : d'où vient l'argent des wallets suspects gagnants ----------

const KIND_FR = {
  polymarket: ["Compte Polymarket", "good"],
  plateforme: ["Plateforme (échange, pont)", ""],
  contrat: ["Contrat", ""],
  wallet: ["Wallet personnel", "alert"],
};
const profile = (addr, text) => `<a href="https://polymarket.com/profile/${esc(addr)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const scan = (addr) => `<a href="https://polygonscan.com/address/${esc(addr)}" target="_blank" rel="noopener noreferrer">${shortAddress(addr)}</a>`;

function funderLine(f) {
  const [kind, tone] = KIND_FR[f.kind] ?? KIND_FR.wallet;
  const who =
    f.kind === "polymarket" && f.pm
      ? `${profile(f.pm.proxy, f.pm.name ? `<b>${esc(f.pm.name)}</b>` : shortAddress(f.pm.proxy))} <span class="muted small">(${f.pm.trades >= 500 ? "500+" : f.pm.trades} paris${
          f.pm.value != null ? `, ${usd0.format(f.pm.value)} en jeu` : ""
        }${f.pm.since ? `, actif depuis ${timeAgo(f.pm.since).replace("il y a ", "")}` : ""})</span>`
      : `${f.label ? `<b>${esc(f.label)}</b> ` : ""}${scan(f.address)}`;
  return `<li><span class="flag ${tone}">${kind}</span> ${who} · a envoyé <b>${usd0.format(f.amount)}</b>${f.count > 1 ? ` en ${f.count} fois` : ""}, ${timeAgo(f.first)}${
    f.shared > 1 ? ` · <b class="down">a aussi financé ${f.shared - 1} autre${f.shared > 2 ? "s" : ""} wallet${f.shared > 2 ? "s" : ""} suspect${f.shared > 2 ? "s" : ""}</b>` : ""
  }</li>`;
}

function renderTrails(ctx) {
  const box = $("alerts-trails");
  const data = ctx.state.walletTrails;
  if (!data?.wallets) {
    box.innerHTML = "";
    return;
  }
  const withMain = data.wallets.filter((w) => w.main);
  const clusters = data.clusters ?? [];
  box.innerHTML = `
    <section class="verdict trails">
      <h2>D'où vient l'argent des wallets suspects gagnants ?</h2>
      <p class="muted small">Wallets de moins de 30 jours dont les alertes ont gagné (${data.candidates ?? data.wallets.length}) : leurs premiers dépôts en dollars, lus sur la blockchain Polygon (publique).
        Si l'argent vient d'un autre compte Polymarket, c'est sans doute le compte principal de la même personne. Un transfert ne le prouve pas (ça peut être un paiement),
        et beaucoup viennent d'une plateforme d'échange : piste froide. Mis à jour ${timeAgo(new Date(data.updatedAt).getTime())}.</p>
      ${
        clusters.length
          ? `<h3>Une même adresse derrière plusieurs wallets suspects</h3><ul class="trail-list">${clusters
              .map(
                (c) =>
                  `<li>${c.kind === "polymarket" && c.pm ? profile(c.pm.proxy, c.pm.name ? `<b>${esc(c.pm.name)}</b>` : shortAddress(c.pm.proxy)) : `${c.label ? `<b>${esc(c.label)}</b> ` : ""}${scan(c.address)}`}
                  a financé <b>${c.wallets.length} wallets suspects</b> : ${c.wallets.map((w) => profile(w, shortAddress(w))).join(", ")}</li>`
              )
              .join("")}</ul>`
          : ""
      }
      ${withMain.length ? `<p><b>${withMain.length}</b> compte${withMain.length > 1 ? "s" : ""} principa${withMain.length > 1 ? "ux" : "l"} probable${withMain.length > 1 ? "s" : ""} trouvé${withMain.length > 1 ? "s" : ""}.</p>` : ""}
      ${
        data.wallets.length
          ? `<div class="trail-cards">${data.wallets
              .slice(0, 20)
              .map(
                (w) => `
            <article class="trail">
              <header>
                ${profile(w.wallet, w.name ? `<b>${esc(w.name)}</b>` : `<b>${shortAddress(w.wallet)}</b>`)}
                <span class="muted small">compte de ${duration(w.age)} · ${w.alerts} alerte${w.alerts > 1 ? "s" : ""} (score max ${w.best}) · ${w.won} gagnée${w.won > 1 ? "s" : ""}, ${w.lost} perdue${
                  w.lost > 1 ? "s" : ""
                } · ${usd0.format(w.cash)} misés</span>
              </header>
              ${
                w.main
                  ? `<p class="trail-main">Compte principal probable : ${profile(w.main.proxy, w.main.name ? `<b>${esc(w.main.name)}</b>` : shortAddress(w.main.proxy))}</p>`
                  : ""
              }
              ${
                w.funders.length
                  ? `<ul class="trail-list">${w.funders.map(funderLine).join("")}</ul>`
                  : `<p class="muted small">${w.error ? `Lecture de la blockchain en échec (${esc(w.error)}) : nouvel essai dans l'heure.` : "Aucun dépôt en dollars trouvé (argent arrivé autrement)."}</p>`
              }
            </article>`
              )
              .join("")}</div>`
          : `<p class="muted small">Aucun wallet récent n'a encore d'alerte gagnante sur un marché terminé.</p>`
      }
    </section>`;
}

function moveLine(a, now) {
  if (now == null) return `<span class="muted">Marché clôturé ou hors liste</span>`;
  return `Aujourd'hui : <b>${pct(now)}</b> ${changeBadge(now - a.price) || '<span class="chg">=</span>'}`;
}

function alertCard(ctx, a) {
  const { now, ev } = liveInfo(ctx, a);
  const question = a.title || a.eventTitle;
  const showEvent = a.eventTitle && a.eventTitle !== question;
  return `
    <article class="alert-card">
      <div class="score ${scoreClass(a.score)}" title="Score de suspicion sur 100"><b>${a.score}</b><span>/100</span></div>
      <div class="alert-main">
        ${showEvent ? `<p class="alert-event">${esc(a.eventTitle)}</p>` : ""}
        <h3>${esc(question)}</h3>
        <p class="alert-bet">
          A misé <b>${usd0.format(a.cash)}</b> sur « <b>${esc(translateOutcome(a.outcome))}</b> » à <b>${pct(a.price)}</b>
          <span class="muted">· ${timeAgo(a.ts * 1000)}</span>
        </p>
        <p class="alert-move">${moveLine(a, now)}${reviewLine(ctx.state, a)}</p>
        ${marketLine(a)}
        <div class="reasons">${a.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div>
        <footer>
          <span class="wallet">${walletLine(a)}</span>
          <span class="links">
            ${ev ? `<button type="button" class="link" data-open-event="${esc(ev.id)}" data-condition="${esc(a.conditionId)}">Voir le marché</button>` : ""}
            <a class="link" href="https://polymarket.com/profile/${esc(a.wallet)}" target="_blank" rel="noopener noreferrer">Wallet ↗</a>
          </span>
        </footer>
      </div>
    </article>`;
}

export function alertMiniList(ctx, alerts) {
  return `<div class="alert-mini">${alerts
    .map((a) => {
      const { now } = liveInfo(ctx, a);
      return `
      <button type="button" class="alert-mini-row" data-alert-market="${esc(a.conditionId)}">
        <span class="score sm ${scoreClass(a.score)}"><b>${a.score}</b></span>
        <span class="alert-mini-text">${usd0.format(a.cash)} sur « ${esc(translateOutcome(a.outcome))} »${
          a.title && a.title !== a.eventTitle ? ` · ${esc(a.title)}` : ""
        } à ${pct(a.price)} <span class="muted">· ${timeAgo(a.ts * 1000)}${now != null ? ` · maintenant ${pct(now)}` : ""}</span></span>
      </button>`;
    })
    .join("")}</div>`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("alerts-min").addEventListener("change", (e) => {
    filter.min = Number(e.target.value);
    renderAlerts(ctx);
  });
  $("alerts-size").addEventListener("change", (e) => {
    filter.size = e.target.value;
    renderAlerts(ctx);
  });
  $("alerts-review").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-review-window]");
    const min = e.target.closest("[data-review-min]");
    const apply = e.target.closest("[data-review-apply]");
    if (chip) review.window = chip.dataset.reviewWindow;
    else if (min) review.min = Number(min.dataset.reviewMin);
    else if (apply) Object.assign(review, bestCache[Number(apply.dataset.reviewApply)]?.f ?? {});
    else return;
    renderReview(ctx);
  });
  $("alerts-review").addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "review-stake") {
      const v = Number(t.value);
      if (v > 0) review.stake = v;
    } else if (t.id === "review-price") review.price = t.value;
    else if (t.id === "review-size") review.size = t.value;
    else if (t.id === "review-group") review.group = t.value;
    else if (t.id === "review-buyable") review.buyable = t.checked;
    else if (t.id === "review-real") review.realOnly = t.checked;
    else return;
    renderReview(ctx);
  });
  $("alerts-sort").addEventListener("change", (e) => {
    filter.sort = e.target.value;
    renderAlerts(ctx);
  });
  $("alerts-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    filter.group = chip.dataset.group;
    renderAlerts(ctx);
  });
  $("alerts-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-event]");
    if (!btn) return;
    const { ev } = liveInfo(ctx, { conditionId: btn.dataset.condition, outcomeIndex: 0 });
    const m = ev?.markets.find((x) => x.conditionId === btn.dataset.condition);
    ctx.openDetail(btn.dataset.openEvent, { marketId: m?.id });
  });
}

export function renderAlerts(ctx) {
  bind(ctx);
  const { state } = ctx;
  const list = $("alerts-list");
  renderReview(ctx);
  renderTrails(ctx);

  const all = state.alerts ?? [];
  const counts = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  const sizeOk = (a) => filter.size === "all" || (filter.size === "small" ? a.small === true : !a.small);
  for (const a of all) {
    if (a.score < filter.min || !sizeOk(a)) continue;
    counts.all++;
    counts[groupOf(a)]++;
  }
  $("alerts-chips").innerHTML = GROUPS.map(
    (g) =>
      `<button type="button" class="chip${g.key === filter.group ? " active" : ""}" data-group="${g.key}" aria-pressed="${
        g.key === filter.group
      }">${g.label} <span class="count">${counts[g.key]}</span></button>`
  ).join("");

  if (state.alerts === null) {
    list.innerHTML = `<p class="empty">Chargement des alertes…</p>`;
    return;
  }
  if (state.alertsError && all.length === 0) {
    list.innerHTML = `<p class="empty">Les alertes ne sont pas encore disponibles. Elles sont calculées toutes les 5 minutes par la GitHub Action : réessaie un peu plus tard.</p>`;
    return;
  }

  let shown = all.filter((a) => a.score >= filter.min && sizeOk(a) && (filter.group === "all" || groupOf(a) === filter.group));
  const move = (a) => {
    const { now } = liveInfo(ctx, a);
    return now == null ? -Infinity : now - a.price;
  };
  const by = {
    recent: (a, b) => b.ts - a.ts,
    score: (a, b) => b.score - a.score || b.ts - a.ts,
    cash: (a, b) => b.cash - a.cash,
    move: (a, b) => move(b) - move(a),
  }[filter.sort];
  shown = [...shown].sort(by).slice(0, 150);

  if (shown.length === 0) {
    list.innerHTML = `<p class="empty">Aucun pari suspect avec ces filtres sur les 7 derniers jours. Baisse le score minimum ou change de catégorie.</p>`;
    return;
  }
  const updated = state.alertsUpdatedAt ? `<p class="muted small">Analyse mise à jour ${timeAgo(new Date(state.alertsUpdatedAt).getTime())}.</p>` : "";
  list.innerHTML = updated + shown.map((a) => alertCard(ctx, a)).join("");
}
