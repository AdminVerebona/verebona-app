/**
 * Carte #849 (B1, B2) — PLAN de suppression définitive d'un bien : ce qui est
 * SUPPRIMÉ (appartient exclusivement au bien) et ce qui est CONSERVÉ (lié aussi
 * à un autre bien du compte), calculé UNE fois, par la même requête, pour la
 * fenêtre de confirmation (inventaire + empreinte) et pour la suppression
 * elle-même (dans sa transaction, ligne du bien verrouillée).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *
 *   · Document (`asset_files`) du bien (colonnes historiques, pièce, équipement
 *     du bien) : CONSERVÉ s'il vise aussi un AUTRE bien non supprimé du même
 *     compte (colonnes, ou lien N-N ACTIF PRIMARY / SECONDARY vers ce bien, une
 *     de ses pièces ou un de ses équipements) — seules ses relations au bien
 *     supprimé sont retirées ; s'il appartenait au bien, il est confié à
 *     l'autre bien (lien principal d'abord). Sinon SUPPRIMÉ, versions et
 *     fichiers compris (purge après commit).
 *   · Échéance / événement historiques (`deadlines`, `events`) : conservés
 *     s'ils visent aussi un autre bien (colonne `asset_id` ou
 *     `linked_asset_id`), sinon supprimés.
 *   · Élément d'Agenda : SUPPRIMÉ s'il vise le bien (lien direct, équipement,
 *     pièce ou document supprimé) et AUCUN autre bien ni document conservé ;
 *     sinon CONSERVÉ (liens au bien retirés par la cascade).
 *   · Opération : SUPPRIMÉE (dépenses, ventilations, preuves, historique
 *     compris) si elle ne vise que ce bien (liens, équipements, pièces,
 *     composantes) et qu'aucune Opération ou élément d'Agenda CONSERVÉ ne la
 *     référence ; sinon CONSERVÉE — détachée du bien (retrait historisé du
 *     lot 39), invalidée si plus aucune source ne la soutient.
 *   · Lignes d'un AUTRE compte : jamais visées (règle D23, déclencheur 0346).
 *
 * L'EMPREINTE (`fingerprint`) couvre les identifiants de chaque catégorie,
 * supprimés et conservés : la suppression HTTP l'exige et la recalcule sous
 * verrou ; un rattachement survenu entre l'affichage et la confirmation
 * (nouveau document, nouvelle Opération, partage) est refusé (409), jamais
 * détruit à l'aveugle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { db } from '@/db';

type Runner = Pick<typeof db, 'execute'>;
type Row = Record<string, unknown>;
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const num = (v: unknown): number => Number(v);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : []).sort((a, b) => a - b);
const pgInts = (list: readonly number[]) => `{${list.map((n) => Math.trunc(Number(n))).join(',')}}`;

export interface DeletionPlan {
  assetId: number;
  accountId: number | null;
  /** Documents (photos comprises) supprimés avec le bien. */
  exclusiveFileIds: number[];
  /** Documents conservés : nouveau bien porteur si le document appartenait au bien supprimé. */
  sharedFiles: Array<{ id: number; newAssetId: number | null }>;
  /** Fichiers « documents » (hors photos, envoi terminé, non supprimés) — affichage. */
  documentFileIds: number[];
  versionIds: number[];
  photoIds: number[];
  substructureIds: number[];
  equipmentIds: number[];
  exclusiveDeadlineIds: number[];
  sharedDeadlineIds: number[];
  exclusiveEventIds: number[];
  sharedEventIds: number[];
  exclusiveAgendaItemIds: number[];
  sharedAgendaItemIds: number[];
  /** Opérations supprimées physiquement. */
  exclusiveOperationIds: number[];
  /** Opérations conservées : multi-biens, ou référencées par un élément conservé (détachées / invalidées). */
  sharedOperationIds: number[];
  /**
   * Dépenses du bien supprimées : composantes financières actives des Opérations supprimées, et
   * ventilations d'une Opération CONSERVÉE qui visent le bien (ou un de ses équipements) — retirées
   * (remplacées, historisées) : jamais reportées sur les autres biens (pas de double comptage).
   */
  expenseComponentIds: number[];
  /** Sous-ensemble : ventilations au bien dans des Opérations conservées. */
  sharedOperationExpenseIds: number[];
  exportIds: number[];
}

/** Décompte présenté avant confirmation (#849) — compatible avec l'ancien résumé. */
export interface AssetDeletionInventory {
  documents: number;
  documentVersions: number;
  photos: number;
  deadlines: number;
  events: number;
  rooms: number;
  equipments: number;
  agendaItems: number;
  operations: number;
  expenses: number;
  exports: number;
  /** Éléments liés aussi à un autre bien : CONSERVÉS, seule la relation au bien supprimé disparaît. */
  shared: { documents: number; agendaItems: number; operations: number; deadlines: number; events: number };
  /** Empreinte de l'inventaire : à renvoyer à la suppression (409 si elle a changé). */
  fingerprint: string;
}

/** Empreinte stable d'un plan (pure, testée) : identifiants triés de chaque catégorie. */
export function deletionPlanFingerprint(p: Omit<DeletionPlan, 'accountId'>): string {
  const canon = {
    v: 1,
    a: p.assetId,
    f: [...p.exclusiveFileIds].sort((a, b) => a - b),
    sf: [...p.sharedFiles].map((s) => `${s.id}>${s.newAssetId ?? ''}`).sort(),
    ve: [...p.versionIds].sort((a, b) => a - b),
    ph: [...p.photoIds].sort((a, b) => a - b),
    su: [...p.substructureIds].sort((a, b) => a - b),
    eq: [...p.equipmentIds].sort((a, b) => a - b),
    dl: [...p.exclusiveDeadlineIds].sort((a, b) => a - b),
    sdl: [...p.sharedDeadlineIds].sort((a, b) => a - b),
    ev: [...p.exclusiveEventIds].sort((a, b) => a - b),
    sev: [...p.sharedEventIds].sort((a, b) => a - b),
    ag: [...p.exclusiveAgendaItemIds].sort((a, b) => a - b),
    sag: [...p.sharedAgendaItemIds].sort((a, b) => a - b),
    op: [...p.exclusiveOperationIds].sort((a, b) => a - b),
    sop: [...p.sharedOperationIds].sort((a, b) => a - b),
    ex: [...p.expenseComponentIds].sort((a, b) => a - b),
    xp: [...p.exportIds].sort((a, b) => a - b),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 32);
}

/** Inventaire affiché (pur, testé). */
export function inventoryOfPlan(p: DeletionPlan): AssetDeletionInventory {
  return {
    documents: p.documentFileIds.length,
    documentVersions: p.versionIds.length,
    photos: p.photoIds.length,
    deadlines: p.exclusiveDeadlineIds.length,
    events: p.exclusiveEventIds.length,
    rooms: p.substructureIds.length,
    equipments: p.equipmentIds.length,
    agendaItems: p.exclusiveAgendaItemIds.length,
    operations: p.exclusiveOperationIds.length,
    expenses: p.expenseComponentIds.length,
    exports: p.exportIds.length,
    shared: {
      documents: p.sharedFiles.length,
      agendaItems: p.sharedAgendaItemIds.length,
      operations: p.sharedOperationIds.length,
      deadlines: p.sharedDeadlineIds.length,
      events: p.sharedEventIds.length,
    },
    fingerprint: deletionPlanFingerprint(p),
  };
}

/**
 * Ligne d'une table à `account_id` qui appartient au même compte que le bien
 * (ou bien / ligne sans compte, historique) — règle D23 (lot 53).
 */
const memeCompte = (t: string, assetId: number) => `(${t}.account_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM assets o WHERE o.id = ${assetId} AND o.account_id IS NOT NULL AND o.account_id <> ${t}.account_id))`;

/**
 * Calcule le plan. `runner` : la transaction de suppression (ligne du bien
 * verrouillée) ou une lecture simple (inventaire). `null` : bien introuvable.
 */
export async function planAssetDeletion(runner: Runner, assetId: number): Promise<DeletionPlan | null> {
  const X = Math.trunc(Number(assetId));
  const [asset] = await rows<{ id: number; account_id: number | null }>(runner, sql`SELECT id, account_id FROM assets WHERE id = ${X}`);
  if (!asset) return null;
  const accountId = asset.account_id === null ? null : num(asset.account_id);

  // ── Documents ────────────────────────────────────────────────────────────
  const fichiers = await rows<{ id: number; asset_id: number | null; others: unknown; preferred: number | null; is_doc: boolean }>(runner, sql.raw(`
    WITH subs AS (SELECT id FROM substructures WHERE asset_id = ${X}),
         eqs  AS (SELECT id FROM equipments WHERE asset_id = ${X}),
         rms  AS (SELECT id FROM rooms WHERE asset_id = ${X})
    SELECT f.id, f.asset_id,
           (f.deleted_at IS NULL AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED'
             AND NOT EXISTS (SELECT 1 FROM asset_photos p WHERE p.file_id = f.id AND p.asset_id = ${X})) AS is_doc,
           COALESCE((SELECT array_agg(DISTINCT t.asset_id) FROM (
               SELECT f.asset_id AS asset_id, 1 AS rk WHERE f.asset_id IS NOT NULL
               UNION ALL SELECT f.linked_asset_id, 2 WHERE f.linked_asset_id IS NOT NULL
               UNION ALL SELECT s.asset_id, 3 FROM substructures s WHERE s.id = f.substructure_id
               UNION ALL SELECT e.asset_id, 3 FROM equipments e WHERE e.id = f.equipment_id
               UNION ALL SELECT COALESCE(l.asset_id, e.asset_id, s.asset_id), CASE WHEN l.link_role = 'PRIMARY' THEN 0 ELSE 2 END
                 FROM document_asset_links l
                 LEFT JOIN equipments e ON e.id = l.equipment_id
                 LEFT JOIN substructures s ON s.id = l.substructure_id
                WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY')
             ) t JOIN assets a ON a.id = t.asset_id AND a.deleted_at IS NULL AND a.account_id IS NOT DISTINCT FROM f.account_id
             WHERE t.asset_id <> ${X}), '{}') AS others,
           (SELECT t.asset_id FROM (
               SELECT f.linked_asset_id AS asset_id, 2 AS rk WHERE f.linked_asset_id IS NOT NULL
               UNION ALL SELECT s.asset_id, 3 FROM substructures s WHERE s.id = f.substructure_id
               UNION ALL SELECT e.asset_id, 3 FROM equipments e WHERE e.id = f.equipment_id
               UNION ALL SELECT COALESCE(l.asset_id, e.asset_id, s.asset_id), CASE WHEN l.link_role = 'PRIMARY' THEN 0 ELSE 2 END
                 FROM document_asset_links l
                 LEFT JOIN equipments e ON e.id = l.equipment_id
                 LEFT JOIN substructures s ON s.id = l.substructure_id
                WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY')
             ) t JOIN assets a ON a.id = t.asset_id AND a.deleted_at IS NULL AND a.account_id IS NOT DISTINCT FROM f.account_id
             WHERE t.asset_id <> ${X} ORDER BY t.rk, t.asset_id LIMIT 1) AS preferred
      FROM asset_files f
     WHERE (f.asset_id = ${X} OR f.linked_asset_id = ${X} OR f.linked_room_id IN (SELECT id FROM rms)
            OR (f.asset_id IS NULL AND (f.substructure_id IN (SELECT id FROM subs) OR f.equipment_id IN (SELECT id FROM eqs))))
       AND ${memeCompte('f', X)}
     ORDER BY f.id`));
  const exclusiveFileIds: number[] = [];
  const sharedFiles: DeletionPlan['sharedFiles'] = [];
  const documentFileIds: number[] = [];
  for (const f of fichiers) {
    const autres = nums(f.others);
    if (autres.length > 0) {
      sharedFiles.push({ id: num(f.id), newAssetId: f.asset_id !== null && num(f.asset_id) === X ? (f.preferred === null ? autres[0] : num(f.preferred)) : null });
    } else {
      exclusiveFileIds.push(num(f.id));
      if (f.is_doc === true) documentFileIds.push(num(f.id));
    }
  }
  const versionIds = exclusiveFileIds.length
    ? (await rows<{ id: number }>(runner, sql.raw(`SELECT id FROM document_versions WHERE file_id = ANY('${pgInts(exclusiveFileIds)}'::int[]) ORDER BY id`))).map((r) => num(r.id))
    : [];
  const photoIds = (await rows<{ id: number }>(runner, sql`SELECT id FROM asset_photos WHERE asset_id = ${X} ORDER BY id`)).map((r) => num(r.id));
  const substructureIds = (await rows<{ id: number }>(runner, sql`SELECT id FROM substructures WHERE asset_id = ${X} ORDER BY id`)).map((r) => num(r.id));
  const equipmentIds = (await rows<{ id: number }>(runner, sql`SELECT id FROM equipments WHERE asset_id = ${X} ORDER BY id`)).map((r) => num(r.id));

  // ── Échéances / événements historiques ────────────────────────────────────
  const legacy = async (table: 'deadlines' | 'events') => {
    const r = await rows<{ id: number; shared: boolean }>(runner, sql.raw(`
      SELECT t.id,
             EXISTS (SELECT 1 FROM assets a WHERE a.deleted_at IS NULL AND a.id <> ${X}
                      AND a.account_id IS NOT DISTINCT FROM t.account_id
                      AND (a.id = t.asset_id OR a.id = t.linked_asset_id)) AS shared
        FROM ${table} t
       WHERE (t.asset_id = ${X} OR t.linked_asset_id = ${X}
              OR t.linked_room_id IN (SELECT id FROM rooms WHERE asset_id = ${X})
              OR (t.asset_id IS NULL AND t.substructure_id IN (SELECT id FROM substructures WHERE asset_id = ${X})))
         AND ${memeCompte('t', X)}
       ORDER BY t.id`));
    return {
      exclusive: r.filter((x) => !x.shared).map((x) => num(x.id)),
      shared: r.filter((x) => x.shared).map((x) => num(x.id)),
    };
  };
  const dl = await legacy('deadlines');
  const ev = await legacy('events');

  // ── Agenda ───────────────────────────────────────────────────────────────
  const agenda = accountId === null ? [] : await rows<{ id: number; shared: boolean }>(runner, sql.raw(`
    SELECT i.id,
           (EXISTS (SELECT 1 FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id
                     WHERE l.agenda_item_id = i.id AND l.asset_id <> ${X} AND a.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id JOIN assets a ON a.id = e.asset_id
                        WHERE l.agenda_item_id = i.id AND e.asset_id <> ${X} AND a.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id JOIN assets a ON a.id = s.asset_id
                        WHERE l.agenda_item_id = i.id AND s.asset_id <> ${X} AND a.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id
                        AND NOT (l.asset_file_id = ANY('${pgInts(exclusiveFileIds)}'::int[])))) AS shared
      FROM agenda_items i
     WHERE i.account_id = ${accountId}
       AND (EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = ${X})
            OR EXISTS (SELECT 1 FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id WHERE l.agenda_item_id = i.id AND e.asset_id = ${X})
            OR EXISTS (SELECT 1 FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id WHERE l.agenda_item_id = i.id AND s.asset_id = ${X})
            OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = ANY('${pgInts(exclusiveFileIds)}'::int[])))
     ORDER BY i.id`));
  const exclusiveAgendaItemIds = agenda.filter((a) => !a.shared).map((a) => num(a.id));
  const sharedAgendaItemIds = agenda.filter((a) => a.shared).map((a) => num(a.id));

  // ── Opérations ───────────────────────────────────────────────────────────
  const ops = accountId === null ? [] : await rows<{ id: number; multi: boolean }>(runner, sql.raw(`
    SELECT o.id,
           (EXISTS (SELECT 1 FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id
                     WHERE l.operation_id = o.id AND l.active AND l.asset_id <> ${X} AND a.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM business_operation_equipment_links l JOIN assets a ON a.id = l.asset_id
                        WHERE l.operation_id = o.id AND l.active AND l.asset_id <> ${X} AND a.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM business_operation_room_links l JOIN assets a ON a.id = l.asset_id
                        WHERE l.operation_id = o.id AND l.active AND l.asset_id <> ${X} AND a.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM business_operation_financial_components c JOIN assets a ON a.id = c.target_asset_id
                        WHERE c.operation_id = o.id AND c.active AND c.target_asset_id <> ${X} AND a.deleted_at IS NULL)) AS multi
      FROM business_operations o
     WHERE o.account_id = ${accountId}
       AND (EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.asset_id = ${X})
            OR EXISTS (SELECT 1 FROM business_operation_equipment_links l WHERE l.operation_id = o.id AND l.asset_id = ${X})
            OR EXISTS (SELECT 1 FROM business_operation_room_links l WHERE l.operation_id = o.id AND l.asset_id = ${X})
            OR EXISTS (SELECT 1 FROM business_operation_financial_components c WHERE c.operation_id = o.id
                        AND (c.target_asset_id = ${X} OR c.target_equipment_id IN (SELECT id FROM equipments WHERE asset_id = ${X}))))
     ORDER BY o.id`));
  let exclusifs = ops.filter((o) => !o.multi).map((o) => num(o.id));
  // Une Opération exclusive référencée par une Opération ou un élément d'Agenda CONSERVÉS est conservée
  // (détachée, invalidée) : jamais de référence morte chez un survivant. Point fixe (références en chaîne).
  const { operationsReferencedBySurvivorsInTx } = await import('@/services/business-operations/asset-lifecycle');
  for (let tour = 0; tour < 10 && exclusifs.length > 0; tour++) {
    const gardes = new Set(await operationsReferencedBySurvivorsInTx(runner, exclusifs, exclusiveAgendaItemIds));
    if (gardes.size === 0) break;
    exclusifs = exclusifs.filter((id) => !gardes.has(id));
  }
  const exclusiveOperationIds = exclusifs;
  const sharedOperationIds = ops.map((o) => num(o.id)).filter((id) => !exclusiveOperationIds.includes(id));
  const exclusiveExpenseIds = exclusiveOperationIds.length
    ? (await rows<{ id: number }>(runner, sql.raw(`
        SELECT id FROM business_operation_financial_components
         WHERE operation_id = ANY('${pgInts(exclusiveOperationIds)}'::bigint[]) AND active ORDER BY id`))).map((r) => num(r.id))
    : [];
  const sharedOperationExpenseIds = sharedOperationIdsOf(ops.map((o) => num(o.id)), exclusiveOperationIds).length
    ? (await rows<{ id: number }>(runner, sql.raw(`
        SELECT id FROM business_operation_financial_components
         WHERE operation_id = ANY('${pgInts(sharedOperationIdsOf(ops.map((o) => num(o.id)), exclusiveOperationIds))}'::bigint[]) AND active
           AND (target_asset_id = ${X} OR target_equipment_id IN (SELECT id FROM equipments WHERE asset_id = ${X}))
         ORDER BY id`))).map((r) => num(r.id))
    : [];
  const expenseComponentIds = [...exclusiveExpenseIds, ...sharedOperationExpenseIds].sort((a, b) => a - b);

  const exportIds = (await rows<{ id: number }>(runner, sql`SELECT id FROM export_generation WHERE asset_id = ${X} ORDER BY id`)).map((r) => num(r.id));

  return {
    assetId: X, accountId,
    exclusiveFileIds, sharedFiles, documentFileIds, versionIds, photoIds, substructureIds, equipmentIds,
    exclusiveDeadlineIds: dl.exclusive, sharedDeadlineIds: dl.shared,
    exclusiveEventIds: ev.exclusive, sharedEventIds: ev.shared,
    exclusiveAgendaItemIds, sharedAgendaItemIds,
    exclusiveOperationIds, sharedOperationIds, expenseComponentIds, sharedOperationExpenseIds, exportIds,
  };
}

const sharedOperationIdsOf = (all: readonly number[], exclusive: readonly number[]) => all.filter((id) => !exclusive.includes(id));
