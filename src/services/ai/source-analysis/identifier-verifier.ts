/**
 * Vérification locale des identifiants renvoyés par le modèle — CDC §4.1.7.
 *
 * « Un identifiant retourné par le modèle doit être vérifié localement avant
 *   utilisation. »
 *
 * Sans ce contrôle, un modèle qui hallucine un `assetId` rattacherait un
 * document au bien d'un autre compte. C'est le scénario le plus coûteux du
 * §11.4 (« les données d'un compte ne sont jamais incluses dans un autre »).
 *
 * Un candidat non vérifié n'est pas supprimé : il est conservé avec
 * `verified: false` et déclenche un avertissement, afin que la réconciliation
 * puisse le traiter comme une proposition et non comme un fait.
 */
import { db } from '@/db';
import { assets, rooms, equipments, suppliers } from '@/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { LinkCandidate, AnalysisWarning } from './types';

export type VerifiableEntity = 'asset' | 'room' | 'equipment' | 'supplier';

export interface VerificationOutcome {
  candidates: LinkCandidate[];
  warnings: AnalysisWarning[];
}

/**
 * Confirme l'existence des identifiants DANS LE COMPTE et marque les autres.
 * La requête filtre systématiquement sur `account_id` : c'est le point unique
 * où le cloisonnement est garanti pour les rattachements.
 */
export async function verifyCandidates(
  entity: VerifiableEntity,
  candidates: LinkCandidate[],
  accountId: number,
): Promise<VerificationOutcome> {
  const ids = candidates
    .map((c) => c.entityId)
    .filter((id): id is number => typeof id === 'number' && id > 0);

  const existing = ids.length > 0 ? await loadExistingIds(entity, ids, accountId) : new Set<number>();

  const warnings: AnalysisWarning[] = [];
  const verified = candidates.map((c) => {
    if (c.entityId === null) return { ...c, verified: false };

    if (existing.has(c.entityId)) return { ...c, verified: true };

    warnings.push({
      code: 'UNVERIFIED_IDENTIFIER',
      message:
        `Le modèle a proposé ${entity} #${c.entityId}, introuvable dans le compte ${accountId}. ` +
        'Candidat conservé comme proposition non vérifiée.',
      target: `${entity}:${c.entityId}`,
    });
    // L'identifiant est neutralisé : seul le libellé brut subsiste.
    return { ...c, entityId: null, verified: false };
  });

  return { candidates: verified, warnings };
}

async function loadExistingIds(
  entity: VerifiableEntity,
  ids: number[],
  accountId: number,
): Promise<Set<number>> {
  switch (entity) {
    case 'asset': {
      const rows = await db.select({ id: assets.id }).from(assets).where(and(
        inArray(assets.id, ids), eq(assets.accountId, accountId), isNull(assets.deletedAt),
      ));
      return new Set(rows.map((r) => r.id));
    }
    case 'room': {
      // Les pièces sont rattachées à un bien : le cloisonnement passe par une jointure.
      const rows = await db.select({ id: rooms.id })
        .from(rooms)
        .innerJoin(assets, eq(rooms.assetId, assets.id))
        .where(and(inArray(rooms.id, ids), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
      return new Set(rows.map((r) => r.id));
    }
    case 'equipment': {
      const rows = await db.select({ id: equipments.id })
        .from(equipments)
        .innerJoin(assets, eq(equipments.assetId, assets.id))
        .where(and(inArray(equipments.id, ids), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
      return new Set(rows.map((r) => r.id));
    }
    case 'supplier': {
      const rows = await db.select({ id: suppliers.id }).from(suppliers).where(and(
        inArray(suppliers.id, ids), eq(suppliers.accountId, accountId),
      ));
      return new Set(rows.map((r) => r.id));
    }
  }
}
