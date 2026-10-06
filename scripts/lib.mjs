// Outils partagés par les scripts lancés dans la GitHub Action.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "data");

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
  await writeData(`${name}-state.json`, state);
  await writeData(`${name}.json`, view);
}
