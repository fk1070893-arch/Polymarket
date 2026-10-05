// Onglet « Backtest » : résultats de scripts/build-backtest.mjs

import { esc, pct, timeAgo } from "./format.js";

const GROUP_LABELS = { all: "Tout", politique: "Politique", crypto: "Crypto", sport: "Sport", eco: "Économie / Tech", autre: "Autres" };
const KIND_LABELS = { above: "Au-dessus de X à une date", below: "Sous X à une date", between: "Entre A et B à une date", touch: "Atteint / chute à X" };
const MIN_N = 30; // en dessous, un résultat n'est pas affiché comme fiable
const MIN_ROI = 0.05;

const filter = { group: "all" };
let bound = false;
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function roiCell(v) {
  if (v == null) return `<td class="num muted">—</td>`;
  const p = Math.round(v * 100);
  return `<td class="num ${p > 0 ? "up" : p < 0 ? "down" : ""}">${p > 0 ? "+" : ""}${p} %</td>`;
}

// Un gain est "stable" s'il est du même signe et assez grand dans les deux
// moitiés tirées au sort, avec assez de marchés de chaque côté.
function stable(bin, side) {
  const a = bin.A[side];
  const b = bin.B[side];
  return bin.A.n >= MIN_N / 2 && bin.B.n >= MIN_N / 2 && a != null && b != null && a >= MIN_ROI && b >= MIN_ROI;
}

function binLabel(b) {
  return `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)} %`;
}

function findings(bins) {
  const out = [];
  for (const b of bins) {
    if (b.n < MIN_N) continue;
    if (stable(b, "roiNo"))
      out.push(`Acheter <b>« Non »</b> quand « Oui » est à <b>${binLabel(b)}</b> : ${pctSigned(b.roiNo)} par pari (moitié A ${pctSigned(b.A.roiNo)}, moitié B ${pctSigned(b.B.roiNo)}, ${b.n} marchés).`);
    if (stable(b, "roiYes"))
      out.push(`Acheter <b>« Oui »</b> quand il est à <b>${binLabel(b)}</b> : ${pctSigned(b.roiYes)} par pari (moitié A ${pctSigned(b.A.roiYes)}, moitié B ${pctSigned(b.B.roiYes)}, ${b.n} marchés).`);
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
          <tr><th>Prix « Oui » la veille</th><th class="num">Marchés</th><th class="num">Prix moyen</th><th class="num">Réalité</th><th class="num">Acheter « Oui »</th><th class="num">Acheter « Non »</th></tr>
        </thead>
        <tbody>
          ${bins
            .filter((b) => b.n > 0)
            .map(
              (b) => `
            <tr class="${b.n < MIN_N ? "thin" : ""}">
              <td>${binLabel(b)}</td>
              <td class="num">${b.n}</td>
              <td class="num">${pct(b.avgPrice)}</td>
              <td class="num"><b>${pct(b.freq)}</b></td>
              ${roiCell(b.roiYes)}
              ${roiCell(b.roiNo)}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="muted small">« Acheter Oui / Non » = gain moyen pour 1 $ misé sur chaque marché de la tranche, au prix de la veille. Lignes grisées : moins de ${MIN_N} marchés, pas fiable.</p>`;
}

function cryptoSection(c) {
  if (!c || !c.n) {
    return `<p class="empty-inline">Pas encore de résultat pour le modèle crypto (historique Deribit ou marchés crypto terminés indisponibles).</p>`;
  }
  const better = c.brierModel < c.brierPoly;
  const t5 = c.thresholds?.["0.05"];
  const verdict = (() => {
    if (!t5 || t5.all.bets < MIN_N) return "Trop peu de signaux pour conclure.";
    const okA = t5.A.roi != null && t5.A.roi > 0;
    const okB = t5.B.roi != null && t5.B.roi > 0;
    if (okA && okB) return `<b class="up">Les signaux à 5 pts auraient rapporté dans les deux moitiés.</b> C'est encourageant, à confirmer sur les marchés en cours.`;
    if (!okA && !okB) return `<b class="down">Les signaux à 5 pts auraient perdu de l'argent dans les deux moitiés.</b> Le modèle tel quel ne bat pas Polymarket : il ne faut pas le suivre aveuglément.`;
    return `<b>Résultat différent selon la moitié : probablement du hasard.</b> Pas d'avantage démontré.`;
  })();

  return `
    <p>Rejoué sur <b>${c.n}</b> marchés BTC/ETH terminés (prix et volatilité DVOL de Deribit 24 h avant la fin).
      Erreur moyenne (Brier, plus bas = meilleur) : modèle <b>${c.brierModel.toFixed(3)}</b>, Polymarket <b>${c.brierPoly.toFixed(3)}</b>.
      <b class="${better ? "up" : "down"}">${better ? "Le modèle a été plus précis que Polymarket." : "Polymarket a été plus précis que le modèle."}</b></p>
    <p>${verdict}</p>
    <h3>Si on avait suivi chaque signal (1 $ par signal)</h3>
    <div class="table-wrap">
      <table class="bt-table">
        <thead><tr><th>Écart minimum</th><th class="num">Signaux</th><th class="num">Gagnés</th><th class="num">Gain / pari</th><th class="num">Moitié A</th><th class="num">Moitié B</th></tr></thead>
        <tbody>
          ${Object.entries(c.thresholds ?? {})
            .map(
              ([t, r]) => `
            <tr class="${r.all.bets < MIN_N ? "thin" : ""}">
              <td>${Math.round(Number(t) * 100)} pts</td>
              <td class="num">${r.all.bets}</td>
              <td class="num">${r.all.bets ? pct(r.all.wins / r.all.bets) : "—"}</td>
              ${roiCell(r.all.roi)}${roiCell(r.A.roi)}${roiCell(r.B.roi)}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <h3>Par type de marché</h3>
    <div class="table-wrap">
      <table class="bt-table">
        <thead><tr><th>Type</th><th class="num">Marchés</th><th class="num">Brier modèle</th><th class="num">Brier Polymarket</th><th class="num">Signaux 5 pts</th><th class="num">Gain / pari</th></tr></thead>
        <tbody>
          ${Object.entries(c.byKind ?? {})
            .map(
              ([k, r]) => `
            <tr class="${r.n < MIN_N ? "thin" : ""}">
              <td>${esc(KIND_LABELS[k] ?? k)}</td>
              <td class="num">${r.n}</td>
              <td class="num ${r.brierModel < r.brierPoly ? "up" : ""}">${r.brierModel.toFixed(3)}</td>
              <td class="num ${r.brierPoly <= r.brierModel ? "up" : ""}">${r.brierPoly.toFixed(3)}</td>
              <td class="num">${r.signals.all.bets}</td>
              ${roiCell(r.signals.all.roi)}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("backtest-body").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-bt-group]");
    if (!chip) return;
    filter.group = chip.dataset.btGroup;
    renderBacktest(ctx);
  });
}

export function renderBacktest(ctx) {
  bind(ctx);
  const data = ctx.state.backtest;
  const body = $("backtest-body");
  if (data === null) {
    body.innerHTML = `<p class="empty">Chargement du backtest…</p>`;
    return;
  }
  if (!data || !data.calibration) {
    body.innerHTML = `<p class="empty">Le backtest n'est pas encore disponible. Il est calculé une fois par jour par la GitHub Action (quelques minutes de calcul) : réessaie un peu plus tard.</p>`;
    return;
  }

  const cal = data.calibration;
  const groups = ["all", ...Object.keys(cal.byGroup ?? {})];
  if (!groups.includes(filter.group)) filter.group = "all";
  const cur = filter.group === "all" ? cal : cal.byGroup[filter.group];
  const found = findings(cur.bins);

  body.innerHTML = `
    <p class="muted small">Calculé ${timeAgo(new Date(data.updatedAt).getTime())} · prix pris ${data.lookbackHours} h avant la fin de chaque marché${
      data.partial ? " · calcul interrompu (limite de temps), résultats partiels" : ""
    }.</p>

    <section class="verdict">
      <h2>1. Polymarket est-il bien calibré ?</h2>
      <p>Sur <b>${cal.n}</b> marchés terminés ces 6 derniers mois : quand Polymarket affichait X % la veille, est-ce que ça
        arrivait vraiment X % du temps ? Si un point est <b>sous la diagonale</b>, l'issue était trop chère (acheter « Non » rapportait) ;
        <b>au-dessus</b>, elle était bradée.</p>
      <nav class="chips">
        ${groups
          .map(
            (g) =>
              `<button type="button" class="chip${g === filter.group ? " active" : ""}" data-bt-group="${g}" aria-pressed="${g === filter.group}">${
                GROUP_LABELS[g] ?? g
              } <span class="count">${g === "all" ? cal.n : cal.byGroup[g].n}</span></button>`
          )
          .join("")}
      </nav>
      <div class="calib-layout">
        <div class="chart-box calib-box" id="calib-chart"></div>
        <div class="calib-findings">
          <h3>Biais stables trouvés</h3>
          ${
            found.length
              ? `<ul>${found.map((f) => `<li>${f}</li>`).join("")}</ul>
                 <p class="muted small">« Stable » = au moins +${MIN_ROI * 100} % dans les deux moitiés tirées au sort. Ça reste du passé : rien ne garantit que ça dure, et les frais / l'écart achat-vente rognent ces gains.</p>`
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
        <li><b>Deux moitiés :</b> les marchés sont répartis au hasard en A et B. Un effet qui n'existe que dans une moitié est probablement de la chance.</li>
        <li><b>Le passé n'est pas l'avenir :</b> un biais connu finit souvent par disparaître quand d'autres l'exploitent.</li>
        <li><b>Frais et liquidité :</b> les gains sont calculés au prix affiché ; en vrai, l'écart achat-vente et la taille des mises les réduisent.</li>
        <li><b>Modèle crypto simplifié :</b> le backtest utilise la volatilité DVOL (à la monnaie, 30 jours), sans le « sourire » de volatilité utilisé en direct.</li>
      </ul>
    </section>`;

  calibrationChart($("calib-chart"), cur.bins);
}
