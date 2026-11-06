/**
 * Chargement des entrées de l'état CIL (lot 111U) — lectures seules, bornées
 * au compte du bien (bien non supprimé). Périmètre documentaire = celui des
 * listes (`documentInAssetsCondition`, lot 32C) : colonnes historiques
 * `asset_id` / `linked_asset_id` et liens N-N ACTIFS PRIMARY / SECONDARY
 * (un bien seulement CITÉ n'en fait pas partie), documents ouverts (non
 * supprimés, non regroupés, dépôt terminé), ni brouillon ni ignorés.
 */
import { pgClient } from '@/db';
import { ASSET_LIST_LINK_ROLES_SQL } from '@/services/documents/asset-document-scope';
import { documentTitle } from '@/services/exports/v12/data/documents';
import type { CilStateInput } from './evaluate';

const RECONTROLE_MS = 5 * 60_000;
let schema: { ready: boolean; at: number } | null = null;

/** Colonnes / table de la migration 1300 présentes ? (relu toutes les 5 min tant qu'absentes). */
export async function cilProjectionSchemaReady(): Promise<boolean> {
  if (schema && (schema.ready || Date.now() - schema.at < RECONTROLE_MS)) return schema.ready;
  let ready = false;
  try {
    const rows = await pgClient.unsafe(`
      SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
                AND ((table_name = 'energy_materials' AND column_name IN ('origin', 'installation_state', 'source_file_id', 'projection_key', 'evidence'))
                  OR (table_name = 'equipment_cil_specs' AND column_name = 'field_origins')))::int AS cols,
             (SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'cil_projection_journal')::int AS tab`);
    const r = (rows as unknown as Array<{ cols: number; tab: number }>)[0];
    ready = r?.cols === 6 && r?.tab === 1;
  } catch { ready = false; }
  schema = { ready, at: Date.now() };
  return ready;
}

let schema2: { ready: boolean; at: number } | null = null;

/** Migration 1301 présente ? (`energy_materials.u_value`, provenance de `asset_cil_profiles`). */
export async function cilSecondPassSchemaReady(): Promise<boolean> {
  if (schema2 && (schema2.ready || Date.now() - schema2.at < RECONTROLE_MS)) return schema2.ready;
  let ready = false;
  try {
    const rows = await pgClient.unsafe(`
      SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema()
         AND ((table_name = 'energy_materials' AND column_name = 'u_value')
           OR (table_name = 'asset_cil_profiles' AND column_name IN ('origin', 'source_file_id', 'evidence')))`);
    ready = (rows as unknown as Array<{ n: number }>)[0]?.n === 4;
  } catch { ready = false; }
  schema2 = { ready, at: Date.now() };
  return ready;
}

/** Réservé aux tests. */
export function __resetCilSchemaForTests(): void { schema = null; schema2 = null; }

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[]): Promise<Row[]> => (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** SQL : documents ouverts du bien (alias `f`). `$1` = bien, `$2` = compte. */
export const CIL_DOCUMENT_SCOPE_SQL = `f.account_id = $2 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
  AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED' AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
  AND COALESCE(f.is_web_link, false) = false
  AND (f.asset_id = $1 OR f.linked_asset_id = $1
       OR f.id IN (SELECT dal.file_id FROM document_asset_links dal WHERE dal.asset_id = $1 AND dal.status = 'ACTIVE'
                    AND dal.link_role IN ${ASSET_LIST_LINK_ROLES_SQL}))`;

export interface CilAssetRef { id: number; accountId: number }

/**
 * Entrées de l'évaluation. `null` : bien introuvable pour ce compte (404).
 * Lève en cas d'erreur de base — l'appelant DOIT la présenter comme une
 * erreur (jamais comme un état « tout non renseigné »).
 */
export async function loadCilStateInput(ref: CilAssetRef): Promise<CilStateInput | null> {
  const [asset] = await q(`SELECT id, address, postal_code, city, subtype, category FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [ref.id, ref.accountId]);
  if (!asset) return null;
  const ready = await cilProjectionSchemaReady();
  const ready2 = await cilSecondPassSchemaReady();

  const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
  const [canon, profileRows, resolutions, docRows, matRows, eqRows, workRows, journalRows, evidence] = await Promise.all([
    getCanonicalAssetState(ref.id, ref.accountId),
    q(`SELECT trigger_type, to_char(trigger_date, 'YYYY-MM-DD') AS trigger_date, authorization_type
              ${ready2 ? ', origin, source_file_id' : ", 'USER' AS origin, NULL AS source_file_id"} FROM asset_cil_profiles WHERE asset_id = $1`, [ref.id]),
    q(`SELECT block_id, resolution, justification FROM cil_block_resolutions WHERE asset_id = $1`, [ref.id]),
    q(`SELECT f.id, f.document_type, f.document_type_code, f.retained_function_code, f.cil_rubric_codes, f.retained_title, f.original_filename,
              f.web_link_title, f.s3_key, to_char(f.document_date, 'YYYY-MM-DD') AS document_date, m.plan_state
         FROM asset_files f LEFT JOIN document_cil_metadata m ON m.asset_file_id = f.id
        WHERE ${CIL_DOCUMENT_SCOPE_SQL} ORDER BY f.id`, [ref.id, ref.accountId]),
    q(`SELECT id, category, material_nature, brand, reference, thermal_resistance_r, lambda, thickness_mm, surface_sqm, document_id
              ${ready ? ', origin, installation_state, source_file_id' : ", 'USER' AS origin, NULL AS installation_state, NULL AS source_file_id"}
              ${ready2 ? ', u_value' : ', NULL AS u_value'}
         FROM energy_materials WHERE asset_id = $1 ORDER BY id`, [ref.id]),
    q(`SELECT e.id, e.name, e.type, e.category, e.energy_usage, s.brand, s.model, s.energy_type, s.evacuation_mode,
              s.heat_network_delivery_station, s.power_kw ${ready ? ', s.field_origins' : ", '{}'::jsonb AS field_origins"}
         FROM equipments e LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id
        WHERE e.asset_id = $1 AND e.archived_at IS NULL ORDER BY e.id`, [ref.id]),
    q(`SELECT id, title, category, to_char(completed_at, 'YYYY-MM-DD') AS completed_at, company_name FROM energy_works WHERE asset_id = $1 ORDER BY completed_at NULLS LAST, id`, [ref.id]),
    ready ? q(`SELECT projection_key, status, reason, source_file_ids, target_id, detail FROM cil_projection_journal WHERE asset_id = $1 AND account_id = $2`, [ref.id, ref.accountId]) : Promise.resolve([] as Row[]),
    // Preuve documentaire principale des champs du bien lus par le CIL (autorité décroissante, puis la plus récente).
    q(`SELECT DISTINCT ON (field_key) field_key, source_id, source_location
         FROM field_evidence WHERE asset_id = $1 AND account_id = $2 AND status = 'active' AND source_type = 'document'
          AND field_key = ANY($3::text[])
        ORDER BY field_key, authority_score DESC, extracted_at DESC`,
    [ref.id, ref.accountId, ['dpeClass', 'gesClass', 'dpeDate', 'energyConsumption', 'gesEmissions', 'dpeAdemeNumber', 'dpeExpiryDate', 'livingArea', 'constructionYear']]),
  ]);

  const fields: CilStateInput['fields'] = {};
  for (const [k, st] of Object.entries(canon?.fields ?? {})) fields[k] = { value: st.value, origin: st.origin ?? null };
  const fieldSources: CilStateInput['fieldSources'] = {};
  for (const e of evidence) {
    const loc = (e.source_location ?? {}) as { page?: unknown };
    fieldSources[String(e.field_key)] = { fileId: Number(e.source_id), page: n(loc.page) };
  }

  // B7 : Opérations d'intervention qualifiées « travaux énergétiques réalisés » par la projection (journal).
  const workKeys = journalRows.filter((j) => String(j.projection_key).startsWith('cil:work:') && ['WRITTEN', 'UNCHANGED'].includes(String(j.status)));
  const opIds = workKeys.map((j) => Number(j.target_id)).filter((x) => Number.isSafeInteger(x));
  const opRows = opIds.length ? await q(`
    SELECT o.id::int AS id, o.technical_label, o.provider, to_char(o.realized_date, 'YYYY-MM-DD') AS realized
      FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) AND o.status = 'REALIZED' AND o.invalidated_at IS NULL`,
  [ref.accountId, `{${opIds.join(',')}}`]) : [];
  const opWorks: CilStateInput['opWorks'] = opRows.map((o) => {
    const j = workKeys.find((x) => Number(x.target_id) === Number(o.id))!;
    const detail = (j.detail ?? {}) as { categories?: string[] };
    return {
      operationId: Number(o.id), title: (o.technical_label as string) ?? null, provider: (o.provider as string) ?? null, realizedDate: (o.realized as string) ?? null,
      categories: detail.categories ?? [], fileIds: Array.isArray(j.source_file_ids) ? (j.source_file_ids as unknown[]).map(Number) : [],
    };
  });

  const p = profileRows[0];
  return {
    asset: { id: ref.id, address: (asset.address as string) ?? null, postalCode: (asset.postal_code as string) ?? null, city: (asset.city as string) ?? null, subtype: (asset.subtype as string) ?? null },
    fields,
    fieldSources,
    profile: p ? {
      triggerType: String(p.trigger_type ?? 'inconnu'), triggerDate: (p.trigger_date as string) ?? null,
      authorizationType: (p.authorization_type as string) ?? null, origin: String(p.origin ?? 'USER'), sourceFileId: n(p.source_file_id),
    } : null,
    opWorks,
    resolutions: resolutions.map((r) => ({ blockId: String(r.block_id), resolution: String(r.resolution), justification: (r.justification as string) ?? null })),
    documents: docRows.map((d) => ({
      id: Number(d.id),
      title: documentTitle({ id: Number(d.id), retainedTitle: d.retained_title as string | null, originalFilename: d.original_filename as string | null, webLinkTitle: d.web_link_title as string | null, s3Key: d.s3_key as string | null }),
      date: (d.document_date as string) ?? null,
      documentType: (d.document_type as string) ?? null,
      documentTypeCode: (d.document_type_code as string) ?? null,
      retainedFunctionCode: (d.retained_function_code as string) ?? null,
      cilRubricCodes: Array.isArray(d.cil_rubric_codes) ? (d.cil_rubric_codes as string[]) : typeof d.cil_rubric_codes === 'string' ? safeArray(d.cil_rubric_codes) : null,
      planState: (d.plan_state as string) ?? null,
    })),
    materials: matRows.map((m) => ({
      id: Number(m.id), category: String(m.category), materialNature: (m.material_nature as string) ?? null, brand: (m.brand as string) ?? null,
      reference: (m.reference as string) ?? null, thermalResistanceR: n(m.thermal_resistance_r), lambda: n(m.lambda), thicknessMm: n(m.thickness_mm),
      surfaceSqm: n(m.surface_sqm), origin: String(m.origin ?? 'USER'), installationState: (m.installation_state as string) ?? null,
      sourceFileId: n(m.source_file_id), documentId: n(m.document_id), uValue: n(m.u_value),
    })),
    equipments: eqRows.map((e) => ({
      id: Number(e.id), name: String(e.name), type: (e.type as string) ?? null, category: (e.category as string) ?? null, energyUsage: (e.energy_usage as string) ?? null,
      brand: (e.brand as string) ?? null, model: (e.model as string) ?? null, energyType: (e.energy_type as string) ?? null,
      evacuationMode: (e.evacuation_mode as string) ?? null, heatNetworkDeliveryStation: (e.heat_network_delivery_station as string) ?? null,
      powerKw: n(e.power_kw), fieldOrigins: (e.field_origins as Record<string, string>) ?? {},
    })),
    works: workRows.map((w) => ({ id: Number(w.id), title: String(w.title), category: String(w.category), completedAt: iso(w.completed_at), companyName: (w.company_name as string) ?? null })),
    journal: journalRows.map((j) => ({
      projectionKey: String(j.projection_key), status: String(j.status), reason: (j.reason as string) ?? null,
      sourceFileIds: Array.isArray(j.source_file_ids) ? (j.source_file_ids as unknown[]).map(Number) : [], targetId: n(j.target_id),
    })),
  };
}

function safeArray(v: unknown): string[] | null {
  try { const a = JSON.parse(String(v)); return Array.isArray(a) ? a.map(String) : null; } catch { return null; }
}
