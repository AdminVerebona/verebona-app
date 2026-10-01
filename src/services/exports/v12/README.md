# Dossiers prêts à l'emploi V12 — moteur de rendu

CDC 16 « Exports et dossiers prêts à l'emploi » V12 : DEC-001/002/003, MIG-01 à 04,
EPIC-01, EXP-011 à 017, PDF-TXT-*, ANN-PDF-*, DRH-004 à 010, §15.3, §16, §21, LOG-*.

Les six dossiers (CIL, DOSSIER_COMPLET, VENTE, LOCATION, ASSURANCE_SOUSCRIPTION,
ASSURANCE_SINISTRE) sont rendus **côté serveur en HTML/CSS print par Chromium**
(Playwright), à partir des maquettes validées par le produit
(`maquettes/_system` + un template par dossier). PDFMonkey et le repli jsPDF sont
retirés : un échec de rendu est un échec, journalisé et notifié.

## Architecture

```
POST /api/assets/[id]/exports ─► débit par utilisateur (429), contrôles (type, famille, offre,
        │                        CIL-RULE-002, seuils §6.3), dédoublonnage par empreinte de la demande,
        │                        plafond de 3 générations actives par compte (429)
        │                        └─► export_generation (status = queued, snapshot_json.request)
        ▼
worker (instrumentation) ─► claim équitable par compte (round-robin), FOR UPDATE SKIP LOCKED,
        │                   bail renouvelé, délai global par exécution (10 min)
        │
        ├ validate_request   bien du compte, éligibilité
        ├ lock_snapshot      données du bien + informations complémentaires + choix (§16.3)
        ├ resolve_files      S3 → disque (client à délais) ; PDF inspectés dans un worker isolé
        │                    (inspection stricte), images redimensionnées (sharp)
        ├ render_html        mappeur → contrat de données → template (HTML identique aux maquettes)
        ├ render_pdf         Chromium, 2 passes (Page 1 / N, index « p. 9–14 »), contrôle de la
        │                    pagination, puis pages sources apposées en vectoriel dans les cadres
        │                    d'annexe (pdf-lib, worker isolé) ; une annexe en échec → re-rendu sans elle
        ├ assemble_zip       seulement si une pièce est en mode ZIP (/pdf, /documents, /photos)
        ├ store_result       S3 exports/{compte}/{bien}/{génération}/a{exécution}/Verebona_[Type]_[Nom]_[date].pdf|zip
        └ finalize_history   ready | partial | failed (+ nouvelle tentative différée si transitoire) ;
                             objets d'une exécution non close (bail perdu, délai) → file de purge

GET /api/export-generations/{publicId}            statut (queued … expired)
GET /api/export-generations/{publicId}/download   droits revérifiés → 302 URL signée 60 s
DELETE /api/export-generations/{publicId}/file    fichier supprimé, historique conservé
tâche quotidienne daily-exports-expiry (5 h-8 h)  > 30 jours → expired, objets → file de purge
```

### Code

| Chemin | Rôle |
|---|---|
| `src/services/exports/v12/static/` | `tokens.css`, `components.css`, polices OFL (Inter, Bricolage Grotesque, Space Mono + licences), marque et carte mascotte — copie de `maquettes/_system` |
| `src/services/exports/v12/html/` | composants §19.2, sélection/plan des pièces, assemblage — portage TypeScript fidèle des `.mjs` |
| `src/services/exports/v12/templates/` | un template versionné par dossier (`cil-v1.0.0`…) |
| `src/services/exports/v12/types.ts` | contrats de données des templates (README des maquettes) |
| `src/services/exports/v12/data/` | lecture des données (`source.ts`), classement des pièces (`documents.ts`), choix et pré-sélections §6.2/§24 (`choices.ts`), mappeurs par dossier (`mappers/`) |
| `src/services/exports/v12/render/` | Chromium partagé (`browser.ts`), impression 2 passes et isolement (`render-pdf.ts`), annexes (`annexes.ts` + worker `annex-worker.cjs`), fichiers (`media.ts`), orchestration (`render-dossier.ts`) |
| `src/services/exports/v12/generation/` | file et job (`repository.ts`, `job.ts`, `worker.ts`), mise en file (`enqueue.ts`), débit (`rate-limit.ts`), statuts et DTO (`status.ts`), erreurs (`errors.ts`), expiration, suppression et objets orphelins (`files.ts`) |
| `src/services/exports/v12/preview.ts` | aperçu du back-office (même moteur, sans enregistrement) |

### Pourquoi une file dédiée plutôt que `ai_job_queue`

La file durable existante est celle des **traitements IA** : travaux typés T1/T3/T4
(CHECK de la migration 0132), soumis au disjoncteur, à l'arrêt d'urgence IA, aux
quotas et au versionnement de configuration du BO IA. Y inscrire les exports aurait
arrêté les dossiers à chaque arrêt d'urgence IA et mélangé leurs échecs à la
supervision IA. La ligne `export_generation` est donc elle-même le travail :
prise atomique `FOR UPDATE SKIP LOCKED`, bail `locked_until` renouvelé, reprise
après arrêt brutal (au plus 3 tentatives), `next_attempt_at` pour les erreurs
transitoires — mêmes garanties, sans les dépendances IA.

### Équité et plafonds

- **Par compte** : au plus 3 générations `queued`/`generating` (au-delà : 429,
  `TOO_MANY_GENERATIONS`, message en français) ; contrôle et insertion sérialisés
  par compte (verrou consultatif transactionnel).
- **Par utilisateur** : `EXPORTS_POST_RATE_LIMIT` demandes par minute (création et
  relance, EXPORT_BRUT compris ; 429 `RATE_LIMITED` avec `Retry-After`).
- **Prise round-robin** : tour = rang de la demande dans la file de son compte +
  générations du compte déjà en cours ; plus petit tour d'abord, puis la plus
  ancienne. Un compte qui empile des demandes ne bloque pas les autres.
- **Relances manuelles** : au plus 3 par génération (`user_retry_count`, 429
  `RETRY_LIMIT_REACHED`) ; le compteur de tentatives n'est jamais remis à zéro,
  si bien qu'un dossier qui fait tomber le processus ne boucle pas.
- **Dédoublonnage** : empreinte SHA-256 de la demande (type, format, choix V12 ou
  options du tiroir, variante) — seule une demande identique, encore en file
  depuis moins de 2 min, est réutilisée.

### Jobs bloqués

- Délai global par exécution (`EXPORTS_JOB_TIMEOUT_MS`, 10 min) : au-delà, la
  génération est close en échec (`RENDER_TIMEOUT`, support notifié), l'exécution
  est avertie (AbortSignal) et n'écrit plus rien ; le worker passe à la suivante.
- Battement de cœur plafonné (délai global + 1 min) : même si la clôture échoue,
  le bail expire et la génération est reprise ou close.
- Client S3 dédié avec délais (`EXPORTS_S3_CONNECT_TIMEOUT_MS`,
  `EXPORTS_S3_REQUEST_TIMEOUT_MS`) : un stockage muet devient une erreur
  transitoire (nouvelle tentative), pas un blocage.
- Objets envoyés par une exécution non close (bail perdu, délai, échec de
  `finalize_history`) : confiés à `pending_blob_deletions`. Les clés portent le
  numéro d'exécution (`a{n}/`) : aucune exécution ne supprime les fichiers d'une
  autre.

### Garde-fous du rendu

- **Une génération à la fois par instance**, Chromium partagé, fermé après 60 s
  d'inactivité, recyclé tous les 50 rendus, **tué** si le délai (180 s) est dépassé.
- `--no-sandbox` (conteneurs), `--disable-dev-shm-usage` ; pages sans JavaScript,
  service workers bloqués.
- **Origine virtuelle** : la page est chargée depuis `https://dossier.verebona.invalid`
  et TOUTES les requêtes sont interceptées ; seuls `/static/…` (répertoire statique)
  et `/work/…` (répertoire de travail de la génération) sont servis depuis le disque,
  chemins normalisés et confinés à leur racine. Réseau et autres origines :
  refusés ; `file://` : bloqué par Chromium depuis une origine https. Aucun fichier
  local (`/etc/…`, `.env`) ne peut être incrusté dans un PDF.
- Données utilisateur toujours échappées (texte, attributs) ; la chaîne CSS de
  l'en-tête passe par `cssString` (liste blanche de caractères, tout le reste en
  échappement hexadécimal, retours ligne ramenés à une espace, `\r`/`\f`/`\0` et
  contrôles supprimés) ; point focal des photos filtré (`NN% NN%`).
- **PDF sources isolés** : inspection et apposition (pdf-lib) dans un
  `worker_thread` (`annex-worker.cjs`) au tas plafonné, limité en durée et en volume
  décompressé (plafond sur tous les décodeurs de pdf-lib, les tampons décodés étant
  hors tas V8). Une bombe de décompression ou un PDF pathologique fait échouer le
  worker, jamais le serveur : la pièce est exclue (`corrupted`).
- **Inspection stricte** des pièces intégrées au PDF (apposition « à blanc ») avant
  l'impression : une pièce retenue s'appose sans surprise. Si l'apposition échoue
  malgré tout, la pièce est marquée `corrupted` et le dossier est **re-rendu sans
  elle** (index, pagination et compteurs justes, jamais de page d'annexe vide).
- **Pagination contrôlée** : textes libres bornés dans les zones de hauteur fixe
  (en-tête, bannière d'annexe, page « Références » : `TEXT_BOUNDS`) ; après
  impression, nombre de pages et de cadres d'annexe vérifiés, débordement des pages
  d'annexe et de la page « Références » détecté → `RENDER_ERROR` plutôt qu'un index
  faux.
- Mémoire : fichiers sur disque (répertoire temporaire supprimé en fin de job),
  images réduites à la taille utile, archive ZIP écrite en flux.

## Données et règles

- **Choix** (`data/choices.ts`) : payload V12 (§17.2, choix explicites — une pièce
  sensible peut y être cochée), options du tiroir historique (`customDocIds`,
  `includePhotos` — une pièce sensible n'y est jamais retenue, le tiroir pré-cochant
  tout), ou pré-sélection du CDC (§6.2 / matrice §24 ; plafonds de photos 4 / 8 ;
  vente et location : documents et suivi proposés non cochés ; finances du dossier
  complet décochées).
- **Jamais imprimés** : estimation Verebona (clés de valorisation retirées dès la
  lecture), données d'occupant (statut, notes, locataire ; pièces locatives exclues
  même cochées), coûts dans le dossier de location.
- **Identifiants masqués** comme le design (`UA22F•••••4871`, `FW-SS58-H-25•••318`).
- **Champs vides masqués** (composants) ; exceptions du design conservées (« — » du
  CIL B6 et des montants absents du sinistre).
- **Familles hors design** : le kit de vente (maquetté sur un véhicule), l'assurance
  souscription (objet) et le dossier complet (immobilier) reçoivent les lignes
  « Informations principales » de la famille réelle (`asset.infoRows`).

## Statuts (§2.1, §16.2)

`queued`, `generating`, `ready`, `partial`, `failed`, `expired`, `deleted`
(`pending`/`error`/`cancelled` : générations antérieures). Correspondance CDC :
running = generating ; success_pdf / success_zip = ready + `output_format` ;
partial_success = partial ; file_deleted = deleted. L'API renvoie
`generationStatus` (V12) et `status` compatible avec l'onglet historique
(`pending`, `generating`, `ready`, `error`, `deleted`, `expired`).

Codes d'erreur (`error_code`, §17.3/§21) : INVALID_EXPORT_TYPE, ASSET_NOT_FOUND,
FORBIDDEN, NOT_ELIGIBLE, THRESHOLD_BLOCKED, FILE_UNAVAILABLE, RENDER_TIMEOUT,
STORAGE_ERROR, TEMPLATE_ERROR, RENDER_ERROR, ZIP_ERROR, DB_ERROR — message
générique en français par code (`export-errors.ts`), détail technique dans
`error_payload.technicalMessage` et `export_generation_logs` seulement.

## Base de données — migration 0212

`export_generation` : `output_format`, `file_key`, `file_size_bytes`, `expires_at`,
`deleted_at`, `snapshot_json`, `metrics_json`, `template_version`, `error_code`,
`locked_by`, `locked_until`, `next_attempt_at`, `user_retry_count` ; CHECK des
statuts élargi ; index de file et d'expiration. Tables `export_generation_items`
(éléments retenus / exclus, motif) et `export_generation_logs` (journal par étape).
Idempotente.

Reprise de l'existant :

- `error` → `failed` ;
- générations prêtes : échéance `GREATEST(COALESCE(completed_at, created_at), now())
  + 30 jours` — délai de grâce de 30 jours après le déploiement, aucun fichier ancien
  purgé dès la première tâche d'expiration ;
- `pending` de moins de 24 h (hors EXPORT_BRUT) → `queued` ; autres `pending` →
  `failed` ;
- `generating` sans bail (ancien moteur, EXPORT_BRUT interrompu) → `failed`. Au
  fil de l'eau, la prise de file clôt aussi toute exécution sans bail de plus de
  30 min.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `CHROMIUM_EXECUTABLE_PATH` | — | binaire Chromium fourni par l'image ; sinon headless shell Playwright |
| `PLAYWRIGHT_BROWSERS_PATH` | — | répertoire des navigateurs Playwright (local : `/opt/pw-browsers`) |
| `EXPORTS_INSTALL_CHROMIUM` | vide | `1` : installation au postinstall (échec bloquant) ; `0` : jamais ; vide : seulement sur build Scalingo (échec bloquant) |
| `EXPORTS_WORKER_DISABLED` | `false` | `true` : aucune génération sur cette instance |
| `EXPORTS_WORKER_INTERVAL_MS` | 10000 | scrutation de la file |
| `EXPORTS_RENDER_TIMEOUT_MS` | 180000 | délai du rendu (deux passes) |
| `EXPORTS_JOB_TIMEOUT_MS` | 600000 | délai global d'une exécution (worker) |
| `EXPORTS_POST_RATE_LIMIT` | 6 | demandes de génération par utilisateur et par minute |
| `EXPORTS_S3_CONNECT_TIMEOUT_MS` / `EXPORTS_S3_REQUEST_TIMEOUT_MS` | 10000 / 60000 | délais du client S3 des générations |
| `EXPORTS_ANNEX_WORKER_MEMORY_MB` | 512 | tas maximal du worker d'isolement des PDF |
| `EXPORTS_ANNEX_WORKER_TIMEOUT_MS` | 60000 | durée maximale d'une inspection / apposition |
| `EXPORTS_ANNEX_MAX_DECODED_MB` | 256 | volume décompressé maximal par PDF (64 Mo par flux) |
| `EXPORTS_V12_ANNEX_WORKER` | `src/services/exports/v12/render/annex-worker.cjs` | déplacement du worker (image Docker) |
| `EXPORTS_BROWSER_IDLE_MS` / `EXPORTS_BROWSER_MAX_RENDERS` | 60000 / 50 | fermeture et recyclage de Chromium |
| `EXPORTS_MAX_FILE_BYTES` | 50 Mo | taille maximale d'un fichier source |
| `EXPORTS_DOWNLOAD_URL_TTL_S` | 60 | durée des URL signées de téléchargement |
| `EXPORTS_EXPIRY` | vide | `off` : désactive l'expiration quotidienne |
| `EXPORTS_V12_STATIC_DIR` | `src/services/exports/v12/static` | déplacement des fichiers statiques (image Docker) |
| `EXPORTS_CHROMIUM_TESTS` | vide | `0` : ignore le test d'intégration Chromium |
| `SUPPORT_EMAIL`, `RESEND_API_KEY` | — | notification du support après échec définitif |

## Déploiement Scalingo

0. **Stack `scalingo-24` obligatoire** (ou ultérieure) : l'`Aptfile` utilise les
   noms de paquets d'Ubuntu 24.04 (suffixe `t64`), qui n'existent pas sur
   scalingo-22. Vérifier / changer la stack AVANT le premier déploiement :
   `scalingo --app <app> stacks-set scalingo-24`. Sur une stack plus ancienne, le
   `postinstall` échoue avec un message explicite.
   Sur **scalingo-26** (Ubuntu 26.04), Playwright 1.56 n'a pas de binaire dédié :
   le `postinstall` et le moteur utilisent automatiquement le build ubuntu24.04
   (`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`, surchargeable).
1. `.buildpacks` : `apt-buildpack` **puis** `nodejs-buildpack` (déjà dans le dépôt).
2. `Aptfile` (scalingo-24 / scalingo-26, noms `t64`) : bibliothèques MINIMALES de
   Chromium headless (dépendances Playwright absentes de l'image de base : `libasound2t64
   libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdrm2 libgbm1 libnss3
   libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2`) et
   `fonts-dejavu-core` (glyphes de repli). Pas de GTK, xvfb ni paquets `-dev` :
   inutiles au headless-shell et responsables d'un dépassement de la limite
   d'image Scalingo (2048 Mo).
2 bis. `postbuild` (`scripts/prune-image.mjs`, builds Scalingo uniquement) : retire
   de l'image le cache de compilation Next (`.next/cache/webpack|swc|eslint`), la
   documentation des paquets apt et le ffmpeg de Playwright.
3. Installation de Chromium par le `postinstall` (`scripts/install-chromium.mjs`) :
   automatique sur tout build Scalingo (`STACK=scalingo-*`), ou forcée par
   **`EXPORTS_INSTALL_CHROMIUM=1`** ; `chromium-headless-shell` est installé dans
   `node_modules/playwright-core/.local-browsers` (≈ 320 Mo, inclus dans l'image) ;
   **un échec fait échouer le build** (sauf opt-out explicite
   `EXPORTS_INSTALL_CHROMIUM=0`, pour une application qui ne génère pas). Le moteur le détecte à l'exécution
   (`PLAYWRIGHT_BROWSERS_PATH=0` implicite). Les polices apt sont ajoutées à
   fontconfig automatiquement (`/app/.apt/usr/share/fonts`).
4. Conteneurs : prévoir **au moins 1 Go** par instance qui génère (un rendu riche
   occupe 300 à 500 Mo) ; sinon `EXPORTS_WORKER_DISABLED=true` sur les instances
   web et une instance dédiée à la génération.
5. Migration 0212 appliquée au démarrage (`ensureMigrations`).

## Local et CI

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers   # ou : npx playwright-core install --only-shell chromium
npx vitest run src/services/exports/v12            # parité, mappeurs, job, intégration Chromium
```

Sans Chromium (CI), le test d'intégration est ignoré. Le `postinstall` ne télécharge
rien hors Scalingo.

## Tests

- `v12-templates.test.ts` : HTML identique aux maquettes (6 dossiers × 3 cas × 2
  passes, empreintes des maquettes), `mustNotAppear`, XSS.
- `v12-xss.test.ts` : chaîne CSS de l'en-tête (guillemets, anti-slash, retours
  ligne, contrôles, `url()`, `</style>`), bornes de texte, URL servies à Chromium
  (traversées, encodages, autres origines, `file:`).
- `v12-mappers.test.ts` : 13 combinaisons dossier × famille ; estimation, occupant,
  sensibles, identifiants masqués, champs vides, pré-sélections, modes PDF/ZIP.
- `v12-units.test.ts`, `v12-job.test.ts`, `v12-files.test.ts` : statuts, noms,
  seuils, pagination, placement des annexes, job (succès, partiel, ZIP, reprise,
  échec, bail perdu), expiration.
- `v12-render.integration.test.ts` : PDF réel (Chromium) — pages, pied et
  « Page X / Y » sur chaque page, annexes vectorielles au bon numéro, exclusions
  (illisible, chiffré, absent, bombe de décompression), textes très longs et
  injection dans l'en-tête, page « Références » en débordement détectée, fichier
  local hors racine jamais chargé.

## Données structurées des informations complémentaires (schéma v2, migration 0214)

Listes de la fiche bien (`lib/assets/additional-infos.ts`), stockées dans la
colonne JSONB de leur sous-rubrique, remplacées en bloc avec contrôle optimiste
(`version`, 409 `CONFLICT` + état courant) ; références (photos, pièces,
événement) vérifiées à l'écriture et ignorées à la génération si disparues :

| Liste / champ | Dossier | Repli sans saisie |
|---|---|---|
| `claim.claimEventKey` (sinistre de l'agenda, RULE-001) | sinistre : date, circonstances, pastille de chronologie | saisie temporaire (RULE-002) |
| `claim.damages[]` zone, élément, constat, montant estimé, photos, pièces | sinistre 03 (« P2, P3 · A2 ») | aucun dommage (jamais extrapolé) |
| `claim.actions[]` date(s), statut, action, intervenant, facture | sinistre 05 (« facture · annexe A3 ») | mesures ligne à ligne |
| `claim.exchanges[]` date, sens, interlocuteur, canal, résumé, document | sinistre 07 | correspondances retenues + texte libre |
| `commercial.highlights[]` (4 au plus, suggestions acceptables) | vente 04 | faits documentés déduits |
| `insurance.protectionItems[]`, `insurance.insuredItems[]` | souscription 03/04 | texte libre ligne à ligne |
| `finance.*` valeur retenue (+ origine, date), frais d'acquisition, `charges[]` | dossier complet 03 (si cochée) | — |

Une photo ou une pièce liée n'est citée que si elle est RETENUE dans le dossier
(une pièce sensible non cochée n'apparaît jamais, même par sa référence).

## Écran de préparation (§5, §17.1)

```
/assets/{id}/exports/{dossier}          page dédiée (écran large 65/35 ; plein écran mobile)
POST /api/assets/{id}/exports/prepare   { exportType, includeCurrentSelections?, choices? } → PreparationDto
POST /api/assets/{id}/exports/estimate  { exportType, choices }                                → { estimate, actions, messages }
POST /api/assets/{id}/exports           { exportType, choices: §17.2 }                         → 202 { generationPublicId, pollUrl }
GET  /api/export-generations/{id}       + currentStep (étape du job), excludedFiles (partielle)
```

| Chemin | Rôle |
|---|---|
| `preparation/sections.ts` | sections de l'écran = sections du PDF (titres des templates), obligatoires / décochables, hôte du formulaire d'informations |
| `preparation/prepare.ts` | préparation PURE : éléments (documents, photos une par une, suivi / agenda), pré-sélection §6.2 / §24, compatibilité (`integrable`, `zip_only`, `missing`, `too_large`), modes, blocs CIL (B2 compris), messages MSG-PREP-* |
| `preparation/estimate.ts` | estimation PURE, partagée avec `enqueue.ts` : format (ZIP-001), pages, taille, pièces PDF / ZIP, seuils §6.3, pièces retirées par un « PDF seul » (ALT-002), pièces indisponibles |
| `preparation/load.ts` | contrôles (type 400, famille 422, offre 403), lecture (`loadExportSource`), dernière génération et auteur |
| `lib/exports/preparation-state.ts` | machine d'états §5.3 (réducteur pur) et payload §17.2 |
| `components/exports/preparation/*` | écran : en-tête, sections, éléments, blocs CIL, résumé collant, progression, résultat |

Règles : un document sensible n'est jamais pré-coché ni coché par « Tout
cocher » ; un format non intégrable n'offre que le ZIP ; une photo HEIC va au
ZIP ; une section sans élément retenu se désactive et retrouve sa dernière
sélection à la réactivation ; une demande « PDF seul » qui retirerait des
pièces ZIP sans accusé est refusée (409 `PDF_ONLY_CONFIRMATION_REQUIRED`).

Données structurées (schéma v2) affichées dans leur section, comptées, avec
leurs pièces et photos liées (`sectionRows`) : dommages, actions et échanges
du sinistre, points forts de vente, protections et éléments assurés de la
souscription, valeur et charges du dossier complet (seulement si la section
financière est cochée). Une pièce liée n'est citée que si elle est retenue ;
« Retenir les pièces liées » les coche ensemble, jamais une pièce sensible.
La date du sinistre (pré-sélection) reprend, à défaut de saisie, celle de
l'événement de l'agenda lié (`claim.claimEventKey`). L'état d'enregistrement
du formulaire remonte par `AssetAdditionalInfosSection.onSaveStateChange`.

## Reste à faire

- Contenu des pièces dans l'estimation : pages d'un PDF estimées à 150 Ko par
  page (le compte réel n'est connu qu'à `resolve_files`) ; fichiers protégés ou
  illisibles détectés seulement à la génération (partielle, ALT-004).
- Table `document_template_versions` (versions portées par le code et figées dans
  chaque génération ; pas de table).
- Limitation de débit partagée entre instances (aujourd'hui en mémoire par instance ;
  le plafond par compte, lui, est en base).
