# Corpus E2E du CDC 15 (§15) — index

Les 43 scénarios du §15 (E2E-01 à E2E-20, E2E-T2-01 à E2E-T2-23) sont
chacun portés par au moins un test E2E dont le **titre commence par l'ID**
(`it('E2E-01 — …')`). Ils s'exécutent par `npm run test:e2e` (PostgreSQL
réel, sorties modèle enregistrées rejouées par la vraie passerelle, aucun
réseau — D-08, D-17).

Contrôle bloquant : `src/test/e2e/corpus-cdc15.test.ts` (exécuté par
`npm run test:run`, sans base) lit les fichiers `*.e2e.ts` et échoue si un
ID n'a aucun test actif (absent, ou seulement `it.todo` / `it.skip` /
`it.skipIf` / `it.runIf`, ou dans un fichier contenant `describe.skip` /
`describe.todo` / `describe.skipIf` / `describe.runIf`), ou si la ligne de
cet index ne désigne pas le fichier qui le porte.

**Ce contrôle statique ne suffit pas seul** : il garantit que les tests
existent, pas qu'ils passent. La CI doit exécuter `npm run test:e2e` (job
`e2e-pg`, PostgreSQL réel) et le rendre bloquant — les 43 scénarios doivent
y être verts (D-17).

**Commutateurs** — « cible » = `TARGET_SWITCHES` de `chain.ts` :
`AI_T1_ANALYSIS_MODE`, `CANONICAL_WRITE_MODE`, `T3_NEGATIVE_RECONCILIATION`,
`EXPORTS_CANONICAL_SOURCE` à `enabled`, T1 en architecture `master` par la
version de configuration. Depuis le lot 16b-2, `AI_T4_EFFECTS` et
`ASSISTANT_CANONICAL_READ` sont retirés (toujours actifs) et T2, T4, T5, T6
sont toujours en `master`. Le mode est rappelé dans le titre
de chaque test.

| ID | Fichier | Test | Commutateurs | Couverture de « Attendu » |
|----|---------|------|--------------|---------------------------|
| E2E-01 | corpus-e2e-documents.e2e.ts | E2E-01 — draisienne 24/04/2026 | cible, T1 master | acquisitionDate + prix, événement Achat HISTORICAL lié à la source, export (date, prix), T2 « 24 avril 2026 » |
| E2E-02 | corpus-e2e-documents.e2e.ts | E2E-02 — montant 749 EUR | cible, T1 master | 749 € sur la fiche, la colonne, l'export et T2 ; jamais 74 900 |
| E2E-03 | corpus-e2e-documents.e2e.ts | E2E-03 — facture réparation | cible, T1 master | acquisitionPrice inchangé ; événement réparation HISTORICAL |
| E2E-04 | corpus-e2e-documents.e2e.ts | E2E-04 — entretien + prochain entretien | cible, T1 master | lastRevision (historique) et maintenanceDueDate (échéance action) |
| E2E-05 | corpus-e2e-documents.e2e.ts | E2E-05 — entretien sans prochaine date | cible, T1 master | aucun DEADLINE inventé |
| E2E-06 | corpus-e2e-documents.e2e.ts | E2E-06 — DPE simple | cible, T1 master | dpeDate, ni dpeExpiryDate ni échéance |
| E2E-07 | corpus-e2e-documents.e2e.ts | E2E-07 — DPE + expiration explicite | cible, T1 master | dpeDate, dpeExpiryDate, une seule échéance |
| E2E-08 | corpus-e2e-documents.e2e.ts | E2E-08 — garantie | cible, T1 master | warrantyEndDate, événement garantie, source liée |
| E2E-09 | corpus-e2e-documents.e2e.ts | E2E-09 — contrôle technique | cible, T1 master | historique ; prochain contrôle seulement si le PV le porte |
| E2E-10 | corpus-e2e-cycle.e2e.ts | E2E-10 — document sans bien puis rattaché | cible, T1 master | fiche, preuves, agenda, export identiques à un rattachement initial |
| E2E-11 | corpus-e2e-cycle.e2e.ts | E2E-11 — déplacement A → B | cible, T1 master | A : aucune preuve, fiche vide, agenda vide, export vide ; B = état initial de A |
| E2E-12 | corpus-e2e-cycle.e2e.ts | E2E-12 — réanalyse, date corrigée | cible, T1 master | une preuve active, fiche corrigée, une seule échéance |
| E2E-13 | corpus-e2e-cycle.e2e.ts | E2E-13 — correction humaine | cible, T1 master | USER conservé après nouveau document ; T2 répond la valeur USER |
| E2E-14 | canonical-write.e2e.ts | E2E-14 (enabled) : fiche = colonne = vue canonique = … = export | CANONICAL_WRITE_MODE, EXPORTS_CANONICAL_SOURCE | fiche, colonne, vue canonique, T2 et export identiques ; compte étranger refusé (aussi `e2e-14-immatriculation.e2e.ts`, legacy/colonne) |
| E2E-15 | corpus-e2e-cycle.e2e.ts | E2E-15 — document via linkedAssetId | cible, T1 master | document dans l'export des deux biens et dans T2 (page du bien lié, liste) |
| E2E-16 | corpus-e2e-cycle.e2e.ts | E2E-16 — document multi-biens | cible, T1 master | faits par bien, aucun fait non ciblé, aucune date croisée, lien SECONDARY |
| E2E-17 | corpus-e2e-documents.e2e.ts | E2E-17 — facture équipement | cible, T1 master | preuves EQUIPMENT, fiche parente intacte, échéance liée à l'équipement |
| E2E-18 | corpus-e2e-cycle.e2e.ts | E2E-18 — événement T4 lié au document | cible, T1 master | événements du document = événements du bien ; autre compte : rien |
| E2E-19 | corpus-e2e-cycle.e2e.ts | E2E-19 — suppression d'un document | cible, T1 master | preuves retirées, champs automatiques retirés, USER intact, agenda automatique retiré |
| E2E-20 | corpus-e2e-cycle.e2e.ts | E2E-20 — source non autoritaire | cible, T1 master | devis : aucun élément d'agenda, une carte AGENDA-PROPOSAL ouverte |
| E2E-T2-01 | corpus-e2e-t2.e2e.ts | E2E-T2-01 — état canonique avant un ancien document | cible, T1+T2 master | fiche et T2 : valeur récente, jamais celle de l'ancien document |
| E2E-T2-02 | corpus-e2e-t2.e2e.ts | E2E-T2-02 — valeur USER prioritaire | cible, T1+T2 master | T2 : valeur USER « saisie par vous », aucune revalidation |
| E2E-T2-03 | corpus-e2e-t2.e2e.ts | E2E-T2-03 — « À traiter » | cible, T1+T2 master | sources T2 = actions de `getToProcessPage` (résolues exclues) |
| E2E-T2-04 | corpus-e2e-t2.e2e.ts | E2E-T2-04 — informations manquantes | cible, T1+T2 master | = `listMissingInformation` ; une saisie sort de la liste |
| E2E-T2-05 | corpus-e2e-t2.e2e.ts | E2E-T2-05 — fournisseurs | cible, T1+T2 master | sources `supplier` seules, dédoublonnées, compte seul |
| E2E-T2-06 | corpus-e2e-t2.e2e.ts | E2E-T2-06 — « Retrouve une facture » | cible, T1+T2 master | factures seules (devis, attestation exclus) |
| E2E-T2-07 | t2-routage-cibles.e2e.ts | E2E-T2-07 : documents non rattachés | lecture canonique (seule depuis L16b-2) | filtre exact : ni colonne ni lien N-N |
| E2E-T2-08 | corpus-e2e-t2.e2e.ts | E2E-T2-08 — échéances proches | cible, T1+T2 master | ordre chronologique ; ni HISTORICAL, ni passé, ni hors fenêtre |
| E2E-T2-09 | t2-routage-cibles.e2e.ts | E2E-T2-09 : bien courant puis échéances | lecture canonique (seule depuis L16b-2) | aucune échéance d'un autre bien |
| E2E-T2-10 | t2-routage-cibles.e2e.ts | E2E-T2-10 : page document + « Quel est le montant ? » | lecture canonique (seule depuis L16b-2) | le document de la page ; autre compte : rien |
| E2E-T2-11 | corpus-e2e-t2.e2e.ts | E2E-T2-11 — suivi conversationnel document | cible, T1+T2 master | « le deuxième » → 2e résultat affiché ; « son montant » → même document (aussi `t2-routage-cibles`) |
| E2E-T2-12 | corpus-e2e-t2.e2e.ts | E2E-T2-12 — suivi agenda | cible, T1+T2 master | « le premier » puis « quel est son statut ? » / « est-il réalisé ? » → même échéance |
| E2E-T2-13 | corpus-e2e-t2.e2e.ts | E2E-T2-13 — synthèse | cible, T1+T2 master, t2_answer rejoué | sources canonique + document + agenda + À traiter, toutes dans le prompt |
| E2E-T2-14 | corpus-e2e-t2.e2e.ts | E2E-T2-14 — comparaison | cible, T1+T2 master, t2_answer rejoué | mêmes dimensions pour les deux biens, valeur manquante signalée, documents sur leur bien |
| E2E-T2-15 | corpus-e2e-t2.e2e.ts | E2E-T2-15 — chronologie | cible, T1+T2 master | events[] triés : achat, entretien, réparation, sinistre, contrôle |
| E2E-T2-16 | corpus-e2e-t2.e2e.ts | E2E-T2-16 — somme sémantique | cible, T1+T2 master | entretien = 300,00 € (assurance exclue) |
| E2E-T2-17 | corpus-e2e-t2.e2e.ts | E2E-T2-17 — classification ambiguë | cible, T1+T2 master, t2_understand rejoué | clarification, aucune source |
| E2E-T2-18 | corpus-e2e-t2.e2e.ts | E2E-T2-18 — source hors type attendu | cible, T1+T2 master | sources ⊂ contrat de l'intention (agenda) ; procès-verbal rejeté |
| E2E-T2-19 | p-t2-master.e2e.ts | E2E-T2-19 (master) + P-T2-02 … | T2 master, lecture canonique, t2_answer rejoué | affirmation à source valide mais non soutenue rejetée (CLAIM_UNSUPPORTED) |
| E2E-T2-20 | t2-routage-cibles.e2e.ts | E2E-T2-20 + T2-37 | lecture canonique, écritures T2 actives | lecture, jamais de plan de commande |
| E2E-T2-21 | corpus-e2e-t2.e2e.ts | E2E-T2-21 — vraie modification | cible, T1+T2 master, écritures T2 actives | aperçu sans écriture → confirmation → valeur USER ; pas de rejeu |
| E2E-T2-22 | corpus-e2e-t2.e2e.ts | E2E-T2-22 — revalidation d'une échéance | cible, T1+T2 master, t2_revalidate rejoué | fait réinjecté, une preuve active, fiche (T3) et échéance (T4) à la date corrigée |
| E2E-T2-23 | corpus-e2e-t2.e2e.ts | E2E-T2-23 — conflit déjà arbitré | cible, T1+T2 master | carte d'arbitrage fermée (USER_COMPLETED) ; T2 : valeur retenue, plus « à arbitrer » |
