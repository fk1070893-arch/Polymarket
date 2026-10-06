// Onglet « Backtest » : résultats de scripts/build-backtest.mjs

import { esc, pct, timeAgo } from "./format.js";

const GROUP_LABELS = { all: "Tout", politique: "Politique", crypto: "Crypto", sport: "Sport", eco: "Économie / Tech", autre: "Autres" };
const KIND_LABELS = { above: "Au-dessus de X à une date", below: "Sous X à une date", between: "Entre A et B à une date", touch: "Atteint / chute à X" };
const MIN_N = 30; // en dessous, un résultat n'est pas affiché comme fiable
const MIN_ROI = 0.05;

const VOLUME_LABELS = { "<10k": "Moins de 10 k$", "10k-100k": "10 k$ – 100 k$", "100k-1M": "100 k$ – 1 M$", ">1M": "Plus de 1 M$" };

// Un seul segment à la fois : une catégorie OU une tranche de volume
const filter = { group: "all", volume: "all" };
let bound = false;
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

const signedPct = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`;

// Marge d'erreur à 90 % : "[+12 % ; +60 %]"
function ciText(ci) {
  return ci ? `[${signedPct(ci[0])} ; ${signedPct(ci[1])}]` : "";
}

function roiCell(v, ci = null) {
  if (v == null) return `<td class="num muted">—</td>`;
  const p = Math.round(v * 100);
  const sure = ci && (ci[0] > 0 || ci[1] < 0);
  return `<td class="num ${p > 0 ? "up" : p < 0 ? "down" : ""}">${signedPct(v)}${
    ci ? `<span class="ci${sure ? " sure" : ""}" title="Marge d'erreur à 90 %">${ciText(ci)}</span>` : ""
  }</td>`;
}

// Gain au prix réellement payé (écart achat-vente compris) quand le
// backtest le fournit, sinon au prix affiché.
const exec = (obj, side) => obj?.[`${side}Exec`] ?? obj?.[side];
const execCi = (bin, side) => (side === "roiNo" ? bin.ciNoExec ?? bin.ciNo : bin.ciYesExec ?? bin.ciYes);

// Cellule : gain au prix payé, avec le gain au prix affiché en dessous
function execCell(bin, side) {
  const raw = bin[side];
  const paid = bin[`${side}Exec`];
  if (paid == null) return roiCell(raw, side === "roiNo" ? bin.ciNo : bin.ciYes);
  const cell = roiCell(paid, execCi(bin, side));
  return raw == null ? cell : cell.replace(/<\/td>$/, `<span class="ci" title="Au prix affiché, sans l'écart achat-vente">affiché ${signedPct(raw)}</span></td>`);
}

// Un gain est "stable" s'il est assez grand dans les deux moitiés tirées
// au sort (par événement) ET si toute sa marge d'erreur est positive, au
// prix réellement payé.
function stable(bin, side) {
  const a = exec(bin.A, side);
  const b = exec(bin.B, side);
  const ci = execCi(bin, side);
  return (
    bin.A.n >= MIN_N / 2 &&
    bin.B.n >= MIN_N / 2 &&
    (bin.events ?? bin.n) >= MIN_N &&
    a != null &&
    b != null &&
    a >= MIN_ROI &&
    b >= MIN_ROI &&
    ci != null &&
    ci[0] > 0
  );
}

function binLabel(b) {
  return `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)} %`;
}

function findings(bins) {
  const out = [];
  for (const b of bins) {
    if (b.n < MIN_N) continue;
    if (stable(b, "roiNo"))
      out.push(`Acheter <b>« Non »</b> quand « Oui » est à <b>${binLabel(b)}</b> : ${pctSigned(exec(b, "roiNo"))} par pari, marge ${ciText(execCi(b, "roiNo"))} (moitié A ${pctSigned(exec(b.A, "roiNo"))}, moitié B ${pctSigned(exec(b.B, "roiNo"))}, ${b.n} marchés dans ${b.events ?? "?"} événements).`);
    if (stable(b, "roiYes"))
      out.push(`Acheter <b>« Oui »</b> quand il est à <b>${binLabel(b)}</b> : ${pctSigned(exec(b, "roiYes"))} par pari, marge ${ciText(execCi(b, "roiYes"))} (moitié A ${pctSigned(exec(b.A, "roiYes"))}, moitié B ${pctSigned(exec(b.B, "roiYes"))}, ${b.n} marchés dans ${b.events ?? "?"} événements).`);
  }
  return out;
}

function pctSigned(v) {
  const p = Math.round(v * 100);
  return `<span class="${p >= 0 ? "up" : "down"}">${p > 0 ? "+" : ""}${p} %</span>`;
}

// Graphique de calibration : prix moyen (x) contre fréquence réelle (y),
// diagonale = marché parfaitement calibré.
function calibrationChart(container, bins) {
  container.replaceChildren();
  const pts = bins.filter((b) => b.n >= 5 && b.avgPrice != null);
  const W = Math.max(300, Math.min(560, container.clientWidth || 560));
  const H = Math.round(W * 0.8);
  const m = { top: 12, right: 14, bottom: 40, left: 60 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const x = (v) => m.left + v * iw;
  const y = (v) => m.top + (1 - v) * ih;

  const el = (name, attrs) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart calib", role: "img" });
  svg.setAttribute("aria-label", "Calibration : probabilité affichée par Polymarket la veille contre fréquence réelle");

  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(el("line", { x1: x(0), x2: x(1), y1: y(v), y2: y(v), class: "gridline" }));
    const ly = el("text", { x: m.left - 8, y: y(v) + 4, class: "axis", "text-anchor": "end" });
    ly.textContent = `${v * 100} %`;
    const lx = el("text", { x: x(v), y: H - m.bottom + 18, class: "axis", "text-anchor": v === 0 ? "start" : v === 1 ? "end" : "middle" });
    lx.textContent = `${v * 100} %`;
    svg.append(ly, lx);
  }
  const xt = el("text", { x: m.left + iw / 2, y: H - 4, class: "axis title", "text-anchor": "middle" });
  xt.textContent = "Prix « Oui » la veille de la fin";
  const yt = el("text", { x: 12, y: m.top + ih / 2, class: "axis title", "text-anchor": "middle", transform: `rotate(-90 12 ${m.top + ih / 2})` });
  yt.textContent = "S'est vraiment produit";
  svg.append(xt, yt);

  svg.append(el("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), class: "diag" }));
  const dl = el("text", { x: x(0.62), y: y(0.62) - 8, class: "axis diag-label", transform: `rotate(-${(Math.atan2(ih, iw) * 180) / Math.PI} ${x(0.62)} ${y(0.62) - 8})` });
  dl.textContent = "marché parfait";
  svg.append(dl);

  if (pts.length > 1) {
    const d = pts.map((b, i) => `${i ? "L" : "M"}${x(b.avgPrice).toFixed(1)},${y(b.freq).toFixed(1)}`).join("");
    svg.append(el("path", { d, class: "line" }));
  }

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;

  for (const b of pts) {
    const cx = x(b.avgPrice);
    const cy = y(b.freq);
    const g = el("g", { class: "calib-pt", tabindex: "0" });
    g.append(el("circle", { cx, cy, r: 14, class: "hit" }), el("circle", { cx, cy, r: 5, class: "dot" }));
    const show = () => {
      tip.hidden = false;
      tip.innerHTML = `<strong>${binLabel(b)}</strong><span>prix moyen ${pct(b.avgPrice)} · réalité ${pct(b.freq)} · ${b.n} marchés</span>`;
      const rect = svg.getBoundingClientRect();
      // Garde la bulle dans le graphique (elle est centrée sur le point)
      const half = tip.offsetWidth / 2 + 4;
      tip.style.left = `${Math.min(Math.max((cx / W) * rect.width, half), rect.width - half)}px`;
      tip.style.top = `${(cy / H) * rect.height}px`;
    };
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", () => (tip.hidden = true));
    g.addEventListener("blur", () => (tip.hidden = true));
    svg.append(g);
  }
  container.append(svg, tip);
}

function calibrationTable(bins) {
  return `
    <div class="table-wrap">
      <table class="bt-table">
        <thead>
          <tr><th>Prix « Oui » la veille</th><th class="num">Marchés (év.)</th><th class="num">Prix moyen</th><th class="num">Réalité</th><th class="num">Acheter « Oui »</th><th class="num">Acheter « Non »</th></tr>
        </thead>
        <tbody>
          ${bins
            .filter((b) => b.n > 0)
            .map(
              (b) => `
            <tr class="${b.n < MIN_N ? "thin" : ""}">
              <td>${binLabel(b)}</td>
              <td class="num">${b.n}${b.events != null ? ` <span class="muted">(${b.events})</span>` : ""}</td>
              <td class="num">${pct(b.avgPrice)}</td>
              <td class="num"><b>${pct(b.freq)}</b></td>
              ${execCell(b, "roiYes")}
              ${execCell(b, "roiNo")}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="muted small">« Acheter Oui / Non » = gain moyen pour 1 $ misé sur chaque marché de la tranche, au prix de la veille <b>réellement payé</b>
      (prix affiché + la moitié de l'écart achat-vente typique des marchés de cette taille) ; « affiché » = sans cet écart. Lignes grisées : moins de ${MIN_N} marchés, pas fiable.</p>`;
}

function cryptoSection(c) {
  if (!c || !c.n) {
    return `<p class="empty-inline">Pas encore de résultat pour le modèle crypto (historique Deribit ou marchés crypto terminés indisponibles).</p>`;
  }
  const better = c.brierModel < c.brierPoly;
  const t5 = c.thresholds?.["0.05"];
  const verdict = (() => {
    if (!t5 || t5.all.bets < MIN_N) return "Trop peu de signaux pour conclure.";
    const ci = t5.all.ciExec ?? t5.all.ci;
    const roi = exec(t5.all, "roi");
    const okA = exec(t5.A, "roi") > 0;
    const okB = exec(t5.B, "roi") > 0;
    if (ci && ci[0] > 0 && okA && okB)
      return `<b class="up">Avec un seul pari par événement, les signaux à 5 pts auraient rapporté ${signedPct(roi)} par pari au prix payé, marge ${ciText(ci)} entièrement positive, et dans les deux moitiés.</b> C'est un vrai signal sur le passé, à confirmer sur les marchés en cours.`;
    if (ci && ci[1] < 0)
      return `<b class="down">Avec un seul pari par événement, les signaux à 5 pts auraient perdu de l'argent (marge ${ciText(ci)}).</b> Le modèle tel quel ne bat pas Polymarket.`;
    return `<b>Avec un seul pari par événement, le résultat au prix payé (${signedPct(roi)}, marge ${ciText(ci) || "inconnue"}) peut encore s'expliquer par le hasard.</b> Pas d'avantage démontré pour l'instant.`;
  })();

  return `
    <p>Rejoué sur <b>${c.n}</b> marchés BTC/ETH terminés${c.events ? `, regroupés en <b>${c.events}</b> événements` : ""} (prix et volatilité DVOL de Deribit 24 h avant la fin).
      Erreur moyenne (Brier, plus bas = meilleur) : modèle <b>${c.brierModel.toFixed(3)}</b>, Polymarket <b>${c.brierPoly.toFixed(3)}</b>.
      <b class="${better ? "up" : "down"}">${better ? "Le modèle a été plus précis que Polymarket." : "Polymarket a été plus précis que le modèle."}</b></p>
    <p>${verdict}</p>
    <h3>Si on avait suivi les signaux (1 $ par pari, un seul pari par événement)</h3>
    <div class="table-wrap">
      <table class="bt-table">
        <thead><tr><th>Écart minimum</th><th class="num">Paris</th><th class="num">Gagnés</th><th class="num">Gain / pari au prix payé (marge 90 %)</th><th class="num">Moitié A</th><th class="num">Moitié B</th><th class="num">Tous les signaux</th></tr></thead>
        <tbody>
          ${Object.entries(c.thresholds ?? {})
            .map(
              ([t, r]) => `
            <tr class="${r.all.bets < MIN_N ? "thin" : ""}">
              <td>${Math.round(Number(t) * 100)} pts</td>
              <td class="num">${r.all.bets}</td>
              <td class="num">${r.all.bets ? pct(r.all.wins / r.all.bets) : "—"}</td>
              ${roiCell(exec(r.all, "roi"), r.all.ciExec ?? r.all.ci)}${roiCell(exec(r.A, "roi"))}${roiCell(exec(r.B, "roi"))}
              <td class="num muted">${c.thresholdsAll?.[t] ? `${c.thresholdsAll[t].all.bets} paris, ${signedPct(c.thresholdsAll[t].all.roi ?? 0)}` : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="muted small">« Tous les signaux » compte chaque seuil d'un même événement comme un pari séparé : c'est plus flatteur mais trompeur, car ces paris gagnent ou perdent ensemble.</p>
    ${
      Object.keys(c.byVolume ?? {}).length
        ? `<h3>Par taille de marché (volume total)</h3>
    <div class="table-wrap">
      <table class="bt-table">
        <thead><tr><th>Volume</th><th class="num">Marchés</th><th class="num">Brier modèle</th><th class="num">Brier Polymarket</th><th class="num">Paris 5 pts</th><th class="num">Gain / pari (marge)</th></tr></thead>
        <tbody>
          ${Object.entries(c.byVolume)
            .map(
              ([k, r]) => `
            <tr class="${r.signals.all.bets < 20 ? "thin" : ""}">
              <td>${esc(VOLUME_LABELS[k] ?? k)}</td>
              <td class="num">${r.n}</td>
              <td class="num ${r.brierModel < r.brierPoly ? "up" : ""}">${r.brierModel.toFixed(3)}</td>
              <td class="num ${r.brierPoly <= r.brierModel ? "up" : ""}">${r.brierPoly.toFixed(3)}</td>
              <td class="num">${r.signals.all.bets}</td>
              ${roiCell(exec(r.signals.all, "roi"), r.signals.all.ciExec ?? r.signals.all.ci)}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
        : ""
    }
    <h3>Par type de marché</h3>
    <div class="table-wrap">
      <table class="bt-table">
        <thead><tr><th>Type</th><th class="num">Marchés</th><th class="num">Brier modèle</th><th class="num">Brier Polymarket</th><th class="num">Paris 5 pts</th><th class="num">Gain / pari (marge)</th></tr></thead>
        <tbody>
          ${Object.entries(c.byKind ?? {})
            .map(
              ([k, r]) => `
            <tr class="${r.signals.all.bets < 20 ? "thin" : ""}">
              <td>${esc(KIND_LABELS[k] ?? k)}</td>
              <td class="num">${r.n}</td>
              <td class="num ${r.brierModel < r.brierPoly ? "up" : ""}">${r.brierModel.toFixed(3)}</td>
              <td class="num ${r.brierPoly <= r.brierModel ? "up" : ""}">${r.brierPoly.toFixed(3)}</td>
              <td class="num">${r.signals.all.bets}</td>
              ${roiCell(exec(r.signals.all, "roi"), r.signals.all.ciExec ?? r.signals.all.ci)}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function spreadsLine(spreads) {
  const parts = Object.entries(spreads ?? {})
    .filter(([, v]) => v.median != null)
    .map(([k, v]) => `${esc(VOLUME_LABELS[k] ?? k)} ${(v.median * 100).toFixed(1).replace(".", ",")} pts`);
  return parts.length ? ` · écart achat-vente typique : ${parts.join(", ")}` : "";
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("backtest-body").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-bt-group]");
    const vchip = e.target.closest("[data-bt-volume]");
    if (chip) {
      filter.group = chip.dataset.btGroup;
      filter.volume = "all";
    } else if (vchip) {
      filter.volume = vchip.dataset.btVolume;
      filter.group = "all";
    } else return;
    renderBacktest(ctx);
  });
}

export function renderBacktest(ctx) {
  bind(ctx);
  const data = ctx.state.backtest;
  const body = $("backtest-body");
  const live = `<section class="bt-banner ok">Les stratégies trouvées ici sont mises à l'épreuve en direct, sur des marchés que le backtest n'a jamais vus :
    <a href="#strategies">voir l'onglet Stratégies</a></section>`;
  if (data === null) {
    body.innerHTML = live + `<p class="empty">Chargement du backtest…</p>`;
    return;
  }
  if (!data || !data.calibration) {
    body.innerHTML =
      live +
      `<p class="empty">Le backtest n'est pas encore disponible. Il est calculé une fois par jour par la GitHub Action (quelques minutes de calcul) : réessaie un peu plus tard.</p>`;
    return;
  }

  const cal = data.calibration;
  const groups = ["all", ...Object.keys(cal.byGroup ?? {})];
  if (!groups.includes(filter.group)) filter.group = "all";
  const volumes = Object.keys(cal.byVolume ?? {});
  if (filter.volume !== "all" && !volumes.includes(filter.volume)) filter.volume = "all";
  const cur =
    filter.volume !== "all" ? cal.byVolume[filter.volume] : filter.group === "all" ? cal : cal.byGroup[filter.group];
  const found = findings(cur.bins);

  body.innerHTML = `
    ${live}

    <p class="muted small">Backtest calculé ${timeAgo(new Date(data.updatedAt).getTime())} · prix pris ${data.lookbackHours} h avant la fin de chaque marché${
      data.partial ? " · calcul interrompu (limite de temps), résultats partiels" : ""
    }${spreadsLine(data.spreads)}.</p>

    <section class="verdict">
      <h2>1. Polymarket est-il bien calibré ?</h2>
      <p>Sur <b>${cal.n}</b> marchés terminés ces 6 derniers mois : quand Polymarket affichait X % la veille, est-ce que ça
        arrivait vraiment X % du temps ? Si un point est <b>sous la diagonale</b>, l'issue était trop chère (acheter « Non » rapportait) ;
        <b>au-dessus</b>, elle était bradée.</p>
      <nav class="chips">
        ${groups
          .map(
            (g) =>
              `<button type="button" class="chip${g === filter.group && filter.volume === "all" ? " active" : ""}" data-bt-group="${g}" aria-pressed="${g === filter.group && filter.volume === "all"}">${
                GROUP_LABELS[g] ?? g
              } <span class="count">${g === "all" ? cal.n : cal.byGroup[g].n}</span></button>`
          )
          .join("")}
      </nav>
      ${
        volumes.length
          ? `<nav class="chips" aria-label="Volume du marché">
              <span class="chips-label">Volume du marché</span>
              ${volumes
                .map(
                  (v) =>
                    `<button type="button" class="chip${v === filter.volume ? " active" : ""}" data-bt-volume="${esc(v)}" aria-pressed="${v === filter.volume}">${
                      VOLUME_LABELS[v] ?? esc(v)
                    } <span class="count">${cal.byVolume[v].n}</span></button>`
                )
                .join("")}
            </nav>`
          : ""
      }
      <div class="calib-layout">
        <div class="chart-box calib-box" id="calib-chart"></div>
        <div class="calib-findings">
          <h3>Biais stables trouvés</h3>
          ${
            found.length
              ? `<ul>${found.map((f) => `<li>${f}</li>`).join("")}</ul>
                 <p class="muted small">« Stable » = au moins +${MIN_ROI * 100} % dans les deux moitiés (tirées au sort par événement) et une marge d'erreur entièrement positive. Gains au prix réellement payé (écart achat-vente compris). Ça reste du passé : rien ne garantit que ça dure, c'est l'onglet Stratégies qui le vérifie en direct.</p>`
              : `<p>Aucun biais assez fort et stable dans cette catégorie : Polymarket y est bien calibré, il n'y a pas d'argent facile à prendre en pariant systématiquement sur une tranche de prix.</p>`
          }
        </div>
      </div>
      ${calibrationTable(cur.bins)}
    </section>

    <section class="verdict">
      <h2>2. Le modèle crypto aurait-il gagné ?</h2>
      ${cryptoSection(data.crypto)}
    </section>

    <section class="caveats">
      <h2>Comment lire ces résultats</h2>
      <ul>
        <li><b>Pas de triche :</b> tous les prix sont ceux d'avant la fin du marché (${data.lookbackHours} h avant), jamais le résultat.</li>
        <li><b>Par événement :</b> les marchés d'un même événement (les seuils d'un même jour, le vainqueur et le handicap d'un même match) gagnent ou perdent ensemble. Ils comptent comme un seul pari pour les signaux et restent ensemble dans la même moitié.</li>
        <li><b>Deux moitiés :</b> les événements sont répartis au hasard en A et B. Un effet qui n'existe que dans une moitié est probablement de la chance.</li>
        <li><b>Marge d'erreur :</b> l'intervalle entre crochets contient 90 % des résultats qu'on obtiendrait en retirant d'autres événements au hasard. Il apparaît en gras quand il ne contient pas zéro : le gain (ou la perte) a alors peu de chances d'être dû au hasard.</li>
        <li><b>Le passé n'est pas l'avenir :</b> un biais connu finit souvent par disparaître quand d'autres l'exploitent.</li>
        <li><b>Prix payé :</b> on achète au prix vendeur, plus cher que le prix affiché. L'écart est estimé à partir des marchés ouverts aujourd'hui de même taille. Les grosses mises font aussi bouger le prix : les gains valent pour de petites sommes.</li>
        <li><b>Petits marchés :</b> c'est là que les prix se trompent le plus souvent, mais aussi là où l'écart achat-vente est le plus large et où le dernier prix peut dater de plusieurs heures. Un gain affiché sur la tranche « moins de 10 k$ » est le plus dur à obtenir en vrai : on ne peut y miser que de petites sommes sans faire bouger le prix.</li>
        <li><b>Modèle crypto simplifié :</b> le backtest utilise la volatilité DVOL (à la monnaie, 30 jours), sans le « sourire » de volatilité utilisé en direct.</li>
      </ul>
    </section>`;

  calibrationChart($("calib-chart"), cur.bins);
}
