/**
 * Autorité UTILISATEUR face à une nouvelle connaissance (lot 34E — ticket
 * « T3 : rendre la réconciliation globale réellement continue », §« Respect
 * de l'autorité utilisateur », cas 6).
 *
 *   utilisateur > T3 déterministe > IA
 *
 * Un document rattaché par l'utilisateur à A n'est JAMAIS déplacé par T3.
 * Quand la connaissance du compte évolue et qu'un identifiant canonique lu
 * dans ses faits (immatriculation, VIN, série, cadastre, adresse) désigne
 * désormais UN autre bien B de façon exacte et exclusive, T3 ouvre (ou
 * maintient) la carte « À traiter » d'incohérence LINK-ASSET-CONFLICT
 * existante (`proposeDocumentAssetConflict` : un couple déjà tranché par
 * l'utilisateur n'est jamais reproposé). Déterministe, sans IA, borné ;
 * repassé seulement quand la révision de connaissance du compte avance.
 */
import { pgClient } from '@/db';
import type { ExecutionGuard } from '../../queue/execution-control';
import { resolveAssetByIdentifiers } from '../document-asset/identifiers';
import type { AccountMatchingIndex } from '../document-asset/matching-index';
import { getReconciliationState, recordReconciliationState } from './reconciliation-state.repository';

export const USER_CONFLICT_RELATION = 'USER_LINK_CONFLICT';
export const USER_CONFLICT_ENGINE_VERSION = 1;
/** Documents relus au plus par passage. */
export const USER_CONFLICT_MAX_DOCUMENTS = 200;
const IDENTIFIER_FACT_KEYS = ['registrationNumber', 'vin', 'serialNumber', 'cadastralRef', 'address1', 'postalCode'];

export interface UserConflictResult { skipped: boolean; examined: number; proposed: number }

export async function reconcileUserDecisionConflicts(p: {
  accountId: number; revision: number; index: AccountMatchingIndex; guard?: ExecutionGuard;
}): Promise<UserConflictResult> {
  const prev = await getReconciliationState(USER_CONFLICT_RELATION, 'ACCOUNT', p.accountId);
  if (prev && prev.engineVersion === USER_CONFLICT_ENGINE_VERSION && prev.knowledgeRevision != null && prev.knowledgeRevision >= p.revision) {
    return { skipped: true, examined: 0, proposed: 0 };
  }
  // Documents au bien CHOISI par l'utilisateur, porteurs d'un fait d'identifiant.
  const rows = (await pgClient.unsafe(
    `SELECT f.id AS file_id, COALESCE(
              CASE WHEN COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) THEN f.asset_id END,
              (SELECT l.asset_id FROM document_asset_links l
                WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.origin = 'USER' AND l.link_role = 'PRIMARY' AND l.asset_id IS NOT NULL
                ORDER BY l.id LIMIT 1)) AS user_asset_id,
            (SELECT json_agg(json_build_object('k', COALESCE(d.canonical_key, d.raw_key), 'v', COALESCE(d.normalized_value, d.value_text)))
               FROM document_facts d
              WHERE d.file_id = f.id AND d.status = 'active' AND COALESCE(d.canonical_key, d.raw_key) = ANY($2::text[])) AS facts
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM document_facts d
                     WHERE d.file_id = f.id AND d.status = 'active' AND COALESCE(d.canonical_key, d.raw_key) = ANY($2::text[]))
        AND (COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) AND f.asset_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE'
                         AND l.origin = 'USER' AND l.link_role = 'PRIMARY' AND l.asset_id IS NOT NULL))
      ORDER BY f.id LIMIT ${USER_CONFLICT_MAX_DOCUMENTS}`,
    [p.accountId, IDENTIFIER_FACT_KEYS] as never[],
  )) as unknown as Array<{ file_id: number; user_asset_id: number | null; facts: Array<{ k: string; v: string | null }> | string | null }>;

  let proposed = 0;
  for (const r of rows) {
    if (r.user_asset_id == null) continue;
    const facts = (typeof r.facts === 'string' ? JSON.parse(r.facts) : r.facts ?? []) as Array<{ k: string; v: string | null }>;
    const ident = resolveAssetByIdentifiers(p.index.records, { facts: facts.map((f) => ({ canonicalKey: f.k, value: f.v })), texts: [] });
    const autre = ident.uniqueAssetId;
    if (autre == null || autre === Number(r.user_asset_id) || !ident.matches.every((m) => m.exclusive)) continue;
    await p.guard?.assertActive('T3 autorité utilisateur — incohérence de rattachement');
    const { proposeDocumentAssetConflict } = await import('@/services/to-process/document-asset-conflict');
    const res = await proposeDocumentAssetConflict({
      accountId: p.accountId, fileId: Number(r.file_id), currentAssetId: Number(r.user_asset_id), suggestedAssetId: autre,
      basis: 'IDENTIFIER', kinds: ident.matches.map((m) => m.kind),
    });
    if (res.status === 'CREATED' || res.status === 'UPDATED') proposed += 1;
  }
  await recordReconciliationState({
    relation: USER_CONFLICT_RELATION, subjectType: 'ACCOUNT', subjectId: p.accountId, accountId: p.accountId,
    engineVersion: USER_CONFLICT_ENGINE_VERSION, knowledgeRevision: p.revision, contextFingerprint: null,
    result: proposed > 0 ? 'APPLIED' : 'NO_CHANGE', reason: proposed > 0 ? 'USER_DECISION_CONTRADICTED' : 'NO_CONTRADICTION',
    detail: { examined: rows.length, proposed, aiCalled: false },
  });
  return { skipped: false, examined: rows.length, proposed };
}
