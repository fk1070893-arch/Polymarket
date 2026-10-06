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

import { loadPrevious, readData, writeData } from "./lib.mjs";

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
const SITE = "https://fk1070893-arch.github.io/Polymarket/#strategies";
const HOUR = 3600000;
const KEEP = 7 * 24 * HOUR;
const MAX_LINES = 15;

const cents = (p) => `${Math.round(p * 100)} ¢`;
const link = (slug) => (slug ? ` https://polymarket.com/event/${slug}` : "");

async function readOr(name) {
  return readData(name).catch(() => null);
}

// Nouveautés de chaque stratégie : [{ key, text }]
async function candidates() {
  const out = [];
  const strategy = await readOr("strategy-state.json");
  for (const b of strategy?.bets ?? []) {
    // Seulement les paris « à bon prix » : les autres sont trop nombreux
    if (!b.value) continue;
    out.push({
      key: `strategy:${b.id}`,
      text: `⚽ Contre le favori (${b.when ?? "24h"} avant) : ${b.eventTitle || b.question}\n   1 $ sur ${b.bet} à ${cents(b.cost)} (favori ${b.favorite} à ${Math.round(b.p * 100)} %, plafond ${cents(b.cap)})${link(b.slug)}`,
    });
  }
  const odds = await readOr("odds-state.json");
  for (const b of odds?.bets ?? []) {
    out.push({
      key: `odds:${b.id}`,
      text: `📊 Moins cher que les bookmakers : ${b.eventTitle || b.question}\n   1 $ sur ${b.outcome === "Yes" ? b.question : b.outcome} à ${cents(b.cost)} (bookmakers ${Math.round(b.book * 100)} %)`,
    });
  }
  const copy = await readOr("copy-state.json");
  for (const b of copy?.bets ?? []) {
    if (b.score < 70) continue;
    out.push({
      key: `copy:${b.id}`,
      text: `🕵️ Pari suspect copié (score ${b.score}) : ${b.eventTitle || b.question}\n   1 $ sur ${b.outcome} à ${cents(b.cost)} (le wallet a payé ${cents(b.insiderPrice)})`,
    });
  }
  const fresh = await readOr("fresh-state.json");
  for (const b of fresh?.bets ?? []) {
    out.push({ key: `fresh:${b.id}`, text: `🆕 Marché neuf à vrai prix : ${b.eventTitle || b.question}\n   1 $ sur Non à ${cents(b.cost)}${link(b.slug)}` });
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

if (!TOKEN || !CHAT) {
  console.log("Alertes Telegram désactivées (secrets TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents)");
} else {
  const now = Date.now();
  const prev = await loadPrevious("notify-state.json");
  const sent = Object.fromEntries(Object.entries(prev?.sent ?? {}).filter(([, t]) => now - t < KEEP));
  const all = await candidates();
  const fresh = all.filter((c) => !sent[c.key]);
  try {
    if (!prev) {
      // Premier passage : on ne renvoie pas tout l'historique
      await send(`✅ Alertes Polymarket Viewer activées.\nTu recevras un message à chaque nouveau pari fictif intéressant.\n${SITE}`);
      console.log(`Alertes activées, ${all.length} paris existants ignorés`);
    } else if (fresh.length) {
      const lines = fresh.slice(0, MAX_LINES).map((c) => c.text);
      if (fresh.length > MAX_LINES) lines.push(`… et ${fresh.length - MAX_LINES} autres`);
      await send(`${lines.join("\n\n")}\n\nParis fictifs, pour suivre les tests : ${SITE}`);
      console.log(`${fresh.length} nouveautés envoyées`);
    } else {
      console.log("Rien de nouveau à envoyer");
    }
    for (const c of all) sent[c.key] ??= now;
  } catch (err) {
    // On réessaiera au prochain passage
    console.log(`::warning::Alertes Telegram en échec : ${err.message}`);
  }
  await writeData("notify-state.json", { updatedAt: new Date(now).toISOString(), sent });
}
