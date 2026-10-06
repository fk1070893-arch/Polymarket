// Onglet « Bots » : plusieurs robots fictifs, chacun branché sur un signal du
// site, comparés sur la même période au prix réellement payé
// (données de scripts/build-bots.mjs).

import { pnlChart } from "./chart.js";
import { duration, esc, money, timeAgo } from "./format.js";
import { MIN_BETS, statusBadge, strategyStatus } from "./status.js";

const $ = (id) => document.getElementById(id);
const filter = { family: "all", open: null };
let bound = false;

const sp = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`);
const ciText = (ci) => (ci ? `[${sp(ci[0])} ; ${sp(ci[1])}]` : "");
const cls = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
const yesNo = (o) => (o === "Yes" ? "Oui" : o === "No" ? "Non" : o);
const cents = (v) => (v == null ? "?" : `${(v * 100).toFixed(1).replace(".", ",").replace(",0", "")} ¢`);

// Classement : d'abord ceux qui ont le plus de recul, puis par gain moyen
function score(b) {
  const s = b.summary;
  const n = s.nExec ?? s.n ?? 0;
  if (!n) return -1e9 + (s.total ?? 0);
  // Borne basse de la marge d'erreur quand il y en a une : récompense les résultats solides
  return (s.ci ? s.ci[0] : s.roi) + Math.min(n, MIN_BETS) / 1000;
}

function betLine(b) {
  const result =
    b.won == null
      ? `<span class="muted">${b.end && b.end > Date.now() ? `fin dans ${duration((b.end - Date.now()) / 1000)}` : "résultat en attente"}</span>`
      : b.split
        ? `<span class="muted"><b>Annulé (50/50) ${sp(b.roi)}</b></span>`
        : b.won
          ? `<span class="up"><b>Gagné ${sp(b.roi)}</b></span>`
          : `<span class="down"><b>Perdu</b></span>`;
  const title = b.slug
    ? `<a href="https://polymarket.com/event/${esc(b.slug)}" target="_blank" rel="noopener noreferrer">${esc(b.eventTitle || b.question)}</a>`
    : esc(b.eventTitle || b.question);
  return `<li><span class="muted small">${timeAgo(b.placedAt)}</span> « ${esc(yesNo(b.outcome))} » à <b>${cents(b.cost)}</b> · ${title}
    <span class="muted small">(${esc(b.note ?? "")})</span> · ${result}</li>`;
}

function card(b) {
  const s = b.summary;
  const st = strategyStatus(s);
  const n = s.nExec ?? s.n ?? 0;
  const open = filter.open === b.key;
  const extra = [];
  if (s.avgDays != null) extra.push(`argent bloqué ${duration(s.avgDays * 86400)} en moyenne, soit <b class="${cls(s.perYear)}">${sp(s.perYear)}</b> par an`);
  const big = (s.ladder ?? []).find((l) => l.stake === 1000 && l.n);
  if (big) extra.push(`à 1 000 $ par pari : <b class="${cls(big.roi)}">${sp(big.roi)}</b>`);
  return `
    <article class="dash-card bot-card${open ? " open" : ""}">
      <header>
        <h3>${esc(b.name)}</h3>
        ${statusBadge(st)}
      </header>
      <p class="muted small">${esc(b.about)}</p>
      <p class="dash-nums">
        <span><b class="${cls(s.roi)}">${n ? sp(s.roi) : "—"}</b> par pari</span>
        <span class="muted small">${s.ci ? `marge ${ciText(s.ci)}` : ""}</span>
      </p>
      <div class="dash-chart" data-bot-curve="${esc(b.key)}"></div>
      <p class="muted small">${n} réglé${n > 1 ? "s" : ""}${n ? ` (${s.wins} gagné${s.wins > 1 ? "s" : ""}) · ${s.pnl >= 0 ? "+" : "−"}${money.format(Math.abs(s.pnl ?? 0))}` : ""} · ${s.pending ?? 0} en attente</p>
      ${extra.length ? `<p class="small bot-extra">${extra.join(" · ")}</p>` : ""}
      <button type="button" class="btn small" data-bot-open="${esc(b.key)}" aria-expanded="${open}">${open ? "Masquer ses paris" : "Voir ses derniers paris"}</button>
      ${open ? (b.recent?.length ? `<ul class="bot-bets">${b.recent.map(betLine).join("")}</ul>` : `<p class="muted small">Aucun pari pour l'instant.</p>`) : ""}
    </article>`;
}

function table(list) {
  return `
    <div class="table-wrap"><table class="bt-table">
      <thead><tr><th>#</th><th>Bot</th><th class="num">Réglés</th><th class="num">En attente</th><th class="num">Gain / pari</th><th class="num">Marge d'erreur</th><th class="num">Par an</th></tr></thead>
      <tbody>${list
        .map((b, i) => {
          const s = b.summary;
          const n = s.nExec ?? s.n ?? 0;
          return `<tr class="${n < MIN_BETS ? "thin" : ""}"><td>${i + 1}</td><td>${esc(b.name)} <span class="muted small">${esc(b.family)}</span></td>
            <td class="num">${n}</td><td class="num">${s.pending ?? 0}</td>
            <td class="num ${cls(s.roi)}">${n ? sp(s.roi) : "—"}</td><td class="num">${ciText(s.ci) || "—"}</td>
            <td class="num ${cls(s.perYear)}">${s.perYear != null ? sp(s.perYear) : "—"}</td></tr>`;
        })
        .join("")}</tbody>
    </table></div>`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("bots-body").addEventListener("click", (e) => {
    const fam = e.target.closest("[data-bot-family]");
    if (fam) {
      filter.family = fam.dataset.botFamily;
      renderBots(ctx);
      return;
    }
    const open = e.target.closest("[data-bot-open]");
    if (open) {
      filter.open = filter.open === open.dataset.botOpen ? null : open.dataset.botOpen;
      renderBots(ctx);
    }
  });
}

export function renderBots(ctx) {
  bind(ctx);
  const body = $("bots-body");
  const data = ctx.state.bots;
  if (data === null) {
    body.innerHTML = `<p class="empty">Chargement des bots…</p>`;
    return;
  }
  if (!data?.bots?.length) {
    body.innerHTML = `<p class="empty">Les bots ne sont pas encore lancés : ils démarrent au prochain passage de la GitHub Action (toutes les 5 minutes).</p>`;
    return;
  }
  const families = [...new Set(data.bots.map((b) => b.family))];
  const ranked = [...data.bots].sort((a, b) => score(b) - score(a));
  const shown = ranked.filter((b) => filter.family === "all" || b.family === filter.family);
  body.innerHTML = `
    <nav class="chips" aria-label="Familles de bots">
      ${[["all", "Tous"], ...families.map((f) => [f, f])]
        .map(
          ([k, l]) =>
            `<button type="button" class="chip${k === filter.family ? " active" : ""}" data-bot-family="${esc(k)}" aria-pressed="${k === filter.family}">${esc(l)} <span class="count">${
              k === "all" ? data.bots.length : data.bots.filter((b) => b.family === k).length
            }</span></button>`
        )
        .join("")}
    </nav>
    <h2>Classement</h2>
    ${table(shown)}
    <p class="muted small">Chaque bot mise 1 $ par signal, au prix réellement payé pour une mise de 100 $ (carnet d'ordres, glissement et frais), une seule fois par issue.
      Classés d'après la borne basse de leur marge d'erreur : un bot n'est vraiment devant que si elle reste au-dessus de zéro avec au moins ${MIN_BETS} paris réglés.
      Avec ${data.bots.length} bots, l'un d'eux sera devant par hasard : un bon début n'est pas une preuve. Mis à jour ${timeAgo(new Date(data.updatedAt).getTime())}.</p>
    <section class="dash bots-grid" aria-label="Les bots">${shown.map(card).join("")}</section>`;
  const curves = Object.fromEntries(data.bots.map((b) => [b.key, b.curve]));
  for (const box of body.querySelectorAll("[data-bot-curve]")) pnlChart(box, curves[box.dataset.botCurve]);
}
