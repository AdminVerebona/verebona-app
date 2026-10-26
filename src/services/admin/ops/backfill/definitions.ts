/**
 * Rattrapages de données pilotés depuis le BO « Exploitation » (lot 25,
 * chantier B) — catalogue PUR (aucun import serveur) : partagé par les routes
 * `/api/admin/ops/backfills` et par la page (`/admin/exploitation`).
 *
 * Ordre recommandé (celui de l'affichage) :
 *   1. reprise des anciennes pièces `rooms` dans les Pièces `substructures` (`npm run db:merge-rooms`) ;
 *   2. liens document ↔ bien (`scripts/backfill-document-asset-links.ts`) ;
 *   3. agenda (`scripts/agenda-backfill.ts`, `source-links` puis `dedupe`) ;
 *   4. rattrapage CDC 15 (`scripts/cdc15-backfill.ts --step all`) ;
 *   5. données des biens déplacés entre comptes (lot 40, Duo — aussi lancé
 *      automatiquement par la tâche `asset-account-backfill`) ;
 *   6. Opérations établies par les données structurées des biens (lot 43,
 *      C23.1 — aussi lancé automatiquement par `operations-structured-migration`) ;
 *   7. Sinistres : nettoyage de l'ancien modèle (lot 83D, V-Q2 — jamais
 *      automatique ; refusé sans point de restauration de moins de 24 h),
 *      puis, lot 84A (O-10), étape finale « Finaliser » : suppression
 *      définitive des tables et colonnes de l'ancien modèle, possible
 *      seulement quand le nettoyage ne trouve plus rien sur aucun compte ;
 *   8. Relations intercomptes : correction contrôlée par famille (lot 53,
 *      retour PO D23 — jamais automatique, journalisée et restaurable) ;
 *   9. Séparation bien / équipement (lot 71A, BUG P1) : valeurs héritées
 *      corrigées après vérification de provenance, documents rattachés
 *      rétroactivement aux équipements — jamais automatique, journalisé ;
 *  10. Documents « à valider » (lot 71B, décision PO du 19/10 : plus de
 *      validation sur les fiches) — aussi lancé automatiquement par
 *      `document-validation-reprise` ;
 *  11. Premium Duo en compte partagé (lot 72D, ticket P0) : adhésions des
 *      membres Duo au compte du titulaire, comptes artificiels vides
 *      archivés — jamais automatique, journalisé et restaurable ;
 *  12. Agenda : doublons d'interventions (lot 76H, ticket P1) — même
 *      détection et même projection que le contrôle de cohérence quotidien
 *      COH-AGENDA-OCCURRENCES (lot 82B, qui remplace l'ancienne exécution
 *      automatique au démarrage), journalisé et restaurable ;
 *  13. « À traiter » : faux arbitrages entre valeurs équivalentes (lot 81A,
 *      ticket P1) — aussi lancé automatiquement (campagne bornée de la tâche
 *      `to-process-relevance-reevaluation`), jamais d'écriture sur la fiche.
 *  14. Opérations v5 : purge et reconstruction (lot 85A, CDC v5 O-2 —
 *      préproduction ; jamais automatique ; refusé sans point de
 *      restauration de moins de 24 h ; restaurable par exécution), suivie
 *      d'une campagne de cohérence sur les comptes reconstruits ;
 *  15. IA : reclassement de l'historique et configurations existantes (lot
 *      89A, Pilotage IA V2 P8, MIG-02 / MIG-03) — aussi lancé automatiquement
 *      par la tâche `ai-history-reclassification` quand AI_PILOTAGE_V2=on ;
 *      non destructif, idempotent, restaurable d'un geste ;
 *   0. Point de restauration de la base (lot 82E, décisions PO C-Q8 / D13) :
 *      « Appliquer » crée un point (même mécanisme que la sauvegarde
 *      nocturne) ; « Restaurer » ramène la base à un point (contrôle de
 *      schéma, point de l'état courant pris avant, tout ou rien). Affiché en
 *      tête : à faire AVANT une campagne de recette.
 *
 * Chaque bloc n'offre que ce que le script permet (simulation, application,
 * restauration). Les scripts CLI restent utilisables et appellent les mêmes
 * services.
 */

export type BackfillScript = 'database-restore-point' | 'merge-rooms' | 'document-asset-links' | 'agenda' | 'cdc15' | 'asset-account' | 'operations-structured' | 'claims-legacy-cleanup' | 'cross-account' | 'equipment-separation' | 'document-validation' | 'duo-shared-account' | 'agenda-intervention-duplicates' | 'to-process-false-arbitrations' | 'operations-v5-rebuild' | 'ai-history-reclassification';
export type BackfillAction = 'simulate' | 'apply' | 'restore';
export type BackfillStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface BackfillDefinition {
  script: BackfillScript;
  order: number;
  label: string;
  /** Équivalent en ligne de commande (référence pour l'exploitation). */
  command: string;
  description: string;
  actions: BackfillAction[];
  /** Étapes successives (agenda) ; chacune a ses propres actions. */
  steps?: BackfillStep[];
  /** Étape retenue quand la demande n'en précise pas (compatibilité d'un bloc devenu à étapes, lot 84A). */
  defaultStep?: string;
  /** Filtre « compte » accepté (exécution limitée à un compte). */
  accountFilter: boolean;
  /** Avertissement affiché sur le bloc (ex. écriture directe). */
  warning?: string;
}

interface BackfillStep {
  code: string;
  label: string;
  description: string;
  /** Actions permises pour CETTE étape (défaut : celles du bloc). */
  actions?: BackfillAction[];
  /** `false` : l'étape porte sur toute la plateforme (filtre « compte » refusé). */
  accountFilter?: boolean;
  /** Libellé du bouton d'application (défaut « Appliquer »). */
  applyLabel?: string;
  /** Avertissement propre à l'étape (dialogue de confirmation). */
  warning?: string;
}

/** Actions permises pour une étape (pure). */
export function stepActions(def: Pick<BackfillDefinition, 'actions' | 'steps'>, step: string | null): BackfillAction[] {
  const st = step ? def.steps?.find((x) => x.code === step) : undefined;
  return st?.actions ?? def.actions;
}

/** Libellé d'une action pour une étape (pure) : « Finaliser » au lieu d'« Appliquer » quand l'étape le déclare. */
export function actionLabel(def: Pick<BackfillDefinition, 'steps'>, step: string | null, action: BackfillAction): string {
  const st = step ? def.steps?.find((x) => x.code === step) : undefined;
  return action === 'apply' && st?.applyLabel ? st.applyLabel : ACTION_LABELS[action];
}

export const BACKFILL_DEFINITIONS: readonly BackfillDefinition[] = [
  {
    script: 'database-restore-point',
    order: 0,
    label: 'Point de restauration de la base (recettes)',
    command: 'BO uniquement (aucune commande) — même mécanisme que la sauvegarde nocturne',
    description: 'Avant une campagne de recette (contrôle de cohérence, rattrapage, réanalyse) : « Appliquer » crée un point de '
      + 'restauration — sauvegarde complète de la base lue dans UN instantané cohérent, au format exact de PostgreSQL, avec la '
      + 'signature du schéma (stockage OVH, conservée 30 jours, comme la sauvegarde nocturne). « Restaurer » ramène TOUTE la base au '
      + 'dernier point créé ici (ou à un point choisi dans Exploitation › Sauvegardes et recette) : contrôle du schéma (refus sans '
      + 'aucune écriture s’il a changé), point de l’état actuel pris juste avant, puis rechargement en une seule transaction '
      + '(relations revalidées, nombre de lignes de chaque table vérifié, identifiants conservés, envois en attente neutralisés). '
      + 'Journaux d’administration, d’exports, de rattrapages et de tâches planifiées conservés en l’état.',
    actions: ['apply', 'restore'],
    accountFilter: false,
    warning: 'Restaurer remplace les données de TOUS les comptes par celles du point et bloque l’application pendant le rechargement '
      + '(quelques minutes). Les fichiers du stockage ne sont pas concernés.',
  },
  {
    script: 'merge-rooms',
    order: 1,
    label: 'Reprise des anciennes pièces dans les Pièces',
    command: 'npm run db:merge-rooms',
    description: 'Reprise des anciennes pièces (table rooms) dans les Pièces (table substructures, décision D-G). La simulation écrit seulement son rapport ; '
      + 'l’application est journalisée ligne à ligne et restaurable par son identifiant d’exécution.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
  },
  {
    script: 'document-asset-links',
    order: 2,
    label: 'Liens document ↔ bien',
    command: 'npx tsx scripts/backfill-document-asset-links.ts',
    description: 'Rattrapage de la relation document ↔ bien (CDC 15 X-01) depuis les anciennes colonnes et propositions. '
      + 'Les cas ambigus vont au rapport, jamais tranchés.',
    actions: ['apply'],
    accountFilter: false,
    warning: 'Pas de simulation : ce rattrapage écrit directement. Il est idempotent — relancé, il ne crée aucun doublon.',
  },
  {
    script: 'agenda',
    order: 3,
    label: 'Agenda',
    command: 'npx tsx scripts/agenda-backfill.ts <source-links|dedupe> [--apply]',
    description: 'Rattrapages de l’agenda (CDC 15 §14 points 5 et 6), dans l’ordre : liens vers les documents sources, puis '
      + 'dédoublonnage des éléments automatiques. Aucun élément manuel ni modifié par l’utilisateur n’est touché.',
    actions: ['simulate', 'apply'],
    steps: [
      { code: 'source-links', label: '1. Liens sources', description: 'Liens document et traces de source des éléments d’agenda.' },
      { code: 'dedupe', label: '2. Dédoublonnage', description: 'Retrait des doublons automatiques (mêmes source, champ et date).' },
    ],
    accountFilter: false,
  },
  {
    script: 'cdc15',
    order: 4,
    label: 'Rattrapage CDC 15 (toutes étapes)',
    command: 'npx tsx scripts/cdc15-backfill.ts --step all',
    description: 'Étapes MIG-01, 03, 02, 04, 07, 08, 05, 06 dans cet ordre. La simulation écrit seulement son rapport ; '
      + 'l’application sauvegarde chaque valeur modifiée et se restaure par son identifiant d’exécution.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
  },
  {
    script: 'asset-account',
    order: 5,
    label: 'Biens déplacés : données restées dans l’ancien compte',
    command: 'tâche planifiée « asset-account-backfill » (automatique)',
    description: 'Biens déplacés entre comptes (Duo) avant le lot 40 : documents rattachés au seul bien, analyses, agenda, '
      + '« À traiter » et preuves remis dans le compte du bien ; un document aussi rattaché à un autre bien reste dans '
      + 'l’ancien compte (lien retiré). La simulation exécute le transfert dans une transaction annulée (rapport exact, '
      + 'aucune écriture). Lancé automatiquement au démarrage puis toutes les heures tant qu’il reste des biens à traiter.',
    actions: ['simulate', 'apply'],
    accountFilter: false,
  },
  {
    script: 'operations-structured',
    order: 6,
    label: 'Opérations : données structurées',
    command: 'tâche planifiée « operations-structured-migration » (automatique)',
    description: 'Migration structurée des Opérations (CDC Opérations C23.1) : date et prix d’achat, statut Vendu / Transmis '
      + 'avec date et prix de vente réalisés, assureur et n° de contrat saisis sur la fiche des biens deviennent l’Acquisition, '
      + 'la Cession et le Contrat correspondants — rapprochés des Opérations issues des documents, jamais en doublon. Seules '
      + 'les valeurs saisies par l’utilisateur comptent ; aucun document n’est réanalysé. La simulation exécute la réconciliation '
      + 'dans une transaction annulée (rapport exact, aucune écriture). Lancé automatiquement au démarrage puis toutes les heures '
      + 'tant qu’il reste des biens à examiner ; rejouée, elle ne change rien.',
    actions: ['simulate', 'apply'],
    accountFilter: true,
  },
  {
    // Lot 83D (CDC v5 §15–§18 ; arbitrages V-Q1, V-Q2, C-Q5, C-Q8) : remplace la
    // reprise de l'ancien formulaire (lot 44, tâche retirée).
    script: 'claims-legacy-cleanup',
    order: 7,
    label: 'Sinistres : nettoyage de l’ancien modèle',
    command: 'BO uniquement (aucune commande) — jamais lancé automatiquement',
    description: 'Le bloc « Sinistres » des biens est supprimé : le sinistre vit dans ses documents, son événement d’agenda et '
      + 'le dossier Assurance-sinistre. Ce rattrapage purge les données PROPRES à l’ancien bloc : actions et échanges de sinistre, '
      + 'lien « intervention enfant d’un sinistre » (l’intervention elle-même est conservée), ancien formulaire Sinistre des biens '
      + 'et repères de sa migration, questions « À traiter » de lien intervention ↔ sinistre encore ouvertes (closes). Ne touche '
      + 'jamais aux documents, photos, Opérations, événements, agenda, Pièces, équipements, détails d’assurance ni aux dommages '
      + 'détaillés (conservés pour le dossier d’assurance). Simuler : rapport exact, rien n’est écrit. Appliquer : REFUSÉ sans point '
      + 'de restauration de moins de 24 h (bloc 0) ; chaque ligne retirée est journalisée, puis un contrôle de cohérence est lancé '
      + 'sur les comptes actifs concernés. Restaurer : par l’identifiant d’exécution (journal rejoué). Rejoué, il ne change rien. '
      + 'Lot 84A : quand le nettoyage ne trouve plus rien sur aucun compte, l’étape 2 « Finaliser » supprime définitivement les '
      + 'tables et colonnes de l’ancien modèle (vides) — irréversible depuis le BO.',
    actions: ['simulate', 'apply', 'restore'],
    steps: [
      {
        code: 'cleanup', label: '1. Nettoyage (tous les comptes, ou un compte)',
        description: 'Purge journalisée et restaurable des données propres à l’ancien bloc (voir ci-dessus).',
      },
      {
        code: 'finalize', label: '2. Suppression définitive (finaliser)',
        description: 'Étape finale, une seule fois, pour toute la plateforme : supprime les tables des actions, échanges et repères de '
          + 'migration de l’ancien modèle, le lien « intervention enfant » et l’ancien formulaire Sinistre des biens. Possible seulement '
          + 'si l’étape 1 ne trouve plus rien sur AUCUN compte, avec un point de restauration de moins de 24 h. Simuler : rapport exact '
          + '(ce qui disparaîtrait, motifs de refus), rien n’est modifié. Après la finalisation, l’étape 1 ne peut plus être restaurée et '
          + 'les points de restauration antérieurs sont refusés : créez-en un nouveau.',
        actions: ['simulate', 'apply'],
        accountFilter: false,
        applyLabel: 'Finaliser',
        warning: 'Suppression DÉFINITIVE, irréversible depuis le BO (seul un point de restauration créé APRÈS restera restaurable). '
          + 'Simulez d’abord ; refusé si le nettoyage n’est pas complet ou sans point de restauration de moins de 24 h.',
      },
    ],
    defaultStep: 'cleanup',
    accountFilter: true,
    warning: 'Créez d’abord un point de restauration (bloc 0), puis Simuler, lire le rapport, et Appliquer. Faites un export '
      + 'complet de recette avant et après si vous comparez.',
  },
  {
    script: 'cross-account',
    order: 8,
    label: 'Isolation des comptes : correction contrôlée des anomalies',
    command: 'BO uniquement (aucune commande)',
    description: 'Détache les relations anciennes entre deux comptes (BO › Exploitation › Isolation des comptes), famille par famille : '
      + 'colonne de rattachement remise à vide, lien retiré ou rendu inactif — chaque objet reste dans son propre compte, rien n’est '
      + 'supprimé d’un compte ni déplacé. Les relations relevant du Duo (déplacement de bien, comptes reliés par un Duo) et celles dont '
      + 'un compte est inconnu sont SIGNALÉES, jamais corrigées. La simulation exécute la correction dans une transaction annulée '
      + '(rapport exact) ; l’application est journalisée ligne à ligne (état avant complet : sauvegarde), suivie d’un recontrôle '
      + 'd’intégrité de la famille, et se restaure par son identifiant d’exécution. Les liens « cœur » des Opérations restent en '
      + 'procédure d’incident (recensés, jamais modifiés ici). Jamais lancée automatiquement.',
    actions: ['simulate', 'apply', 'restore'],
    steps: [
      { code: 'documents', label: 'Documents → biens, pièces, équipements', description: 'Colonnes de rattachement et liens N-N document ↔ bien.' },
      { code: 'fournisseurs', label: 'Fournisseurs', description: 'Liens document / équipement / bien ↔ fiche fournisseur d’un autre compte.' },
      { code: 'evenements', label: 'Événements et échéances historiques', description: 'Pièces jointes et cibles d’un autre compte.' },
      { code: 'agenda', label: 'Agenda', description: 'Liens bien, document, pièce, équipement et traces de source.' },
      { code: 'preuves', label: 'Preuves et données projetées', description: 'Preuves retirées, faits « superseded », journal « Ce que j’ai fait ».' },
      { code: 'a_traiter', label: 'À traiter', description: 'Cartes ouvertes visant un objet d’un autre compte (closes « obsolètes »).' },
      { code: 'jobs', label: 'Jobs IA en attente', description: 'Jobs PENDING référençant un objet d’un autre compte, y compris dans leur contexte imbriqué (annulés).' },
      { code: 'operations', label: 'Opérations et Sinistres', description: 'Contrat, événement, pièces et photos de dommage d’un autre compte (détachés) ; liens « cœur » des Opérations : procédure d’incident.' },
    ],
    accountFilter: true,
    warning: 'Correction de sécurité (D23) : à lancer après lecture de la simulation. Le Duo (D3) reste ouvert : ses relations ne sont jamais modifiées ici.',
  },
  {
    script: 'equipment-separation',
    order: 9,
    label: 'Séparation bien / équipement',
    command: 'BO uniquement (aucune commande)',
    description: 'Corrige les données échangées à tort entre un bien et ses équipements (date et prix d’achat), APRÈS vérification de leur '
      + 'provenance : une date identique ne prouve rien. Sont corrigées : la date / le prix d’achat du bien déduits du justificatif d’achat '
      + 'd’un équipement ; la même preuve attribuée au bien ET à un équipement (acte : valeur du bien ; facture : valeur de l’équipement) ; '
      + 'la date d’achat du bien recopiée depuis un événement « achat » lié à un équipement (déplacée sur l’équipement). La preuve erronée '
      + 'est retirée puis la fiche réconciliée : la bonne valeur est restaurée quand elle est connue, sinon le champ reste vide ; une valeur '
      + 'saisie ou validée par l’utilisateur n’est jamais modifiée (comptée « préservée »). Les documents sont ensuite rapprochés '
      + 'rétroactivement des équipements de leur bien (n° de série, modèle, désignation, cible T1) — un cas ambigu reste rattaché au bien '
      + '(carte « À traiter » à l’application). La simulation n’écrit rien ; l’application est tracée ligne à ligne avec le motif. '
      + 'Rejoué, il ne change rien. Lot 75G : un document peut couvrir plusieurs acquisitions légitimes — seules les erreurs à provenance '
      + 'DÉMONTRÉE sont corrigées (équipement du même bien, même valeur, aucune acquisition du bien dans le document) ; les autres situations, '
      + 'et les autres attributs propres (marque, modèle, n° de série, garanties, valeur estimée) identiques au bien, sont signalés comme '
      + 'suspects sans modification. Tous les documents sont examinés (par pages) ; une exécution interrompue est reprise au passage suivant.',
    actions: ['simulate', 'apply'],
    accountFilter: true,
  },
  {
    script: 'document-validation',
    order: 10,
    label: 'Documents « à valider » : reprise',
    command: 'tâche planifiée « document-validation-reprise » (automatique)',
    description: 'Plus de validation sur les fiches (décision PO du 19/10) : les documents restés « à valider » (ancien bandeau '
      + '« Automatique — Validation suggérée » et bouton « Appliquer ») sont repassés « analysés », puis leurs données sont réévaluées '
      + 'par les moteurs existants : une valeur fiable, sans conflit, est écrite directement (tracée, valeur automatique) ; une valeur '
      + 'incertaine ou contradictoire devient une carte « À traiter » (jamais en double) ; une valeur saisie par l’utilisateur n’est '
      + 'jamais modifiée ; les équipements désignés sans ambiguïté sont rattachés (sinon carte « À traiter »), sans appel IA. '
      + 'Chaque document repris est tracé avec le motif. La simulation n’écrit rien. Lancé automatiquement au démarrage puis toutes '
      + 'les heures tant qu’il reste des documents ; rejoué, il ne change rien.',
    actions: ['simulate', 'apply'],
    accountFilter: true,
  },
  {
    script: 'duo-shared-account',
    order: 11,
    label: 'Premium Duo : compte partagé',
    command: 'BO uniquement (aucune commande)',
    description: 'Lot 72D : rattache chaque membre actif d’un Premium Duo au compte EXISTANT du titulaire (adhésion « membre »), '
      + 'rétablit l’adhésion « titulaire » manquante des comptes, et archive — sans rien effacer, de façon réversible — les comptes '
      + 'personnels artificiels VIDES créés aux invités (aucune donnée, aucun autre membre, aucune facturation). Un compte personnel '
      + 'avec des données, un abonnement propre ou des biens reçus n’est jamais touché (rapport seul) ; aucun compte n’est fusionné, '
      + 'aucun bien déplacé, aucun essai réinitialisé, rien n’est envoyé à Stripe. Rapport avant / après (catégories INV-A à INV-I). '
      + 'La simulation n’écrit rien ; l’application est journalisée ligne à ligne et se restaure par son identifiant d’exécution. '
      + 'Rejouée, elle ne fait rien. Jamais lancée automatiquement.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
    warning: 'À lancer après lecture de la simulation. Les Duo « indécidables » (compte introuvable ou ambigu) et les places '
      + 'épuisées sont seulement signalés.',
  },
  {
    script: 'agenda-intervention-duplicates',
    order: 12,
    label: 'Agenda : représentation des Opérations (doublons, étapes, rattachements)',
    command: 'tâche planifiée « coherence-control » (contrôle COH-AGENDA-OCCURRENCES, quotidien et ciblé)',
    description: 'Lot 76H / 87B : reprise du STOCK de la représentation Agenda des Opérations (interventions, sinistres, achats, cessions). '
      + 'Sélection (signaux seulement) : événements automatiques d’un document de l’Opération non reliés, Opérations reliées à plusieurs '
      + 'événements, anciennes consolidations décidées par l’ancienne règle (jamais validées), résidus de fusion. La projection est rejouée '
      + '(rattachement seulement par provenance exacte : document de l’Opération, source établie par T3) ; quand plusieurs représentations '
      + 'sont possibles (doublons ? étapes distinctes ?) la décision est demandée à T4 (plusieurs événements examinés ensemble, preuves '
      + 'conservées, corrections de l’utilisateur respectées, application tout ou rien, journal des réévaluations). Tant que le contrat T4 '
      + 'multi-événements n’est pas livré : constat, aucune fusion ni séparation par le code (carte « À traiter » quand rien ne représente '
      + 'encore l’événement). La simulation n’écrit rien ; l’application se restaure par son identifiant (consolidations décidées par T4). '
      + 'Rejouée, elle ne redemande rien (mémoire des décisions T4). Doublons sans Opération : signalés seulement.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
  },
  {
    script: 'to-process-false-arbitrations',
    order: 13,
    label: '« À traiter » : faux arbitrages (valeurs équivalentes)',
    command: 'tâche planifiée « to-process-relevance-reevaluation » (automatique, campagne bornée)',
    description: 'Lot 81A : cartes « À arbitrer » dont une proposition est équivalente à la valeur actuelle après normalisation '
      + '(ex. « 06/05/2021 » contre « 06/05/2021 ») ou en double. Chaque carte est RÉÉVALUÉE par le moteur T3 corrigé, en lecture '
      + 'seule (preuves actives, valeur de la fiche, décisions déjà prises par l’utilisateur) : une vraie contradiction (troisième '
      + 'valeur, preuve divergente) met la carte à jour avec les bonnes valeurs ; sans contradiction, la carte est close « sans objet ». '
      + 'Aucune valeur de la fiche n’est modifiée, aucune carte n’est supprimée ; chaque carte réexaminée est tracée (valeur actuelle, '
      + 'valeurs candidates, preuves, motif initial, décision corrective) dans l’historique de la carte (Données du compte). Les cartes '
      + 'd’autres familles (documents…) sont seulement comptées. La simulation n’écrit rien. Aussi lancé automatiquement toutes les '
      + 'heures (campagne « l81-faux-arbitrages-1 », bornée et reprise après redémarrage) ; rejoué, il ne change rien.',
    actions: ['simulate', 'apply'],
    accountFilter: true,
  },
  {
    // Lot 85A (CDC v5 lot O-2, §20, AC41–AC43 ; arbitrages V-Q2, V-Q3, C-Q5, C-Q8, C-Q10).
    script: 'operations-v5-rebuild',
    order: 14,
    label: 'Opérations v5 : purge et reconstruction (préproduction)',
    command: 'BO uniquement (aucune commande) — jamais lancé automatiquement',
    description: 'Reconstruit les regroupements de documents (interventions, contrats, sinistres…) et leur représentation dans l’agenda '
      + 'avec les règles actuelles, à partir des sources conservées : documents et leurs analyses DÉJÀ faites (aucune nouvelle analyse '
      + 'des documents), données des fiches, éléments d’agenda saisis, Pièces et équipements, décisions de l’utilisateur. Purgé : ce qui '
      + 'est seulement DÉDUIT (regroupements automatiques, leurs liens et montants calculés, événements d’agenda générés automatiquement '
      + 'et jamais touchés, questions « À traiter » devenues sans objet). Jamais touché : tout ce que l’utilisateur a saisi, modifié, '
      + 'relié, confirmé, refusé ou supprimé (événements saisis ou modifiés, dates choisies, liens manuels, décisions de regroupement, '
      + 'biens retirés, événements supprimés, décisions TCO — un regroupement que l’utilisateur a touché est conservé et seulement '
      + 'recalculé). Puis : consolidation complète, séries de factures récurrentes, liens aux équipements, agenda et événements de '
      + 'référence, cartes « À traiter », TCO relu et comparé ; rapport par compte. Comptes non actifs ou en lecture seule : exclus. '
      + 'Simuler : inventaire exact par compte, rien n’est écrit. Appliquer : REFUSÉ sans point de restauration de moins de 24 h (bloc 0) ; '
      + 'les traitements automatiques du compte attendent pendant sa reconstruction ; puis contrôle de cohérence des comptes reconstruits. '
      + 'Rejoué sur un compte inchangé : rien n’est écrit. Restaurer : par l’identifiant d’exécution, chaque compte revient exactement à '
      + 'son état d’avant (refusé pour un compte modifié depuis — le point de restauration de la base reste le recours).',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
    warning: 'Préproduction uniquement. Créez d’abord un point de restauration (bloc 0), faites un export complet de recette, Simulez sur '
      + 'un compte, lisez le rapport, puis Appliquez (un compte, puis tous). L’analyse IA de rapprochement (M3) peut être sollicitée, '
      + 'dans ses plafonds habituels (5 appels par passage, 30 par jour et par compte, plafond de coût mensuel).',
  },
  {
    // Lot 89A (CDC Pilotage IA V2 P8, MIG-02, MIG-03, LIV-02).
    script: 'ai-history-reclassification',
    order: 15,
    label: 'IA : reclassement de l’historique et configurations existantes (Pilotage IA V2)',
    command: 'BO uniquement (aucune commande) — aussi lancé automatiquement quand AI_PILOTAGE_V2=on',
    description: 'Classe les appels IA ANTÉRIEURS au suivi par exécution (lot 83) selon une règle versionnée (p8-historique-v1) : nature '
      + 'métier, technique (sonde, qualification, test, balayage planifié) ou non déterminable ; traitement ; exécution métier seulement si '
      + 'un lien enregistré la prouve (travail de la file, rapport d’analyse, génération ou évaluation de la mascotte) et son issue '
      + '(Réussie, Incomplète, Échouée…). Sans preuve : « non déterminable », avec le motif — jamais de rapprochement à l’heure, aucun '
      + 'appel IA. Chaque appel garde sa trace d’origine ; le classement et sa preuve sont écrits à côté. Les appels suivis par le nouveau '
      + 'chemin ne sont jamais touchés. Marque aussi les versions de configuration existantes « manuel, non qualifié » (affichage '
      + 'seulement : leur fonctionnement ne change pas). Simuler : comptes par nature, traitement et issue, rien n’est écrit. Appliquer : '
      + 'relancé, rien n’est réécrit. Restaurer (avec l’identifiant donné dans le rapport) : tout le classement et les marques sont retirés.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: false,
  },
];

const ACTION_LABELS: Record<BackfillAction, string> = {
  simulate: 'Simuler',
  apply: 'Appliquer',
  restore: 'Restaurer',
};

export const STATUS_LABELS: Record<BackfillStatus, string> = {
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échec',
  interrupted: 'Interrompu',
};

export const REASON_MIN = 5;
export const REASON_MAX = 500;

export function backfillDefinition(script: string): BackfillDefinition | null {
  return BACKFILL_DEFINITIONS.find((d) => d.script === script) ?? null;
}

/** Le motif est obligatoire pour toute écriture (application, restauration). */
export function reasonRequired(action: BackfillAction): boolean {
  return action !== 'simulate';
}

export interface BackfillRequest {
  script: BackfillScript;
  action: BackfillAction;
  step: string | null;
  /** Identifiant d'exécution du script à restaurer (`--restore <runId>`). */
  runId: string | null;
  accountId: number | null;
  reason: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validation d'une demande (pure). */
export function validateBackfillRequest(body: unknown): { ok: true; value: BackfillRequest } | { ok: false; code: string; message: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const def = backfillDefinition(String(b.script ?? ''));
  if (!def) return { ok: false, code: 'UNKNOWN_SCRIPT', message: 'Rattrapage inconnu.' };
  const action = String(b.action ?? '') as BackfillAction;
  if (!def.actions.includes(action)) {
    return { ok: false, code: 'ACTION_NOT_SUPPORTED', message: `« ${def.label} » ne permet pas l’action « ${action || '?'} ».` };
  }
  let step: string | null = null;
  // Une restauration vise une exécution (son identifiant), pas une étape.
  if (def.steps && action !== 'restore') {
    step = String(b.step ?? def.defaultStep ?? '');
    const st = def.steps.find((s) => s.code === step);
    if (!st) return { ok: false, code: 'INVALID_STEP', message: 'Étape inconnue.' };
    if (st.actions && !st.actions.includes(action)) {
      return { ok: false, code: 'ACTION_NOT_SUPPORTED', message: `« ${st.label} » ne permet pas l’action « ${action} ».` };
    }
  }
  let runId: string | null = null;
  if (action === 'restore') {
    runId = String(b.runId ?? '').trim();
    if (!UUID.test(runId)) return { ok: false, code: 'INVALID_RUN_ID', message: 'Identifiant d’exécution à restaurer invalide.' };
  }
  let accountId: number | null = null;
  if (b.accountId !== undefined && b.accountId !== null && b.accountId !== '') {
    if (!def.accountFilter || action === 'restore' || def.steps?.find((s) => s.code === step)?.accountFilter === false) {
      return { ok: false, code: 'ACCOUNT_FILTER_NOT_SUPPORTED', message: 'Ce rattrapage ne se limite pas à un compte.' };
    }
    const n = Number(b.accountId);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, code: 'INVALID_ACCOUNT', message: 'Identifiant de compte invalide.' };
    accountId = n;
  }
  const brut = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reasonRequired(action) && brut.length < REASON_MIN) {
    return { ok: false, code: 'REASON_REQUIRED', message: `Motif obligatoire (${REASON_MIN} caractères au moins).` };
  }
  if (brut.length > REASON_MAX) return { ok: false, code: 'REASON_TOO_LONG', message: `Motif limité à ${REASON_MAX} caractères.` };
  return { ok: true, value: { script: def.script, action, step, runId, accountId, reason: brut || null } };
}
