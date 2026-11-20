/**
 * T3 DOCUMENT_ASSET — rattachement hérité de l'opération (carte #819) : LECTURES et réévaluation.
 * Règles et garde-fous : `operation-inheritance.ts` (pur). Toutes les lectures sont bornées au compte ;
 * la seule écriture est celle du service canonique (`resolveDocumentAsset`).
 */
import { pgClient } from '@/db';
import { strongOperationRelation } from './identity/sources';
import {
  operationAttachmentOf, operationOfReason, OPERATION_LINKED_REASON, OPERATION_LINKED_TRIGGER,
  type OperationAttachment, type OperationMembership,
} from './operation-inheritance';

/** Document visible, déposé, ni brouillon ni écarté, SANS bien principal ni décision de l'utilisateur (alias `f`). */
const ORPHELIN_SANS_DECISION = `f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
  AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED' AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
  AND f.asset_id IS NULL AND f.linked_asset_id IS NULL
  AND COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false
  AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.account_id = f.account_id AND l.status = 'ACTIVE'
                    AND l.asset_id IS NOT NULL AND (l.link_role = 'PRIMARY' OR l.origin = 'USER'))`;

interface MembershipRow {
  operation_id: number; user_member: boolean; own_source_ids: number[] | string | null;
  sources: Array<{ a: string | null; c: string | null }> | string | null;
  assets: Array<{ a: number; s: number | null }> | string | null;
}

const liste = <T>(v: T[] | string | null): T[] => (v === null ? [] : typeof v === 'string' ? JSON.parse(v) as T[] : v);

/**
 * Appartenances ÉTABLIES d'un document (lecture seule, bornée au compte) : opérations actives dont il est
 * une source documentaire active, ou auxquelles l'utilisateur l'a rattaché ; biens actifs de chacune.
 */
export async function loadOperationMemberships(accountId: number, fileId: number): Promise<OperationMembership[]> {
  const rows = (await pgClient.unsafe(
    `WITH src AS (
       SELECT s.operation_id, s.id, s.authority, s.confidence
         FROM business_operation_sources s
        WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text
     ), usr AS (
       SELECT d.operation_id FROM business_operation_documents d
        WHERE d.account_id = $1 AND d.file_id = $2::int AND d.active AND 'USER' = ANY(d.origins)
     ), ops AS (
       SELECT operation_id FROM src UNION SELECT operation_id FROM usr
     )
     SELECT o.id::float8 AS operation_id,
            EXISTS (SELECT 1 FROM usr u WHERE u.operation_id = o.id) AS user_member,
            COALESCE((SELECT json_agg(json_build_object('a', x.authority, 'c', x.confidence)) FROM src x WHERE x.operation_id = o.id), '[]'::json) AS sources,
            COALESCE((SELECT json_agg(x.id::float8) FROM src x WHERE x.operation_id = o.id), '[]'::json) AS own_source_ids,
            COALESCE((SELECT json_agg(json_build_object('a', l.asset_id, 's', l.source_operation_source_id::float8) ORDER BY l.asset_id)
                        FROM business_operation_asset_links l
                        JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                       WHERE l.operation_id = o.id AND l.account_id = $1 AND l.active), '[]'::json) AS assets
       FROM business_operations o
       JOIN ops ON ops.operation_id = o.id
      WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND o.status <> 'CANCELLED'
      ORDER BY o.id`,
    [accountId, fileId] as never[],
  )) as unknown as MembershipRow[];
  const out: OperationMembership[] = [];
  for (const r of rows) {
    const fortes = liste(r.sources).some((s) => strongOperationRelation({ authority: s.a, confidence: s.c }));
    // Une source « probable » ou d'inférence n'établit pas l'appartenance ; le geste de l'utilisateur, si.
    if (!fortes && r.user_member !== true) continue;
    const propres = new Set(liste(r.own_source_ids).map(Number));
    out.push({
      operationId: Number(r.operation_id),
      via: fortes ? 'SOURCE' : 'USER_MEMBER',
      assets: liste(r.assets).map((a) => ({ assetId: Number(a.a), ownSupport: a.s !== null && propres.has(Number(a.s)) })),
    });
  }
  return out;
}

/** Bien désigné au document par ses opérations (lecture seule, bornée au compte). */
export async function loadOperationAttachment(accountId: number, fileId: number): Promise<OperationAttachment> {
  return operationAttachmentOf(await loadOperationMemberships(accountId, fileId));
}

/**
 * Documents SANS bien principal ni décision de l'utilisateur qui appartiennent (appartenance établie) à l'une
 * de ces opérations — candidats à la réévaluation après l'enregistrement d'une relation. Bornée au compte.
 */
export async function listOperationOrphanDocuments(accountId: number, operationIds: readonly number[], limit: number): Promise<number[]> {
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (ids.length === 0 || limit <= 0) return [];
  const rows = (await pgClient.unsafe(
    `SELECT f.id FROM asset_files f
      WHERE f.account_id = $1 AND ${ORPHELIN_SANS_DECISION}
        AND (EXISTS (SELECT 1 FROM business_operation_sources s
                      WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = f.id::text
                        AND s.operation_id = ANY($2::bigint[]))
          OR EXISTS (SELECT 1 FROM business_operation_documents d
                      WHERE d.account_id = $1 AND d.file_id = f.id AND d.active AND 'USER' = ANY(d.origins) AND d.operation_id = ANY($2::bigint[])))
      ORDER BY f.id LIMIT $3`,
    [accountId, ids, limit] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

/** Documents réévalués au plus par appel (le reste : passage suivant, balayage T3, contrôle de cohérence). */
export const OPERATION_REEVALUATION_LIMIT = 25;

export interface OperationReevaluation {
  /** Documents examinés. */
  examined: number[];
  /** Documents rattachés à leur bien par l'opération. */
  attached: Array<{ fileId: number; assetId: number; operationId: number | null }>;
  /** Documents dont l'examen a échoué (repris par les filets existants). */
  errors: number[];
}

/**
 * Rattache UN document sans bien au bien de son opération, s'il y a lieu — DÉTERMINISTE seulement
 * (`operationOnly` : aucune IA, aucune carte créée, rien d'écrit si aucune règle sans IA ne rattache).
 * Écriture par le service canonique (`resolveDocumentAsset`) : garde d'admission, lien et colonne, carte LINK-ASSET
 * ouverte fermée avec son motif, projection en contexte technique. Rend le rattachement posé, sinon null.
 */
export async function attachByOperation(accountId: number, fileId: number): Promise<{ fileId: number; assetId: number; operationId: number | null } | null> {
  const { resolveDocumentAsset } = await import('./resolve-document-asset.service');
  const r = await resolveDocumentAsset({
    accountId, fileId, userId: null, operationOnly: true, skipAi: true,
    triggerCode: OPERATION_LINKED_TRIGGER, reprocessReason: OPERATION_LINKED_REASON,
  });
  return r.outcome === 'APPLIED' && r.decision?.kind === 'APPLY'
    ? { fileId, assetId: r.decision.assetId, operationId: operationOfReason(r.decision.reason) } : null;
}

/**
 * RÉÉVALUATION déclenchée par l'enregistrement d'une relation document – opération (carte #819, D) : les
 * documents sans bien de ces opérations sont réexaminés tout de suite (`attachByOperation`). Une carte LINK-ASSET
 * ouverte avant le rapprochement est fermée (« résolu par l'opération »), l'abstention mémorisée est remplacée.
 * Ne lève que pour une interruption d'exploitation.
 */
export async function reevaluateOperationDocuments(
  accountId: number, operationIds: readonly number[],
  opts: { limit?: number; beforeWrite?: (what: string) => Promise<void> } = {},
): Promise<OperationReevaluation> {
  const out: OperationReevaluation = { examined: [], attached: [], errors: [] };
  const fichiers = await listOperationOrphanDocuments(accountId, operationIds, opts.limit ?? OPERATION_REEVALUATION_LIMIT);
  if (fichiers.length === 0) return out;
  const { isExecutionCancelled } = await import('../../queue/execution-control');
  for (const fileId of fichiers) {
    out.examined.push(fileId);
    try {
      await opts.beforeWrite?.('rattachement d’un document au bien de son opération');
      const r = await attachByOperation(accountId, fileId);
      if (r) out.attached.push(r);
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      out.errors.push(fileId);
      console.error(`[t3-document-asset] réévaluation par l'opération du document ${fileId} (compte ${accountId}) :`, (e as Error).message);
    }
  }
  return out;
}

/**
 * Documents SANS bien principal ni décision de l'utilisateur du compte qui appartiennent à une opération active
 * (reprise du stock, carte #819, F) — après `afterId`, bornée. Lecture seule.
 */
export async function listAccountOperationOrphans(accountId: number, afterId: number, limit: number): Promise<number[]> {
  const rows = (await pgClient.unsafe(
    `SELECT f.id FROM asset_files f
      WHERE f.account_id = $1 AND f.id > $2 AND ${ORPHELIN_SANS_DECISION}
        AND (EXISTS (SELECT 1 FROM business_operation_sources s
                       JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
                      WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = f.id::text
                        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)
          OR EXISTS (SELECT 1 FROM business_operation_documents d
                       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id
                      WHERE d.account_id = $1 AND d.file_id = f.id AND d.active AND 'USER' = ANY(d.origins)
                        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL))
      ORDER BY f.id LIMIT $3`,
    [accountId, afterId, limit] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}
