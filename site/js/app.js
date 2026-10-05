import { loadEvents, loadHistory } from "./api.js";
import { mainMarket, yesPrice } from "./normalize.js";
import { lineChart, sparkline } from "./chart.js";

const PAGE = 24;
const LIVE_REFRESH_MS = 2 * 60 * 1000;

const TAG_FR = {
  politics: "Politique",
  elections: "Élections",
  "us-election": "Élections US",
  "global-elections": "Élections monde",
  world: "Monde",
  geopolitics: "Géopolitique",
  sports: "Sport",
  soccer: "Football",
  football: "Football",
  nfl: "NFL",
  nba: "NBA",
  tennis: "Tennis",
  crypto: "Crypto",
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  economy: "Économie",
  business: "Business",
  finance: "Finance",
  tech: "Tech",
  ai: "IA",
  science: "Science",
  culture: "Culture",
  "pop-culture": "Pop culture",
  movies: "Cinéma",
  music: "Musique",
  trump: "Trump",
  france: "France",
  weather: "Météo",
};

// Tags techniques de Polymarket qui ne servent pas de catégories
const TAG_SKIP = new Set(["all", "featured", "recurring", "hide-from-new", "trending", "new", "breaking-news", "games"]);

const state = {
  events: [],
  histories: {},
  source: null,
  updatedAt: null,
  query: "",
  category: "all",
  sort: "volume24h",
  shown: PAGE,
  favorites: loadFavorites(),
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

const usd = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const usd0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const shortDateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function pct(p) {
  if (p > 0 && p < 0.01) return "<1 %";
  if (p < 1 && p > 0.99) return ">99 %";
  return `${Math.round(p * 100)} %`;
}

function changeBadge(delta) {
  const pts = delta * 100;
  if (Math.abs(pts) < 0.5) return "";
  const cls = pts > 0 ? "up" : "down";
  const sign = pts > 0 ? "▲" : "▼";
  return `<span class="chg ${cls}">${sign} ${Math.abs(pts).toFixed(0)} pt${Math.abs(pts) >= 2 ? "s" : ""}</span>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function translateOutcome(o) {
  return { Yes: "Oui", No: "Non" }[o] ?? o;
}

function tagLabel(tag) {
  return TAG_FR[tag.slug] ?? tag.label;
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

// ---------- Rendu ----------

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
  return `
    <article class="card" data-id="${esc(ev.id)}" tabindex="0" role="button" aria-label="${esc(ev.title)}">
      <header>
        ${ev.image ? `<img src="${esc(ev.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
        <h3>${esc(ev.title)}</h3>
        <button type="button" class="fav${fav ? " on" : ""}" data-fav="${esc(ev.id)}" aria-pressed="${fav}" aria-label="${fav ? "Retirer des favoris" : "Ajouter aux favoris"}">★</button>
      </header>
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

function render() {
  renderStatus();
  renderChips();
  renderGrid();
}

function renderSkeleton() {
  $("grid").innerHTML = Array.from({ length: 9 }, () => `<div class="card skeleton"><i></i><i></i><i></i><i></i></div>`).join("");
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

function openDetail(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  let selected = mainMarket(ev);
  let interval = "1w";
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
          (m, i) => `
        <button type="button" class="row selectable${i === 0 ? " selected" : ""}" data-market="${esc(m.id)}">
          <span class="row-label">${esc(m.label || m.question)}</span>
          <span class="bar"><i class="yes" style="width:${yesPrice(m) * 100}%"></i></span>
          <span class="row-val">${pct(yesPrice(m))}</span>
          ${changeBadge(m.change24h) || '<span class="chg"></span>'}
        </button>`
        )
        .join("");

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
    <section>
      <h3>${isBinary(ev) ? "Probabilités" : `Issues (${ev.markets.length})`}</h3>
      ${isBinary(ev) ? "" : '<p class="hint">Cliquez sur une issue pour afficher son historique.</p>'}
      <div class="rows detail-rows">${rows}</div>
    </section>
    ${ev.description ? `<section><h3>Règles de résolution</h3><p class="desc">${esc(ev.description)}</p></section>` : ""}
  `;

  const setTitle = () => {
    $("detail-chart-title").textContent = isBinary(ev)
      ? `Probabilité « Oui » : ${pct(yesPrice(selected))}`
      : `${selected.label || selected.question} : ${pct(yesPrice(selected))}`;
  };
  setTitle();

  $("detail-body").onclick = (e) => {
    const tab = e.target.closest("[data-interval]");
    if (tab) {
      interval = tab.dataset.interval;
      $("detail-body").querySelectorAll("[data-interval]").forEach((b) => b.setAttribute("aria-selected", b === tab));
      drawHistory(selected, interval);
      return;
    }
    const row = e.target.closest("[data-market]");
    if (row) {
      selected = ev.markets.find((m) => m.id === row.dataset.market) ?? selected;
      $("detail-body").querySelectorAll("[data-market]").forEach((b) => b.classList.toggle("selected", b === row));
      setTitle();
      drawHistory(selected, interval);
      $("detail-chart").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  if (!dlg.open) dlg.showModal();
  dlg.querySelector(".detail-inner").scrollTop = 0;
  history.replaceState(null, "", `#${encodeURIComponent(ev.slug || ev.id)}`);
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
    history.replaceState(null, "", location.pathname + location.search);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("search") && !$("detail").open) {
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

async function refresh({ initial = false } = {}) {
  try {
    const data = await loadEvents({ preferLive: initial || state.source === "live" });
    Object.assign(state, data);
    render();
    if (initial && location.hash) {
      const key = decodeURIComponent(location.hash.slice(1));
      const ev = state.events.find((e) => e.slug === key || e.id === key);
      if (ev) openDetail(ev.id);
    }
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
renderStatus();
renderSkeleton();
refresh({ initial: true });
setInterval(() => {
  if (!document.hidden && !$("detail").open) refresh();
}, LIVE_REFRESH_MS);
