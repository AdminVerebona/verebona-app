/**
 * Carte #849 (A2) — garde d'écriture d'un DOCUMENT dont tous les biens sont
 * TRANSMIS (consultation seule). Module séparé de `asset-quota-guard` (que
 * de nombreux scénarios simulent) : la garde s'applique même quand le quota
 * est simulé.
 */
import { NextResponse } from 'next/server';
import { ASSET_READ_ONLY_MESSAGE } from '@/lib/asset-status';

/**
 * #849 (A2) — refus prêt à renvoyer si le DOCUMENT ne vise que des biens
 * TRANSMIS (consultation seule) : modification, suppression, reclassement
 * refusés. Un document partagé avec un bien en service reste modifiable.
 * `null` : écriture permise (ou document inconnu : la route répond elle-même).
 */
export async function refuserSiDocumentDeBienTransmis(fileId: number, accountId: number): Promise<NextResponse | null> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `WITH biens AS (
       SELECT f.asset_id AS id FROM asset_files f WHERE f.id = $1 AND f.account_id = $2 AND f.asset_id IS NOT NULL
       UNION SELECT f.linked_asset_id FROM asset_files f WHERE f.id = $1 AND f.account_id = $2 AND f.linked_asset_id IS NOT NULL
       UNION SELECT COALESCE(l.asset_id, e.asset_id, s.asset_id) FROM document_asset_links l
              LEFT JOIN equipments e ON e.id = l.equipment_id LEFT JOIN substructures s ON s.id = l.substructure_id
        WHERE l.file_id = $1 AND l.account_id = $2 AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY'))
     SELECT (EXISTS (SELECT 1 FROM biens b JOIN assets a ON a.id = b.id WHERE a.deleted_at IS NULL AND a.status = 'TRANSMIS')
             AND NOT EXISTS (SELECT 1 FROM biens b JOIN assets a ON a.id = b.id WHERE a.deleted_at IS NULL AND a.status IS DISTINCT FROM 'TRANSMIS')) AS bloque`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ bloque: boolean }>;
  if (!r[0]?.bloque) return null;
  return NextResponse.json(
    { error: ASSET_READ_ONLY_MESSAGE, code: 'ASSET_READ_ONLY', message: ASSET_READ_ONLY_MESSAGE, details: { status: 'TRANSMIS' } },
    { status: 403 },
  );
}
