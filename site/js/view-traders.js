// Onglet « Traders » : les wallets les plus rentables de Polymarket et leurs
// derniers paris (données de scripts/build-leaders.mjs). On peut en suivre
// certains : ils restent en haut de la liste (choix gardé dans le navigateur).

import { esc, pct, shortAddress, timeAgo, usd0 } from "./format.js";

const $ = (id) => document.getElementById(id);
const KEY = "pm-followed-wallets";
const filter = { period: "week" };
let bound = false;

function loadFollowed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
const followed = loadFollowed();
function saveFollowed() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...followed]));
  } catch {
    // stockage indisponible : le suivi ne dure que le temps de la visite
  }
}

const yesNo = (o) => (o === "Yes" ? "Oui" : o === "No" ? "Non" : o);
const signed = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${usd0.format(Math.abs(v))}`);

function tradeLine(t) {
  const verb = t.side === "SELL" ? "vend" : "achète";
  return `<li><span class="muted small">${t.ts ? timeAgo(t.ts * 1000) : ""}</span> ${verb} <b>${usd0.format(t.cash)}</b> de « ${esc(yesNo(t.outcome))} » à ${
    t.price != null ? pct(t.price) : "?"
  } · ${t.eventSlug ? `<a href="https://polymarket.com/event/${esc(t.eventSlug)}" target="_blank" rel="noopener noreferrer">${esc(t.title)}</a>` : esc(t.title)}</li>`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("traders-body").addEventListener("click", (e) => {
    const p = e.target.closest("[data-period]");
    if (p) {
      filter.period = p.dataset.period;
      renderTraders(ctx);
      return;
    }
    const f = e.target.closest("[data-follow]");
    if (f) {
      const w = f.dataset.follow;
      if (followed.has(w)) followed.delete(w);
      else followed.add(w);
      saveFollowed();
      renderTraders(ctx);
    }
  });
}

export function renderTraders(ctx) {
  bind(ctx);
  const body = $("traders-body");
  const data = ctx.state.leaders;
  if (data === null) {
    body.innerHTML = `<p class="empty">Chargement du classement…</p>`;
    return;
  }
  if (!data?.week && !data?.month) {
    body.innerHTML = `<p class="empty">Le classement n'est pas encore disponible : il est mis à jour une fois par heure par la GitHub Action.</p>`;
    return;
  }
  const rows = [...(data[filter.period] ?? [])].sort((a, b) => Number(followed.has(b.wallet)) - Number(followed.has(a.wallet)) || a.rank - b.rank);
  body.innerHTML = `
    <nav class="chips">
      <button type="button" class="chip${filter.period === "week" ? " active" : ""}" data-period="week" aria-pressed="${filter.period === "week"}">Cette semaine</button>
      <button type="button" class="chip${filter.period === "month" ? " active" : ""}" data-period="month" aria-pressed="${filter.period === "month"}">Ce mois-ci</button>
    </nav>
    <p class="muted small">Mis à jour ${timeAgo(new Date(data.updatedAt).getTime())}. Classement par gains, d'après Polymarket. Un gros gain récent peut être de la chance : regarde surtout ceux qui restent en haut semaine après semaine.</p>
    <div class="trader-list">
      ${rows
        .map((r) => {
          const trades = data.trades?.[r.wallet] ?? [];
          const isF = followed.has(r.wallet);
          return `
        <article class="trader${isF ? " followed" : ""}">
          <header>
            <span class="trader-rank">#${r.rank}</span>
            <span class="trader-name">${r.name ? `<b>${esc(r.name)}</b>` : ""}
              <a class="${r.name ? "muted small" : ""}" href="https://polygonscan.com/address/${esc(r.wallet)}" target="_blank" rel="noopener noreferrer">${shortAddress(r.wallet)} ↗</a></span>
            <span class="trader-pnl ${r.pnl >= 0 ? "up" : "down"}">${signed(r.pnl)}</span>
            <button type="button" class="chip${isF ? " active" : ""}" data-follow="${esc(r.wallet)}" aria-pressed="${isF}">${isF ? "★ Suivi" : "☆ Suivre"}</button>
          </header>
          ${r.volume != null ? `<p class="muted small">${usd0.format(r.volume)} échangés sur la période</p>` : ""}
          ${trades.length ? `<ul class="trader-trades">${trades.slice(0, isF ? 8 : 3).map(tradeLine).join("")}</ul>` : `<p class="muted small">Pas de pari récent.</p>`}
        </article>`;
        })
        .join("")}
    </div>`;
}
