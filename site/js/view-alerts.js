// Onglet « Alertes » : paris suspects détectés par scripts/build-alerts.mjs

import { changeBadge, duration, esc, pct, shortAddress, timeAgo, translateOutcome, usd0 } from "./format.js";

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
const review = { window: "24h", stake: 10 };
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
  if (!r || r.status === "unknown") return "";
  const sp = `${r.roi >= 0 ? "+" : ""}${Math.round(r.roi * 100)} %`;
  const txt = r.status === "won" ? `Gagné : ${sp}` : r.status === "lost" ? "Perdu" : `En cours : ${sp} si revendu maintenant`;
  return ` <span class="flag ${r.roi >= 0 ? "good" : "alert"}">${txt}</span>`;
}

const money2 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const signedUsd = (v) => `${v >= 0 ? "+" : "−"}${money2.format(Math.abs(v))}`;

function renderReview(ctx) {
  const box = $("alerts-review");
  const data = ctx.state.alertsReview;
  if (!data?.windows) {
    box.innerHTML = "";
    return;
  }
  const w = data.windows[review.window];
  const k = review.stake;
  const pctOf = (v) => (w.n ? `${v >= 0 ? "+" : ""}${Math.round((v / w.n) * 100)} %` : "—");
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
      ${
        w.n
          ? `<div class="pf-stats review-stats">
              <div class="stat"><span>Misé</span><strong>${money2.format(w.n * k)}</strong><em class="muted">${w.n} alertes</em></div>
              <div class="stat"><span>Gagné / perdu (terminées)</span><strong class="${w.realized >= 0 ? "up" : "down"}">${signedUsd(w.realized * k)}</strong><em class="muted">${w.resolved} terminées, ${w.won} gagnées</em></div>
              <div class="stat"><span>En cours, si revendu maintenant</span><strong class="${w.unrealized >= 0 ? "up" : "down"}">${signedUsd(w.unrealized * k)}</strong><em class="muted">${w.open} en cours</em></div>
              <div class="stat big"><span>Total</span><strong class="${w.total >= 0 ? "up" : "down"}">${signedUsd(w.total * k)}</strong><em class="${w.total >= 0 ? "up" : "down"}">${pctOf(w.total)} de la mise</em></div>
            </div>
            <div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Alertes</th><th class="num">Nombre</th><th class="num">Terminées (gagnées)</th><th class="num">Total</th></tr></thead>
              <tbody>${w.byScore
                .filter((b) => b.n)
                .map(
                  (b) => `<tr><td>${b.label}</td><td class="num">${b.n}</td><td class="num">${b.resolved} (${b.won})</td>
                    <td class="num ${b.total >= 0 ? "up" : "down"}">${signedUsd(b.total * k)} <span class="ci">${b.total >= 0 ? "+" : ""}${Math.round((b.total / b.n) * 100)} %</span></td></tr>`
                )
                .join("")}</tbody>
            </table></div>
            <p class="muted small">Prix d'achat : celui réellement obtenu par le test « copier les alertes » pour ${w.realPrice} alerte${w.realPrice > 1 ? "s" : ""} sur ${w.n}
              (mise de 100 $, glissement et frais compris) ; pour les autres, celui payé par le wallet suspect plus les frais du marché, impossible à obtenir en le copiant (le résultat réel serait moins bon).
              « Si revendu maintenant » utilise le meilleur prix d'achat actuel, frais déduits (sans le glissement à la revente). La plupart des marchés ne sont pas encore terminés : ce total bouge à chaque actualisation.
              Mis à jour ${timeAgo(new Date(data.updatedAt).getTime())}.</p>`
          : `<p>Aucune alerte sur cette période.</p>`
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
            <a class="link" href="https://polygonscan.com/address/${esc(a.wallet)}" target="_blank" rel="noopener noreferrer">Wallet ↗</a>
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
    if (!chip) return;
    review.window = chip.dataset.reviewWindow;
    renderReview(ctx);
  });
  $("alerts-review").addEventListener("change", (e) => {
    if (e.target.id !== "review-stake") return;
    const v = Number(e.target.value);
    if (v > 0) review.stake = v;
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
