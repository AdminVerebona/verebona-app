/**
 * CanonicalAssetView — lecture unique de l'état courant d'un bien
 * (CDC 15 §12 SVC-04, T3-05 ; plan lot 11, décision D-10).
 *
 * Ordre de lecture d'une clé canonique :
 *   1. `keyCharacteristics[clé]` — la source de vérité (D-10) ;
 *   2. un alias historique présent dans `keyCharacteristics` (registre) ;
 *   3. la colonne historique miroir (`purchase_date`, `purchase_price_cents`,
 *      `registration_number`, `address`, …), convertie dans l'unité
 *      canonique — repli tant que le rattrapage MIG-07 n'a pas été exécuté.
 *
 * L'origine est lue au format structuré `<clé>__origin` (puis l'ancien
 * `<clé>_origin`) ; sans information, elle vaut `USER` : une valeur
 * historique non tracée est protégée (CDC §14.3, `readOrigin`).
 *
 * Toujours bornée au compte : un bien d'un autre compte est « introuvable ».
 */
import { pgClient } from '@/db';
import { readOrigin } from '@/services/ai/reconciliation/field-origin';
import {
  centsToEur, getField, listFields, normalizeValue, resolveAlias, resolveAliasDetailed, toAssetFamily,
  type AssetFamily, type CanonicalFieldDef, type MirrorColumn,
} from '@/services/canonical/registry';
import type { CanonicalAssetState, CanonicalFieldState } from './types';

/** Ligne `assets` telle que renvoyée par `row_to_json` (noms SQL). */
export type AssetRowJson = Record<string, unknown> & {
  id: number;
  account_id: number | null;
  category: string;
  key_characteristics: string | null;
  updated_at?: string | null;
};

/** Exécutant SQL minimal (client ou transaction postgres.js). */
export interface SqlRunner {
  unsafe(query: string, params?: never[]): Promise<unknown> | PromiseLike<unknown>;
}

export function parseKc(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...(raw as Record<string, unknown>) };
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Valeur absente : null, chaîne vide, liste vide. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Colonne historique → valeur dans l'unité canonique (inverse de `toMirrorValue`). */
export function fromMirrorColumn(col: MirrorColumn, raw: unknown): unknown {
  if (isEmptyValue(raw)) return null;
  switch (col.transform) {
    case 'eur_to_cents': {
      const n = Number(raw);
      return Number.isFinite(n) ? centsToEur(n) : null;
    }
    case 'date':
      return String(raw).slice(0, 10);
    case 'integer': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    default:
      return raw;
  }
}

export function hasOriginInfo(kc: Record<string, unknown>, name: string): boolean {
  return kc[`${name}__origin`] !== undefined || kc[`${name}_origin`] !== undefined;
}

/** Clé technique de la fiche (`x__origin`, `x_origin`, `x__updatedAt`…) : jamais une valeur. */
export function isMetaKey(k: string): boolean {
  return k.includes('__') || /_origin$/.test(k);
}

export interface KcAlias { rawKey: string; sourceUnit?: string }

/**
 * Clés de la fiche qui sont des ALIAS d'une clé canonique (résolution du
 * registre : casse, accents, séparateurs ignorés), groupées par clé.
 */
export function indexKcAliases(kc: Record<string, unknown>, family: AssetFamily): Map<string, KcAlias[]> {
  const out = new Map<string, KcAlias[]>();
  for (const k of Object.keys(kc)) {
    // Clé canonique de CETTE famille : pas un alias. Une clé canonique d'une
    // autre famille peut être un alias ici (`generalCondition` → `condition`).
    if (isMetaKey(k) || getField(k)?.families.includes(family)) continue;
    const r = resolveAliasDetailed(k, family);
    if (!r || r.canonical) continue;
    const list = out.get(r.key) ?? [];
    list.push(r.sourceUnit ? { rawKey: k, sourceUnit: r.sourceUnit } : { rawKey: k });
    out.set(r.key, list);
  }
  return out;
}

/** Valeur dans l'unité canonique si elle se normalise, brute sinon. */
function canonicalise(key: string, raw: unknown, sourceUnit?: string): { value: unknown; normalized: boolean } {
  const r = normalizeValue(key, raw, sourceUnit ? { sourceUnit } : {});
  return r.ok ? { value: r.value, normalized: true } : { value: raw, normalized: false };
}

/** État d'UNE clé canonique dans une ligne de bien (null si vide). */
export function readFieldState(
  def: CanonicalFieldDef,
  kc: Record<string, unknown>,
  row: Record<string, unknown>,
  aliases: KcAlias[] = [],
): CanonicalFieldState | null {
  let value: unknown;
  let normalized = true;
  let from: CanonicalFieldState['from'] = 'key';
  let fromName: string | undefined;

  if (!isEmptyValue(kc[def.key])) {
    ({ value, normalized } = canonicalise(def.key, kc[def.key]));
  } else {
    for (const a of aliases) {
      if (isEmptyValue(kc[a.rawKey])) continue;
      ({ value, normalized } = canonicalise(def.key, kc[a.rawKey], a.sourceUnit));
      from = 'alias'; fromName = a.rawKey;
      break;
    }
  }
  if (value === undefined && from === 'key') {
    for (const col of def.mirrorColumns ?? []) {
      const v = fromMirrorColumn(col, row[col.column]);
      if (!isEmptyValue(v)) { value = v; from = 'column'; fromName = col.column; break; }
    }
  }
  if (isEmptyValue(value)) return null;

  // L'origine suit la clé effectivement lue ; une colonne n'en a pas → USER.
  const originKey = from === 'alias' && fromName && !hasOriginInfo(kc, def.key) && hasOriginInfo(kc, fromName)
    ? fromName : def.key;
  const origin = from === 'column' ? 'USER' : readOrigin(kc, originKey);
  const upd = kc[`${originKey}__updatedAt`];
  const src = kc[`${originKey}__source`];
  const state: CanonicalFieldState = {
    key: def.key, value, origin, from,
    updatedAt: typeof upd === 'string' ? upd : null,
  };
  if (!normalized) state.normalized = false;
  if (fromName) state.fromName = fromName;
  if (typeof src === 'string') state.source = src;
  return state;
}

/** Famille d'une ligne : celle du registre, OBJECT à défaut (comme la fiche). */
export function rowFamily(category: string | null | undefined): AssetFamily {
  return toAssetFamily(category) ?? 'OBJECT';
}

/** Vue canonique d'une ligne de bien — fonction pure. */
export function buildCanonicalAssetState(row: AssetRowJson): CanonicalAssetState {
  const family = rowFamily(row.category);
  const kc = parseKc(row.key_characteristics);
  const aliases = indexKcAliases(kc, family);
  const fields: Record<string, CanonicalFieldState> = {};
  for (const def of listFields(family)) {
    const st = readFieldState(def, kc, row, aliases.get(def.key));
    if (st) fields[def.key] = st;
  }
  return {
    assetId: Number(row.id),
    accountId: Number(row.account_id),
    family,
    category: row.category,
    fields,
    assetUpdatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

/** État canonique d'une clé (ou d'un alias) dans une ligne — null si vide. */
export function readCanonicalValue(row: AssetRowJson, key: string): CanonicalFieldState | null {
  const family = rowFamily(row.category);
  const def = getField(key) ?? getField(resolveAlias(key, family) ?? '');
  if (!def) return null;
  const kc = parseKc(row.key_characteristics);
  return readFieldState(def, kc, row, indexKcAliases(kc, family).get(def.key));
}

/**
 * Ligne complète du bien, bornée au compte, hors biens supprimés.
 * `lock` : `FOR UPDATE` (à n'utiliser que dans une transaction).
 */
export async function loadAssetRow(
  run: SqlRunner,
  assetId: number,
  accountId: number,
  lock = false,
): Promise<AssetRowJson | null> {
  const rows = (await run.unsafe(
    `SELECT row_to_json(a.*) AS r FROM assets a
      WHERE a.id = $1 AND a.account_id = $2 AND a.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [assetId, accountId] as never[],
  )) as Array<{ r: AssetRowJson | string }>;
  const r = rows[0]?.r;
  if (!r) return null;
  return typeof r === 'string' ? JSON.parse(r) as AssetRowJson : r;
}

/**
 * CanonicalAssetView : clés canoniques → { valeur, origine, date, source }.
 * `null` si le bien n'existe pas dans ce compte.
 */
export async function getCanonicalAssetState(
  assetId: number,
  accountId: number,
  run: SqlRunner = pgClient as unknown as SqlRunner,
): Promise<CanonicalAssetState | null> {
  const row = await loadAssetRow(run, assetId, accountId);
  return row ? buildCanonicalAssetState(row) : null;
}
