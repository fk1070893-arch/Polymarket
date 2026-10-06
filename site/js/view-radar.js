// Onglet « Radar » : tous les signaux du moment sur une seule page, avec ce
// que vaut chaque type de signal d'après les tests en direct.

import { cents, duration, esc, pct, timeAgo, usd0 } from "./format.js";
import { statusBadge, strategyStatus, strategySummaries } from "./status.js";

const $ = (id) => document.getElementById(id);
const filter = { kind: "all" };
let bound = false;

const KINDS = {
  anomaly: "Anomalie de prix",
  favorite: "Contre un favori sport",
  bookmaker: "Moins cher que les bookmakers",
  kalshi: "Écart avec Kalshi",
  insider: "Pari suspect",
  fresh: "Marché neuf à vrai prix",
  crypto: "Modèle crypto",
};

const pts = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} pts`;
const yesNo = (o) => (o === "Yes" ? "Oui" : o === "No" ? "Non" : o);
const HOUR = 3600000;

function items(ctx) {
  const { state } = ctx;
  const now = Date.now();
  const out = [];
  const sums = strategySummaries(state);

  for (const f of state.arbs?.found ?? []) {
    out.push({
      kind: "anomaly",
      title: f.title,
      detail: `Acheter tous les « ${f.side === "yes" ? "Oui" : "Non"} » (${f.legs} issues) : gain sûr de ${f.profit.toFixed(2).replace(".", ",")} $ pour ${Math.round(f.cost)} $ engagés`,
      strength: 10 + f.profit / Math.max(1, f.cost),
      status: null,
      slug: f.slug,
      eventId: f.eventId,
    });
  }
  for (const a of state.cross?.arbs ?? []) {
    out.push({
      kind: "anomaly",
      title: a.question,
      detail: `${a.label} : ${cents(a.cost)} pour 1 $ sûr, frais compris. À vérifier : les règles des deux sites doivent être identiques.`,
      strength: 10 + a.profit,
      status: null,
      slug: a.slug,
      marketId: a.marketId,
    });
  }
  for (const b of state.strategy?.bets ?? []) {
    if (b.won != null || !b.value || now - b.placedAt > 12 * HOUR || (b.end && b.end < now)) continue;
    const key = (b.when ?? "24h") === "4h" ? "fav4" : "favValue";
    out.push({
      kind: "favorite",
      title: b.eventTitle || b.question,
      detail: `Favori ${b.favorite} à ${pct(b.p)} : « ${b.bet} » à ${cents(b.cost)}, sous la valeur estimée (${cents(b.cap + 0.03)})${b.end ? ` · fin dans ${duration((b.end - now) / 1000)}` : ""}`,
      strength: (b.cap ?? 0) - (b.cost ?? 0),
      status: sums[key],
      slug: b.slug,
      marketId: b.marketId ?? b.id,
    });
  }
  for (const r of state.odds?.rows ?? []) {
    if (r.edge == null || r.edge < 0.03 || r.commence <= now) continue;
    out.push({
      kind: "bookmaker",
      title: r.eventTitle,
      detail: `${yesNo(r.outcome === "Yes" ? r.question : r.outcome)} : ${cents(r.ask)} sur Polymarket, ${pct(r.book)} chez les bookmakers (${pts(r.edge)}) · match dans ${duration((r.commence - now) / 1000)}`,
      strength: r.edge,
      status: sums.odds,
      slug: r.slug,
      marketId: r.marketId,
    });
  }
  for (const p of state.cross?.pairs ?? []) {
    if (p.edge == null || p.edge < 0.05) continue;
    out.push({
      kind: "kalshi",
      title: p.question,
      detail: `« ${p.side === 0 ? "Oui" : "Non"} » à ${cents(p.ask)} sur Polymarket, Kalshi donne ${pct(p.side === 0 ? p.kalshi.mid : 1 - p.kalshi.mid)} (${pts(p.edge)}) · ressemblance des questions ${Math.round(p.sim * 100)} %`,
      strength: p.edge,
      status: sums.cross,
      slug: p.slug,
      marketId: p.marketId,
    });
  }
  for (const a of state.alerts ?? []) {
    if (a.score < 70 || now - a.ts * 1000 > 24 * HOUR) continue;
    out.push({
      kind: "insider",
      title: a.title || a.eventTitle,
      detail: `${usd0.format(a.cash)} sur « ${yesNo(a.outcome)} » à ${pct(a.price)}, score ${a.score}/100 · ${timeAgo(a.ts * 1000)}`,
      strength: a.score / 100,
      status: sums.copy,
      slug: a.eventSlug,
      conditionId: a.conditionId,
    });
  }
  for (const b of state.fresh?.bets ?? []) {
    if (b.won != null || now - b.placedAt > 12 * HOUR) continue;
    out.push({
      kind: "fresh",
      title: b.eventTitle || b.question,
      detail: `Affiché ${pct(b.p)}, « Non » réellement à vendre à ${cents(b.cost)}`,
      strength: 0.5 - (b.cost ?? 0.5),
      status: sums.fresh,
      slug: b.slug,
      marketId: b.marketId,
    });
  }
  for (const m of state.crypto?.markets ?? []) {
    const p = ctx.currentPrice(m.marketId, 0) ?? m.poly;
    const edge = m.model - p;
    if (Math.abs(edge) < 0.05) continue;
    out.push({
      kind: "crypto",
      title: m.question,
      detail: `Polymarket ${pct(p)}, modèle ${pct(m.model)} (${pts(edge)})`,
      strength: Math.abs(edge) / 10,
      status: sums.crypto,
      eventId: m.eventId,
      marketId: m.marketId,
    });
  }
  return out;
}

function rank(it) {
  if (it.kind === "anomaly") return -1;
  if (it.status?.rejected) return 9;
  return strategyStatus(it.status?.s).rank;
}

function badge(it) {
  if (it.kind === "anomaly") return `<span class="dash-status good"><span aria-hidden="true">💰</span> Gain sûr si les prix tiennent</span>`;
  if (it.status?.rejected) return `<span class="dash-status bad"><span aria-hidden="true">❌</span> Rejeté par le backtest</span>`;
  return statusBadge(strategyStatus(it.status?.s));
}

// Ouvre la fiche si le marché est dans la liste du site, sinon lien Polymarket
function action(ctx, it) {
  const idx = ctx.marketIndex();
  const hit = it.marketId ? idx.byId.get(String(it.marketId)) : it.conditionId ? idx.byCondition.get(it.conditionId) : null;
  const evId = hit?.ev.id ?? (it.eventId && ctx.state.events.some((e) => e.id === String(it.eventId)) ? String(it.eventId) : null);
  if (evId) return `<button type="button" class="link" data-radar-open="${esc(evId)}" data-radar-market="${esc(hit?.m.id ?? "")}">Voir le marché</button>`;
  return it.slug ? `<a class="link" href="https://polymarket.com/event/${esc(it.slug)}" target="_blank" rel="noopener noreferrer">Polymarket ↗</a>` : "";
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("radar-body").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-radar-kind]");
    if (chip) {
      filter.kind = chip.dataset.radarKind;
      renderRadar(ctx);
      return;
    }
    const open = e.target.closest("[data-radar-open]");
    if (open) ctx.openDetail(open.dataset.radarOpen, { marketId: open.dataset.radarMarket || null });
  });
}

export function renderRadar(ctx) {
  bind(ctx);
  const body = $("radar-body");
  if (ctx.state.strategy === null) {
    body.innerHTML = `<p class="empty">Chargement des signaux…</p>`;
    return;
  }
  const all = items(ctx).sort((a, b) => rank(a) - rank(b) || b.strength - a.strength);
  const counts = { all: all.length };
  for (const it of all) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  const shown = all.filter((it) => filter.kind === "all" || it.kind === filter.kind).slice(0, 120);
  body.innerHTML = `
    <nav class="chips" aria-label="Types de signaux">
      ${[["all", "Tout"], ...Object.entries(KINDS)]
        .filter(([k]) => k === "all" || counts[k])
        .map(
          ([k, l]) =>
            `<button type="button" class="chip${k === filter.kind ? " active" : ""}" data-radar-kind="${k}" aria-pressed="${k === filter.kind}">${l} <span class="count">${counts[k] ?? 0}</span></button>`
        )
        .join("")}
    </nav>
    ${
      shown.length
        ? `<div class="radar-list">${shown
            .map(
              (it) => `
          <article class="radar-item">
            <div class="radar-top">
              <span class="radar-kind">${KINDS[it.kind]}</span>
              ${badge(it)}
            </div>
            <h3>${esc(it.title)}</h3>
            <p>${esc(it.detail)}</p>
            <footer>${action(ctx, it)}</footer>
          </article>`
            )
            .join("")}</div>`
        : `<p class="empty">Aucun signal en ce moment. Les tests tournent toutes les 5 minutes : repasse plus tard.</p>`
    }
    <p class="muted small">Le statut vient des tests en direct (onglet <a href="#strategies">Stratégies</a>) : un signal « en test » n'a pas encore prouvé qu'il rapporte. Rien n'est un conseil de pari.</p>`;
}
