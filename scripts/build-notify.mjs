// Alertes Telegram : un message quand une stratégie en test trouve un
// nouveau pari (fictif) ou qu'une anomalie de prix apparaît.
//
// Nécessite deux secrets GitHub : TELEGRAM_BOT_TOKEN (donné par @BotFather)
// et TELEGRAM_CHAT_ID (ton identifiant Telegram). Ils ne sont jamais écrits
// dans les logs ni dans les fichiers publiés ; sans eux, l'étape ne fait rien.
// Ce qui a déjà été envoyé est noté dans notify-state.json (identifiants de
// marchés seulement).
//
// Usage : node scripts/build-notify.mjs (après les tests en direct)

import { loadPrevious, readData, readState, writeData } from "./lib.mjs";

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
const SITE = "https://fk1070893-arch.github.io/Polymarket/#strategies";
const HOUR = 3600000;
const KEEP = 7 * 24 * HOUR;
const MAX_LINES = 15;
// Types d'alertes voulus : variable GitHub TELEGRAM_TYPES (ex. « favoris,anomalies,bilan »).
// Sans elle, tout est envoyé.
const TYPES = {
  favoris: "paris contre les favoris sport à bon prix",
  bookmakers: "Polymarket moins cher que les bookmakers",
  kalshi: "Polymarket moins cher que Kalshi",
  suspects: "copie des paris suspects (score 70+)",
  neufs: "marchés neufs à vrai prix",
  anomalies: "anomalies de prix (envoyées tout de suite)",
  bilan: "bilan du soir à 20 h et paliers de 50 paris",
};
const wanted = (process.env.TELEGRAM_TYPES ?? "").split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
const ENABLED = new Set(wanted.length ? wanted.filter((t) => t in TYPES) : Object.keys(TYPES));
const typeOf = (key) =>
  key.startsWith("arb:") ? "anomalies" : { strategy: "favoris", odds: "bookmakers", cross: "kalshi", copy: "suspects", fresh: "neufs" }[key.split(":")[0]];
// Un résumé par heure au plus (sauf anomalie de prix, envoyée tout de suite)
const DIGEST_EVERY = 55 * 60000;

const cents = (p) => `${Math.round(p * 100)} ¢`;
const link = (slug) => (slug ? ` https://polymarket.com/event/${slug}` : "");

async function readOr(name) {
  return readData(name).catch(() => null);
}

// Nouveautés de chaque stratégie : [{ key, text }]
async function candidates() {
  const out = [];
  const strategy = await readState("strategy");
  for (const b of strategy?.bets ?? []) {
    // Seulement les paris « à bon prix » : les autres sont trop nombreux
    if (!b.value) continue;
    out.push({
      key: `strategy:${b.id}`,
      text: `⚽ Contre le favori (${b.when ?? "24h"} avant) : ${b.eventTitle || b.question}\n   1 $ sur ${b.bet} à ${cents(b.cost)} (favori ${b.favorite} à ${Math.round(b.p * 100)} %, plafond ${cents(b.cap)})${link(b.slug)}`,
    });
  }
  const odds = await readState("odds");
  for (const b of odds?.bets ?? []) {
    out.push({
      key: `odds:${b.id}`,
      text: `📊 Moins cher que les bookmakers : ${b.eventTitle || b.question}\n   1 $ sur ${b.outcome === "Yes" ? b.question : b.outcome} à ${cents(b.cost)} (bookmakers ${Math.round(b.book * 100)} %)`,
    });
  }
  const copy = await readState("copy");
  for (const b of copy?.bets ?? []) {
    if (b.score < 70) continue;
    out.push({
      key: `copy:${b.id}`,
      text: `🕵️ Pari suspect copié (score ${b.score}) : ${b.eventTitle || b.question}\n   1 $ sur ${b.outcome} à ${cents(b.cost)} (le wallet a payé ${cents(b.insiderPrice)})`,
    });
  }
  const fresh = await readState("fresh");
  for (const b of fresh?.bets ?? []) {
    out.push({ key: `fresh:${b.id}`, text: `🆕 Marché neuf à vrai prix : ${b.eventTitle || b.question}\n   1 $ sur Non à ${cents(b.cost)}${link(b.slug)}` });
  }
  const cross = await readState("cross");
  for (const b of cross?.bets ?? []) {
    out.push({
      key: `cross:${b.id}`,
      text: `🔁 Moins cher que Kalshi : ${b.question}\n   1 $ sur ${b.outcome === "Yes" ? "Oui" : b.outcome === "No" ? "Non" : b.outcome} à ${cents(b.cost)} (Kalshi ${Math.round(b.kalshi * 100)} %)`,
    });
  }
  for (const a of cross?.arbs ?? []) {
    out.push({
      key: `arb:x:${a.marketId}:${a.label}`,
      text: `💰 Anomalie Polymarket / Kalshi : ${a.question}\n   ${a.label} : ${cents(a.cost)} pour 1 $ sûr (frais compris) — vérifier que les règles sont identiques${link(a.slug)}`,
    });
  }
  const arbs = await readOr("arbs.json");
  for (const f of arbs?.found ?? []) {
    out.push({
      key: `arb:${f.eventId}:${f.side}`,
      text: `💰 Anomalie de prix : ${f.title}\n   tous les « ${f.side === "yes" ? "Oui" : "Non"} » : +${f.profit.toFixed(2)} $ sûrs pour ${f.cost.toFixed(0)} $ engagés${link(f.slug)}`,
    });
  }
  return out;
}

async function send(text) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
    });
  } catch {
    // Jamais l'adresse dans l'erreur : elle contient le jeton
    throw new Error("Telegram injoignable");
  }
  if (!res.ok) throw new Error(`Telegram : HTTP ${res.status}`);
}

// ---------- Bilan du soir ----------

const MIN_BETS = 50;
const pc = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`);
const usd = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2).replace(".", ",")} $`;

// Même règle que le tableau de bord du site
function status(x) {
  const n = x?.nExec ?? x?.n ?? 0;
  if (!n) return "pas encore de résultat";
  if (n < MIN_BETS) return `en test (${n}/${MIN_BETS})`;
  if (x.ci && x.ci[0] > 0) return "✅ prometteuse";
  if (x.ci && x.ci[1] < 0) return "❌ rejetée";
  return "pas de conclusion";
}

async function strategies() {
  const [strategy, copy, odds, cross, fresh] = await Promise.all(["strategy", "copy", "odds", "cross", "fresh"].map((n) => readState(n)));
  const fav = (when) => (strategy?.bets ?? []).filter((b) => (b.when ?? "24h") === when);
  return [
    { key: "fav24", name: "⚽ Favoris sport, 24 h avant", s: strategy?.variants?.["24h"] ?? strategy?.summary, bets: fav("24h") },
    { key: "favValue", name: "⚽ Favoris sport, à bon prix", s: strategy?.variants?.["24h"]?.value, bets: fav("24h").filter((b) => b.value) },
    { key: "fav4", name: "⚽ Favoris sport, 2-6 h avant", s: strategy?.variants?.["4h"], bets: fav("4h") },
    { key: "copy", name: "🕵️ Copier les paris suspects", s: copy?.summary, bets: copy?.bets ?? [] },
    { key: "odds", name: "📊 Moins cher que les bookmakers", s: odds?.summary, bets: odds?.bets ?? [] },
    { key: "cross", name: "🔁 Moins cher que Kalshi", s: cross?.summary, bets: cross?.bets ?? [] },
    { key: "fresh", name: "🆕 Marchés neufs, au vrai prix", s: fresh?.summary, bets: fresh?.bets ?? [] },
  ];
}

function dailyReport(list, now) {
  const day = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Paris" }).format(new Date(now));
  const lines = list.map(({ name, s, bets }) => {
    const today = bets.filter((b) => b.won != null && Number.isFinite(b.roi) && b.resolvedAt && now - b.resolvedAt < 24 * 3600000);
    const won = today.filter((b) => b.won).length;
    const pnl = today.reduce((t, b) => t + b.roi, 0);
    const todayText = today.length ? `${today.length} réglé${today.length > 1 ? "s" : ""} aujourd'hui (${won} gagné${won > 1 ? "s" : ""}, ${usd(pnl)})` : "rien de réglé aujourd'hui";
    const total = s?.n ? `${s.n} paris, ${pc(s.roi)} par pari` : "aucun pari réglé";
    return `${name}\n   ${todayText}\n   Total : ${total} · ${status(s)}`;
  });
  return `📅 Bilan du ${day}\n\n${lines.join("\n\n")}\n\nParis fictifs de 1 $ : ${SITE}`;
}

// Quand l'heure de Paris est 20 h et que le bilan du jour n'est pas parti
function reportDue(now, lastDay) {
  const parts = new Intl.DateTimeFormat("fr-FR", { hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Paris" }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return { due: Number(get("hour")) >= 20 && lastDay !== day, day };
}

if (!TOKEN || !CHAT) {
  console.log("Alertes Telegram désactivées (secrets TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents)");
} else {
  const now = Date.now();
  const prev = await loadPrevious("notify-state.json");
  const sent = Object.fromEntries(Object.entries(prev?.sent ?? {}).filter(([, t]) => now - t < KEEP));
  const all = (await candidates()).filter((c) => ENABLED.has(typeOf(c.key)));
  const fresh = all.filter((c) => !sent[c.key]);
  let lastSent = prev?.lastSent ?? 0;
  let didSend = false;
  try {
    if (!prev) {
      // Premier passage : on ne renvoie pas tout l'historique
      await send(`✅ Alertes Polymarket Viewer activées.\nTu recevras : ${[...ENABLED].map((t) => TYPES[t]).join(" ; ")}.\n${SITE}`);
      console.log(`Alertes activées, ${all.length} paris existants ignorés`);
    } else if (fresh.length && now - (prev.lastSent ?? 0) < DIGEST_EVERY && !fresh.some((c) => typeOf(c.key) === "anomalies")) {
      console.log(`${fresh.length} nouveautés en attente du prochain résumé`);
    } else if (fresh.length) {
      const lines = fresh.slice(0, MAX_LINES).map((c) => c.text);
      if (fresh.length > MAX_LINES) lines.push(`… et ${fresh.length - MAX_LINES} autres`);
      await send(`${lines.join("\n\n")}\n\nParis fictifs, pour suivre les tests : ${SITE}`);
      console.log(`${fresh.length} nouveautés envoyées`);
      lastSent = now;
      didSend = true;
    } else {
      console.log("Rien de nouveau à envoyer");
    }
    // Les nouveautés en attente du résumé ne sont pas encore marquées
    if (didSend || !prev) for (const c of all) sent[c.key] ??= now;
  } catch (err) {
    // On réessaiera au prochain passage
    console.log(`::warning::Alertes Telegram en échec : ${err.message}`);
  }

  // Bilan du soir et paliers de 50 paris réglés
  let reportDay = prev?.reportDay ?? null;
  const milestones = { ...(prev?.milestones ?? {}) };
  if (ENABLED.has("bilan") && prev) {
    try {
      const list = await strategies();
      const { due, day } = reportDue(now, reportDay);
      if (due) {
        await send(dailyReport(list, now));
        reportDay = day;
        console.log("Bilan du soir envoyé");
      }
      for (const { key, name, s } of list) {
        const n = s?.nExec ?? s?.n ?? 0;
        if (n < MIN_BETS || milestones[key]) continue;
        await send(`🏁 ${name} : ${n} paris réglés, assez pour un premier verdict.\n   ${pc(s.roi)} par pari, marge d'erreur [${pc(s.ci?.[0])} ; ${pc(s.ci?.[1])}] → ${status(s)}\n${SITE}`);
        milestones[key] = now;
      }
    } catch (err) {
      console.log(`::warning::Bilan Telegram en échec : ${err.message}`);
    }
  }
  await writeData("notify-state.json", { updatedAt: new Date(now).toISOString(), lastSent, sent, reportDay, milestones });
}
