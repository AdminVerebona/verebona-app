# Décision PO du 03/11/2026 — interface distante = cible V1 iOS et Android (lot 108G)

## 1. La décision

> Architecture cible de Verebona iOS et Android : **interface distante (mode A)** chargée depuis le
> serveur de l'environnement, dans une application Capacitor disposant de fonctionnalités natives.
> Cette décision **remplace la décision B1 du 27/10/2026** (interface React embarquée, mode B).

- **B1 : décision remplacée / plan abandonné.** `docs/mobile/plan-architecture-embarquee.md` est conservé
  pour l'historique, avec un bandeau explicite. Le plan B (74 à 113 jours) n'est pas engagé.
- Ne sont **pas** abandonnés : les fonctions natives (Face ID, scanner, partage entrant, notifications,
  liens, envoi de fond), les exigences de sécurité, les droits utilisateur (résiliation, suppression de
  compte) et l'absence d'achat intégré.
- Hors périmètre : portage de l'interface dans le binaire, stockage métier local, mise en ligne immédiate.

Raisons (PO) : interface évolutive déployable côté serveur sans soumission systématique ; un seul code
web / mobile ; aucune consultation métier hors ligne demandée ; Face ID, scanner, notifications, liens
et partage entrant ne dépendent pas du mode embarqué.

## 2. Classement des étapes du plan embarqué (E0–E15)

Chaque étape est classée **une seule fois**. « Adapter » = l'exigence fonctionnelle ou de sécurité reste,
sa mise en œuvre change pour le mode distant.

| Étape (plan B) | Classement | Ce qui reste / pourquoi | Où c'est traité |
|---|---|---|---|
| **E0** Préalables : comptes, icônes, matrice d'appareils, `.p8` en clair, versions minimales d'OS | **Conserver** | Indépendant de l'architecture. `.p8` en clair : fait (lot 101/107-bis). | `guide-comptes-unique.md`, `builds-et-secrets.md` |
| **E1** Coquille cliente embarquée (routeur client, adaptateur `next/*`, 9 pages serveur, PDF.js, CSP par `meta`) | **Annuler** | Objet même du plan B. Seul le besoin « CSP de l'application » subsiste → **adapté** : CSP appliquée par le serveur à la vue de l'app. | `architecture-distante.md` § 1 |
| **E2** Adresse de base de l'API (≈ 130 `fetch('/api/…')` → `apiClient`) | **Annuler** (comme exigence mobile) | Inutile en même origine. Reste une bonne pratique web facultative, sans lien avec l'app. | — |
| **E3** Retour Google / Apple par `…://retour`, échange rendant une session d'application | **Adapter** | B4 conservée (schéma propre, distinct par environnement) avec la forme **déjà en place** `fr.verebona.app[.preprod]:/oauth` ; l'échange par cookies de même origine reste. Cas d'erreur (forgé, rejoué, expiré, annulation, app fermée) : à recetter. | `guide-comptes-unique.md` § 11.2, recette CA04 |
| **E4** Session native (clé d'appareil, jeton chiffré au Keychain / Keystore, Bearer, CSRF adapté) | **Adapter — arbitrage PO A-1** | CSRF : sans objet (même origine, aucun assouplissement). B2 (Keychain / Keystore) **non supprimée** : option (b) de l'arbitrage A-1 = jeton de renouvellement au Keychain / Keystore en mode distant (≈ 10–14 j). Révocation, déconnexion, réinstallation : déjà en place, à recetter. | `architecture-distante.md` § 7 |
| **E5** Verrouillage 5 min, biométrie sinon code du téléphone, contrôle serveur au déverrouillage | **Conserver** (fait, lot 107A) | Indépendant du mode ; non modifié. | `src/lib/native/unlock-*.ts`, recette CA04 |
| **E6** Partage entrant app fermée + file d'attente locale + envoi de fond | **Adapter** | Fait au lot 108G : extension iOS **intégrée** au projet, **file technique** (un élément par partage, persistante, isolée par compte, purge explicite) **sans** mode hors ligne ni envoi automatique en arrière-plan d'un élément non confirmé (l'utilisateur confirme dans le formulaire habituel). Chiffrement applicatif de la file : remplacé par la protection de fichier « complète » d'iOS et le stockage privé Android. | `architecture-distante.md` § 6 |
| **E7** Scanner multipage, import Photos / Fichiers, reprise après interruption | **Conserver** | Scanner fait (lot 95) ; reprise : file de dépôt idempotente existante, message d'interruption corrigé (108G). | recette CA04 / CA05 |
| **E8** État hors ligne cohérent (coquille toujours affichée, données en mémoire) | **Adapter** | Réduit à la décision PO : aucune consultation hors ligne ; page « Connexion Internet indisponible » + « Réessayer », bandeau dans l'app. | `www/offline.html`, recette CA05 |
| **E9** Notifications : écran ciblé dans le routeur embarqué, démarrage à froid, après déverrouillage | **Adapter** | Routeur embarqué sans objet ; ouverture de l'écran ciblé via `pushTargetPath` + attente du déverrouillage : déjà en place. | recette CA04 |
| **E10** Masquage commercial (A9), suppression de compte dans l'app, « Mise à jour requise » | **Conserver** | Déjà en place côté serveur et coque (97B, 100D) ; à revérifier pour la revue. | `conformite-stores.md` |
| **E11** Liens universels / App Links vers le routeur embarqué | **Adapter** | Vers l'interface distante : déjà en place (`resolveAppUrl`, `npm run check:links`). | recette CA04 |
| **E12** Compatibilité des versions, build de l'interface dans la CI mobile, contrôle d'imports serveur | **Adapter** | Build de l'interface : annulé. Reste : version minimale / interrupteurs (lot 97) et **garde-fous de distribution** (108G : aucune sonde distribuée, binaire contrôlé). | workflows `mobile-*.yml` |
| **E13** Icônes, notification, écran de démarrage | **Conserver** | Fait au lot 107F ; fichiers du graphiste à venir (B5). | `builds-et-secrets.md` § 7 |
| **E14** Fiches stores : confidentialité, sécurité des données, captures, service de premier plan | **Conserver** | Indépendant du mode ; constats et risques au lot 108G. | `conformite-stores.md` |
| **E15** Gate 0 « B » sur appareils physiques, procès-verbal | **Adapter** | Grille GB-01..18 remplacée par la recette CA01–CA06 du mode distant (critères utiles repris : partage app fermée, aucun doublon, révocation, isolation préprod / prod, aucun achat, revue TestFlight externe). | `recette-108g-mobile-distant.md` |

Critères GB-01 à GB-18 : GB-01 (démarrage < 3 s) → mesure PERF-01 ; GB-02/03/04 → CA04/CA05 ;
GB-05 → CA04 scanner ; GB-06/07 → CA04 ; GB-08 (aucun jeton hors Keychain) → A-1 ; GB-09/10/11/13 →
CA04 sessions ; GB-12 → CA04 Face ID ; GB-14/15 → CA04 Google / Apple ; GB-16 → CA06 ; GB-17 → CA06 /
stores ; GB-18 → CA06. Aucun n'est supprimé sans reprise.

## 3. Matrice des décisions PO « application mobile » (état au 03/11/2026)

| Décision | Date | Contenu | Statut au 03/11/2026 |
|---|---|---|---|
| M1 | 26/10 | Google / Apple dans l'app, par le navigateur système | En vigueur |
| M2 | 26/10 | « Appareils connectés » identique web / mobile | En vigueur |
| M3 | 26/10 | Aucun Web Push, notifications natives | En vigueur |
| M4 | 26/10 | Projet dans `mobile/`, mise à jour web sans soumission systématique | En vigueur — **renforcée** par la décision du 03/11 |
| M5 | 26/10 | Architecture qualifiée au Gate 0 | **Tranchée le 03/11 : interface distante** |
| M6, M7, M8, M9, M10 | 26/10 | Comptes Verebona ; `fr.verebona.app` / `fr.verebona.app.preprod` ; GitHub Actions + production sur approbation ; VisionKit / ML Kit ; rôles de recette | En vigueur |
| A9 | 27/10 | Aucun achat intégré ; résiliation, rétractation, suppression de compte conservées | En vigueur |
| **B1** | 27/10 | Option B, interface embarquée | **REMPLACÉE le 03/11/2026 — plan abandonné** |
| B2 | 27/10 | Session au Keychain / Keystore | Maintenue comme exigence ; mise en œuvre en mode distant **à arbitrer (A-1)** |
| B3 | 27/10 | Code du téléphone après 5 min sans biométrie | En vigueur (fait, lot 107A) |
| B4 | 27/10 | Retour Google / Apple par schéma propre, préprod / prod séparées | En vigueur, forme `…:/oauth` |
| B5 | 27/10 | Icônes du graphiste remplaceront les provisoires | En vigueur |
| **03/11** | 03/11 | Interface distante = cible V1 ; deux apps distinctes ; préparation prod sans ouverture publique ; publication manuelle | **En vigueur** |

## 4. Séparation des étapes vers le public (CA06)

1. **Préparation technique de la production** (développeur + PO) : variables et secrets de
   l'environnement GitHub `production-mobile`, builds de production en mode distant, envoi à TestFlight
   (app de production) / piste « Tests internes » de la fiche Play de production, après **approbation**
   du PO dans GitHub. → Aucun utilisateur public.
2. **Recette de production** sur vrais téléphones (`recette-108g-mobile-distant.md`, partie B),
   éventuellement revue bêta TestFlight externe.
3. **Soumission** à la revue Apple / Google : geste manuel du PO dans les consoles, après la recette.
   Choisir « **Publication manuelle** » (App Store) ; Play : version en **brouillon** ou déploiement
   « non lancé ».
4. **Ouverture publique** : décision PO séparée, après acceptation des stores ; pas de date imposée.
