import { loadAlerts, loadBacktest, loadCrypto, loadData, loadEvents, loadStrategy, loadHistory, loadMarketStates } from "./api.js";
import { mainMarket, yesPrice } from "./normalize.js";
import { lineChart, sparkline } from "./chart.js";
import {
  TAG_SKIP,
  cents,
  changeBadge,
  dateFmt,
  esc,
  money,
  pct,
  shortDateFmt,
  signedMoney,
  tagLabel,
  timeFmt,
  translateOutcome,
  usd,
  usd0,
} from "./format.js";
import { buy, loadPortfolio, settle } from "./portfolio.js";
import { renderAlerts, alertsForEvent, alertMiniList } from "./view-alerts.js";
import { renderPortfolio } from "./view-portfolio.js";
import { cryptoForMarket, renderCrypto } from "./view-crypto.js";
import { renderBacktest } from "./view-backtest.js";
import { renderStrategies } from "./view-strategies.js";
import { renderRadar } from "./view-radar.js";
import { renderCalendar } from "./view-calendar.js";
import { renderTraders } from "./view-traders.js";
import { marketInsights } from "./view-insights.js";

const PAGE = 24;
const LIVE_REFRESH_MS = 2 * 60 * 1000;
const VIEWS = {
  "": "markets",
  radar: "radar",
  alertes: "alerts",
  strategies: "strategies",
  calendrier: "calendar",
  traders: "traders",
  crypto: "crypto",
  backtest: "backtest",
  portefeuille: "portfolio",
  comprendre: "learn",
};
// Onglets qui ont besoin des fichiers des tests en direct
const NEEDS_TESTS = new Set(["strategies", "radar", "portfolio"]);

const state = {
  view: "markets",
  events: [],
  histories: {},
  source: null,
  updatedAt: null,
  query: "",
  category: "all",
  sort: "volume24h",
  shown: PAGE,
  favorites: loadFavorites(),
  alerts: null, // null = pas encore chargées
  alertsUpdatedAt: null,
  alertsError: false,
  portfolio: loadPortfolio(),
  strategy: null, // test en direct de la stratégie (null = pas encore chargé, false = indisponible)
  copy: null, // test en direct : copier les alertes
  odds: null, // test en direct : bookmakers
  arbs: null, // anomalies de prix
  fresh: null, // test en direct : marchés tout neufs
  cross: null, // Kalshi et Metaculus
  calendar: null, // fins de marché et résultats récents
  leaders: null, // classement des traders
  backtest: null, // résultats du backtest (null = pas encore chargé, false = indisponible)
  crypto: null, // modèle crypto (null = pas encore chargé, false = indisponible)
  marketStates: {}, // prix / résultats des marchés hors liste (portefeuille)
};

const $ = (id) => document.getElementById(id);

// ---------- Utilitaires ----------

function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem("pm-favorites") ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  try {
    localStorage.setItem("pm-favorites", JSON.stringify([...state.favorites]));
  } catch {
    // stockage indisponible (navigation privée) : on ignore
  }
}

let toastTimer;
function toast(msg, kind = "") {
  const el = $("detail").open ? $("toast") : $("toast-page");
  for (const t of [$("toast"), $("toast-page")]) t.hidden = true;
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function daysLeft(endDate) {
  if (!endDate) return null;
  const ms = new Date(endDate).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.ceil(ms / 86400000);
}

function endLabel(endDate) {
  const d = daysLeft(endDate);
  if (d === null) return "";
  if (d < 0) return "En attente de résolution";
  if (d === 0) return "Se termine aujourd'hui";
  if (d === 1) return "Se termine demain";
  if (d < 60) return `Fin dans ${d} jours`;
  return `Fin le ${dateFmt.format(new Date(endDate))}`;
}

// Un événement binaire n'a qu'un marché Oui/Non ; sinon c'est un
// événement à plusieurs issues (ex. "Qui gagnera l'élection ?").
function isBinary(ev) {
  return ev.markets.length === 1;
}

function maxMove(ev) {
  return Math.max(0, ...ev.markets.map((m) => Math.abs(m.change24h)));
}

// Index des marchés ouverts, pour retrouver un prix rapidement
let marketIndex = { byId: new Map(), byCondition: new Map() };
function indexMarkets() {
  const byId = new Map();
  const byCondition = new Map();
  for (const ev of state.events) {
    for (const m of ev.markets) {
      byId.set(m.id, { ev, m });
      if (m.conditionId) byCondition.set(m.conditionId, { ev, m });
    }
  }
  marketIndex = { byId, byCondition };
}

// Prix actuel d'une issue d'un marché (ou null si inconnu)
function currentPrice(marketId, outcomeIndex) {
  const hit = marketIndex.byId.get(marketId);
  if (hit) return hit.m.prices[outcomeIndex] ?? null;
  const st = state.marketStates[marketId];
  return st?.p?.[outcomeIndex] ?? null;
}

// ---------- Filtres et tri ----------

function categories() {
  const counts = new Map();
  for (const ev of state.events) {
    for (const t of ev.tags) {
      if (TAG_SKIP.has(t.slug)) continue;
      const cur = counts.get(t.slug) ?? { tag: t, n: 0 };
      cur.n++;
      counts.set(t.slug, cur);
    }
  }
  return [...counts.values()]
    .filter((c) => c.n >= 3)
    .sort((a, b) => b.n - a.n)
    .slice(0, 14)
    .map((c) => c.tag);
}

function normalizeText(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function filtered() {
  const q = normalizeText(state.query.trim());
  let list = state.events;

  if (state.category === "favorites") list = list.filter((ev) => state.favorites.has(ev.id));
  else if (state.category !== "all") list = list.filter((ev) => ev.tags.some((t) => t.slug === state.category));

  if (q) {
    const words = q.split(/\s+/);
    list = list.filter((ev) => {
      const hay = normalizeText(
        [ev.title, ...ev.markets.map((m) => m.label || m.question), ...ev.tags.map((t) => `${t.label} ${tagLabel(t)}`)].join(" ")
      );
      return words.every((w) => hay.includes(w));
    });
  }

  const by = {
    volume24h: (a, b) => b.volume24h - a.volume24h,
    volume: (a, b) => b.volume - a.volume,
    liquidity: (a, b) => b.liquidity - a.liquidity,
    movers: (a, b) => maxMove(b) - maxMove(a),
    ending: (a, b) => {
      const da = daysLeft(a.endDate);
      const db = daysLeft(b.endDate);
      const ka = da === null || da < 0 ? Infinity : da;
      const kb = db === null || db < 0 ? Infinity : db;
      return ka - kb;
    },
    newest: (a, b) => new Date(b.startDate ?? 0) - new Date(a.startDate ?? 0),
  }[state.sort];

  return [...list].sort(by);
}

// ---------- Rendu : marchés ----------

function renderStatus() {
  const s = $("status");
  if (!state.source) {
    s.innerHTML = `<span class="pill">Chargement…</span>`;
    return;
  }
  const when = state.updatedAt ? timeFmt.format(new Date(state.updatedAt)) : "?";
  s.innerHTML =
    state.source === "live"
      ? `<span class="pill live" title="Données lues directement sur l'API Polymarket"><i></i>En direct<span class="when"> · ${when}</span></span>`
      : `<span class="pill snap" title="L'API Polymarket n'est pas joignable depuis votre connexion : affichage du dernier instantané">Instantané<span class="when"> · ${when}</span></span>`;
}

function renderChips() {
  const chips = [
    { slug: "all", label: "Tout" },
    { slug: "favorites", label: `★ Favoris${state.favorites.size ? ` (${state.favorites.size})` : ""}` },
    ...categories().map((t) => ({ slug: t.slug, label: tagLabel(t) })),
  ];
  $("chips").innerHTML = chips
    .map(
      (c) =>
        `<button type="button" class="chip${c.slug === state.category ? " active" : ""}" data-slug="${esc(c.slug)}" aria-pressed="${c.slug === state.category}">${esc(c.label)}</button>`
    )
    .join("");
}

function renderStats(list) {
  const vol24 = list.reduce((s, ev) => s + ev.volume24h, 0);
  const liq = list.reduce((s, ev) => s + ev.liquidity, 0);
  $("stats").innerHTML = `
    <div class="stat"><span>Événements</span><strong>${list.length.toLocaleString("fr-FR")}</strong></div>
    <div class="stat"><span>Volume 24 h</span><strong>${usd0.format(vol24)}</strong></div>
    <div class="stat"><span>Liquidité</span><strong>${usd0.format(liq)}</strong></div>`;
}

function outcomeRows(ev, limit) {
  if (isBinary(ev)) {
    const m = ev.markets[0];
    return m.outcomes
      .slice(0, 2)
      .map(
        (o, i) => `
        <div class="row">
          <span class="row-label">${esc(translateOutcome(o))}</span>
          <span class="bar"><i class="${i === 0 ? "yes" : "no"}" style="width:${(m.prices[i] ?? 0) * 100}%"></i></span>
          <span class="row-val">${pct(m.prices[i] ?? 0)}</span>
          ${i === 0 ? changeBadge(m.change24h) : '<span class="chg"></span>'}
        </div>`
      )
      .join("");
  }
  return ev.markets
    .slice(0, limit)
    .map(
      (m) => `
      <div class="row">
        <span class="row-label" title="${esc(m.question)}">${esc(m.label || m.question)}</span>
        <span class="bar"><i class="yes" style="width:${yesPrice(m) * 100}%"></i></span>
        <span class="row-val">${pct(yesPrice(m))}</span>
        ${changeBadge(m.change24h) || '<span class="chg"></span>'}
      </div>`
    )
    .join("");
}

function card(ev) {
  const fav = state.favorites.has(ev.id);
  const extra = isBinary(ev) ? 0 : ev.markets.length - 3;
  const hist = state.histories[mainMarket(ev)?.tokenId];
  const nAlerts = alertsForEvent(state, ev).length;
  const nPos = state.portfolio.positions.filter((p) => p.status === "open" && p.eventId === ev.id).length;
  return `
    <article class="card" data-id="${esc(ev.id)}" tabindex="0" role="button" aria-label="${esc(ev.title)}">
      <header>
        ${ev.image ? `<img src="${esc(ev.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
        <h3>${esc(ev.title)}</h3>
        <button type="button" class="fav${fav ? " on" : ""}" data-fav="${esc(ev.id)}" aria-pressed="${fav}" aria-label="${fav ? "Retirer des favoris" : "Ajouter aux favoris"}">★</button>
      </header>
      ${
        nAlerts || nPos
          ? `<div class="card-flags">${nAlerts ? `<span class="flag alert">${nAlerts} alerte${nAlerts > 1 ? "s" : ""}</span>` : ""}${
              nPos ? `<span class="flag pos">Ma prédiction</span>` : ""
            }</div>`
          : ""
      }
      <div class="rows">${outcomeRows(ev, 3)}</div>
      ${extra > 0 ? `<p class="extra">+ ${extra} autre${extra > 1 ? "s" : ""} issue${extra > 1 ? "s" : ""}</p>` : ""}
      <footer>
        <span>${usd.format(ev.volume)} vol.</span>
        <span>${esc(endLabel(ev.endDate))}</span>
        ${hist ? '<span class="spark-slot"></span>' : ""}
      </footer>
    </article>`;
}

function renderGrid() {
  if (!state.source) return;
  const list = filtered();
  renderStats(list);
  const grid = $("grid");

  if (list.length === 0) {
    grid.innerHTML = `<p class="empty">${
      state.category === "favorites"
        ? "Aucun favori pour l'instant. Cliquez sur ★ sur un marché pour le suivre."
        : "Aucun marché ne correspond à votre recherche."
    }</p>`;
    $("more").hidden = true;
    return;
  }

  const visible = list.slice(0, state.shown);
  grid.innerHTML = visible.map(card).join("");

  // Sparklines (uniquement pour les événements dont on a l'historique)
  for (const ev of visible) {
    const hist = state.histories[mainMarket(ev)?.tokenId];
    const slot = grid.querySelector(`.card[data-id="${CSS.escape(ev.id)}"] .spark-slot`);
    if (hist && slot) slot.append(sparkline(hist.map(([t, p]) => ({ t, p }))));
  }

  const more = $("more");
  more.hidden = list.length <= state.shown;
  more.textContent = `Afficher plus (${list.length - state.shown} restants)`;
}

function renderSkeleton() {
  $("grid").innerHTML = Array.from({ length: 9 }, () => `<div class="card skeleton"><i></i><i></i><i></i><i></i></div>`).join("");
}

// ---------- Vues ----------

const ctx = {
  state,
  toast,
  currentPrice,
  marketIndex: () => marketIndex,
  openDetail: (id, opts) => openDetail(id, opts),
  rerender: () => renderView(),
};

function renderAlertsBadge() {
  const b = $("alerts-badge");
  const since = Date.now() / 1000 - 86400;
  const n = (state.alerts ?? []).filter((a) => a.score >= 70 && a.ts > since).length;
  b.hidden = n === 0;
  b.textContent = n;
  b.title = `${n} alerte${n > 1 ? "s" : ""} très suspecte${n > 1 ? "s" : ""} ces dernières 24 h`;
}

function renderView() {
  renderStatus();
  renderAlertsBadge();
  for (const tab of document.querySelectorAll(".view-tab")) {
    const on = tab.dataset.view === state.view;
    tab.classList.toggle("active", on);
    if (on) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    panel.hidden = panel.dataset.viewPanel !== state.view;
  }
  if (state.view === "markets") {
    renderChips();
    renderGrid();
  } else if (state.view === "alerts") {
    renderAlerts(ctx);
  } else if (state.view === "crypto") {
    renderCrypto(ctx);
  } else if (state.view === "strategies") {
    renderStrategies(ctx);
  } else if (state.view === "radar") {
    renderRadar(ctx);
  } else if (state.view === "calendar") {
    renderCalendar(ctx);
  } else if (state.view === "traders") {
    renderTraders(ctx);
  } else if (state.view === "learn") {
    // page statique
  } else if (state.view === "backtest") {
    renderBacktest(ctx);
  } else {
    renderPortfolio(ctx);
  }
}

function viewFromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h in VIEWS) return { view: VIEWS[h] };
  return { view: state.view, slug: h.replace(/^marche\//, "") };
}

function viewHash(view) {
  const key = Object.keys(VIEWS).find((k) => VIEWS[k] === view) ?? "";
  return key ? `#${key}` : location.pathname + location.search;
}

function onRoute() {
  const { view, slug } = viewFromHash();
  if (view !== state.view) {
    state.view = view;
    window.scrollTo({ top: 0 });
    const reload = (fn) =>
      fn().then(() => {
        if (state.view === view && !$("detail").open) renderView();
      });
    if (NEEDS_TESTS.has(view) && state.strategy === null) reload(refreshStrategy);
    if (view === "calendar" && state.calendar === null) reload(refreshCalendar);
    if (view === "traders" && state.leaders === null) reload(refreshLeaders);
  }
  if (!slug && $("detail").open) $("detail").close(); // lien vers un onglet depuis une fiche
  renderView();
  if (slug) {
    const ev = state.events.find((e) => e.slug === slug || e.id === slug);
    if (ev) openDetail(ev.id, { keepHash: true });
  }
}

// ---------- Fiche détaillée ----------

let detailToken = 0;

async function drawHistory(market, interval) {
  const chartBox = $("detail-chart");
  const note = $("detail-chart-note");
  if (!chartBox || !market?.tokenId) return;
  const token = ++detailToken;
  chartBox.innerHTML = `<div class="chart-loading">Chargement de l'historique…</div>`;
  const { points, source } = await loadHistory(market.tokenId, interval);
  if (token !== detailToken) return; // une autre demande a pris le relais
  lineChart(chartBox, points, { interval: source === "snapshot" ? "1w" : interval });
  note.textContent =
    source === "snapshot" && interval !== "1w"
      ? "API injoignable : affichage de l'historique 7 jours de l'instantané."
      : "";
}

// Panneau "prédiction fictive" pour le marché sélectionné
function tradePanel(ev, market, pick) {
  const cash = state.portfolio.cash;
  const options = market.outcomes
    .map((o, i) => {
      const p = market.prices[i] ?? 0;
      return `<button type="button" class="pick ${i === 0 ? "yes" : "no"}${pick === i ? " on" : ""}" data-pick="${i}" ${
        p > 0 && p < 1 ? "" : "disabled"
      }>${esc(translateOutcome(o))} <b>${cents(p)}</b></button>`;
    })
    .join("");
  const mine = state.portfolio.positions.filter((p) => p.status === "open" && p.eventId === ev.id);
  const model = cryptoForMarket(state, market.id);
  const modelLine = model
    ? `<p class="model-hint">Modèle options Deribit : <b>${pct(model.model)}</b> pour « Oui » (Polymarket : ${pct(yesPrice(market))}).
        Sur le passé, ce modèle n'a pas fait mieux que Polymarket. <a href="#crypto">Voir le modèle crypto</a></p>`
    : "";
  return `
    <div class="trade-head">
      <h3>Ma prédiction <span class="muted">(fictive)</span></h3>
      <span class="muted">Solde : <b>${money.format(cash)}</b></span>
    </div>
    ${isBinary(ev) ? "" : `<p class="hint">Issue : <b>${esc(market.label || market.question)}</b></p>`}
    ${modelLine}
    <div class="picks">${options}</div>
    <div class="amount">
      <label for="trade-amount">Mise</label>
      <div class="amount-input"><input id="trade-amount" type="number" min="1" step="1" inputmode="decimal" value="${Math.min(50, Math.floor(cash)) || ""}" /><span>$</span></div>
      <div class="quick">${[50, 100, 250, 500, 1000].map((v) => `<button type="button" data-amount="${v}">${v}</button>`).join("")}</div>
    </div>
    <p class="trade-summary" id="trade-summary"></p>
    <button type="button" class="btn primary" id="trade-go" disabled>Valider la prédiction</button>
    ${
      mine.length
        ? `<div class="my-positions"><h4>Mes prédictions en cours sur ce marché</h4>${mine
            .map((p) => {
              const now = currentPrice(p.marketId, p.outcomeIndex);
              const pnl = p.shares * (now ?? p.price) - p.stake;
              return `<div class="mini-pos"><span>${esc(p.marketLabel ? `${p.marketLabel} · ` : "")}${esc(translateOutcome(p.outcome))} à ${cents(
                p.price
              )} · ${money.format(p.stake)}</span><span class="${pnl >= 0 ? "up" : "down"}">${signedMoney(pnl)}</span></div>`;
            })
            .join("")}</div>`
        : ""
    }`;
}

function openDetail(id, { keepHash = false, marketId = null, pick = null } = {}) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) {
    toast("Ce marché n'est plus dans la liste des marchés ouverts.");
    return;
  }
  let selected = ev.markets.find((m) => m.id === marketId) ?? mainMarket(ev);
  let interval = "1w";
  let tradePick = pick;
  const dlg = $("detail");

  const tags = ev.tags
    .filter((t) => !TAG_SKIP.has(t.slug))
    .slice(0, 6)
    .map((t) => `<span class="tag">${esc(tagLabel(t))}</span>`)
    .join("");

  const rows = isBinary(ev)
    ? outcomeRows(ev)
    : ev.markets
        .map(
          (m) => `
        <button type="button" class="row selectable${m === selected ? " selected" : ""}" data-market="${esc(m.id)}">
          <span class="row-label">${esc(m.label || m.question)}</span>
          <span class="bar"><i class="yes" style="width:${yesPrice(m) * 100}%"></i></span>
          <span class="row-val">${pct(yesPrice(m))}</span>
          ${changeBadge(m.change24h) || '<span class="chg"></span>'}
        </button>`
        )
        .join("");

  const evAlerts = alertsForEvent(state, ev);

  $("detail-body").innerHTML = `
    <header class="detail-head">
      ${ev.image ? `<img src="${esc(ev.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
      <div>
        <div class="tags">${tags}</div>
        <h2 id="detail-title">${esc(ev.title)}</h2>
      </div>
    </header>
    <div class="detail-stats">
      <div class="stat"><span>Volume total</span><strong>${usd.format(ev.volume)}</strong></div>
      <div class="stat"><span>Volume 24 h</span><strong>${usd.format(ev.volume24h)}</strong></div>
      <div class="stat"><span>Liquidité</span><strong>${usd.format(ev.liquidity)}</strong></div>
      <div class="stat"><span>Échéance</span><strong>${ev.endDate ? shortDateFmt.format(new Date(ev.endDate)) : "—"}</strong></div>
    </div>
    <section class="chart-card">
      <div class="chart-head">
        <h3 id="detail-chart-title"></h3>
        <div class="tabs" role="tablist">
          ${[["1d", "1 J"], ["1w", "1 S"], ["1m", "1 M"], ["max", "Max"]]
            .map(([k, l]) => `<button type="button" role="tab" data-interval="${k}" aria-selected="${k === interval}">${l}</button>`)
            .join("")}
        </div>
      </div>
      <div class="chart-box" id="detail-chart"></div>
      <p class="chart-note" id="detail-chart-note"></p>
    </section>
    <section class="trade" id="trade"></section>
    <div id="insights"></div>
    ${
      evAlerts.length
        ? `<section><h3>Paris suspects sur ce marché (${evAlerts.length})</h3>${alertMiniList(ctx, evAlerts.slice(0, 5))}</section>`
        : ""
    }
    <section>
      <h3>${isBinary(ev) ? "Probabilités" : `Issues (${ev.markets.length})`}</h3>
      ${isBinary(ev) ? "" : '<p class="hint">Clique sur une issue pour voir son historique et faire ta prédiction.</p>'}
      <div class="rows detail-rows">${rows}</div>
    </section>
    ${ev.description ? `<section><h3>Règles de résolution</h3><p class="desc">${esc(ev.description)}</p></section>` : ""}
  `;

  const setTitle = () => {
    $("detail-chart-title").textContent = isBinary(ev)
      ? `Probabilité « Oui » : ${pct(yesPrice(selected))}`
      : `${selected.label || selected.question} : ${pct(yesPrice(selected))}`;
  };

  const updateSummary = () => {
    const amount = parseFloat($("trade-amount").value);
    const go = $("trade-go");
    const sum = $("trade-summary");
    go.disabled = true;
    if (tradePick == null) {
      sum.textContent = "Choisis une issue.";
      return;
    }
    if (!(amount > 0)) {
      sum.textContent = "Indique une mise.";
      return;
    }
    if (amount > state.portfolio.cash + 1e-9) {
      sum.innerHTML = `<span class="down">Solde fictif insuffisant (${money.format(state.portfolio.cash)}).</span>`;
      return;
    }
    const shares = amount / selected.prices[tradePick];
    sum.innerHTML = `${shares.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} parts à ${cents(selected.prices[tradePick])}. Si tu as raison : <b class="up">${money.format(
      shares
    )}</b> (${signedMoney(shares - amount)}). Sinon : <b class="down">${signedMoney(-amount)}</b>.`;
    go.disabled = false;
  };

  const renderTrade = () => {
    $("trade").innerHTML = tradePanel(ev, selected, tradePick);
    updateSummary();
  };

  // Ce que les autres outils du site savent sur le marché choisi
  const fillInsights = () => {
    const box = $("insights");
    if (box) box.innerHTML = marketInsights(state, ev, selected);
  };

  setTitle();
  renderTrade();
  fillInsights();
  if (state.strategy === null) refreshStrategy().then(fillInsights);

  $("detail-body").oninput = (e) => {
    if (e.target.id === "trade-amount") updateSummary();
  };

  $("detail-body").onclick = (e) => {
    const tab = e.target.closest("[data-interval]");
    if (tab) {
      interval = tab.dataset.interval;
      $("detail-body").querySelectorAll("[data-interval]").forEach((b) => b.setAttribute("aria-selected", b === tab));
      drawHistory(selected, interval);
      return;
    }
    const pickBtn = e.target.closest("[data-pick]");
    if (pickBtn) {
      tradePick = Number(pickBtn.dataset.pick);
      $("trade").querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("on", b === pickBtn));
      updateSummary();
      return;
    }
    const amountBtn = e.target.closest("[data-amount]");
    if (amountBtn) {
      $("trade-amount").value = amountBtn.dataset.amount;
      updateSummary();
      return;
    }
    if (e.target.closest("#trade-go")) {
      try {
        const amount = parseFloat($("trade-amount").value);
        const pos = buy(state.portfolio, { event: ev, market: selected, outcomeIndex: tradePick, amount });
        toast(`Prédiction enregistrée : ${translateOutcome(pos.outcome)} à ${cents(pos.price)} pour ${money.format(pos.stake)}.`, "ok");
        tradePick = null;
        renderTrade();
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }
    const alertLink = e.target.closest("[data-alert-market]");
    if (alertLink) {
      const m = ev.markets.find((x) => x.conditionId === alertLink.dataset.alertMarket);
      if (m && !isBinary(ev)) $("detail-body").querySelector(`[data-market="${CSS.escape(m.id)}"]`)?.click();
      return;
    }
    const row = e.target.closest("[data-market]");
    if (row) {
      selected = ev.markets.find((m) => m.id === row.dataset.market) ?? selected;
      tradePick = null;
      $("detail-body").querySelectorAll("[data-market]").forEach((b) => b.classList.toggle("selected", b === row));
      setTitle();
      renderTrade();
      fillInsights();
      drawHistory(selected, interval);
      $("detail-chart").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  if (!dlg.open) dlg.showModal();
  dlg.querySelector(".detail-inner").scrollTop = 0;
  if (!keepHash) history.replaceState(null, "", `#marche/${encodeURIComponent(ev.slug || ev.id)}`);
  drawHistory(selected, interval);
}

function closeDetail() {
  $("detail").close();
}

// ---------- Événements ----------

function bind() {
  let t;
  $("search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.query = e.target.value;
      state.shown = PAGE;
      renderGrid();
    }, 150);
  });

  $("sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    state.shown = PAGE;
    renderGrid();
  });

  $("chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.category = chip.dataset.slug;
    state.shown = PAGE;
    renderChips();
    renderGrid();
  });

  $("more").addEventListener("click", () => {
    state.shown += PAGE;
    renderGrid();
  });

  $("grid").addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      e.stopPropagation();
      const id = favBtn.dataset.fav;
      state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
      saveFavorites();
      renderChips();
      renderGrid();
      return;
    }
    const c = e.target.closest(".card[data-id]");
    if (c) openDetail(c.dataset.id);
  });

  $("grid").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const c = e.target.closest(".card[data-id]");
    if (c && e.target === c) {
      e.preventDefault();
      openDetail(c.dataset.id);
    }
  });

  $("detail-close").addEventListener("click", closeDetail);
  $("detail").addEventListener("click", (e) => {
    if (e.target === $("detail")) closeDetail(); // clic sur le fond
  });
  $("detail").addEventListener("close", () => {
    detailToken++;
    history.replaceState(null, "", viewHash(state.view));
    renderView(); // reflète les nouvelles prédictions
  });

  window.addEventListener("hashchange", onRoute);

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && state.view === "markets" && document.activeElement !== $("search") && !$("detail").open) {
      e.preventDefault();
      $("search").focus();
    }
  });

  $("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("pm-theme", root.dataset.theme);
    } catch {}
  });
}

function restoreTheme() {
  try {
    const t = localStorage.getItem("pm-theme");
    if (t) document.documentElement.dataset.theme = t;
  } catch {}
}

// ---------- Chargement ----------

// Le backtest ne change qu'une fois par semaine : on ne le recharge pas à chaque fois
let backtestLoadedAt = 0;
async function refreshBacktest() {
  if (Date.now() - backtestLoadedAt < 30 * 60 * 1000 && state.backtest) return;
  try {
    state.backtest = await loadBacktest();
    backtestLoadedAt = Date.now();
  } catch {
    state.backtest ??= false;
  }
}

async function refreshStrategy() {
  const load = async (key, fn) => {
    try {
      state[key] = await fn();
    } catch {
      state[key] ??= false;
    }
  };
  await Promise.all([
    load("strategy", loadStrategy),
    load("copy", () => loadData("copy")),
    load("odds", () => loadData("odds")),
    load("arbs", () => loadData("arbs")),
    load("fresh", () => loadData("fresh")),
    load("cross", () => loadData("cross")),
  ]);
}

async function refreshCalendar() {
  try {
    state.calendar = await loadData("calendar");
  } catch {
    state.calendar ??= false;
  }
}

async function refreshLeaders() {
  try {
    state.leaders = await loadData("leaders");
  } catch {
    state.leaders ??= false;
  }
}

async function refreshCrypto() {
  try {
    state.crypto = await loadCrypto();
  } catch {
    state.crypto ??= false;
  }
}

// Les marchés crypto analysés ne sont pas tous dans le top 500 : on ajoute
// leurs événements pour pouvoir ouvrir leur fiche.
function mergeCryptoEvents() {
  const extra = state.crypto?.events ?? [];
  if (!extra.length) return;
  const known = new Set(state.events.map((e) => e.id));
  state.events = state.events.concat(extra.filter((e) => !known.has(e.id)));
}

async function refreshAlerts() {
  try {
    const { alerts, updatedAt } = await loadAlerts();
    state.alerts = alerts;
    state.alertsUpdatedAt = updatedAt;
    state.alertsError = false;
  } catch {
    state.alerts ??= [];
    state.alertsError = true;
  }
}

// Met à jour le prix / le résultat des marchés du portefeuille qui ne sont
// plus dans la liste, puis règle les positions terminées.
async function refreshPortfolioMarkets() {
  const open = state.portfolio.positions.filter((p) => p.status === "open");
  const ids = [...new Set(open.map((p) => p.marketId))].filter((id) => !marketIndex.byId.has(id));
  if (ids.length === 0) return;
  state.marketStates = { ...state.marketStates, ...(await loadMarketStates(ids)) };
  const n = settle(state.portfolio, state.marketStates);
  if (n) toast(`${n} prédiction${n > 1 ? "s" : ""} terminée${n > 1 ? "s" : ""} : va voir ton portefeuille !`, "ok");
}

async function refresh({ initial = false } = {}) {
  try {
    const [data] = await Promise.all([
      loadEvents({ preferLive: initial || state.source === "live" }),
      refreshAlerts(),
      refreshCrypto(),
      refreshBacktest(),
      // Les données de chaque onglet ne sont chargées que s'il est ouvert
      NEEDS_TESTS.has(state.view) ? refreshStrategy() : null,
      state.view === "calendar" ? refreshCalendar() : null,
      state.view === "traders" ? refreshLeaders() : null,
    ]);
    Object.assign(state, data);
    mergeCryptoEvents();
    indexMarkets();
    await refreshPortfolioMarkets();
    if ($("detail").open) {
      renderStatus();
      renderAlertsBadge();
    } else {
      renderView();
    }
    if (initial) onRoute();
  } catch (err) {
    console.error(err);
    if (initial) {
      $("status").innerHTML = `<span class="pill err">Hors ligne</span>`;
      $("grid").innerHTML = `
        <div class="empty">
          <p><strong>Impossible de charger les marchés.</strong></p>
          <p>L'API Polymarket n'est pas joignable depuis votre connexion et aucun instantané n'est encore disponible.
          L'instantané est généré automatiquement par la GitHub Action du dépôt : réessayez dans quelques minutes.</p>
        </div>`;
    }
  }
}

restoreTheme();
bind();
state.view = viewFromHash().view;
renderView();
renderSkeleton();
refresh({ initial: true });
setInterval(() => {
  if (!document.hidden && !$("detail").open) refresh();
}, LIVE_REFRESH_MS);

// Installable sur téléphone et consultable hors connexion (voir sw.js)
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
