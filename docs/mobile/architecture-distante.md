# Application mobile — architecture de l'interface distante et audit de sécurité (lot 108G)

Version du 03/11/2026. **Décision PO du 03/11/2026 : interface distante = cible V1 iOS et Android**, elle
remplace la décision B1 du 27/10/2026 (interface embarquée, plan abandonné). Ce document décrit
l'architecture retenue pour la production, l'audit de la configuration du prototype, ce qui est
**réellement** industrialisé, ce qui ne l'est pas, et les arbitrages laissés au PO.

Documents liés : décision et classement E0–E15 `decision-interface-distante-108g.md` ; builds
`builds-et-secrets.md` ; stores `conformite-stores.md` ; recette `docs/exploitation/recette-108g-mobile-distant.md`.

---

## 0. En mots simples

- L'application affiche les écrans Verebona **depuis le serveur** de son environnement (préprod ou prod) :
  une correction d'écran est en ligne sans nouvelle version sur les stores.
- Elle n'ouvre **que** l'adresse de son environnement. Tout autre lien (site public, e-mail, téléphone)
  part dans Safari / Chrome ou l'application concernée. Aucun contenu d'un autre site ne peut parler aux
  fonctions du téléphone (scanner, fichiers, Face ID…).
- Sans réseau : un écran clair « Connexion Internet indisponible » avec « Réessayer ». Rien n'est
  consultable hors ligne (ce n'est pas promis).
- Les fonctions natives restent : Face ID, scanner, partage depuis Mail / Outlook / Photos / Fichiers,
  notifications, liens, envoi de fond.
- Il reste des points à valider sur de vrais téléphones et deux arbitrages pour le PO (§ 7).

---

## 1. Audit du prototype (`mobile/capacitor.config.ts` avant le lot 108G)

| Constat | Gravité | Preuve (lecture du code Capacitor 8.5.3 embarqué) | Traitement 108G |
|---|---|---|---|
| `server.url = <origine>/accueil` : Capacitor documente `server.url` comme « non destiné à la production » (outil de rechargement à chaud) | Majeure (support éditeur) | Documentation Capacitor ; aucun contrat de stabilité | Conservé comme **mécanisme de chargement**, mais encadré par les garde-fous ci-dessous ; risque résiduel R1 (§ 5). Voir § 2 pour le choix. |
| **Android : le chemin `/accueil` désactivait la règle d'origine du pont natif** | **Critique (démontrée)** | `Bridge.setAllowedOriginRules()` ajoute `getServerUrl()` (avec son chemin) aux règles de `WebViewCompat.addWebMessageListener`, qui n'accepte qu'une origine ; l'exception est attrapée par `MessageHandler` qui se replie sur `addJavascriptInterface(this, "androidBridge")` — **joignable depuis tout cadre et toute page chargée dans la vue** | `server.url` = **origine seule** (`serverUrl` de `environments.mjs`) ; la racine du site redirige vers l'accueil ou la connexion. Test `gate0-config` + `L108G-DIST`. |
| iOS : règle de navigation de Capacitor par **préfixe de chaîne** (`https://app.verebona.fr` accepte `https://app.verebona.fr.exemple.com`) | Majeure | `WebViewDelegationHandler.decidePolicyFor` : `navURL.absoluteString.starts(with: serverURL.absoluteString)` | Garde natif `VerebonaNavigationGuard` (origine **exacte**), consulté avant la règle de Capacitor (`shouldOverrideLoad`). |
| iOS : **cadres (iframes) de tout domaine admis** ; le gestionnaire de messages du pont est joignable depuis tout cadre | Majeure | « fallthrough to allowing it » pour toute navigation non principale ; `userContentController(_:didReceive:)` ne contrôle pas l'origine du cadre | Garde natif : cadre d'un autre domaine **refusé** ; domaines « app-bound » (WebKit n'expose scripts injectés et gestionnaires de messages qu'aux domaines déclarés) ; CSP `frame-src 'self' blob: data:` pour la vue de l'app. |
| `allowNavigation: [host]` | Mineure | Sur Android, chaque entrée devient aussi une règle d'origine du pont ; sur iOS, comparaison d'hôte seule (tout schéma / port) | `allowNavigation: []` : rien d'autre que l'origine de `server.url`. |
| Android : WebView ancienne sans `WEB_MESSAGE_LISTENER` / `DOCUMENT_START_SCRIPT` → pont ouvert à tous les cadres et relais HTTP de Capacitor (en-têtes de sécurité du serveur remplacés) | Majeure (parc ancien) | `MessageHandler` (repli `addJavascriptInterface`), `WebViewLocalServer.handleProxyRequest` | `android.minWebViewVersion = 100` (constante `ANDROID_MIN_WEBVIEW_VERSION`) : en dessous, page locale « Mise à jour nécessaire » au lieu du site. |
| Schémas `intent:`, `javascript:`, `file:`, `content:`, schémas privés : laissés au système par Capacitor Android (`ACTION_VIEW`) | Moyenne | `Bridge.launchIntent` | Garde natif : refusés (seuls `mailto:`, `tel:`, `sms:`, `geo:`, `maps:` sont remis au système). |
| CSP du site en **observation seulement** (`Report-Only`) | Majeure (pour l'app) | `next.config.mjs` | CSP **appliquée** à la vue de l'app (agent `VerebonaApp/`) : `object-src 'none'`, `base-uri 'self'`, `frame-src 'self' blob: data:`, `frame-ancestors 'self'`, `form-action 'self'`. `script-src` non durci : risque R2. |
| `www/` contenait la sonde technique du Gate 0 (mode B) copiée dans tout binaire | Mineure | `webDir: 'www'` | Sonde déplacée dans `mobile/sonde-b/` (servie seulement en mode local, jamais distribué) ; `www/` = pages de secours. |
| Aucun contrôle empêchant d'envoyer une sonde (mode local) à TestFlight / Play | Majeure (CA02) | workflows | `checkDistribution` (readiness) + contrôle du **binaire** (`distribution-guard.mjs`) avant envoi ; production forcée en distant. |
| Extension de partage hors du projet Xcode ; ouverture de l'app par la chaîne des répondeurs ; clé unique écrasée | Majeure | `ios-share-extension/` | § 6. |

Inchangé et vérifié : `cleartext: false`, `allowMixedContent: false`, débogage de la vue coupé en
production, `CapacitorHttp` / `CapacitorCookies` coupés en mode distant (pas de relais HTTP natif),
`PrivacyScreen` (aperçu multitâche masqué), aucune sauvegarde Android, `limitsNavigationsToAppBoundDomains`
désormais activé.

---

## 2. Architecture retenue et justification

**Coque locale signée minimale + interface chargée depuis l'origine exacte de l'environnement, pont
natif réservé à cette origine.**

```
┌────────────────── Application Verebona (Capacitor 8.5.3, binaire signé) ──────────────────┐
│ Coque locale (www/) : offline.html (« Connexion Internet indisponible » / « Réessayer »),    │
│   index.html (renvoi vers l'accueil). Aucune donnée ni interface métier.                    │
│ Vue (WKWebView / Android WebView)  ── charge ──►  https://<origine de l'environnement>      │
│   · garde natif VerebonaNavigationGuard : origine exacte seulement, autre domaine → navigateur│
│   · iOS : WKAppBoundDomains = [domaine de l'environnement, localhost]                        │
│   · Android : règle d'origine du pont = origine de server.url ; WebView ≥ 100                 │
│ Pont natif (window.Capacitor) : plugins listés NATIVE_PLUGINS ; aucun ne rend de jeton       │
│ Natif : Face ID / verrou 5 min · scanner · ShareExtension + file technique · push · liens    │
│   universels / App Links · envoi de fond · Keychain / Keystore (identifiant, PKCE, biométrie) │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Pourquoi `server.url` (origine seule) et pas une autre variante :

| Variante | Pont natif sur l'interface distante | Écart à Capacitor | Retenue |
|---|---|---|---|
| A1 — `server.url` = origine, garde-fous ci-dessus | Oui, iOS et Android, limité à l'origine par WebKit / `addWebMessageListener` | Option documentée « hors production » mais code maintenu et testé par l'éditeur ; aucun patch du cœur | **Oui** |
| A2 — coque locale puis navigation vers l'origine (`allowNavigation`) | iOS : oui ; **Android : non** (le script du pont n'est injecté que pour l'origine de démarrage — `addDocumentStartJavaScript(…, singleton(appUrl))`) → il faudrait réinjecter le pont soi-même | Réimplémentation d'un mécanisme interne de Capacitor | Non (plus fragile) |
| A3 — mise à jour à distance d'une interface embarquée (Capgo, Appflow…) | — | Nouveau fournisseur, règles Apple 3.3.1(B) / 2.5.2 | Non (hors décision) |
| B — interface embarquée | — | — | Abandonnée (décision PO) |

`server.url` reste formellement « non recommandé en production » par Capacitor : c'est le **risque
résiduel R1**, accepté sur justification (le chargement distant est l'objet même de la décision PO) et
compensé par : garde natif indépendant de la règle de Capacitor, règle d'origine Android rétablie,
domaines app-bound iOS, tests du dépôt qui échouent si la configuration régresse, contrôle du binaire en
CI, et suivi de version de Capacitor (une montée de version majeure doit relancer
`mobile/test/l108g-mode-distant.test.mjs` et la recette § « navigation »).

Politique de navigation (source unique `mobile/config/navigation-policy.mjs`, appliquée par
`VerebonaNavigationGuard.swift` et `VerebonaNavigationGuardPlugin.java`) :

| Adresse | Vue principale | Cadre (iframe) |
|---|---|---|
| `https://` + hôte + port de l'environnement | chargée | chargée |
| coque locale (`capacitor://localhost`, `https://localhost`) | chargée | chargée |
| autre domaine `http(s)` (dont sous-domaine trompeur, autre port, `http`) | navigateur système | **refusée** |
| `mailto:`, `tel:`, `sms:`, `geo:`, `maps:` | application du système | refusée |
| `about:`, `blob:` (aperçu / téléchargement généré par la page) | admise | admise (`data:` aussi) |
| identifiants dans l'adresse, `javascript:`, `file:`, `intent:`, `content:`, schémas privés | refusée | refusée |

Liens externes ouverts par le code : brique générique **`src/lib/native/open-external.ts`**
(`openExternalUrl`, livrée par le lot 108H, reprise telle quelle) — `AppLauncher.openUrl` (Safari /
Chrome, hors de l'app ; jamais le plugin `Browser` intégré). Lot 108G : les liens entrants de
l'environnement exclus de l'app (offres, abonnement, administration — `APP_LINK_EXCLUSIONS`) passaient
par `Browser.open` (SFSafariViewController / Custom Tabs, **dans** l'app) ; ils s'ouvrent désormais dans
le navigateur système par cette brique. Le contrôle de légitimité reste à l'appelant (`resolveAppUrl`,
liste juridique de 108H).

---

## 3. Sessions, authentification, Face ID (inchangés, vérifiés)

- Sessions : cookies **HttpOnly**, `Secure`, `SameSite=Lax` de **même origine** que l'interface (lots 37,
  53A, 92) ; renouvellement, rotation, détection de rejeu, révocation par `sid` et « Appareils connectés »
  inchangés. CSRF par origine (`src/lib/csrf.ts`) : les requêtes de la vue portent l'origine de
  l'environnement → aucune adaptation, aucun assouplissement.
- Google / Apple (M1, B4) : navigateur système (ASWebAuthenticationSession / Custom Tabs), PKCE,
  vérificateur au Keychain / Keystore, retour `APP_OAUTH_RETURN_URL = fr.verebona.app[.preprod]:/oauth`
  validé par `resolveAppUrl` — **non modifié** par ce lot.
- Face ID / verrou (lot 107A : `src/lib/native/unlock-*.ts`, `lock-boot.ts`, `app-lock.ts`) : **non
  modifiés**. Les éléments partagés attendent le déverrouillage avant d'être proposés.
- Liens universels / App Links : `resolveAppUrl` + `npm run check:links` inchangés (vérifié).

---

## 4. Réseau et interruptions

| Situation | Comportement | Où |
|---|---|---|
| Lancement sans réseau, serveur muet | page locale « Connexion Internet indisponible » (ou « Service momentanément indisponible ») + « Réessayer » ; reprise automatique au retour du réseau | `www/offline.html`, `offline.js`, `server.errorPath` |
| WebView Android < 100 | page locale « Mise à jour nécessaire » (Android System WebView) | `minWebViewVersion` |
| Perte du réseau dans l'app | bandeau « Connexion Internet indisponible — rien n'est perdu » + « Réessayer » (nouvelle mesure, **sans recharger** : saisies conservées) | `NativeBridgeRuntime.tsx` |
| Coupure pendant un envoi | file de dépôt idempotente (`operationId`, lot APP-PERF-30) : état « échec » explicite + « Reprendre », **aucun doublon** ; confirmation rejouée sans renvoi | `src/lib/upload-queue.ts`, `native-upload.ts` (message corrigé : plus de promesse de reprise automatique) |
| App tuée pendant un envoi | à la réouverture : « interrompu » (fichier à resélectionner) ou confirmation seule si transféré — jamais de faux succès | `upload-queue.ts` |
| Coupure / fermeture pendant un scan | le scanner est local ; un scan interrompu n'est pas proposé (rien n'est créé) | `scan.ts` |
| Partage reçu sans réseau, app verrouillée ou sans session | l'élément attend dans la **file technique** ; proposé après Face ID / connexion ; message « Connectez-vous pour importer… » | `share-inbox.ts` |

La file technique des partages n'est **pas** un mode hors connexion métier : elle ne contient que des
fichiers en cours d'import, rien n'est consultable sans le serveur.

---

## 5. Risques résiduels (à connaître, non masqués)

| N° | Risque | Effet possible | Parade en place | Reste à faire |
|---|---|---|---|---|
| R1 | `server.url` « non destiné à la production » selon Capacitor | Changement de comportement lors d'une montée de version | Garde natif indépendant, tests qui échouent si la configuration régresse, contrôle du binaire | Revue à chaque montée de version Capacitor |
| R2 | `script-src` de la CSP non durci (scripts en ligne de Next.js) : une faille XSS du site s'exécuterait avec accès au pont | Accès au scanner / fichiers / partage pendant la session | Plugins limités (`NATIVE_PLUGINS`), aucun ne rend de jeton de session ; cadres tiers refusés ; validation des liens | Lot dédié : CSP à nonces pour Next.js (impact site entier) |
| R3 | Domaines « app-bound » iOS et garde natif **non éprouvés sur appareil** ici (pas de Mac) | Une fonction native ne répond pas, ou la page de secours ne s'affiche pas | Réglage documenté par Capacitor (localhost déclaré) | Recette CA03 ; repli : `limitsNavigationsToAppBoundDomains: false` (une ligne, le garde natif reste) |
| R4 | Démarrage dépendant du réseau | Lenteur sur réseau faible | Fond Sérénité, page de secours | Mesure PERF-01 en recette |
| R5 | Cookies de session dans le magasin de la WebView (pas le Keychain) | Voir A-1 | Bac à sable chiffré par le système, non sauvegardé, verrou 5 min, révocation serveur | Arbitrage A-1 |
| R6 | Fichiers partagés Android : copies dans le cache de l'app, purgées par le plugin après 24 h lors d'un nouveau partage | Un partage non importé sous 24 h peut devenir illisible | Message explicite « fichier plus disponible… partagez-le de nouveau » (jamais silencieux) | — |
| R7 | Compilation iOS / Android non faite ici (pas de Mac ni de SDK) | Erreur de compilation Swift / Gradle au premier run | Structure Xcode analysée par test, code relu | Premier run CI |

---

## 6. Extension de partage iOS (ticket « Partage iOS vers Verebona »)

- **Cible versionnée** `ShareExtension` dans `mobile/ios/App/App.xcodeproj` (sources
  `mobile/ios/App/ShareExtension/`), embarquée par la phase « Embed Foundation Extensions », dépendance
  de la cible App, configurée par `Verebona.xcconfig` : identifiant `$(VB_SHARE_EXTENSION_ID)` =
  `<identifiant de l'app>.ShareExtension`, droits propres (groupe `$(VB_APP_GROUP)`), signature
  automatique, iPhone. Préprod et prod : mêmes fichiers, valeurs de l'environnement.
- **Contrôle CI** avant TestFlight : `App.app/PlugIns/ShareExtension.appex` présent, identifiant dérivé,
  groupe d'apps présent dans les droits **signés** de l'app et de l'extension.
- **Formats** : PDF, JPEG, PNG, WEBP tels quels ; HEIC / HEIF (ou autre image) **convertis en JPEG**
  (ImageIO, qualité maximale, orientation et métadonnées conservées) et **signalés** ; 10 fichiers par
  partage ; tout autre format refusé avec nom et motif. Activation : prédicat « au moins un PDF ou une image ».
- **Conformité Apple** : l'extension n'ouvre pas l'application (plus de chaîne des répondeurs ni
  d'`UIApplication.open`) ; elle copie, confirme « Document prêt à importer dans Verebona » (jamais
  « enregistré ») et se ferme sur « OK ». Aucun réseau, aucune session dans l'extension.
- **File technique** (groupe d'apps, `partages-v1/<id>/` + `manifest.json`) : un élément par partage,
  écrit sous un nom provisoire puis renommé d'un coup ; protection de fichier « complète » ; exclu des
  sauvegardes ; 20 éléments au plus (au-delà : refus explicite dans l'extension).
- **Reprise** (`src/lib/native/share-inbox.ts`, plugin local `VerebonaShareInbox`) : à l'ouverture / au
  retour au premier plan, après Face ID et connexion, l'élément le plus ancien est ouvert dans le
  **formulaire d'ajout habituel** (aperçu, retrait d'un fichier, confirmation, garde d'écriture et quotas,
  file de dépôt, T1). L'élément est effacé quand l'ajout est confirmé (ou ses fichiers remis à la file
  de dépôt, qui a sa propre reprise sans doublon) ; formulaire fermé, quota refusé : il reste et un
  bandeau propose « Importer » / « Abandonner » (abandon = copies effacées).
- **Isolation par compte** : le premier compte à qui l'élément est proposé le prend ; un autre compte
  connecté ensuite ne le voit pas ; à la **déconnexion explicite** de ce compte, ses éléments sont
  effacés. Une session simplement expirée les conserve (reconnexion). Purge automatique après 7 jours,
  signalée.
- **Android** (hors ticket iOS, même file) : intents `SEND` / `SEND_MULTIPLE` reçus même app fermée
  (Capacitor transmet l'intent de lancement), références persistées avant toute autre action.

---

## 7. Arbitrages à valider par le PO

| N° | Question | Options | Recommandation |
|---|---|---|---|
| **A-1** | B2 (27/10) exigeait la session au Keychain / Keystore, dans le cadre de B1. En mode distant, la session est dans des cookies HttpOnly du magasin de la WebView. | (a) Accepter pour la V1 cet « équivalent » (AUTH-08) : bac à sable chiffré, non sauvegardé, non lisible du JavaScript, verrou 5 min, révocation serveur ; (b) jeton de renouvellement au Keychain / Keystore lié à une clé d'appareil, réinjecté par la coque (adaptation de E4, ≈ 10 à 14 j dont 6 à 8 serveur, changement de sécurité sensible) | (a) pour la V1, (b) inscrit comme lot ultérieur. **L'exigence n'est pas supprimée** : elle reste ouverte tant que le PO n'a pas tranché. |
| **A-2** | Durcir `script-src` (risque R2) | (a) CSP à nonces pour tout le site (lot dédié, impact web) ; (b) accepter le risque pour la V1 avec les parades listées | (a) avant l'ouverture publique si possible, sinon (b) documenté |
| A-3 | Version minimale WebView Android | 100 (défaut) ou autre | 100 (Chrome / WebView mis à jour par Google Play depuis 2022) |
| A-4 | Conservation des partages non importés | 7 jours (défaut, `SHARE_INBOX_TTL_MS`) | 7 jours |

Aucun réglage ci-dessus n'est présenté comme validé sur appareil : la preuve est la recette
`docs/exploitation/recette-108g-mobile-distant.md`.
