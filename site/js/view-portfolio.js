// Onglet « Mon portefeuille » : prédictions fictives et score face au marché

import { cents, esc, money, pct, shortDateFmt, signedMoney, translateOutcome } from "./format.js";
import { START_CASH, exportPortfolio, importPortfolio, resetPortfolio, sell, stats } from "./portfolio.js";
import { strategySummaries } from "./status.js";
import { exitEstimate, quoteSell } from "./execution.js";

const $ = (id) => document.getElementById(id);
let bound = false;

function verdict(s) {
  if (s.resolvedCount === 0) {
    return `<p>Pas encore de prédiction terminée. Dès qu'un de tes marchés se termine, tu verras ici si tu fais mieux que le marché.</p>`;
  }
  const edgePts = Math.round(s.edge * 100);
  const mood =
    s.resolvedCount < 10
      ? `<p class="muted small">Encore trop peu de résultats (${s.resolvedCount}) pour conclure : vise au moins 20 à 30 prédictions terminées.</p>`
      : "";
  const line =
    edgePts > 0
      ? `<b class="up">Tu bats le marché de ${edgePts} pt${edgePts > 1 ? "s" : ""}.</b>`
      : edgePts < 0
        ? `<b class="down">Le marché fait mieux que toi de ${-edgePts} pt${edgePts < -1 ? "s" : ""}.</b>`
        : `<b>Tu fais exactement comme le marché.</b>`;
  return `
    <p>Tu as eu raison <b>${pct(s.actual)}</b> du temps (${s.wins}/${s.resolvedCount}).
    Vu les prix auxquels tu as acheté, le marché s'attendait à <b>${pct(s.expected)}</b>.</p>
    <p>${line}</p>${mood}`;
}

function resaleOf(ctx, pos) {
  const m = ctx.marketOf(pos);
  return m ? exitEstimate(m, pos.outcomeIndex, pos.feeParams ?? m.fee) : null;
}

function positionRow(ctx, p) {
  const ev = ctx.state.events.find((e) => e.id === p.eventId);
  const title = `<span class="pos-title">${
    ev ? `<button type="button" class="link" data-open="${esc(p.eventId)}" data-market="${esc(p.marketId)}">${esc(p.eventTitle)}</button>` : esc(p.eventTitle)
  }</span>`;
  const pick = `${p.marketLabel ? `${esc(p.marketLabel)} · ` : ""}<b>${esc(translateOutcome(p.outcome))}</b>`;

  if (p.status === "open") {
    const now = ctx.currentPrice(p.marketId, p.outcomeIndex);
    // Valeur si revendue maintenant : meilleur prix acheteur, frais déduits
    const exit = resaleOf(ctx, p);
    const value = p.shares * (exit ?? now ?? p.price);
    const pnl = value - p.stake;
    return `
      <div class="pos">
        <div class="pos-info">
          ${title}
          <span class="pos-pick">${pick} · acheté à ${cents(p.price)}${p.shown != null && Math.abs(p.shown - p.price) > 0.0005 ? ` tout compris (affiché ${cents(p.shown)})` : ""} le ${shortDateFmt.format(new Date(p.at))}</span>
        </div>
        <div class="pos-nums">
          <span>Mise <b>${money.format(p.stake)}</b></span>
          <span>Prix actuel <b>${now == null ? "?" : cents(now)}</b></span>
          <span title="Si tu revendais maintenant : meilleur prix acheteur, frais déduits">Valeur <b>${money.format(value)}</b></span>
          <span class="${pnl >= 0 ? "up" : "down"}"><b>${signedMoney(pnl)}</b></span>
        </div>
        <button type="button" class="btn small" data-sell="${esc(p.id)}" ${now == null ? "disabled title='Prix actuel inconnu'" : ""}>Vendre</button>
      </div>`;
  }

  const pnl = (p.payout ?? 0) - p.stake;
  const badge = { won: ["Gagné", "up"], lost: ["Perdu", "down"], sold: ["Vendu", ""] }[p.status];
  return `
    <div class="pos closed">
      <div class="pos-info">
        ${title}
        <span class="pos-pick">${pick} · acheté à ${cents(p.price)}${p.status === "sold" ? `, revendu à ${cents(p.exitPrice)}` : ""}</span>
      </div>
      <div class="pos-nums">
        <span>Mise <b>${money.format(p.stake)}</b></span>
        <span>Retour <b>${money.format(p.payout ?? 0)}</b></span>
        <span class="${pnl >= 0 ? "up" : "down"}"><b>${signedMoney(pnl)}</b></span>
      </div>
      <span class="result ${badge[1]}">${badge[0]}</span>
    </div>`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("portfolio-body").addEventListener("click", (e) => {
    const { state } = ctx;
    const open = e.target.closest("[data-open]");
    if (open) {
      ctx.openDetail(open.dataset.open, { marketId: open.dataset.market });
      return;
    }
    const sellBtn = e.target.closest("[data-sell]");
    if (sellBtn) {
      const pos = state.portfolio.positions.find((x) => x.id === sellBtn.dataset.sell);
      const m = pos && ctx.marketOf(pos);
      if (!m) return;
      sellBtn.disabled = true;
      // Revente aux acheteurs du carnet d'ordres, frais déduits
      quoteSell({ ...m, fee: pos.feeParams ?? m.fee }, pos.outcomeIndex, pos.shares).then((q) => {
        sellBtn.disabled = false;
        if (!q) return;
        const value = q.value;
        const how = q.source === "affiché" ? "au prix affiché (carnet indisponible)" : `à ${cents(q.price)} en moyenne chez les acheteurs`;
        const fee = q.fee > 0.00005 ? `, moins ${cents(q.fee)} de frais par part` : "";
        if (!confirm(`Revendre ${how}${fee} : tu récupères ${money.format(value)} (${signedMoney(value - pos.stake)}). Confirmer ?`)) return;
        sell(state.portfolio, pos.id, q.net);
        ctx.toast(`Revendu pour ${money.format(value)} (${signedMoney(value - pos.stake)}).`, "ok");
        renderPortfolio(ctx);
      });
      return;
    }
    if (e.target.closest("#pf-export")) {
      const url = URL.createObjectURL(exportPortfolio(state.portfolio));
      const a = document.createElement("a");
      a.href = url;
      a.download = `portefeuille-polymarket-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (e.target.closest("#pf-import")) {
      $("pf-file").click();
      return;
    }
    if (e.target.closest("#pf-reset")) {
      if (!confirm(`Tout effacer et repartir avec ${money.format(START_CASH)} fictifs ? (pense à exporter avant si tu veux garder une trace)`)) return;
      state.portfolio = resetPortfolio();
      ctx.toast("Portefeuille remis à zéro.");
      renderPortfolio(ctx);
    }
  });
  $("portfolio-body").addEventListener("change", async (e) => {
    if (e.target.id !== "pf-file" || !e.target.files[0]) return;
    try {
      ctx.state.portfolio = importPortfolio(await e.target.files[0].text());
      ctx.toast("Portefeuille importé.", "ok");
      renderPortfolio(ctx);
    } catch (err) {
      ctx.toast(err.message, "err");
    }
  });
}

// Tes prédictions comparées aux stratégies testées en direct : gain moyen
// pour 1 $ misé, de part et d'autre
function versusStrategies(ctx, p) {
  const done = p.positions.filter((x) => x.status === "won" || x.status === "lost");
  const staked = done.reduce((t, x) => t + x.stake, 0);
  const mine = staked ? done.reduce((t, x) => t + (x.status === "won" ? x.shares - x.stake : -x.stake), 0) / staked : null;
  const sums = Object.values(strategySummaries(ctx.state)).filter((x) => x.s?.n);
  if (ctx.state.strategy === null) return `<p class="muted small">Chargement des stratégies…</p>`;
  const sp = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`);
  const rows = [
    { name: "<b>Toi</b>", n: done.length, roi: mine },
    ...sums.map((x) => ({ name: esc(x.name), n: x.s.n, roi: x.s.roi })),
  ].sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9));
  return `
    <section class="verdict">
      <h2>Toi contre les stratégies automatiques</h2>
      <p>Gain moyen pour 1 $ misé, sur les paris terminés. Les stratégies parient 1 $ fictif à chaque signal, au prix réellement payé.</p>
      ${
        done.length
          ? `<div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Qui</th><th class="num">Paris terminés</th><th class="num">Gain pour 1 $</th></tr></thead>
              <tbody>${rows
                .map((r) => `<tr class="${r.n < 20 ? "thin" : ""}"><td>${r.name}</td><td class="num">${r.n}</td><td class="num ${r.roi == null ? "" : r.roi >= 0 ? "up" : "down"}">${sp(r.roi)}</td></tr>`)
                .join("")}</tbody>
            </table></div>
            <p class="muted small">Lignes grisées : moins de 20 paris terminés, le hasard domine encore.</p>`
          : `<p class="empty-inline">Aucune de tes prédictions n'est encore terminée : la comparaison apparaîtra dès la première.</p>`
      }
    </section>`;
}

export function renderPortfolio(ctx) {
  bind(ctx);
  const { state } = ctx;
  const p = state.portfolio;
  const s = stats(p, (pos) => resaleOf(ctx, pos) ?? ctx.currentPrice(pos.marketId, pos.outcomeIndex));
  const open = p.positions.filter((x) => x.status === "open");
  const closed = p.positions.filter((x) => x.status !== "open");

  $("portfolio-body").innerHTML = `
    <div class="pf-stats">
      <div class="stat big">
        <span>Valeur totale</span>
        <strong>${money.format(s.total)}</strong>
        <em class="${s.pnl >= 0 ? "up" : "down"}">${signedMoney(s.pnl)} (${s.roi >= 0 ? "+" : ""}${(s.roi * 100).toFixed(1)} %)</em>
      </div>
      <div class="stat"><span>Disponible</span><strong>${money.format(s.cash)}</strong></div>
      <div class="stat"><span>En jeu (${s.openCount})</span><strong>${money.format(s.openValue)}</strong></div>
    </div>

    <section class="verdict">
      <h2>Est-ce que tu bats le marché ?</h2>
      ${verdict(s)}
    </section>

    ${versusStrategies(ctx, p)}

    <section>
      <h2>Prédictions en cours (${open.length})</h2>
      ${
        open.length
          ? `<div class="positions">${open.map((x) => positionRow(ctx, x)).join("")}</div>`
          : `<p class="empty-inline">Aucune prédiction en cours. <a href="#">Choisis un marché</a>, ouvre-le et fais ta prédiction dans le bloc « Ma prédiction ».</p>`
      }
    </section>

    ${
      closed.length
        ? `<section><h2>Historique (${closed.length})</h2><div class="positions">${closed.map((x) => positionRow(ctx, x)).join("")}</div></section>`
        : ""
    }

    <section class="pf-actions">
      <p class="muted small">
        Ton portefeuille est enregistré dans ce navigateur uniquement (départ : ${money.format(START_CASH)} le
        ${shortDateFmt.format(new Date(p.startedAt))}). Exporte-le pour le garder ou le passer sur un autre appareil.
      </p>
      <div class="pf-buttons">
        <button type="button" class="btn small" id="pf-export">Exporter</button>
        <button type="button" class="btn small" id="pf-import">Importer</button>
        <button type="button" class="btn small danger" id="pf-reset">Remettre à zéro</button>
        <input type="file" id="pf-file" accept="application/json,.json" hidden />
      </div>
    </section>`;
}
