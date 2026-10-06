// Onglet « Stratégies » : tests en direct sur des marchés que le backtest
// n'a jamais vus (favoris sport, copie des alertes, bookmakers) et
// anomalies de prix. Données : strategy.json, copy.json, odds.json, arbs.json.

import { cents, duration, esc, money, pct, timeAgo } from "./format.js";

const MIN_BETS = 50; // en dessous, pas de conclusion
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
    Gain moyen <b>au prix réellement payé</b> : <b class="${cls(s.roi)}">${sp(s.roi)}</b> par pari${s.ci ? `, marge d'erreur ${ciText(s.ci)}` : ""}
    (${pnl >= 0 ? "+" : "−"}${money.format(Math.abs(pnl))} pour ${n} $ misés)${
      s.roiMid != null ? `. Au prix affiché, ç'aurait été ${sp(s.roiMid)}` : ""
    }.</p><p>${line}</p>`;
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

function favoritesSection(st) {
  const title = "Contre les favoris sport";
  if (st === null) return loading(title);
  if (!st?.summary) return `<section class="verdict live"><h2>${title}</h2><p>Le test démarre au prochain passage de la GitHub Action.</p></section>`;
  const s = st.summary;
  const spread = s.medianSpread != null ? `<em class="muted">écart achat-vente médian ${(s.medianSpread * 100).toFixed(1)} pts</em>` : "";
  return `
    <section class="verdict live" id="strat-favoris">
      <h2>${title}</h2>
      <p>Le backtest a trouvé que les favoris sport cotés 60-90 % la veille gagnent moins souvent que leur prix ne le dit.
        On le vérifie en direct en pariant fictivement contre eux.</p>
      ${started(st)}
      ${stats(s, spread)}
      ${verdict(s)}
      ${
        s.all?.n
          ? `<p class="muted small">Comptés comme dans le backtest : les marchés finis avec au moins 1 000 $ de volume (${s.n ?? 0}).
              Sur tous les paris réglés (${s.all.n}), y compris les petits marchés : ${sp(s.all.roi ?? s.all.roiMid)} par pari.</p>`
          : ""
      }
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `${b.question !== b.eventTitle ? `${esc(b.question)} · ` : ""}favori ${esc(b.favorite)} à ${pct(b.p)}`,
        pick: `1 $ sur <b>${esc(b.bet)}</b> à ${cents(b.cost ?? 1 - b.p)}${b.cost == null ? ` <span class="muted small">(prix affiché)</span>` : ""}`,
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
        pick: `1 $ sur <b>${esc(b.outcome === "Yes" ? "Oui" : b.outcome === "No" ? "Non" : b.outcome)}</b> à ${cents(b.cost)}`,
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
        pick: `1 $ sur <b>${esc(b.outcome === "Yes" ? b.question : b.outcome)}</b> à ${cents(b.cost)}`,
      }))}
    </section>`;
}

// ---------- Marchés tout neufs ----------

function freshSection(st) {
  const title = "Contre les marchés tout neufs à 50 %";
  if (st === null) return loading(title);
  if (!st?.summary) return `<section class="verdict live"><h2>${title}</h2><p>Le test démarre au prochain passage de la GitHub Action.</p></section>`;
  const s = st.summary;
  const seen = (s.quoted ?? 0) + (s.noQuote ?? 0);
  const cents0 = (v) => (v == null ? "—" : `${Math.round(v * 100)} ¢`);
  const sub = (x, label) => (x?.n ? `<li>${label} : ${x.n} pari${x.n > 1 ? "s" : ""}, <b class="${cls(x.roi)}">${sp(x.roi)}</b> par pari</li>` : "");
  const details = [sub(s.multi, "Événements à plusieurs candidats"), sub(s.single, "Questions simples oui / non")].join("");
  return `
    <section class="verdict live" id="strat-neufs">
      <h2>${title}</h2>
      <p>Le backtest dit : un marché affiché 40-60 % six heures après son ouverture ne se réalise que 22 % du temps, et acheter « Non » aurait rapporté +44 % par pari.
        Mais c'est peut-être un <b>prix fantôme</b> (50 % par défaut, faute d'échanges). Ici, on regarde le <b>vrai prix de vente</b> du « Non » dans le carnet d'ordres.</p>
      ${started(st)}
      ${
        seen
          ? `<p><b>${seen}</b> marché${seen > 1 ? "s" : ""} repéré${seen > 1 ? "s" : ""} : ${s.noQuote ?? 0} sans aucun vendeur de « Non » (prix fantôme pur),
              ${s.quoted ?? 0} avec un vendeur. Prix payé médian <b>${cents0(s.medianCost)}</b>, soit <b>${cents0(s.medianPremium)}</b> de plus que le prix affiché.</p>`
          : `<p class="muted">Aucun marché repéré pour l'instant.</p>`
      }
      ${stats(s)}
      ${verdict(s)}
      ${details ? `<ul class="strat-split">${details}</ul>` : ""}
      ${betList(st.bets, (b) => ({
        title: b.eventTitle || b.question,
        sub: `${b.question !== b.eventTitle ? `${esc(b.question)} · ` : ""}affiché ${pct(b.p)}${b.multi ? " · plusieurs candidats" : ""}`,
        pick: `1 $ sur <b>Non</b> à ${cents(b.cost)} <span class="muted small">(affiché ${cents(b.mid)})</span>`,
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

export function renderStrategies(ctx) {
  const { state } = ctx;
  $("strategies-body").innerHTML = `
    ${favoritesSection(state.strategy)}
    ${copySection(state.copy)}
    ${oddsSection(state.odds)}
    ${freshSection(state.fresh)}
    ${arbsSection(state.arbs)}
    <section class="caveats">
      <h2>Comment lire ces tests</h2>
      <ul>
        <li><b>Rien n'est misé :</b> ce sont des paris fictifs de 1 $, enregistrés au moment où on les aurait pris, puis réglés à la fin du marché.</li>
        <li><b>Prix réellement payé :</b> on achète au meilleur prix vendeur du moment, pas au prix affiché (le milieu entre achat et vente). Sur les petits marchés, la différence peut manger tout le gain.</li>
        <li><b>Il faut du volume :</b> en dessous de 50 paris réglés, le hasard domine. La marge d'erreur entre crochets dit si le résultat peut encore être de la chance.</li>
        <li><b>Plusieurs idées testées :</b> plus on teste de stratégies, plus l'une d'elles finira par « gagner » par hasard. Une stratégie n'est crédible que si elle gagne sur la durée.</li>
      </ul>
    </section>`;
}
