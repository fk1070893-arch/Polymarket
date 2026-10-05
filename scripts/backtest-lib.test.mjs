import { test } from "node:test";
import assert from "node:assert/strict";
import { brier, calibration, followSignals, groupOf, half, parseTime, roiNo, roiYes } from "./backtest-lib.mjs";

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
