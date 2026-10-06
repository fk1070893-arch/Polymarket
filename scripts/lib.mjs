// Outils partagés par les scripts lancés dans la GitHub Action.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "data");

// Mémoire des tests d'un passage à l'autre : la GitHub Action la récupère au
// début depuis la branche « etat » du dépôt dans .state/, et l'y renvoie à
// la fin, que la publication du site réussisse ou non. Elle ne dépend donc
// plus du site publié (qui sert seulement de repli, pour la transition).
export const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".state");

// Fichiers publiés qui servent aussi de mémoire au passage suivant
const PERSISTED = new Set(["alerts.json", "arbs.json", "backtest.json", "crypto.json", "markets.json", "odds.json", "notify-state.json"]);

async function readStateFile(name) {
  try {
    return JSON.parse(await readFile(join(STATE_DIR, name), "utf8"));
  } catch {
    return null;
  }
}

async function writeStateFile(name, data) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, name), JSON.stringify(data));
}

export async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

// Exécute fn sur chaque élément avec au plus `limit` appels en parallèle.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// Les Actions n'ont pas de mémoire d'une exécution à l'autre : on relit
// donc l'état précédent depuis le site déjà publié sur GitHub Pages.
export async function loadPrevious(name) {
  const saved = await readStateFile(name);
  if (saved) return saved;
  const base = process.env.PAGES_URL;
  if (!base) return null;
  try {
    const url = `${base.replace(/\/$/, "")}/data/${name}?t=${Date.now()}`;
    return await getJSON(url, 2);
  } catch (err) {
    console.log(`Pas d'état précédent pour ${name} (${err.message})`);
    return null;
  }
}

export async function readData(name) {
  return JSON.parse(await readFile(join(DATA_DIR, name), "utf8"));
}

export async function writeData(name, data) {
  await mkdir(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, name);
  await writeFile(path, JSON.stringify(data));
  if (PERSISTED.has(name)) await writeStateFile(name, data);
  console.log(`Écrit : ${path}`);
}

export const nowSec = () => Math.floor(Date.now() / 1000);

// État complet d'un test en direct (tous les paris, caches…), publié à part
// pour que la page n'ait à charger que le résumé. Repli sur l'ancien fichier
// unique pour reprendre les tests lancés avant la séparation.
export async function loadState(name) {
  return (await loadPrevious(`${name}-state.json`)) ?? (await loadPrevious(`${name}.json`)) ?? null;
}

export async function writeState(name, state, view) {
  // L'état complet reste dans la mémoire (non publié) ; le site n'a que le résumé
  await writeStateFile(`${name}-state.json`, state);
  await writeData(`${name}.json`, view);
}

// État complet écrit plus tôt dans ce même passage (alertes Telegram…)
export async function readState(name) {
  return readStateFile(`${name}-state.json`);
}

// Tous les événements Gamma dont la fin prévue tombe entre `from` et `to`
// (ms). L'API refuse d'aller au-delà d'environ 2 000 résultats par requête :
// on vérifie d'abord si la période en contient plus (une requête d'un seul
// résultat, loin dans la liste) et, si oui, on la coupe en deux. Les pages
// sont lues par 4 en parallèle. `params` : filtres Gamma (active, tag_slug…).
// `deadline` (ms) : au-delà, on s'arrête avec ce qui a été lu.
const GAMMA_EVENTS = "https://gamma-api.polymarket.com/events";
const MAX_OFFSET = 1800;
const PAGE = 100;

function eventsUrl(params, from, to, offset, limit = PAGE) {
  const qs = new URLSearchParams({
    ...params,
    end_date_min: new Date(from).toISOString(),
    end_date_max: new Date(to).toISOString(),
    limit: String(limit),
    offset: String(offset),
  });
  return `${GAMMA_EVENTS}?${qs}`;
}

export async function eventsBetween(params, from, to, { deadline = Infinity, depth = 0 } = {}) {
  if (Date.now() > deadline) return [];
  if (depth < 14 && to - from >= 3600000) {
    const probe = await getJSON(eventsUrl(params, from, to, MAX_OFFSET, 1));
    if (probe.length) {
      const mid = Math.floor(from + (to - from) / 2);
      const opts = { deadline, depth: depth + 1 };
      return [...(await eventsBetween(params, from, mid, opts)), ...(await eventsBetween(params, mid, to, opts))];
    }
  }
  const out = [];
  for (let offset = 0; offset <= MAX_OFFSET; offset += 4 * PAGE) {
    const offsets = [0, 1, 2, 3].map((k) => offset + k * PAGE).filter((o) => o <= MAX_OFFSET);
    const pages = await Promise.all(offsets.map((o) => getJSON(eventsUrl(params, from, to, o))));
    for (const p of pages) out.push(...p);
    if (pages.some((p) => p.length < PAGE)) break;
  }
  return out;
}

// Même chose, sans doublons (un événement à cheval sur deux périodes)
export async function allEventsBetween(params, from, to, opts = {}) {
  const seen = new Map();
  for (const ev of await eventsBetween(params, from, to, opts)) seen.set(String(ev.id), ev);
  return [...seen.values()];
}

// Cache local entre deux étapes d'un même passage (jamais publié : hors de site/)
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");

export async function writeCache(name, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, name), JSON.stringify(data));
}

export async function readCache(name) {
  try {
    return JSON.parse(await readFile(join(CACHE_DIR, name), "utf8"));
  } catch {
    return null;
  }
}

// Événements lus une seule fois en début de passage (build-universe.mjs),
// filtrés par `keep`. null si la lecture n'a pas eu lieu : l'appelant relit
// alors l'API lui-même.
let universe;
export async function universeEvents(keep = () => true) {
  universe ??= (await readCache("universe.json")) ?? false;
  if (!universe?.events) return null;
  return universe.events.filter(keep);
}
