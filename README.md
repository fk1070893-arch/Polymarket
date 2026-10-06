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

Pour les marchés « BTC/ETH au-dessus de X $ le … », « entre A et B $ », « atteint / chute à X $ avant le … », l'onglet **Modèle crypto** calcule une probabilité à partir de la volatilité implicite des options **Deribit** (surface interpolée selon le prix d'exercice et l'échéance, modèle log-normal ; formule de réflexion pour les marchés « atteint ») et la compare au prix Polymarket. Le prix actuel vient de **Binance** (BTCUSDT), sur lequel se règlent la plupart des marchés crypto de Polymarket. Les écarts sont présentés comme une comparaison : le backtest ne montre pas d'avantage au modèle. Si Deribit ne répond pas, le modèle utilise la volatilité réalisée sur 30 jours (Coinbase).

Le site fige aussi, pour chaque marché, les deux probabilités 24 h avant l'échéance puis note le résultat : la section « Est-ce que le modèle a raison ? » compare les scores de Brier et le résultat qu'aurait donné le suivi de tous les signaux.

### Backtest

L'onglet **Backtest** rejoue le passé, une fois par semaine sur un large échantillon (ou à la demande : *Actions → Publier le site → Run workflow → Recalculer le backtest*) :

1. **Calibration de Polymarket** sur ~2 800 marchés terminés des 6 derniers mois, tirés à parts égales dans quatre tranches de volume (< 10 k$, 10-100 k$, 100 k$-1 M$, > 1 M$) pour ne pas ignorer les petits marchés : pour chaque tranche de prix la veille de la fin (5-10 %, 10-20 %…), la fréquence réelle de l'issue et le gain qu'aurait donné l'achat systématique de « Oui » ou de « Non », par catégorie et par taille de marché.
2. **Modèle crypto rejoué** sur les marchés BTC/ETH terminés des 4 derniers mois, avec le prix Deribit et l'indice de volatilité DVOL de l'époque, avec un détail par taille de marché.

Tous les prix sont pris 24 h avant la fin (aucune information future), et chaque résultat est recalculé sur deux moitiés tirées au sort : un effet qui n'apparaît que dans une moitié est traité comme du hasard.

### Ce que le backtest a trouvé (6 octobre 2026)

- **Modèle crypto :** une fois le test rendu honnête (statistiques par événement, prix pris 24 h avant la fin *prévue*), il fait jeu égal avec Polymarket (Brier 0,033 contre 0,033) et ses signaux n'ont pas d'avantage prouvé. L'onglet Modèle crypto présente donc ses écarts comme une simple comparaison.
- **Favoris en sport :** quand la première issue d'un marché sport est cotée 70-80 % la veille, elle ne gagne que 65 % du temps. Parier contre aurait rapporté +34 % par pari, marge [+6 % ; +62 %], positif dans les deux moitiés, et la même tendance apparaît de 60 % à 90 %.

### Stratégies testées en direct

L'onglet **Stratégies** met les idées à l'épreuve sur les marchés en cours, que le backtest n'a jamais vus. Chaque pari est fictif (1 $), enregistré au **prix réellement payé** (meilleur prix vendeur du moment, pas le prix affiché), puis réglé à la clôture ; le gain au prix affiché est gardé à côté pour comparer. Il faut 50 à 100 paris réglés avant de conclure.

**Prix réel.** Le prix enregistré est celui qu'on aurait vraiment payé pour une mise de 100 $ : on descend dans le carnet d'ordres (glissement quand les meilleures offres ne suffisent pas), puis on ajoute les frais preneur de Polymarket quand le marché en a (taux × (p × (1 − p))^exposant par part, avec le taux et l'exposant de la catégorie donnés par le champ `feeSchedule` du marché ; `scripts/fee-lib.mjs`, `realCost` dans `scripts/paper.mjs`). Les anomalies de prix, les comparaisons Kalshi/bookmakers, le backtest « au prix payé » et le bilan des alertes (frais à l'achat et à la revente) comptent aussi ces frais. Non comptés : le réseau Polygon (payé par Polymarket), le dépôt et le retrait d'argent, et l'effet de nos propres achats sur les prix suivants. Les paris enregistrés avant ce changement gardent le meilleur prix vendeur.

Autres règles de Polymarket prises en compte partout : un marché annulé ou ambigu est réglé 50/50 (0,50 $ par part) ; le portefeuille fictif achète et revend dans le carnet d'ordres (glissement et frais compris, valeur des positions au prix de revente) ; le bilan des alertes prend le prix du carnet lu dans la demi-heure après l'alerte quand le test de copie ne l'a pas suivie ; le backtest applique les frais d'aujourd'hui de la catégorie aux marchés terminés avant leur mise en place ; le suivi du modèle crypto paie le prix vendeur et les frais.

Sous le bilan de chaque test : l'argent bloqué jusqu'à la fin des marchés (durée moyenne et rendement ramené à un an), la récompense de détention de Polymarket (environ 4 %/an sur certains marchés politiques et géopolitiques, comptée quand le marché l'indique), et le gain par pari avec une mise de 500, 1 000 ou 5 000 $ (notre propre achat vide les meilleures offres : prix lu dans le carnet au moment du pari). Le bilan des alertes revend toutes les parts d'une mise de 100 $ aux acheteurs du carnet (glissement à la revente compris).

- **Contre les favoris sport** (`scripts/build-strategy.mjs`) : marchés sport à deux issues, première issue cotée 60-90 % → 1 $ sur l'autre. Résultat principal sur les marchés finis avec au moins 1 000 $ de volume, comme dans le backtest. Trois variantes suivies côte à côte : **le moment** (24 h ou 2-6 h avant la fin), **un prix plafond** (« à bon prix » : « Non » acheté au moins 3 ¢ sous sa valeur d'après le backtest sport) et **l'avis des bookmakers** (le favori est-il plus cher sur Polymarket que chez Pinnacle ?).
- **Copier les paris suspects** (`scripts/build-copy.mjs`) : à chaque alerte de score 50+, 1 $ sur la même issue au prix du moment où le site la voit. Le prix payé par le wallet suspect est noté pour mesurer ce que coûte le temps de réaction.
- **Sport contre bookmakers** (`scripts/build-odds.mjs`) : les cotes des bookmakers (Pinnacle en priorité, via The Odds API), sans leur marge, comparées au prix d'achat Polymarket. Écart d'au moins 3 pts dans les 24 h avant le match → 1 $ fictif. La précision des deux (score de Brier) est aussi suivie. **Activation :** créer une clé gratuite sur the-odds-api.com, puis l'ajouter au dépôt dans *Settings → Secrets and variables → Actions → New repository secret*, nom `ODDS_API_KEY`. La clé n'apparaît jamais dans le code, les logs ou le site ; le quota gratuit (500 requêtes / mois) est réparti automatiquement sur le mois.
- **Contre les marchés tout neufs** (`scripts/build-fresh.mjs`) : le backtest trouve que les marchés affichés 40-60 % six heures après leur ouverture se réalisent bien moins souvent. Soupçon de prix « fantôme » (50 % par défaut faute d'échanges) : le test note le vrai prix de vente du « Non » dans le carnet d'ordres. **Verdict dès le premier passage : prix fantôme** (sur 3 483 marchés, aucun vendeur pour 1 068, et un « Non » à 99 ¢ en médiane pour les autres). Le test continue seulement sur les marchés où le « Non » se vend vraiment 70 ¢ ou moins.
- **Kalshi et Metaculus** (`scripts/build-cross.mjs`) : les mêmes questions sur Kalshi (site de paris régulé aux États-Unis, API publique) et Metaculus (prévisions d'une communauté de prévisionnistes). Les questions sont rapprochées par leurs mots importants (`scripts/match-lib.mjs`), en écartant les paires dont les nombres, les années ou le sens diffèrent. Si Polymarket vend une issue au moins 5 pts moins cher que la probabilité Kalshi : 1 $ fictif. Les « anomalies entre sites » (Oui d'un côté + Non de l'autre pour moins de 1 $, frais Kalshi compris) sont listées, à vérifier : les règles de résolution diffèrent parfois. Metaculus sert de second avis, sans pari ; son API demande une clé gratuite (compte Metaculus → paramètres → accès API), à enregistrer dans le secret GitHub `METACULUS_TOKEN`. Vérifié une fois par heure. En octobre 2026, l'API renvoie les questions mais pas les prévisions de la communauté : la comparaison reste vide tant que Metaculus ne les publie pas.
- **Anomalies de prix** (`scripts/build-arbs.mjs`) : sur **tous** les événements ouverts (pas seulement les plus actifs : c'est sur les petits, peu surveillés, que les écarts durent), dans les événements où une seule issue peut gagner, les « Oui » doivent valoir 100 % au total. Si la somme s'en écarte, acheter toutes les issues (ou tous les « Non ») rapporte un gain sûr ; le site vérifie dans les carnets d'ordres combien on aurait vraiment pu acheter.

En haut de l'onglet, un **tableau de bord** résume chaque stratégie : statut (en test, prometteuse, rejetée), gain par pari et courbe des gains cumulés. Les idées abandonnées sont listées à part, avec la raison.

### Alertes Telegram (facultatif)

`scripts/build-notify.mjs` envoie un message Telegram à chaque nouveau pari fictif intéressant (favori « à bon prix », écart avec les bookmakers, pari suspect de score 70+, anomalie de prix). Pour l'activer :

1. Dans Telegram, écrire à **@BotFather**, envoyer `/newbot`, choisir un nom : il donne un **jeton** (token).
2. Écrire à **@userinfobot** : il répond avec ton **identifiant** (un nombre).
3. Envoyer un premier message (n'importe lequel) à ton nouveau bot, sinon il n'a pas le droit de t'écrire.
4. Dans le dépôt GitHub : *Settings → Secrets and variables → Actions*, ajouter `TELEGRAM_BOT_TOKEN` (le jeton) et `TELEGRAM_CHAT_ID` (l'identifiant).

Le jeton et l'identifiant restent privés : ils n'apparaissent ni dans le code, ni dans les logs, ni sur le site.

Chaque soir à 20 h (heure de Paris), un **bilan** résume la journée de chaque stratégie (paris réglés, gain du jour, total, statut), et un message part quand une stratégie atteint 50 paris réglés (premier verdict). Pour choisir les alertes reçues : *Settings → Secrets and variables → Actions → onglet Variables → New repository variable*, nom `TELEGRAM_TYPES`, valeur parmi `favoris, bookmakers, kalshi, suspects, neufs, anomalies, bilan` séparés par des virgules (sans cette variable, tout est envoyé).

### Études de niche (onglet Backtest)

- **Sport, moment du pari** : le biais sur les favoris rejoué 24 h, 6 h et 2 h avant la fin.
- **« Avant telle date »** : marchés « X arrivera-t-il avant le … ? », calibrés 7, 3 et 1 jour avant l'échéance (le « Oui » garde-t-il un prix d'espoir ?).
- **Marchés tout neufs** : calibration 6 h et 24 h après l'ouverture, quand il y a encore peu de traders.
- **Crypto « Up or Down »** (15 min et 1 h) : à mi-fenêtre, probabilité de finir en hausse calculée à partir du prix d'ouverture, du prix du moment (bougies minute Deribit) et de la volatilité DVOL, comparée au prix Polymarket.

Le comparateur bookmakers couvre aussi les tournois ATP/WTA en cours et des ligues de foot secondaires (Eredivisie, Liga Portugal, MLS, Brésil, Mexique, Turquie).

Le backtest compte lui aussi l'écart achat-vente : il est mesuré sur les marchés ouverts de même taille et ajouté au prix de la veille.

### Portefeuille fictif

Dans chaque fiche de marché, le bloc **Ma prédiction** permet d'acheter des parts avec 5 000 $ fictifs, au prix du marché. Une part vaut 1 $ si l'issue gagne, 0 sinon. L'onglet **Mon portefeuille** suit la valeur des prédictions, les règle automatiquement quand le marché se termine, et compare ton taux de réussite à celui attendu par le marché (« est-ce que tu bats le marché ? »). Les données restent dans le navigateur (export / import en JSON).

## Comment ça marche

```
navigateur ──► API Polymarket (direct)          ✔ badge « En direct »
     │
     └─ si injoignable ──► data/events.json      ✔ badge « Instantané »
                           (généré toutes les 5 min par la GitHub Action) 
```

La GitHub Action génère six fichiers à chaque passage :

- `data/events.json` : marchés ouverts et historiques 7 jours ;
- `data/markets.json` : dernier prix et résultat final des marchés déjà vus (pour régler le portefeuille) ;
- `data/alerts.json` : paris suspects des 7 derniers jours ;
- `data/crypto.json` : modèle crypto et historique de ses prédictions ;
- `data/backtest.json` : résultats du backtest (recalculés une fois par semaine) ;
- `data/strategy.json` : paris fictifs du test en direct de la stratégie.

Comme une Action n'a pas de mémoire, chaque passage relit l'état précédent depuis le site publié.

Si ta connexion bloque les domaines Polymarket, le site affiche automatiquement le dernier instantané récupéré par GitHub (en général moins de 30 minutes de retard : GitHub lance parfois les tâches planifiées en retard).

## Mise en ligne (GitHub Pages)

1. Fusionner le code sur la branche par défaut du dépôt.
2. Dans **Settings → Pages**, choisir **Source : GitHub Actions**.
3. Lancer une première fois **Actions → Publier le site → Run workflow**.

Le site est ensuite disponible sur `https://<ton-pseudo>.github.io/Polymarket/` et se met à jour tout seul toutes les 5 minutes (GitHub peut retarder un passage de quelques minutes). À la fin de chaque passage, les paris suspects sont relus toutes les minutes (et copiés au prix du moment) jusqu'au passage suivant. Une page ouverte recharge les prix toutes les 30 secondes.

> GitHub Pages est gratuit pour les dépôts **publics**. Pour un dépôt privé, il faut un compte GitHub Pro.

## Autres onglets

- **Alertes, « Si on avait suivi toutes les alertes »** (`scripts/build-alerts-review.mjs`) : sur les dernières 24 h ou les 7 derniers jours, ce qu'aurait donné une mise fixe sur chaque alerte (réglable) : gain réel sur les marchés terminés, valeur si on revendait maintenant pour les autres, détail par score. Prix d'achat : celui obtenu par le test de copie quand il existe, sinon celui du wallet suspect (cas le plus favorable). Filtres : score minimum (50+, 60+, 70+…), prix, mise du wallet, catégorie, et « seulement si assez de parts à vendre pour ma mise ». Le site essaie aussi toutes les combinaisons et montre les meilleures, avec le résultat du même filtre sur l'autre période pour repérer la chance. Parts disponibles : la première fois que le site voit une alerte, il lit le carnet d'ordres (parts au meilleur prix, au prix du wallet ou moins cher, et jusqu'à 5 ¢ au-dessus).
- **Radar** : tous les signaux du moment sur une seule page (anomalies de prix, favoris sport à bon prix, écarts avec les bookmakers et Kalshi, paris suspects, marchés neufs à vrai prix, modèle crypto), chacun avec le statut de sa stratégie d'après les tests en direct.
- **Fiche d'un marché** : un bloc « Ce que le site sait sur ce marché » réunit les cotes des bookmakers, le prix Kalshi, le modèle crypto, une éventuelle anomalie et les paris fictifs en cours des tests.
- **Calendrier** (`scripts/build-calendar.mjs`) : les événements les plus suivis qui se terminent dans les 7 jours, et les résultats des dernières 48 h.
- **Traders** (`scripts/build-leaders.mjs`) : les wallets les plus rentables de la semaine et du mois, leurs derniers paris ; « Suivre » garde un trader en haut de la liste (choix enregistré dans le navigateur). Mis à jour une fois par heure.
- **Mon portefeuille** : tes prédictions comparées aux stratégies automatiques (gain pour 1 $ misé).
- **Comprendre** : les notions du site expliquées simplement.

**Sur téléphone**, le site s'installe comme une application (menu du navigateur → « Ajouter à l'écran d'accueil ») et reste consultable hors connexion avec les dernières données chargées (`site/sw.js`, `site/manifest.webmanifest`).

## Fiabilité

- **Un seul passage à la fois** (manuel ou automatique) : deux passages simultanés reliraient la même mémoire et le second effacerait les paris du premier.
- **Mémoire des tests dans la branche `etat`** du dépôt : récupérée au début de chaque passage, renvoyée à la fin même si une étape ou la publication échoue. Elle ne contient que l'état le plus récent (un seul commit remplacé à chaque fois, pour que le dépôt ne grossisse pas). Si la branche existe mais ne se lit pas, le passage s'arrête au lieu de repartir de zéro.
- **Une seule lecture de Polymarket par passage** (`scripts/build-universe.mjs`, environ 20 000 événements) partagée par les étapes suivantes ; si elle échoue, chaque étape relit l'API elle-même.

## En local

```bash
npm run snapshot   # récupère les marchés (nécessite l'accès à l'API)
npm run alerts     # détecte les paris suspects
npm run crypto     # modèle crypto
npm run backtest   # backtest (BACKTEST_FORCE=true pour forcer)
npm run strategy   # test en direct : contre les favoris sport
npm run copy       # test en direct : copier les alertes (après alerts)
npm run arbs       # anomalies de prix
npm run odds       # bookmakers (ODDS_API_KEY=... pour activer)
npm run fresh      # test en direct : marchés tout neufs
npm run notify     # alertes Telegram (TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...)
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
| `site/js/view-strategies.js` | Onglet Stratégies (tests en direct, anomalies) |
| `scripts/paper.mjs` | Paris fictifs : prix payé, règlement, statistiques |
| `scripts/build-strategy.mjs` | Contre les favoris sport → `strategy.json` |
| `scripts/build-copy.mjs` | Copier les alertes → `copy.json` |
| `scripts/build-fresh.mjs` | Contre les marchés tout neufs → `fresh.json` |
| `scripts/build-notify.mjs` | Alertes Telegram |
| `scripts/match-lib.mjs`, `scripts/build-cross.mjs` | Kalshi et Metaculus → `cross.json` |
| `scripts/lib.mjs` | Outils communs ; chaque test en direct publie un résumé léger (`x.json`, lu par la page) et son état complet (`x-state.json`, relu par le script) |
| `scripts/odds-lib.mjs`, `scripts/build-odds.mjs` | Bookmakers → `odds.json` |
| `scripts/arb-lib.mjs`, `scripts/build-arbs.mjs` | Anomalies de prix → `arbs.json` |
| `.github/workflows/pages.yml` | Instantané + déploiement toutes les 5 min |

Les probabilités sont les prix du marché, pas des certitudes. Données publiques de Polymarket, à titre informatif uniquement.
