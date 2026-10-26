/**
 * Périmètre d'un travail de la file durable — lot 49 (ticket SEC-P0,
 * SEC-08 : « vérifier la cohérence entre job.accountId, document source,
 * bien cible et entités concernées, lors de la mise en file ET de
 * l'exécution, y compris pour les jobs anciens, différés ou relancés »).
 *
 * Un travail porte un compte (`account_id`) et des identifiants : sa cible
 * (`target_type` / `target_id`) et, dans son contexte, le bien, le document
 * source, l'équipement… Chacun doit appartenir au compte du travail :
 *
 *   · À LA MISE EN FILE : une demande dont une référence appartient à un
 *     autre compte n'est PAS mise en file (refus journalisé) ;
 *   · À L'EXÉCUTION (avant l'exécutant, quel que soit le traitement T1 à
 *     T4) : un travail ancien, différé ou relancé dont une référence
 *     appartient désormais (ou appartenait déjà) à un autre compte échoue
 *     DÉFINITIVEMENT (`PermanentJobError`) — aucune lecture, écriture ni
 *     suppression n'a lieu.
 *
 * Lot 54 (ticket SEC-P0-CORR, SEC-05 « isolation exhaustive des traitements
 * IA ») :
 *   · TOUTES les cibles : en plus des objets (bien, document, équipement,
 *     pièce, agenda), les cibles « compte » des Opérations
 *     (`business_operations`, `business_operations_agenda` : `target_id` =
 *     compte du travail, sinon refus) ;
 *   · références IMBRIQUÉES : le contexte est parcouru en profondeur
 *     (tableaux, objets : `events[].fileId`, `events[].operationIds[]`…) ;
 *     clés reconnues : `JOB_PAYLOAD_KINDS` ; un `accountId` du contexte doit
 *     être celui du travail ;
 *   · FAIL CLOSED : contrôle indisponible (base injoignable) → mise en file
 *     REFUSÉE (et, à l'exécution, l'exécutant ne tourne pas : le travail est
 *     reporté comme toute erreur technique) ; contexte illisible (trop
 *     profond / trop volumineux) → refus ;
 *   · cible INCONNUE d'un travail rattaché à un compte (type déclaré par un
 *     contrat T3 futur ou de test) : son identifiant n'est pas interprété —
 *     variante prudente pour ne pas bloquer un traitement légitime — mais
 *     toutes les références de son contexte sont contrôlées, et le cas est
 *     journalisé (`security.job_scope_unknown_target`) ;
 *   · travaux TECHNIQUES sans compte (balayages globaux paginés :
 *     `GLOBAL_JOB_TARGET_TYPES`, ou sans cible) : admis SEULEMENT s'ils ne
 *     portent aucune référence métier — leur exécutant résout chaque compte
 *     lui-même et met en file des travaux par compte, contrôlés ici.
 *
 * Une référence INTROUVABLE n'est pas un refus ici : l'exécutant la traite
 * (TARGET_GONE, rien à faire) comme avant. Un déplacement Duo / changement
 * de compte d'un bien met à jour `ai_job_queue.account_id` dans la même
 * transaction (`asset-account-transfer.service`) : un travail légitime suit
 * donc son bien et n'est pas refusé.
 *
 * Refus journalisés (`security.cross_account_refused` /
 * `security.job_scope_refused`) : types et identifiants techniques, jamais
 * de donnée métier.
 *
 * Coût : une requête par clé primaire (UNION ALL), seulement pour les
 * travaux qui portent un compte et au moins une référence.
 */
import { PermanentJobError } from './queue-policy';
import type { OwnedKind, OwnershipRefs, RejectedRef, SqlExecutor } from '@/services/security/account-ownership';

/** Type de cible de la file → type d'objet contrôlé. */
export const JOB_TARGET_KINDS: Readonly<Record<string, OwnedKind>> = {
  asset: 'asset',
  asset_file: 'file',
  document: 'file',
  equipment: 'equipment',
  // Lot 75G : rapprochement des documents d'un équipement (cible = l'équipement).
  equipment_documents: 'equipment',
  // Pièce = sous-structure depuis D-G (lot 20, 0229).
  room: 'substructure',
  agenda_item: 'agenda_item',
};

/** Cibles « compte » : `target_id` est le compte du travail (Opérations, lots 39-48). */
const ACCOUNT_JOB_TARGET_TYPES: ReadonlySet<string> = new Set(['business_operations', 'business_operations_agenda']);

/**
 * Balayages GLOBAUX (travaux techniques sans compte, pagination
 * `cycle:page`) : encadrés — aucune référence métier admise.
 */
const GLOBAL_JOB_TARGET_TYPES: ReadonlySet<string> = new Set([
  't3_sweep', 'document_sweep', 'document_title_sweep', 'business_operations_sweep',
]);

/** Clés du contexte (payload, à toute profondeur) → type d'objet contrôlé. */
const JOB_PAYLOAD_KINDS: Readonly<Record<string, OwnedKind>> = {
  assetId: 'asset',
  assetIds: 'asset',
  linkedAssetId: 'asset',
  liveAssetIds: 'asset',
  fileId: 'file',
  fileIds: 'file',
  leadSourceId: 'file',
  sourceFileId: 'file',
  documentId: 'file',
  documentIds: 'file',
  assetFileId: 'file',
  invoiceFileId: 'file',
  equipmentId: 'equipment',
  equipmentIds: 'equipment',
  substructureId: 'substructure',
  substructureIds: 'substructure',
  agendaItemId: 'agenda_item',
  agendaItemIds: 'agenda_item',
  supplierId: 'supplier',
  supplierIds: 'supplier',
  eventId: 'event',
  deadlineId: 'deadline',
  operationId: 'operation',
  operationIds: 'operation',
  canonicalOperationId: 'operation',
  businessOperationId: 'operation',
  parentOperationId: 'operation',
  mergedIntoOperationId: 'operation',
  proposedOperationIds: 'operation',
};

/** Bornes du parcours du contexte (au-delà : refus, jamais un contrôle partiel). */
export const PAYLOAD_MAX_DEPTH = 8;
const PAYLOAD_MAX_NODES = 5_000;

const entier = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/** Contexte illisible : refus (fail closed). */
class JobScopeError extends PermanentJobError {
  constructor(message: string) {
    super(message);
    this.name = 'JobScopeError';
  }
}

type JobShape = {
  accountId?: number | null; targetType?: string | null; targetId?: string | number | null; payload?: Record<string, unknown> | null;
};

/** Références d'un travail (pure, testée) — cible et contexte, en profondeur. */
export function jobRefs(job: JobShape): OwnershipRefs {
  return analyseJob(job).refs;
}

/** Analyse pure : références par type, comptes cités, contexte illisible. */
export function analyseJob(job: JobShape): { refs: OwnershipRefs; accountIds: number[]; unreadable: string | null } {
  const out: Partial<Record<OwnedKind, number[]>> = {};
  const comptes: number[] = [];
  const add = (k: OwnedKind, v: unknown) => {
    const n = entier(v);
    if (n !== null) (out[k] ??= []).push(n);
  };
  const cible = job.targetType ? JOB_TARGET_KINDS[job.targetType] : undefined;
  if (cible) add(cible, job.targetId);
  let noeuds = 0;
  let illisible: string | null = null;
  const parcourir = (v: unknown, profondeur: number) => {
    if (illisible || v === null || typeof v !== 'object') return;
    if (profondeur > PAYLOAD_MAX_DEPTH) { illisible = `contexte trop profond (> ${PAYLOAD_MAX_DEPTH})`; return; }
    if (++noeuds > PAYLOAD_MAX_NODES) { illisible = `contexte trop volumineux (> ${PAYLOAD_MAX_NODES})`; return; }
    if (Array.isArray(v)) { for (const x of v) parcourir(x, profondeur + 1); return; }
    for (const [cle, val] of Object.entries(v as Record<string, unknown>)) {
      const kind = JOB_PAYLOAD_KINDS[cle];
      if (kind) {
        if (Array.isArray(val)) val.forEach((x) => add(kind, x));
        else add(kind, val);
      } else if (cle === 'accountId') {
        const n = entier(val);
        if (n !== null) comptes.push(n);
      }
      if (val !== null && typeof val === 'object') parcourir(val, profondeur + 1);
    }
  };
  parcourir(job.payload ?? null, 0);
  return { refs: out, accountIds: comptes, unreadable: illisible };
}

const vide = (refs: OwnershipRefs) => Object.values(refs).every((l) => !Array.isArray(l) || l.length === 0);

/**
 * Refus STRUCTURELS (sans base) : cible inconnue, cible « compte » d'un autre
 * compte, `accountId` du contexte différent, travail sans compte portant des
 * références métier, contexte illisible. `null` : rien à redire.
 */
export function structuralJobRefusal(job: JobShape): string | null {
  const { refs, accountIds, unreadable } = analyseJob(job);
  if (unreadable) return unreadable;
  const compte = job.accountId ?? null;
  const type = job.targetType ?? null;
  if (compte === null) {
    if (!vide(refs)) return 'travail sans compte portant des références métier';
    if (accountIds.length) return 'travail sans compte portant un compte dans son contexte';
    if (type !== null && !GLOBAL_JOB_TARGET_TYPES.has(type) && !JOB_TARGET_KINDS[type] && !ACCOUNT_JOB_TARGET_TYPES.has(type)) {
      return `cible ${type} sans compte non autorisée`;
    }
    return null;
  }
  if (type !== null && ACCOUNT_JOB_TARGET_TYPES.has(type) && entier(job.targetId) !== compte) {
    return `cible ${type} ${String(job.targetId)} hors du compte ${compte}`;
  }
  const autres = accountIds.filter((a) => a !== compte);
  if (autres.length) return `compte ${autres[0]} cité dans le contexte d'un travail du compte ${compte}`;
  return null;
}

/** Références d'un travail qui appartiennent à un AUTRE compte que le sien. */
export async function foreignJobRefs(job: JobShape, exec?: SqlExecutor): Promise<RejectedRef[]> {
  if (!job.accountId) return [];
  const t = job.targetType ?? null;
  if (t !== null && !JOB_TARGET_KINDS[t] && !ACCOUNT_JOB_TARGET_TYPES.has(t) && !GLOBAL_JOB_TARGET_TYPES.has(t)) {
    console.info(JSON.stringify({ event: 'security.job_scope_unknown_target', accountId: job.accountId, targetType: t }));
  }
  const refs = jobRefs(job);
  if (vide(refs)) return [];
  const { findForeignRefs } = await import('@/services/security/account-ownership');
  return findForeignRefs(job.accountId, refs, exec);
}

function journaliserRefus(context: string, job: JobShape, motif: string): void {
  console.warn(JSON.stringify({
    event: 'security.job_scope_refused', context, accountId: job.accountId ?? null, targetType: job.targetType ?? null, reason: motif.slice(0, 200),
  }));
}

/**
 * Contrôle d'EXÉCUTION : lève `PermanentJobError` (échec définitif immédiat,
 * aucune écriture) si une référence du travail appartient à un autre compte
 * ou si son périmètre est structurellement invalide. Toute autre erreur
 * (base injoignable) remonte telle quelle : l'exécutant ne tourne pas.
 */
export async function assertJobScope(
  job: { id: number; treatment?: string; accountId: number | null; targetType: string | null; targetId: string | null; payload: Record<string, unknown> | null },
  exec?: SqlExecutor,
): Promise<void> {
  const context = `queue.${job.treatment ?? 'job'}.${job.id}`;
  const motif = structuralJobRefusal(job);
  if (motif) {
    journaliserRefus(context, job, motif);
    throw new JobScopeError(`périmètre refusé : ${motif}`);
  }
  const etrangeres = await foreignJobRefs(job, exec);
  if (etrangeres.length === 0) return;
  const { logCrossAccountRefusal } = await import('@/services/security/account-ownership');
  logCrossAccountRefusal(context, { accountId: job.accountId as number, rejected: etrangeres });
  throw new PermanentJobError(
    `périmètre hors compte : ${etrangeres.map((r) => `${r.kind} ${r.id}`).join(', ')} n'appartient pas au compte ${job.accountId}`,
  );
}

// ── Point d'appel de la file (remplaçable par les tests unitaires) ──────────

type ScopeCheck = (job: Parameters<typeof assertJobScope>[0]) => Promise<void>;
let surcharge: ScopeCheck | null = null;

/**
 * TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`) : aucun test unitaire
 * n'ouvre de connexion à la base. Les tests de bout en bout (PostgreSQL)
 * exercent le contrôle réel. `null` rétablit le contrôle réel.
 */
export function __setJobScopeCheckForTests(fn: ScopeCheck | null): void {
  surcharge = fn;
}

/** Contrôle d'exécution appelé par le boucleur avant chaque exécutant. */
export function checkJobScope(job: Parameters<typeof assertJobScope>[0]): Promise<void> {
  return (surcharge ?? assertJobScope)(job);
}

/**
 * Contrôle de MISE EN FILE : `true` si la demande peut être mise en file.
 * Référence d'un autre compte, périmètre invalide → refus journalisé
 * (`false`). Lot 54 (SEC-05) : FAIL CLOSED — une panne du contrôle refuse
 * aussi la mise en file (rien n'est écrit ; l'appelant réessaiera, comme
 * pour toute écriture en base impossible).
 */
export async function enqueueScopeAllowed(input: {
  treatment: string; scope?: { accountId?: number | null; targetType?: string | null; targetId?: string | number | null } | null;
  payload?: Record<string, unknown> | null;
}): Promise<boolean> {
  const job = {
    id: 0, treatment: input.treatment, accountId: input.scope?.accountId ?? null,
    targetType: input.scope?.targetType ?? null,
    targetId: input.scope?.targetId == null ? null : String(input.scope.targetId),
    payload: input.payload ?? null,
  };
  try {
    await checkJobScope(job);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'PERMANENT_JOB_ERROR') {
      console.warn(`[queue] mise en file ${input.treatment} refusée — ${(e as Error).message}`);
      return false;
    }
    console.error(JSON.stringify({
      event: 'security.job_scope_unavailable', treatment: input.treatment, accountId: job.accountId, targetType: job.targetType,
      reason: String((e as Error).message ?? e).slice(0, 200),
    }));
    return false;
  }
}
