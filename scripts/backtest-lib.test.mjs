import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapCI, brier, calibration, clusterKey, followSignals, groupOf, half, parseTime, roiNo, roiYes, volumeBucket } from "./backtest-lib.mjs";

test("lecture des dates de l'API", () => {
  assert.equal(parseTime("2025-10-03 12:00:00+00"), Date.UTC(2025, 9, 3, 12));
  assert.equal(parseTime("2025-10-03T12:00:00Z"), Date.UTC(2025, 9, 3, 12));
  assert.equal(parseTime(null), null);
  assert.equal(parseTime("n'importe quoi"), null);
});

test("gains par dollar misé", () => {
  assert.equal(roiYes(0.25, 1), 3);
  assert.equal(roiYes(0.25, 0), -1);
  assert.equal(roiNo(0.75, 0), 3);
  assert.equal(roiNo(0.75, 1), -1);
});

test("moitiés stables et équilibrées", () => {
  assert.equal(half("abc"), half("abc"));
  let a = 0;
  for (let i = 0; i < 2000; i++) if (half(`m${i}`) === "A") a++;
  assert.ok(a > 900 && a < 1100);
});

test("calibration d'un marché parfaitement calibré", () => {
  // Prix 0,10 : 1 sur 10 gagne → gain moyen nul
  const samples = Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, p: 0.1, outcome: i % 10 === 0 ? 1 : 0 }));
  const bins = calibration(samples);
  const b = bins.find((x) => x.n > 0);
  assert.equal(b.n, 100);
  assert.ok(Math.abs(b.freq - 0.1) < 1e-9);
  assert.ok(Math.abs(b.roiYes) < 1e-9);
  assert.ok(Math.abs(b.roiNo) < 1e-9);
  assert.equal(b.A.n + b.B.n, 100);
});

test("calibration : les issues improbables trop chères", () => {
  // Prix 0,10 mais seulement 5 % gagnent → acheter "Non" rapporte
  const samples = Array.from({ length: 200 }, (_, i) => ({ id: `y${i}`, p: 0.1, outcome: i % 20 === 0 ? 1 : 0 }));
  const b = calibration(samples).find((x) => x.n > 0);
  assert.ok(b.roiYes < 0);
  assert.ok(b.roiNo > 0);
});

test("score de Brier et suivi des signaux", () => {
  const s = [
    { id: "a", p: 0.3, model: 0.6, outcome: 1 },
    { id: "b", p: 0.5, model: 0.52, outcome: 0 }, // écart trop faible : ignoré
    { id: "c", p: 0.7, model: 0.4, outcome: 0 },
  ];
  assert.ok(brier(s, "model") < brier(s, "p"));
  const f = followSignals(s, 0.05);
  assert.equal(f.all.bets, 2);
  assert.equal(f.all.wins, 2);
  assert.ok(f.all.pnl > 0);
});

test("catégories", () => {
  assert.equal(groupOf(["politics", "france"]), "politique");
  assert.equal(groupOf(["bitcoin"]), "crypto");
  assert.equal(groupOf(["weird"]), "autre");
});

test("tranches de volume", () => {
  assert.equal(volumeBucket(1500), "<10k");
  assert.equal(volumeBucket(10000), "10k-100k");
  assert.equal(volumeBucket(250000), "100k-1M");
  assert.equal(volumeBucket(5e6), ">1M");
});

test("un même événement tombe toujours dans la même moitié", () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, event: "ev1", p: 0.25, outcome: 0 }));
  const b = calibration(samples).find((x) => x.n > 0);
  assert.ok(b.A.n === 10 || b.B.n === 10);
  assert.equal(b.events, 1);
  assert.equal(clusterKey({ id: "x" }), "x");
});

test("un seul pari par événement : on garde le plus gros écart", () => {
  const s = [
    { id: "a", event: "e1", p: 0.3, model: 0.4, outcome: 0 },
    { id: "b", event: "e1", p: 0.3, model: 0.6, outcome: 1 },
    { id: "c", event: "e2", p: 0.5, model: 0.3, outcome: 0 },
  ];
  const one = followSignals(s, 0.05);
  assert.equal(one.all.bets, 2);
  assert.equal(one.all.wins, 2);
  const every = followSignals(s, 0.05, { onePerEvent: false });
  assert.equal(every.all.bets, 3);
});

test("marge d'erreur : plus large quand les marchés sont liés", () => {
  // 40 marchés indépendants contre les mêmes 40 regroupés en 4 événements
  const values = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 3 : -0.5));
  const indep = values.map((v, i) => ({ id: `i${i}`, v }));
  const linked = values.map((v, i) => ({ id: `l${i}`, event: `e${i % 4 === 0 ? 0 : 1 + (i % 3)}`, v }));
  const a = bootstrapCI(indep, (x) => x.v);
  const b = bootstrapCI(linked, (x) => x.v, { minClusters: 2 });
  assert.ok(a[0] < 0.125 && a[1] > 0.125, "l'intervalle contient la moyenne");
  assert.ok(b[1] - b[0] > a[1] - a[0], "regrouper par événement élargit l'intervalle");
  assert.equal(bootstrapCI(linked, (x) => x.v), null, "trop peu d'événements : pas d'intervalle");
});

test("marge d'erreur reproductible", () => {
  const xs = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, v: Math.sin(i) }));
  assert.deepEqual(bootstrapCI(xs, (x) => x.v), bootstrapCI(xs, (x) => x.v));
});
