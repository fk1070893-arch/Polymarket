// Onglet « Calendrier » : ce qui se termine bientôt et les derniers résultats
// (données de scripts/build-calendar.mjs).

import { esc, pct, timeAgo, usd0 } from "./format.js";

const $ = (id) => document.getElementById(id);
let bound = false;
const filter = { tab: "upcoming" };
const PER_DAY = 12; // les plus suivis de chaque jour ; le reste sur demande
const expanded = new Set();

const dayKey = (t) => new Date(t).toDateString();
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function dayTitle(t) {
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const yesterday = new Date(Date.now() - 86400000);
  if (dayKey(t) === today.toDateString()) return "Aujourd'hui";
  if (dayKey(t) === tomorrow.toDateString()) return "Demain";
  if (dayKey(t) === yesterday.toDateString()) return "Hier";
  const s = dayFmt.format(new Date(t));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function groupByDay(list) {
  const groups = new Map();
  for (const it of list) {
    const k = dayKey(it.end);
    if (!groups.has(k)) groups.set(k, { key: k, title: dayTitle(it.end), items: [] });
    groups.get(k).items.push(it);
  }
  return [...groups.values()];
}

function openButton(ctx, it) {
  const known = ctx.state.events.some((e) => e.id === it.id);
  return known
    ? `<button type="button" class="link" data-cal-open="${esc(it.id)}">Voir</button>`
    : `<a class="link" href="https://polymarket.com/event/${esc(it.slug)}" target="_blank" rel="noopener noreferrer">Polymarket ↗</a>`;
}

function bind(ctx) {
  if (bound) return;
  bound = true;
  $("calendar-body").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-cal-tab]");
    if (tab) {
      filter.tab = tab.dataset.calTab;
      renderCalendar(ctx);
      return;
    }
    const more = e.target.closest("[data-cal-more]");
    if (more) {
      expanded.add(more.dataset.calMore);
      renderCalendar(ctx);
      return;
    }
    const open = e.target.closest("[data-cal-open]");
    if (open) ctx.openDetail(open.dataset.calOpen);
  });
}

export function renderCalendar(ctx) {
  bind(ctx);
  const body = $("calendar-body");
  const data = ctx.state.calendar;
  if (data === null) {
    body.innerHTML = `<p class="empty">Chargement du calendrier…</p>`;
    return;
  }
  if (!data?.upcoming) {
    body.innerHTML = `<p class="empty">Le calendrier n'est pas encore disponible : il est préparé à chaque passage de la GitHub Action (toutes les 5 minutes).</p>`;
    return;
  }
  const upcoming = data.upcoming.filter((it) => it.end > Date.now());
  const list = filter.tab === "upcoming" ? upcoming : data.resolved;
  const groups = groupByDay(list);
  body.innerHTML = `
    <nav class="chips">
      <button type="button" class="chip${filter.tab === "upcoming" ? " active" : ""}" data-cal-tab="upcoming" aria-pressed="${filter.tab === "upcoming"}">À venir (7 jours) <span class="count">${upcoming.length}</span></button>
      <button type="button" class="chip${filter.tab === "resolved" ? " active" : ""}" data-cal-tab="resolved" aria-pressed="${filter.tab === "resolved"}">Résultats (48 h) <span class="count">${data.resolved.length}</span></button>
    </nav>
    <p class="muted small">Mis à jour ${timeAgo(new Date(data.updatedAt).getTime())} · ${
      filter.tab === "upcoming" ? "les événements les plus suivis qui se terminent dans les 7 jours" : "les événements les plus suivis terminés depuis 48 h"
    }. L'heure de fin est celle prévue : le résultat peut être annoncé plus tard.</p>
    ${
      groups.length
        ? groups
            .map(
              (g) => `
        <section class="cal-day">
          <h2>${esc(g.title)} <span class="muted small">(${g.items.length})</span></h2>
          <div class="cal-list">${(expanded.has(`${filter.tab}:${g.key}`)
            ? g.items
            : [...g.items].sort((a, b) => (b.volume24h ?? b.volume ?? 0) - (a.volume24h ?? a.volume ?? 0)).slice(0, PER_DAY).sort((a, b) => (filter.tab === "upcoming" ? a.end - b.end : b.end - a.end))
          )
            .map(
              (it) => `
            <div class="cal-item">
              <span class="cal-time">${timeFmt.format(new Date(it.end))}</span>
              <span class="cal-main"><b>${esc(it.title)}</b>
                <span class="muted small">${
                  filter.tab === "upcoming"
                    ? `${it.leader ? `En tête : ${esc(it.leader.label)} ${it.leader.p != null ? pct(it.leader.p) : ""} · ` : ""}${usd0.format(it.volume24h)} échangés sur 24 h`
                    : `Résultat : <b>${esc(it.winner)}</b> · ${usd0.format(it.volume)} échangés`
                }</span></span>
              ${openButton(ctx, it)}
            </div>`
            )
            .join("")}</div>
          ${
            g.items.length > PER_DAY && !expanded.has(`${filter.tab}:${g.key}`)
              ? `<button type="button" class="btn small cal-more" data-cal-more="${esc(`${filter.tab}:${g.key}`)}">Afficher les ${g.items.length - PER_DAY} autres</button>`
              : ""
          }
        </section>`
            )
            .join("")
        : `<p class="empty">Rien à afficher.</p>`
    }`;
}
