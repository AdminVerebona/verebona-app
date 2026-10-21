/**
 * Rattrapages de données pilotés depuis le BO « Exploitation » (lot 25,
 * chantier B) — catalogue PUR (aucun import serveur) : partagé par les routes
 * `/api/admin/ops/backfills` et par la page (`/admin/exploitation`).
 *
 * Ordre recommandé (celui de l'affichage) :
 *   1. fusion pièces → sous-structures (`npm run db:merge-rooms`) ;
 *   2. liens document ↔ bien (`scripts/backfill-document-asset-links.ts`) ;
 *   3. agenda (`scripts/agenda-backfill.ts`, `source-links` puis `dedupe`) ;
 *   4. rattrapage CDC 15 (`scripts/cdc15-backfill.ts --step all`) ;
 *   5. données des biens déplacés entre comptes (lot 40, Duo — aussi lancé
 *      automatiquement par la tâche `asset-account-backfill`) ;
 *   6. Opérations établies par les données structurées des biens (lot 43,
 *      C23.1 — aussi lancé automatiquement par `operations-structured-migration`) ;
 *   7. Sinistres : reprise de l'ancien formulaire (lot 44, C14.3 — aussi lancé
 *      automatiquement par `operations-claim-migration`) ;
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
 *      archivés — jamais automatique, journalisé et restaurable.
 *
 * Chaque bloc n'offre que ce que le script permet (simulation, application,
 * restauration). Les scripts CLI restent utilisables et appellent les mêmes
 * services.
 */

export type BackfillScript = 'merge-rooms' | 'document-asset-links' | 'agenda' | 'cdc15' | 'asset-account' | 'operations-structured' | 'operations-claims' | 'cross-account' | 'equipment-separation' | 'document-validation' | 'duo-shared-account';
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
  steps?: Array<{ code: string; label: string; description: string }>;
  /** Filtre « compte » accepté (exécution limitée à un compte). */
  accountFilter: boolean;
  /** Avertissement affiché sur le bloc (ex. écriture directe). */
  warning?: string;
}

export const BACKFILL_DEFINITIONS: readonly BackfillDefinition[] = [
  {
    script: 'merge-rooms',
    order: 1,
    label: 'Fusion des pièces dans les sous-structures',
    command: 'npm run db:merge-rooms',
    description: 'Reprise des pièces (rooms) dans les sous-structures (décision D-G). La simulation écrit seulement son rapport ; '
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
    script: 'operations-claims',
    order: 7,
    label: 'Sinistres : ancien formulaire',
    command: 'tâche planifiée « operations-claim-migration » (automatique)',
    description: 'Migration de l’ancien formulaire Sinistre (un seul sinistre par bien) vers la rubrique « Sinistres » (CDC Opérations '
      + 'C14.3) : type, dates, références, statut du dossier, textes, dommages, actions, échanges, montants. Un sinistre n’est créé '
      + 'que si l’ancienne saisie a au moins un type, une date, une référence ou un montant ; il est rapproché d’un sinistre déjà '
      + 'établi par les documents (même référence, même événement d’agenda, même date) au lieu d’être dupliqué ; l’événement '
      + 'd’agenda lié est rattaché, jamais recréé. La simulation exécute la migration dans une transaction annulée (rapport exact, '
      + 'aucune écriture). Lancé automatiquement au démarrage puis toutes les heures ; rejouée, elle ne change rien.',
    actions: ['simulate', 'apply'],
    accountFilter: true,
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
      { code: 'operations', label: 'Opérations et Sinistres', description: 'Contrat, événement, facture, échange, pièces et photos de dommage d’un autre compte (détachés) ; liens « cœur » des Opérations : procédure d’incident.' },
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
];

export const ACTION_LABELS: Record<BackfillAction, string> = {
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
    step = String(b.step ?? '');
    if (!def.steps.some((s) => s.code === step)) return { ok: false, code: 'INVALID_STEP', message: 'Étape inconnue.' };
  }
  let runId: string | null = null;
  if (action === 'restore') {
    runId = String(b.runId ?? '').trim();
    if (!UUID.test(runId)) return { ok: false, code: 'INVALID_RUN_ID', message: 'Identifiant d’exécution à restaurer invalide.' };
  }
  let accountId: number | null = null;
  if (b.accountId !== undefined && b.accountId !== null && b.accountId !== '') {
    if (!def.accountFilter || action === 'restore') {
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
