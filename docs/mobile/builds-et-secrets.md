# Application mobile — builds, comptes, secrets (lot 95)

Décisions PO appliquées : M4 (projet dans `mobile/`), M6 (comptes au nom de Verebona), M7 (identifiants),
M8 (GitHub Actions, TestFlight / Google Play tests internes, production sur approbation). Aucun secret,
certificat, clé ou fichier Firebase n'est dans le dépôt : tout est déposé dans **GitHub › Settings ›
Environments**. Le PO ne lance aucune commande : il crée les comptes, dépose les valeurs et approuve les
publications.

> Création des comptes, dépôt des secrets, tests et reprise des accès : **guide unique**
> `docs/exploitation/guide-comptes-unique.md` (C3, 29/10/2026). Icônes : `docs/design/brief-graphiste-icone-et-mascotte.md`.
>
> **Architecture (décision PO du 03/11/2026, lot 108G) : interface DISTANTE = cible V1 iOS et Android.**
> Elle remplace la décision B1 du 27/10/2026 (interface embarquée), **décision remplacée / plan
> abandonné** (`plan-architecture-embarquee.md`, conservé pour l'historique). Architecture et audit de
> sécurité : `docs/mobile/architecture-distante.md` ; décision et classement E0–E15 :
> `docs/mobile/decision-interface-distante-108g.md` ; stores : `docs/mobile/conformite-stores.md` ;
> recette : `docs/exploitation/recette-108g-mobile-distant.md`.

## 1. Organisation du dépôt

```
mobile/
  package.json, package-lock.json   Capacitor 8.5.3 et plugins (versions figées)
  capacitor.config.ts               configuration unique, lue par environnement
  config/environments.mjs           préprod / prod : identifiants, noms, schémas, garde-fous
  scripts/prepare.mjs               fichiers propres à UN build (non versionnés)
  scripts/app-links.mjs             App Links Android générés depuis src/lib/mobile/app-links.ts
  config/navigation-policy.mjs      ce que la vue peut ouvrir (appliqué en natif iOS / Android)
  scripts/distribution-guard.mjs    contrôle du BINAIRE avant envoi TestFlight / Play (lot 108G)
  www/                              coque locale du mode distant : pages de secours seulement
                                    (« Connexion Internet indisponible »), aucune donnée métier
  sonde-b/                          sonde technique du Gate 0 (mode local) — jamais distribuée
  android/                          projet Android (variantes Gradle preprod / prod)
  ios/                              projet iOS (Swift Package Manager, Verebona.xcconfig généré)
  ios/App/ShareExtension/           extension de partage iOS — cible Xcode VERSIONNÉE (lot 108G, § 6)
  test/                             tests du projet mobile (`npm test`)
.github/workflows/mobile-android.yml, mobile-ios.yml   workflows dédiés (ci.yml inchangé)
```

Le site n'est pas concerné : `mobile/` est exclu du typecheck (`tsconfig.json`), du lint
(`eslint.config.mjs`), de vitest (qui ne lit que `src/`), du build Next.js et du scan Tailwind
(`@source not` dans `globals.css`). Le site n'embarque **aucun** paquet Capacitor.

## 2. Ce que fait la CI

| Événement | Android (Linux) | iOS (macOS) |
|---|---|---|
| Pull request touchant `mobile/**`, `src/lib/native/**`, `src/lib/mobile/app-links.ts` | Contrôles seulement | Contrôles seulement |
| Push sur `main` (mêmes chemins) | Contrôles → build **préprod** → Google Play **tests internes** | Contrôles → build **préprod** → **TestFlight** |
| Lancement manuel (« Run workflow ») | Choix préprod / prod, publication oui / non, piste prod ; mode `remote` par défaut (`local` = sonde, préprod, artefact seul) | Choix préprod / prod, publication oui / non ; mode `remote` par défaut (`local` = sonde, préprod, compilation seule) |
| Production | Environnement **protégé** `production-mobile` : rien ne part sans l'approbation d'un réviseur. **Toujours en mode distant.** Piste `internal` (testeurs de la fiche de production, défaut) ou `production` en **brouillon** (le déploiement public se confirme à la main dans la Play Console). | Environnement **protégé** `production-mobile` : **toujours en mode distant** ; le build arrive dans TestFlight de l'app de production. La **soumission** à la revue et la **publication** (choisir « publication manuelle ») restent deux gestes manuels du PO dans App Store Connect. |
| Garde-fous (lot 108G, CA02) | `readiness` refuse une sonde locale en production ou avec « publish » ; avant l'envoi, l'**AAB** est ouvert et sa configuration Capacitor réelle contrôlée (`distribution-guard.mjs` : interface distante de l'environnement, aucune sonde, pas de débogage en prod) | Idem sur l'**archive** Xcode, plus : `ShareExtension.appex` présent dans `App.app/PlugIns`, identifiant `<app>.ShareExtension`, groupe d'apps présent dans les droits **signés** de l'app et de l'extension |

Contrôles (BUILD-07) : typecheck de la configuration, tests du projet mobile, App Links à jour, tests
vitest de `src/lib/native` et `src/lib/mobile`, liste des dépendances (BUILD-09, artefact `sbom`).
Numéro de build = numéro d'exécution du workflow (toujours croissant, BUILD-06) ; version marketing =
variable `VEREBONA_APP_VERSION`. Artefacts conservés : AAB (90 j préprod, 400 j prod), symboles iOS
(BUILD-08). Retour arrière (M8) : republier un build précédent depuis TestFlight / la Play Console (dans
les limites des stores), plus interrupteurs serveur `MOBILE_FEATURES_OFF` et version minimale (lot 97).

Commandes exécutées par la CI (pour mémoire, le PO n'a rien à lancer) :

```
cd mobile && npm ci --legacy-peer-deps
VEREBONA_ENV=preprod VEREBONA_APP_ORIGIN=… VEREBONA_APP_VERSION=… VEREBONA_APP_BUILD=… npm run sync -- android   # ou ios
cd android && ./gradlew bundlePreprodRelease                                                                         # ou bundleProdRelease
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release archive …                              # puis -exportArchive (envoi TestFlight)
```

Les projets natifs sont **versionnés** (générés par `npx cap add android` / `npx cap add ios`, puis
configurés). Les régénérer n'est utile qu'en cas de montée de version majeure de Capacitor ; il faut
alors reporter les adaptations (variantes Gradle, manifeste, `Info.plist`, droits, `Verebona.xcconfig`,
plugins locaux `VerebonaAuthSession`, `VerebonaBiometricState`, `VerebonaNavigationGuard`,
`VerebonaShareInbox`, cible `ShareExtension`) — les tests `mobile/test/gate0-config.test.mjs` et
`mobile/test/l108g-mode-distant.test.mjs` (analyse du `project.pbxproj`) signalent un oubli.

## 3. Environnements GitHub à créer (Settings › Environments)

| Environnement | Protection | Utilisé par |
|---|---|---|
| `mobile-preprod` | Branche `main` uniquement | builds de préproduction |
| `production-mobile` | **Réviseurs obligatoires** (le PO), branche `main` uniquement, « Prevent self-review » | builds de production |

### Variables (onglet « Variables » de chaque environnement — non secrètes)

| Variable | Préproduction | Production |
|---|---|---|
| `VEREBONA_APP_ORIGIN` | adresse https de l'application de préproduction (même valeur que `NEXT_PUBLIC_APP_URL` de Scalingo préprod) | adresse https de production |
| `VEREBONA_APP_VERSION` | ex. `0.1.0` | ex. `1.0.0` |
| `APPLE_TEAM_ID` | Team ID Apple (10 caractères) | idem |

Garde-fou : un build de production vers une adresse contenant `preprod` / `staging` / `recette` est
refusé, et un build de préproduction exige une telle adresse (`config/environments.mjs`, motif
`PREPROD_HOST`, seul point à ajuster si l'adresse réelle diffère).

### Secrets (onglet « Secrets » de chaque environnement — valeurs propres à chaque environnement)

| Secret | Contenu | Où l'obtenir |
|---|---|---|
| `GOOGLE_SERVICES_JSON_BASE64` | `google-services.json` du projet Firebase de l'environnement, encodé en base64 | Firebase › Paramètres du projet › app Android |
| `GOOGLE_SERVICE_INFO_PLIST_BASE64` | `GoogleService-Info.plist` du projet Firebase de l'environnement, en base64 | Firebase › Paramètres du projet › app iOS |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | clé d'**import** (upload key) Google Play, fichier `.jks` en base64 | générée une fois par le développeur, enregistrée dans Play App Signing |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` | mots de passe et alias de cette clé | idem |
| `PLAY_SERVICE_ACCOUNT_JSON` | compte de service Google Cloud autorisé dans la Play Console (« Publier sur les pistes de test » ; production : « Gérer les versions de production ») | Play Console › Utilisateurs et autorisations |
| `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` | clé d'API App Store Connect (rôle **App Manager**, avec accès aux certificats gérés par Apple) | App Store Connect › Utilisateurs et accès › Intégrations |
| `ASC_API_KEY_P8_BASE64` | fichier `.p8` de cette clé, en base64 | téléchargeable une seule fois à la création |

Signature iOS : automatique, certificats de distribution **gérés par Apple** via la clé d'API (aucun
certificat `.p12` ni profil dans GitHub). Signature Android : Google Play App Signing (Google conserve la
clé de signature ; la CI ne détient que la clé d'import). Les fichiers sensibles sont effacés du poste de
build en fin de job.

## 4. Comptes et projets à créer par Verebona (M6, M7)

1. **Apple Developer Program** (organisation, numéro D-U-N-S) → App Store Connect : créer les apps
   `fr.verebona.app.preprod` (« Verebona Préprod ») et `fr.verebona.app` (« Verebona »). Pour chaque
   identifiant (Certificates, Identifiers & Profiles › Identifiers) cocher : **Push Notifications**,
   **Associated Domains**, **App Groups** (`group.fr.verebona.app.preprod` / `group.fr.verebona.app`),
   **Sign in with Apple** (si Apple est proposé). Créer la clé APNs (`.p8`) et la déposer dans **chaque**
   projet Firebase. TestFlight : un groupe interne (équipe) et un groupe **externe** (revue bêta d'Apple,
   premier avis sur la règle 4.2).
2. **Google Play Console** (organisation) : créer les deux applications ; activer Play App Signing ;
   piste « Tests internes » avec la liste des testeurs ; **le tout premier AAB doit être envoyé à la main**
   dans la Play Console (exigence de Google), les suivants partent de la CI. Relever l'**empreinte SHA-256
   du certificat de signature** (Intégrité de l'app) pour `MOBILE_ANDROID_SHA256_FINGERPRINTS` (lot 97).
   Déclarer le service de premier plan « synchronisation de données » (envoi de documents en
   arrière-plan) dans le formulaire de la Play Console.
3. **Firebase** : deux projets (`verebona-preprod`, `verebona-prod`), chacun avec une app Android et une
   app iOS aux identifiants de l'environnement ; compte de service « Firebase Cloud Messaging API Admin »
   pour la variable Scalingo `FIREBASE_SERVICE_ACCOUNT_JSON` (lot 97).
4. Accès : Verebona reste propriétaire / administrateur principal ; le développeur reçoit des droits
   nominatifs minimaux. Ne jamais transmettre de mot de passe principal ni de clé en clair.

## 5. Variables Scalingo liées (serveur, par environnement)

Déjà décrites dans `docs/exploitation/application-mobile-serveur.md` (lot 97) ; à poser pour le Gate 0 :

| Variable | Préproduction (exemple) | Effet |
|---|---|---|
| `MOBILE_IOS_TEAM_ID` / `MOBILE_IOS_BUNDLE_IDS` | Team ID / `fr.verebona.app.preprod` | Liens universels iOS + retour https de la connexion Google / Apple |
| `MOBILE_ANDROID_PACKAGE` / `MOBILE_ANDROID_SHA256_FINGERPRINTS` | `fr.verebona.app.preprod` / empreinte Play | App Links Android |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | compte de service du projet Firebase préprod | Notifications |
| `APP_OAUTH_RETURN_URL` | `https://<adresse préprod>/app/retour-connexion` (recommandé) — ou `fr.verebona.app.preprod:/oauth` | Retour de la connexion Google / Apple vers l'app (lot 93). L'app accepte les deux formes ; le Gate 0 dira laquelle garder (voir ci-dessous). |

**Décision B4 (27/10/2026)** : schéma propre à l'application, distinct par environnement. Lot 108G :
l'étape E3 du plan embarqué (cible `…://retour`) est **abandonnée** avec B1 ; la forme en place et
testée est `fr.verebona.app.preprod:/oauth` (préprod) / `fr.verebona.app:/oauth` (prod), acceptée par
`resolveAppUrl` (aucun changement). La forme https reste acceptée.

Choix de `APP_OAUTH_RETURN_URL` (Gate 0) : l'adresse **https** (lien d'app vérifié) est la plus sûre ; elle exige
iOS 17.4 ou plus pour être captée par la session d'authentification d'Apple. Le **schéma privé**
(RFC 8252) fonctionne sur toutes les versions ; il reste sûr car le code reçu ne sert à rien sans le
vérificateur PKCE gardé par l'app. Une seule valeur par environnement : la retenir au Gate 0 selon la
version minimale d'iOS décidée. L'app n'a rien à reconstruire : le serveur annonce la **forme** retenue
(`https` ou `scheme`, jamais l'adresse) dans `GET /api/mobile/config` › `auth.appOAuthReturn`.

## 6. Extension de partage iOS (lot 108G : plus aucune manipulation Xcode)

La cible `ShareExtension` est **versionnée** dans `mobile/ios/App/App.xcodeproj` (sources
`mobile/ios/App/ShareExtension/` : contrôleur Swift, `Info.plist`, droits). Rien à faire sur un Mac.

| Élément | Préproduction | Production |
|---|---|---|
| Identifiant de l'extension (dérivé, `VB_SHARE_EXTENSION_ID`) | `fr.verebona.app.preprod.ShareExtension` | `fr.verebona.app.ShareExtension` |
| Groupe d'apps (app + extension, `VB_APP_GROUP`) | `group.fr.verebona.app.preprod` | `group.fr.verebona.app` |
| Nom dans la feuille « Partager » | « Verebona Préprod » | « Verebona » |

- Signature automatique (même clé d'API que l'app) : `xcodebuild -allowProvisioningUpdates` crée les
  identifiants et profils de l'extension. **À faire par le PO si la CI le signale** : dans Certificates,
  Identifiers & Profiles › Identifiers, créer le groupe d'apps de l'environnement (App Groups) et le
  cocher sur l'identifiant de l'app ET sur celui de l'extension.
- Contrôle CI avant envoi : `App.app/PlugIns/ShareExtension.appex` présent, identifiant dérivé de celui
  de l'app, groupe d'apps présent dans les droits signés des deux.
- Fonctionnement : l'extension copie les PDF / images dans une **file technique** du groupe d'apps (un
  dossier par partage, protection « complète », hors sauvegarde), affiche « Document prêt à importer dans
  Verebona », sans ouvrir l'app ni rien envoyer. À l'ouverture de Verebona (après Face ID / connexion),
  l'app propose ces documents dans le formulaire d'ajout habituel ; les copies sont effacées après
  l'ajout confirmé ou « Abandonner », et au plus tard après 7 jours. Détail :
  `docs/mobile/architecture-distante.md` § 6.

## 7. Icônes et nom

Nom affiché : « Verebona Préprod » / « Verebona » (variantes Gradle, `Verebona.xcconfig`).

Icône (lot 107F) : symbole du design system « Verebona Sérénité » (8 carrés ivoire + carré cuivre
incliné). Production : fond pétrole `#17474D`. Préprod : fond ivoire `#F8F6F1` + bandeau cuivre
« PRÉPROD » (deux différences cumulées, brief § 2.3, repère présent aussi dans le calque monochrome).
Android : `src/main/res` (prod) et `src/preprod/res` (préprod, prioritaire pour la variante) ; iOS :
`AppIcon.appiconset` / `AppIcon-Preprod.appiconset` (PNG 1024 RVB sans alpha). Écrans de démarrage : fond
ivoire, symbole pétrole. Fichiers générés par `mobile/scripts/generate-icons.cjs` (outil de développeur,
non lancé par la CI) ; contrôlés par `mobile/test/l107f-icones.test.mjs`. Décision B5 inchangée : les
fichiers du graphiste remplaceront ceux-ci dès leur livraison (`docs/design/brief-graphiste-icone-et-mascotte.md` § 8).
Une nouvelle icône n'apparaît sur les téléphones qu'avec un **nouveau build** de l'application.

## Signature iOS en CI : appareil technique et rôle de la clé d'API (lot 101-septies)

- `xcodebuild archive` en signature automatique génère d'abord un profil de
  développement, qu'Apple refuse tant que l'équipe n'a **aucun appareil
  enregistré**. L'étape « Appareil iOS pour la signature automatique »
  (`mobile/scripts/asc-ensure-device.mjs`) enregistre, une seule fois, un
  appareil technique « CI Verebona appareil technique (ne pas supprimer) » si
  l'équipe n'en a aucun. Ne pas le supprimer de Certificates, Identifiers &
  Profiles › Devices tant qu'aucun vrai iPhone de test n'est enregistré.
- La clé d'API App Store Connect utilisée par la CI doit pouvoir gérer
  appareils, certificats et profils : rôle **Admin** (une clé « Gestionnaire
  d'apps » est refusée avec une erreur 403, message explicite dans le job).
- L'envoi à TestFlight (`-exportArchive`) re-signe pour la distribution App
  Store : l'appareil technique n'intervient pas dans l'app distribuée.
