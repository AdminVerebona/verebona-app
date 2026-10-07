/**
 * Informations manquantes — CDC 15 T2-04 (lot 15).
 *
 * « Qu'est-ce qui manque sur ma fiche ? » se calcule depuis les
 * `completenessRule` du registre canonique (champ attendu pour la famille du
 * bien, valeur canonique vide), EN PLUS des éléments « À traiter » ouverts
 * sur les biens (complétions et arbitrages en attente). Borné au compte ;
 * biens archivés ou transmis exclus. Lecture seule.
 */
import { pgClient } from '@/db';
import { assistantAssetAvailability } from '../core/asset-availability';
import { buildCanonicalAssetState, isEmptyValue, type AssetRowJson } from '@/services/canonical/asset-state';
import { listFields, toAssetFamily, type AssetFamily, type CanonicalFieldDef } from '@/services/canonical/registry';
import { canonicalKeyOf } from './field-reader';

export interface MissingField {
  key: string;
  label: string;
  /** Carte « À traiter » ouverte sur ce champ, s'il y en a une. */
  toProcessPublicId: string | null;
}

export interface AssetCompleteness {
  assetId: number;
  assetName: string;
  family: AssetFamily;
  /** Champs attendus par le registre et non renseignés. */
  missing: MissingField[];
  /** Éléments « À traiter » ouverts sur le bien (hors champs ci-dessus). */
  toProcess: Array<{ publicId: string; question: string; fieldKey: string | null; actionKind: string }>;
}

/** Champs requis d'une famille (pure, testée). */
export function requiredFieldsFor(family: AssetFamily): CanonicalFieldDef[] {
  return listFields(family).filter((d) => d.completenessRule?.required
    && (!d.completenessRule.families || d.completenessRule.families.includes(family)));
}

/** Champs requis manquants d'un bien (pure, testée sur une ligne `assets`). */
export function missingRequiredFields(row: AssetRowJson): Array<{ key: string; label: string }> {
  const state = buildCanonicalAssetState(row);
  return requiredFieldsFor(state.family)
    .filter((d) => { const f = state.fields[d.key]; return !f || isEmptyValue(f.value); })
    .map((d) => ({ key: d.key, label: d.label }));
}

/** Informations manquantes des biens du compte (tous, ou `assetIds`). */
export async function listMissingInformation(accountId: number, opts: { assetIds?: number[] } = {}): Promise<AssetCompleteness[]> {
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const assets = (await pgClient.unsafe(
    `SELECT row_to_json(a.*) AS r FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
        AND ($2::int[] IS NULL OR a.id = ANY($2::int[]))
      ORDER BY a.name LIMIT 200`,
    [accountId, ids] as never[],
  )) as unknown as Array<{ r: AssetRowJson | string }>;
  if (assets.length === 0) return [];
  const rows = assets.map((x) => (typeof x.r === 'string' ? JSON.parse(x.r) : x.r) as AssetRowJson & { name: string });
  const actions = (await pgClient.unsafe(
    `SELECT public_id AS "publicId", question, target_id AS "assetId", field_key AS "fieldKey", action_kind AS "actionKind"
       FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'ASSET' AND resolved_at IS NULL AND target_id = ANY($2::int[])
      ORDER BY id`,
    [accountId, rows.map((r) => r.id)] as never[],
  )) as unknown as Array<{ publicId: string; question: string; assetId: number; fieldKey: string | null; actionKind: string }>;

  return rows.map((row) => {
    const family = toAssetFamily(row.category) ?? 'OBJECT';
    const mesActions = actions.filter((a) => Number(a.assetId) === Number(row.id));
    const parCle = new Map(mesActions.filter((a) => a.fieldKey).map((a) => [canonicalKeyOf(a.fieldKey!) ?? a.fieldKey!, a]));
    const missing = missingRequiredFields(row).map((m) => ({ ...m, toProcessPublicId: parCle.get(m.key)?.publicId ?? null }));
    const couverts = new Set(missing.map((m) => m.key));
    return {
      assetId: Number(row.id),
      assetName: row.name,
      family,
      missing,
      toProcess: mesActions
        .filter((a) => !a.fieldKey || !couverts.has(canonicalKeyOf(a.fieldKey) ?? a.fieldKey))
        .map((a) => ({ publicId: a.publicId, question: a.question, fieldKey: a.fieldKey, actionKind: a.actionKind })),
    };
  });
}
