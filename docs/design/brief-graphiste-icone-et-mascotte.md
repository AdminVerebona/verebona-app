# Brief graphique — icône de l'application mobile et mascotte Verebona

Version du 29/10/2026 (chantier 100F). Décisions PO appliquées : **B5** (nouvelle icône mobile, variante
« PRÉPROD », livraison directe aux développeurs) et **C5** (visuels de mascotte, brief établi par les
développeurs avant toute attente de livraison). Les deux livrables suivent **le même circuit** mais
restent **deux commandes distinctes** : lot I (icône) et lot M (mascotte). Mascotte : exigence du
CDC 4 §7.5 ; les emplacements, tailles et poses ci-dessous sont **relevés dans le code actuel** (lot 99),
pas supposés.

Destinataire : le graphiste. Émetteur et interlocuteur technique : l'équipe de développement Verebona.
Validation du concept : le PO (Verebona). Ce document se lit seul ; il ne contient aucun secret.

---

## 0. En bref

| | Lot I — icône de l'application | Lot M — mascotte |
|---|---|---|
| Quoi | Une **nouvelle** icône d'application iOS / Android (production) et sa variante **PRÉPROD** clairement différente | Les **12 poses** de la mascotte utilisées aujourd'hui dans l'application, redessinées **dans les couleurs définitives** (fin de la recoloration provisoire par filtre) |
| Pourquoi | Publication sur l'App Store et Google Play ; les deux applications (« Verebona » et « Verebona Préprod ») sont installées côte à côte sur le même téléphone | Accueil, assistant « Demander à Verebona », page introuvable, exports PDF |
| Livré à | Les développeurs, directement (§ 6) | Les développeurs, directement (§ 6) |
| Ce qui n'est **pas** demandé | Captures d'écran des stores, logo du site public, charte complète | Nouvelles poses non listées, animation image par image |

**À ne pas reprendre** : l'icône actuelle de la PWA (tuile pétrole, cases ivoire, cube cuivre — lot 71H) et
toute maquette ou génération d'icône échangée en cours de discussion sans validation (décision B5).

---

## 1. Ce qu'il faut savoir sur Verebona

- Verebona range **tous les biens** d'un foyer et leurs documents : logement, mais aussi véhicule,
  équipements, objets de valeur, animaux, contrats… L'icône **ne doit pas** représenter seulement
  l'immobilier (pas de maison seule, pas de clé de porte seule).
- Ton : calme, sûr, professionnel, rassurant (« Sérénité »). Pas de dessin enfantin, pas d'effet
  « gadget ».
- Langue : français. L'application est utilisée sur téléphone (capture et ajout de documents, consultation
  rapide) et sur ordinateur.

### 1.1 Charte « Sérénité » (source : `src/app/globals.css`, jetons de marque)

| Rôle | Nom du jeton | Couleur |
|---|---|---|
| Couleur principale (pétrole) | `--vb-petrole` | `#17474D` |
| Pétrole survol / foncé | `--vb-petrole-hover` | `#10383E` |
| Pétrole clair | `--vb-petrole-clair` | `#9FD3CC` |
| Accent (cuivre) | `--vb-cuivre` | `#D66B53` |
| Cuivre texte (foncé) | `--vb-cuivre-texte` | `#AA4E38` |
| Fond clair (ivoire) | `--vb-ivoire` | `#F8F6F1` |
| Ivoire 2 | `--vb-ivoire-2` | `#F2F0EA` |
| Brume | `--vb-brume` | `#E2EBE9` |
| Encre (texte, thème sombre) | `--vb-encre` / `--vb-encre-2` | `#26353B` / `#1B2529` |
| Gris | `--vb-gris` | `#52636A` |
| Bulle de l'assistant | `--vb-bulle` | `#ECF1EF` |
| Mascotte — lumière | `--vb-mascotte-lumiere` | `#18B8E8` |
| Mascotte — face | `--vb-mascotte-face` | `#08A8D8` |
| Mascotte — ombre | `--vb-mascotte-ombre` | `#0878A8` |

- Typographie : **Figtree** (licence SIL OFL, graisses 400 à 800). L'icône ne contient **aucun texte**
  (sauf la mention de la variante PRÉPROD, § 2.3). Si un lettrage est utilisé dans une planche de
  présentation, il est en Figtree.
- Style : aplats, **sans relief, sans reflet, sans dégradé décoratif, sans ombre portée**. Rayons arrondis
  doux dans l'interface (12 à 22 px), mais **l'icône est livrée en carré plein, sans coins arrondis**
  (les systèmes appliquent leur propre masque).
- Contrastes mesurés (WCAG) : ivoire sur pétrole **9,5:1** ; cuivre sur pétrole **3,0:1** (limite : le
  cuivre sert d'accent, jamais seul porteur de la forme) ; cyan « face » `#08A8D8` sur ivoire **2,6:1**
  (insuffisant seul : voir § 3.4).
- Thèmes de l'application : **clair** (fond de page ivoire `#F8F6F1`, cartes blanches `#FFFFFF`) et
  **sombre** (fond de page `#1B2529`, cartes `#26353B`).

---

## 2. Lot I — icône de l'application

### 2.1 Usages réels

| Où l'icône apparaît | Taille d'affichage typique | Fichier source utilisé |
|---|---|---|
| Écran d'accueil iPhone / iPad, Spotlight, Réglages, notifications iOS | 29 à 83,5 pt (58 à 180 px) | `AppIcon` 1024 × 1024 (iOS dérive toutes les tailles) |
| App Store (fiche, résultats de recherche), TestFlight | jusqu'à 1024 px | idem |
| Écran d'accueil Android (cercle, carré arrondi, goutte… selon le fabricant), tiroir d'applications | 48 dp (≈ 48 à 192 px) | icône adaptative (avant-plan + arrière-plan + monochrome) |
| Android 13+ « icônes à thème » (couleur imposée par le fond d'écran) | 48 dp | calque **monochrome** |
| Google Play (fiche, recherche) | 512 px | icône Play 512 × 512 |
| Barre d'état et volet de notification Android | 24 dp | petite icône de notification **blanche sur transparent** (§ 2.6) |
| Écran de démarrage (iOS et Android) | ≈ 160 à 200 dp au centre | marque seule sur fond uni (§ 2.7) |
| Paramètres › Applications, gestion du stockage, sélecteur de partage | 24 à 48 dp | dérivés automatiques |

Les deux applications installées ensemble : **« Verebona »** (`fr.verebona.app`) et **« Verebona
Préprod »** (`fr.verebona.app.preprod`). Le nom affiché sous l'icône est tronqué par le système (souvent
« Verebona Pr… ») : **la différence doit se voir sur l'icône elle-même**.

### 2.2 Exigences de dessin (production)

1. Un **symbole** simple, distinctif, propre à Verebona, évoquant « tous mes biens rangés au même endroit »
   (contenant, ordre, protection, sérénité), **valable pour toutes les familles de biens**.
2. **Lisible à 29 pt et à 24 dp** : au plus 2 à 3 formes principales ; aucun trait plus fin que 1/48 du
   côté (≈ 21 px sur 1024) ; aucun détail inférieur à 1/24 du côté (≈ 43 px sur 1024) ; pas de texte.
3. Couleurs de la charte (§ 1.1) uniquement ; **le contraste principal symbole / fond est au moins de
   4,5:1** (ex. ivoire sur pétrole) ; le cuivre n'est qu'un accent.
4. Fond **opaque, plein cadre**, sans transparence, sans coins arrondis, sans bordure, sans ombre, sans
   reflet.
5. Reconnaissable en **monochrome** (une seule couleur) : la silhouette seule doit suffire.
6. Distincte des icônes usuelles des catégories voisines (banques, assurances, gestionnaires de fichiers,
   Google Drive, Dropbox, Notes) : pas de dossier jaune, pas de nuage, pas de cadenas seul.
7. Pas de lettre « V » seule en police standard (trop banale), sauf dessin propre et justifié en concept.

### 2.3 Variante PRÉPROD (obligatoire)

But : qu'un testeur ne confonde **jamais** les deux applications, même d'un coup d'œil, même en
monochrome, même à 24 dp.

Exigences :
1. **Même symbole** que la production (on reconnaît Verebona).
2. **Deux différences cumulées** :
   - un **fond de couleur différente** de la production (ex. ivoire `#F8F6F1` ou cuivre `#D66B53` si la
     production est pétrole ; le graphiste propose, le PO choisit) ;
   - **un repère de forme** qui survit au monochrome : bandeau oblique ou horizontal en bas de l'icône,
     ou coin coupé / pastille géométrique, intégré **dans la zone sûre Android** (§ 2.5).
3. Le mot **« PRÉPROD »** (capitales, Figtree 800, accent sur le É) peut figurer dans le bandeau ; il doit
   alors rester lisible à 1024 et à 180 px. À 48 dp il peut devenir illisible : la différence de fond et
   de forme suffit alors.
4. Le **calque monochrome** Android de la préprod contient le repère de forme (sinon les deux icônes « à
   thème » seraient identiques).
5. La petite icône de notification préprod (§ 2.6) porte le même repère de forme.

### 2.4 iOS — fichiers attendus

Le projet utilise un catalogue d'images avec une seule taille 1024 (Xcode dérive le reste) :
`mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset` (production) et `AppIcon-Preprod.appiconset`
(préprod), sélectionnés au build (`ASSETCATALOG_COMPILER_APPICON_NAME`).

| Fichier | Format | Dimensions | Contraintes |
|---|---|---|---|
| `verebona-ios-1024.png` | PNG 24 bits **sans canal alpha**, sRGB | 1024 × 1024 | **Aucune transparence, aucun coin arrondi**, fond plein cadre (exigence App Store) |
| `verebona-ios-1024-sombre.png` | PNG, sRGB | 1024 × 1024 | Variante « sombre » d'iOS 18+ : symbole sur fond **transparent** (iOS ajoute son propre fond sombre) ou fond foncé plein cadre — à préciser dans la planche |
| `verebona-ios-1024-teinte.png` | PNG **niveaux de gris**, sRGB | 1024 × 1024 | Variante « teintée » d'iOS 18+ : symbole en gris clair sur fond transparent, contrastes conservés |
| `verebona-ios-calques.svg` | SVG | 1024 × 1024 | Calques séparés et nommés (`fond`, `symbole`, `accent`) pour constituer un fichier Icon Composer `.icon` (Xcode 26, effet « Liquid Glass ») ; si le graphiste dispose d'Icon Composer, il livre aussi `verebona.icon` |

Même jeu pour la préprod, suffixe `-preprod` (ex. `verebona-preprod-ios-1024.png`).

Contrôle Apple : l'App Store refuse une icône 1024 avec canal alpha. Pas de capture d'écran de
l'interface, pas de photo, pas d'élément imitant une icône système.

### 2.5 Android — fichiers attendus

Icône adaptative (Android 8+) : canevas **108 × 108 dp** ; zone visible ≈ 72 dp ; **zone sûre : cercle de
66 dp de diamètre centré** — tout ce qui compte (symbole, repère PRÉPROD) est dans ce cercle ; le fond
déborde jusqu'aux 108 dp. Le projet attend `ic_launcher_foreground`, `ic_launcher_background`
(aujourd'hui une couleur blanche par défaut) et un calque monochrome à ajouter
(`mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`).

| Fichier | Format | Dimensions | Contraintes |
|---|---|---|---|
| `verebona-android-avant-plan.svg` | SVG simple (formes pleines, sans filtre, sans texte non vectorisé, sans masque complexe) | viewBox 108 × 108 | Symbole seul sur **transparent**, entièrement dans le cercle central de 66 de diamètre ; convertible en VectorDrawable |
| `verebona-android-avant-plan-432.png` | PNG 32 bits avec alpha | 432 × 432 | Même contenu (densité xxxhdpi) |
| `verebona-android-arriere-plan.svg` + couleur hexadécimale | SVG plein cadre ou couleur unie | viewBox 108 × 108 | Plein cadre, **sans transparence** ; si couleur unie, donner le code (ex. `#17474D`) |
| `verebona-android-arriere-plan-432.png` | PNG 24 bits | 432 × 432 | Plein cadre |
| `verebona-android-monochrome.svg` | SVG une couleur (noir `#000000`) sur transparent | viewBox 108 × 108 | Silhouette du symbole pour les icônes à thème (Android 13+), dans le cercle de 66 |
| `verebona-android-monochrome-432.png` | PNG alpha | 432 × 432 | idem |
| `verebona-android-legacy-512.png` | PNG 32 bits | 512 × 512 | Icône complète (fond + symbole), carré plein, pour les appareils antérieurs à Android 8 (les développeurs déclinent 48/72/96/144/192 px et la version ronde) |
| `verebona-play-512.png` | PNG 32 bits, sRGB, **≤ 1 Mo** | 512 × 512 | Icône Google Play : carré plein, **sans coins arrondis ni ombre** (Google les ajoute) |
| `verebona-play-banniere-1024x500.png` | PNG 24 bits sans alpha ou JPEG | 1024 × 500 | « Image de présentation » de la fiche Play (obligatoire pour publier). Symbole + nom « Verebona » en Figtree, aucun texte promotionnel (« n° 1 », « gratuit ») |

Même jeu pour la préprod, préfixe `verebona-preprod-…`. La préprod n'a **jamais** de fiche publique,
mais Google Play exige quand même icône 512 et bannière pour la piste de test interne.

### 2.6 Petite icône de notification Android

Android affiche cette icône dans la barre d'état : **silhouette blanche sur fond transparent**, sans
couleur (sinon Android affiche un carré blanc). À ce jour aucune n'est déclarée dans le projet (le
système utilise l'icône de l'application, d'où un carré blanc).

| Fichier | Format | Dimensions | Contraintes |
|---|---|---|---|
| `ic_stat_verebona.svg` | SVG blanc `#FFFFFF` sur transparent | viewBox 24 × 24, contenu dans 20 × 20 centré | Formes pleines, aucun trait < 2 unités |
| `ic_stat_verebona-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}.png` | PNG alpha, blanc pur | 24, 36, 48, 72, 96 px | idem |
| `ic_stat_verebona_preprod.*` | idem | idem | Avec le repère de forme PRÉPROD |
| Couleur d'accent de notification | code hexadécimal | — | Proposée dans la planche (par défaut `#17474D`) |

iOS n'utilise pas de petite icône séparée (il reprend l'icône de l'application).

### 2.7 Écran de démarrage (Capacitor, iOS et Android)

Aujourd'hui : écran blanc / image par défaut de Capacitor, fond ivoire `#F8F6F1` réglé dans
`mobile/capacitor.config.ts` (`backgroundColor`, `SplashScreen.backgroundColor`). Cible : **fond uni +
marque seule au centre**, sans texte, sans animation, identique en préprod sauf le repère PRÉPROD.

| Fichier | Format | Dimensions | Contraintes |
|---|---|---|---|
| `verebona-demarrage-marque.svg` | SVG | carré | Symbole seul sur transparent |
| `verebona-demarrage-android12-1152.png` | PNG alpha | 1152 × 1152 (288 dp × 4) | Symbole sur **transparent**, contenu dans un **cercle de 768 px** de diamètre centré (règle Android 12+ : 192 dp sur 288 dp) |
| `verebona-demarrage-2732.png` | PNG 24 bits | 2732 × 2732 | Fond uni (couleur choisie) + symbole centré, largeur du symbole ≤ 600 px (outil `@capacitor/assets`) |
| `verebona-demarrage-sombre-2732.png` | PNG 24 bits | 2732 × 2732 | Version thème sombre (fond `#1B2529`) |
| Couleurs de fond clair / sombre | codes hexadécimaux | — | Par défaut ivoire `#F8F6F1` / `#1B2529` |

Même jeu préprod (`verebona-preprod-demarrage-…`).

### 2.8 Web (favicon, PWA) — à livrer, intégration sur décision du PO

Le site utilise aujourd'hui `public/favicon.svg`, `favicon.ico`, `favicon-16/32/48…png`, et pour
l'application installée `public/pwa/icon-any-192|512-l79.png`, `icon-maskable-192|512-l79.png`,
`apple-touch-icon-180-l79.png` (`src/lib/pwa/icons.ts`). La décision B5 écarte l'icône PWA actuelle
**pour l'application mobile** ; aligner aussi le site sur la nouvelle icône est une décision séparée du
PO. Pour éviter une seconde commande, ces exports sont livrés en même temps :

| Fichier | Format | Dimensions | Contraintes |
|---|---|---|---|
| `favicon.svg` | SVG | carré | Symbole simplifié, lisible à 16 px, fond plein ou transparent (préciser) |
| `favicon.ico` | ICO multi-tailles | 16, 32, 48 | Pixel-perfect à 16 px (retouche manuelle si nécessaire) |
| `pwa-any-192.png`, `pwa-any-512.png` | PNG | 192, 512 | Fond opaque plein cadre |
| `pwa-maskable-192.png`, `pwa-maskable-512.png` | PNG | 192, 512 | Symbole dans un **cercle de 80 %** du côté (rayon 40 %), fond plein cadre |
| `apple-touch-icon-180.png` | PNG sans alpha | 180 × 180 | Opaque, coins carrés |

### 2.9 Tailles de contrôle à fournir dans la planche

Pour la production **et** la préprod, côte à côte, sur fond d'écran clair et sombre :
1024, 180, 120, 87, 58 px (iOS) ; masques Android cercle, carré arrondi, goutte, « squircle » à 192 et
48 px ; icône à thème (monochrome) Android ; notification à 24 dp (96 px agrandi × 4 et taille réelle) ;
simulation de l'écran d'accueil avec les deux applications voisines.

---

## 3. Lot M — mascotte

### 3.1 Situation actuelle (relevée dans le code)

- Un **seul point de rendu** : `src/components/verebona/space/MascotPose.tsx`, qui affiche
  `public/mascot/<pose>.webp` (`src/lib/verebona/mascot-motion.ts`, fonction `mascotSrc`).
- Fichiers actuels : 12 poses, **WebP 512 × 512, fond transparent**.
- Couleur : une **recoloration cyan provisoire par filtre CSS** (`--vb-mascotte-filtre`) est appliquée à
  toutes les occurrences, « en attendant les fichiers recolorés à la source » (charte Sérénité §4, lot 66).
  Le même filtre est recopié dans les exports PDF (`src/services/exports/v12/static/components.css`).
  **Objectif du lot M : livrer des fichiers déjà aux bonnes couleurs** pour supprimer ce filtre.
- Une ancienne bibliothèque `public/assets/verebona/mascot/v1/` (manifeste de 20 poses, seulement 5
  présentes, tailles 48/112/160/512) **n'est pas utilisée** par l'application : elle ne sert pas de
  référence.

### 3.2 Emplacements et tailles d'affichage

| Emplacement | Fichier code | Taille affichée (CSS) | Fond derrière | Mouvement |
|---|---|---|---|---|
| Accueil, bulle de la mascotte — ordinateur | `src/components/home/MascotSpeaks.tsx` | **112 × 112 px** | ivoire `#F8F6F1` (clair) / `#1B2529` (sombre) | Arrivée à chaque changement de pose ; balancement lent « au travail » pour `document-analysis-pdf` (pivot à **88 % de la hauteur**, les pieds) |
| Accueil — téléphone | idem | **72 × 72 px** | idem | idem |
| Champ « Demander à Verebona » (barre du haut, ordinateur) | `src/components/verebona/space/VerebonaField.tsx` | **26 × 26 px** | carte blanche `#FFFFFF` / `#26353B` | Arrivée à chaque changement de pose |
| Champ « Demander à Verebona » (téléphone) | idem | **26 × 26 px** | idem | idem |
| En-tête de l'espace de réponse plein écran (téléphone) | idem | **28 × 28 px** | idem | idem |
| Page introuvable (404) | `src/app/not-found.tsx` | **112 × 112 px** | fond de page | Arrivée |
| Exports PDF (encart d'information en fin de document) | `src/services/exports/v12/html/components.ts` (fichier `src/services/exports/v12/static/assets/brand/info-card.webp`) | **58 px** de large, impression | papier blanc | aucun |

Écrans de densité 2× et 3× : 112 px affichés = **336 px réels** ; 26 px = **78 px réels**.
Mouvement réduit (réglage d'accessibilité) : aucune animation, la pose change instantanément.

### 3.3 Poses à livrer (12, toutes obligatoires)

Le **nom de fichier est une clé technique** utilisée par le code : il ne change pas.

| Clé (nom de fichier) | Quand elle s'affiche (code : `src/lib/verebona/space.ts`, `src/services/home/mascot/bubble.ts`) | Attitude attendue |
|---|---|---|
| `neutral` | Pose par défaut, chargement, état non garanti | Debout, calme, regard vers l'utilisateur |
| `welcome-wave` | Compte vide (accueil) ; champ de l'assistant sans échange | Salue de la main |
| `search-loupe` | Recherche en cours ; réponse avec plusieurs résultats | Tient une loupe |
| `property-house` | Réponse portant sur **un bien** | Présente une fiche « bien » (pictogramme générique de bien, pas seulement une maison : le concept le précise) |
| `info-card` | Réponse factuelle, aide ; encart des exports PDF | Présente une carte d'information |
| `document-analysis-pdf` | Réponse sur un document ; **analyse de documents en cours** (pose « au travail », animée) | Lit un document |
| `reminder-bell` | Sujet à traiter ; réponse sur une échéance / un événement | Cloche ou rappel |
| `thumbs-up` | Action proposée / exécutée | Pouce levé |
| `dialogue-bubble` | Conversation (salutations, remerciements, synthèse) | Bulle de dialogue |
| `questioning` | Information à vérifier ; aucun résultat ; erreur ; page 404 | Interrogatif, bienveillant (jamais inquiet ni moqueur) |
| `success-check` | Rien de particulier à signaler | Coche de validation, satisfait sans excès |
| `alert-folder` | Échéance en retard | Dossier avec signal d'attention, ton sérieux mais **pas alarmiste** |

Hors commande (ne pas produire sans nouveau bon de commande) : `conversation-ready`, `analysis-in-progress`,
`alert`, `composed-hands`, `security-shield`, `premium-folder`, `download-file`, `search-card`.

### 3.4 Règles de dessin de la mascotte

1. **Même personnage** que l'actuel (identité conservée) ; le graphiste peut le **nettoyer** (traits,
   proportions), pas le remplacer. Toute évolution de forme est montrée au concept (§ 5).
2. **Couleurs** : corps dans les trois teintes mascotte — lumière `#18B8E8`, face `#08A8D8`, ombre
   `#0878A8` — ; accessoires dans la charte (pétrole, cuivre, ivoire, blanc). Aucun autre bleu.
3. **Contraste de la silhouette** (accessibilité, WCAG 1.4.11 « 3:1 ») : le cyan clair seul est trop pâle
   sur ivoire (2,6:1). La silhouette extérieure porte donc un **contour ou une ombre propre en `#0878A8`**
   (4,6:1 sur ivoire), tandis que les faces claires assurent le contraste sur fond sombre (4,6:1 sur
   `#26353B`). Critère : **sur chacun des fonds** `#F8F6F1`, `#FFFFFF`, `#ECF1EF`, `#1B2529`, `#26353B`,
   la silhouette est visible avec un contraste ≥ 3:1 sur au moins la moitié de son contour.
4. **Cadrage identique pour toutes les poses** (sinon la mascotte « saute » quand la pose change) :
   carré, personnage centré horizontalement, **pieds sur la même ligne à 88 % de la hauteur** (pivot du
   balancement), marge ≥ 5 % sur chaque bord, tête à la même hauteur d'une pose à l'autre (± 2 %).
   Les accessoires peuvent dépasser latéralement, jamais hors cadre.
5. **Lisibilité à 26 px** : à cette taille, on doit reconnaître la mascotte et distinguer au moins
   `welcome-wave`, `search-loupe`, `questioning`, `thumbs-up`. D'où la version **petite taille** (§ 3.5) :
   formes simplifiées, accessoire agrandi, détails internes supprimés, contour épaissi.
6. Fond **transparent**, sans ombre portée au sol, sans halo, sans reflet ; bords propres (pas de frange
   blanche ou noire autour de l'alpha : vérifier sur fond pétrole et sur fond rouge vif).
7. Aucun texte dans l'image ; aucune marque tierce (pas de logo PDF d'Adobe : un document « PDF » est
   suggéré par une feuille, pas par le logo).
8. Les poses `alert-folder` et `questioning` ne doivent pas évoquer la peur, l'échec ou le reproche.

### 3.5 Fichiers attendus (par pose — remplacer `<cle>` par la clé du § 3.3)

| Fichier | Format | Dimensions | Usage |
|---|---|---|---|
| `mascotte-source.<fig|ai|svg>` (un seul fichier pour toutes les poses) | Source vectorielle, calques nommés par pose | — | Archives, retouches futures |
| `<cle>-master.png` | PNG 32 bits alpha, sRGB | **2048 × 2048** | Référence haute définition |
| `<cle>.webp` | WebP avec alpha, qualité ≥ 90, sRGB, **≤ 60 Ko** | **512 × 512** | Fichier servi par l'application (`public/mascot/`) pour les affichages ≥ 48 px |
| `<cle>-petite.webp` | WebP avec alpha, **≤ 15 Ko** | **128 × 128** | Version simplifiée pour les affichages ≤ 32 px (champ de l'assistant) |
| `<cle>-petite.png` | PNG alpha | 128 × 128 | Contrôle de la version simplifiée |

En plus, une seule fois :
- `info-card-export.png` : PNG alpha 512 × 512 de la pose `info-card`, pour les exports PDF (fond blanc
  d'impression : vérifier le rendu en niveaux de gris).
- `mascotte-planche-controle.pdf` : les 12 poses aux tailles 112, 72, 28 et 26 px (taille réelle et × 3),
  sur les cinq fonds du § 3.4 ; superposition des 12 poses à 50 % d'opacité (contrôle du cadrage).

---

## 4. Critères de validation et de refus (les deux lots)

### 4.1 Validation

| N° | Critère | Lot | Vérifié par |
|---|---|---|---|
| V1 | Le concept a été validé par écrit par le PO avant la finalisation | I, M | PO |
| V2 | Liste des fichiers du § 2 / § 3.5 **complète**, noms exacts, arborescence du § 6 | I, M | Développeurs |
| V3 | Dimensions, format, profil sRGB et présence / absence d'alpha conformes à chaque ligne | I, M | Développeurs (contrôle automatique) |
| V4 | Icône iOS 1024 sans alpha ni coins arrondis | I | Développeurs |
| V5 | Android : symbole et repère PRÉPROD dans le cercle de 66 dp ; rendu correct en cercle, carré arrondi, goutte | I | Développeurs + planche |
| V6 | Production et préprod distinguables **à 48 dp, en monochrome et en niveaux de gris** | I | PO + développeurs |
| V7 | Lisibilité à 24 dp (notification) et à 29 pt (iOS) | I | Planche + téléphone réel |
| V8 | Couleurs exclusivement de la charte ; contrastes du § 2.2 (icône) et § 3.4 (mascotte) | I, M | Développeurs (mesure) |
| V9 | Cadrage commun des 12 poses (superposition) ; pieds à 88 % | M | Développeurs |
| V10 | Mascotte reconnaissable à 26 px (version petite taille) sur fonds clairs et sombres | M | Développeurs + PO |
| V11 | Rendu vérifié **en situation** : téléphones réels iOS et Android (écran d'accueil, notification, démarrage), application en thème clair et sombre | I, M | Développeurs puis PO |
| V12 | Cession de droits signée (§ 7) reçue avant intégration en production | I, M | PO |

### 4.2 Motifs de refus (renvoi au graphiste)

- fichier manquant, mal nommé, mauvaise dimension, mauvais format ;
- icône 1024 avec transparence ou coins arrondis ; ombre ou reflet ajouté ;
- texte illisible à 180 px, ou icône reposant sur un texte pour se distinguer ;
- préprod non distinguable de la production en monochrome ;
- élément essentiel hors de la zone sûre Android ;
- couleur hors charte, dégradé décoratif ;
- mascotte : frange autour de la transparence, cadrage qui varie d'une pose à l'autre, personnage
  remplacé sans validation, expression alarmiste ;
- reprise d'une maquette non validée ou de l'icône PWA actuelle ;
- élément dont l'origine ne permet pas la cession (banque d'images sans licence adaptée, contenu généré
  par IA non déclaré, police non libre).

Deux allers-retours de corrections sont inclus par lot après validation du concept.

---

## 5. Étapes et calendrier type

J = date d'envoi du brief. Jours ouvrés.

| Étape | Échéance | Contenu | Qui |
|---|---|---|---|
| 1. Questions du graphiste | J+2 | Questions écrites ; réponse des développeurs sous 1 jour | Graphiste → développeurs |
| 2. Concepts | J+7 | Icône : **3 pistes**, chacune en production + préprod, à 1024 / 180 / 48 px et en monochrome. Mascotte : `neutral` + 2 poses (`questioning`, `welcome-wave`) recolorées, aux 4 tailles du § 3.2 | Graphiste |
| 3. Choix du PO | J+9 | Choix d'une piste d'icône et validation de la mascotte, par écrit (V1) | PO |
| 4. Finalisation | J+16 | Icône complète ; mascotte : les 12 poses en 512 + petite taille | Graphiste |
| 5. Contrôle technique | J+18 | Contrôles V2 à V10 ; retours groupés | Développeurs |
| 6. Corrections et exports définitifs | J+21 | Arborescence complète du § 6 | Graphiste |
| 7. Intégration et builds de préproduction | J+23 | Procédure du § 8 | Développeurs |
| 8. Recette sur téléphones réels | J+25 | V11 ; procès-verbal PO | Développeurs puis PO |

---

## 6. Livraison directe aux développeurs

- **Canal** : dossier partagé de Verebona (Google Drive de l'entreprise) auquel les développeurs ont
  accès ; un message court signale chaque dépôt. Pas de Trello, pas de pièce jointe dispersée.
  Ces fichiers ne sont pas secrets ; seuls les contrats (§ 7) restent chez le PO.
- **Un dossier par livraison**, daté, jamais modifié après dépôt (une correction = un nouveau dossier).

```
verebona-graphisme-AAAAMMJJ/
  00-LISEZ-MOI.txt                 liste des fichiers, version, outils, polices, remarques
  01-sources/
    icone-verebona.<fig|ai|svg>
    mascotte-source.<fig|ai|svg>
  02-icone-production/
    ios/        verebona-ios-1024.png, verebona-ios-1024-sombre.png, verebona-ios-1024-teinte.png,
                verebona-ios-calques.svg, [verebona.icon]
    android/    verebona-android-avant-plan.svg, verebona-android-avant-plan-432.png,
                verebona-android-arriere-plan.svg (ou couleurs.txt), verebona-android-arriere-plan-432.png,
                verebona-android-monochrome.svg, verebona-android-monochrome-432.png,
                verebona-android-legacy-512.png, verebona-play-512.png, verebona-play-banniere-1024x500.png
    notification/ ic_stat_verebona.svg, ic_stat_verebona-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}.png
    demarrage/  verebona-demarrage-marque.svg, verebona-demarrage-android12-1152.png,
                verebona-demarrage-2732.png, verebona-demarrage-sombre-2732.png
    web/        favicon.svg, favicon.ico, pwa-any-192.png, pwa-any-512.png,
                pwa-maskable-192.png, pwa-maskable-512.png, apple-touch-icon-180.png
    couleurs.txt  codes hexadécimaux : fond icône, fond démarrage clair / sombre, accent notification
  03-icone-preprod/
    (même structure, préfixe verebona-preprod-…, ic_stat_verebona_preprod…)
  04-mascotte/
    master/     <cle>-master.png ×12
    app/        <cle>.webp ×12
    app-petite/ <cle>-petite.webp ×12, <cle>-petite.png ×12
    export/     info-card-export.png
  05-planches/
    icone-planche-controle.pdf, mascotte-planche-controle.pdf
```

Conventions : minuscules, tirets, sans espace ni accent dans les noms de fichiers ; clés de pose exactement
celles du § 3.3.

---

## 7. Droits et cession

Avant toute intégration en production, le graphiste remet un **contrat de cession de droits d'auteur**
(article L131-3 du Code de la propriété intellectuelle : chaque droit cédé est mentionné et son domaine
délimité). Contenu minimal :
- droits cédés : **reproduction, représentation, adaptation et modification** (déclinaisons, recolorations,
  animations, simplifications futures) ;
- supports : applications iOS / Android et leurs fiches App Store / Google Play, site et application web,
  e-mails, documents et exports PDF, réseaux sociaux, supports imprimés et de présentation ;
- territoire : **monde entier** ; durée : **toute la durée légale** des droits ; cession **exclusive** ;
- prix de la cession distinct ou inclus explicitement dans le devis ;
- **garantie d'originalité** : aucun élément de banque d'images sans licence adaptée, aucune police non
  libre (Figtree, licence OFL, est autorisée) ;
- **déclaration** de l'usage éventuel d'outils d'IA générative (nature, étape) ; les éléments livrés doivent
  être cessibles ;
- remise des **sources éditables**.

Le PO conserve le contrat signé. Les développeurs n'intègrent pas en production sans confirmation du PO
que le contrat est signé (V12) ; l'intégration en préproduction pour contrôle est possible avant.

---

## 8. Procédure d'intégration côté développeurs

À réaliser par les développeurs après le contrôle technique (étape 5). Le PO n'a aucune commande à lancer.

### 8.1 Contrôles automatiques à la réception

1. Copier la livraison dans un dossier de travail (pas dans le dépôt tel quel).
2. Vérifier, fichier par fichier : présence, dimensions, alpha (icône iOS 1024 : **aucun canal alpha**),
   profil sRGB, poids (WebP ≤ 60 Ko / ≤ 15 Ko), noms. Un contrôle par script (lecture des en-têtes
   d'image) suffit ; résultat joint au compte rendu de contrôle.
3. Superposer les 12 poses (cadrage) ; mesurer les contrastes du § 3.4 ; afficher l'icône Android dans les
   masques cercle / carré arrondi / goutte.
4. Retours groupés au graphiste en une seule liste numérotée (critère V/motif de refus concerné).

### 8.2 Icône iOS

1. Remplacer `mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` par
   `verebona-ios-1024.png` (même nom de fichier dans le catalogue ou `Contents.json` mis à jour) ;
   ajouter dans `Contents.json` les entrées d'apparence « dark » et « tinted » avec les variantes
   sombre et teintée.
2. Même opération dans `AppIcon-Preprod.appiconset` avec les fichiers `verebona-preprod-ios-…`.
3. Si un fichier `.icon` est fourni et que la version de Xcode de la CI le permet : l'ajouter au projet ;
   sinon le conserver pour une version ultérieure.
4. La sélection reste automatique (`ASSETCATALOG_COMPILER_APPICON_NAME`, `mobile/scripts/prepare.mjs`) ;
   le test `mobile/test/gate0-config.test.mjs` le vérifie déjà.

### 8.3 Icône Android

1. Production (`mobile/android/app/src/main/res/`) : convertir l'avant-plan, l'arrière-plan et le calque
   monochrome en VectorDrawable (Android Studio › Vector Asset, ou PNG par densité à défaut) ;
   `mipmap-anydpi-v26/ic_launcher.xml` et `ic_launcher_round.xml` : `<background>`, `<foreground>` et
   **`<monochrome>`** ; `values/ic_launcher_background.xml` : couleur de fond livrée (aujourd'hui
   `#FFFFFF`).
2. Icônes anciennes : décliner `verebona-android-legacy-512.png` en `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}`
   (48, 72, 96, 144, 192 px) pour `ic_launcher.png` et `ic_launcher_round.png`.
3. **Préprod** : créer le dossier de variante `mobile/android/app/src/preprod/res/` avec les mêmes noms de
   ressources (Gradle prend la variante `preprod` en priorité ; les variantes existent déjà dans
   `app/build.gradle`). La production reste dans `src/main/res/`.
4. Notification : ajouter `drawable/ic_stat_verebona` (et `ic_stat_verebona` dans
   `src/preprod/res/drawable/` pour la préprod), puis dans `AndroidManifest.xml` les métadonnées
   `com.google.firebase.messaging.default_notification_icon` et
   `com.google.firebase.messaging.default_notification_color`.
5. Google Play : déposer `verebona-play-512.png` et la bannière dans la fiche de chaque application
   (Play Console › Présence sur le Store) — geste du titulaire du compte ou du développeur s'il a reçu le
   droit correspondant.

### 8.4 Écran de démarrage

1. Option recommandée : placer `verebona-demarrage-2732.png` et `verebona-demarrage-sombre-2732.png` comme
   `assets/splash.png` / `assets/splash-dark.png` dans un dossier de travail et générer les ressources avec
   `npx @capacitor/assets generate` (une fois par variante, puis déplacer les ressources préprod dans
   `src/preprod/res/` et `Splash` iOS selon la variante).
2. Android 12+ : déclarer l'icône de démarrage (`windowSplashScreenAnimatedIcon`) avec
   `verebona-demarrage-android12-1152.png` et la couleur de fond livrée dans le thème
   `AppTheme.NoActionBarLaunch` (`values/styles.xml`).
3. Aligner `backgroundColor` et `SplashScreen.backgroundColor` de `mobile/capacitor.config.ts` sur la
   couleur livrée.

### 8.5 Mascotte

1. Remplacer les 12 fichiers `public/mascot/<cle>.webp` (mêmes noms). `next.config.mjs` ne pose pas
   aujourd'hui de cache long sur `/mascot/*` (contrairement à `/pwa/*`) : le remplacement sur place est
   donc possible ; si un cache long est ajouté un jour, passer par un suffixe de version dans `mascotSrc`.
2. Ajouter `public/mascot/<cle>-petite.webp` et faire choisir la petite version par `mascotSrc` quand la
   taille affichée est ≤ 32 px (`MascotPose` connaît la taille).
3. Supprimer la recoloration provisoire : `--vb-mascotte-filtre: none` dans `src/app/globals.css` (le
   point unique `mascotFilter` reste en place) et retirer le `filter` de `.mascot-card img` dans
   `src/services/exports/v12/static/components.css`.
4. Remplacer `src/services/exports/v12/static/assets/brand/info-card.webp` par l'export de
   `info-card-export.png` (WebP).
5. Archiver les masters et sources hors du dépôt applicatif (dossier partagé), pas dans `public/`.
6. Mettre à jour les tests qui figent le filtre provisoire : `src/__tests__/lot66/l66-theme.test.ts`
   (L66-THEME-01 et L66-THEME-04 attendent la valeur `hue-rotate(-30deg)…` et
   `filter:var(--vb-mascotte-filtre)`) — garder le point unique `mascotFilter` et changer seulement la
   valeur attendue ; mettre à jour le commentaire « provisoire » de `globals.css` et de `MascotPose.tsx`.

### 8.6 Web (seulement si le PO décide d'aligner le site)

Nouveaux noms suffixés (ex. `-l1xx`) dans `public/pwa/`, déclarés dans `src/lib/pwa/icons.ts` ; **ne
jamais remplacer un fichier de `public/pwa/` sur place** (cache `immutable`, voir
`docs/exploitation/pwa-icones.md`) ; recopier dans `public/manifest.json` (test l79b) ; incrémenter
`ICONS_VERSION` du layout racine pour les favicons.

### 8.7 Builds et recette

1. Build **préprod** iOS et Android par les workflows `mobile-ios.yml` / `mobile-android.yml` ; installer
   « Verebona Préprod » et, dès qu'elle existe, « Verebona » sur le **même téléphone**.
2. Captures : écran d'accueil clair et sombre, icônes à thème Android, notification de test, écran de
   démarrage, accueil de l'application (mascotte 112 / 72 px), champ de l'assistant (26 px), page 404,
   un export PDF.
3. Contrôle V11, puis procès-verbal du PO joint au ticket ; en cas de réserve, retour au graphiste
   (étape 6).
4. Production : uniquement après V12 (cession signée) et par l'environnement protégé `production-mobile`.
