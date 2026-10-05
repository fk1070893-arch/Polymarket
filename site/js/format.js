// Formatage et petits utilitaires d'affichage partagés par les vues.

export const TAG_FR = {
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
export const TAG_SKIP = new Set(["all", "featured", "recurring", "hide-from-new", "trending", "new", "breaking-news", "games"]);

export function tagLabel(tag) {
  return TAG_FR[tag.slug] ?? tag.label;
}

export const usd = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
export const usd0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0 });
export const money = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
export const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
export const shortDateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
export const timeFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function pct(p) {
  if (p > 0 && p < 0.01) return "<1 %";
  if (p < 1 && p > 0.99) return ">99 %";
  return `${Math.round(p * 100)} %`;
}

// Prix d'une part, à la manière de Polymarket (0,38 $ = 38 ¢)
export function cents(p) {
  const c = p * 100;
  return `${c < 1 || c > 99 ? c.toFixed(1) : Math.round(c)} ¢`;
}

export function signedMoney(v) {
  if (Math.abs(v) < 0.005) return money.format(0);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${money.format(Math.abs(v))}`;
}

export function changeBadge(delta) {
  const pts = delta * 100;
  if (Math.abs(pts) < 0.5) return "";
  const cls = pts > 0 ? "up" : "down";
  const sign = pts > 0 ? "▲" : "▼";
  return `<span class="chg ${cls}">${sign} ${Math.abs(pts).toFixed(0)} pt${Math.abs(pts) >= 2 ? "s" : ""}</span>`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function translateOutcome(o) {
  return { Yes: "Oui", No: "Non", Up: "Hausse", Down: "Baisse" }[o] ?? o;
}

export function duration(seconds) {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  if (d < 60) return `${d} jour${d > 1 ? "s" : ""}`;
  if (d < 730) return `${Math.round(d / 30)} mois`;
  return `${Math.round(d / 365)} ans`;
}

export function timeAgo(tsMs) {
  return `il y a ${duration((Date.now() - tsMs) / 1000)}`;
}

export function shortAddress(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}
