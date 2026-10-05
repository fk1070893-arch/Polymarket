# Polymarket Viewer

Site web en **lecture seule** pour consulter les marchés de [Polymarket](https://polymarket.com) : probabilités, volumes, historiques de prix. Aucun compte, aucun wallet, **aucun pari possible**. On regarde les cotes, c'est tout.

## Fonctionnalités

- Liste des marchés ouverts : recherche, catégories (Politique, Sport, Crypto…) et 6 tris (volume 24 h, volume total, liquidité, plus fortes variations, fin la plus proche, plus récents)
- Probabilités en %, variation sur 24 h et mini-graphique 7 jours sur chaque carte
- Fiche détaillée : graphique interactif (1 J / 1 S / 1 M / Max), toutes les issues (cliquer sur une issue affiche son historique), règles de résolution
- Favoris ★ enregistrés dans le navigateur
- Thème clair / sombre, adapté au mobile
- Liens directs vers un marché (`…/#slug-du-marche`)

## Comment ça marche

```
navigateur ──► API Polymarket (direct)          ✔ badge « En direct »
     │
     └─ si injoignable ──► data/events.json      ✔ badge « Instantané »
                           (généré toutes les 5 min par la GitHub Action)
```

Si ta connexion bloque les domaines Polymarket, le site affiche automatiquement le dernier instantané récupéré par GitHub (en général moins de 15 minutes de retard : GitHub lance parfois les tâches planifiées en retard).

## Mise en ligne (GitHub Pages)

1. Fusionner le code sur la branche par défaut du dépôt.
2. Dans **Settings → Pages**, choisir **Source : GitHub Actions**.
3. Lancer une première fois **Actions → Publier le site → Run workflow**.

Le site est ensuite disponible sur `https://<ton-pseudo>.github.io/Polymarket/` et se met à jour tout seul toutes les 5 minutes.

> GitHub Pages est gratuit pour les dépôts **publics**. Pour un dépôt privé, il faut un compte GitHub Pro.

## En local

```bash
npm run snapshot   # récupère les données (nécessite l'accès à l'API)
npm start          # sert le dossier site/ sur http://localhost:3000
```

## Structure

| Fichier | Rôle |
| --- | --- |
| `site/index.html`, `site/css/style.css` | Page et styles |
| `site/js/app.js` | Interface : filtres, cartes, fiche détaillée |
| `site/js/api.js` | Chargement des données (direct ou instantané) |
| `site/js/normalize.js` | Mise en forme des données de l'API (partagée navigateur / Node) |
| `site/js/chart.js` | Graphiques SVG sans dépendance |
| `scripts/build-snapshot.mjs` | Génère `site/data/events.json` |
| `.github/workflows/pages.yml` | Instantané + déploiement toutes les 5 min |

Les probabilités sont les prix du marché, pas des certitudes. Données publiques de Polymarket, à titre informatif uniquement.
