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

const filter = { min: 50, sort: "recent", group: "all" };
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
        <p class="alert-move">${moveLine(a, now)}</p>
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

  const all = state.alerts ?? [];
  const counts = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  for (const a of all) {
    if (a.score < filter.min) continue;
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

  let shown = all.filter((a) => a.score >= filter.min && (filter.group === "all" || groupOf(a) === filter.group));
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
