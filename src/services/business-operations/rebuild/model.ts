/**
 * Lot 85A — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-2
 * (§20, AC41–AC43, E20) : purge et reconstruction des Opérations en
 * PRÉPRODUCTION (arbitrages PO V-Q2, V-Q3 — aucune production —, C-Q5, C-Q8,
 * C-Q10). Règles PURES (aucun accès base) : partagées par le service
 * (`service.ts`), le rapport BO et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST DÉRIVÉ ET PURGEABLE (§20.3) — et ce qui ne l'est jamais
 *
 * Une Opération est PURGÉE (supprimée, avec ses sources, liens, appartenances,
 * composantes, références, historique, revues d'identité, détails dérivés)
 * seulement si RIEN dans ses données ne vient d'un geste de l'utilisateur ni
 * d'une source que plus aucun traitement ne reproduit. Sinon elle est
 * CONSERVÉE (son identifiant porte les décisions de l'utilisateur) et
 * seulement RECALCULÉE depuis ses sources (variante prudente : un regroupement
 * que l'utilisateur a touché n'est jamais défait par la reconstruction).
 *
 *   Motif de conservation (`KeepReason`)      Donnée de l'utilisateur protégée
 *   ─────────────────────────────────────     ─────────────────────────────────
 *   USER_GESTURE        historique signé par un utilisateur (geste au tiroir…)
 *   USER_SOURCE         source « ancien formulaire Sinistre », arbitrage,
 *                       reprise, lien posé par l'utilisateur (agenda)
 *   USER_DECISION       décision de la mémoire unifiée (82D / 84B) : rattaché,
 *                       refusé, dissocié, principal désigné ou retiré
 *   ASSET_EXCLUSION     bien retiré par l'utilisateur
 *   PROJECTION_SUPPRESSED  projection supprimée par l'utilisateur
 *   USER_AGENDA_ROLE    élément d'agenda rattaché / désigné par l'utilisateur
 *   USER_DOCUMENT       document rattaché par l'utilisateur
 *   CLAIM_DATA          dommages détaillés (dossier d'assurance, V-Q8)
 *   LEGACY_CLAIM        ancien modèle Sinistres encore présent (avant 84A)
 *   TCO_DECISION        décision TCO sans autre identité stable (clé `o:`)
 *   LINKED              Opération dont dépend une Opération conservée
 *                       (fusion, contrat d'assurance d'un sinistre conservé)
 *
 * Éléments d'agenda : seules les PROJECTIONS AUTOMATIQUES INTACTES d'une
 * Opération purgée sont retirées (`removeAgendaItemsTraced`, trace
 * restaurable) — jamais un élément saisi, modifié, confirmé, à statut, relié
 * manuellement à un document, avec une préférence de rappel ou des travaux.
 * Les autres éléments sont seulement détachés (rôle retiré) ; la provenance
 * dérivée `OPERATION_PRINCIPAL` des liens Document ↔ Agenda est retirée, un
 * lien sans autre provenance disparaît, les liens manuels restent.
 *
 * Reconstruction (sans nouvelle analyse T1 : les candidats T1 PERSISTÉS sont
 * remis en consolidation) : T3 complet (données structurées, agenda,
 * documents, attentes, M3 sous ses plafonds), réexamen rétroactif des séries
 * (55B / 84E), Opérations conservées recalculées, liens directs équipement
 * (84E), projection Agenda et principaux (83A / 82D / 84B), cartes
 * « À traiter », TCO relu (calculé à la lecture).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { LEGACY_CLAIM_TABLES } from '../claims/legacy-schema';

/** Version des règles de reconstruction : la changer rend tous les comptes « à reconstruire ». */
export const REBUILD_VERSION = 'l85a-v1';

export const KEEP_REASONS = [
  'USER_GESTURE', 'USER_SOURCE', 'USER_DECISION', 'ASSET_EXCLUSION', 'PROJECTION_SUPPRESSED', 'USER_AGENDA_ROLE',
  'USER_DOCUMENT', 'CLAIM_DATA', 'LEGACY_CLAIM', 'TCO_DECISION', 'LINKED',
] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];

export const KEEP_REASON_LABELS: Readonly<Record<KeepReason, string>> = {
  USER_GESTURE: 'geste de l’utilisateur dans l’historique',
  USER_SOURCE: 'source saisie ou reliée par l’utilisateur (ancien formulaire Sinistre, arbitrage, lien agenda)',
  USER_DECISION: 'décision de l’utilisateur (rattaché, refusé, dissocié, événement de référence)',
  ASSET_EXCLUSION: 'bien retiré par l’utilisateur',
  PROJECTION_SUPPRESSED: 'événement supprimé par l’utilisateur (suppression mémorisée)',
  USER_AGENDA_ROLE: 'événement rattaché ou désigné par l’utilisateur',
  USER_DOCUMENT: 'document rattaché par l’utilisateur',
  CLAIM_DATA: 'dommages détaillés du dossier d’assurance',
  LEGACY_CLAIM: 'ancien modèle Sinistres encore présent (nettoyage non finalisé)',
  TCO_DECISION: 'décision TCO de l’utilisateur sans autre identité stable',
  LINKED: 'Opération dont dépend une Opération conservée (fusion, contrat d’assurance)',
};

/** Indicateurs lus pour une Opération (inventaire en lecture seule). */
export interface OperationFlags {
  id: number;
  invalidated: boolean;
  mergedInto: number | null;
  userHistory: boolean;
  userSource: boolean;
  userDecision: boolean;
  exclusion: boolean;
  suppression: boolean;
  userAgendaRole: boolean;
  userDocument: boolean;
  claimDamages: boolean;
  legacyClaim: boolean;
  /** Contrat d'assurance désigné par le sinistre (détails CLAIM). */
  insuranceContract: number | null;
  /** Ancien lien parent / enfant encore présent (avant 84A) : les deux bouts. */
  legacyParent: number | null;
}

/** Motifs propres d'une Opération (pure). */
export function ownKeepReasons(f: OperationFlags): KeepReason[] {
  const out: KeepReason[] = [];
  if (f.userHistory) out.push('USER_GESTURE');
  if (f.userSource) out.push('USER_SOURCE');
  if (f.userDecision) out.push('USER_DECISION');
  if (f.exclusion) out.push('ASSET_EXCLUSION');
  if (f.suppression) out.push('PROJECTION_SUPPRESSED');
  if (f.userAgendaRole) out.push('USER_AGENDA_ROLE');
  if (f.userDocument) out.push('USER_DOCUMENT');
  if (f.claimDamages) out.push('CLAIM_DATA');
  if (f.legacyClaim || f.legacyParent !== null) out.push('LEGACY_CLAIM');
  return out;
}

/**
 * Ensemble CONSERVÉ (pure) : motifs propres, Opérations imposées (décision
 * TCO sans autre identité), puis fermeture : la cible de fusion d'une
 * Opération conservée, le contrat d'assurance d'un sinistre conservé et les
 * deux bouts d'un ancien lien parent sont conservés (aucune clé étrangère
 * ne pointe jamais vers une Opération purgée).
 */
export function computeKeepSet(flags: readonly OperationFlags[], forced: ReadonlyMap<number, KeepReason> = new Map()): Map<number, KeepReason[]> {
  const parId = new Map(flags.map((f) => [f.id, f]));
  const keep = new Map<number, KeepReason[]>();
  const ajouter = (id: number, r: KeepReason) => {
    if (!parId.has(id)) return false;
    const cur = keep.get(id);
    if (cur?.includes(r)) return false;
    keep.set(id, [...(cur ?? []), r]);
    return !cur;
  };
  for (const f of flags) for (const r of ownKeepReasons(f)) ajouter(f.id, r);
  for (const [id, r] of forced) ajouter(id, r);
  // Ancien lien parent : l'enfant conservé garde son parent, et inversement.
  for (const f of flags) if (f.legacyParent !== null) ajouter(f.legacyParent, 'LEGACY_CLAIM');
  let change = true;
  while (change) {
    change = false;
    for (const id of [...keep.keys()]) {
      const f = parId.get(id)!;
      if (f.mergedInto !== null && !keep.has(f.mergedInto)) change = ajouter(f.mergedInto, 'LINKED') || change;
      if (f.insuranceContract !== null && !keep.has(f.insuranceContract)) change = ajouter(f.insuranceContract, 'LINKED') || change;
    }
  }
  return keep;
}

// ── Décisions TCO (O-9) : clé `o:` d'une Opération purgée → clé stable `s:` ─

export interface LegacyOperationKey { operationId: number; fact: string; kind: string; amountMinor: number; currency: string }

/** `o:<Opération>:<nature>:<montant>:<devise>` → éléments, ou null (pure). */
export function parseLegacyOperationKey(key: string): LegacyOperationKey | null {
  const m = /^o:(\d{1,18}):([A-Z_]+):(\d{1,18}):([A-Z]{0,3})$/.exec(key);
  if (!m) return null;
  return { operationId: Number(m[1]), fact: `${m[2]}:${m[3]}:${m[4]}`, kind: m[2], amountMinor: Number(m[3]), currency: m[4] };
}

/** Nouvelle clé stable d'une décision `o:` (même forme que `tcoLineKeys`), null sans identité reproductible (pure). */
export function stableDecisionKey(identities: readonly string[], fact: string): string | null {
  const ids = [...new Set(identities)].sort();
  return ids.length ? `s:${ids[0]}:${fact}` : null;
}

// ── Statuts et rapport ──────────────────────────────────────────────────────

export type RebuildAccountStatus =
  | 'PLANNED' | 'UP_TO_DATE' | 'INELIGIBLE' | 'BUSY' | 'REBUILT' | 'PARTIAL' | 'FAILED' | 'RESTORED' | 'RESTORE_REFUSED';

export const ACCOUNT_STATUS_LABELS: Readonly<Record<RebuildAccountStatus, string>> = {
  PLANNED: 'à reconstruire (simulation)',
  UP_TO_DATE: 'déjà reconstruit, inchangé depuis : rien à faire',
  INELIGIBLE: 'compte non actif ou en lecture seule : exclu (C-Q10)',
  BUSY: 'un traitement T3 / T4 du compte est en cours : compte reporté, relancer plus tard',
  REBUILT: 'reconstruit',
  PARTIAL: 'reconstruit avec des points à reprendre (voir le rapport)',
  FAILED: 'échec : rien n’a été purgé, ou purge annulée (voir le rapport)',
  RESTORED: 'restauré à l’état d’avant la reconstruction',
  RESTORE_REFUSED: 'restauration refusée : le compte a changé depuis la reconstruction',
};

/** Statut d'un compte avant tout travail (pure) — l'ordre des gardes compte. */
export function preflightStatus(p: { eligible: boolean; busy: boolean; upToDate: boolean; mode: 'SIMULATE' | 'APPLY' }): RebuildAccountStatus | null {
  if (!p.eligible) return 'INELIGIBLE';
  if (p.upToDate) return 'UP_TO_DATE';
  if (p.busy && p.mode === 'APPLY') return 'BUSY';
  return null;
}

/** Inventaire d'un compte : ce qui serait purgé / conservé / remis en consolidation. */
export interface PurgePlan {
  operations: { total: number; active: number; invalidated: number; merged: number };
  purged: number[];
  kept: Array<{ id: number; reasons: KeepReason[] }>;
  keptByReason: Partial<Record<KeepReason, number>>;
  /** Projections automatiques intactes retirées (trace restaurable). */
  projectionsRemoved: number[];
  /** Éléments d'agenda conservés et détachés d'une Opération purgée (saisis, modifiés, statut, liens manuels…). */
  itemsDetached: number;
  /** Liens Document ↔ Agenda : provenance dérivée retirée / liens supprimés faute d'autre provenance. */
  principalProvenancesRemoved: number;
  principalLinksDeleted: number;
  /** Cartes « À traiter » ouvertes sur une Opération purgée ou une projection retirée (closes « obsolètes »). */
  cardsClosed: number[];
  /** Candidats T1 persistés remis en consolidation (aucune nouvelle analyse). */
  candidatesRequeued: number;
  documents: number;
  /** Éléments d'agenda saisis sources d'une Opération purgée (reconsolidés). */
  agendaSourceItems: number[];
  /** Décisions TCO dont la clé `o:` devient une clé stable `s:` (aucune décision perdue). */
  tcoDecisionsRekeyed: Array<{ id: number; from: string; to: string }>;
  tcoDecisionsMerged: number;
  /** Données de l'utilisateur conservées (contrôle du rapport). */
  userData: UserDataCounts;
}

export interface UserDataCounts {
  agendaUserItems: number;
  agendaModifiedItems: number;
  manualDocumentLinks: number;
  decisions: number;
  exclusions: number;
  suppressions: number;
  userDates: number;
  tcoDecisions: number;
}

export const USER_DATA_LABELS: Readonly<Record<keyof UserDataCounts, string>> = {
  agendaUserItems: 'Éléments d’agenda saisis',
  agendaModifiedItems: 'Éléments d’agenda modifiés, confirmés ou à statut',
  manualDocumentLinks: 'Liens manuels document ↔ agenda',
  decisions: 'Décisions de regroupement (mémoire unifiée)',
  exclusions: 'Biens retirés (exclusions)',
  suppressions: 'Suppressions de projection',
  userDates: 'Dates choisies par l’utilisateur',
  tcoDecisions: 'Décisions TCO',
};

/** Données de l'utilisateur perdues entre deux décomptes (pure) : toute baisse est une perte. */
export function userDataLosses(before: UserDataCounts, after: UserDataCounts): string[] {
  return (Object.keys(USER_DATA_LABELS) as Array<keyof UserDataCounts>)
    .filter((k) => after[k] < before[k])
    .map((k) => `${USER_DATA_LABELS[k]} : ${before[k]} → ${after[k]}`);
}

// ── Signature métier (AC43) : résultat sans identifiant technique ──────────

export interface SignatureOperation {
  type: string | null;
  status: string;
  realizedDate: string | null;
  plannedDate: string | null;
  startDate: string | null;
  endDate: string | null;
  provider: string | null;
  documents: number[];
  assets: number[];
  equipments: number[];
  rooms: number[];
  components: Array<{ kind: string; amountMinor: number; currency: string; date: string | null; periodStart: string | null; periodEnd: string | null }>;
  /** Éléments d'agenda de l'Opération, décrits sans identifiant (une projection recréée garde la même description). */
  agenda: Array<{ title: string; date: string | null; role: string | null; automatic: boolean }>;
}

/**
 * Signature métier CANONIQUE d'un compte (pure) : Opérations actives
 * décrites par leurs preuves et leurs objets (fichiers, biens, équipements,
 * Pièces, éléments d'agenda), jamais par leur identifiant. Deux
 * reconstructions identiques donnent la même signature (AC43).
 */
export function canonicalBusinessSignature(ops: readonly SignatureOperation[]): string {
  const tri = <T>(xs: readonly T[]) => [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  const norm = ops.map((o) => ({
    ...o,
    documents: [...o.documents].sort((a, b) => a - b), assets: [...o.assets].sort((a, b) => a - b),
    equipments: [...o.equipments].sort((a, b) => a - b), rooms: [...o.rooms].sort((a, b) => a - b),
    components: tri(o.components), agenda: tri(o.agenda),
  }));
  return JSON.stringify(tri(norm));
}

// ── Périmètre de la sauvegarde par compte (restauration exacte) ───────────

/**
 * Tables que la purge ou la reconstruction d'un compte peuvent écrire, dans
 * l'ordre des clés étrangères (parents d'abord). `filter` : lignes du compte
 * (`t` = la table, `$1` = le compte). L'image AVANT de ces lignes est
 * journalisée par compte ; « Restaurer » ramène exactement ces lignes.
 * Tables absentes de la base (ancien modèle supprimé, migration future) :
 * ignorées.
 */
export interface ScopeTable { table: string; filter: string }

const ACC = 't.account_id = $1';
const OPS = 't.operation_id IN (SELECT id FROM business_operations WHERE account_id = $1)';
const ITEMS = 't.agenda_item_id IN (SELECT id FROM agenda_items WHERE account_id = $1)';
const DAMAGES = 't.damage_id IN (SELECT d.id FROM business_operation_claim_damages d JOIN business_operations o ON o.id = d.operation_id WHERE o.account_id = $1)';

export const REBUILD_SCOPE: readonly ScopeTable[] = [
  { table: 'business_operations', filter: ACC },
  { table: 'business_operation_sources', filter: ACC },
  { table: 'business_operation_asset_links', filter: ACC },
  { table: 'business_operation_equipment_links', filter: ACC },
  { table: 'business_operation_room_links', filter: ACC },
  { table: 'business_operation_documents', filter: ACC },
  { table: 'business_operation_financial_components', filter: ACC },
  { table: 'business_operation_financial_component_sources', filter: 't.component_id IN (SELECT id FROM business_operation_financial_components WHERE account_id = $1)' },
  { table: 'business_operation_history', filter: ACC },
  { table: 'business_operation_identity_reviews', filter: ACC },
  { table: 'business_operation_projection_suppressions', filter: ACC },
  { table: 'business_operation_references', filter: ACC },
  { table: 'business_operation_match_decisions', filter: ACC },
  { table: 'business_operation_side_amounts', filter: ACC },
  { table: 'business_operation_asset_exclusions', filter: ACC },
  { table: 'business_operation_asset_data_marks', filter: ACC },
  { table: 'business_operation_contract_details', filter: OPS },
  { table: 'business_operation_financing_details', filter: OPS },
  { table: 'business_operation_claim_details', filter: OPS },
  { table: 'business_operation_claim_damages', filter: OPS },
  { table: 'business_operation_claim_damage_documents', filter: DAMAGES },
  { table: 'business_operation_claim_damage_photos', filter: DAMAGES },
  // Ancien modèle Sinistres (présent jusqu'à la finalisation 84A, noms : `legacy-schema.ts`) : jamais purgé, sauvegardé tant qu'il existe.
  ...LEGACY_CLAIM_TABLES.map((table) => ({ table, filter: table.endsWith('_marks') ? ACC : OPS })),
  { table: 'document_operation_candidates', filter: ACC },
  { table: 'agenda_items', filter: ACC },
  { table: 'agenda_asset_links', filter: ITEMS },
  { table: 'agenda_file_links', filter: ITEMS },
  { table: 'agenda_room_links', filter: ITEMS },
  { table: 'agenda_equipment_links', filter: ITEMS },
  { table: 'agenda_item_sources', filter: `(${ITEMS} OR (t.agenda_item_id IS NULL AND t.asset_file_id IN (SELECT id FROM asset_files WHERE account_id = $1)))` },
  { table: 'agenda_occurrence_events', filter: ACC },
  { table: 'agenda_item_removals', filter: ACC },
  { table: 'agenda_intervention_consolidations', filter: ACC },
  { table: 'agenda_data_conflicts', filter: ACC },
  { table: 't6_candidate_examinations', filter: ACC },
  { table: 't6_evaluation_runs', filter: ACC },
  { table: 't6_interpellation_assessments', filter: ACC },
  { table: 't6_reminder_preferences', filter: ACC },
  { table: 'energy_works', filter: 't.asset_id IN (SELECT id FROM assets WHERE account_id = $1)' },
  { table: 'impact_queue', filter: ACC },
  { table: 'to_process_actions', filter: ACC },
  { table: 'to_process_action_events', filter: ACC },
  { table: 'document_asset_links', filter: ACC },
  { table: 'asset_cost_line_decisions', filter: ACC },
];

/** Tables d'une restauration, dans l'ordre de suppression (enfants d'abord) (pure). */
export function deletionOrder(scope: readonly ScopeTable[]): ScopeTable[] {
  return [...scope].reverse();
}

// ── Point de restauration (C-Q8) ────────────────────────────────────────────

export const RESTORE_POINT_REQUIRED_CODE = 'RESTORE_POINT_REQUIRED';

/** Passages de consolidation T3 au plus par phase (chaque passage : 200 documents, M3 sous ses plafonds). */
export const MAX_CONSOLIDATION_PASSES = 40;
