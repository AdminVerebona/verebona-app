# Opérations V1 — rapport de recette (lot 48, O10)

CDC Opérations V1 v3, Partie III (fait foi) : C28 étape 44 « recette complète C29/C30 avant MEP », C29, C30, C30.1, C31, C32, C34, B33.
Base : tag `lot47` (lots O0 à O9 livrés : lots 38 à 47). Décisions PO : Q1 (TCO — **inclus depuis le lot 54D**, décision PO du 13/10/2026 ; il était hors de ce CDC jusqu'au lot 53), Q7 (préprod lot par lot, recette complète avant la future production), Q8 (aucun interrupteur), Q9 (le BO ne modifie jamais une Opération).

Matrice détaillée (cas par cas, tests, procédures) : [`operations-v1-matrice.md`](operations-v1-matrice.md), générée depuis [`operations-v1-matrice.json`](operations-v1-matrice.json) (`npm run recette:matrice`). Le test `src/test/recette/__tests__/o10-matrice.test.ts` (ACC-021) échoue si un cas du périmètre n'est couvert ni par un test (identifiant présent dans le fichier cité) ni par une procédure de recette préprod, ni par une décision PO ou un écart tracé.

## 1. Synthèse chiffrée

| Famille | Total | Automatisés | dont + recette préprod (modèle réel / BO) | Hors périmètre | Écarts |
|---|---|---|---|---|---|
| C29 — cas F-001 à F-200 | 200 | 200 | 31 | 0 (F-112, F-113 : prorata TCO automatisés au lot 54D) | 0 (F-106 résolu, lots 53D / 54D) |
| C31 — ACC-001 à ACC-022 | 22 | 22 | 2 | 0 (ACC-011 : TCO automatisé au lot 54D) | 0 |
| C34 — INV-FINAL-001 à 026 | 26 | 26 | 1 | 0 | 0 |
| B33 — INV-001 à 060 | 60 | 60 (dont 14 « via » des cas automatisés) | 0 | 0 | 0 |
| **Total** | **308** | **308** | **34** | **0** | **0** |

Avant ce lot : 154 cas C29 nommés dans les tests ; 46 cas C29, 17 ACC et 20 INV-FINAL sans test nommé. Tous sont désormais couverts (tests écrits, ou identifiants ajoutés aux tests existants qui les vérifiaient déjà : `l39` PARENT, `l43` O4-E05, `l45` O6-E02).

Les cas « + recette préprod » sont automatisés en CI avec des **sorties enregistrées** (candidats T1 persistés, verdicts M3 rejoués) ; la procédure préprod vérifie le même résultat avec le **vrai modèle** (RP-03 gating T1, RP-04 rapprochement M3) ou l'écran BO (RP-05).

## 2. Jeux de données C30.1 (harnais e2e, jamais en base d'exploitation)

`src/test/e2e/datasets/operations-v1.ts` construit les 7 jeux par les chemins de production (persistance T1, consolidation T3, service Sinistre, migration structurée lot 43, décision utilisateur lot 42) :

| Jeu | Contenu |
|---|---|
| Standard | 2 biens, facture de réparation, notice, photo, garantie, preuve de paiement seule, facture sans bien, sinistre saisi ; aucune entité équipement |
| Premium | maison + chaudière + radiateur + véhicule ; intervention sur équipement, assurance, contrat d'entretien, LOA, prêt + intérêts, sinistre clos + devis de réparation enfant, DPE facturé |
| Duo | deux membres actifs, une intervention partagée |
| Historique | vieux documents analysés sans candidats (jamais backfillés) + achat structuré migré |
| Multi-biens | sinistre sur deux biens (indemnité globale), réparation attribuée à un bien, facture commune non ventilée |
| Devises | EUR, CHF sans conversion, CHF avec débit EUR lu |
| Ambiguïtés | deux interventions du même garage la même semaine (attente M3), deux sinistres le même jour, décision REJECTED durable |

Scénario `src/test/e2e/scenarios/l48-o10-recette-jeux.e2e.ts` (21 tests) : anomalies dures du diagnostic BO (`OperationDiagnosticsService.hardAnomalies`) à **0 sur chaque jeu** après consolidation (ACC-022), passage rejoué sans écriture (INV-040), invariants C34, cas C29 propres à chaque jeu, consommateurs T2 et projection Agenda, reconsolidation complète sans effet sur un compte cohérent. Scénario `l48-o10-recette-complements.e2e.ts` (15 tests) : cas C29 isolés et bouton « Reconsolider ce compte ». Durée des deux fichiers : ≈ 12 s chacun.

## 3. Corrections de comportement (écarts réels corrigés dans ce lot)

| Cas | Constat sur la base lot47 | Correction |
|---|---|---|
| F-055 (C7.7, C9) | Une Opération OTHER dont la source est réanalysée en CONTRACT (même réalité) était quittée par sa source : nouvelle Opération créée, l'ancienne invalidée. C7.7 : « OTHER → type connu conserve le même operation_id et historise TYPE_CHANGED ». | `matching.ts` : une Opération OTHER n'est plus « type incompatible » avec un candidat de type connu (l'inverse et deux types connus restent incompatibles) ; `model.ts` : OTHER → type connu commun à toutes les sources typées ; `consolidator.ts` : `setType` (TYPE_CHANGED) pour OTHER comme pour le type nul. |
| F-096 (C12) | Une remise lue sur la facture qui porte elle-même le coût (indice REDUCTION à côté du total) créait une REDUCTION : double réduction si le total est déjà net. C12 : « Ne pas recréer une REDUCTION si elle est déjà intégrée au total final. » | `componentsFromIdentity` : une REDUCTION portée par un document qui porte aussi un coût (facture, devis) est ignorée ; un avoir (CREDIT_NOTE) ou une remise sur un document sans coût reste une réduction. |

Tests : `src/services/business-operations/consolidation/__tests__/o10-recette.test.ts` (règles pures) et e2e `F-055`, `F-096`.

## 4. Écarts du lot 48 — résolus (lots 53D puis 54D)

| ID | Cas | Constat | Proposition |
|---|---|---|---|
| E-01 | F-106 | Contrat T1 v4 sans contre-valeur EUR. | **Résolu** : contrat T1 v5 `amountEurMinor` (53D) ; 54D : contre-valeurs contradictoires entre justificatifs → aucune retenue, montant d'origine conservé et signalé (OPS-E03). |
| E-02 | F-103 (remarque) | Principal non renseigné dans `financing_details`. | **Résolu** : rôle `LOAN_PRINCIPAL` (53D) ; 54D : idempotence après réanalyse et TCO (OPS-E04), contrôle BO `FIN_PRINCIPAL_AS_COST`. |

## 5. Bouton « Reconsolider ce compte » (point ouvert du lot 47)

- **Où** : BO › Comptes › fiche › section « Opérations du compte », et BO › Opérations filtré sur un compte (à côté de « Travaux T3 du compte »). Même composant desktop et mobile (`ReconsolidateAccountButton`, bouton pleine largeur sur mobile, fenêtre de confirmation du design system).
- **Geste** : confirmation + motif obligatoire (5 à 500 caractères) → `POST /api/admin/accounts/:id/operations-reconsolidation` (admin seulement, CSRF par le middleware).
- **Effet** : met en file le travail T3 `business_operations` du compte (dédoublonné : une demande rapprochée s'ajoute au travail en attente ; événement C4 `admin_reconsolidation`, code `manual`, jamais bloqué par la version de configuration) + la projection Agenda complète du compte, même corrélation. L'exécutant fait un passage COMPLET : données structurées de tous les biens, attentes réexaminées, chaque Opération active recalculée depuis ses sources (lots de 100). Lot 54D (E08) : plus de plafond (500 biens / 2 000 Opérations) — pages sur curseur jusqu'à épuisement, tous les candidats actifs remis en consolidation, projection Agenda complète enchaînée ; statut COMPLET / PARTIEL / ERREUR et compteurs dans le détail du travail (BO › File IA). Un compte cohérent n'est pas modifié (testé sur les 7 jeux).
- **Journal** : `admin_audit_log` action `OPERATIONS_RECONSOLIDATE`, cible ACCOUNT, motif, travaux, corrélation ; SUCCESS / DENIED (compte inconnu) / FAILURE.
- **Ce n'est pas une édition** (Q9, INV-032) : aucune valeur métier n'est transmise ; les vues de diagnostic restent en lecture seule ; la procédure affichée avec les anomalies dures cite désormais ce bouton.

## 6. Check-list de recette préprod à dérouler

Procédures détaillées dans la matrice (§ « Procédures de recette préprod »).

- [ ] **RP-01** Activation des prompts maîtres livrés : T1 (lot 40), T3 avec OPERATION_MATCH (lot 42), T2 (lot 45, facultatif).
- [ ] **RP-02** Rattrapages BO : « Biens déplacés » (lot 40), « Opérations : données structurées » (lot 43), « Sinistres : ancien formulaire » (lot 44) — simulation, application, rejeu sans effet.
- [ ] **RP-03** Gating T1 réel sur le corpus de recette (F-001…F-030, F-096, F-097, F-099, F-104, F-199) dans un compte de recette dédié.
- [ ] **RP-04** Rapprochement M3 réel (F-048, F-058, F-059, F-200) et cartes « À traiter » sur mobile et desktop.
- [ ] **RP-05** BO diagnostic : anomalies dures à 0, 13 indicateurs, tâche operations-quality-check, « Reconsolider ce compte » desktop et mobile (journal d'audit), aucun outil d'édition.
- [ ] **RP-06** Parcours utilisateur de non-régression : Sinistres, export Assurance-sinistre, Agenda historique, assistant, Duo.
- [ ] **RP-07** (lot 54D) TCO, moteur financier partagé et reprises T3 / T4 — voir § 9.

## 7. Critères pour la future mise en production

1. **ACC-022** : BO › Opérations › Indicateurs (global) : anomalies dures = 0 (cross-account, cycles parent, composante sans source, Opération active sans source ; et contrôles complémentaires profondeur > 3, montant négatif, OTHER en repli) ; aucune anomalie Supervision « other:business-operations:* » ouverte.
2. **ACC-021** : `npm run recette:matrice -- --check` et le test `o10-matrice` verts ; RP-01 à RP-06 cochés en préprod, écarts du modèle consignés et traités par une nouvelle version de prompt.
3. Suites vertes sur le commit livré : typecheck 0 erreur, vitest complet, e2e complet, scripts IA (`referential:check`, `ai:inventory`, `prompts:check`, `ai:cutover-check`, `ai:check-legacy -- --strict`, `ai:corpus -- --check-fingerprints`), build.
4. Indicateurs C26.2 suivis 7 jours en préprod sans dérive : % type nul stable, aucun pic de création inexpliqué (F-194, F-195), attentes T3 lisibles.
5. Décisions PO : E-01 / E-02 résolus ; TCO inclus (Q1, lot 54D) — recette préprod RP-07 ci-dessous.
6. Aucune étape shadow ni interrupteur (ACC-019, INV-FINAL-026) : les Opérations sont actives dès la mise en production ; la reconsolidation d'un compte se fait par le bouton BO, jamais par une commande.

## 8. Risques de régression et parades

| Comportement touché | Risque | Parade vérifiée |
|---|---|---|
| Consolidation T3 (F-055) | Une Opération OTHER pouvait désormais être rapprochée (M1/M2) par un candidat de type connu et requalifiée. | Conforme à C7.7 ; l'inverse et les types connus restent incompatibles (tests `o10-recette`, C5-11 inchangé) ; e2e T3 lots 41-47 relancés. |
| Composantes (F-096) | Une REDUCTION lue sur une facture qui porte un coût n'est plus créée. | Avoir et remise sans coût inchangés (tests) ; e2e lots 41/42/45 verts ; aucune donnée existante réécrite hors reconsolidation normale du document. |
| File T3 | Nouveau déclencheur `admin_reconsolidation` (code `manual`). | Les autres déclencheurs restent soumis à la version effective (test O10-03a) ; un travail plus ancien sans cet événement s'exécute comme avant ; passage complet borné (500 biens, 2 000 Opérations, lots de 100). |
| BO | Nouvelle route d'action, bouton dans deux pages. | Routes de diagnostic toujours GET seulement (test O9-R02 inchangé) ; vues pures sans action ; garde admin + motif + journal (tests O10-01) ; desktop et mobile (test O10-UI). |
| Durée des suites | +2 fichiers e2e. | Jeux construits une fois par fichier ; ≈ 12 s par fichier. |
| Mémoire du typecheck | Nouveaux modules de test. | Memory used 2,77 Go (lot47) → 2,91 Go (lot 48), sans type Drizzle coûteux ; 0 erreur. |
| Comptes, sessions, Stripe, parrainage, mobile Capacitor | Non touchés. | Suites complètes vertes. |

## 9. Lot 54D — TCO, moteur financier partagé, écarts E01 à E09

Décision PO du 13/10/2026 : le TCO est livré dans Opérations V1 (plus aucun cas « TCO hors périmètre »).

**Architecture** : T1 extrait, T3 consolide, T2 / TCO / Sinistres / exports lisent les composantes consolidées par UN moteur commun (`src/services/business-operations/finance/engine.ts` : nature et signe, conversion EUR, attribution, dédoublonnage, périodes et prorata, inclusion / exclusion motivée, complétude, contrôles) ; T4 projette. Le service TCO (`business-operations/tco/`) ne lit aucun PDF, ne crée aucune Opération et ne persiste aucun total (recalcul à chaque lecture).

| Écart | Correction | Tests |
|---|---|---|
| E01 erreurs T3 masquées | Erreur technique distincte d'une attente métier (`TECHNICAL_ERROR:<code>`), cause / candidat / compte / job conservés, reprise automatique bornée (5 min × 2ⁿ, ≤ 6 h, 6 tentatives), travail `FAILED` tant qu'une erreur subsiste ; BO : tentatives, prochaine reprise, anomalie « reprises épuisées » | OPS-E01, OPS-E01b |
| E02 agrégats T2 tronqués (500 / 5 000) | Lectures exhaustives par curseur, dédoublonnage strict, état de lecture `COMPLETE / PARTIAL / DEGRADED` (un repli documentaire n'est jamais un total complet) | OPS-E02, OPS-E02b |
| E03 contre-valeur EUR | 53D (contrat v5) + 54D : contre-valeurs contradictoires → aucune | OPS-E03 |
| E04 capital des financements | 53D + 54D : idempotence après réanalyse, TCO = intérêts seuls, contrôle BO | OPS-E04, FIN-E |
| E05 cartes « À traiter » perdues | Échec de synchronisation rendu (plus avalé), marque durable `t3_cards_pending`, reprise par le balayage, sans doublon, décisions respectées | OPS-E05 |
| E06 reprise Agenda 48 h | Fenêtre supprimée : projection manquante restaurée quel que soit son âge ; tombstones et cartes ouvertes respectées (aucune boucle) | OPS-E06 |
| E07 projection ≤ 1 000 | Pages sur curseur stable jusqu'à épuisement, compteurs `pages` / `lastOperationId` | OPS-E07 |
| E08 reconsolidation partielle | Sans plafond, candidats + Opérations + projection, statut COMPLET / PARTIEL / ERREUR | OPS-E08 |
| E09 devise inconnue = 0 € | Sinistres : plus de `COALESCE(…, 0)` ; montant non convertible exclu des totaux EUR et signalé (fiche, T2, TCO) | OPS-E09, FIN-G |

Scénarios financiers FIN-A à FIN-H : `src/services/business-operations/finance/__tests__/l54d-finance-tco.test.ts` (règles pures) et `src/test/e2e/scenarios/l54d-operations-tco.e2e.ts` (PostgreSQL réel, chemins de production, routes HTTP).

### RP-07 — recette préprod (aucune commande, aucun SQL)

1. Compte Premium de recette, un véhicule : déposer une facture d'achat, une facture d'entretien, un avoir, un relevé d'intérêts de prêt ; saisir un sinistre avec indemnité ; ajouter une valorisation datée. Attendre l'analyse.
2. Fiche du bien › Informations › section Valorisation › **Coût de possession** (desktop puis mobile) : coût cumulé, valeur actuelle, coût net estimé, détail par poste, réductions / indemnités, « Fiabilité » (justificatifs ouvrables, montants exclus).
3. Ajouter un forfait carburant : il apparaît dans « Budget d'usage », jamais dans le coût cumulé. Le modifier puis le supprimer.
4. Déposer un certificat de cession avec prix et frais : après analyse, rouvrir le tiroir — coût net final, « résultat définitif » ; sans prix : « simulation provisoire ».
5. Assistant : « Quel est le coût de possession de ma voiture ? » → mêmes montants que le tiroir ; fiche Sinistre : brut / indemnité / reste à charge cohérents.
6. Passer le compte en Standard (BO › Abonnements) : le tiroir affiche « Fonction Premium », aucun montant ; repasser Premium : tout est revenu (forfaits compris). Premium Duo : le second membre voit le même TCO.
7. Document en CHF sans contre-valeur : non compté, signalé « devise étrangère » (tiroir, assistant, sinistre).
8. BO › Opérations › Attentes : filtre « erreur technique » — tentatives et prochaine reprise visibles ; BO › Indicateurs : anomalies `FIN_INDEMNITY_DUPLICATED`, `FIN_PRINCIPAL_AS_COST`, `T3_TECHNICAL_ERROR_EXHAUSTED` à 0.
9. BO › Lancer T3 manuellement puis attendre le passage horaire : BO › File IA, travaux T3 consommés (résultat `APPLIED` / `NO_CHANGE` / `ABSTAIN`, `FAILED` seulement avec erreur technique, détail lisible) ; « Reconsolider ce compte » sur un compte volumineux : détail `reconsolidation.status = COMPLET` (ou `PARTIEL` puis passages enchaînés jusqu'à `COMPLET`).
10. Agenda : supprimer un événement issu d'une intervention → il ne revient pas ; un événement disparu sans suppression utilisateur est restauré au passage horaire suivant.

Un planificateur présent dans le code ne prouve pas son exécution : les points 8 à 10 se constatent dans le BO (File IA, Opérations) sur la préprod.
