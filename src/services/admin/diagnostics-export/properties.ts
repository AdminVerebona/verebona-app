/**
 * Lot 88A — diagnostic global : TRAÇABILITÉ PAR PROPRIÉTÉ et projection
 * API → écran. Serveur uniquement.
 *
 * Pour chaque bien du compte et chaque propriété (champ) — qu'elle soit
 * affichée, renvoyée par l'API, persistée, ou seulement citée par une
 * preuve, une décision, un conflit ou une écriture — une entrée réunit la
 * chaîne complète :
 *
 *   valeur affichée ← valeur renvoyée par l'API (même fonction que la route :
 *   `buildSections`) ← valeur persistée (fiche, colonne de repli, vue
 *   canonique, origine, verrou) ← écritures (avant / après, résultat) et
 *   lignes de rapport (écrite / non écrite et motif) ← décisions T3 (action,
 *   motif, preuves citées) et conflits ← preuves (candidates : document,
 *   page, extrait, confiance, cycle de vie) ← faits T1 ← extractions ←
 *   documents ← traitements (rapports, file, appels).
 *
 * Un verdict distingue un problème de DONNÉE (vide en base), de BACKEND
 * (persisté mais non renvoyé) ou d'AFFICHAGE (renvoyé mais non affiché,
 * attendu par l'écran mais non renvoyé). Aucun développement propre à un
 * champ : le prix d'achat n'est qu'un cas du principe général.
 */
import type { DiagPlanKit } from './account';
import {
  DETAILS_UI_COMPONENT, DETAILS_UI_COMMON_FIELDS, DETAILS_UI_FAMILY_SECTIONS, DETAILS_UI_ROUTE, DETAILS_UI_SECTION_FIELDS, DETAILS_UI_SECTION_LABELS,
  detailsUiFieldFor, detailsUiFields, type DetailsUiFamily,
} from '@/lib/assets/details-ui-map';

type Row = Record<string, unknown>;

const KC_META = /__(origin|updatedAt|source|sourceUnit|userValidated|evidenceId|confidence)$/;
const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const N = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Colonnes de repli lues par `buildSections` quand la clé de fiche est vide. */
const COLUMN_FALLBACKS: Readonly<Record<string, string>> = {
  acquisitionPrice: 'purchase_price_cents (÷ 100)', acquisitionDate: 'purchase_date', acquisitionLocation: 'purchase_location', notes: 'notes',
  address1: 'address', postalCode: 'postal_code', city: 'city', generalCondition: 'general_condition', registrationNumber: 'registration_number',
  engine: 'engine_info', mileage: 'mileage_or_hours', objectCategory: 'object_category', condition: 'general_condition', dimensions: 'dimensions',
  name: 'name', subCategory: 'subtype',
};

export type PropertyVerdict = 'VIDE_EN_BASE' | 'PERSISTE_NON_RENVOYE' | 'RENVOYE_NON_AFFICHE' | 'ATTENDU_PAR_ECRAN_NON_RENVOYE' | 'NON_EXPOSE_PAR_LA_FICHE' | 'API_INDISPONIBLE' | 'COHERENT';

/**
 * Verdict d'une propriété (pur). `uiExpects` : un champ de l'écran lit cette
 * clé dans une section de la réponse ; `uiConsumed` : il la lit dans une
 * section qui la REÇOIT (sinon il s'affiche vide).
 */
export function propertyVerdict(p: { persisted: unknown; apiStatus: number; apiSent: boolean; apiValue: unknown; uiExpects: boolean; uiConsumed: boolean }): PropertyVerdict {
  if (p.apiStatus !== 200) return 'API_INDISPONIBLE';
  if (!p.apiSent && p.uiExpects) return 'ATTENDU_PAR_ECRAN_NON_RENVOYE';
  if (!p.apiSent) return empty(p.persisted) ? 'VIDE_EN_BASE' : 'NON_EXPOSE_PAR_LA_FICHE';
  if (empty(p.apiValue)) return empty(p.persisted) ? 'VIDE_EN_BASE' : 'PERSISTE_NON_RENVOYE';
  if (!p.uiConsumed) return 'RENVOYE_NON_AFFICHE';
  return 'COHERENT';
}

/**
 * Lot 89B : correspondance API → écran d'UNE propriété (pur) — section qui la
 * renvoie, champs d'écran qui la lisent, et s'ils la lisent dans une section
 * qui la REÇOIT. Même calcul pour le diagnostic et le test générique de toutes
 * les familles (`l89b-details-sections.test.ts`).
 */
export function apiUiMatch(sections: Record<string, Record<string, unknown>>, uiFamily: DetailsUiFamily, champ: string) {
  const sec = Object.entries(sections).find(([, d]) => champ in d);
  const consumers = Object.keys(sections).map((section) => detailsUiFieldFor(uiFamily, section, champ)).filter(Boolean) as Array<NonNullable<ReturnType<typeof detailsUiFieldFor>>>;
  return {
    section: sec?.[0] ?? null,
    apiSent: !!sec,
    apiValue: sec ? sec[1][champ] : null,
    consumers,
    uiExpects: consumers.length > 0,
    uiConsumed: consumers.some((c) => champ in (sections[c.section] ?? {})),
  };
}

/** Ligne `assets` (JSON) → objet de ligne Drizzle (mêmes conversions que la route). */
async function drizzleAssetRow(json: Row): Promise<Record<string, unknown>> {
  const { getTableColumns } = await import('drizzle-orm');
  const { assets } = await import('@/db/schema');
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(getTableColumns(assets))) {
    const raw = json[col.name];
    let v: unknown = raw ?? null;
    if (raw !== null && raw !== undefined && typeof (col as { mapFromDriverValue?: unknown }).mapFromDriverValue === 'function') {
      try { v = (col as unknown as { mapFromDriverValue: (x: unknown) => unknown }).mapFromDriverValue(raw); } catch { v = raw; }
    }
    out[k] = v;
  }
  return out;
}

interface ApiProjection {
  status: number;
  motif: string | null;
  family: string;
  uiFamily: DetailsUiFamily;
  sections: Record<string, Record<string, unknown>>;
}

/** Réponse de `GET /api/assets/[id]/details` pour cette ligne, par la même fonction que la route. */
async function projectApi(json: Row): Promise<ApiProjection> {
  const { toExportFamily } = await import('@/services/exports/catalog');
  const { buildSections } = await import('@/services/assets/details-sections');
  const { buildCanonicalAssetState } = await import('@/services/canonical/asset-state/canonical-asset-view');
  const category = String(json.category ?? '');
  const family = toExportFamily(category) ?? 'OBJET';
  const uiFamily: DetailsUiFamily = category === 'IMMOBILIER' || category === 'VEHICULE' ? category : 'OBJET';
  if (json.deleted_at) return { status: 404, motif: 'bien supprimé : la route répond 404 (NOT_FOUND)', family, uiFamily, sections: {} };
  if (json.status === 'ARCHIVED' || (json.lock_state && json.lock_state !== 'NONE')) {
    return { status: 403, motif: `bien ${json.status === 'ARCHIVED' ? 'archivé' : 'verrouillé par l’offre'} : la route répond 403 (ASSET_UNAVAILABLE), l’écran n’affiche aucune valeur`, family, uiFamily, sections: {} };
  }
  let kc: Record<string, unknown> = {};
  try { kc = json.key_characteristics ? JSON.parse(String(json.key_characteristics)) as Record<string, unknown> : {}; } catch { kc = {}; }
  const row = await drizzleAssetRow(json);
  let adresse = null;
  if (family === 'IMMOBILIER') {
    const f = buildCanonicalAssetState(json as never).fields;
    adresse = { address1: f.address1?.value ?? null, postalCode: f.postalCode?.value ?? null, city: f.city?.value ?? null };
  }
  // Sérialisation JSON comme `NextResponse.json` (dates en ISO, undefined retirés).
  const sections = JSON.parse(JSON.stringify(buildSections(family, kc, row, adresse))) as Record<string, Record<string, unknown>>;
  return { status: 200, motif: null, family, uiFamily, sections };
}

/** Fichiers de traçabilité des propriétés et de projection API → écran. */
export async function planPropertyFiles(kit: DiagPlanKit): Promise<void> {
  const { s, A } = kit;
  const assetIds = (await s.q(`SELECT id FROM assets WHERE account_id = $1 ORDER BY id`, [A])).map((r) => Number(r.id));
  const sensitive = (k: string) => kit.isSensitiveKey(k);
  const maskValue = (k: string, v: unknown) => (sensitive(k) && !empty(v) ? { $etat: 'masque', motif: 'donnée sensible (registre)' } : v);

  kit.entry('api-ui/correspondance-champs.json', `Table de correspondance champ API → composant d’écran (src/lib/assets/details-ui-map.ts) : route ${DETAILS_UI_ROUTE}, composant ${DETAILS_UI_COMPONENT}`, async (w) => {
    await w(`${JSON.stringify({ route: DETAILS_UI_ROUTE, composant: DETAILS_UI_COMPONENT, regle: 'Chaque section de la réponse API est rendue avec SES champs, lus dans sections[section][champ] ; un champ défini pour une section qui ne le reçoit pas s’affiche vide.', sections: DETAILS_UI_SECTION_LABELS, sectionsParFamille: DETAILS_UI_FAMILY_SECTIONS, champsCommuns: DETAILS_UI_COMMON_FIELDS, champsParSection: DETAILS_UI_SECTION_FIELDS }, null, 2)}\n`);
    return { expected: null, batches: 1, error: null };
  }, undefined, 'api-ui');

  // Cache par bien, partagé entre les deux fichiers (lu une fois, libéré ensuite).
  const projections = new Map<number, { json: Row | null; api: ApiProjection | null; error: string | null }>();
  const load = async (id: number) => {
    if (projections.has(id)) return projections.get(id)!;
    let out: { json: Row | null; api: ApiProjection | null; error: string | null };
    try {
      const [r] = await s.savepoint(() => s.q(`SELECT row_to_json(a.*) AS r FROM assets a WHERE a.id = $1 AND a.account_id = $2`, [id, A]));
      const json = r ? (typeof r.r === 'string' ? JSON.parse(r.r) as Row : r.r as Row) : null;
      out = { json, api: json ? await projectApi(json) : null, error: null };
    } catch (e) {
      if ((e as { code?: string })?.code === '25006') throw e;
      out = { json: null, api: null, error: (e as Error)?.message ?? String(e) };
    }
    projections.set(id, out);
    return out;
  };

  kit.entry('api-ui/fiches.json', `Réponse de ${DETAILS_UI_ROUTE} recalculée pour chaque bien par la même fonction que la route (buildSections), et champs rendus par l’écran avec leur valeur`, async (w) => {
    await w('[');
    let n = 0;
    const errors: string[] = [];
    for (const id of assetIds) {
      const p = await load(id);
      if (p.error || !p.api) { errors.push(`bien #${id} : ${p.error ?? 'introuvable'}`); continue; }
      const api = p.api;
      const ecran = Object.entries(api.sections).map(([section, data]) => ({
        section, libelle: DETAILS_UI_SECTION_LABELS[section] ?? section,
        champs: detailsUiFields(api.uiFamily, section).map((f) => ({ champ: f.key, libelle: f.label, condition: f.condition ?? null, valeurLue: maskValue(f.key, data[f.key] ?? null), recuDeLApi: f.key in data })),
        renvoyesNonAffiches: Object.keys(data).filter((k) => !detailsUiFields(api.uiFamily, section).some((f) => f.key === k)),
      }));
      const fiche = { bien: id, http: api.status, motif: api.motif, famille: api.family, familleEcran: api.uiFamily, reponseApi: { family: api.family, sections: Object.fromEntries(Object.entries(api.sections).map(([k, d]) => [k, Object.fromEntries(Object.entries(d).map(([f, v]) => [f, maskValue(f, v)]))])) }, ecran };
      await w(`${n++ ? ',' : ''}\n  ${kit.safeJson(kit.M(fiche))}`);
    }
    await w(`${n ? '\n' : ''}]\n`);
    return { expected: assetIds.length, count: n, batches: 1, error: errors.length ? errors.join(' ; ') : null };
  }, undefined, 'api-ui');

  kit.entry('tracabilite/proprietes.json', 'Chaîne de chaque propriété (bien × champ) : affichage ← API ← persistance ← écritures ← décisions / conflits ← preuves (candidates) ← faits ← extractions ← documents ← traitements ; verdict donnée / backend / affichage', async (w) => {
    await w('[');
    let n = 0;
    let biens = 0;
    const errors: string[] = [];
    for (const id of assetIds) {
      try {
        const entries = await s.savepoint(() => propertyEntries(kit, id, load));
        for (const e of entries) await w(`${n++ ? ',' : ''}\n  ${kit.safeJson(kit.M(e))}`);
        biens++;
      } catch (e) {
        if ((e as { code?: string })?.code === '25006' || (e as Error)?.name === 'SinkError') throw e;
        errors.push(`bien #${id} : ${(e as Error)?.message ?? String(e)}`);
      }
      projections.delete(id);
    }
    await w(`${n ? '\n' : ''}]\n`);
    return { expected: assetIds.length, count: biens, batches: 1, error: errors.length ? errors.join(' ; ') : null };
  }, undefined, 'tracabilite');
}

const group = (rows: Row[], keys: (r: Row) => Array<unknown>): Map<string, Row[]> => {
  const m = new Map<string, Row[]>();
  for (const r of rows) for (const k of new Set(keys(r).filter((x) => x !== null && x !== undefined && x !== '').map(String))) {
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
};

/** Entrées de traçabilité d'un bien (toutes ses propriétés). */
async function propertyEntries(kit: DiagPlanKit, assetId: number, load: (id: number) => Promise<{ json: Row | null; api: ApiProjection | null; error: string | null }>): Promise<Row[]> {
  const { s, A } = kit;
  const maskValue = (k: string, v: unknown) => (kit.isSensitiveKey(k) && !empty(v) ? { $etat: 'masque', motif: 'donnée sensible (registre)' } : v);
  const p = await load(assetId);
  const json = p.json ?? {};
  let kc: Record<string, unknown> = {};
  try { kc = json.key_characteristics ? JSON.parse(String(json.key_characteristics)) as Record<string, unknown> : {}; } catch { kc = {}; }
  // Lignes au format JSON de PostgreSQL (row_to_json) : mêmes types que les fichiers `compte/` (identifiants bigint en nombres).
  const q = async (sql: string, params: unknown[] = [A, assetId]): Promise<Row[]> =>
    (await s.q(`SELECT row_to_json(x) AS r FROM (${sql}) x`, params)).map((r) => (typeof r.r === 'string' ? JSON.parse(r.r) as Row : r.r as Row));

  const evidences = await q(`SELECT id, field_key, canonical_key, value_json, normalized_value, raw_value, source_type, source_id, source_version, source_location, evidence_excerpt,
         evidence_origin, confidence, authority_score, status, lifecycle_status, superseded_at, superseded_by_evidence_id, analysis_run_id, operation_trace_id,
         provider, model, prompt_version, document_type, document_date, extracted_at, target_type, target_entity_id
    FROM field_evidence WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
  const decisions = await q(`SELECT d.id, d.run_id, d.field_key, d.action, d.reason_code, d.confidence, d.deterministic, d.evidence_ids, d.source_priority, d.created_at,
         r.triggered_by, r.trace_id::text AS run_trace_id, r.status AS run_status, r.shadow
    FROM reconciliation_decisions d LEFT JOIN reconciliation_runs r ON r.id = d.run_id AND r.account_id = d.account_id
   WHERE d.account_id = $1 AND d.asset_id = $2 ORDER BY d.id`);
  const conflicts = await q(`SELECT id, field_key, current_value, proposed_value, source_type, source_detail, inconsistency_type, status, resolution, resolved_at, resolved_by,
         current_evidence_ids, proposed_evidence_ids, authority_rule, decision_mode, reason_code, current_origin, operation_trace_id::text AS operation_trace_id, created_at, updated_at
    FROM inconsistency_registry WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
  const writes = await q(`SELECT id, canonical_key, old_value, new_value, origin, actor_user_id, source_type, source_id, trace_id, outcome, dry_run, divergence, mirror_columns, created_at, target_type, target_id
    FROM canonical_field_writes WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
  const aiUpdates = await q(`SELECT id, field_key, old_value, new_value, evidence_id, decision_type, reason_code, provider, model, prompt_version, confidence, asset_file_id, reverted_at, reverted_by, target_type, target_id, created_at
    FROM ai_field_updates WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
  // Lot 88B : reprises de propriétés manquantes (décision T3 écrite ou abstention motivée).
  const recoveries = (await q(`SELECT to_regclass('public.property_recovery_decisions') IS NOT NULL AS ok`, []))[0]?.ok
    ? await q(`SELECT id, run_id, object_type, object_id, field_key, decision, cause, value_before, value_after, proposed_value, findings, rejected, evidence_ids, provenance, write_outcome, prompt_version, context_fp, created_at
    FROM property_recovery_decisions WHERE account_id = $1 AND asset_id = $2 ORDER BY id`)
    : [];
  const docIds = [...new Set([
    ...(await q(`SELECT id FROM asset_files WHERE account_id = $1 AND (asset_id = $2 OR linked_asset_id = $2)
                 UNION SELECT file_id FROM document_asset_links WHERE account_id = $1 AND asset_id = $2`)).map((r) => Number(r.id)),
    ...evidences.filter((e) => /^(document|file|asset_file)$/i.test(String(e.source_type ?? ''))).map((e) => Number(e.source_id)),
  ].filter((x) => Number.isSafeInteger(x) && x > 0))].sort((a, b) => a - b);
  const docs = docIds.length ? await q(`SELECT id, retained_title, document_date, analysis_state, deleted_at FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[]) ORDER BY id`, [A, docIds]) : [];
  const facts = docIds.length ? await q(`SELECT id, file_id, extraction_id, fact_key, canonical_key, raw_key, label, value_text, value_number, value_unit, value_json, normalized_value, raw_value,
         confidence, excerpt, location, source_unit_ids, status, target_type, target_entity_id, provider, model, prompt_version, created_at
    FROM document_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND canonical_key IS NOT NULL ORDER BY id`, [A, docIds]) : [];
  const extractions = docIds.length ? await q(`SELECT id, file_id, analysis_run_id, provider, model, prompt_version, operation_trace_id, document_type_code, fact_count, extracted_at
    FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[]) ORDER BY id`, [A, docIds]) : [];
  const reports = await q(`SELECT id, treatment, status, job_id, file_id, asset_id, extraction_id, reconciliation_run_id, trace_ids, counters, created_at
    FROM ai_execution_reports WHERE account_id = $1 AND (asset_id = $2 OR file_id = ANY($3::int[])) ORDER BY id`, [A, assetId, docIds]);
  const reportIds = reports.map((r) => Number(r.id));
  const entries = reportIds.length ? await q(`SELECT r.id AS report_id, r.treatment, r.reconciliation_run_id, e.seq, e.section, e.field_key, e.entity_type, e.entity_id, e.old_value, e.value,
         e.write_result, e.reason_code, e.reason, e.record_status, e.table_name, e.record_id
    FROM ai_execution_reports r JOIN ai_execution_report_entries e ON e.account_id = r.account_id AND e.report_id = coalesce(r.entries_report_id, r.id)
   WHERE r.account_id = $1 AND r.id = ANY($2::bigint[]) AND e.field_key IS NOT NULL AND e.section IN ('FIELD', 'PROJECTION', 'NOT_EXAMINED', 'DECLARED')
   ORDER BY r.id, e.seq`, [A, reportIds]) : [];
  const jobIds = [...new Set(reports.map((r) => N(r.job_id)).filter((x): x is number => x !== null))];

  // Cible d'une ligne : le bien lui-même (ASSET) ou un objet du bien (équipement, Pièce).
  const target = (t: unknown, id: unknown) => (t && String(t).toUpperCase() !== 'ASSET' && id != null ? `${String(t).toUpperCase()}#${id}` : `ASSET#${assetId}`);
  const key = (cible: string, champ: string) => `${cible}|${champ}`;
  const evBy = group(evidences, (e) => [key(target(e.target_type, e.target_entity_id), String(e.field_key)), ...(e.canonical_key && e.canonical_key !== e.field_key ? [key(target(e.target_type, e.target_entity_id), String(e.canonical_key))] : [])]);
  const decBy = group(decisions, (d) => [key(`ASSET#${assetId}`, String(d.field_key))]);
  const conBy = group(conflicts, (c) => [key(`ASSET#${assetId}`, String(c.field_key))]);
  const wrBy = group(writes, (x) => [key(target(x.target_type, x.target_id), String(x.canonical_key))]);
  const recBy = group(recoveries, (x) => [key(target(x.object_type, x.object_id), String(x.field_key))]);
  const aiBy = group(aiUpdates, (x) => [key(target(x.target_type, x.target_id), String(x.field_key))]);
  const repBy = group(entries.filter((e) => e.section !== 'DECLARED' || e.entity_type == null || String(e.entity_type).toUpperCase() === 'ASSET'), (e) => [key(target(e.entity_type, e.entity_type && String(e.entity_type).toUpperCase() !== 'ASSET' ? e.entity_id : null), String(e.field_key))]);
  const factsBy = group(facts, (f) => [String(f.canonical_key)]);

  const api = p.api;
  const self = `ASSET#${assetId}`;
  const keys = new Set<string>();
  if (api) for (const [section, data] of Object.entries(api.sections)) {
    for (const k of Object.keys(data)) keys.add(key(self, k));
    for (const f of detailsUiFields(api.uiFamily, section)) keys.add(key(self, f.key));
  }
  for (const k of Object.keys(kc)) if (!KC_META.test(k)) keys.add(key(self, k));
  for (const m of [evBy, decBy, conBy, wrBy, aiBy, repBy, recBy]) for (const k of m.keys()) keys.add(k);

  const docById = new Map(docs.map((d) => [Number(d.id), d]));
  const out: Row[] = [];
  for (const k of [...keys].sort()) {
    const [cible, champ] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    const isSelf = cible === self;
    const ev = evBy.get(k) ?? [];
    const dec = decBy.get(k) ?? [];
    const con = conBy.get(k) ?? [];
    const wr = wrBy.get(k) ?? [];
    const ai = aiBy.get(k) ?? [];
    const rep = repBy.get(k) ?? [];
    const rec = recBy.get(k) ?? [];
    const fa = isSelf ? (factsBy.get(champ) ?? []) : [];
    // API / écran.
    let apiPart: Row | null = null;
    let uiPart: Row | null = null;
    let apiSent = false;
    let apiValue: unknown = null;
    let uiConsumed = false;
    let uiExpects = false;
    if (isSelf && api) {
      const m = apiUiMatch(api.sections, api.uiFamily, champ);
      const sec = m.section;
      const consumers = m.consumers;
      apiSent = m.apiSent;
      apiValue = m.apiValue;
      apiPart = { route: DETAILS_UI_ROUTE, http: api.status, motif: api.motif, section: sec, renvoye: apiSent, valeur: maskValue(champ, apiValue) };
      uiExpects = m.uiExpects;
      uiConsumed = m.uiConsumed;
      uiPart = consumers.length
        ? {
          composant: DETAILS_UI_COMPONENT,
          champs: consumers.map((c) => ({ section: c.section, sectionLibelle: c.sectionLabel, libelle: c.label, condition: c.condition ?? null, valeurLue: maskValue(champ, api.sections[c.section]?.[champ] ?? null), recuDeLApi: champ in (api.sections[c.section] ?? {}) })),
          ...(apiSent && !uiConsumed ? { motif: `renvoyé dans la section « ${sec} » mais lu par l’écran dans une autre section (${consumers.map((c) => c.section).join(', ')}) : affiché vide` } : {}),
        }
        : { composant: null, motif: apiSent ? 'renvoyé par l’API mais lu par aucun champ de l’écran' : 'non affiché par la fiche' };
    }
    const persistedKc = isSelf ? kc[champ] : undefined;
    const meta: Row = {};
    if (isSelf) for (const m of ['origin', 'updatedAt', 'source', 'sourceUnit', 'userValidated', 'evidenceId', 'confidence']) if (kc[`${champ}__${m}`] !== undefined) meta[m] = kc[`${champ}__${m}`];
    const colonne = isSelf && COLUMN_FALLBACKS[champ] ? { colonne: COLUMN_FALLBACKS[champ], valeur: maskValue(champ, json[COLUMN_FALLBACKS[champ].split(' ')[0]] ?? null) } : null;
    let canonique: unknown = null;
    if (isSelf && p.json) {
      try {
        const { readCanonicalValue } = await import('@/services/canonical/asset-state/canonical-asset-view');
        const st = readCanonicalValue(p.json as never, champ);
        canonique = st ? { valeur: maskValue(champ, st.value), origine: st.origin, lu: st.from, misAJour: st.updatedAt } : null;
      } catch { canonique = null; }
    }
    const persisted = !empty(persistedKc) ? persistedKc : (colonne && !empty(colonne.valeur) ? colonne.valeur : null);
    const verdict = isSelf && api ? propertyVerdict({ persisted, apiStatus: api.status, apiSent, apiValue, uiExpects, uiConsumed }) : null;
    // Écritures corrélées aux décisions : même trace de passage, même champ ; lignes FIELD du rapport du passage.
    const decisionsOut = dec.map((d) => ({
      ...d,
      ecrituresCorrelees: wr.filter((x) => d.run_trace_id && String(x.trace_id ?? '') === String(d.run_trace_id)).map((x) => x.id),
      resultatRapport: rep.filter((e) => e.section === 'FIELD' && N(e.reconciliation_run_id) === N(d.run_id)).map((e) => ({ rapport: e.report_id, seq: e.seq, ecriture: e.write_result, motif: e.reason_code, detail: e.reason })),
    }));
    const evFiles = new Set(ev.map((e) => (/^(document|file|asset_file)$/i.test(String(e.source_type ?? '')) ? Number(e.source_id) : null)).filter((x): x is number => x !== null));
    const factFiles = new Set(fa.map((f) => Number(f.file_id)));
    const fileIds = [...new Set([...evFiles, ...factFiles])].sort((a, b) => a - b);
    const ex = extractions.filter((x) => fileIds.includes(Number(x.file_id)));
    out.push({
      bien: assetId, cible, champ, verdict,
      affichage: uiPart, api: apiPart,
      persiste: isSelf ? { fiche: { cle: `key_characteristics.${champ}`, valeur: maskValue(champ, persistedKc ?? null), meta, verrouUtilisateur: meta.userValidated === true || meta.origin === 'USER' }, colonne, canonique } : { motif: 'propriété d’un objet du bien : valeur dans compte/etat-metier (équipements, Pièces)' },
      ecritures: wr, ecrituresRapport: rep.map((e) => ({ ...e, value: maskValue(champ, e.value), old_value: maskValue(champ, e.old_value) })), misesAJourIA: ai,
      decisions: decisionsOut, conflits: con,
      reprisesProprieteManquante: rec.map((r) => ({ ...r, value_before: maskValue(champ, r.value_before), value_after: maskValue(champ, r.value_after), proposed_value: maskValue(champ, r.proposed_value) })),
      preuves: ev.map((e) => ({ ...e, document: /^(document|file|asset_file)$/i.test(String(e.source_type ?? '')) ? N(e.source_id) : null, page: (e.source_location as Row | null)?.page ?? null })),
      faits: fa.map((f) => ({ ...f, projeteEnPreuve: ev.some((e) => Number(e.source_id) === Number(f.file_id)) })),
      extractions: ex.map((x) => ({ id: x.id, document: x.file_id, analyse: x.analysis_run_id, modele: x.model, versionPrompt: x.prompt_version, trace: x.operation_trace_id, faits: x.fact_count, extraitLe: x.extracted_at })),
      documents: fileIds.map((f) => docById.get(f) ?? { id: f, motif: 'document absent du compte (supprimé définitivement ?)' }),
      traitements: {
        rapports: reports.filter((r) => fileIds.includes(Number(r.file_id)) || (N(r.asset_id) === assetId && r.treatment === 'T3')).map((r) => ({ id: r.id, traitement: r.treatment, statut: r.status, job: r.job_id, document: r.file_id, passageT3: r.reconciliation_run_id, traces: r.trace_ids, creeLe: r.created_at })),
        jobs: jobIds,
      },
    });
  }
  return out;
}
