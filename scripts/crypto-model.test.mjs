import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSurface,
  modelProbability,
  normCdf,
  parseCryptoQuestion,
  parseDeribitInstrument,
  probAbove,
  probBetween,
  probTouch,
  realizedVol,
  surfaceVol,
} from "./crypto-model.mjs";

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("loi normale", () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.975, 1e-4);
  close(normCdf(-1.96), 0.025, 1e-4);
});

test("probabilité au-dessus d'un seuil", () => {
  // Seuil = prix actuel : un peu moins de 50 % (dérive -σ²/2)
  const p = probAbove(100, 100, 0.5, 0.25);
  assert.ok(p < 0.5 && p > 0.45);
  // Très loin au-dessus : presque 0 ; très loin en dessous : presque 1
  assert.ok(probAbove(100, 300, 0.5, 0.05) < 0.001);
  assert.ok(probAbove(100, 30, 0.5, 0.05) > 0.999);
  // Échéance passée
  assert.equal(probAbove(100, 90, 0.5, 0), 1);
});

test("entre deux seuils = différence des probabilités", () => {
  const p = probBetween(100, 95, 105, 0.6, 0.02);
  close(p, probAbove(100, 95, 0.6, 0.02) - probAbove(100, 105, 0.6, 0.02), 1e-12);
});

test("toucher un seuil est plus probable que finir au-dessus", () => {
  const above = probAbove(100, 120, 0.6, 0.1);
  const touch = probTouch(100, 120, 0.6, 0.1);
  assert.ok(touch > above);
  // Principe de réflexion : environ 2× P(finir au-dessus), à la dérive près
  assert.ok(touch < 2.2 * above && touch > 1.8 * above);
  // Barrière basse
  const down = probTouch(100, 80, 0.6, 0.1);
  assert.ok(down > 1 - probAbove(100, 80, 0.6, 0.1));
  // Déjà au-delà de la barrière dans le sens demandé
  assert.equal(probTouch(100, 90, 0.6, 0.1, "up"), 1);
  assert.equal(probTouch(100, 110, 0.6, 0.1, "down"), 1);
  // Direction déduite : 90 sous le prix actuel = chute
  close(probTouch(100, 90, 0.6, 0.1), probTouch(100, 90, 0.6, 0.1, "down"), 1e-12);
});

test("toucher : simulation de Monte-Carlo", () => {
  // Vérifie la formule contre une simulation (graine fixe)
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const sigma = 0.7;
  const tau = 30 / 365;
  const steps = 300;
  const dt = tau / steps;
  let hits = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    let x = 0;
    for (let s = 0; s < steps; s++) {
      x += (-sigma * sigma / 2) * dt + sigma * Math.sqrt(dt) * gauss();
      if (x >= Math.log(1.15)) {
        hits++;
        break;
      }
    }
  }
  // La simulation discrète rate des franchissements : elle sous-estime un peu
  const p = probTouch(100, 115, sigma, tau);
  assert.ok(Math.abs(hits / N - p) < 0.04, `simulé ${hits / N}, formule ${p}`);
});

test("lecture des instruments Deribit", () => {
  const i = parseDeribitInstrument("BTC-10OCT26-120000-C");
  assert.equal(i.asset, "BTC");
  assert.equal(i.strike, 120000);
  assert.equal(new Date(i.expiry).toISOString(), "2026-10-10T08:00:00.000Z");
  assert.equal(parseDeribitInstrument("BTC-PERPETUAL"), null);
});

test("surface de volatilité", () => {
  const now = Date.UTC(2026, 9, 5);
  const rows = [];
  for (const [d, iv] of [["10OCT26", 50], ["31OCT26", 60]]) {
    for (const k of [80000, 100000, 120000]) {
      rows.push({ instrument_name: `BTC-${d}-${k}-C`, mark_iv: iv + (k === 100000 ? 0 : 10) });
      rows.push({ instrument_name: `BTC-${d}-${k}-P`, mark_iv: iv + (k === 100000 ? 0 : 10) });
    }
  }
  const s = buildSurface(rows, 100000);
  assert.equal(s.expiries.length, 2);
  // À la monnaie, première échéance
  close(surfaceVol(s, 100000, Date.UTC(2026, 9, 10, 8), now), 0.5, 1e-9);
  // Sourire : plus de volatilité loin de la monnaie
  assert.ok(surfaceVol(s, 120000, Date.UTC(2026, 9, 10, 8), now) > 0.5);
  // Entre deux échéances : entre les deux volatilités
  const mid = surfaceVol(s, 100000, Date.UTC(2026, 9, 20), now);
  assert.ok(mid > 0.5 && mid < 0.6);
});

test("volatilité réalisée", () => {
  const closes = Array.from({ length: 31 }, (_, i) => 100 * Math.exp(0.02 * (i % 2 ? 1 : -1)));
  const v = realizedVol(closes);
  assert.ok(v > 0.5 && v < 1);
});

test("lecture des questions Polymarket", () => {
  assert.deepEqual(parseCryptoQuestion("Will the price of Bitcoin be above $118,000 on October 10?"), {
    asset: "BTC",
    kind: "above",
    strike: 118000,
  });
  assert.deepEqual(parseCryptoQuestion("Will the price of Ethereum be less than $3,800 on October 10?"), {
    asset: "ETH",
    kind: "below",
    strike: 3800,
  });
  assert.deepEqual(parseCryptoQuestion("Will the price of Bitcoin be between $116,000 and $118,000 on October 10?"), {
    asset: "BTC",
    kind: "between",
    low: 116000,
    high: 118000,
  });
  assert.deepEqual(parseCryptoQuestion("Will Bitcoin reach $150k in October?"), { asset: "BTC", kind: "touch", strike: 150000, dir: "up" });
  assert.deepEqual(parseCryptoQuestion("Will Ethereum dip to $3,000 in October?"), { asset: "ETH", kind: "touch", strike: 3000, dir: "down" });
  assert.deepEqual(parseCryptoQuestion("Will Bitcoin hit $90k by December 31?"), { asset: "BTC", kind: "touch", strike: 90000, dir: null });
  assert.deepEqual(parseCryptoQuestion("Will Bitcoin dip below $100,000 in October?"), { asset: "BTC", kind: "touch", strike: 100000, dir: "down" });
  assert.equal(parseCryptoQuestion("Will a Bitcoin ETF see $1B inflows?"), null);
  assert.equal(parseCryptoQuestion("Bitcoin Up or Down - October 5, 3PM ET"), null);
  assert.equal(parseCryptoQuestion("MicroStrategy holds more than 700k BTC?"), null);
  assert.equal(parseCryptoQuestion("Will Trump win?"), null);
});

test("probabilité du modèle selon le type de question", () => {
  const ctx = { spot: 100000, vol: () => 0.5, dateMs: Date.UTC(2026, 9, 10), nowMs: Date.UTC(2026, 9, 5) };
  const above = modelProbability({ kind: "above", strike: 105000 }, ctx);
  const below = modelProbability({ kind: "below", strike: 105000 }, ctx);
  close(above + below, 1, 1e-12);
  const touch = modelProbability({ kind: "touch", strike: 105000 }, ctx);
  assert.ok(touch > above);
});
