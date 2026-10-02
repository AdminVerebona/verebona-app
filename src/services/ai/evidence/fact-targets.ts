/**
 * Vérification des cibles de faits et bien porteur — CDC 15 T1-04, T1-05, U8, U9.
 *
 * La projection annonce des identifiants « vérifiés » ; la persistance les
 * REVÉRIFIE (défense en profondeur, §4.1.7 : un identifiant n'est utilisé
 * qu'après contrôle local) et retrouve, pour un équipement ou une pièce, le
 * bien PORTEUR (`asset_id`), seul rattachement admis par `field_evidence`.
 *
 * Toutes les requêtes filtrent sur le compte : un identifiant d'un autre
 * compte est traité comme inexistant.
 */
import { pgClient } from '@/db';

/** Types de cible projetables en preuve de champ (un champ de bien, d'équipement ou de pièce). */
export const EVIDENCE_TARGET_TYPES = ['ASSET', 'EQUIPMENT', 'ROOM'] as const;
export type EvidenceEntityTargetType = (typeof EVIDENCE_TARGET_TYPES)[number];

export const isEvidenceTargetType = (t: string): t is EvidenceEntityTargetType =>
  (EVIDENCE_TARGET_TYPES as readonly string[]).includes(t);

export const targetKey = (type: string, entityId: number) => `${type}:${entityId}`;

/**
 * Cibles existantes dans le compte → bien porteur.
 * Clé `TYPE:id` ; absente = cible introuvable (ou d'un autre compte, ou d'un
 * bien supprimé).
 */
export async function resolveFactTargets(
  accountId: number,
  targets: Array<{ type: EvidenceEntityTargetType; entityId: number }>,
): Promise<Map<string, { assetId: number }>> {
  const out = new Map<string, { assetId: number }>();
  const ids = (type: EvidenceEntityTargetType) => [...new Set(targets
    .filter((t) => t.type === type && Number.isInteger(t.entityId) && t.entityId > 0)
    .map((t) => t.entityId))];

  const assetIds = ids('ASSET');
  const equipmentIds = ids('EQUIPMENT');
  const roomIds = ids('ROOM');

  if (assetIds.length) {
    const rows = (await pgClient.unsafe(
      `SELECT id AS "entityId", id AS "assetId" FROM assets
        WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
      [accountId, assetIds] as never[],
    )) as unknown as Array<{ entityId: number; assetId: number }>;
    for (const r of rows) out.set(targetKey('ASSET', r.entityId), { assetId: r.assetId });
  }
  if (equipmentIds.length) {
    // Cloisonnement par le bien porteur (comme `identifier-verifier`).
    const rows = (await pgClient.unsafe(
      `SELECT e.id AS "entityId", e.asset_id AS "assetId" FROM equipments e
         JOIN assets a ON a.id = e.asset_id
        WHERE a.account_id = $1 AND e.id = ANY($2::int[]) AND a.deleted_at IS NULL`,
      [accountId, equipmentIds] as never[],
    )) as unknown as Array<{ entityId: number; assetId: number }>;
    for (const r of rows) out.set(targetKey('EQUIPMENT', r.entityId), { assetId: r.assetId });
  }
  if (roomIds.length) {
    // D-G (lot 20, migration 0229) : une cible ROOM désigne une SOUS-STRUCTURE
    // (`substructures.id`) ; la table `rooms` n'est plus lue.
    const rows = (await pgClient.unsafe(
      `SELECT r.id AS "entityId", r.asset_id AS "assetId" FROM substructures r
         JOIN assets a ON a.id = r.asset_id
        WHERE a.account_id = $1 AND r.id = ANY($2::int[]) AND a.deleted_at IS NULL`,
      [accountId, roomIds] as never[],
    )) as unknown as Array<{ entityId: number; assetId: number }>;
    for (const r of rows) out.set(targetKey('ROOM', r.entityId), { assetId: r.assetId });
  }
  return out;
}
