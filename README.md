# Polymarket Viewer

Site web en **lecture seule** pour consulter les marchés de [Polymarket](https://polymarket.com) : probabilités, volumes, historiques de prix. Aucun compte, aucun wallet, **aucun pari possible**. On regarde les cotes, c'est tout.

## Fonctionnalités

- Liste des marchés ouverts : recherche, catégories (Politique, Sport, Crypto…) et 6 tris (volume 24 h, volume total, liquidité, plus fortes variations, fin la plus proche, plus récents)
- Probabilités en %, variation sur 24 h et mini-graphique 7 jours sur chaque carte
- Fiche détaillée : graphique interactif (1 J / 1 S / 1 M / Max), toutes les issues (cliquer sur une issue affiche son historique), règles de résolution
- Favoris ★ enregistrés dans le navigateur
- Thème clair / sombre, adapté au mobile
- Liens directs vers un marché (`…/#marche/slug-du-marche`)

### Alertes : paris suspects

L'onglet **Alertes** liste les paris qui ressemblent à ceux d'un initié : ceux de 2 000 $ et plus, et dès 300 $ sur les **petits marchés** (liquidité < 25 000 $ ou volume < 50 000 $), où un pari modeste peut déjà faire bouger le prix. Chaque pari reçoit un score sur 100 :

| Signal | Points |
| --- | --- |
| Wallet créé il y a moins de 24 h / 7 jours / 30 jours | 35 / 25 / 10 |
| 1 seul marché joué / 3 ou moins / 10 ou moins | 20 / 15 / 5 |
| Mise sur une issue à ≤ 10 % / ≤ 25 % / ≤ 40 % | 20 / 12 / 5 |
| Mise ≥ 50 000 $ / ≥ 10 000 $ / ≥ 5 000 $ | 20 / 12 / 6 |
| D'autres wallets récents ont misé pareil en moins de 2 h | 10 à 15 |
| Pari placé moins de 7 jours avant l'échéance | 5 |
| Mise ≥ 50 % / ≥ 20 % / ≥ 10 % de la liquidité du marché | 25 / 15 / 8 |

Seuls les paris à 35 points ou plus sont gardés (7 jours d'historique). Pour chaque alerte, le site montre aussi l'évolution du prix depuis le pari : c'est le meilleur moyen de voir si ces wallets avaient vraiment une info. Un score élevé n'est **pas une preuve** de délit d'initié.

### Modèle crypto

Pour les marchés « BTC/ETH au-dessus de X $ le … », « entre A et B $ », « atteint / chute à X $ avant le … », l'onglet **Modèle crypto** calcule une probabilité à partir de la volatilité implicite des options **Deribit** (surface interpolée selon le prix d'exercice et l'échéance, modèle log-normal ; formule de réflexion pour les marchés « atteint ») et la compare au prix Polymarket. Un écart d'au moins 5 points est signalé. Si Deribit ne répond pas, le modèle utilise la volatilité réalisée sur 30 jours (Coinbase).

Le site fige aussi, pour chaque marché, les deux probabilités 24 h avant l'échéance puis note le résultat : la section « Est-ce que le modèle a raison ? » compare les scores de Brier et le résultat qu'aurait donné le suivi de tous les signaux.

### Backtest

L'onglet **Backtest** rejoue le passé, une fois par jour (ou à la demande : *Actions → Publier le site → Run workflow → Recalculer le backtest*) :

1. **Calibration de Polymarket** sur ~2 800 marchés terminés des 6 derniers mois, tirés à parts égales dans quatre tranches de volume (< 10 k$, 10-100 k$, 100 k$-1 M$, > 1 M$) pour ne pas ignorer les petits marchés : pour chaque tranche de prix la veille de la fin (5-10 %, 10-20 %…), la fréquence réelle de l'issue et le gain qu'aurait donné l'achat systématique de « Oui » ou de « Non », par catégorie et par taille de marché.
2. **Modèle crypto rejoué** sur les marchés BTC/ETH terminés des 4 derniers mois, avec le prix Deribit et l'indice de volatilité DVOL de l'époque, avec un détail par taille de marché.

Tous les prix sont pris 24 h avant la fin (aucune information future), et chaque résultat est recalculé sur deux moitiés tirées au sort : un effet qui n'apparaît que dans une moitié est traité comme du hasard.

### Portefeuille fictif

Dans chaque fiche de marché, le bloc **Ma prédiction** permet d'acheter des parts avec 1 000 $ fictifs, au prix du marché. Une part vaut 1 $ si l'issue gagne, 0 sinon. L'onglet **Mon portefeuille** suit la valeur des prédictions, les règle automatiquement quand le marché se termine, et compare ton taux de réussite à celui attendu par le marché (« est-ce que tu bats le marché ? »). Les données restent dans le navigateur (export / import en JSON).

## Comment ça marche

```
navigateur ──► API Polymarket (direct)          ✔ badge « En direct »
     │
     └─ si injoignable ──► data/events.json      ✔ badge « Instantané »
                           (généré toutes les 15 min par la GitHub Action)
```

La GitHub Action génère cinq fichiers à chaque passage :

- `data/events.json` : marchés ouverts et historiques 7 jours ;
- `data/markets.json` : dernier prix et résultat final des marchés déjà vus (pour régler le portefeuille) ;
- `data/alerts.json` : paris suspects des 7 derniers jours ;
- `data/crypto.json` : modèle crypto et historique de ses prédictions ;
- `data/backtest.json` : résultats du backtest (recalculés une fois par jour).

Comme une Action n'a pas de mémoire, chaque passage relit l'état précédent depuis le site publié.

Si ta connexion bloque les domaines Polymarket, le site affiche automatiquement le dernier instantané récupéré par GitHub (en général moins de 30 minutes de retard : GitHub lance parfois les tâches planifiées en retard).

## Mise en ligne (GitHub Pages)

1. Fusionner le code sur la branche par défaut du dépôt.
2. Dans **Settings → Pages**, choisir **Source : GitHub Actions**.
3. Lancer une première fois **Actions → Publier le site → Run workflow**.

Le site est ensuite disponible sur `https://<ton-pseudo>.github.io/Polymarket/` et se met à jour tout seul toutes les 15 minutes.

> GitHub Pages est gratuit pour les dépôts **publics**. Pour un dépôt privé, il faut un compte GitHub Pro.

## En local

```bash
npm run snapshot   # récupère les marchés (nécessite l'accès à l'API)
npm run alerts     # détecte les paris suspects
npm run crypto     # modèle crypto
npm run backtest   # backtest (BACKTEST_FORCE=true pour forcer)
npm test           # tests unitaires
npm start          # sert le dossier site/ sur http://localhost:3000
```

## Structure

| Fichier | Rôle |
| --- | --- |
| `site/index.html`, `site/css/style.css` | Page et styles |
| `site/js/app.js` | Interface : onglets, filtres, cartes, fiche détaillée |
| `site/js/view-alerts.js`, `site/js/view-portfolio.js` | Onglets Alertes et Portefeuille |
| `site/js/portfolio.js` | Logique du portefeuille fictif |
| `site/js/format.js` | Formatage (montants, %, dates) |
| `site/js/api.js` | Chargement des données (direct ou instantané) |
| `site/js/normalize.js` | Mise en forme des données de l'API (partagée navigateur / Node) |
| `site/js/chart.js` | Graphiques SVG sans dépendance |
| `scripts/build-snapshot.mjs` | Génère `events.json` et `markets.json` |
| `scripts/build-alerts.mjs` | Détecte les paris suspects → `alerts.json` |
| `scripts/crypto-model.mjs` | Maths du modèle crypto (+ tests `npm test`) |
| `scripts/build-crypto.mjs` | Modèle crypto → `crypto.json` |
| `site/js/view-crypto.js` | Onglet Modèle crypto |
| `scripts/backtest-lib.mjs` | Calculs du backtest (+ tests) |
| `scripts/build-backtest.mjs` | Backtest → `backtest.json` |
| `site/js/view-backtest.js` | Onglet Backtest |
| `.github/workflows/pages.yml` | Instantané + déploiement toutes les 15 min |

Les probabilités sont les prix du marché, pas des certitudes. Données publiques de Polymarket, à titre informatif uniquement.
