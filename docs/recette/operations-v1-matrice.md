# Opérations V1 — matrice de traçabilité exécutable (lot 48, O10)

> Fichier GÉNÉRÉ depuis `docs/recette/operations-v1-matrice.json` par `npm run recette:matrice` — ne pas modifier à la main.

**Référence** : CDC Opérations V1 v3, Partie III (fait foi) : C29 (F-001 à F-200), C31 (ACC-001 à ACC-022), C32, C34 (INV-FINAL-001 à 026), B33 (INV-001 à 060).

**Règle** : Chaque cas du périmètre est AUTOMATISÉ (identifiant présent dans chaque fichier de test cité, ou couvert « via » des cas automatisés), complété le cas échéant d'une procédure de recette préprod (modèle réel, BO), HORS PÉRIMÈTRE (décision PO citée) ou ÉCART tracé (proposition). Le test src/test/recette/__tests__/o10-matrice.test.ts échoue sinon (ACC-021).

## Synthèse

| Famille | Total | Automatisés | dont + recette préprod | Recette préprod seule | Hors périmètre | Écarts |
|---|---|---|---|---|---|---|
| C29 | 200 | 200 | 31 | 0 | 0 | 0 |
| C31 | 22 | 22 | 2 | 0 | 0 | 0 |
| C34 | 26 | 26 | 1 | 0 | 0 | 0 |
| B33 | 60 | 60 | 0 | 0 | 0 | 0 |
| **Total** | **308** | **308** | **34** | **0** | **0** | **0** |

## Décisions PO citées

- **Q1** — Décision PO du 13/10/2026 (lot 54D) : le TCO est INCLUS dans Opérations V1 — service TCO sur les composantes consolidées (moteur financier partagé T2 / TCO / Sinistres), formules C17, prorata au jour, forfaits d’usage, tiroir « Coût de possession » (Premium / Premium Duo, verrouillé en Standard). Plus aucun cas TCO hors périmètre.
- **Q7** — Livraison en préprod lot par lot ; recette complète (ce lot) avant la future mise en production.
- **Q8** — Aucun interrupteur fonctionnel du système Opération.
- **Q9** — Le BO diagnostique et ne modifie jamais une Opération ; la correction passe par le code puis la reconsolidation (bouton « Reconsolider ce compte », lot 48).
- **D5-D6** — Retour PO du 12/10/2026 (lot 53) : rapprochement automatique seulement à forte confiance (bien, nature, références, montants, prestataire, dates = indices) ; deux factures finales de numéros différents ne font plus systématiquement deux interventions ; doute → carte « À traiter » (docs/exploitation/operations-rapprochement.md).
- **D7** — Retour PO du 12/10/2026 (lot 53) : plafonds d’appels conservés, examen M3 progressif par lots de 5, report tracé et repris, jamais d’abandon.
- **D14** — Retour PO du 12/10/2026 (lot 53) : projection agenda incertaine → carte « À traiter » avec candidats et provenance, jamais de projection automatique.

## Écarts tracés

- **E-01** (F-106 ; gravité faible (aucune donnée fausse : montant d’origine conservé, exclu de l’agrégat EUR)) — RÉSOLU (lots 53D puis 54D) — contrat T1 v5 : contre-valeur EUR écrite `amountEurMinor` propagée aux candidats puis aux composantes (`amount_eur_cents`) ; absente ou contradictoire entre justificatifs : aucune, montant d’origine conservé et signalé (OPS-E03). *Proposition :* Aucune action restante : recette préprod sur un document CHF avec débit EUR (rapport de recette, section TCO).
- **E-02** (F-103 ; gravité faible (information descriptive manquante, aucun calcul faux)) — RÉSOLU (lots 53D puis 54D) — capital (`LOAN_PRINCIPAL`) renseigné dans business_operation_financing_details.principal_amount_minor, jamais une composante ; idempotent après réanalyse (OPS-E04) ; contrôle BO FIN_PRINCIPAL_AS_COST. *Proposition :* Aucune action restante : recette préprod sur une offre de prêt (rapport de recette, section TCO).

## Procédures de recette préprod

### RP-01 — Activation des prompts maîtres livrés (lots 40, 42, 45)

1. BO › Configuration IA › Prompts maîtres › T1 : « Repartir du texte livré avec l’application », enregistrer, puis « Activer » (contrat T1 v4, candidats Opération, lot 40).
2. BO › Configuration IA › Prompts maîtres › T3 : créer un brouillon, « Repartir du texte livré avec l’application », enregistrer, puis « Activer » (tâche OPERATION_MATCH, lot 42).
3. BO › Configuration IA › Prompts maîtres › T2 : même geste (règles B11-B15, lot 45) — facultatif, les règles serveur suffisent.
4. Contrôle : BO › Configuration IA, version effective affichée = version activée pour T1 et T3 ; BO › Exécutions IA : une analyse T1 récente porte « businessOperationCandidates ».

*Attendu :* T1 v4 et T3 (OPERATION_MATCH) actifs ; aucune erreur dans BO › Exécutions IA.

### RP-02 — Rattrapages BO des lots 40, 43 et 44

1. BO › Exploitation › Rattrapages › « Biens déplacés » (lot 40) : Simuler (rapport exact, aucune écriture), puis Appliquer avec un motif.
2. BO › Exploitation › Rattrapages › « Opérations : données structurées » (lot 43) : Simuler, contrôler les décomptes ACQUISITION / DISPOSAL / CONTRACT, puis Appliquer.
3. BO › Exploitation › Rattrapages › « Sinistres : ancien formulaire » (lot 44) : Simuler, puis Appliquer ; contrôler qu’une ancienne saisie sous le seuil reste « Reprendre en sinistre ».
4. Relancer chaque simulation : 0 élément à traiter (idempotence, F-175).

*Attendu :* Rattrapages appliqués une fois, rejoués sans effet ; les tâches internes correspondantes (asset-account-backfill, operations-structured-migration, operations-claim-migration) restent actives.

### RP-03 — Gating T1 et création anti-pollution avec le VRAI modèle

1. Prérequis : RP-01 fait. Compte de recette Premium dédié (jamais un compte client).
2. Déposer le corpus de recette, un document par cas : facture de réparation datée (F-001), facture chaudière liée à l’équipement (F-002), facture sans nature (F-003), notice (F-004), photo (F-005), garantie avec date de fin (F-006), estimation de valeur (F-007), DPE facturé (F-008), DPE descriptif (F-009), contrat d’assurance (F-010), courrier d’assureur citant une référence de sinistre (F-016), ticket illisible (F-023), preuve de paiement seule (F-024, F-097), facture à deux travaux indépendants (F-027), facture pièces + main-d’œuvre (F-028), facture deux véhicules (F-029), facture avec remise sur la même facture (F-096), relevé d’intérêts de prêt (F-104), courrier d’indemnité (F-099), document listant plus de 20 événements (F-199).
3. Attendre la fin des analyses (BO › File IA, T1 puis T3 business_operations du compte).
4. BO › Opérations (filtre du compte) : pour chaque document, vérifier l’issue attendue de la matrice (Opération créée / rattachée, ou aucune) ; onglet « En attente T3 » : motifs lisibles des attentes (F-024 : source probable sans Opération).
5. BO › Opérations › détail : composantes (F-028 une seule, F-096 aucune REDUCTION, F-097 aucun coût), liens bien / équipement (F-002), références.
6. Consigner les écarts éventuels du modèle (cas, document, sortie T1 dans BO › Exécutions IA) : ils se corrigent dans le prompt maître T1 (nouvelle version BO), jamais dans le BO Opérations.

*Attendu :* Chaque document a l’issue attendue de la matrice ; aucun document non métier ne crée d’Opération (ACC-001, INV-FINAL-002).

### RP-04 — Rapprochement M3 réel (lot 42)

1. Prérequis : RP-01 (version T3 contenant OPERATION_MATCH active).
2. Compte de recette : déposer un devis (garage X, bien Y, sans référence commune), puis une facture du même garage quelques jours plus tard sans référence au devis.
3. Après le passage T3 du compte : BO › Exécutions IA, opération t3_operation_match présente (au plus 5 par passage, 30 par jour et par compte).
4. Verdict SAME_OPERATION certain + candidat unique → facture rattachée (F-059) ; probable → carte « À traiter » (F-058, F-200) ; AMBIGUOUS avec impact → carte, jamais une troisième Opération (F-048).
5. Répondre à la carte sur mobile puis sur desktop (« Oui, la même » / « Non ») : décision durable, jamais reproposée (F-046, F-047).

*Attendu :* Aucun rattachement automatique sur verdict probable ; décisions mémorisées.

### RP-05 — Diagnostic BO, anomalies dures et « Reconsolider ce compte » (desktop et mobile)

1. BO › Dashboard › Supervision › Opérations › onglet Indicateurs, sans filtre, 30 derniers jours : « Anomalies dures : 0 » (ACC-022) ; les 13 indicateurs s’affichent (F-195 pic de créations visible par jour).
2. BO › Exploitation › Tâches planifiées : operations-quality-check exécutée (ou « Exécuter maintenant ») sans anomalie ouverte dans Supervision.
3. BO › Comptes › un compte de recette › section « Opérations du compte » : bouton « Reconsolider ce compte », confirmation, motif ≥ 5 caractères ; message « mise en file » ; BO › File IA du compte : travail T3 business_operations (code manual) puis DONE ; historique admin : OPERATIONS_RECONSOLIDATE avec le motif.
4. Même geste depuis BO › Opérations?accountId=… sur un téléphone (largeur ≤ 390 px) : bouton pleine largeur, fenêtre lisible, motif saisissable.
5. Aucun bouton d’édition sur une Opération (liste, détail, référentiel des types : F-182, F-183).

*Attendu :* Anomalies dures à 0 ; reconsolidation journalisée, sans modification d’un compte cohérent.

### RP-06 — Parcours utilisateur de non-régression (desktop et mobile)

1. Fiche d’un bien › Sinistres : ajout, modification (Clos), suppression ; export Assurance-sinistre (Premium) avec choix du sinistre.
2. Agenda : événements historiques projetés (achat, intervention réalisée) affichés « réalisé », échéance prévue notifiée ; suppression d’un événement projeté non recréée après une heure.
3. Assistant : « Combien ai-je dépensé pour <bien> ? », « Où en est mon sinistre ? » : aucun double comptage, jamais le mot « Opération ».
4. Compte Duo : le second membre voit les mêmes sinistres et le même total.

*Attendu :* Aucune régression visible ; aucun terme technique « Opération » côté utilisateur.

## C29 — Matrice de recette fonctionnelle (F-001 à F-200)

| ID | Domaine (C32) | Scénario | Attendu | Statut | Couverture |
|---|---|---|---|---|---|
| F-001 | Création anti-pollution — C3, C5 — T1 + T3 | Facture réparation voiture avec date/montant/prestation/bien | INTERVENTION REALIZED ; coût ; Agenda historique si date. | AUTOMATISÉ + RECETTE PRÉPROD | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l40-o2-candidats-t1.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>préprod RP-03 |
| F-002 | Création anti-pollution — C3, C5 — T1 + T3 | Facture chaudière liée à équipement Premium | INTERVENTION REALIZED ; equipment_link + asset parent ; TCO une fois. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : TCO automatisé — coût d’équipement remonté une seule fois au bien parent (TCO-15).* |
| F-003 | Création anti-pollution — C3, C5 — T1 + T3 | Date+montant+fournisseur sans nature | Aucune Operation. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-004 | Création anti-pollution — C3, C5 — T1 + T3 | Notice datée | Aucune Operation. | AUTOMATISÉ + RECETTE PRÉPROD | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>`e2e/l40-o2-candidats-t1.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-005 | Création anti-pollution — C3, C5 — T1 + T3 | Photo | Aucune Operation. | AUTOMATISÉ + RECETTE PRÉPROD | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-006 | Création anti-pollution — C3, C5 — T1 + T3 | Garantie + date fin | Pas Operation ; fait/Agenda possible. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-007 | Création anti-pollution — C3, C5 — T1 + T3 | Valorisation 25 000 € | Pas Operation ; valuationHistory. | AUTOMATISÉ + RECETTE PRÉPROD | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>préprod RP-03 |
| F-008 | Création anti-pollution — C3, C5 — T1 + T3 | DPE/prestation de diagnostic facturée | INTERVENTION si le document prouve la prestation ; la valeur DPE reste canonique. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-009 | Création anti-pollution — C3, C5 — T1 + T3 | DPE descriptif déjà existant sans coût/prestation distincte | Pas Operation si aucune action métier identifiable. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-010 | Création anti-pollution — C3, C5 — T1 + T3 | Contrat assurance | CONTRACT. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-011 | Création anti-pollution — C3, C5 — T1 + T3 | Contrat maintenance | CONTRACT. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-012 | Création anti-pollution — C3, C5 — T1 + T3 | LLD/LOA avant propriété | CONTRACT. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-013 | Création anti-pollution — C3, C5 — T1 + T3 | Levée option LOA | ACQUISITION nouvelle. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-014 | Création anti-pollution — C3, C5 — T1 + T3 | Prêt auto | FINANCING. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-015 | Création anti-pollution — C3, C5 — T1 + T3 | Déclaration sinistre formulaire sans doc | CLAIM REALIZED. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-016 | Création anti-pollution — C3, C5 — T1 + T3 | Courrier assureur avec ref sinistre | MATCH/CREATE CLAIM selon existant. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l48-o10-recette-complements.e2e.ts`<br>préprod RP-03 |
| F-017 | Création anti-pollution — C3, C5 — T1 + T3 | Acte vente | DISPOSAL REALIZED. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-018 | Création anti-pollution — C3, C5 — T1 + T3 | Prix souhaité vente | Aucune DISPOSAL. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o4-asset-data.test.ts` |
| F-019 | Création anti-pollution — C3, C5 — T1 + T3 | Statut VENDU sans prix/date | DISPOSAL REALIZED ; date fallback changement statut. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o4-asset-data.test.ts`<br>`e2e/l43-o4-donnees-structurees.e2e.ts` |
| F-020 | Création anti-pollution — C3, C5 — T1 + T3 | Agenda rappel « penser à vérifier chaudière » | Aucune Operation. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/l47b-agenda-source.test.ts`<br>`e2e/l47b-agenda-source-t3.e2e.ts` |
| F-021 | Création anti-pollution — C3, C5 — T1 + T3 | Agenda « remplacement chaudière prévu le 20/11 » | INTERVENTION ENVISAGED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/l47b-agenda-source.test.ts`<br>`e2e/l47b-agenda-source-t3.e2e.ts` |
| F-022 | Création anti-pollution — C3, C5 — T1 + T3 | Agenda « vidange faite aujourd’hui » | INTERVENTION REALIZED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/l47b-agenda-source.test.ts`<br>`e2e/l47b-agenda-source-t3.e2e.ts` |
| F-023 | Création anti-pollution — C3, C5 — T1 + T3 | Montant isolé dans ticket illisible | Pas Operation. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>préprod RP-03 |
| F-024 | Création anti-pollution — C3, C5 — T1 + T3 | Document candidat probable sans Operation existante | HOLD_UNRESOLVED, pas CREATE. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-025 | Création anti-pollution — C3, C5 — T1 + T3 | Document candidat probable avec match M1 exact | MATCH autorisé. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-026 | Création anti-pollution — C3, C5 — T1 + T3 | Document candidat conflictual | Pas CREATE/MATCH auto. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>préprod RP-03 |
| F-027 | Création anti-pollution — C3, C5 — T1 + T3 | Une facture avec deux travaux explicitement indépendants | Deux candidats/Operations si T1 les sépare. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l48-o10-recette-complements.e2e.ts`<br>préprod RP-03 |
| F-028 | Création anti-pollution — C3, C5 — T1 + T3 | Facture pièces + main d’œuvre même réparation | Une INTERVENTION. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l48-o10-recette-complements.e2e.ts`<br>préprod RP-03 |
| F-029 | Création anti-pollution — C3, C5 — T1 + T3 | Facture multi-biens même sinistre | Une CLAIM possible + plusieurs liens, pas une par bien. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-030 | Création anti-pollution — C3, C5 — T1 + T3 | Type non qualifiable mais événement certain | Operation type=null, pas OTHER. | AUTOMATISÉ + RECETTE PRÉPROD | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>`services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts`<br>préprod RP-03 |
| F-031 | Matching/dédoublonnage — C6, C7 — T3 | Devis puis facture cite devis | Même INTERVENTION, ENVISAGED->REALIZED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-032 | Matching/dédoublonnage — C6, C7 — T3 | Deux copies même facture | Une Operation/composante. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-033 | Matching/dédoublonnage — C6, C7 — T3 | Même garage, même jour, réparations différentes avec refs différentes | Deux INTERVENTION quand les travaux diffèrent (numéros différents = indice contraire) ; mêmes travaux et numéros différents : plus de création d’office — M3 puis carte « À traiter » en cas de doute (décision PO D6, lot 53). | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l53c-po-rapprochement.e2e.ts`<br>*Règle adaptée au retour PO D6 (lot 53) : deux factures finales distinctes peuvent porter sur une même intervention ; voir docs/exploitation/operations-rapprochement.md.* |
| F-034 | Matching/dédoublonnage — C6, C7 — T3 | Même garage, montant identique, aucune autre preuve | Ne suffit pas au match. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-035 | Matching/dédoublonnage — C6, C7 — T3 | Même contrat assurance, facture annuelle | Même CONTRACT. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o4-asset-data.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-036 | Matching/dédoublonnage — C6, C7 — T3 | Même fournisseur, nouvelle police sans continuité | Nouveau CONTRACT. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-037 | Matching/dédoublonnage — C6, C7 — T3 | Avenant mentionne contrat initial | Même CONTRACT. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-038 | Matching/dédoublonnage — C6, C7 — T3 | Même loan ref | Même FINANCING. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-039 | Matching/dédoublonnage — C6, C7 — T3 | Deux prêts distincts même achat | Deux FINANCING enfants possibles. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-040 | Matching/dédoublonnage — C6, C7 — T3 | Même insurerClaimRef | Même CLAIM. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-041 | Matching/dédoublonnage — C6, C7 — T3 | Deux sinistres même jour refs distinctes | Deux CLAIM. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-042 | Matching/dédoublonnage — C6, C7 — T3 | Vente structurée + acte vente | Même DISPOSAL. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o4-asset-data.test.ts`<br>`e2e/l43-o4-donnees-structurees.e2e.ts` |
| F-043 | Matching/dédoublonnage — C6, C7 — T3 | Revente après nouvelle acquisition | Nouvelle DISPOSAL. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-044 | Matching/dédoublonnage — C6, C7 — T3 | Acquisition facture + champs acquisitionPrice/date | Même ACQUISITION. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o4-asset-data.test.ts`<br>`e2e/l43-o4-donnees-structurees.e2e.ts` |
| F-045 | Matching/dédoublonnage — C6, C7 — T3 | Rachat après disposal | Nouvelle ACQUISITION. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o4-asset-data.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-046 | Matching/dédoublonnage — C6, C7 — T3 | Source rejetée pour Operation A puis T3 horaire | Aucun rematch vers A. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-047 | Matching/dédoublonnage — C6, C7 — T3 | Source confirmée par utilisateur | M0 stable. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-048 | Matching/dédoublonnage — C6, C7 — T3 | Deux Operations plausibles pour facture | À traiter, pas troisième Operation. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-04 |
| F-049 | Matching/dédoublonnage — C6, C7 — T3 | Fusion après référence commune découverte | Une canonique, autre merged. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-050 | Matching/dédoublonnage — C6, C7 — T3 | Fusion conserve toutes sources | Oui, sans double composante. | AUTOMATISÉ | `e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-051 | Matching/dédoublonnage — C6, C7 — T3 | Fusion conserve décisions rejetées pertinentes | Oui, remappées au canonique si nécessaire. | AUTOMATISÉ | `e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-052 | Matching/dédoublonnage — C6, C7 — T3 | Invalidée puis nouvelle preuve même ref | Réactivation même id. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-053 | Matching/dédoublonnage — C6, C7 — T3 | Invalidée puis preuve événement distinct | Nouvelle Operation. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-054 | Matching/dédoublonnage — C6, C7 — T3 | type null puis qualification INTERVENTION | Même id + TYPE_CHANGED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-055 | Matching/dédoublonnage — C6, C7 — T3 | OTHER requalifié CONTRACT | Même id si même réalité. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-056 | Matching/dédoublonnage — C6, C7 — T3 | Document déplacé de dossier mais cible explicite inchangée | Operation garde cible prouvée. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-057 | Matching/dédoublonnage — C6, C7 — T3 | Document lié manuellement autre bien contre preuve explicite | À traiter plutôt qu’écrasement silencieux. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-058 | Matching/dédoublonnage — C6, C7 — T3 | M3 semantic SAME_OPERATION probable | Pas auto-match. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-04 |
| F-059 | Matching/dédoublonnage — C6, C7 — T3 | M3 SAME_OPERATION certain + candidat unique | Auto-match. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l42-o3b-consolidation-t3.e2e.ts`<br>préprod RP-04 |
| F-060 | Matching/dédoublonnage — C6, C7 — T3 | Hard negative target | Aucun match. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| F-061 | Cycle de vie — C8, C9 — T3/Repository | Réanalyse identique | No-op métier. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-062 | Cycle de vie — C8, C9 — T3/Repository | Réanalyse montant facture 1000->1200 | Même composante mise à jour/supersédée, pas +1200. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3b-m3-fusion.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-063 | Cycle de vie — C8, C9 — T3/Repository | Réanalyse retire candidat | Source désactivée ; Operation recalculée. | AUTOMATISÉ | `e2e/l40-o2-candidats-t1.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-064 | Cycle de vie — C8, C9 — T3/Repository | Suppression seule source | Operation invalidée. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-065 | Cycle de vie — C8, C9 — T3/Repository | Suppression une source sur trois | Operation reste active. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-066 | Cycle de vie — C8, C9 — T3/Repository | Restauration source | Réactivation si identité certaine. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-067 | Cycle de vie — C8, C9 — T3/Repository | ENVISAGED dépasse date | Reste ENVISAGED. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-068 | Cycle de vie — C8, C9 — T3/Repository | ENVISAGED preuve annulation | CANCELLED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts` |
| F-069 | Cycle de vie — C8, C9 — T3/Repository | ENVISAGED facture | REALIZED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-070 | Cycle de vie — C8, C9 — T3/Repository | REALIZED perd preuve réalisation mais devis subsiste | ENVISAGED. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts` |
| F-071 | Cycle de vie — C8, C9 — T3/Repository | CANCELLED puis facture réalisation | REALIZED. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| F-072 | Cycle de vie — C8, C9 — T3/Repository | CLAIM clos | Operation REALIZED + closed_at. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| F-073 | Cycle de vie — C8, C9 — T3/Repository | Contrat résilié après exécution | Operation REALIZED + end_date/closed_at, pas CANCELLED. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-074 | Cycle de vie — C8, C9 — T3/Repository | Projet contrat annulé avant effet | CANCELLED. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-075 | Cycle de vie — C8, C9 — T3/Repository | Parent claim real + enfant repair real | Les deux REALIZED. | AUTOMATISÉ | `e2e/l42-o3b-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-076 | Cycle de vie — C8, C9 — T3/Repository | Parent claim clôturé, enfant réparation encore en cours | Parent REALIZED/closed possible selon dossier ; enfant garde propre état. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-077 | Cycle de vie — C8, C9 — T3/Repository | Suppression parent interdite physiquement | Invalidation/relation reconsolidée, pas orphan FK. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| F-078 | Cycle de vie — C8, C9 — T3/Repository | Operation sans target | Active mais exclue scopes bien/TCO. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-079 | Cycle de vie — C8, C9 — T3/Repository | Target résolu plus tard | Ajout lien + aval. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-080 | Cycle de vie — C8, C9 — T3/Repository | Operation sans target >30j | Aucune invalidation automatique ; BO bucket. | AUTOMATISÉ | `e2e/l47a-o9-bo-diagnostic.e2e.ts` |
| F-081 | Cycle de vie — C8, C9 — T3/Repository | Equipment target affiné depuis asset | Même Operation. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-082 | Cycle de vie — C8, C9 — T3/Repository | Downgrade Standard | Données conservées. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-083 | Cycle de vie — C8, C9 — T3/Repository | Account Duo utilisateur 2 modifie sinistre | Même CLAIM partagée. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-084 | Cycle de vie — C8, C9 — T3/Repository | Conversation T2 utilisateur 1 | Ne devient pas source partagée. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-085 | Cycle de vie — C8, C9 — T3/Repository | Suppression Agenda généré | Operation intacte + suppression projection durable. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/l47b-agenda-source.test.ts`<br>`e2e/l47b-agenda-source-t3.e2e.ts` |
| F-086 | Cycle de vie — C8, C9 — T3/Repository | Suppression Agenda utilisateur source unique envisagée | Retirer source ; invalider si aucune autre. | AUTOMATISÉ | `e2e/l47b-agenda-source-t3.e2e.ts` |
| F-087 | Cycle de vie — C8, C9 — T3/Repository | Annulation Agenda projetée système | Ne doit pas devenir source d’annulation métier. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/l47b-agenda-source.test.ts`<br>`e2e/l47b-agenda-source-t3.e2e.ts` |
| F-088 | Cycle de vie — C8, C9 — T3/Repository | claim form supprimé, documents restent | CLAIM reste. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-089 | Cycle de vie — C8, C9 — T3/Repository | claim form supprimé, aucune preuve | CLAIM invalidée. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-090 | Cycle de vie — C8, C9 — T3/Repository | Hour sweep | Convergence/no-op si rien changé. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-091 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Devis 1200 + facture 1350 | Forecast 1200 + realized 1350 ; TCO 1350. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : TCO automatisé — devis exclu, réalisé 1 350 compté (TCO-15).* |
| F-092 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Acompte 300 + final total 1200 | TCO 1200. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : TCO 1 200 contrôlé (FIN-D, TCO-15).* |
| F-093 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Acompte 300 + solde 900 | TCO 1200. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : TCO 1 200 contrôlé (TCO-15).* |
| F-094 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Deux factures partielles 500+700 | TCO 1200 si portions distinctes. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : TCO 1 200 contrôlé (TCO-15).* |
| F-095 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Facture 1350 + avoir 100 | Net 1250. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-096 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Remise déjà dans total facture | Pas double réduction. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts`<br>préprod RP-03 |
| F-097 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Payment proof 1250 | Aucun coût supplémentaire. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>préprod RP-03 |
| F-098 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Refund proof 200 | REFUND 200. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-099 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Indemnité 800 reçue | INDEMNITY 800. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>préprod RP-03 |
| F-100 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Dommage estimé 800 | Pas INDEMNITY/REALIZED_COST. | AUTOMATISÉ | `e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-101 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Prix vente 10000 | PROCEED. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-102 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Frais vente 500 | REALIZED_COST disposal. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-103 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Principal prêt 20000 | Hors TCO. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts`<br>*Principal jamais une composante ni ajouté à l’acquisition ; principal non renseigné dans les détails (remarque E-02).* |
| F-104 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Intérêts facturés 500 | REALIZED_COST financing. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| F-105 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Devise CHF sans EUR | Hors agrégat TCO EUR, montant original visible. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>`e2e/l54d-operations-tco.e2e.ts`<br>*Lot 54D : agrégat TCO EUR et T2 contrôlés, montant d’origine conservé (OPS-E03, TCO-15).* |
| F-106 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | CHF avec débit EUR explicite | amount_eur_cents utilisé. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts`<br>`e2e/l53d-retours-po.e2e.ts`<br>`e2e/l54d-operations-tco.e2e.ts`<br>*Lot 53D (Q16) puis 54D (E03) : contre-valeur EUR écrite → amount_eur_cents ; absente ou contradictoire → aucune (OPS-E03).* |
| F-107 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Composante source supprimée, aucune autre preuve | active=false. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-108 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Même invoice dupliquée | Une composante. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-109 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Invoice reanalysis corrige montant | Une composante courante. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-110 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Contrat tarif mensuel sans factures | Pas 12 coûts générés. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-111 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Cotisation annuelle facturée | REALIZED_COST période. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-112 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Période contrat dépasse vente sans remboursement | Prorata TCO au jour si règle TCO appliquée. | AUTOMATISÉ | `services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : prorata exact au jour (TCO-02) ; remboursement réel prioritaire (TCO-03).* |
| F-113 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Remboursement final réel après résiliation | Réalité documentée remplace prorata. | AUTOMATISÉ | `services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : prorata exact au jour (TCO-02) ; remboursement réel prioritaire (TCO-03).* |
| F-114 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Multi-biens coût global sans allocation | Pas TCO individuel. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-115 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Multi-biens composante ciblée bien A | TCO A seulement. | AUTOMATISÉ | `e2e/l45-o6-t2-operation-first.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : TCO du bien ciblé seulement (TCO-15).* |
| F-116 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Equipment cost | Roll-up parent une fois. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : roll-up équipement → bien parent une fois (TCO-04, TCO-15).* |
| F-117 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Net cost négatif après remboursement | Autorisé. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-118 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Operation active sans montant | T2 peut lister l’événement ; coût inconnu. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts` |
| F-119 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Document amount generic lié Operation sans financial hint | Ne pas l’utiliser comme coût brut. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts` |
| F-120 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Credit note supérieur au coût | Net négatif autorisé si preuve. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-121 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Quote annulé | Forecast reste historique ; Operation CANCELLED si annulation prouvée. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-122 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Facture finale remplace prévision | Forecast conservé mais exclu TCO réel. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-123 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Indemnité globale claim multi-biens | Pas ventilation automatique. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-124 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Prix souhaité VENDU sans réalisé | Net provisoire seulement. | AUTOMATISÉ | `e2e/l43-o4-donnees-structurees.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : net provisoire au prix souhaité, jamais un résultat définitif (TCO-08, TCO-15).* |
| F-125 | Finances/TCO — C11, C12, C17 — FinancialService/TCO | Prix réalisé arrive | Remplace provisoire automatiquement. | AUTOMATISÉ | `e2e/l43-o4-donnees-structurees.e2e.ts` |
| F-126 | T2 — C15 — T2 router/read service | T2 adresse maison | Canonique, pas Operation. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-127 | T2 — C15 — T2 router/read service | T2 coût réparation avec Operation | Composante Operation. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-128 | T2 — C15 — T2 router/read service | T2 coût réparation sans Operation | Fallback doc/facts qualifié. | AUTOMATISÉ | `e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-129 | T2 — C15 — T2 router/read service | T2 agrégat 2 Operations + 1 vieille facture hors Operation | Somme Operations + fallback vieille facture, sans docs sources des Operations. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-130 | T2 — C15 — T2 router/read service | T2 facture source Operation | Retourne document via source. | AUTOMATISÉ | `e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-131 | T2 — C15 — T2 router/read service | T2 valeur actuelle | valuationHistory. | AUTOMATISÉ | `e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-132 | T2 — C15 — T2 router/read service | T2 « payé/réglé » sans preuve paiement | Ne pas prétendre réglé ; distinguer coût. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-133 | T2 — C15 — T2 router/read service | T2 « coûté » | Coût économique. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-134 | T2 — C15 — T2 router/read service | T2 historique voiture | Operations + compléments non représentés. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts` |
| F-135 | T2 — C15 — T2 router/read service | T2 old doc source d’une Operation | Pas recompter en fallback. | AUTOMATISÉ | `e2e/l45-o6-t2-operation-first.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-136 | T2 — C15 — T2 router/read service | T2 Operation sans target dans question bien | Exclue. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-137 | T2 — C15 — T2 router/read service | T2 Operation sans target question compte global | Peut être mentionnée sans affirmer bien. | AUTOMATISÉ | `services/verebona-assistant/canonical/__tests__/l45-o6-operation-first.test.ts`<br>`e2e/l45-o6-t2-operation-first.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-138 | T4/Agenda — C16 — T4 projection | T4 intervention envisagée datée | Agenda planifié. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-139 | T4/Agenda — C16 — T4 projection | T4 intervention réalisée datée sans agenda | Agenda historique. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-140 | T4/Agenda — C16 — T4 projection | T4 intervention réalisée sans date | Pas date inventée. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts` |
| F-141 | T4/Agenda — C16 — T4 projection | T4 claim date connue | Agenda historique sinistre. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-142 | T4/Agenda — C16 — T4 projection | T4 acquisition date connue | Agenda historique acquisition. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-143 | T4/Agenda — C16 — T4 projection | T4 disposal date connue | Agenda historique sortie. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts` |
| F-144 | T4/Agenda — C16 — T4 projection | T4 contract sans échéance actionnable | Pas copie Agenda. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-145 | T4/Agenda — C16 — T4 projection | T4 projection puis event callback | Boucle bloquée. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts` |
| F-146 | T4/Agenda — C16 — T4 projection | Utilisateur supprime projection Agenda | Pas recréée par hourly. | AUTOMATISÉ | `components/agenda/__tests__/l46-o7-tiroir-source.test.ts`<br>`services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts` |
| F-147 | T4/Agenda — C16 — T4 projection | Agenda utilisateur existe avant Operation | Lier, ne pas dupliquer. | AUTOMATISÉ | `services/business-operations/agenda-projection/__tests__/o7-projection.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l46-o7-agenda-projection.e2e.ts`<br>`e2e/l53c-po-sinistres-agenda.e2e.ts`<br>*Lot 53 (décision PO D14) : rapprochement seulement probable → aucune projection, carte « À traiter » avec les événements candidats et leur provenance.* |
| F-148 | Sinistre — C14 — ClaimOperationService/exports | Sinistre A_DECLARER | CLAIM REALIZED, dossier A_DECLARER. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts` |
| F-149 | Sinistre — C14 — ClaimOperationService/exports | Sinistre CLOS | CLAIM REALIZED + closed_at. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-150 | Sinistre — C14 — ClaimOperationService/exports | Sinistre refusé | CLAIM REALIZED, status dossier REFUSE. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts` |
| F-151 | Sinistre — C14 — ClaimOperationService/exports | Action sinistre couper eau | Pas child Operation. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-152 | Sinistre — C14 — ClaimOperationService/exports | Action sinistre réparation avec facture | INTERVENTION enfant possible/match. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-153 | Sinistre — C14 — ClaimOperationService/exports | Dommage list item | Pas Operation. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts` |
| F-154 | Sinistre — C14 — ClaimOperationService/exports | Échange assureur | Pas Operation. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts` |
| F-155 | Sinistre — C14 — ClaimOperationService/exports | Policy ref matches Contract | claim_details insurance_contract_operation_id. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-156 | Sinistre — C14 — ClaimOperationService/exports | Policy ref ambigu | Texte conservé, pas faux lien. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-157 | Sinistre — C14 — ClaimOperationService/exports | Export assurance après migration | Lit CLAIM, pas additionalInfo comme source de vérité. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| F-158 | Sinistre — C14 — ClaimOperationService/exports | Claim multi-biens | Une CLAIM. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-159 | Sinistre — C14 — ClaimOperationService/exports | Claim indemnity allocated asset A | TCO A réduit. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : réduction du TCO du bien contrôlée (TCO-15, FIN-A).* |
| F-160 | Sinistre — C14 — ClaimOperationService/exports | Claim indemnity unallocated | Pas réduction TCO individuel. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>`services/business-operations/finance/__tests__/l54d-finance-tco.test.ts`<br>*Lot 54D : aucune réduction d’un TCO individuel (TCO-15, FIN-G).* |
| F-161 | Valorisation — C18 — Valuation service/coherence | Valuation doc fiable | valuationHistory, pas Operation. | AUTOMATISÉ | `services/ai/source-analysis/projection/__tests__/o0-acquisition-contextualisee.test.ts`<br>`services/canonical/__tests__/o0-valorisation-devise.test.ts`<br>`e2e/l38-o0-propagations.e2e.ts` |
| F-162 | Valorisation — C18 — Valuation service/coherence | Acquisition invoice amount | Acquisition cost, pas estimatedValue. | AUTOMATISÉ | `services/ai/source-analysis/projection/__tests__/o0-acquisition-contextualisee.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-163 | Valorisation — C18 — Valuation service/coherence | Document date générique | Ne propage pas acquisitionDate sans sémantique. | AUTOMATISÉ | `services/ai/source-analysis/projection/__tests__/o0-acquisition-contextualisee.test.ts`<br>`services/coherence/__tests__/o0-propagations-generiques.test.ts` |
| F-164 | Valorisation — C18 — Valuation service/coherence | Amount generic | Ne propage pas acquisitionPrice/estimatedValue. | AUTOMATISÉ | `services/ai/source-analysis/projection/__tests__/o0-acquisition-contextualisee.test.ts`<br>`services/coherence/__tests__/o0-propagations-generiques.test.ts` |
| F-165 | Valorisation — C18 — Valuation service/coherence | Question « prochaine échéance » | Agenda/T4 prioritaire, Operation contexte. | AUTOMATISÉ | `services/coherence/__tests__/o0-propagations-generiques.test.ts` |
| F-166 | Concurrence/migration — C23-C25 — DB/T3/migrations | Deux jobs T3 même source | Une seule Operation grâce sérialisation/unique. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| F-167 | Concurrence/migration — C23-C25 — DB/T3/migrations | Échec T4 après commit Operation | Operation reste ; projection rejouable. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-168 | Concurrence/migration — C23-C25 — DB/T3/migrations | Échec pendant fusion | Rollback complet. | AUTOMATISÉ | `e2e/l42-o3b-consolidation-t3.e2e.ts` |
| F-169 | Concurrence/migration — C23-C25 — DB/T3/migrations | Cross-account parent | Rejet intégrité. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| F-170 | Concurrence/migration — C23-C25 — DB/T3/migrations | Cross-account source | Rejet intégrité. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| F-171 | Concurrence/migration — C23-C25 — DB/T3/migrations | Cycle parent | Rejet. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts` |
| F-172 | Concurrence/migration — C23-C25 — DB/T3/migrations | Profondeur 4 | Rejet. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts` |
| F-173 | Concurrence/migration — C23-C25 — DB/T3/migrations | Active component sans active source | Diagnostic anomalie dure. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-05 |
| F-174 | Concurrence/migration — C23-C25 — DB/T3/migrations | Active Operation sans active source | Diagnostic anomalie dure. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-05 |
| F-175 | Concurrence/migration — C23-C25 — DB/T3/migrations | Migration relancée | Idempotente. | AUTOMATISÉ | `e2e/l43-o4-donnees-structurees.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-176 | Concurrence/migration — C23-C25 — DB/T3/migrations | Old document non retraité | Aucune Operation créée par backfill. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-177 | Concurrence/migration — C23-C25 — DB/T3/migrations | Old document réanalysé | Entre dans modèle normal. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-178 | Concurrence/migration — C23-C25 — DB/T3/migrations | Migration acquisition fields | Une ACQUISITION. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o4-asset-data.test.ts`<br>`e2e/l43-o4-donnees-structurees.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-179 | Concurrence/migration — C23-C25 — DB/T3/migrations | Migration status vendu | Une DISPOSAL. | AUTOMATISÉ | `e2e/l43-o4-donnees-structurees.e2e.ts` |
| F-180 | Concurrence/migration — C23-C25 — DB/T3/migrations | Migration claim | Une CLAIM + détails. | AUTOMATISÉ | `e2e/l44-o5-sinistre.e2e.ts` |
| F-181 | Concurrence/migration — C23-C25 — DB/T3/migrations | additionalInfo.claim après cutover | Pas de double écriture source de vérité. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| F-182 | Concurrence/migration — C23-C25 — DB/T3/migrations | BO utilisateur admin tente edit | Aucune action d’édition disponible. | AUTOMATISÉ + RECETTE PRÉPROD | `app/admin/operations/__tests__/o9-bo-diagnostic-ui.test.ts`<br>`app/api/admin/accounts/[id]/operations-reconsolidation/__tests__/o10-reconsolidation.test.ts`<br>`app/api/admin/operations/__tests__/o9-routes.test.ts`<br>`services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>préprod RP-05 |
| F-183 | Concurrence/migration — C23-C25 — DB/T3/migrations | Type referential usage count | Affiché. | AUTOMATISÉ + RECETTE PRÉPROD | `app/admin/operations/__tests__/o9-bo-diagnostic-ui.test.ts`<br>`services/business-operations/__tests__/o1-socle.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts`<br>préprod RP-05 |
| F-184 | Concurrence/migration — C23-C25 — DB/T3/migrations | T3 hourly no change | 0 histoire métier. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-185 | Concurrence/migration — C23-C25 — DB/T3/migrations | Merged operation queried by old ID | Redirection canonique. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts` |
| F-186 | Concurrence/migration — C23-C25 — DB/T3/migrations | Account deletion | Données Operation supprimées selon RGPD. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| F-187 | Concurrence/migration — C23-C25 — DB/T3/migrations | Asset deletion multi-asset | Autres liens survivent si politique le permet ; aucune FK invalide. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l44-o5-sinistre.e2e.ts` |
| F-188 | Concurrence/migration — C23-C25 — DB/T3/migrations | Downgrade plan | Pas suppression données. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-189 | Concurrence/migration — C23-C25 — DB/T3/migrations | Duo | Operations partagées. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| F-190 | Concurrence/migration — C23-C25 — DB/T3/migrations | Standard | Pas nouvelle dépendance équipement. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-191 | Observabilité/architecture — C26-C28 — BO/deploy | Candidate probable stale | Pas création par âge. | AUTOMATISÉ | `services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-192 | Observabilité/architecture — C26-C28 — BO/deploy | Arbitration REJECTED | Persiste. | AUTOMATISÉ | `services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| F-193 | Observabilité/architecture — C26-C28 — BO/deploy | New source version materially changed | Peut rouvrir matching sans effacer historique. | AUTOMATISÉ | `services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts` |
| F-194 | Observabilité/architecture — C26-C28 — BO/deploy | Unknown type high rate | Métrique, pas fallback OTHER automatique. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts` |
| F-195 | Observabilité/architecture — C26-C28 — BO/deploy | Operation creation spike | Visible BO, système reste actif. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>préprod RP-05 |
| F-196 | Observabilité/architecture — C26-C28 — BO/deploy | No feature flag OPERATIONS_ENABLED | Absent. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/__tests__/o10-invariants.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts` |
| F-197 | Observabilité/architecture — C26-C28 — BO/deploy | No shadow mode | Operations exploitées dès création. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts` |
| F-198 | Observabilité/architecture — C26-C28 — BO/deploy | ai_operations table | Jamais utilisée pour BusinessOperation. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts` |
| F-199 | Observabilité/architecture — C26-C28 — BO/deploy | T1 candidate >20 events | Doit regrouper ou signaler, pas créer >20 candidats. | AUTOMATISÉ + RECETTE PRÉPROD | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>préprod RP-03 |
| F-200 | Observabilité/architecture — C26-C28 — BO/deploy | Match semantic probable | Pas auto. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-04 |

## C31 — Critères d’acceptation globaux

| ID | Énoncé | Statut | Couverture |
|---|---|---|---|
| ACC-001 | Aucun document non métier ne crée une Operation uniquement parce qu’il contient date/montant/fournisseur. | AUTOMATISÉ + RECETTE PRÉPROD | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| ACC-002 | Toute Operation active a au moins une source active et une provenance diagnostiquable. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| ACC-003 | Tout candidat T1 est persisté/versionné ou explicitement absent ; T3 ne dépend pas du fichier brut. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| ACC-004 | T3 recherche toujours un match avant CREATE_NEW. | AUTOMATISÉ | via INV-FINAL-004, F-001 |
| ACC-005 | Une ambiguïté entre Operations plausibles ne crée pas une troisième Operation par défaut. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| ACC-006 | Les 7 types et type=null sont les seules classifications structurantes V1. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts` |
| ACC-007 | Les documents dupliqués, acomptes, paiements et avoirs ne provoquent aucun double comptage. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| ACC-008 | T2 utilise Operation lorsqu’elle porte la donnée consolidée mais conserve les autres sources selon C15. | AUTOMATISÉ | via F-127, F-128 |
| ACC-009 | Le fallback économique T2 exclut les documents déjà représentés par les Operations retenues. | AUTOMATISÉ | via F-129, F-135 |
| ACC-010 | T4 produit l’Agenda attendu sans boucle ni doublon et respecte les suppressions utilisateur. | AUTOMATISÉ | via F-138, F-145, F-146, F-147 |
| ACC-011 | TCO ne lit pas directement les montants génériques de documents ; il consomme les composantes consolidées + valuationHistory. | AUTOMATISÉ | `e2e/l54d-operations-tco.e2e.ts`<br>*Lot 54D : le service TCO lit les composantes consolidées, liens biens / équipements et valuationHistory ; aucun montant documentaire générique (FIN-B).* |
| ACC-012 | CLAIM devient la source de vérité Sinistre ; additionalInfo.claim n’est plus double-écrit après migration. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| ACC-013 | Aucune donnée de valorisation n’est transformée en Operation. | AUTOMATISÉ | via F-007, F-161, INV-FINAL-014 |
| ACC-014 | Les Operations multi-biens n’inventent aucune ventilation. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| ACC-015 | Aucun taux de change externe automatique n’est introduit en V1. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| ACC-016 | Aucun ledger de paiement n’est introduit. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| ACC-017 | Aucune scission automatique générique n’est introduite. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| ACC-018 | Aucune API CRUD générique Operation utilisateur n’est exposée. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts` |
| ACC-019 | Aucun shadow mode ni feature flag fonctionnel Operation n’existe. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| ACC-020 | Les migrations structurées sont idempotentes et aucun backfill massif des documents n’est lancé. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| ACC-021 | Les 200 cas C29 sont automatisés ou couverts par recette tracée selon pertinence. | AUTOMATISÉ | `test/recette/__tests__/o10-matrice.test.ts` |
| ACC-022 | Les anomalies dures BO sont à zéro avant MEP : cross-account, cycles parent, component sans source, Operation active sans source. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-05 |

## C34 — Invariants finaux de livraison

| ID | Énoncé | Statut | Couverture |
|---|---|---|---|
| INV-FINAL-001 | Une source n’est jamais confondue avec l’Operation qu’elle prouve. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-002 | Une date ou un montant isolé ne crée jamais une Operation. | AUTOMATISÉ + RECETTE PRÉPROD | `services/business-operations/consolidation/__tests__/o10-recette.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts`<br>préprod RP-03 |
| INV-FINAL-003 | Une source probable ne crée jamais seule une nouvelle Operation. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-004 | Toute création est précédée d’un matching. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-FINAL-005 | Une ambiguïté de matching ne crée pas un doublon. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-006 | Une Operation peut exister sans document mais jamais sans source. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-007 | Une Operation sans target fiable n’alimente pas un TCO ou historique de bien. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-008 | Le type peut être null ; OTHER ne signifie jamais « inconnu ». | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts` |
| INV-FINAL-009 | T3 est le seul moteur de consolidation. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-FINAL-010 | T2 n’est pas limité aux Operations. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-011 | T2 ne recalcule pas une donnée déjà consolidée. | AUTOMATISÉ | via F-127, F-135 |
| INV-FINAL-012 | T4 est une projection temporelle, pas une source miroir systématique. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-013 | Le TCO est un consommateur, pas le moteur du modèle. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-FINAL-014 | Une valorisation n’est jamais une Operation. | AUTOMATISÉ | via F-007, F-161 |
| INV-FINAL-015 | Une preuve de paiement n’est jamais un coût supplémentaire. | AUTOMATISÉ | `services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts` |
| INV-FINAL-016 | Le principal d’un financement n’est jamais ajouté au coût d’acquisition. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-017 | Une indemnité non allouée multi-biens ne réduit aucun TCO individuel. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-018 | Une fusion conserve toutes les preuves et évite tout double compte. | AUTOMATISÉ | via F-049, F-050, F-051 |
| INV-FINAL-019 | Une source supprimée est retirée de l’état courant mais reste historisée. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-020 | Une Operation invalidée cesse immédiatement d’alimenter les consommateurs actifs. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-021 | Les décisions utilisateur de matching sont mémorisées. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-022 | Le Sinistre reste REALIZED même quand le dossier assurance est refusé ou clos. | AUTOMATISÉ | `services/business-operations/claims/__tests__/o5-sinistre.test.ts`<br>`e2e/l44-o5-sinistre.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-023 | Le claim status est distinct du status Operation. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-024 | Les anciens documents ne sont pas backfillés massivement. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-025 | Les données structurées sémantiques existantes sont migrées pour éviter les doubles sources de vérité. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-FINAL-026 | Le système Operation est actif dès la mise en production et ne dispose d’aucun mode shadow. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |

## B33 — Invariants normatifs

| ID | Énoncé | Statut | Couverture |
|---|---|---|---|
| INV-001 | Une Opération = une réalité métier consolidée, jamais un document. | AUTOMATISÉ | via INV-FINAL-001, F-031 |
| INV-002 | Un document peut alimenter plusieurs Opérations ; une Opération peut avoir plusieurs documents. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-003 | Une date n’est pas une preuve d’Opération. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-004 | Un montant n’est pas une preuve d’Opération. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-005 | Un fournisseur n’est pas une preuve d’Opération. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-006 | T1 extrait et qualifie ; T3 consolide et persiste l’Opération. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-007 | T3 recherche avant de créer. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts` |
| INV-008 | Une ambiguïté entre plusieurs Opérations existantes ne crée pas automatiquement une nouvelle Opération. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-decision.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-009 | type=null signifie type non encore qualifié ; AUTRE signifie type compris mais hors six catégories principales. | AUTOMATISÉ | via INV-FINAL-008, F-030 |
| INV-010 | La valeur estimée n’est jamais une Opération. | AUTOMATISÉ | `services/canonical/__tests__/o0-valorisation-devise.test.ts` |
| INV-011 | Un rappel pur n’est jamais une Opération. | AUTOMATISÉ | via F-020 |
| INV-012 | Un paiement n’est jamais un coût additionnel. | AUTOMATISÉ | `services/ai/source-analysis/projection/__tests__/o0-acquisition-contextualisee.test.ts` |
| INV-013 | Un devis n’entre pas dans le TCO réalisé. | AUTOMATISÉ | `services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts` |
| INV-014 | Une facture finale incluant un acompte ne s’additionne pas à l’acompte. | AUTOMATISÉ | `services/ai/source-analysis/projection/__tests__/o0-acquisition-contextualisee.test.ts`<br>`services/business-operations/consolidation/__tests__/o3a-finances-etat.test.ts` |
| INV-015 | Une réduction/remboursement/indemnité ne doit pas être comptée deux fois. | AUTOMATISÉ | via F-095, F-096, F-097, F-120 |
| INV-016 | Une composante non attribuable d’une Opération multi-biens ne nourrit aucun TCO individuel. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-017 | Une sous-opération ne hérite pas automatiquement de tous les biens du parent. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-018 | Un parent peut n’avoir aucun montant propre. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| INV-019 | Le parent REALIZED n’impose pas REALIZED aux enfants sans preuve propre. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-020 | Une Opération annulée peut avoir des enfants réalisés si ceux-ci ont réellement eu lieu. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| INV-021 | Un Sinistre est REALIZED lorsqu’il survient, pas lorsqu’il est clôturé par l’assureur. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-022 | Le contrat d’assurance n’est pas parent du Sinistre par défaut. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| INV-023 | La réparation d’un Sinistre peut être une sous-opération. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-024 | Le financement peut être sous-opération de l’Acquisition. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| INV-025 | Le principal d’un financement ne double jamais le prix d’acquisition dans le TCO. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-026 | T2 lit l’information là où elle appartient naturellement. | AUTOMATISÉ | via F-126, F-131 |
| INV-027 | T2 ne recalcule pas une réalité déjà consolidée par T3. | AUTOMATISÉ | via F-127, F-135 |
| INV-028 | Le fallback T2 exclut les documents déjà représentés par les Opérations comptées. | AUTOMATISÉ | via F-129, F-135 |
| INV-029 | T4 projette dans le temps ; il n’est pas source unique de l’Opération. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-030 | Une projection Agenda issue d’une Opération ne doit pas provoquer une boucle de création. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-031 | TCO est un calcul dérivé et ne persiste pas une vérité financière concurrente. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-032 | Le BO diagnostique mais ne répare pas les Opérations par édition directe. | AUTOMATISÉ | `app/admin/operations/__tests__/o10-reconsolidation-ui.test.ts`<br>`app/api/admin/accounts/[id]/operations-reconsolidation/__tests__/o10-reconsolidation.test.ts`<br>`app/api/admin/operations/__tests__/o9-routes.test.ts`<br>`services/business-operations/diagnostics/__tests__/o9-diagnostics.test.ts`<br>`e2e/l47a-o9-bo-diagnostic.e2e.ts` |
| INV-033 | Aucun shadow mode n’est prévu. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-034 | Aucune feature flag fonctionnelle de désactivation du système Opération n’est prévue. | AUTOMATISÉ | `services/business-operations/__tests__/o1-socle.test.ts` |
| INV-035 | Le rollback est technique, pas un mode produit. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-036 | Les anciens documents ne sont pas backfillés massivement. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-037 | Les données structurées qui affirment une réalité métier doivent converger vers une Opération. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-038 | Chaque valeur consolidée doit rester explicable par ses sources et son historique. | AUTOMATISÉ | via ACC-002, F-050 |
| INV-039 | Une réanalyse identique est idempotente. | AUTOMATISÉ | `e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-040 | Un balayage horaire sans changement n’écrit rien. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l41-o3a-consolidation-t3.e2e.ts`<br>`e2e/l48-o10-recette-complements.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-041 | Une fusion ne perd ni source, ni composante, ni historique, ni relation utile. | AUTOMATISÉ | via F-049, F-050, F-051 |
| INV-042 | Une Opération invalidée ne nourrit plus T2 consolidé, T4, TCO ou exports métier. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-043 | Une Opération absorbée résout vers son Opération canonique. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| INV-044 | Les corrections utilisateur ont une autorité supérieure aux inférences automatiques sur le fait corrigé. | AUTOMATISÉ | via F-044, F-047 |
| INV-045 | Les rejets utilisateur de matching sont durables. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-046 | La profondeur hiérarchique maximale est de 3 niveaux. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts` |
| INV-047 | Une Opération n’a qu’un parent en V1. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts`<br>`e2e/l39-o1-socle-operations.e2e.ts` |
| INV-048 | Il n’existe pas de graphe transverse générique en V1. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts` |
| INV-049 | La devise originale est toujours conservée. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-050 | Une conversion EUR n’est jamais inventée. | AUTOMATISÉ | `services/business-operations/__tests__/o10-invariants.test.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-051 | Un contrat ne reconstruit pas des périodes tarifaires inconnues. | AUTOMATISÉ | via F-110 |
| INV-052 | Une cession utilise le prix réalisé lorsqu’il est connu ; le prix souhaité reste distinct. | AUTOMATISÉ | via F-018, F-124, F-125 |
| INV-053 | Le TCO peut être négatif. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| INV-054 | Les composants financiers sont des faits économiques, pas des documents. | AUTOMATISÉ | via F-032, F-108 |
| INV-055 | Plusieurs sources peuvent prouver une même composante financière. | AUTOMATISÉ | via F-108 |
| INV-056 | Une source supprimée force la réévaluation des faits qu’elle soutenait. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-057 | Le système ne maintient pas deux sources de vérité Sinistre après migration. | AUTOMATISÉ | `e2e/l48-o10-recette-complements.e2e.ts` |
| INV-058 | Toutes les Opérations sont scoppées au compte. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-059 | Les Opérations Duo sont partagées au niveau du compte ; les conversations T2 restent individuelles. | AUTOMATISÉ | `e2e/l48-o10-recette-jeux.e2e.ts` |
| INV-060 | Les Opérations suivent les politiques RGPD et de suppression du compte. | AUTOMATISÉ | `e2e/l39-o1-socle-operations.e2e.ts`<br>`e2e/l48-o10-recette-jeux.e2e.ts` |
