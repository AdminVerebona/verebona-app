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
 * Une référence INTROUVABLE n'est pas un refus ici : l'exécutant la traite
 * (TARGET_GONE, rien à faire) comme avant. Un déplacement Duo / changement
 * de compte d'un bien met à jour `ai_job_queue.account_id` dans la même
 * transaction (`asset-account-transfer.service`) : un travail légitime suit
 * donc son bien et n'est pas refusé.
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
  // Pièce = sous-structure depuis D-G (lot 20, 0229).
  room: 'substructure',
  agenda_item: 'agenda_item',
};

/** Clés du contexte (payload) → type d'objet contrôlé. */
export const JOB_PAYLOAD_KINDS: Readonly<Record<string, OwnedKind>> = {
  assetId: 'asset',
  assetIds: 'asset',
  fileId: 'file',
  fileIds: 'file',
  leadSourceId: 'file',
  sourceFileId: 'file',
  documentId: 'file',
  equipmentId: 'equipment',
  substructureId: 'substructure',
  agendaItemId: 'agenda_item',
};

const entier = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/** Références d'un travail (pure, testée). */
export function jobRefs(job: {
  targetType?: string | null; targetId?: string | number | null; payload?: Record<string, unknown> | null;
}): OwnershipRefs {
  const out: Partial<Record<OwnedKind, number[]>> = {};
  const add = (k: OwnedKind, v: unknown) => {
    const n = entier(v);
    if (n !== null) (out[k] ??= []).push(n);
  };
  const cible = job.targetType ? JOB_TARGET_KINDS[job.targetType] : undefined;
  if (cible) add(cible, job.targetId);
  for (const [cle, kind] of Object.entries(JOB_PAYLOAD_KINDS)) {
    const v = job.payload?.[cle];
    if (Array.isArray(v)) v.forEach((x) => add(kind, x));
    else add(kind, v);
  }
  return out;
}

const vide = (refs: OwnershipRefs) => Object.values(refs).every((l) => !Array.isArray(l) || l.length === 0);

/** Références d'un travail qui appartiennent à un AUTRE compte que le sien. */
export async function foreignJobRefs(
  job: { accountId?: number | null; targetType?: string | null; targetId?: string | number | null; payload?: Record<string, unknown> | null },
  exec?: SqlExecutor,
): Promise<RejectedRef[]> {
  if (!job.accountId) return [];
  const refs = jobRefs(job);
  if (vide(refs)) return [];
  const { findForeignRefs } = await import('@/services/security/account-ownership');
  return findForeignRefs(job.accountId, refs, exec);
}

/**
 * Contrôle d'EXÉCUTION : lève `PermanentJobError` (échec définitif immédiat,
 * aucune écriture) si une référence du travail appartient à un autre compte.
 */
export async function assertJobScope(
  job: { id: number; treatment?: string; accountId: number | null; targetType: string | null; targetId: string | null; payload: Record<string, unknown> | null },
  exec?: SqlExecutor,
): Promise<void> {
  const etrangeres = await foreignJobRefs(job, exec);
  if (etrangeres.length === 0) return;
  const { logCrossAccountRefusal } = await import('@/services/security/account-ownership');
  logCrossAccountRefusal(`queue.${job.treatment ?? 'job'}.${job.id}`, { accountId: job.accountId as number, rejected: etrangeres });
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
 * Une référence d'un autre compte → refus journalisé (`false`). Une panne
 * du contrôle ne bloque pas la mise en file : le contrôle d'exécution, lui,
 * est bloquant (aucune écriture sans lui).
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
    console.error(`[queue] contrôle de périmètre à la mise en file indisponible (${input.treatment}) :`, (e as Error).message);
    return true;
  }
}
