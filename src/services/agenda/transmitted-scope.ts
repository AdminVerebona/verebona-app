/**
 * Carte #849 (A2) — échéances et événements d'un bien TRANSMIS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Un bien transmis sort du portefeuille actif : ses échéances et événements
 * restent CONSULTABLES dans son historique (fiche du bien, filtre par bien,
 * document), mais disparaissent de l'Agenda courant du compte, de l'accueil,
 * des calendriers ICS et des rappels.
 *
 * Règle unique (SQL) : un élément est MASQUÉ s'il vise au moins un bien
 * TRANSMIS (lien direct, par un équipement ou par une pièce) et AUCUN bien
 * actif (non supprimé, non transmis). Une échéance partagée avec un autre
 * bien en service continue donc pour ce bien. Un élément sans bien (compte)
 * n'est jamais masqué.
 *
 * À la remise en service, rien n'est réécrit : les éléments réapparaissent
 * d'eux-mêmes ; les rappels ne couvrent que la fenêtre J+0 → J+7 et leur
 * dédoublonnage (`agenda_deadline_reminders`) empêche tout rappel
 * rétroactif ou en double.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Biens visés par l'élément d'alias `i` (directs, via équipement, via pièce). */
const biensVises = (i: string) => `(
  SELECT l.asset_id FROM agenda_asset_links l WHERE l.agenda_item_id = ${i}.id
  UNION SELECT e.asset_id FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id WHERE l.agenda_item_id = ${i}.id
  UNION SELECT s.asset_id FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id WHERE l.agenda_item_id = ${i}.id
)`;

/** Condition SQL : l'élément d'agenda d'alias `i` est masqué (biens visés tous transmis). */
export function agendaItemHiddenByTransmittedAssetsSql(i: string): string {
  return `(EXISTS (SELECT 1 FROM ${biensVises(i)} v JOIN assets a ON a.id = v.asset_id
                    WHERE a.deleted_at IS NULL AND a.status = 'TRANSMIS')
           AND NOT EXISTS (SELECT 1 FROM ${biensVises(i)} v JOIN assets a ON a.id = v.asset_id
                    WHERE a.deleted_at IS NULL AND a.status IS DISTINCT FROM 'TRANSMIS'))`;
}

/**
 * #849 (A2) — garde d'ÉCRITURE de l'Agenda : refus (403 `ASSET_READ_ONLY`)
 * si la demande rattache un bien TRANSMIS (directement, par un équipement ou
 * une pièce) ou modifie / supprime un élément qui ne vise QUE des biens
 * transmis. `null` : écriture permise. Les éléments partagés avec un bien en
 * service restent modifiables (pour ce bien) ; le lien au bien transmis,
 * lui, n'est pas ajouté.
 */
export async function refuserEcritureAgendaBienTransmis(p: {
  accountId: number;
  itemId?: number | null;
  assetIds?: unknown; equipmentIds?: unknown; substructureIds?: unknown;
}): Promise<import('next/server').NextResponse | null> {
  const { pgClient } = await import('@/db');
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : []);
  const a = ids(p.assetIds); const e = ids(p.equipmentIds); const s = ids(p.substructureIds);
  let bloque = false;
  if (a.length || e.length || s.length) {
    const r = (await pgClient.unsafe(
      `SELECT 1 FROM assets x
        WHERE x.account_id = $1 AND x.deleted_at IS NULL AND x.status = 'TRANSMIS'
          AND (x.id = ANY($2::int[])
            OR x.id IN (SELECT asset_id FROM equipments WHERE id = ANY($3::int[]))
            OR x.id IN (SELECT asset_id FROM substructures WHERE id = ANY($4::int[])))
        LIMIT 1`,
      [p.accountId, `{${a.join(',')}}`, `{${e.join(',')}}`, `{${s.join(',')}}`] as never[],
    )) as unknown as unknown[];
    bloque = r.length > 0;
  }
  if (!bloque && p.itemId) {
    const r = (await pgClient.unsafe(
      `SELECT 1 FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2 AND ${agendaItemHiddenByTransmittedAssetsSql('i')}`,
      [p.itemId, p.accountId] as never[],
    )) as unknown as unknown[];
    bloque = r.length > 0;
  }
  if (!bloque) return null;
  const { NextResponse } = await import('next/server');
  const { ASSET_READ_ONLY_MESSAGE } = await import('@/lib/asset-status');
  return NextResponse.json(
    { error: ASSET_READ_ONLY_MESSAGE, code: 'ASSET_READ_ONLY', message: ASSET_READ_ONLY_MESSAGE },
    { status: 403 },
  );
}
