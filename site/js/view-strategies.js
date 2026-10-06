// Onglet « Stratégies » : tests en direct sur des marchés que le backtest
// n'a jamais vus (favoris sport, copie des alertes, bookmakers) et
// anomalies de prix. Données : strategy.json, copy.json, odds.json, arbs.json.

import { pnlChart } from "./chart.js";
import { MIN_BETS, strategyStatus } from "./status.js";
import { cents, duration, esc, money, pct, timeAgo } from "./format.js";

const $ = (id) => document.getElementById(id);

const sp = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`);
const ciText = (ci) => (ci ? `[${sp(ci[0])} ; ${sp(ci[1])}]` : "");
const cls = (v) => (v == null ? "" : v >= 0 ? "up" : "down");

function loading(title) {
  return `<section class="verdict live"><h2>${title}</h2><p class="muted">Chargement…</p></section>`;
}

// Bilan d'une liste de paris réglés (voir scripts/paper.mjs)
function verdict(s) {
  if (!s?.n) return `<p>Aucun pari réglé pour l'instant : les premiers résultats arrivent quand les premiers marchés se terminent.</p>`;
  const n = s.nExec ?? s.n;
  const line =
    n < MIN_BETS
      ? `<b>Trop tôt pour conclure</b> (${n} pari${n > 1 ? "s" : ""} réglé${n > 1 ? "s" : ""} au prix payé) : il en faut au moins ${MIN_BETS} à 100.`
      : s.ci && s.ci[0] > 0
        ? `<b class="up">Ça gagne en direct, et la marge d'erreur est entièrement positive.</b>`
        : s.ci && s.ci[1] < 0
          ? `<b class="down">Ça perd de l'argent en direct : l'idée ne tient pas.</b>`
          : `<b>Pas encore de conclusion : le résultat peut encore s'expliquer par le hasard.</b>`;
  const pnl = s.pnl ?? 0;
  return `<p>Les issues choisies ont gagné <b>${pct(s.winRate)}</b> du temps (${s.wins}/${s.n}) ; leur prix annonçait <b>${pct(s.expectedWinRate)}</b>.
    Gain moyen <b>au prix réellement payé</b> <span class="muted small">(mise de 100 $ : écart achat-vente, glissement et frais compris)</span> : <b class="${cls(s.roi)}">${sp(s.roi)}</b> par pari${s.ci ? `, marge d'erreur ${ciText(s.ci)}` : ""}
    (${pnl >= 0 ? "+" : "−"}${money.format(Math.abs(pnl))} pour ${n} $ misés)${
      s.roiMid != null ? `. Au prix affiché, ç'aurait été ${sp(s.roiMid)}` : ""
    }.</p><p>${line}</p>${realism(s)}`;
}

const int0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

// Ce que le gain par pari ne dit pas (voir realism() dans scripts/paper.mjs)
function realism(s) {
  if (s.avgDays == null) return "";
  const bits = [];
  bits.push(
    `<li>Argent bloqué en moyenne <b>${duration(s.avgDays * 86400)}</b> par pari, jusqu'à la fin du marché : ramené à un an, le rendement est de <b class="${cls(s.perYear)}">${sp(s.perYear)}</b> <span class="muted small">(sans réinvestir les gains)</span>.</li>`
  );
  if (s.withHold)
    bits.push(
      `<li>Récompense de détention de Polymarket (environ 4 %/an sur certains marchés) : <b class="up">+${money.format(s.rewards)}</b> sur ${s.withHold} pari${s.withHold > 1 ? "s" : ""}, soit ${sp(s.roiWithRewards)} par pari avec elle.</li>`
    );
  const lad = (s.ladder ?? []).filter((l) => l.n);
  if (lad.length)
    bits.push(
      `<li>Avec une mise plus grosse, notre propre achat fait monter le prix (on vide les meilleures offres) : ${lad
        .map((l) => `${int0.format(l.stake)} $ → <b class="${cls(l.roi)}">${sp(l.roi)}</b>${l.refused ? ` <span class="muted small">(${l.refused} pari${l.refused > 1 ? "s" : ""} impossible${l.refused > 1 ? "s" : ""} faute de vendeurs)</span>` : ""}`)
        .join(" · ")} <span class="muted small">(sur ${lad[0].n} paris dont le carnet a été lu)</span>.</li>`
    );
  return `<ul class="realism small">${bits.join("")}</ul>`;
}

function stats(s, extra = "") {
  return `<div class="pf-stats">
    <div class="stat"><span>Paris réglés</span><strong>${s?.n ?? 0}</strong><em class="muted">${s?.events ?? 0} événement${(s?.events ?? 0) > 1 ? "s" : ""}</em></div>
    <div class="stat"><span>En attente</span><strong>${s?.pending ?? 0}</strong>${extra}</div>
    <div class="stat"><span>Gain / pari (prix payé)</span><strong class="${cls(s?.roi)}">${s?.n ? sp(s.roi) : "—"}</strong></div>
  </div>`;
}

function betStatus(b) {
  if (b.won == null) {
    return `<span class="muted">${b.end && b.end > Date.now() ? `fin dans ${duration((b.end - Date.now()) / 1000)}` : "résultat en attente"}</span>`;
  }
  return b.won ? `<span class="up"><b>Gagné ${sp(b.roi ?? b.roiMid)}</b></span>` : `<span class="down"><b>Perdu</b></span>`;
}

// Ce que le prix payé comprend en plus du meilleur prix : « dont glissement +1 ¢, frais 0,5 ¢ »
function costDetail(b) {
  const parts = [];
  if (b.slippage > 0.0005) parts.push(`glissement +${(b.slippage * 100).toFixed(1).replace(".", ",")} ¢`);
  if (b.fee > 0.0005) parts.push(`frais ${(b.fee * 100).toFixed(1).replace(".", ",")} ¢`);
  if (b.filled != null && b.filled < 99) parts.push(`seulement ${Math.round(b.filled)} $ achetables`);
  return parts.length ? ` <span class="muted small">(dont ${parts.join(", ")})</span>` : "";
}

function betList(bets, describe) {
  const recent = (bets ?? []).slice(0, 6);
  if (!recent.length) return "";
  return `<h3>Derniers paris fictifs</h3><div class="strat-bets">${recent
    .map((b) => {
      const d = describe(b);
      return `<div class="strat-bet">
        <span class="strat-q"><b>${esc(d.title)}</b><span class="muted small">${d.sub}</span></span>
        <span class="strat-pick">${d.pick}</span>
        ${betStatus(b)}
      </div>`;
    })
    .join("")}</div>`;
}

function started(st) {
  return `<p class="muted small">Démarré ${timeAgo(new Date(st.startedAt).getTime())} · règle : ${esc(st.rule?.description ?? "")}</p>`;
}

// ---------- 1. Contre les favoris sport ----------

const WHEN_LABEL = { "24h": "24 h avant", "4h": "2-6 h avant" };

function favoritesSection(st) {
  const title = "Contre les favoris sport";
  if (st === null) return loading(title);
  if (!st?.summary) return `<section class="verdict live"><h2>${title}</h2><p>Le test démarre au prochain passage de la GitHub Action.</p></section>`;
  const s = st.summary;
  const variants = st.variants ?? { "24h": s };
  const row = (label, x, total) =>
    `<tr class="${(x?.nExec ?? 0) < MIN_BETS ? "thin" : ""}">
      <td>${label}</td>
      <td class="num">${total ?? "—"}</td>
      <td class="num">${x?.n ?? 0}</td>
      <td class="num ${cls(x?.roi)}">${x?.n ? sp(x.roi) : "—"}${x?.ci ? `<span class="ci">${ciText(x.ci)}</span>` : ""}</td>
    </tr>`;
  const rows = Object.entries(variants)
    .map(
      ([k, v]) =>
        row(`<b>${WHEN_LABEL[k] ?? k}</b> : tous les paris`, v, v.total) +
        row(`${WHEN_LABEL[k] ?? k} : à bon prix seulement`, v.value, v.value?.total) +
        (v.withBook ? row(`${WHEN_LABEL[k] ?? k} : favori plus cher que chez les bookmakers`, v.overpriced, null) : "")
    )
    .join("");
  const spread = s.medianSpread != null ? `<em class="muted">écart achat-vente médian ${(s.medianSpread * 100).toFixed(1)} pts</em>` : "";
  const fair = (st.fair ?? []).filter((f) => f.lo >= 0.6 && f.hi <= 0.9);
  return `
    <section class="verdict live" id="strat-favoris">
      <h2>${title}</h2>
      <p>Le backtest a trouvé que les favoris sport cotés 60-90 % gagnent moins souvent que leur prix ne le dit. On le vérifie en direct en pariant fictivement contre eux,
        avec trois variantes : <b>le moment</b> (24 h ou 2-6 h avant la fin), <b>un prix plafond</b> (n'acheter que sous la valeur estimée par le backtest)
        et <b>l'avis des bookmakers</b> (le favori est-il plus cher sur Polymarket que chez Pinnacle ?).</p>
      ${started(st)}
      ${
        fair.length
          ? `<p class="muted small">Prix plafond (valeur du « Non » d'après le backtest, moins 3 ¢) : ${fair
              .map((f) => `favori à ${Math.round(f.lo * 100)}-${Math.round(f.hi * 100)} % → « Non » à ${Math.round((f.fairNo - 0.03) * 100)} ¢ maximum`)
              .join(" · ")}.</p>`
          : ""
      }
      ${stats(s, spread)}
      ${verdict(s)}
      <div class="table-wrap"><table class="bt-table">
        <thead><tr><th>Variante</th><th class="num">Paris pris</th><th class="num">Réglés</th><th class="num">Gain / pari au prix payé (marge 90 %)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="muted small">Résultats comptés comme dans le backtest : marchés finis avec au moins 1 000 $ de volume. Lignes grisées : moins de ${MIN_BETS} paris réglés.</p>
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `${b.question !== b.eventTitle ? `${esc(b.question)} · ` : ""}favori ${esc(b.favorite)} à ${pct(b.p)} · ${WHEN_LABEL[b.when ?? "24h"]}${
          b.book != null ? ` · bookmakers ${pct(b.book)}` : ""
        }`,
        pick: `1 $ sur <b>${esc(b.bet)}</b> à ${b.cost != null ? cents(b.cost) + costDetail(b) : `${cents(1 - b.p)} <span class="muted small">(prix affiché)</span>`}${
          b.value ? ` <span class="flag good">✓ bon prix</span>` : ""
        }`,
      }))}
    </section>`;
}

// ---------- 2. Copier les alertes ----------

function copySection(st) {
  const title = "Copier les paris suspects";
  if (st === null) return loading(title);
  if (!st?.summary) return `<section class="verdict live"><h2>${title}</h2><p>Le test démarre au prochain passage de la GitHub Action.</p></section>`;
  const s = st.summary;
  const sub = (x, label) =>
    x?.n ? `<li>${label} : ${x.n} pari${x.n > 1 ? "s" : ""}, <b class="${cls(x.roi)}">${sp(x.roi)}</b> par pari ${x.ci ? `<span class="muted">${ciText(x.ci)}</span>` : ""}</li>` : "";
  const details = [sub(s.hot, "Score 70 et plus"), sub(s.warm, "Score 50 à 69"), sub(s.small, "Petits marchés")].join("");
  return `
    <section class="verdict live" id="strat-copie">
      <h2>${title}</h2>
      <p>Les alertes repèrent des paris qui ressemblent à ceux d'initiés. Mais est-ce que les copier rapporte ?
        Le site achète fictivement la même issue dès qu'il voit l'alerte, au prix du moment : le pari suspect a souvent déjà fait monter le prix.</p>
      ${started(st)}
      ${stats(s)}
      ${verdict(s)}
      ${
        s.insider?.n
          ? `<p class="muted small">Au prix payé par le wallet suspect (impossible à obtenir en le copiant) : ${sp(s.insider.roi)} par pari. L'écart avec notre résultat est ce que coûte le temps de réaction.</p>`
          : ""
      }
      ${details ? `<ul class="strat-split">${details}</ul>` : ""}
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `${b.question !== b.eventTitle ? `${esc(b.question)} · ` : ""}alerte ${b.score}/100, le wallet a payé ${cents(b.insiderPrice)}`,
        pick: `1 $ sur <b>${esc(b.outcome === "Yes" ? "Oui" : b.outcome === "No" ? "Non" : b.outcome)}</b> à ${cents(b.cost)}${costDetail(b)}`,
      }))}
    </section>`;
}

// ---------- 3. Sport contre bookmakers ----------

function oddsSection(st) {
  const title = "Sport : Polymarket contre les bookmakers";
  if (st === null) return loading(title);
  if (!st || !st.enabled) {
    return `
      <section class="verdict live" id="strat-bookmakers">
        <h2>${title}</h2>
        <p>Les cotes des bookmakers « pros » (Pinnacle en tête) sont la meilleure estimation connue des chances d'un match.
          Quand Polymarket vend une issue nettement moins cher, c'est peut-être une bonne affaire.</p>
        <p><b>Pas encore activé :</b> il faut une clé gratuite The Odds API, enregistrée comme secret <code>ODDS_API_KEY</code> du dépôt GitHub
          (Settings → Secrets and variables → Actions). La clé reste privée : elle n'apparaît ni dans le code ni sur le site.</p>
      </section>`;
  }
  const s = st.summary ?? {};
  const acc = s.accuracy;
  const rows = (st.rows ?? []).filter((r) => r.commence > Date.now()).slice(0, 15);
  return `
    <section class="verdict live" id="strat-bookmakers">
      <h2>${title}</h2>
      <p>Probabilités des bookmakers (sans leur marge) comparées au prix auquel on peut acheter sur Polymarket.</p>
      ${st.startedAt ? started(st) : ""}
      <p class="muted small">Cotes : ${esc(st.status ?? "")}${st.quota?.remaining != null ? ` · ${st.quota.remaining} requêtes restantes ce mois-ci` : ""}</p>
      ${stats(s)}
      ${verdict(s)}
      ${
        acc?.n
          ? `<p>Précision sur <b>${acc.n}</b> marchés terminés (Brier, plus bas = meilleur) : bookmakers <b>${acc.book.toFixed(3)}</b>, Polymarket <b>${acc.poly.toFixed(3)}</b>.
              <b class="${acc.book < acc.poly ? "up" : ""}">${acc.book < acc.poly ? "Les bookmakers ont été plus précis." : "Polymarket a été aussi précis ou plus."}</b></p>`
          : ""
      }
      ${
        rows.length
          ? `<h3>Plus gros écarts en ce moment</h3>
            <div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Match</th><th>Issue</th><th class="num">Bookmakers</th><th class="num">Achat Polymarket</th><th class="num">Écart</th></tr></thead>
              <tbody>${rows
                .map(
                  (r) => `<tr>
                    <td>${esc(r.eventTitle)}<span class="muted small"> · dans ${duration((r.commence - Date.now()) / 1000)}</span></td>
                    <td>${esc(r.outcome === "Yes" ? r.question : r.outcome)}</td>
                    <td class="num">${pct(r.book)}</td>
                    <td class="num">${cents(r.ask)}</td>
                    <td class="num ${r.edge >= 0.03 ? "up" : r.edge < 0 ? "down" : ""}">${r.edge > 0 ? "+" : ""}${Math.round(r.edge * 100)} pts</td>
                  </tr>`
                )
                .join("")}</tbody>
            </table></div>`
          : `<p class="muted">Aucun match rapproché pour l'instant (les cotes sont rafraîchies une ligue à la fois pour tenir le quota gratuit).</p>`
      }
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `bookmakers ${pct(b.book)} (${esc(b.source)}) · écart ${Math.round(b.edge * 100)} pts`,
        pick: `1 $ sur <b>${esc(b.outcome === "Yes" ? b.question : b.outcome)}</b> à ${cents(b.cost)}${costDetail(b)}`,
      }))}
    </section>`;
}

// ---------- Marchés tout neufs ----------

function freshSection(st) {
  const title = "Contre les marchés tout neufs à 50 %";
  if (st === null) return loading(title);
  if (!st?.summary) return `<section class="verdict live"><h2>${title}</h2><p>Le test démarre au prochain passage de la GitHub Action.</p></section>`;
  const s = st.summary;
  const sub = (x, label) => (x?.n ? `<li>${label} : ${x.n} pari${x.n > 1 ? "s" : ""}, <b class="${cls(x.roi)}">${sp(x.roi)}</b> par pari</li>` : "");
  const details = [sub(s.multi, "Événements à plusieurs candidats"), sub(s.single, "Questions simples oui / non")].join("");
  const counts = s.counts ?? [];
  const total = s.total ?? 0;
  const phantom = counts.filter((c) => ["none", "le90", "le97", "gt97"].includes(c.key)).reduce((a, c) => a + c.n, 0);
  return `
    <section class="verdict live" id="strat-neufs">
      <h2>${title}</h2>
      <p>Le backtest disait : un marché affiché 40-60 % six heures après son ouverture ne se réalise que 22 % du temps, et acheter « Non » aurait rapporté +44 % par pari.
        Ici, on regarde le <b>vrai prix de vente</b> du « Non » dans le carnet d'ordres.</p>
      ${started(st)}
      ${
        total
          ? `<p>${phantom / total > 0.5 ? "<b>Verdict : c'est surtout un prix fantôme.</b> " : ""}Sur <b>${total}</b> marchés repérés, <b>${phantom}</b> (${pct(phantom / total)}) n'ont aucun vendeur de « Non »
              ou le vendent plus de 70 ¢ alors qu'il est affiché autour de 50 ¢. Le gain du backtest n'existe pas pour eux.</p>
            <div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Vrai prix du « Non »</th><th class="num">Marchés</th><th class="num">Part</th></tr></thead>
              <tbody>${counts.map((c) => `<tr><td>${esc(c.label)}</td><td class="num">${c.n}</td><td class="num">${pct(c.n / total)}</td></tr>`).join("")}</tbody>
            </table></div>
            <p>On continue de parier seulement quand le « Non » se vend vraiment 70 ¢ ou moins : est-ce que ceux-là gagnent ?</p>`
          : `<p class="muted">Aucun marché repéré pour l'instant.</p>`
      }
      ${stats(s)}
      ${verdict(s)}
      ${details ? `<ul class="strat-split">${details}</ul>` : ""}
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `${b.question !== b.eventTitle ? `${esc(b.question)} · ` : ""}affiché ${pct(b.p)}${b.multi ? " · plusieurs candidats" : ""}`,
        pick: `1 $ sur <b>Non</b> à ${cents(b.cost)}${costDetail(b)} <span class="muted small">(affiché ${cents(b.mid)})</span>`,
      }))}
    </section>`;
}

// ---------- 4. Anomalies de prix ----------

function arbsSection(st) {
  const title = "Anomalies de prix";
  if (st === null) return loading(title);
  const intro = `<p>Dans un événement où <b>une seule issue peut gagner</b> (« Qui va gagner l'élection ? »), les « Oui » doivent valoir 100 % au total.
    S'ils valent moins, acheter toutes les issues rapporte un gain connu d'avance ; s'ils valent plus, c'est l'achat de tous les « Non » qui gagne à coup sûr.
    Le site vérifie dans les carnets d'ordres combien on aurait vraiment pu acheter, en ne gardant que ce qui rapporte au moins 0,5 % de la mise.</p>`;
  if (!st?.updatedAt) return `<section class="verdict" id="strat-anomalies"><h2>${title}</h2>${intro}<p>Le détecteur démarre au prochain passage de la GitHub Action.</p></section>`;
  const found = st.found ?? [];
  const hist = st.history ?? [];
  return `
    <section class="verdict" id="strat-anomalies">
      <h2>${title}</h2>
      ${intro}
      <p class="muted small">Vérifié ${timeAgo(new Date(st.updatedAt).getTime())} : ${st.scanned} événements, dont ${st.exclusive} à issues exclusives ;
        ${st.candidates} écarts affichés, ${st.mirages ?? 0} qui disparaissent dans les carnets d'ordres (prix périmés).</p>
      ${
        found.length
          ? `<div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Événement</th><th>Acheter</th><th class="num">Mise</th><th class="num">Gain sûr</th><th class="num">Par an</th></tr></thead>
              <tbody>${found
                .map(
                  (f) => `<tr>
                    <td><a href="https://polymarket.com/event/${esc(f.slug)}" target="_blank" rel="noopener noreferrer">${esc(f.title)}</a>
                      <span class="muted small"> · ${f.end ? `fin dans ${duration((f.end - Date.now()) / 1000)}` : "fin inconnue"}</span></td>
                    <td>tous les « ${f.side === "yes" ? "Oui" : "Non"} » (${f.legs})</td>
                    <td class="num">${money.format(f.cost)}</td>
                    <td class="num up">+${money.format(f.profit)}</td>
                    <td class="num">${f.yearly != null ? sp(f.yearly) : "—"}</td>
                  </tr>`
                )
                .join("")}</tbody>
            </table></div>`
          : `<p><b>Aucune anomalie exploitable en ce moment.</b> C'est le cas normal : des robots corrigent ces écarts en quelques secondes.</p>`
      }
      ${
        hist.length
          ? `<p class="muted small">Ces 30 derniers jours : ${hist.length} anomalie${hist.length > 1 ? "s" : ""} repérée${hist.length > 1 ? "s" : ""},
              la plus grosse à +${money.format(Math.max(...hist.map((h) => h.bestProfit)))}.</p>`
          : ""
      }
      <p class="muted small">« Par an » ramène le gain à la durée pendant laquelle l'argent reste bloqué : 2 % sur un marché qui finit dans 6 mois, c'est peu.
        Les marchés peuvent aussi être réglés en retard, ou de façon contestée.</p>
    </section>`;
}

// ---------- Kalshi et Metaculus ----------

const yesNo = (o) => (o === "Yes" ? "Oui" : o === "No" ? "Non" : o);
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const day = (t) => (t ? dayFmt.format(new Date(t)) : "?");

// Règles Kalshi dépliables, pour vérifier que les deux questions se règlent pareil
function kalshiRules(rules) {
  return rules ? `<details class="rules"><summary>Règles Kalshi</summary><p>${esc(rules)}${rules.length >= 500 ? "…" : ""}</p></details>` : "";
}

function crossSection(st) {
  const title = "Les mêmes questions sur Kalshi et Metaculus";
  if (st === null) return loading(title);
  if (!st?.updatedAt) return `<section class="verdict live" id="strat-kalshi"><h2>${title}</h2><p>La comparaison démarre au prochain passage de la GitHub Action.</p></section>`;
  const s = st.summary ?? {};
  const gap = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} pts`;
  const pairs = (st.pairs ?? []).slice(0, 15);
  const meta = (st.metaculus ?? []).slice(0, 12);
  return `
    <section class="verdict live" id="strat-kalshi">
      <h2>${title}</h2>
      <p><b>Kalshi</b> est un site de paris régulé aux États-Unis, avec beaucoup de questions communes (Fed, inflation, élections, sport).
        Quand les deux sites ne donnent pas la même probabilité, l'un des deux se trompe. Les questions sont rapprochées par leurs mots importants ;
        les paires dont les nombres, les années ou le sens diffèrent sont écartées.</p>
      ${started(st)}
      <p class="muted small">${esc(st.kalshiStatus ?? "")} · ${st.pmMarkets ?? 0} marchés Polymarket · <b>${st.pairCount ?? 0}</b> questions communes trouvées.</p>
      ${stats(s)}
      ${verdict(s)}
      ${
        (st.arbs ?? []).length
          ? `<h3>Anomalies entre sites</h3>
            <p class="muted small">Acheter « Oui » sur un site et « Non » sur l'autre coûte moins de 1 $ (frais Kalshi compris) : gain sûr <b>si les deux questions se règlent vraiment pareil</b>. Lis toujours les règles des deux côtés : c'est là que se cachent les pièges (date, source, cas limites).</p>
            <div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Question</th><th>Acheter</th><th class="num">Coût pour 1 $</th><th class="num">Gain sûr</th></tr></thead>
              <tbody>${st.arbs
                .slice(0, 10)
                .map(
                  (a) => `<tr><td><a href="https://polymarket.com/event/${esc(a.slug)}" target="_blank" rel="noopener noreferrer">${esc(a.question)}</a>
                    <span class="muted small"> · Kalshi : ${esc(a.kalshiText)}${a.end ? ` · fin ${day(a.end)}` : ""}${a.kalshiEnd ? ` / Kalshi ${day(a.kalshiEnd)}` : ""}</span>${kalshiRules(a.kalshiRules)}</td>
                    <td>${esc(a.label)}</td><td class="num">${cents(a.cost)}</td><td class="num up">+${cents(a.profit)}</td></tr>`
                )
                .join("")}</tbody>
            </table></div>`
          : ""
      }
      ${
        pairs.length
          ? `<h3>Plus gros écarts entre Polymarket et Kalshi</h3>
            <div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Question (Polymarket / Kalshi)</th><th class="num">Polymarket</th><th class="num">Kalshi</th><th class="num">Écart</th></tr></thead>
              <tbody>${pairs
                .map(
                  (p) => `<tr><td>${esc(p.question)}<span class="muted small"><br />Kalshi : ${esc(p.kalshi.text)} · ressemblance ${Math.round(p.sim * 100)} % · fin ${day(p.pmEnd)} / Kalshi ${day(p.kalshi.end)}</span>${kalshiRules(p.kalshi.rules)}</td>
                    <td class="num">${pct(p.pmMid)}</td><td class="num">${pct(p.kalshi.mid)}</td>
                    <td class="num">${Math.abs(p.gap) >= 0.05 ? `<b>${gap(p.gap)}</b>` : gap(p.gap)}</td></tr>`
                )
                .join("")}</tbody>
            </table></div>`
          : `<p class="muted">Aucune question commune trouvée pour l'instant.</p>`
      }
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `${b.question !== b.eventTitle ? `${esc(b.question)} · ` : ""}Kalshi ${pct(b.kalshi)} · écart ${Math.round(b.edge * 100)} pts`,
        pick: `1 $ sur <b>${esc(yesNo(b.outcome))}</b> à ${cents(b.cost)}${costDetail(b)}`,
      }))}
      <h3>Second avis : Metaculus</h3>
      <p>Les prévisions d'une communauté de prévisionnistes, réputées bien calibrées en géopolitique, science et technologie. Pas de pari ici, seulement une comparaison.</p>
      <p class="muted small">${esc(st.metaculusStatus ?? "")} · ${st.metaculusCount ?? 0} questions communes avec Polymarket.</p>
      ${
        meta.length
          ? `<div class="table-wrap"><table class="bt-table">
              <thead><tr><th>Question (Polymarket / Metaculus)</th><th class="num">Polymarket</th><th class="num">Metaculus</th><th class="num">Écart</th></tr></thead>
              <tbody>${meta
                .map(
                  (m) => `<tr><td>${esc(m.question)}<span class="muted small"><br /><a href="${esc(m.metaculus.url)}" target="_blank" rel="noopener noreferrer">Metaculus : ${esc(
                    m.metaculus.text
                  )}</a> · ressemblance ${Math.round(m.sim * 100)} %</span></td>
                    <td class="num">${pct(m.pmMid)}</td><td class="num">${pct(m.metaculus.p)}</td>
                    <td class="num">${Math.abs(m.gap) >= 0.1 ? `<b>${gap(m.gap)}</b>` : gap(m.gap)}</td></tr>`
                )
                .join("")}</tbody>
            </table></div>`
          : ""
      }
    </section>`;
}

// ---------- Tableau de bord ----------

// Statut d'une stratégie : voir status.js
const status = strategyStatus;

function cards(state) {
  const fav = state.strategy?.variants ?? (state.strategy?.summary ? { "24h": state.strategy.summary } : {});
  const list = [
    { id: "fav24", name: "Favoris sport, 24 h avant", s: fav["24h"], curve: fav["24h"]?.curve, anchor: "strat-favoris" },
    { id: "favValue", name: "Favoris sport, à bon prix", s: fav["24h"]?.value, curve: fav["24h"]?.valueCurve, anchor: "strat-favoris" },
    { id: "fav4", name: "Favoris sport, 2-6 h avant", s: fav["4h"], curve: fav["4h"]?.curve, anchor: "strat-favoris" },
    { id: "copy", name: "Copier les paris suspects", s: state.copy?.summary, curve: state.copy?.summary?.curve, anchor: "strat-copie" },
    { id: "odds", name: "Moins cher que les bookmakers", s: state.odds?.summary, curve: state.odds?.summary?.curve, anchor: "strat-bookmakers" },
    { id: "fresh", name: "Marchés neufs, au vrai prix", s: state.fresh?.summary, curve: state.fresh?.summary?.curve, anchor: "strat-neufs" },
    { id: "cross", name: "Moins cher que Kalshi", s: state.cross?.summary, curve: state.cross?.summary?.curve, anchor: "strat-kalshi" },
  ];
  return `
    <section class="dash" aria-label="Tableau de bord des stratégies">
      ${list
        .map((c) => {
          const st = status(c.s);
          const pnl = c.s?.pnl;
          return `
          <article class="dash-card">
            <header>
              <h3><a href="#strategies" data-anchor="${c.anchor}">${c.name}</a></h3>
              <span class="dash-status ${st.key}"><span aria-hidden="true">${st.icon}</span> ${st.label}</span>
            </header>
            <p class="dash-nums">
              <span><b class="${cls(c.s?.roi)}">${c.s?.n ? sp(c.s.roi) : "—"}</b> par pari</span>
              <span class="muted small">${c.s?.ci ? `marge ${ciText(c.s.ci)}` : `${c.s?.pending ?? 0} en attente`}</span>
            </p>
            <div class="dash-chart" data-curve="${c.id}"></div>
            <p class="muted small">${c.s?.n ? `${c.s.n} paris réglés · ${pnl >= 0 ? "+" : "−"}${money.format(Math.abs(pnl ?? 0))} au total` : "Gains cumulés (1 $ par pari)"}</p>
          </article>`;
        })
        .join("")}
    </section>`;
}

// Idées testées puis abandonnées, pour ne pas les refaire
const GRAVEYARD = [
  ["Marchés tout neufs à 50 %", "+44 % dans le backtest, mais c'était un prix fantôme : 98 % de ces marchés n'ont aucun vendeur ou vendent le « Non » à plus de 90 ¢."],
  ["Crypto « Up or Down »", "Le modèle à mi-fenêtre se trompe plus que Polymarket ; le gain apparent ne tient que dans une moitié des données."],
  ["« Avant telle date »", "Trop peu de marchés pour conclure, aucun biais stable à 7, 3 ou 1 jour de l'échéance."],
  ["Modèle crypto (options Deribit)", "Jeu égal avec Polymarket une fois le backtest rendu honnête : pas d'avantage prouvé."],
  ["Acheter les quasi-certitudes (95-99 ¢)", "Elles ne se réalisent que 95 % du temps pour un prix moyen de 99 % : environ −4 % par pari."],
];

function graveyard() {
  return `
    <details class="graveyard">
      <summary><b>Idées testées et abandonnées</b> <span class="muted">(${GRAVEYARD.length})</span></summary>
      <ul>${GRAVEYARD.map(([name, why]) => `<li><b>${name}</b> : ${why}</li>`).join("")}</ul>
    </details>`;
}

let boundDash = false;

export function renderStrategies(ctx) {
  const { state } = ctx;
  const body = $("strategies-body");
  body.innerHTML = `
    ${cards(state)}
    ${graveyard()}
    ${favoritesSection(state.strategy)}
    ${copySection(state.copy)}
    ${oddsSection(state.odds)}
    ${crossSection(state.cross)}
    ${freshSection(state.fresh)}
    ${arbsSection(state.arbs)}
    <section class="caveats">
      <h2>Comment lire ces tests</h2>
      <ul>
        <li><b>Rien n'est misé :</b> ce sont des paris fictifs de 1 $, enregistrés au moment où on les aurait pris, puis réglés à la fin du marché.</li>
        <li><b>Prix réellement payé :</b> chaque pari est compté comme une mise de 100 $ : on achète au prix vendeur (pas au prix affiché), en descendant dans le carnet d'ordres tant que la mise n'est pas complète (le <b>glissement</b>), plus les <b>frais</b> Polymarket quand le marché en prend. Sur les petits marchés, ces coûts peuvent manger tout le gain. Les paris enregistrés avant le 6 octobre au soir ne comptent que le meilleur prix vendeur.</li>
        <li><b>Non compté :</b> le réseau (payé par Polymarket), le dépôt et le retrait d'argent (une fois, pas à chaque pari), et le fait que nos propres achats feraient bouger les prix suivants.</li>
        <li><b>Il faut du volume :</b> en dessous de 50 paris réglés, le hasard domine. La marge d'erreur entre crochets dit si le résultat peut encore être de la chance.</li>
        <li><b>Plusieurs idées testées :</b> plus on teste de stratégies, plus l'une d'elles finira par « gagner » par hasard. Une stratégie n'est crédible que si elle gagne sur la durée.</li>
      </ul>
    </section>`;

  const curves = {
    fav24: state.strategy?.variants?.["24h"]?.curve ?? state.strategy?.summary?.curve,
    favValue: state.strategy?.variants?.["24h"]?.valueCurve,
    fav4: state.strategy?.variants?.["4h"]?.curve,
    copy: state.copy?.summary?.curve,
    odds: state.odds?.summary?.curve,
    fresh: state.fresh?.summary?.curve,
    cross: state.cross?.summary?.curve,
  };
  for (const box of body.querySelectorAll("[data-curve]")) pnlChart(box, curves[box.dataset.curve]);
  if (!boundDash) {
    boundDash = true;
    // Les titres des cartes mènent à la section détaillée sans changer d'onglet
    body.addEventListener("click", (e) => {
      const a = e.target.closest("[data-anchor]");
      if (!a) return;
      e.preventDefault();
      document.getElementById(a.dataset.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}