// Onglet « Modèle crypto » : probabilités tirées des options Deribit
// comparées aux prix Polymarket (données de scripts/build-crypto.mjs).

import { duration, esc, money, pct, shortDateFmt, timeAgo } from "./format.js";

const filter = { asset: "all", min: 0, sort: "edge" };
let bound = false;

const $ = (id) => document.getElementById(id);
const fmtPrice = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

// Prix Polymarket le plus récent : en direct si disponible, sinon celui de
// l'instantané utilisé pour le calcul.
function livePoly(ctx, row) {
  const p = ctx.currentPrice(row.marketId, 0);
  return p ?? row.poly;
}

export function cryptoForMarket(state, marketId) {
  return state.crypto?.markets?.find((m) => m.marketId === marketId) ?? null;
}

function describe(row, spot) {
  const d = dayFmt.format(new Date(row.date));
  const n = (v) => `${fmtPrice.format(v)} $`;
  switch (row.kind) {
    case "above":
      return `${row.asset} au-dessus de ${n(row.strike)} le ${d}`;
    case "below":
      return `${row.asset} sous ${n(row.strike)} le ${d}`;
    case "between":
      return `${row.asset} entre ${n(row.low)} et ${n(row.high)} le ${d}`;
    case "touch": {
      const up = row.dir ? row.dir === "up" : row.strike >= spot;
      return `${row.asset} ${up ? "atteint" : "chute à"} ${n(row.strike)} avant le ${d}`;
    }
    default:
      return row.question;
  }
}

// Verdict du backtest (un pari par événement, marge d'erreur à 90 %) :
// tant que le modèle n'a pas prouvé qu'il bat Polymarket, ses écarts sont
// présentés comme une simple comparaison, pas comme des signaux.
function backtestBanner(bt) {
  const t5 = bt?.crypto?.thresholds?.["0.05"];
  if (!t5) return "";
  // Au prix réellement payé (écart achat-vente compris) si disponible
  const ci = t5.all.ciExec ?? t5.all.ci;
  const roi = t5.all.roiExec ?? t5.all.roi;
  const sp = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`;
  const proven = ci && ci[0] > 0 && (t5.A.roiExec ?? t5.A.roi) > 0 && (t5.B.roiExec ?? t5.B.roi) > 0;
  return `
    <section class="bt-banner ${proven ? "ok" : "warn"}">
      <b>${proven ? "Le backtest donne un avantage au modèle." : "Le backtest ne montre pas d'avantage au modèle."}</b>
      Rejoué sur ${bt.crypto.events ?? "?"} événements passés, un seul pari par événement, en suivant les écarts de 5 pts ou plus :
      ${sp(roi)} par pari${t5.all.roiExec != null ? " au prix payé" : ""}, marge d'erreur ${ci ? `[${sp(ci[0])} ; ${sp(ci[1])}]` : "inconnue"}.
      ${proven ? "" : "Les écarts ci-dessous sont une comparaison, pas des conseils de pari."}
      <a href="#backtest">Voir le backtest</a>
    </section>`;
}

function trackRecord(rec) {
  if (!rec || !rec.resolved) {
    return `<p>Le suivi vient de commencer. Pour chaque marché, le site fige les probabilités du modèle et de Polymarket
      24 h avant l'échéance, puis note le résultat. Les premiers bilans arrivent dès que des marchés se terminent.</p>`;
  }
  const better = rec.brierModel < rec.brierPoly;
  const roi = rec.signalBets ? rec.signalPnl / rec.signalBets : null;
  return `
    <p>Sur <b>${rec.resolved}</b> marché${rec.resolved > 1 ? "s" : ""} terminé${rec.resolved > 1 ? "s" : ""}, erreur moyenne (score de Brier, plus bas = meilleur) :
      modèle <b>${rec.brierModel.toFixed(3)}</b> contre Polymarket <b>${rec.brierPoly.toFixed(3)}</b>.
      <b class="${better ? "up" : "down"}">${better ? "Le modèle a été plus précis." : "Polymarket a été plus précis."}</b></p>
    ${
      rec.signalBets
        ? `<p>En suivant les ${rec.signalBets} signaux (1 $ chacun, 24 h avant) : ${rec.signalWins} gagnés,
            résultat <b class="${rec.signalPnl >= 0 ? "up" : "down"}">${rec.signalPnl >= 0 ? "+" : ""}${money.format(rec.signalPnl)}</b>
            (${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(0)} % par pari).</p>`
        : ""
    }
    ${rec.resolved < 30 ? `<p class="muted small">Encore peu de résultats : attends au moins 30 marchés terminés avant de te fier à ce bilan.</p>` : ""}`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("crypto-body").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-asset]");
    if (chip) {
      filter.asset = chip.dataset.asset;
      renderCrypto(ctx);
      return;
    }
    const row = e.target.closest("[data-crypto-market]");
    if (row) {
      const pick = row.dataset.pick === "" ? null : Number(row.dataset.pick);
      ctx.openDetail(row.dataset.event, { marketId: row.dataset.cryptoMarket, pick });
    }
  });
  $("crypto-body").addEventListener("change", (e) => {
    if (e.target.id === "crypto-min") filter.min = Number(e.target.value);
    else if (e.target.id === "crypto-sort") filter.sort = e.target.value;
    else return;
    renderCrypto(ctx);
  });
}

export function renderCrypto(ctx) {
  bind(ctx);
  const { state } = ctx;
  const body = $("crypto-body");
  const data = state.crypto;

  if (data === null) {
    body.innerHTML = `<p class="empty">Chargement du modèle…</p>`;
    return;
  }
  if (!data || !data.markets) {
    body.innerHTML = `<p class="empty">Le modèle n'est pas encore disponible. Il est recalculé toutes les 15 minutes par la GitHub Action : réessaie un peu plus tard.</p>`;
    return;
  }

  const assets = Object.entries(data.assets ?? {});
  const rows = data.markets
    .map((r) => {
      const poly = livePoly(ctx, r);
      return { ...r, poly, edge: r.model - poly };
    })
    .filter((r) => filter.asset === "all" || r.asset === filter.asset)
    .filter((r) => Math.abs(r.edge) >= filter.min);

  const by = {
    edge: (a, b) => Math.abs(b.edge) - Math.abs(a.edge),
    date: (a, b) => new Date(a.date) - new Date(b.date),
    volume: (a, b) => b.volume - a.volume,
  }[filter.sort];
  rows.sort(by);

  const counts = { all: data.markets.length };
  for (const m of data.markets) counts[m.asset] = (counts[m.asset] ?? 0) + 1;

  body.innerHTML = `
    <div class="crypto-assets">
      ${assets
        .map(
          ([a, v]) => `
        <div class="stat">
          <span>${a}</span>
          <strong>${fmtPrice.format(v.spot)} $</strong>
          <em class="muted">Volatilité ${(v.atmVol * 100).toFixed(0)} % · ${v.source === "deribit" ? "implicite (options Deribit)" : "historique 30 j (Deribit indisponible)"}</em>
        </div>`
        )
        .join("")}
      <div class="stat"><span>Mis à jour</span><strong>${timeAgo(new Date(data.updatedAt).getTime())}</strong><em class="muted">${data.markets.length} marchés analysés</em></div>
    </div>

    ${backtestBanner(ctx.state.backtest)}

    <section class="verdict">
      <h2>Suivi en direct : est-ce que le modèle a raison ?</h2>
      ${trackRecord(data.record)}
    </section>

    <section class="controls" aria-label="Filtres du modèle">
      <label class="sort">
        <span>Écart minimum</span>
        <select id="crypto-min">
          ${[[0, "Tout afficher"], [0.03, "3 pts"], [0.05, "5 pts"], [0.1, "10 pts"]]
            .map(([v, l]) => `<option value="${v}"${v === filter.min ? " selected" : ""}>${l}</option>`)
            .join("")}
        </select>
      </label>
      <label class="sort">
        <span>Trier par</span>
        <select id="crypto-sort">
          ${[["edge", "Plus gros écart"], ["date", "Échéance la plus proche"], ["volume", "Volume"]]
            .map(([v, l]) => `<option value="${v}"${v === filter.sort ? " selected" : ""}>${l}</option>`)
            .join("")}
        </select>
      </label>
    </section>
    <nav class="chips">
      ${["all", ...assets.map(([a]) => a)]
        .map(
          (a) =>
            `<button type="button" class="chip${a === filter.asset ? " active" : ""}" data-asset="${a}" aria-pressed="${a === filter.asset}">${
              a === "all" ? "Tout" : a
            } <span class="count">${counts[a] ?? 0}</span></button>`
        )
        .join("")}
    </nav>

    ${
      rows.length
        ? `<div class="crypto-list">
            <div class="crypto-row head" aria-hidden="true">
              <span>Marché</span><span>Polymarket</span><span>Modèle</span><span>Écart</span>
            </div>
            ${rows
              .map((r) => {
                const spot = data.assets?.[r.asset]?.spot ?? 0;
                const pts = Math.round(r.edge * 100);
                return `
                <button type="button" class="crypto-row" data-crypto-market="${esc(r.marketId)}" data-event="${esc(r.eventId)}" data-pick="">
                  <span class="cr-name">
                    <b>${esc(describe(r, spot))}</b>
                    <span class="muted small">${esc(r.eventTitle)} · ${duration((new Date(r.date) - Date.now()) / 1000)} restants · vol. ${Math.round(r.sigma * 100)} %</span>
                  </span>
                  <span class="cr-num"><em>Polymarket</em>${pct(r.poly)}</span>
                  <span class="cr-num"><em>Modèle</em>${pct(r.model)}</span>
                  <span class="cr-num edge ${pts > 0 ? "up" : pts < 0 ? "down" : ""}"><em>Écart</em>${pts > 0 ? "+" : ""}${pts} pt${Math.abs(pts) > 1 ? "s" : ""}</span>
                </button>`;
              })
              .join("")}
          </div>`
        : `<p class="empty">Aucun marché crypto avec un écart d'au moins ${Math.round(filter.min * 100)} points en ce moment. Baisse l'écart minimum pour tout voir.</p>`
    }

    <section class="caveats">
      <h2>À savoir</h2>
      <ul>
        <li><b>Le modèle n'est pas magique.</b> Il suppose des variations de prix « normales » ; les krachs et les envolées soudaines sont plus fréquents dans la réalité.</li>
        <li><b>Les options sont « neutres au risque ».</b> La probabilité Deribit intègre une prime de risque : elle surestime un peu les mouvements extrêmes.</li>
        <li><b>La référence diffère.</b> Polymarket se base en général sur le prix Binance à une heure précise, Deribit sur son propre indice : quelques dizaines de dollars d'écart possibles.</li>
        <li><b>Un écart sur un petit marché</b> (peu de liquidité) peut juste venir d'un manque d'acheteurs, pas d'une erreur.</li>
        <li><b>Rejoué sur le passé, le modèle fait jeu égal avec Polymarket.</b> Un écart ne veut donc pas dire que Polymarket se trompe. Le suivi en direct ci-dessus dira, avec le temps, si ça change.</li>
      </ul>
    </section>`;
}
