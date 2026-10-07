/**
 * Rattachement AUTOMATIQUE Document → Bien (lot 31B) — un seul chemin pour T1
 * (bien certain) et T3 DOCUMENT_ASSET (bien résolu).
 *
 * Il passe par les deux services canoniques existants, sans écriture SQL
 * propre :
 *   · relation N-N : `linkDocumentToAsset` (origine AI, rôle, confiance) —
 *     la représentation canonique lue par l'assistant, les exports, T3 ;
 *   · rattachement principal visible : `ASSET_LINK_SLOT.writeAuto` (lot 28,
 *     colonne `asset_id`, lue par les listes de documents et la fiche du
 *     bien), qui ne s'écrit JAMAIS par-dessus un choix ou un retrait de
 *     l'utilisateur et porte la marque « automatique » (`assetIdAuto`).
 * Le déclencheur 0221 ne crée pas de second lien (cible déjà liée) ; le
 * déclencheur 0257 fermerait l'action « À traiter » avec un motif
 * utilisateur — elle est donc fermée AVANT (`closeAssetLinkQuestion`).
 */
import { db, pgClient } from '@/db';
import { linkDocumentToAsset } from '@/services/documents/document-asset-links';
import { ASSET_LINK_SLOT } from '@/services/to-process/document-slots';
import { resolveActionsForData } from '@/services/to-process/to-process-action.service';

/** Ferme la question LINK-ASSET ouverte : le système vient de répondre. */
export function closeAssetLinkQuestion(accountId: number, fileId: number): Promise<number> {
  return resolveActionsForData(accountId, 'DOCUMENT', fileId, 'assetIds', 'OBSOLETE');
}

/**
 * Colonne de rattachement principal posée automatiquement (vide, ou déjà
 * automatique). Refusée si l'utilisateur a choisi ou retiré un bien.
 */
export function writeAutomaticPrimaryColumn(accountId: number, fileId: number, assetId: number): Promise<boolean> {
  return ASSET_LINK_SLOT.writeAuto(db, accountId, fileId, assetId, { origin: 'RECONCILIATION', confidence: 1 });
}

/** Rattachement automatique complet (lien N-N AI + colonne pour un PRIMARY). */
export async function attachAutomatically(p: {
  accountId: number; fileId: number; assetId: number; role: 'PRIMARY' | 'SECONDARY'; confidence: number;
}): Promise<{ columnWritten: boolean }> {
  await linkDocumentToAsset({
    accountId: p.accountId, fileId: p.fileId, target: { assetId: p.assetId },
    role: p.role, origin: 'AI', confidence: p.confidence,
  });
  const columnWritten = p.role === 'PRIMARY' ? await writeAutomaticPrimaryColumn(p.accountId, p.fileId, p.assetId) : false;
  return { columnWritten };
}

/**
 * Retire la colonne posée automatiquement vers `assetId` (choix utilisateur
 * concurrent) — jamais une colonne humaine (marque différente, choix
 * utilisateur posé).
 */
export async function clearAutomaticPrimaryColumn(accountId: number, fileId: number, assetId: number): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `UPDATE asset_files
        SET asset_id = NULL, user_edited_fields = COALESCE(user_edited_fields, '{}'::jsonb) - 'assetIdAuto', updated_at = now()
      WHERE id = $1 AND account_id = $2 AND asset_id = $3
        AND asset_id = (user_edited_fields ->> 'assetIdAuto')::int
        AND COALESCE((user_edited_fields ->> 'assetId')::boolean, false) = false
      RETURNING id`,
    [fileId, accountId, assetId] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}
