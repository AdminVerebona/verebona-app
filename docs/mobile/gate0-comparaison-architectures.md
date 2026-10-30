# Gate 0 — comparaison des architectures de mutualisation de l'interface (lot 95)

> **DÉCISION PO B1 du 27/10/2026 : option B retenue** — application hybride avec **interface mobile
> embarquée** et composants natifs ciblés (pas une WebView du site distant). Décisions liées : **B2**
> session au Keychain / Android Keystore (§ 5 : « jeton mobile », désormais requis), **B3** code du
> téléphone après 5 minutes sans biométrie (§ 10 n° 2), **B4** retour Google / Apple par le schéma
> `fr.verebona.app[.preprod]://retour`. La proposition « A renforcé » ci-dessous (§ 0, § 7.2) **n'est pas
> retenue** ; ce document reste la trace de l'analyse et de l'inventaire du code. Plan du lot :
> `docs/mobile/plan-architecture-embarquee.md`. Le mode A du prototype reste utilisable pour le
> diagnostic, il n'est plus la cible.

Référence : CDC 12 « Application mobile iOS & Android V1 » §3 et §3.2 (G0-01 à G0-10) ; décisions PO
du 26/10/2026 M1 à M10 (elles priment) ; CDC 18 (sessions, Google / Apple). Statut : **document de
qualification**. Il ne fige rien : le choix définitif est pris par le PO après les essais sur vrais
téléphones (M5, M10). Aucune industrialisation n'est engagée avant cette validation.

Documents liés : grille de recette `docs/mobile/gate0-grille-recette.md` ; builds, comptes et secrets
`docs/mobile/builds-et-secrets.md` ; statut exigence par exigence `docs/exploitation/cdc12-mobile-ecarts.md` ;
socle serveur `docs/exploitation/application-mobile-serveur.md`.

---

## 0. En mots simples (pour le PO)

- Il y a quatre façons de faire l'application en réutilisant l'interface du site : **A** l'application
  affiche le site Verebona dans un cadre sécurisé ; **B** l'interface est copiée dans l'application et
  ne demande au serveur que les données ; **C** un mélange des deux ; **D** tout réécrire (écarté sauf
  échec démontré, comme vous l'avez demandé).
- Nous avons examiné le code réel. **B est possible mais coûteux** : le site utilise des fonctions du
  serveur (pages protégées, redirections, sécurité de connexion par cookies) qui ne se copient pas
  telles quelles dans une application. Il faudrait un deuxième « montage » de l'interface, changer la
  façon dont la connexion est conservée (point sensible pour la sécurité), et publier une nouvelle
  version sur les stores à chaque changement d'écran. Estimation : 6 à 9 semaines de développement, puis
  un surcoût permanent à chaque évolution du site.
- **A ne demande presque aucune duplication** et profite immédiatement de chaque mise à jour du site.
  Ses risques sont connus et mesurables : acceptation par Apple, comportement sans réseau, conservation
  de la connexion, sécurité du pont entre le site et le téléphone.
- **Notre proposition** : retenir **A « renforcé »** pour la V1, **à condition** que le Gate 0 le prouve
  sur de vrais iPhone et Android (liste de preuves au § 8). Si une preuve échoue (refus Apple, perte de
  connexion, sécurité), on bascule vers B avec le plan décrit au § 7.3. Le prototype livré contient déjà
  les fonctions natives communes aux deux (scan, partage, notifications, liens, verrouillage, connexion
  Google / Apple) : elles ne seront pas refaites.
- Trois décisions simples vous seront demandées après les essais (§ 10).

---

## 1. Ce que les décisions imposent à l'architecture

| Décision | Conséquence pour le choix d'architecture |
|---|---|
| M5 | Interface et règles mutualisées. Évaluer **en priorité** l'interface embarquée (B) ; chargement distant (A) permis pour les prototypes, **pas adopté automatiquement** en production ; pas de réécriture native (D) sans preuve du besoin. |
| M1 | Google / Apple dans l'app, **par le navigateur système** (jamais dans la vue de l'app), même compte que sur le site. |
| M2 | « Appareils connectés » identique web / mobile, registre unique du lot 92 ; un jeton push n'est pas une session. |
| M3 | Aucun Web Push : notifications natives seulement. |
| M4 | Tout dans `mobile/`, sans régresser la CI ni la livraison du site ; une mise à jour web ne doit pas imposer systématiquement une soumission aux stores. |
| M7 | `fr.verebona.app` (« Verebona ») et `fr.verebona.app.preprod` (« Verebona Préprod »), installables ensemble, strictement isolés, sans bascule par l'utilisateur. |
| M8 | GitHub Actions (macOS pour iOS, Linux pour Android), TestFlight / Google Play tests internes, production sur approbation explicite. |
| M9 | VisionKit (iOS) et ML Kit Document Scanner (Android), PDF multipage, parcours documentaire existant. |
| M10 | Tests techniques par le développeur sur vrais appareils, validation finale du PO. |

---

## 2. Inventaire du code réel (branche l95, base lot 93 + 97)

Mesures faites sur le dépôt (`src/`), pas des hypothèses.

| Élément | Constat | Effet sur l'architecture |
|---|---|---|
| Cadre | Next.js 15.5, **App Router**, React 19, Tailwind 4. | Le rendu et le routage sont ceux de Next.js. |
| Pages | 85 pages : 44 d'administration (hors app), **41 utilisateur**. 58 des 85 commencent par `'use client'`. | L'essentiel de l'interface est **déjà exécuté dans le navigateur**. |
| Pages serveur côté utilisateur | 9 : `/` (lit les cookies puis redirige), `/signup` (lit la base : invitations de prélancement), `/documents` et `/accueil/a-traiter` (métadonnées + composant client), 5 redirections d'anciens liens. | Non exportables tels quels ; faciles à transposer une à une. |
| Mises en page | 3 `layout.tsx` serveur (racine avec métadonnées, `(auth)`, `(dashboard)`), qui ne font qu'envelopper des composants clients (`ClientShell`, `DashboardLayout`). | Transposables. |
| Actions serveur | **0** fichier `'use server'` ; 1 seul `next/headers` hors API (`/`). | Bon point pour B. |
| Routes dynamiques utilisateur | 10 (`/assets/[id]`, `/assets/[id]/edit`, `/assets/[id]/exports/[dossier]`, `/documents/[id]`, `/duo/join/[token]`, `/transmission/[token]`, `/fournisseurs/[id]`, `/duos/[id]/…`, `/mon-compte/abonnement/gerer/[compte]`), **aucun `generateStaticParams`**. | Un export statique n'est pas possible sans réécrire ce routage (identifiants inconnus au build). |
| API | **457 routes** `src/app/api/**/route.ts` + 6 routes hors `/api` (fichiers d'association, CGVU, aide, `/r/[code]`). | Restent sur le serveur dans toutes les options. |
| Middleware | `src/middleware.ts` : pages protégées (redirection vers `/login?returnUrl=…`, page servie si renouvellement possible), **CSRF par origine** sur toute écriture, version minimale mobile (426), CORS limité au site vitrine. | Ne s'exécute pas dans une interface embarquée ; la protection CSRF **refuse** une écriture sans `Origin` du site (cas de B). |
| Appels d'API | `apiClient` (123 fichiers) **et** `fetch('/api/…')` relatif direct dans **71 fichiers (132 appels)** ; 9 liens / ouvertures directes vers `/api/…`. | En B, chaque adresse relative viserait l'app elle-même : il faut une adresse de base partout. |
| Session | Cookies **HttpOnly SameSite=Lax** (accès 15 min, renouvellement 30 j, rotation, détection de rejeu — lots 37, 53A, 92) ; `/api/auth/refresh` lit **exclusivement** le cookie ; le middleware et `SessionService` acceptent aussi `Authorization: Bearer` pour le jeton d'accès. Émission unique `issueSession` (lot 92). | A : fonctionne tel quel (même origine). B : cookies d'un autre site → bloqués par WebKit ; il faut un autre transport de session (côté serveur sensible). |
| Google / Apple | Lot 93 : parcours `client=app` (PKCE de l'app) → retour `APP_OAUTH_RETURN_URL?handoff=…` → `POST /api/auth/oauth/app/exchange` qui ouvre la session par `issueSession`. | Conçu pour une vue de **même origine** (A) ; en B l'échange devrait rendre un jeton au lieu de cookies. |
| Navigateur | Service worker PWA (`/sw.js`), PDF.js (worker servi depuis `public/`), 78 usages de `localStorage` (préférences, file de dépôt **sans jeton**), 65 de `window.location`, 2 `next/image`, en-têtes de sécurité (CSP en observation, `frame-ancestors`) posés par `next.config.mjs`. | En B : worker PDF à embarquer, en-têtes de sécurité à reproduire, images non optimisées. |
| Parcours commerciaux | Pages Offres, Abonnement, `abonnement/*`, Stripe. | À masquer dans l'app **quelle que soit l'option** (COM-01/05, STORE-08). |
| Socle mobile déjà livré | Lot 97 : en-têtes `X-Verebona-*`, `/api/mobile/config` (versions minimales, interrupteurs), registre push FCM, fichiers d'association par environnement, écran « Mise à jour requise ». Lot 92 : registre des sessions, « Appareils connectés ». | Réutilisés par toutes les options. |

**Conclusion de l'inventaire** : l'interface est très majoritairement cliente, donc **réutilisable** ; ce qui
empêche un export statique « universel » est concentré dans quatre points : routage dynamique, pages
serveur, middleware (protections et CSRF) et transport de la session par cookies de même origine. Il n'y a
pas d'hypothèse d'export statique universel dans ce document (exigence M5).

---

## 3. Option A — l'application affiche le site de l'environnement (WebView distante)

**Principe.** La coque Capacitor ouvre `https://<site de l'environnement>/accueil` (`server.url`). Les
fonctions natives sont exposées à la page par le pont Capacitor (`window.Capacitor.Plugins`) ; le site
les utilise via `src/lib/native/*` (sans effet dans un navigateur).

**Faisabilité au vu du code.** Immédiate : c'est le prototype livré (`VEREBONA_UI_MODE=remote`).
Middleware, pages serveur, routes dynamiques, cookies, CSRF, Google / Apple (lot 93) fonctionnent
**sans changement** car la vue est de même origine que l'API.

**Effort.** Faible et déjà engagé pour le Gate 0 : coque, configuration par environnement, intégrations
natives (≈ 10 j réalisés dans ce lot). Restent pour l'industrialisation : masquage des parcours
commerciaux dans l'app, écrans de réglage (biométrie, notifications), extension de partage iOS, icônes,
fiches stores (≈ 10 à 15 j).

**Écarts / limites.**
- `server.url` est documenté par Capacitor comme « non destiné à la production » (outil de rechargement à
  chaud) : il fonctionne, mais **aucune garantie de l'éditeur**. Sur Android, la page principale est
  relayée par le serveur local de Capacitor : la transmission des cookies sur le chargement des pages
  protégées est un **point de mesure Gate 0** (G0-02).
- Sur iOS, lire un fichier natif depuis la page distante (`convertFileSrc`) peut être refusé par WebKit :
  le prototype bascule alors sur `Filesystem.readFile` (plus lent) — à mesurer (G0-04, G0-07).
- Démarrage dépendant du réseau et du temps de réponse du serveur (PERF-01 < 3 s à mesurer) ; sans
  réseau, page locale « Connexion Internet requise » (`www/offline.html`, `server.errorPath`).

**Risques.**
- **Sécurité (SEC-05, SEC-06)** : du code servi par le site s'exécute avec accès aux plugins natifs. Une
  faille XSS ou une compromission du serveur donnerait accès au scanner, aux fichiers, au stockage
  sécurisé de l'app. Mesures : navigation limitée au domaine de l'environnement (`allowNavigation`),
  plugins strictement nécessaires, **aucun plugin qui rende un secret de session au JavaScript**, CSP à
  passer en mode bloquant au moins pour l'app, liens entrants validés (`lib/native/deep-links.ts`).
- **Cookies et Keychain (AUTH-08, G0-08)** : les jetons restent dans le magasin de cookies de la WebView
  (fichier du bac à sable de l'app, protégé par le chiffrement du système, exclu des sauvegardes —
  `allowBackup=false` sur Android), **pas dans le Keychain / Keystore**. AUTH-08 admet « ou
  équivalent », G0-08 cite Keychain / Keystore : **écart à arbitrer** (§ 5, décision n° 1).
- **OAuth (M1)** : respecté — navigateur système, retour par lien d'app ou schéma privé, PKCE de l'app
  (§ 6).
- **Liens universels** : fichiers d'association par environnement déjà servis (lot 97) ; chemins
  identiques web / app.
- **Hors connexion** : aucun mode métier hors ligne (NET-01) ; page locale explicite et reprise.
- **Stores** : Apple 4.2 « fonctionnalité minimale » vise les sites simplement « emballés ». Verebona
  apporte de vraies fonctions natives (scanner système, partage, notifications, biométrie, envoi de
  fond, liens universels), ce qui est le cas usuel d'acceptation **sans le garantir** (M5). Paiement :
  aucune page d'achat ni lien Stripe dans l'app (règle 3.1.1) — masquage nécessaire dans toutes les options.

**Adaptations nécessaires (production).** CSP bloquante pour l'app ; masquage COM-01 ; décision G0-08 ;
mesure du démarrage ; surveillance des échecs de chargement distant ; interrupteurs serveur déjà
disponibles (`MOBILE_FEATURES_OFF`) ; version minimale (lot 97).

---

## 4. Option B — interface embarquée localement, appelant l'API

**Principe.** L'interface React est compilée et **livrée dans le binaire** (`www/`), servie par la WebView
sous `capacitor://localhost` (iOS) / `https://localhost` (Android) ; elle appelle l'API du serveur de
l'environnement.

**Faisabilité au vu du code.** Possible, **pas en l'état** :

1. `output: 'export'` de Next.js refuse le middleware, les pages serveur lisant cookies / base, et les
   10 routes dynamiques sans liste d'identifiants. Il faut un **second point d'entrée** « coquille
   cliente » : routes dynamiques passées en paramètres (`/assets?id=…`) ou routeur client unique,
   équivalents clients des 9 pages serveur, protections de pages côté client (le serveur restant juge).
2. **Adresse de base de l'API** à introduire dans `apiClient` **et** dans 71 fichiers d'appels directs
   (132 `fetch('/api/…')`) + 9 liens directs.
3. **Session** : depuis `capacitor://localhost`, les cookies du site sont des cookies **tiers** — bloqués
   par WebKit (iOS) et refusés par `SameSite=Lax`. Il faut soit passer toutes les requêtes par la pile
   native (`CapacitorHttp` + magasin de cookies natif — testé par la sonde du prototype), soit un **jeton
   mobile** (§ 5). Dans les deux cas : **la protection CSRF actuelle refuse les écritures** (requête sans
   `Origin` du site, ou origine `capacitor://localhost`) → modification de `src/lib/csrf.ts` et du
   middleware, et `/api/auth/refresh` doit accepter un jeton hors cookie. Ce sont des changements de
   **sécurité** à concevoir avec soin (lots 37, 53A, 92).
4. **Google / Apple** : l'échange du lot 93 pose des cookies ; il faudrait une variante rendant un
   jeton à l'app (même émission `issueSession`, autre dépôt).
5. Worker PDF.js, polices, icônes, en-têtes de sécurité à embarquer / reproduire ; `next/image` non optimisé.

**Effort.** Estimation : 30 à 45 j de développement pour la première version (coquille cliente,
routage, adresse de base, transport de session et CSRF, tests de sécurité), **puis un coût permanent** :
chaque évolution du site doit rester compatible avec le second montage (une nouvelle page serveur
casse l'app), et chaque changement d'écran exige **une nouvelle soumission aux stores** — en
contradiction avec M4 — sauf mise à jour « à distance » du JavaScript (service tiers type Capgo / Appflow :
nouveau fournisseur, et règles Apple 3.3.1(B) / Google à respecter).

**Écarts / limites.** Compatibilité des versions : une interface embarquée N parlera à une API N+k
(VER-05 devient bloquant à chaque évolution d'API). Les liens web et les écrans de l'app peuvent
diverger.

**Risques.** Sécurité du pont **meilleure** (seul le code signé du binaire a accès aux plugins) ; sécurité
de session **plus délicate** (nouveau transport, CSRF assoupli). OAuth M1 : identique à A côté navigateur.
Liens universels : identiques. Hors connexion : **meilleur** (la coquille s'affiche toujours, écrans
d'attente propres). Stores : 4.2 jugé sur l'expérience, pas sur l'origine du code — même exposition que
A, légèrement plus favorable (démarrage instantané, écrans natifs d'erreur).

**Adaptations nécessaires.** Celles des points 1 à 5, plus une chaîne de build web → mobile dans la CI
mobile et des tests de non-régression des deux montages.

---

## 5. Session : cookies de la WebView ou jeton mobile ?

| | Cookies HttpOnly de la WebView (A, prototype) | Jeton mobile au Keychain / Keystore (B obligatoire, A optionnel) |
|---|---|---|
| Où est le jeton | Magasin de cookies de la WebView (bac à sable, chiffré par le système, non sauvegardé) | Keychain (`whenUnlockedThisDeviceOnly`) / Keystore matériel |
| Lisible par le JavaScript | Non (HttpOnly) | Non, si seul le code natif le manipule |
| Émission | `issueSession` (lot 92) inchangé | `issueSession` avec un **dépôt différent** (corps chiffré pour l'app au lieu de `Set-Cookie`) |
| Renouvellement | `/api/auth/refresh` tel quel (rotation, rejeu) | Variante native du renouvellement (même rotation, même `sid`, même registre) |
| CSRF | Inchangé | À adapter (requêtes natives sans `Origin`) |
| G0-08 | **Écart** si lecture stricte (« Keychain / Keystore ») ; conforme à AUTH-08 si « équivalent » admis | Conforme |
| Changement serveur | Aucun | Oui (sensible) |

**Proposition de jeton mobile (non implémentée, faute d'être indispensable au Gate 0).** Si le PO exige
Keychain / Keystore au sens strict, ou si B est retenu :
1. à la première ouverture, l'app crée une **paire de clés non exportable** (Secure Enclave / Keystore
   StrongBox) et enregistre la clé publique avec son `installationId` (table du lot 97) ;
2. la connexion (mot de passe, lien e-mail, échange Google / Apple) passe par **la même émission
   `issueSession`**, variante de dépôt « application » : le jeton de renouvellement est rendu **chiffré
   pour la clé de l'appareil**, jamais en clair au JavaScript ; le jeton d'accès (15 min) reste un cookie
   (A) ou un en-tête `Bearer` déjà accepté par le middleware (B) ;
3. le renouvellement natif présente le jeton **signé par la clé de l'appareil** (preuve de possession) :
   un jeton copié hors du téléphone ne sert à rien ; rotation, détection de rejeu, `sid` et registre
   des sessions restent ceux du lot 92 (« Appareils connectés » M2 inchangé) ;
4. un point unique côté serveur (`session-issuance.ts`) — comme l'annonçait déjà son en-tête.
Estimation : 8 à 12 j (serveur + natif + tests de sécurité). **Pourquoi pas maintenant** : le Gate 0 doit
d'abord trancher l'architecture ; en A le modèle cookies est fonctionnel et mesurable (G0-02, G0-08) ;
coder ce transport sans décision ferait toucher la sécurité des sessions pour rien si le PO accepte
l'« équivalent ».

Ce que le prototype range **déjà** au Keychain / Keystore : identifiant d'installation, préférence
biométrique, vérificateur PKCE du parcours Google / Apple (`src/lib/native/secure-store.ts`). Aucun mot
de passe n'est stocké (AUTH-07). À la réinstallation, les valeurs héritées du Keychain sont effacées
(AUTH-13).

---

## 6. Ce qui est commun à toutes les options (livré dans le prototype)

Module partagé `src/lib/native/*` (aucun effet dans un navigateur — testé) + projet `mobile/` :

| Fonction | Réalisation | Exigences |
|---|---|---|
| Détection de la coque, accès aux plugins | `bridge.ts` (via `window.Capacitor`, **aucune dépendance npm côté site**) | SEC-06 |
| En-têtes `X-Verebona-*` dès la 1re requête | marqueur `VerebonaApp/<version> (<build>; <env>)` ajouté à l'agent utilisateur au build → `shell-info.ts` → contrat `VerebonaNative` du lot 97 | API-02, VER-01 |
| Isolation préprod / prod | environnement figé au build ; contrôle `environment` de `/api/mobile/config` → écran bloquant si discordance ; build refusé si l'adresse ne correspond pas | §27, M7, REC-063/064 |
| Stockage sécurisé | `secure-store.ts` (Keychain `whenUnlockedThisDeviceOnly` / Keystore) | AUTH-07/08, G0-08 (partiel, § 5) |
| Verrouillage 5 min, biométrie facultative, aperçu masqué | `app-lock.ts`, écran de verrouillage, plugin `PrivacyScreen` | AUTH-05/06/09/15, REC-056/057/058 |
| Google / Apple | `oauth.ts` : ASWebAuthenticationSession (plugin local iOS `VerebonaAuthSession.swift`), Custom Tabs (Android), PKCE, échange lot 93 | M1, MOB-10 |
| Liens universels / App Links | validation unique `deep-links.ts` ; intent-filters Android **générés** depuis `src/lib/mobile/app-links.ts` (`npm run sync:links`) | §19, SEC-04 |
| Push FCM | `push.ts` : autorisation sur action, enregistrement `/api/mobile/push-installations`, ouverture de l'écran ciblé, désinscription à la déconnexion | PUSH-01..09, AUTH-10, M2, M3 |
| Scanner natif → PDF | `scan.ts` (VisionKit / ML Kit via `@capgo/capacitor-document-scanner`, PDF sans recompression) → formulaire d'ajout habituel | SCAN-01..03, M9 |
| Partage entrant | `share-in.ts` + extension iOS (`mobile/ios-share-extension/`, à ajouter sous Xcode) + intents Android | IMP-02..06, G0-07 |
| Envoi de fond | `native-upload.ts` (URLSession background / service Android) branché sur la file idempotente existante | UPL-01..10, G0-04/05 |
| Hors connexion | page locale `www/offline.html` + bandeau « Connexion Internet requise » | NET-01/02 |

Ces briques fonctionnent à l'identique en A et en B : le choix d'architecture ne les remet pas en cause.

---

## 7. Comparaison et proposition

### 7.1 Synthèse

| Critère | A distant | B embarqué | C hybride | D natif |
|---|---|---|---|---|
| Duplication de l'interface (G0-10) | Aucune | Second montage du même code | Faible | Totale |
| Effort initial | Faible (≈ 20 j au total) | Élevé (≈ 30-45 j de plus) | Moyen | Très élevé |
| Coût à chaque évolution du site | Nul | Élevé (compatibilité + soumission) | Moyen | Très élevé |
| Mise à jour sans store (M4) | Oui | Non (sauf service tiers) | Partiel | Non |
| Session / sécurité de connexion | Inchangée (même origine) | À refaire (sensible) | Comme A | À refaire |
| Pont natif exposé au contenu distant | Oui → durcissement | Non | Partiel | Non |
| Hors connexion | Page locale | Coquille toujours disponible | Coquille + écrans distants | Natif |
| Démarrage | Dépend du réseau | Instantané | Rapide | Instantané |
| Stores (4.2) | Exposé, mitigé par les fonctions natives | Légèrement plus favorable | Comme A | Favorable |
| Garantie éditeur Capacitor | `server.url` « hors production » | Standard | Variable | — |

**Option C** (coquille locale + écrans distants dans la même vue) n'apporte pas d'avantage net avec
Capacitor : sur Android, le pont natif n'est injecté que pour l'origine configurée, si bien que des écrans
distants ouverts depuis une coquille locale perdent l'accès aux plugins ; la variante réaliste de C est
« A + pages locales de secours » (démarrage, hors connexion, mise à jour requise), **déjà présente dans le
prototype** (`server.errorPath`, écrans locaux).

**Option D** (React Native / natif) : pour mémoire, écartée par le CDC et M5 sauf échec démontré.

### 7.2 Proposition pour la production (non retenue — décision B1 : option B)

**Retenir A « renforcé » pour la V1**, **sous condition** que le Gate 0 apporte les preuves listées au § 8.
Arguments :
1. **Mutualisation maximale sans refonte** (M5, G0-10) : 0 écran dupliqué ; B demanderait un second
   montage et des changements de sécurité de session disproportionnés pour une V1.
2. **Livraison du site inchangée et immédiate** (M4) : une correction d'écran n'impose pas de soumission.
3. **Sécurité de session éprouvée** : les mécanismes des lots 37, 53A, 92 et 93 (rotation, rejeu,
   registre, révocation, échange Google / Apple) s'appliquent tels quels.
4. **Risques mesurables et réversibles** : chacun a une preuve Gate 0 et un plan de repli.

Durcissements **obligatoires** avant production si A est retenu : CSP en mode bloquant au moins pour les
clients de l'app ; liste blanche de plugins figée ; aucun plugin rendant un secret au JavaScript ; masquage
des parcours commerciaux (COM-01/05) ; décision G0-08 appliquée (§ 5) ; mesure du démarrage ; suivi des
échecs de chargement distant ; extension de partage iOS.

### 7.3 Conditions de bascule vers B (et préparation « sans regret »)

Basculer vers B si, au Gate 0 : refus Apple au titre de 4.2 (dès la revue TestFlight externe) ; perte ou
incohérence de session sur Android due au relais de `server.url` non corrigeable ; exigence PO de
fonctionnement hors ligne au-delà de l'écran explicite ; démarrage > 3 s non améliorable.
Travaux utiles aux deux options, à faire **quoi qu'il arrive** pendant l'industrialisation : faire passer
les 132 `fetch('/api/…')` directs par `apiClient` (une seule adresse de base possible) ; supprimer la
dépendance des pages à des segments dynamiques côté serveur quand c'est simple ; garder les nouvelles
pages en composants clients.

---

## 8. Plan de qualification Gate 0

Rôles (M10) : le **développeur** prépare les versions installables, mène les tests techniques sur vrais
iPhone et Android, fournit les preuves, corrige et reteste ; le **PO** teste l'expérience sur son
téléphone et prononce la validation finale. Grille : `docs/mobile/gate0-grille-recette.md`.

1. **Préalables (PO, M6)** : comptes Apple Developer et Google Play Console au nom de Verebona, projets
   Firebase préprod / prod, environnements GitHub (`docs/mobile/builds-et-secrets.md`).
2. **Builds** (GitHub Actions) : `Verebona Préprod` en **mode A** (iOS + Android) ; un build de la **sonde
   B** (`ui_mode=local`) pour mesurer cookies, CSRF et persistance sur appareil ; distribution TestFlight
   (interne **et** un groupe externe pour obtenir la revue bêta d'Apple, premier signal 4.2) et Google Play
   tests internes.
3. **Tests techniques (développeur)** : G0-01 à G0-10, M1, M2, M9, plus les mesures propres à A :
   cookies après arrêt forcé / redémarrage du téléphone ; chargement d'une page protégée après 15 min
   (Android, relais `server.url`) ; démarrage à froid (chronomètre) ; violations CSP observées dans l'app ;
   lecture de fichiers natifs depuis la page distante (iOS) ; envoi de fond app tuée.
4. **Recette PO** : parcours réels sur son téléphone (connexion, scan, partage, notification, lien
   e-mail, coupure réseau, verrouillage) ; validation ou réserves.
5. **Décision d'architecture** : A confirmée, ou bascule B selon § 7.3 ; décisions du § 10.
6. **Sortie** : aucune anomalie critique ou majeure ouverte sur les parcours visés ; PV de validation PO.

---

## 9. Écarts et risques restant après ce lot

| Sujet | État | Suite |
|---|---|---|
| Compilation iOS / Android | Projets générés et configurés **sans compilation** (pas de Mac ni de SDK Android ici) | 1er passage CI ; corrections éventuelles du code natif (Swift, Gradle) |
| Extension de partage iOS | Code fourni, **cible Xcode à créer sur un Mac** (procédure dans builds-et-secrets.md) | Gate 0 |
| Envoi de fond, app tuée par le système | Transfert natif continue ; la **confirmation** n'a lieu qu'à la réouverture et la file actuelle demande alors de resélectionner le fichier (UPL-08) | Si G0-05 l'exige : persister le chemin du fichier natif et confirmer à la reprise |
| Icônes préprod | Icône identique (copie) en attendant le visuel « Préprod » | Fournir l'icône (M7) |
| Masquage des achats dans l'app (COM-01) | Non fait (indépendant de l'architecture) | Industrialisation |
| Lier Google / Apple depuis Mon compte dans l'app | Le parcours de liaison du site s'ouvrirait dans la vue de l'app (refusé par Google) | Industrialisation : variante `client=app` de la liaison, ou renvoi vers le site |
| G0-08 au sens strict | Cookies dans le magasin de la WebView | Décision n° 1 (§ 10) |
| Réglage « Déverrouiller avec Face ID / empreinte » | Fonction prête (`setBiometricsEnabled`), écran Mon compte › Sécurité à brancher | Industrialisation (bloc biométrie du CDC 18 §27) |

---

## 10. Décisions à demander au PO (après les essais)

> **Tranchées le 27/10/2026** : n° 1 → **Keychain / Keystore exigé** (B2) ; n° 2 → **code du téléphone**
> (B3, réglage `UNLOCK_WITHOUT_BIOMETRICS = 'device_credential'` déjà en place) ; n° 3 → **option B**
> (B1). Mise en œuvre : `docs/mobile/plan-architecture-embarquee.md`.

1. **Connexion conservée sur le téléphone** : accepter que la connexion soit gardée dans l'espace
   protégé de l'application (comme le fait le navigateur, chiffré par le téléphone, non sauvegardé) ?
   Ou exiger le coffre-fort du téléphone (Keychain / Keystore) — environ 2 semaines de plus, avec un
   changement côté serveur ?
2. **Verrouillage sans Face ID / empreinte** : quand l'application se verrouille après 5 minutes et que
   la biométrie n'est pas activée, demander **le code du téléphone** (proposé) ou **une nouvelle
   connexion complète** ? (Réglage unique : `UNLOCK_WITHOUT_BIOMETRICS`, `src/lib/native/app-lock.ts`.)
3. **Architecture définitive** : confirmer A « renforcé » au vu des résultats, ou demander B.
