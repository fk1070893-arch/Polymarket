// Calendrier : ce qui se termine dans les 7 prochains jours (les événements
// les plus suivis) et les résultats des dernières 48 heures.
// Résultat : site/data/calendar.json
//
// Usage : node scripts/build-calendar.mjs (après build-universe.mjs)

import { GAMMA } from "../site/js/api.js";
import { normalizeEvent, normalizeMarket, winnerIndex } from "../site/js/normalize.js";
import { parseTime } from "./backtest-lib.mjs";
import { getJSON, universeEvents, writeData } from "./lib.mjs";

const DAY = 86400000;
const MAX_UPCOMING = 400;
const NOISE = /\bup or down\b/i;

// L'issue en tête d'un événement : « Oui » à x % pour une question simple,
// le candidat le plus probable sinon
function leader(ev) {
  const e = normalizeEvent(ev);
  if (!e.markets.length) return null;
  if (e.markets.length === 1) {
    const m = e.markets[0];
    const i = m.prices[0] >= (m.prices[1] ?? 0) ? 0 : 1;
    return { label: m.outcomes[i] ?? "", p: m.prices[i] ?? null };
  }
  const m = e.markets[0]; // déjà triés par probabilité décroissante
  return { label: m.label || m.question, p: m.prices[0] ?? null };
}

function upcoming(events, now) {
  return events
    .filter((ev) => {
      const end = parseTime(ev.endDate);
      return end != null && end > now && end < now + 7 * DAY && !NOISE.test(ev.title ?? "");
    })
    .sort((a, b) => (Number(b.volume24hr) || 0) - (Number(a.volume24hr) || 0))
    .slice(0, MAX_UPCOMING)
    .map((ev) => ({
      id: String(ev.id),
      slug: ev.slug ?? "",
      title: ev.title ?? "",
      image: ev.image || ev.icon || "",
      end: parseTime(ev.endDate),
      volume24h: Math.round(Number(ev.volume24hr) || 0),
      tags: (ev.tags ?? []).map((t) => t.slug).filter(Boolean).slice(0, 6),
      leader: leader(ev),
    }))
    .sort((a, b) => a.end - b.end);
}

// Événements terminés depuis 48 h, les plus suivis, avec leur résultat
async function resolved(now) {
  const out = [];
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      closed: "true",
      end_date_min: new Date(now - 2 * DAY).toISOString(),
      end_date_max: new Date(now).toISOString(),
      order: "volume",
      ascending: "false",
      limit: "100",
      offset: String(page * 100),
    });
    const batch = await getJSON(`${GAMMA}/events?${params}`);
    for (const ev of batch) {
      if (NOISE.test(ev.title ?? "")) continue;
      const winners = (ev.markets ?? [])
        .map((raw) => {
          const m = normalizeMarket(raw);
          const w = winnerIndex({ ...m, closed: raw.closed === true || m.closed });
          if (w == null) return null;
          // Question à plusieurs issues : on garde l'issue dont le « Oui » a gagné
          if ((ev.markets ?? []).length > 1) return w === 0 ? m.label || m.question : null;
          return m.outcomes[w] ?? null;
        })
        .filter(Boolean);
      if (!winners.length) continue;
      out.push({
        id: String(ev.id),
        slug: ev.slug ?? "",
        title: ev.title ?? "",
        image: ev.image || ev.icon || "",
        end: parseTime(ev.endDate),
        volume: Math.round(Number(ev.volume) || 0),
        winner: winners.slice(0, 3).join(", "),
      });
    }
    if (batch.length < 100) break;
  }
  return out.sort((a, b) => b.end - a.end).slice(0, 150);
}

const now = Date.now();
try {
  const events = (await universeEvents()) ?? [];
  const up = upcoming(events, now);
  const done = await resolved(now).catch((err) => {
    console.log(`Résultats récents indisponibles (${err.message})`);
    return [];
  });
  console.log(`Calendrier : ${up.length} événements dans les 7 jours, ${done.length} résultats des dernières 48 h`);
  await writeData("calendar.json", { updatedAt: new Date(now).toISOString(), upcoming: up, resolved: done });
} catch (err) {
  console.log(`::warning::Calendrier en échec : ${err.message}`);
}
