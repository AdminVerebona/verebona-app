# Application mobile — builds, comptes, secrets (lot 95)

Décisions PO appliquées : M4 (projet dans `mobile/`), M6 (comptes au nom de Verebona), M7 (identifiants),
M8 (GitHub Actions, TestFlight / Google Play tests internes, production sur approbation). Aucun secret,
certificat, clé ou fichier Firebase n'est dans le dépôt : tout est déposé dans **GitHub › Settings ›
Environments**. Le PO ne lance aucune commande : il crée les comptes, dépose les valeurs et approuve les
publications.

## 1. Organisation du dépôt

```
mobile/
  package.json, package-lock.json   Capacitor 8.5.3 et plugins (versions figées)
  capacitor.config.ts               configuration unique, lue par environnement
  config/environments.mjs           préprod / prod : identifiants, noms, schémas, garde-fous
  scripts/prepare.mjs               fichiers propres à UN build (non versionnés)
  scripts/app-links.mjs             App Links Android générés depuis src/lib/mobile/app-links.ts
  www/                              pages locales : hors connexion, sonde du mode B
  android/                          projet Android (variantes Gradle preprod / prod)
  ios/                              projet iOS (Swift Package Manager, Verebona.xcconfig généré)
  ios-share-extension/              extension de partage iOS (à ajouter sous Xcode, § 6)
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
| Lancement manuel (« Run workflow ») | Choix préprod / prod, mode A / B, publication oui / non, piste prod | Choix préprod / prod, mode A / B, publication oui / non |
| Production | Environnement **protégé** `production-mobile` : rien ne part sans l'approbation d'un réviseur. Piste `internal` (version candidate) ou `production` en **brouillon** (le déploiement se confirme dans la Play Console). | Environnement **protégé** `production-mobile` : le build arrive dans TestFlight de l'app de production ; la **soumission à l'App Store** reste un geste manuel dans App Store Connect. |

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
plugin `VerebonaAuthSession.swift`) — les tests `mobile/test/gate0-config.test.mjs` signalent un oubli.

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

Choix de `APP_OAUTH_RETURN_URL` : l'adresse **https** (lien d'app vérifié) est la plus sûre ; elle exige
iOS 17.4 ou plus pour être captée par la session d'authentification d'Apple. Le **schéma privé**
(RFC 8252) fonctionne sur toutes les versions ; il reste sûr car le code reçu ne sert à rien sans le
vérificateur PKCE gardé par l'app. Une seule valeur par environnement : la retenir au Gate 0 selon la
version minimale d'iOS décidée. L'app n'a rien à reconstruire : le serveur annonce la **forme** retenue
(`https` ou `scheme`, jamais l'adresse) dans `GET /api/mobile/config` › `auth.appOAuthReturn`.

## 6. Extension de partage iOS (une fois, sur un Mac — développeur)

1. `cd mobile && VEREBONA_ENV=preprod VEREBONA_APP_ORIGIN=… npm run sync -- ios`, ouvrir
   `ios/App/App.xcodeproj` dans Xcode.
2. File › New › Target › **Share Extension**, nom `ShareExtension`, langage Swift.
3. Remplacer le `ShareViewController.swift` et l'`Info.plist` générés par ceux de
   `mobile/ios-share-extension/` ; supprimer le storyboard généré.
4. Réglages de la cible : configuration de base `Verebona.xcconfig` (comme l'app), bundle ID
   `$(PRODUCT_BUNDLE_IDENTIFIER).share`, capacité **App Groups** = `$(VB_APP_GROUP)`, iPhone uniquement.
5. Créer les identifiants `fr.verebona.app.preprod.share` et `fr.verebona.app.share` (App Groups cochés).
6. Commit du projet modifié ; la CI construit ensuite l'app et son extension.

## 7. Icônes et nom

Nom affiché : « Verebona Préprod » / « Verebona » (variantes Gradle, `Verebona.xcconfig`). Icône : celle
de Capacitor par défaut pour l'instant ; la variante préprod (`AppIcon-Preprod`, ressources Android de la
variante `preprod`) attend le visuel du PO (M7 : « différencier visuellement la préproduction »).
Génération des tailles : `npx @capacitor/assets generate` à partir d'une image 1024 × 1024 par variante.
