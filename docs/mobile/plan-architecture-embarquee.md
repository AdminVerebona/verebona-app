# Plan du lot mobile — application hybride embarquée (architecture B)

Version du 29/10/2026 (chantier 100F, documentation seule : aucun code ni migration dans ce chantier).
Décisions PO du 27/10/2026 appliquées : **B1** (option B : interface mobile embarquée, composants natifs
ciblés, partage depuis d'autres applications même Verebona fermée, scanner multipage, file d'attente
locale sécurisée, état hors ligne cohérent), **B2** (session persistante au Keychain / Android Keystore),
**B3** (code du téléphone après 5 minutes quand la biométrie n'est pas activée), **B4** (retour Google /
Apple par un schéma propre à l'application, préprod et prod séparées), **A9** (aucun achat intégré), **D**
(Gate 0 et appareils physiques obligatoires ; autorisations des stores jamais présumées).

Documents d'appui : `gate0-comparaison-architectures.md` (inventaire du code, §§ 2, 4, 5), `gate0-grille-recette.md`,
`builds-et-secrets.md`, `docs/exploitation/application-mobile-serveur.md`, `docs/exploitation/guide-comptes-unique.md`,
`docs/design/brief-graphiste-icone-et-mascotte.md`.

---

## 0. En mots simples

- L'application ne se contentera pas d'afficher le site : **les écrans sont livrés dans l'application**
  (démarrage immédiat, écran propre sans réseau), et ne demandent au serveur que les données. Les règles
  métier, l'IA et les données restent **uniquement sur le serveur** : rien n'est réécrit.
- La connexion est gardée dans le **coffre-fort du téléphone** (Keychain / Keystore). Après 5 minutes en
  arrière-plan, l'application demande Face ID / empreinte si activé, **sinon le code du téléphone** ; si
  la session a été coupée côté serveur, il faut se reconnecter vraiment.
- On pourra **partager un document** vers Verebona depuis Mail, Gmail, Outlook, Photos, Fichiers… même
  application fermée. Sans réseau, le document attend dans une **file chiffrée** sur le téléphone et part
  tout seul au retour du réseau.
- Coût estimé : **74 à 113 jours de développement** (≈ 4 à 5,5 mois pour un développeur, ≈ 2,5 à 3,5 mois
  à deux), hors délais de revue des stores et de création des comptes. Contrepartie connue : une
  modification d'écran demande une **nouvelle version sur les stores** (§ 6).

---

## 1. Architecture cible

```
┌──────────────────────── Application iOS / Android (Capacitor) ─────────────────────────┐
│  Interface embarquée (www/)  ← compilée depuis les composants React existants (src/)    │
│     routeur client unique · adaptateur de navigation · apiClient (adresse de base)      │
│                    │ appels API (aucun jeton visible du JavaScript)                      │
│  Couche native « VerebonaSession » : jetons au Keychain / Keystore, en-tête Bearer,      │
│     renouvellement, verrouillage 5 min (biométrie ou code du téléphone)                 │
│  Natif ciblé : scanner multipage · import Photos / Fichiers · extension de partage iOS / │
│     intents Android · file d'attente chiffrée · envoi de fond · push FCM · liens        │
└────────────────────────────────────────┬────────────────────────────────────────────────┘
                                         │ https (environnement figé au build)
┌────────────────────────────────────────▼────────────────────────────────────────────────┐
│  Serveur Verebona (inchangé dans son rôle) : API, règles métier, T1-T6, base, sessions,   │
│  « Appareils connectés », révocations, push, versions minimales, interrupteurs          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Principes :
1. **Un seul code d'interface** : les écrans de l'application sont les composants de `src/` ; pas de
   second jeu d'écrans. Ce qui ne peut pas être embarqué (pages serveur, middleware) est transposé une
   fois, côté client, sans logique métier.
2. **Le serveur reste juge** : droits, quotas, validations, sessions. L'interface embarquée n'est qu'un
   client de l'API.
3. **Aucun secret lisible du JavaScript** : les jetons sont manipulés par la couche native (B2).
4. **Environnement figé au build** (déjà en place : `mobile/config/environments.mjs`) ; préprod et prod
   cohabitent sans rien partager.

---

## 2. Étapes du lot

Jours = jours de développement, fourchette basse – haute. « Serveur » = part du travail dans `src/`
côté API.

| Étape | Contenu | Dépend de | Jours | dont serveur |
|---|---|---|---|---|
| **E0** | Préalables : comptes (guide unique), icônes (brief graphiste), matrice d'appareils, workflows acceptant le `.p8` App Store Connect en texte brut (`ASC_API_KEY_P8` à côté de `ASC_API_KEY_P8_BASE64`), versions minimales d'OS (§ 5) | — | 2 – 3 | 0 |
| **E1** | Coquille cliente embarquée (§ 3.1) : essai technique de 2 à 3 j puis mise en œuvre ; routeur client unique, adaptateur `next/navigation` / `next/link` / `next/image`, transposition des 9 pages serveur utilisateur et des protections de pages, PDF.js, polices, CSP de l'application | E0 | 15 – 22 | 0 |
| **E2** | Adresse de base de l'API : tous les appels passent par `apiClient` (≈ 130 `fetch('/api/…')` directs à migrer + liens directs `/api/…` de téléchargement) ; règle de lint interdisant un nouvel appel direct | E0 (parallèle à E1) | 5 – 8 | 0 |
| **E3** | Retour Google / Apple (B4) : schéma `fr.verebona.app[.preprod]://retour` accepté par `src/lib/native/deep-links.ts` (cible `retour` en plus de `oauth`), déclaration iOS / Android ; échange rendant une **session d'application** (dépôt natif, § 3.3) au lieu de cookies | E4 (serveur) | 2 – 4 | 1 – 2 |
| **E4** | Session native (B2, § 3.2) : clé d'appareil non exportable, émission `issueSession` avec dépôt « application », renouvellement natif avec preuve de possession, CSRF adapté aux requêtes Bearer sans cookie, révocation, déconnexion, réinstallation | E0 | 10 – 14 | 6 – 8 |
| **E5** | Verrouillage (B3, § 3.4) : 5 min, biométrie si activée sinon code du téléphone, contrôle serveur au déverrouillage ; bloc « Biométrie » de Mon compte › Sécurité | E4 | 2 – 3 | 0 |
| **E6** | Partage entrant application fermée + file d'attente locale chiffrée + envoi de fond (§ 3.5) | E4, E2 | 10 – 15 | 1 |
| **E7** | Scanner multipage, import Photos / Fichiers, reprise après interruption (versés dans la file E6) | E6 | 3 – 5 | 0 |
| **E8** | État hors ligne cohérent (§ 3.6) | E1 | 3 – 4 | 0 |
| **E9** | Notifications natives : ouverture de l'écran ciblé dans le routeur embarqué, démarrage à froid, après déverrouillage | E1, E5 | 2 – 3 | 0 |
| **E10** | Masquage des parcours commerciaux (A9) dans l'interface embarquée ; suppression de compte accessible dans l'application (règle Apple 5.1.1(v)) ; écran « Mise à jour requise » | E1 | 4 – 6 | 0 – 1 |
| **E11** | Liens universels / App Links → écran interne du routeur embarqué | E1 | 1 – 2 | 0 |
| **E12** | Compatibilité des versions (§ 6) et CI : build de l'interface vers `mobile/www` dans les workflows, contrôle « aucun import serveur dans un composant embarqué », test d'accès de chaque page utilisateur dans la coquille, contrat des routes API utilisées par l'app | E1, E2 | 4 – 6 | 1 |
| **E13** | Icônes, notification, écran de démarrage (brief graphiste § 8) | livraison graphiste | 1 – 2 | 0 |
| **E14** | Fiches stores : confidentialité (App Store), sécurité des données (Play), captures, déclaration du service de premier plan | E10 | 3 – 5 | 0 |
| **E15** | Gate 0 « B » sur appareils physiques (§ 4), corrections, nouvelle passe, procès-verbal PO | tout | 8 – 12 | selon anomalies |
| | **Total** | | **74 – 113** | **≈ 9 – 13** |

Chemin critique : E0 → E1 (essai) → E1 + E2 en parallèle, E4 en parallèle côté serveur → E3, E5 → E6 / E7
→ E15. Les étapes E8 à E14 se glissent en parallèle. À deux développeurs (un web / serveur, un natif) :
≈ 10 à 14 semaines calendaires.

Ce qui est **déjà fait** et réutilisé (lot 95, 97) : `src/lib/native/*` (pont, stockage sécurisé,
verrouillage, scan, partage, envoi de fond, push, liens, OAuth natif), projet `mobile/` et ses variantes
préprod / prod, workflows `mobile-android.yml` / `mobile-ios.yml`, socle serveur (`/api/mobile/config`,
en-têtes `X-Verebona-*`, versions minimales, interrupteurs `MOBILE_FEATURES_OFF`, registre push, fichiers
d'association). Le mode A (`VEREBONA_UI_MODE=remote`) reste disponible pour le diagnostic, il n'est plus la
cible.

---

## 3. Conception par sujet

### 3.1 Coquille cliente embarquée (E1)

Constat du code (inventaire Gate 0) : 41 pages utilisateur, dont 32 déjà clientes ; 9 pages serveur
(`/`, `/signup`, `/documents`, `/accueil/a-traiter`, 5 redirections) ; 10 routes dynamiques sans liste
d'identifiants ; middleware (protection des pages, CSRF, version minimale) non exécuté dans une interface
embarquée ; aucun `'use server'`.

Choix par défaut (confirmé ou corrigé par l'essai technique de début d'E1) :
- **un export statique dédié** (configuration de build propre à l'application), qui ne contient **qu'une
  page coquille** ; un **routeur client unique** associe les chemins de l'application (`/accueil`,
  `/assets/:id`, `/documents/:id`…) aux composants de page existants ; mêmes chemins que le site (les
  liens universels et les notifications restent valables) ;
- un **adaptateur de navigation** fournit `useRouter`, `usePathname`, `useSearchParams`, `useParams`,
  `Link` et `Image` équivalents dans la coquille, sans modifier les composants (alias de build) ;
- les 9 pages serveur sont transposées en composants clients appelant l'API ; les protections de pages
  deviennent : « pas de session → écran de connexion » (le serveur refuse toujours les données) ;
- composants à **exclure** de l'application : tout le back-office (`/admin`), les pages commerciales
  (remplacées par l'écran d'information de A9) ;
- PDF.js, polices Figtree, icônes embarquées ; CSP de l'application posée par balise `meta` (pas
  d'en-tête serveur dans une interface embarquée) ;
- règle de dépôt : une nouvelle page utilisateur reste un composant client ; un test de la CI (E12)
  échoue si une page utilisateur n'est pas atteignable dans la coquille.

### 3.2 Session native (E4, B2)

Reprise de la proposition « jeton mobile » du document de comparaison (§ 5), désormais requise :
1. À la première ouverture, la couche native crée une **paire de clés non exportable** (Secure Enclave sur
   iOS, Android Keystore — matériel / StrongBox si disponible) et enregistre la clé publique avec
   l'identifiant d'installation (registre du lot 97).
2. Toute connexion (mot de passe, lien e-mail, Google / Apple) passe par **la même émission
   `issueSession`** (`src/lib/auth/session-issuance.ts`, lot 92) avec un **dépôt « application »** : pas
   de `Set-Cookie`, le jeton de renouvellement est rendu **chiffré pour la clé de l'appareil** et rangé
   par le natif au Keychain (`WhenUnlockedThisDeviceOnly`, non sauvegardé, non synchronisé) / au Keystore.
   Le jeton d'accès (15 min) reste en mémoire native.
3. La couche native ajoute l'en-tête `Authorization: Bearer` (déjà accepté par le middleware et
   `SessionService`) aux requêtes API ; **le JavaScript ne voit jamais un jeton**.
4. **Renouvellement natif** signé par la clé de l'appareil (preuve de possession) : même rotation, même
   détection de rejeu, même `sid`, même registre « Appareils connectés » qu'aujourd'hui. Un jeton copié
   hors du téléphone est inutile.
5. **CSRF** (`src/lib/csrf.ts`, middleware) : une requête authentifiée **uniquement** par Bearer et sans
   cookie de session n'est pas exposée au CSRF (aucune autorité implicite) ; elle est acceptée sans
   `Origin` du site. Les requêtes à cookie gardent la règle actuelle, inchangée pour le site.
6. **Révocation distante** (« Déconnecter cet appareil », tous les appareils, changement de mot de passe,
   suspension) : la prochaine requête ou le prochain renouvellement échoue → effacement local (jetons,
   file d'attente du compte après avertissement, préférences de session) → écran de connexion.
7. **Déconnexion** : révocation serveur, effacement Keychain / Keystore, désinscription push (déjà prévu,
   `src/lib/mobile/session-revocation-hook.ts`). **Réinstallation** : les valeurs héritées du Keychain sont
   effacées au premier lancement (AUTH-13, déjà en place).
8. Jamais de mot de passe stocké ; rien dans `localStorage` / IndexedDB qui donne accès au compte.

Dépendances serveur : variante de dépôt dans `issueSession`, route de renouvellement native, table ou
colonnes pour la clé publique d'appareil (migration additive à réserver), adaptation CSRF, tests de
sécurité (rejeu, vol de jeton, révocation, isolation des comptes).

### 3.3 Retour Google / Apple (E3, B4)

- Valeurs : `fr.verebona.app.preprod://retour` (préprod), `fr.verebona.app://retour` (prod), posées dans
  `APP_OAUTH_RETURN_URL` de l'environnement (guide unique § 11.2). Schémas **différents** : une
  application ne reçoit jamais le retour de l'autre, même installées ensemble.
- Déjà en place (lot 93 / 95) et conservé : navigateur système (ASWebAuthenticationSession / Custom Tabs),
  `state`, **PKCE** de l'application (vérificateur au Keychain / Keystore), adresse de retour exacte sans
  paramètres (`src/lib/auth/oauth/config.ts`), **code d'échange à usage unique de 2 minutes** dans
  l'adresse — jamais un jeton de session —, échange `POST /api/auth/oauth/app/exchange`.
- À faire : accepter la cible `retour` dans `resolveAppUrl` (aujourd'hui seule `oauth` est acceptée sur le
  schéma privé) ; l'échange rend la session par le **dépôt « application »** (§ 3.2) ; cas application
  fermée pendant le parcours (Android : reprise à l'ouverture du lien, vérificateur encore présent et non
  expiré, sinon message « Recommencez la connexion »), interruption, erreur du fournisseur, compte déjà
  existant (écran « Un compte Verebona utilise déjà cette adresse » du lot 93), retours forgés ou rejoués
  (refusés : code inconnu, expiré, déjà utilisé, vérificateur absent).
- La forme https (`/app/retour-connexion`) reste acceptée par le code pour mémoire ; elle n'est plus la
  cible.

### 3.4 Verrouillage (E5, B3)

- Déjà réglé dans le code : `LOCK_AFTER_BACKGROUND_MS = 5 min` et `UNLOCK_WITHOUT_BIOMETRICS =
  'device_credential'` (`src/lib/native/app-lock.ts`) — conforme à B3, aucun changement de réglage.
- Retour au premier plan après plus de 5 minutes : Face ID / Touch ID / empreinte si l'utilisateur l'a
  activé dans Mon compte › Sécurité, **sinon le code du téléphone** (code, schéma ou mot de passe système).
  Téléphone sans code : pas de verrouillage local possible → message invitant à définir un code, et la
  session reste soumise aux règles serveur.
- Le déverrouillage local **n'est jamais une autorisation serveur** : juste après, la couche native vérifie
  la session (renouvellement si besoin) ; session expirée, révoquée ou invalide → vraie reconnexion.
- Aperçu multitâche masqué (déjà en place, `PrivacyScreen`).

### 3.5 Partage entrant et file d'attente locale chiffrée (E6, E7)

Aujourd'hui (`src/lib/native/share-in.ts`) : fichiers partagés gardés **en mémoire** seulement ; perdus si
l'application est fermée. B1 exige la reprise fiable : on passe à une **file persistante chiffrée**.

- **iOS** : l'extension de partage (`mobile/ios-share-extension/`, PDF et images, 10 fichiers au plus)
  copie les fichiers dans le conteneur du groupe d'apps (`group.fr.verebona.app[.preprod]`), protection
  de fichier « complète », **chiffrés** par une clé gardée au Keychain dans un groupe d'accès partagé avec
  l'application ; elle affiche « Ajouté à Verebona — envoi à la prochaine ouverture » et se ferme. Pas
  d'appel réseau dans l'extension (mémoire limitée, pas de session).
- **Android** : intents `SEND` / `SEND_MULTIPLE` (PDF, images, déjà déclarés) reçus même application
  fermée ; copie immédiate dans le stockage privé de l'application (exclu des sauvegardes), chiffrée par
  une clé Keystore.
- **File d'attente** (une par compte, identifiant de compte haché) : pour chaque élément — empreinte,
  nom, type, taille, date, origine (partage, scan, import), bien choisi éventuellement, **clé
  d'idempotence** —, états *en attente*, *en cours*, *envoyé*, *refusé (motif)*, *expiré*. Envoi
  automatique au retour du réseau et à l'ouverture, en arrière-plan (URLSession background / service de
  premier plan Android, déjà prévu dans `native-upload.ts`), reprise après coupure, **une seule création
  côté serveur** grâce à la clé d'idempotence (file idempotente existante, `src/lib/upload-queue.ts`).
  Copie locale effacée dès l'accusé de réception du serveur.
- **Bornes** (choix par défaut, réglables en un point) : 50 éléments et 500 Mo par compte ; élément non
  envoyé au bout de 7 jours → l'utilisateur est prévenu et choisit (réessayer / supprimer).
- **Déconnexion** : avertissement s'il reste des éléments, puis effacement de la file du compte. Changement
  de compte : les files ne se mélangent jamais.
- Sans session au moment du partage : la file attend la connexion du **même** compte.
- Écran « Envois en attente » : liste, état, motif, « Réessayer », « Retirer ».
- Scanner (VisionKit / ML Kit, déjà intégré) et import Photos (sélecteur système, sans permission large)
  / Fichiers (UIDocumentPicker / sélecteur Android) versent dans la même file.

### 3.6 Hors ligne (E8)

- La coquille démarre **toujours**, même sans réseau ; bandeau « Hors connexion » ; les écrans affichent
  un état clair (« Ces informations seront à jour au retour du réseau ») au lieu d'une erreur.
- Données affichées : celles déjà chargées **en mémoire** pendant la session ; **pas de copie durable des
  données du compte** sur le téléphone (choix par défaut : confidentialité ; une consultation hors ligne
  persistante serait un lot séparé).
- Actions possibles hors ligne : partager, scanner, importer (vers la file E6). Les autres actions sont
  désactivées avec un message.

### 3.7 Notifications et liens (E9, E11)

Réutilisation de `push.ts` et `deep-links.ts` : la cible d'une notification ou d'un lien universel devient
un écran du routeur embarqué ; application verrouillée → l'écran s'ouvre après déverrouillage ; écran
d'un autre compte ou supprimé → message neutre.

---

## 4. Critères Gate 0 « B » et recette sur appareils physiques (E15)

Règles de la grille (`gate0-grille-recette.md`) inchangées : vrais appareils, simulateurs non admis, rôles
M10 (le développeur teste et prouve, le PO valide). Matrice minimale : iPhone récent (iOS 26) + iPhone
plus ancien (version minimale retenue) ; Android récent (Pixel, Android 16) + Android milieu de gamme
d'un autre constructeur (Samsung). Préprod **et** prod installées ensemble sur au moins un iPhone et un
Android.

| N° | Critère (décision) | Réussite |
|---|---|---|
| GB-01 | Démarrage à froid (B1) | Accueil affiché en < 3 s sur réseau 4G ; écran propre sans réseau |
| GB-02 | Application fermée, partage depuis Outlook, Gmail, Mail, Photos, Fichiers (B1) | Fichiers présents dans « Envois en attente » à l'ouverture, envoyés une seule fois |
| GB-03 | Réseau absent puis revenu (B1) | Éléments en file envoyés automatiquement ; aucune perte, aucun doublon |
| GB-04 | Reprise arrière-plan / application tuée pendant un envoi de 20 Mo (B1) | Envoi terminé ou repris ; un seul document créé |
| GB-05 | Scanner multipage : 1, 3, 10 pages, mal cadrées, petits caractères (B1) | Un PDF unique, pages redressées, mêmes règles que l'import web |
| GB-06 | Push : application fermée, en arrière-plan, verrouillée (B1) | L'écran ciblé s'ouvre (après déverrouillage le cas échéant) |
| GB-07 | Liens universels et App Links depuis un e-mail (B1) | Ouverture de l'écran dans l'application de **cet** environnement |
| GB-08 | Stockage (B2) | Inventaire du conteneur : aucun jeton ni mot de passe lisible hors Keychain / Keystore ; rien dans `localStorage` / IndexedDB |
| GB-09 | Fermeture / redémarrage du téléphone (B2) | Session conservée |
| GB-10 | Révocation depuis le web, expiration du renouvellement, changement de mot de passe (B2) | Reconnexion exigée ; « Appareils connectés » à jour ; plus de push personnel |
| GB-11 | Restauration de sauvegarde / changement d'appareil (B2) | Aucune session transférée : reconnexion |
| GB-12 | Retour avant 5 min, après 5 min, biométrie inactive (B3) | Avant : rien ; après : code du téléphone ; biométrie active : Face ID / empreinte |
| GB-13 | Déverrouillage local avec session révoquée ou périmée (B3) | Vraie reconnexion demandée |
| GB-14 | Google puis Apple, iOS et Android, préprod et prod installées ensemble (B4) | Chaque application revient sur elle-même ; aucun jeton de session dans l'adresse |
| GB-15 | Retour malveillant : lien forgé, rejoué, code expiré, application fermée pendant le parcours, annulation, erreur fournisseur, compte existant (B4) | Refus propre, aucune session incohérente |
| GB-16 | Isolation préprod / prod (M7) | Aucune donnée, notification ou session d'un environnement visible dans l'autre |
| GB-17 | Aucun achat ni lien d'achat (A9) | Parcours du § 3 bis de la grille Gate 0 |
| GB-18 | Revue bêta TestFlight externe et piste de test Play | Acceptées (signal, jamais présumé pour la publication) |

Sortie : aucune anomalie critique ou majeure ouverte ; procès-verbal PO. Les autorisations App Store /
Google Play ne sont **jamais** présumées : la publication en production reste soumise à la revue des
stores et à l'approbation du PO (environnement `production-mobile`).

---

## 5. Choix pris par défaut (modifiables en un point)

| Sujet | Choix par défaut | Où le changer |
|---|---|---|
| Versions minimales | iOS 16, Android 8 (API 26) — à confirmer à E0 selon le parc des testeurs | projet iOS, `variables.gradle` |
| Retour Google / Apple | schéma `…://retour` (B4) | `APP_OAUTH_RETURN_URL` par environnement |
| Délai de verrouillage | 5 min ; code du téléphone sans biométrie | `src/lib/native/app-lock.ts` |
| File d'attente | 50 éléments, 500 Mo, 7 jours | constante unique du module de file |
| Hors ligne | pas de copie durable des données du compte | — (lot séparé) |
| Mises à jour de l'interface | par les stores uniquement ; pas de service tiers de mise à jour à distance | décision PO ultérieure si besoin |

---

## 6. Risques et parades

| Risque | Effet | Parade |
|---|---|---|
| Une évolution du site casse l'application (page serveur, import serveur dans un composant) | Écran indisponible dans l'app | Contrôles CI d'E12 ; règle « pages utilisateur clientes » |
| API N+k incompatible avec une app N encore installée | Erreurs chez les utilisateurs non mis à jour | Contrat des routes utilisées par l'app (E12), changements d'API rétrocompatibles, version minimale (`MOBILE_MIN_VERSION_*`) et écran « Mise à jour requise » |
| Chaque correction d'écran passe par les stores (contraire de M4) | Délai de 1 à 3 jours par correctif | Interrupteurs serveur `MOBILE_FEATURES_OFF` ; corrections groupées ; éventuel service de mise à jour à distance = décision PO séparée (règles Apple 3.3.1(B) / Google) |
| Changement du transport de session (sécurité) | Faille ou déconnexions | Point unique `issueSession`, tests de rejeu / vol / révocation, revue de sécurité avant fusion, déploiement serveur sans effet sur le site |
| Extension de partage iOS (mémoire limitée, pas de réseau) | Partage lourd échoue | Copie seule dans l'extension, envoi par l'app |
| Refus Apple (4.2 fonctionnalité minimale, 3.1.1 paiements, 5.1.1 suppression de compte) | Retard de publication | Fonctions natives réelles, masquage commercial, suppression de compte accessible ; revue bêta dès E15 |
| Fabricants Android qui tuent les tâches de fond | Envoi retardé | Service de premier plan déclaré, reprise à l'ouverture |
| Délais de comptes (D-U-N-S, vérifications) | Gate 0 retardé | Lancer le guide unique tout de suite (étape 1) |
| Icônes non livrées | Build préprod indiscernable | Brief graphiste émis ; icône provisoire marquée « PRÉPROD » par les développeurs en attendant |

---

## 7. Ce que le PO aura à faire

1. Suivre `docs/exploitation/guide-comptes-unique.md` (comptes, clés, variables, environnements GitHub).
2. Transmettre le brief `docs/design/brief-graphiste-icone-et-mascotte.md` au graphiste et valider le
   concept.
3. Tester sur son téléphone pendant E15 et signer le procès-verbal.
4. Approuver les builds de production dans GitHub et la soumission dans les consoles.
