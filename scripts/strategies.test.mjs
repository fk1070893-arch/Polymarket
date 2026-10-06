import assert from "node:assert/strict";
import { test } from "node:test";
import { asksOf, eventPrices, walkBooks } from "./arb-lib.mjs";
import { calibration, followSignals, roiNoExec, roiYesExec } from "./backtest-lib.mjs";
import { devig, gameProbs, marketTargets, sameGame, sameTeam, sideProbs, teamTokens, titleTeams } from "./odds-lib.mjs";
import { askPrices, median, paperStats, roiAt, spreadOf } from "./paper.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// ---------- Paris fictifs ----------

test("prix d'achat des deux issues", () => {
  const [a0, a1] = askPrices({ bestBid: "0.62", bestAsk: 0.64 });
  close(a0, 0.64);
  close(a1, 0.38);
  assert.deepEqual(askPrices({ bestBid: 0, bestAsk: 1 }), [null, null]);
  close(spreadOf({ bestBid: 0.62, bestAsk: 0.64 }), 0.02);
  assert.equal(spreadOf({ bestBid: 0.7, bestAsk: 0.6 }), null);
});

test("gain d'un pari et médiane", () => {
  close(roiAt(0.25, true), 3);
  assert.equal(roiAt(0.25, false), -1);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("statistiques : prix payé et prix affiché séparés", () => {
  const bets = [
    { id: "a", event: "e1", won: true, cost: 0.5, mid: 0.45, roi: 1, roiMid: 1 / 0.45 - 1 },
    { id: "b", event: "e2", won: false, cost: 0.5, mid: 0.45, roi: -1, roiMid: -1 },
    // ancien pari sans prix payé : compte pour le prix affiché seulement
    { id: "c", event: "e3", won: true, cost: null, mid: 0.4, roi: null, roiMid: 1.5 },
    { id: "d", event: "e4", won: null },
  ];
  const s = paperStats(bets);
  assert.equal(s.n, 3);
  assert.equal(s.nExec, 2);
  assert.equal(s.wins, 2);
  close(s.roi, 0);
  close(s.roiMid, (1 / 0.45 - 1 - 1 + 1.5) / 3);
  assert.deepEqual(paperStats([]), { n: 0 });
});

// ---------- Anomalies de prix ----------

const mk = (id, bid, ask, extra = {}) => ({
  id,
  groupItemTitle: `Issue ${id}`,
  bestBid: bid,
  bestAsk: ask,
  clobTokenIds: JSON.stringify([`${id}y`, `${id}n`]),
  outcomePrices: JSON.stringify([String(ask), String(1 - ask)]),
  negRisk: true,
  ...extra,
});

test("somme des Oui inférieure à 100 % : achat de toutes les issues", () => {
  const r = eventPrices({ negRisk: true, markets: [mk(1, 0.3, 0.31), mk(2, 0.3, 0.32), mk(3, 0.3, 0.33)] });
  close(r.yes.cost, 0.96);
  close(r.yes.edge, 0.04);
  close(r.no.edge, -0.1);
});

test("somme des Oui supérieure à 100 % : achat de tous les Non", () => {
  const r = eventPrices({ negRisk: true, markets: [mk(1, 0.4, 0.42), mk(2, 0.35, 0.37), mk(3, 0.3, 0.32)] });
  close(r.no.edge, 0.05);
  close(r.no.cost, 3 - 1.05);
});

test("pas d'achat de tous les Oui si la liste peut s'allonger ou si une issue manque", () => {
  const m = [mk(1, 0.3, 0.31), mk(2, 0.3, 0.32)];
  assert.equal(eventPrices({ negRisk: true, negRiskAugmented: true, markets: m }).yes, null);
  assert.equal(eventPrices({ negRisk: true, markets: [...m, mk(3, 0.1, null)] }).yes, null);
  // un événement déjà joué ou sans issues exclusives est ignoré
  assert.equal(eventPrices({ negRisk: true, markets: [...m, mk(3, 0.99, 0.99, { closed: true })] }), null);
  assert.equal(eventPrices({ markets: m.map((x) => ({ ...x, negRisk: false })) }), null);
});

test("carnets d'ordres : on achète tant que le lot coûte moins que ce qu'il rapporte", () => {
  const books = [
    asksOf({ asks: [{ price: "0.5", size: "100" }, { price: "0.45", size: "10" }] }),
    asksOf({ asks: [{ price: "0.5", size: "50" }] }),
  ];
  // 10 lots à 0,45 + 0,5 = 0,95, puis plus rien à moins de 1 $
  const r = walkBooks(books, 1);
  close(r.sets, 10);
  close(r.cost, 9.5);
  close(r.profit, 0.5);
  assert.equal(walkBooks([[], books[1]], 1).sets, 0);
  // marge minimale : un lot à 0,997 $ pour 1 $ n'en vaut pas la peine
  const thin = [asksOf({ asks: [{ price: "0.497", size: "1000" }] }), asksOf({ asks: [{ price: "0.5", size: "1000" }] })];
  assert.equal(walkBooks(thin, 1).sets, 1000);
  assert.equal(walkBooks(thin, 1, { minMargin: 0.005 }).sets, 0);
  // frais : 2 % × min(p, 1 − p) par part rendent le lot à 0,95 $ non rentable au-delà de la marge
  const cheap = [asksOf({ asks: [{ price: "0.47", size: "10" }] }), asksOf({ asks: [{ price: "0.48", size: "10" }] })];
  close(walkBooks(cheap, 1).profit, 0.5);
  assert.ok(walkBooks(cheap, 1, { fees: [0.02, 0.02] }).profit < 0.5);
});

// ---------- Bookmakers ----------

test("noms d'équipes", () => {
  assert.deepEqual(teamTokens("Manchester Utd FC"), ["manchester", "united"]);
  assert.ok(sameTeam("Chiefs", "Kansas City Chiefs"));
  assert.ok(sameTeam("Man City", "Manchester City"));
  assert.ok(sameTeam("LA Lakers", "Los Angeles Lakers"));
  assert.ok(sameTeam("Atlético Madrid", "Atletico Madrid"));
  assert.ok(!sameTeam("Manchester United", "Manchester City"));
  assert.deepEqual(titleTeams("NFL: Chiefs vs. Bills"), ["Chiefs", "Bills"]);
  assert.deepEqual(titleTeams("Arsenal FC vs Chelsea FC (Premier League)"), ["Arsenal FC", "Chelsea FC"]);
  assert.equal(titleTeams("Will the Chiefs win the Super Bowl?"), null);
});

test("cotes sans la marge du bookmaker", () => {
  const p = devig([
    { name: "A", price: 1.9 },
    { name: "B", price: 1.9 },
  ]);
  close(p.A, 0.5);
  const g = {
    bookmakers: [
      { key: "unibet", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 1.5 }, { name: "B", price: 2.5 }] }] },
      { key: "pinnacle", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 1.6 }, { name: "B", price: 2.4 }] }] },
    ],
  };
  const gp = gameProbs(g);
  assert.equal(gp.source, "pinnacle");
  close(gp.probs.A, 1 / 1.6 / (1 / 1.6 + 1 / 2.4));
});

test("marchés Polymarket comparables aux cotes", () => {
  const nfl = { home: "Buffalo Bills", away: "Kansas City Chiefs" };
  assert.ok(sameGame("Chiefs vs. Bills", nfl));
  assert.ok(!sameGame("Chiefs vs. Jets", nfl));
  const names = ["Buffalo Bills", "Kansas City Chiefs"];
  const t = marketTargets({ question: "Chiefs vs. Bills", sportsMarketType: "moneyline" }, ["Chiefs", "Bills"], nfl, names);
  assert.deepEqual(t, { teams: ["Kansas City Chiefs", "Buffalo Bills"] });
  assert.deepEqual(sideProbs(t, { "Buffalo Bills": 0.4, "Kansas City Chiefs": 0.6 }), [0.6, 0.4]);
  // handicap et total : pas comparables
  assert.equal(marketTargets({ question: "Spread: Chiefs (-3.5)" }, ["Chiefs", "Bills"], nfl, names), null);
  assert.equal(marketTargets({ question: "Chiefs vs. Bills", sportsMarketType: "totals" }, ["Over", "Under"], nfl, names), null);

  const epl = { home: "Arsenal", away: "Chelsea" };
  const soc = ["Arsenal", "Chelsea", "Draw"];
  assert.deepEqual(marketTargets({ question: "Will Arsenal FC win on 2026-10-10?", groupItemTitle: "Arsenal FC" }, ["Yes", "No"], epl, soc), { yes: "Arsenal" });
  assert.deepEqual(marketTargets({ question: "Will Arsenal FC vs. Chelsea FC end in a draw?" }, ["Yes", "No"], epl, soc), { yes: "Draw" });
  // deux équipes alors que le match peut finir nul : pas comparable
  assert.equal(marketTargets({ question: "Arsenal vs. Chelsea" }, ["Arsenal", "Chelsea"], epl, soc), null);
  assert.deepEqual(sideProbs({ yes: "Draw" }, { Arsenal: 0.5, Chelsea: 0.25, Draw: 0.25 }), [0.25, 0.75]);
});

// ---------- Backtest au prix payé ----------

test("les frais s'ajoutent au prix payé", () => {
  const s = { p: 0.7, outcome: 0, hs: 0.02, fee: 0.1 };
  // « Non » : 0,32 + 10 % × min(0,32 ; 0,68) = 0,352
  close(roiNoExec(s), 1 / 0.352 - 1);
});

test("le gain au prix payé tient compte de l'écart achat-vente", () => {
  const s = { p: 0.7, outcome: 0, hs: 0.02 };
  close(roiNoExec(s), 1 / 0.32 - 1);
  close(roiYesExec({ ...s, outcome: 1 }), 1 / 0.72 - 1);
  const samples = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, event: `e${i}`, p: 0.75, outcome: i % 2, hs: 0.01 }));
  const bin = calibration(samples).find((b) => b.n > 0);
  assert.ok(bin.roiNoExec < bin.roiNo);
  close(bin.halfSpread, 0.01);
  const sig = followSignals(
    samples.map((s) => ({ ...s, model: 0.6 })),
    0.05
  );
  assert.ok(sig.all.roiExec < sig.all.roi);
});

// ---------- Études de niche ----------

import { isDeadline, parseUpDown, probUp } from "./niche-lib.mjs";

test("marchés « avant telle date »", () => {
  assert.ok(isDeadline("Will Russia and Ukraine sign a ceasefire by December 31?"));
  assert.ok(isDeadline("Will the Fed cut rates before 2027?"));
  assert.ok(isDeadline("Will X be released by end of Q3?"));
  assert.ok(!isDeadline("Will Bitcoin reach $150,000 by December 31?"));
  assert.ok(!isDeadline("Who will win the election?"));
});

test("marchés Up or Down", () => {
  assert.deepEqual(parseUpDown("Bitcoin Up or Down - October 5, 3:00PM-3:15PM ET"), { asset: "BTC", minutes: 15 });
  assert.deepEqual(parseUpDown("Ethereum Up or Down - October 5, 11PM ET"), { asset: "ETH", minutes: 60 });
  assert.deepEqual(parseUpDown("Bitcoin Up or Down - October 5, 11:45PM-12:00AM ET"), { asset: "BTC", minutes: 15 });
  assert.equal(parseUpDown("Bitcoin Up or Down on October 5?"), null);
  assert.equal(parseUpDown("Solana Up or Down - October 5, 3PM ET"), null);
});

test("probabilité de finir au-dessus de l'ouverture", () => {
  close(probUp(100, 100, 0.5, 0.0001), 0.5);
  assert.ok(probUp(100, 101, 0.5, 30 / 525960) > 0.9);
  assert.ok(probUp(100, 99.9, 0.5, 30 / 525960) < 0.5);
  assert.equal(probUp(0, 100, 0.5, 1), null);
});

import { pnlCurve } from "./paper.mjs";

test("courbe des gains cumulés", () => {
  const bets = [
    { won: true, roi: 2, resolvedAt: 3 },
    { won: false, roi: -1, resolvedAt: 1 },
    { won: null, roi: null },
    { won: true, roi: null, resolvedAt: 2 }, // sans prix payé : ignoré
  ];
  assert.deepEqual(pnlCurve(bets), [
    [1, -1, 1],
    [3, 1, 2],
  ]);
  const many = Array.from({ length: 500 }, (_, i) => ({ won: true, roi: 1, resolvedAt: i + 1 }));
  const c = pnlCurve(many, 50);
  assert.equal(c.length, 50);
  assert.deepEqual(c[c.length - 1], [500, 500, 500]);
});

// ---------- Rapprochement de questions entre sites ----------

import { bestMatch, buildIndex, questionInfo, questionTokens, similarity } from "./match-lib.mjs";

test("mots importants d'une question", () => {
  assert.deepEqual(questionTokens("Will Bitcoin be above $100,000 on December 31?"), ["bitcoin", "above", "100000", "dec", "31"]);
  assert.deepEqual(questionTokens("BTC above 100k"), ["btc", "above", "100000"]);
});

test("similarité : nombres, années et sens doivent concorder", () => {
  const q = (t) => questionInfo(t);
  assert.ok(similarity(q("Will the Fed cut rates in December 2026?"), q("Fed cuts rates in December 2026")) > 0.6);
  assert.equal(similarity(q("Bitcoin above 100000 in 2026"), q("Bitcoin above 110000 in 2026")), 0);
  assert.equal(similarity(q("Bitcoin above 100000"), q("Bitcoin below 100000")), 0);
  assert.equal(similarity(q("Will Trump win in 2024?"), q("Will Trump win in 2028?")), 0);
});

test("meilleure correspondance dans un index", () => {
  const pm = [
    { id: 1, q: "Will the Fed cut interest rates in December 2026?" },
    { id: 2, q: "Will the Fed hike interest rates in December 2026?" },
    { id: 3, q: "Will Bitcoin reach $150,000 in 2026?" },
  ];
  const idx = buildIndex(pm, (x) => x.q);
  assert.equal(bestMatch(idx, "Fed cuts interest rates December 2026")?.item.id, 1);
  assert.equal(bestMatch(idx, "Will Ethereum reach $5,000 in 2026?"), null);
  assert.equal(bestMatch(idx, "Fed cuts interest rates December 2026", { accept: (x) => x.id !== 1 })?.item.id ?? null, null);
});

test("frais : comptés seulement si le marché les a activés", async () => {
  const { feeRate } = await import("./paper.mjs");
  assert.equal(feeRate({ takerBaseFee: 1000 }), 0);
  assert.equal(feeRate({ takerBaseFee: 1000, feesEnabled: false }), 0);
  assert.equal(feeRate({ takerBaseFee: 1000, feesEnabled: true }), 0.1);
  assert.equal(feeRate({ takerBaseFee: 0, feesEnabled: true }), 0);
});
