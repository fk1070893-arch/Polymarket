// Petits graphiques SVG sans dépendance : une sparkline pour les cartes et
// un graphique détaillé (avec survol) pour la fiche d'un marché.

const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function pathFor(points, x, y) {
  return points.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join("");
}

export function sparkline(points, { width = 120, height = 32 } = {}) {
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: "spark", "aria-hidden": "true" });
  if (points.length < 2) return svg;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const ps = points.map((p) => p.p);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const pad = Math.max((hi - lo) * 0.15, 0.01);
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * width;
  const y = (p) => height - 2 - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * (height - 4);
  const up = ps[ps.length - 1] >= ps[0];
  svg.append(el("path", { d: pathFor(points, x, y), class: up ? "spark-up" : "spark-down" }));
  return svg;
}

const pct = (p) => `${(p * 100).toFixed(p < 0.01 || p > 0.99 ? 1 : 0)} %`;

export function lineChart(container, points, { interval = "1w" } = {}) {
  container.replaceChildren();
  if (points.length < 2) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "Historique indisponible pour ce marché.";
    container.append(empty);
    return;
  }

  // La largeur du viewBox suit celle du conteneur pour garder un texte
  // lisible sur mobile au lieu de réduire tout le graphique.
  const W = Math.max(300, Math.round(container.clientWidth || 640));
  const H = W < 480 ? 200 : 240;
  const m = { top: 12, right: 44, bottom: 26, left: 8 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const ps = points.map((p) => p.p);
  let lo = Math.max(0, Math.floor((Math.min(...ps) - 0.05) * 10) / 10);
  let hi = Math.min(1, Math.ceil((Math.max(...ps) + 0.05) * 10) / 10);
  if (hi - lo < 0.2) {
    lo = Math.max(0, lo - 0.1);
    hi = Math.min(1, hi + 0.1);
  }

  const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (p) => m.top + (1 - (p - lo) / (hi - lo)) * ih;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  svg.setAttribute("aria-label", `Évolution de la probabilité, de ${pct(ps[0])} à ${pct(ps[ps.length - 1])}`);

  // Grille horizontale et graduations en %
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const p = lo + ((hi - lo) * i) / steps;
    svg.append(el("line", { x1: m.left, x2: m.left + iw, y1: y(p), y2: y(p), class: "gridline" }));
    const label = el("text", { x: m.left + iw + 6, y: y(p) + 4, class: "axis" });
    label.textContent = `${Math.round(p * 100)} %`;
    svg.append(label);
  }

  // Graduations temporelles
  const fmt =
    interval === "1d"
      ? new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
  const ticks = W < 480 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    const label = el("text", {
      x: x(t),
      y: H - 6,
      class: "axis",
      "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle",
    });
    label.textContent = fmt.format(new Date(t));
    svg.append(label);
  }

  const line = pathFor(points, x, y);
  const area = `${line}L${x(t1).toFixed(1)},${m.top + ih}L${x(t0).toFixed(1)},${m.top + ih}Z`;
  svg.append(el("path", { d: area, class: "area" }));
  svg.append(el("path", { d: line, class: "line" }));

  // Survol : ligne verticale + point + bulle
  const cursor = el("line", { y1: m.top, y2: m.top + ih, class: "cursor", visibility: "hidden" });
  const dot = el("circle", { r: 4, class: "dot", visibility: "hidden" });
  svg.append(cursor, dot);

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;

  const tipFmt = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  function onMove(evt) {
    const rect = svg.getBoundingClientRect();
    const sx = ((evt.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((sx - m.left) / iw) * (t1 - t0);
    let best = points[0];
    for (const pt of points) if (Math.abs(pt.t - t) < Math.abs(best.t - t)) best = pt;
    const cx = x(best.t);
    const cy = y(best.p);
    cursor.setAttribute("x1", cx);
    cursor.setAttribute("x2", cx);
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    cursor.setAttribute("visibility", "visible");
    dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<strong>${pct(best.p)}</strong><span>${tipFmt.format(new Date(best.t))}</span>`;
    const left = (cx / W) * rect.width;
    tip.style.left = `${Math.min(Math.max(left, 50), rect.width - 50)}px`;
    tip.style.top = `${(cy / H) * rect.height}px`;
  }

  function onLeave() {
    cursor.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }

  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);
  container.append(svg, tip);
}
