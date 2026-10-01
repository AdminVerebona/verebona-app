/**
 * Vue canonique d'un ÉQUIPEMENT ou d'une PIÈCE — CDC 15 T1-04 (lot 18, R3).
 *
 * Même ordre de lecture qu'un bien (D-10) :
 *   1. fiche de l'entité (`equipments.key_characteristics`,
 *      `rooms.key_characteristics`, migration 0227) ;
 *   2. colonne historique miroir (`equipments.purchase_price_cents`,
 *      `equipment_cil_specs.serial_number`, `rooms.area`…), convertie dans
 *      l'unité canonique. Une valeur de colonne sans origine dans la fiche est
 *      lue `USER` (saisie de l'écran, protégée — `readOrigin`).
 *
 * Champs admis : ceux du registre dont `targetTypes` contient le type de
 * l'entité (jamais un champ du bien : `livingArea` n'a rien à faire sur une
 * pièce). La famille du bien n'est pas un filtre ici : `serialNumber` est un
 * champ des OBJETS au niveau du bien, mais vaut pour la chaudière d'une maison.
 *
 * Toujours bornée au compte PAR LE BIEN PARENT (non supprimé).
 */
import { pgClient } from '@/db';
import { readOrigin } from '@/services/ai/reconciliation/field-origin';
import {
  centsToEur, fieldTargetTypes, getField, isExcludedKey, listFields, normalizeValue, resolveAlias,
  type CanonicalFieldDef,
} from '@/services/canonical/registry';
import { isEmptyValue, parseKc, type CanonicalFieldState, type SqlRunner } from '@/services/canonical/asset-state';
import type {
  CanonicalEntityRow, CanonicalEntityState, CanonicalEntityTarget, CanonicalEntityType, EntityMirrorColumn,
} from './types';

/**
 * Colonnes réelles d'une entité (registre, en-tête de `fields.ts`). Les
 * champs absents de cette table n'ont QUE la fiche 0227 (dates de garantie,
 * d'entretien, d'achat d'un équipement).
 */
export const ENTITY_MIRRORS: Readonly<Record<CanonicalEntityType, Readonly<Record<string, EntityMirrorColumn>>>> = {
  EQUIPMENT: {
    acquisitionPrice: { table: 'equipments', column: 'purchase_price_cents', transform: 'eur_to_cents' },
    estimatedValue: { table: 'equipments', column: 'estimated_value_cents', transform: 'eur_to_cents' },
    brand: { table: 'equipment_cil_specs', column: 'brand', transform: 'identity' },
    modelName: { table: 'equipment_cil_specs', column: 'model', transform: 'identity' },
    serialNumber: { table: 'equipment_cil_specs', column: 'serial_number', transform: 'identity' },
    powerKw: { table: 'equipment_cil_specs', column: 'power_kw', transform: 'number' },
  },
  ROOM: {
    roomArea: { table: 'rooms', column: 'area', transform: 'text_number' },
  },
};

export const mirrorId = (m: EntityMirrorColumn) => `${m.table}.${m.column}`;

/** Le champ admet-il cette cible (`targetTypes` du registre, obligatoire) ? */
export function fieldTargetsEntity(def: CanonicalFieldDef, type: CanonicalEntityType): boolean {
  return fieldTargetTypes(def).includes(type);
}

/** Champs du registre applicables à un type d'entité. */
export function listEntityFields(type: CanonicalEntityType): CanonicalFieldDef[] {
  return listFields(undefined, { targetType: type });
}

/**
 * Définition d'une clé (canonique ou alias) pour une entité. `undefined` :
 * clé inconnue ou exclue. La cible n'est PAS vérifiée ici (motif distinct).
 */
export function resolveEntityDef(rawKey: string): CanonicalFieldDef | undefined {
  if (isExcludedKey(rawKey)) return undefined;
  const direct = getField(rawKey);
  if (direct) return direct;
  const k = resolveAlias(rawKey);
  return k ? getField(k) : undefined;
}

/** Colonne miroir → valeur canonique (null si vide ou illisible). */
export function fromEntityMirror(key: string, m: EntityMirrorColumn, raw: unknown): unknown {
  if (isEmptyValue(raw)) return null;
  switch (m.transform) {
    case 'eur_to_cents': {
      const n = Number(raw);
      return Number.isInteger(n) ? centsToEur(n) : null;
    }
    case 'number':
    case 'text_number': {
      const r = normalizeValue(key, raw);
      return r.ok ? r.value : raw;
    }
    default:
      return raw;
  }
}

function canonicalise(key: string, raw: unknown): { value: unknown; normalized: boolean } {
  const r = normalizeValue(key, raw);
  return r.ok ? { value: r.value, normalized: true } : { value: raw, normalized: false };
}

/** État d'UNE clé canonique d'une entité (null si vide) — pure. */
export function readEntityFieldState(def: CanonicalFieldDef, row: CanonicalEntityRow): CanonicalFieldState | null {
  const kc = row.kc;
  let value: unknown;
  let normalized = true;
  let from: CanonicalFieldState['from'] = 'key';
  let fromName: string | undefined;
  if (!isEmptyValue(kc[def.key])) {
    ({ value, normalized } = canonicalise(def.key, kc[def.key]));
  } else {
    const m = ENTITY_MIRRORS[row.target.type][def.key];
    const v = m ? fromEntityMirror(def.key, m, row.columns[mirrorId(m)]) : null;
    if (!isEmptyValue(v)) { value = v; from = 'column'; fromName = mirrorId(m!); }
  }
  if (isEmptyValue(value)) return null;
  // Colonne sans origine tracée : saisie de l'écran → USER (protégée).
  const origin = readOrigin(kc, def.key);
  const upd = kc[`${def.key}__updatedAt`];
  const st: CanonicalFieldState = { key: def.key, value, origin, from, updatedAt: typeof upd === 'string' ? upd : null };
  if (!normalized) st.normalized = false;
  if (fromName) st.fromName = fromName;
  return st;
}

/** Vue canonique d'une ligne d'entité — pure. */
export function buildCanonicalEntityState(row: CanonicalEntityRow): CanonicalEntityState {
  const fields: Record<string, CanonicalFieldState> = {};
  for (const def of listEntityFields(row.target.type)) {
    const st = readEntityFieldState(def, row);
    if (st) fields[def.key] = st;
  }
  return {
    target: row.target, assetId: row.assetId, accountId: row.accountId, name: row.name,
    archived: row.archived, fields, kc: row.kc,
  };
}

const LOCK = ' FOR UPDATE OF x';

/**
 * Ligne d'une entité, bornée au compte par le bien parent (non supprimé).
 * `lock` : `FOR UPDATE` sur la ligne de l'entité (dans une transaction).
 * Suppose la 0227 appliquée (contrôle par l'appelant).
 */
export async function loadEntityRow(
  run: SqlRunner,
  target: CanonicalEntityTarget,
  accountId: number,
  lock = false,
): Promise<CanonicalEntityRow | null> {
  if (!Number.isInteger(target.id) || target.id <= 0) return null;
  if (target.type === 'EQUIPMENT') {
    const rows = (await run.unsafe(
      `SELECT x.id, x.asset_id AS "assetId", a.account_id AS "accountId", x.name, x.archived_at IS NOT NULL AS archived,
              x.key_characteristics AS kc, x.purchase_price_cents AS ppc, x.estimated_value_cents AS evc,
              s.id AS "specId", s.brand, s.model, s.serial_number AS sn, s.power_kw AS pkw
         FROM equipments x
         JOIN assets a ON a.id = x.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
         LEFT JOIN equipment_cil_specs s ON s.equipment_id = x.id
        WHERE x.id = $1${lock ? LOCK : ''}`,
      [target.id, accountId] as never[],
    )) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    return {
      target, assetId: Number(r.assetId), accountId: Number(r.accountId), name: (r.name as string) ?? null,
      archived: r.archived === true, kc: parseKc(r.kc), hasSpecs: r.specId != null,
      columns: {
        'equipments.purchase_price_cents': r.ppc ?? null,
        'equipments.estimated_value_cents': r.evc ?? null,
        'equipment_cil_specs.brand': r.brand ?? null,
        'equipment_cil_specs.model': r.model ?? null,
        'equipment_cil_specs.serial_number': r.sn ?? null,
        'equipment_cil_specs.power_kw': r.pkw ?? null,
      },
    };
  }
  const rows = (await run.unsafe(
    `SELECT x.id, x.asset_id AS "assetId", a.account_id AS "accountId", x.name, x.key_characteristics AS kc, x.area
       FROM rooms x
       JOIN assets a ON a.id = x.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
      WHERE x.id = $1${lock ? LOCK : ''}`,
    [target.id, accountId] as never[],
  )) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    target, assetId: Number(r.assetId), accountId: Number(r.accountId), name: (r.name as string) ?? null,
    archived: false, kc: parseKc(r.kc), columns: { 'rooms.area': r.area ?? null },
  };
}

/**
 * État canonique d'un équipement ou d'une pièce du compte ; `null` si
 * introuvable ou si la migration 0227 manque.
 */
export async function getCanonicalEntityState(
  target: CanonicalEntityTarget,
  accountId: number,
  run: SqlRunner = pgClient as unknown as SqlRunner,
): Promise<CanonicalEntityState | null> {
  const { entityCanonicalColumnsReady } = await import('./entity-schema');
  if (!(await entityCanonicalColumnsReady())) return null;
  const row = await loadEntityRow(run, target, accountId);
  return row ? buildCanonicalEntityState(row) : null;
}

/** Entités (actives) d'un bien du compte : équipements non archivés et pièces. */
export async function listAssetEntities(
  accountId: number,
  assetId: number,
  run: SqlRunner = pgClient as unknown as SqlRunner,
): Promise<CanonicalEntityTarget[]> {
  const rows = (await run.unsafe(
    `SELECT 'EQUIPMENT' AS type, e.id FROM equipments e JOIN assets a ON a.id = e.asset_id
      WHERE a.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL AND e.archived_at IS NULL
     UNION ALL
     SELECT 'ROOM', r.id FROM rooms r JOIN assets a ON a.id = r.asset_id
      WHERE a.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL
     ORDER BY 1, 2`,
    [assetId, accountId] as never[],
  )) as Array<{ type: CanonicalEntityType; id: number }>;
  return rows.map((r) => ({ type: r.type, id: Number(r.id) }));
}

/**
 * Fiches de TOUTES les entités actives d'un bien du compte (équipements non
 * archivés et pièces) en UNE requête — lectures groupées de l'assistant et
 * des exports (relecture lot 18 : pas de N+1). Bien parent ACTUEL : un
 * équipement déplacé est lu sur son nouveau bien. Suppose la 0227 appliquée.
 */
export async function loadAssetEntityRows(
  run: SqlRunner,
  accountId: number,
  assetId: number,
): Promise<CanonicalEntityRow[]> {
  const rows = (await run.unsafe(
    `SELECT 'EQUIPMENT' AS type, x.id, x.asset_id AS "assetId", a.account_id AS "accountId", x.name,
            x.key_characteristics AS kc, s.id IS NOT NULL AS "hasSpecs",
            jsonb_build_object('equipments.purchase_price_cents', x.purchase_price_cents,
              'equipments.estimated_value_cents', x.estimated_value_cents,
              'equipment_cil_specs.brand', s.brand, 'equipment_cil_specs.model', s.model,
              'equipment_cil_specs.serial_number', s.serial_number, 'equipment_cil_specs.power_kw', s.power_kw) AS cols
       FROM equipments x
       JOIN assets a ON a.id = x.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
       LEFT JOIN equipment_cil_specs s ON s.equipment_id = x.id
      WHERE x.asset_id = $1 AND x.archived_at IS NULL
     UNION ALL
     SELECT 'ROOM', x.id, x.asset_id, a.account_id, x.name, x.key_characteristics, false,
            jsonb_build_object('rooms.area', x.area)
       FROM rooms x
       JOIN assets a ON a.id = x.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
      WHERE x.asset_id = $1
      ORDER BY 1, 2`,
    [assetId, accountId] as never[],
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    target: { type: r.type as CanonicalEntityType, id: Number(r.id) },
    assetId: Number(r.assetId), accountId: Number(r.accountId), name: (r.name as string) ?? null,
    archived: false, kc: parseKc(r.kc), hasSpecs: r.hasSpecs === true,
    columns: parseKc(r.cols),
  }));
}
