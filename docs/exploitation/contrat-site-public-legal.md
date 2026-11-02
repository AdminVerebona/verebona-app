# Contrat d'interface — rubrique « Légal » du site public ↔ application (lot 102B)

**Destinataires :** équipe du site public (dépôt `verebona-public`).
**Statut :** à livrer par le site public. L'application peut être déployée avant : elle
reste sur les adresses actuelles du site jusqu'à la livraison (§ 2.1).
**Ce document ne contient aucun texte juridique.** Les textes (Mentions légales, CGUV,
Confidentialité, Sous-traitants et prestataires, Parrainage) sont fournis par le PO et
publiés tels quels par le site public.

---

## 1. Principe

| Rôle | Site public | Application |
|---|---|---|
| Texte juridique officiel | **oui — source unique** | non (plus aucune copie servie ni maintenue) |
| Archive des versions des CGUV | **oui — versions immuables** | non (garde seulement les anciennes versions déjà acceptées, en archive de preuve) |
| Référentiel des versions (code, permalien, empreinte, substantielle oui / non) | publie le **manifeste** | **lit** le manifeste, garde le dernier état connu |
| Preuves d'acceptation | — | **oui** (version + permalien + empreinte + date + contexte + canal) |

Le contenu juridique est **identique en préproduction et en production**. Seul le domaine
change (`https://preprod.verebona.fr`, `https://www.verebona.fr`). Concrètement : pour un
même code de version, l'empreinte SHA-256 est **la même** sur les deux environnements.

L'application connaît la base du site par la variable `NEXT_PUBLIC_PUBLIC_SITE_URL`
(par environnement).

---

## 2. Une URL directe et stable par contenu

La page unique à onglets est conservée. Chaque onglet a **sa propre URL**, qui ouvre la
page directement sur cet onglet (pas d'ancre `#…` seule : une URL de chemin, rendue côté
serveur, indexable, partageable).

| Contenu | Chemin (stable, à vie) | Libellé de l'onglet |
|---|---|---|
| Mentions légales | `/legal/mentions-legales` | Mentions légales |
| CGUV — Conditions générales d'utilisation et de vente | `/legal/cguv` | CGUV |
| Confidentialité | `/legal/confidentialite` | Confidentialité |
| Sous-traitants et prestataires | `/legal/sous-traitants` | Sous-traitants et prestataires |
| Parrainage | `/legal/parrainage` | Parrainage |

Règles :

- `/legal` (sans suffixe) peut afficher la page avec l'onglet par défaut (Mentions légales).
- **Anciennes adresses → redirection permanente 301** :
  `/mentions-legales` → `/legal/mentions-legales`, `/cgu` → `/legal/cguv`,
  `/confidentialite` → `/legal/confidentialite`. Les déclarer dans `legacyRedirects` de
  l'inventaire des liens (`link-inventory.json`) et ajouter les cinq chemins à
  `routes.static`.
- `/legal/cguv` affiche **toujours la version en vigueur** des CGUV, avec son code de
  version visible (ex. « Version 2026-10-30-v1 ») et un lien « Versions précédentes ».
- Terminologie : « CGUV » partout (jamais « CGU », « CGSU » ni « CGVU »).

---

### 2.1 Phase de transition : l'application ne pointe jamais vers une page absente

La préproduction (puis la production) de l'application peut être déployée **avant** que le
site public livre les adresses `/legal/…`. Tant que le manifeste du § 4 n'a **jamais été lu
avec succès**, l'application est en mode **« repli »** :

| Contenu | Repli (adresses ACTUELLES du site) | Après livraison (`/legal/…`) |
|---|---|---|
| Mentions légales | `/mentions-legales` | `/legal/mentions-legales` |
| CGUV | `/cgu` | `/legal/cguv` |
| Confidentialité | `/confidentialite` | `/legal/confidentialite` |
| Sous-traitants et prestataires | `/confidentialite` (page qui en traite aujourd'hui) | `/legal/sous-traitants` |
| Parrainage | `/cgu` (page qui en traite aujourd'hui) | `/legal/parrainage` |

- **Bascule automatique** : à la première lecture réussie du manifeste, tous les liens
  passent sur `/legal/…` (au plus 60 s par serveur, 5 min de cache côté navigateur).
- **Bascule forcée** : `LEGAL_PUBLIC_V2=on` (serveur) — et `NEXT_PUBLIC_LEGAL_PUBLIC_V2=on`
  au build pour la valeur de départ des écrans ; `off` fige le repli.
- **Surcharge par contenu** (mapping unique, mêmes noms que le chantier 102D) :
  `NEXT_PUBLIC_LEGAL_MENTIONS_URL`, `NEXT_PUBLIC_LEGAL_CGUV_URL`,
  `NEXT_PUBLIC_LEGAL_PRIVACY_URL`, `NEXT_PUBLIC_LEGAL_SUBPROCESSORS_URL`,
  `NEXT_PUBLIC_LEGAL_REFERRAL_URL` — URL absolue ou chemin du site ; **prioritaire dans les
  deux modes** (laisser vide pour profiter de la bascule automatique).
- Pendant le repli :
  - **aucune réacceptation** n'est exigée ;
  - l'acceptation (inscription, connexion sociale, souscription) enregistre la **version
    courante connue** (dernière version historique publiée par l'application, en
    préproduction `2026-07-30-v1`), avec son **permalien d'archive** de l'application
    (`https://<app>/cguv/versions/{code}`, qui répond toujours) et son empreinte d'origine,
    au statut **« en attente du site public »** (`EN_ATTENTE_SITE_PUBLIC`) ;
  - l'absence du manifeste est signalée en Supervision comme une **information**
    (« Information — CGUV : le site public n'a pas encore publié son manifeste »), pas comme
    un incident ; elle se résout seule à la première lecture réussie. La tâche planifiée
    reste « réussie » (note). Un manifeste publié mais **invalide**, ou une panne **après**
    une première lecture réussie, restent des incidents.

## 3. Versionnement public des CGUV

### 3.1 Code de version

Format `AAAA-MM-JJ-vN` (ex. `2026-10-30-v1`) : date réelle de publication, `N` ≥ 1
incrémenté si plusieurs versions sont publiées le même jour. Un code n'est **jamais
réutilisé**, même pour une version retirée.

### 3.2 Pour chaque version publiée

| Élément | Chemin | Règle |
|---|---|---|
| Permalien (page lisible) | `/legal/cguv/versions/{code}` | à vie ; affiche **exactement** cette version, jamais une autre ; code inconnu → 404 explicite (jamais de redirection vers la version courante) |
| Texte figé (fichier) | `/legal/cguv/versions/{code}.html` | octets **immuables** ; c'est ce fichier qui est haché |
| Empreinte | `sha256` du manifeste | SHA-256, **hexadécimal minuscule (64 caractères)**, des **octets exacts** servis à `/legal/cguv/versions/{code}.html` (UTF-8, sans transformation ; pas de minification ni d'injection dynamique après publication) |

Immutabilité :

- une version publiée n'est **jamais modifiée ni supprimée** ; une correction, même d'une
  virgule, est une **nouvelle version** ;
- les versions historiques restent publiées et listées dans le manifeste, sans limite de
  durée (elles prouvent ce que chaque utilisateur a accepté) ;
- la décision **« substantielle »** (`requiresReacceptance`) est prise par le PO **avant**
  publication et **figée avec la version** : elle ne change plus jamais.

Effet côté application :

- `requiresReacceptance: true` → tout utilisateur qui n'a accepté ni cette version ni une
  version postérieure est bloqué (écran dédié) jusqu'à son acceptation explicite, à partir
  de `effectiveAt` ;
- `requiresReacceptance: false` → aucune réacceptation, aucun blocage.

### 3.3 Versions publiées autrefois par l'application

L'application a publié elle-même des versions avant le lot 102B (dont `2026-07-30-v1`).
Elles restent consultables par l'application tant que le site ne les a pas republiées.
Pour les reprendre dans l'archive officielle :

1. récupérer le fichier tel qu'il a été figé : `https://<app>/cguv/versions/{code}`
   (réponse `X-Legal-Source: archive-historique`) ;
2. le publier **octet pour octet** à `/legal/cguv/versions/{code}.html` avec le **même
   code**, `requiresReacceptance: false`, `publishedAt` = date d'origine ;
3. l'empreinte du manifeste sera alors identique à celle que l'application connaît déjà.

Dès que le manifeste liste une de ces versions, l'application y renvoie (permalien public)
au lieu de servir son archive.

---

## 4. Manifeste machine des versions — `/legal/cguv/versions.json`

L'application lit ce fichier **toutes les heures** (tâche `legal-cguv-manifest-sync`) et à
la demande (BO › CGUV › « Relire le manifeste »). Adresse surchargeable côté application
par `LEGAL_CGUV_MANIFEST_URL` (tests, secours).

### 4.1 HTTP

- `GET https://<site>/legal/cguv/versions.json` → `200`, `Content-Type: application/json; charset=utf-8`.
- `Cache-Control: public, max-age=300` (5 min) au plus.
- Lu de serveur à serveur : pas de CORS nécessaire, pas d'authentification.
- Taille < 1 Mo (le manifeste ne contient **aucun texte juridique**).
- Généré **au build** depuis les mêmes données que les pages (jamais saisi à la main), et
  vérifié par un test du site : chaque `sha256` = empreinte réelle du fichier `.html`.

### 4.2 Format (schéma `verebona-legal-cguv-versions-v1`)

| Champ | Type | Obligatoire | Règle |
|---|---|---|---|
| `schema` | chaîne | oui | exactement `verebona-legal-cguv-versions-v1` |
| `document` | chaîne | oui | exactement `CGUV` |
| `generatedAt` | date ISO 8601 | conseillé | date de génération |
| `current` | code | oui | version **en vigueur** ; doit figurer dans `versions` |
| `versions` | liste | oui | toutes les versions publiées, historiques comprises (≤ 500) |
| `versions[].code` | code `AAAA-MM-JJ-vN` | oui | unique |
| `versions[].permalink` | URL absolue | oui | `https://<site>/legal/cguv/versions/{code}` — même origine que le site, HTTPS |
| `versions[].sha256` | 64 hex minuscules | oui | empreinte du texte figé (§ 3.2) |
| `versions[].publishedAt` | date ISO 8601 (UTC, `Z`) | oui | figée |
| `versions[].effectiveAt` | date ISO 8601 | non | entrée en vigueur (défaut : `publishedAt`) |
| `versions[].requiresReacceptance` | booléen | oui | **figé à la publication** (`true` = substantielle) |
| `versions[].title` | chaîne ≤ 200 | non | ex. « Conditions générales d'utilisation et de vente » |
| `versions[].changeSummary` | chaîne ≤ 2000 | conseillé si substantielle | résumé en mots simples affiché sur l'écran de réacceptation (pas le texte juridique) |
| `versions[].textUrl` | URL absolue | conseillé | `https://<site>/legal/cguv/versions/{code}.html` ; l'application vérifie l'empreinte à l'import |

### 4.3 Exemple

```json
{
  "schema": "verebona-legal-cguv-versions-v1",
  "document": "CGUV",
  "generatedAt": "2026-11-15T09:00:00Z",
  "current": "2026-11-15-v1",
  "versions": [
    {
      "code": "2026-11-15-v1",
      "permalink": "https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1",
      "textUrl": "https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1.html",
      "sha256": "9b1c0f2d7e4a5b6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
      "publishedAt": "2026-11-15T09:00:00Z",
      "effectiveAt": "2026-11-15T09:00:00Z",
      "requiresReacceptance": true,
      "title": "Conditions générales d'utilisation et de vente",
      "changeSummary": "Nouvelle présentation du parrainage et de la conservation des données après la fin de l'essai."
    },
    {
      "code": "2026-10-30-v1",
      "permalink": "https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1",
      "textUrl": "https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1.html",
      "sha256": "0f4e2a6b8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e1f3a5b7c9d0e2f",
      "publishedAt": "2026-10-30T08:00:00Z",
      "requiresReacceptance": false
    },
    {
      "code": "2026-07-30-v1",
      "permalink": "https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1",
      "textUrl": "https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1.html",
      "sha256": "<empreinte connue de l'application pour cette version>",
      "publishedAt": "2026-07-30T00:00:00Z",
      "requiresReacceptance": false
    }
  ]
}
```

(Les empreintes ci-dessus sont des exemples de forme, pas de vraies valeurs.)

### 4.4 Ce que l'application vérifie (tout ou rien)

Un manifeste qui ne respecte pas une règle du § 4.2 est **refusé en entier** : rien n'est
appliqué, le dernier état connu reste en service et une alerte Supervision est ouverte.
De plus :

- liens hors de l'origine du site public de l'environnement → refusé ;
- version déjà connue dont le permalien, l'empreinte, la date ou la décision
  « substantielle » ont changé → **non modifiée** dans l'application, écart signalé
  (Supervision + BO) ;
- version déjà connue absente du manifeste → écart signalé ;
- `current` pointant vers une version plus ancienne déjà archivée → refusé (publier une
  nouvelle version) ;
- `textUrl` dont les octets ne donnent pas `sha256` → version non importée, écart signalé.

### 4.5 Disponibilité

Le manifeste doit rester disponible en permanence. Une indisponibilité n'empêche jamais
l'usage de l'application (dernier état connu), mais une nouvelle version n'est prise en
compte qu'après une lecture réussie. Alerte côté application après 2 échecs consécutifs
(`LEGAL_MANIFEST_ALERT_AFTER_FAILURES`), dès le premier si aucun état n'est connu.

---

## 5. Liens envoyés par l'application

| Endroit | Lien |
|---|---|
| Inscription, connexion Google / Apple | permalien de la version **affichée** (`versions[].permalink` de `current`) + `/legal/confidentialite` |
| Mon compte › Informations légales | permalien de **chaque version acceptée** + les cinq contenus |
| Pieds de page (web, mobile) | `/legal/mentions-legales`, `/legal/cguv`, `/legal/confidentialite` (+ sous-traitants sur le pied de page public ; parrainage dans Mon compte) |
| E-mail de confirmation de souscription | permalien de la version acceptée |
| Écran de réacceptation | permalien de la version en vigueur |
| Demande de démarrage immédiat (souscription) | `/legal/cguv` |
| Anciennes adresses de l'application `/cgvu`, `/cguv`, `/api/legal/cgvu/…` | redirection vers ces URL publiques |

---

## 6. Livrables attendus du site public (liste de contrôle)

1. Les cinq onglets aux chemins du § 2 (dont **Sous-traitants et prestataires** et
   **Parrainage**, nouveaux), avec les textes fournis par le PO, sans réécriture.
2. Redirections 301 des anciennes adresses (§ 2) et inventaire des liens mis à jour.
3. Archive des CGUV : permalien et texte figé par version (§ 3.2), version courante sur
   `/legal/cguv`, liste des versions précédentes.
4. Reprise des versions publiées autrefois par l'application (§ 3.3), au minimum
   `2026-07-30-v1`, octet pour octet.
5. Manifeste `/legal/cguv/versions.json` généré au build (§ 4), avec un test qui recalcule
   chaque empreinte.
6. Même contenu juridique en préproduction et en production (mêmes empreintes).
7. Procédure de publication documentée côté site : le PO qualifie
   « substantielle oui / non » **avant** publication ; la valeur est écrite dans les données
   de la version et n'est plus modifiable.

## 7. Recette commune

0. Avant livraison du site : BO › CGUV affiche « En attente du site public (information) » et
   « Adresses actuelles du site public (repli) » ; les liens du pied de page, de
   l'inscription et de Mon compte ouvrent `/cgu`, `/mentions-legales`, `/confidentialite` ;
   aucune réacceptation ; une nouvelle inscription apparaît dans BO › Comptes « en attente du
   site public ».
1. Préproduction : publier une version de test non substantielle → BO › CGUV › « Relire le
   manifeste » : la version apparaît « En vigueur », personne n'est bloqué.
2. Publier une version substantielle (`requiresReacceptance: true`, `changeSummary`
   renseigné) → relire : à la connexion suivante, l'écran « Les CGUV évoluent » s'affiche
   (ordinateur et application mobile) ; après acceptation, l'usage reprend ; la preuve
   apparaît dans Mon compte et dans BO › Comptes (version, permalien, empreinte, canal).
3. Couper le manifeste (404) → relire : message « indisponible », alerte Supervision ;
   l'application continue de fonctionner avec la version connue.
4. Ouvrir `https://<app>/cgvu` → redirection vers `https://<site>/legal/cguv`.

---

## 8. Réglages côté application (Scalingo, tous facultatifs sauf le premier)

| Variable | Valeur | Effet |
|---|---|---|
| `NEXT_PUBLIC_PUBLIC_SITE_URL` | `https://preprod.verebona.fr` / `https://www.verebona.fr` (existante) | base des liens légaux et du manifeste |
| `LEGAL_PUBLIC_V2` | `on` / `off` (vide = automatique) | force les nouvelles adresses `/legal/…` ou le repli (§ 2.1) |
| `NEXT_PUBLIC_LEGAL_PUBLIC_V2` | `on` / `off` (build) | même chose pour la valeur de départ des écrans |
| `NEXT_PUBLIC_LEGAL_MENTIONS_URL`, `NEXT_PUBLIC_LEGAL_CGUV_URL`, `NEXT_PUBLIC_LEGAL_PRIVACY_URL`, `NEXT_PUBLIC_LEGAL_SUBPROCESSORS_URL`, `NEXT_PUBLIC_LEGAL_REFERRAL_URL` | URL ou chemin | surcharge d'un contenu, dans les deux modes (partagé avec 102D) |
| `LEGAL_CGUV_MANIFEST_URL` | URL complète | lire le manifeste ailleurs (secours, tests) |
| `LEGAL_PUBLIC_EXTRA_ORIGINS` | origines séparées par des virgules | autres origines admises pour les liens du manifeste |
| `LEGAL_MANIFEST_TIMEOUT_MS` | défaut `8000` | délai maximal de lecture |
| `LEGAL_MANIFEST_ALERT_AFTER_FAILURES` | défaut `2` | échecs consécutifs avant alerte Supervision |
| `SCHEDULED_TASK_LEGAL_CGUV_MANIFEST_SYNC` | `off` | arrêt d'urgence de la lecture horaire (le bouton BO reste) |

Écran BO : **Référentiels › « CGUV — référentiel des versions »** (`/admin/cguv`) — lecture
des versions, état du manifeste, « Relire le manifeste », saisie de secours.
