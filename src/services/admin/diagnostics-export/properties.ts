/**
 * Lots 88A, 91A — diagnostic : TRAÇABILITÉ PAR PROPRIÉTÉ et projection
 * API → écran. Serveur uniquement.
 *
 * Lot 91A : pour CHAQUE bien du filtre — tous les biens de tous les comptes
 * au périmètre « Ensemble de l'application » — et chaque propriété (champ) — qu'elle soit
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
 *
 * Lot 113Q (#714, MEMORY_GUARD à l'étape TRACABILITE sur
 * tracabilite/proprietes.json, 878 Mo) — AVANT : pour chaque bien, toutes
 * ses preuves, décisions, conflits, écritures, mises à jour IA, reprises,
 * faits, extractions, rapports et lignes de rapport étaient chargés EN
 * ENTIER, regroupés, puis le tableau COMPLET de ses propriétés construit
 * avant écriture — « un bien à la fois » ne bornait rien pour un bien à long
 * historique ; et chaque propriété RECOPIAIT les lignes qu'elle citait (tous
 * les rapports T3 du bien dans chacune). MAINTENANT :
 *   · chaque ligne détaillée est exportée UNE fois, par curseur, dans
 *     `tracabilite/proprietes/*.json` (`PROPERTY_DETAIL_FILES`) ;
 *   · la chaîne est lue → transformée → écrite PROPRIÉTÉ PAR PROPRIÉTÉ
 *     (curseurs triés par bien et clé, colonnes de corrélation seulement) ;
 *     elle cite les lignes par identifiant stable (`refs`) — mêmes relations
 *     qu'avant, rien de supprimé (`expandPropertyChain` redonne la forme
 *     développée) ; découpée en parties de DIAG_PROPERTY_ASSETS_PER_PART biens.
 */
import { named } from '@/services/admin/account-data/session';
import type { DiagPlanKit } from './engine';
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

type PropertyVerdict = 'VIDE_EN_BASE' | 'PERSISTE_NON_RENVOYE' | 'RENVOYE_NON_AFFICHE' | 'ATTENDU_PAR_ECRAN_NON_RENVOYE' | 'NON_EXPOSE_PAR_LA_FICHE' | 'API_INDISPONIBLE' | 'COHERENT';

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

type Projection = { json: Row | null; api: ApiProjection | null; error: string | null };

/** Projection d'un bien (ligne persistée + réponse API recalculée), dans la session. */
async function loadProjection(kit: DiagPlanKit, id: number, A: number): Promise<Projection> {
  const { s } = kit;
  try {
    const [r] = await s.savepoint(() => s.q(`SELECT row_to_json(a.*) AS r FROM assets a WHERE a.id = $1 AND a.account_id = $2`, [id, A]));
    const json = r ? (typeof r.r === 'string' ? JSON.parse(r.r) as Row : r.r as Row) : null;
    return { json, api: json ? await projectApi(json) : null, error: null };
  } catch (e) {
    if ((e as { code?: string })?.code === '25006') throw e;
    return { json: null, api: null, error: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Fichiers de traçabilité des propriétés et de projection API → écran, pour
 * les biens de `assetsSql` (paramètres nommés du moteur ; null : aucun bien
 * dans le filtre). Un bien à la fois : mémoire bornée quel que soit le volume.
 */
export async function planPropertyFiles(kit: DiagPlanKit, assetsSql: string | null): Promise<void> {
  const { s } = kit;
  const assets: Array<{ id: number; A: number }> = [];
  let listError: string | null = null;
  if (assetsSql) {
    try {
      const c = named(assetsSql, kit.V);
      for (const r of await s.savepoint(() => s.q(c.sql, c.params))) assets.push({ id: Number(r.id), A: Number(r.account_id) });
    } catch (e) {
      if ((e as { code?: string })?.code === '25006') throw e;
      listError = `liste des biens illisible : ${(e as Error)?.message ?? String(e)}`;
    }
  }
  const sensitive = (k: string) => kit.isSensitiveKey(k);
  const maskValue = (k: string, v: unknown) => (sensitive(k) && !empty(v) ? { $etat: 'masque', motif: 'donnée sensible (registre)' } : v);

  kit.entry('api-ui/correspondance-champs.json', `Table de correspondance champ API → composant d’écran (src/lib/assets/details-ui-map.ts) : route ${DETAILS_UI_ROUTE}, composant ${DETAILS_UI_COMPONENT}`, async (w) => {
    await w(`${JSON.stringify({ route: DETAILS_UI_ROUTE, composant: DETAILS_UI_COMPONENT, regle: 'Chaque section de la réponse API est rendue avec SES champs, lus dans sections[section][champ] ; un champ défini pour une section qui ne le reçoit pas s’affiche vide.', sections: DETAILS_UI_SECTION_LABELS, sectionsParFamille: DETAILS_UI_FAMILY_SECTIONS, champsCommuns: DETAILS_UI_COMMON_FIELDS, champsParSection: DETAILS_UI_SECTION_FIELDS }, null, 2)}\n`);
    return { expected: null, batches: 1, error: null };
  }, undefined, 'api-ui');

  kit.entry('api-ui/fiches.json', `Réponse de ${DETAILS_UI_ROUTE} recalculée pour chaque bien par la même fonction que la route (buildSections), et champs rendus par l’écran avec leur valeur`, async (w) => {
    await w('[');
    let n = 0;
    const errors: string[] = listError ? [listError] : [];
    for (const { id, A } of assets) {
      const p = await loadProjection(kit, id, A);
      if (p.error || !p.api) { errors.push(`bien #${id} : ${p.error ?? 'introuvable'}`); continue; }
      const api = p.api;
      const ecran = Object.entries(api.sections).map(([section, data]) => ({
        section, libelle: DETAILS_UI_SECTION_LABELS[section] ?? section,
        champs: detailsUiFields(api.uiFamily, section).map((f) => ({ champ: f.key, libelle: f.label, condition: f.condition ?? null, valeurLue: maskValue(f.key, data[f.key] ?? null), recuDeLApi: f.key in data })),
        renvoyesNonAffiches: Object.keys(data).filter((k) => !detailsUiFields(api.uiFamily, section).some((f) => f.key === k)),
      }));
      const fiche = { bien: id, compte: A, http: api.status, motif: api.motif, famille: api.family, familleEcran: api.uiFamily, reponseApi: { family: api.family, sections: Object.fromEntries(Object.entries(api.sections).map(([k, d]) => [k, Object.fromEntries(Object.entries(d).map(([f, v]) => [f, maskValue(f, v)]))])) }, ecran };
      await w(`${n++ ? ',' : ''}\n  ${kit.safeJson(kit.M(fiche))}`);
    }
    await w(`${n ? '\n' : ''}]\n`);
    return { expected: listError ? null : assets.length, count: n, batches: 1, error: errors.length ? errors.join(' ; ') : null };
  }, undefined, 'api-ui');

  if (!assetsSql) {
    // Aucun bien dans le filtre : fichier de chaîne vide (attendu 0), comme avant.
    kit.entry('tracabilite/proprietes.json', PROPERTY_CHAIN_DESCRIPTION, async (w) => {
      await w('[]\n');
      return { expected: listError ? null : 0, count: 0, batches: 1, error: listError };
    }, undefined, 'tracabilite');
    return;
  }

  // ── Lot 113Q : données détaillées exportées UNE fois (fichiers dédiés, lus par curseur) ──
  const B = `SELECT b.id, b.account_id FROM (${assetsSql}) b`;
  const DOCS = `SELECT DISTINCT x.account_id, x.file_id FROM (
      SELECT f.account_id, f.id AS file_id FROM (${B}) b JOIN asset_files f ON f.account_id = b.account_id AND (f.asset_id = b.id OR f.linked_asset_id = b.id)
      UNION ALL SELECT l.account_id, l.file_id FROM (${B}) b JOIN document_asset_links l ON l.account_id = b.account_id AND l.asset_id = b.id
      UNION ALL SELECT e.account_id, e.source_id FROM (${B}) b JOIN field_evidence e ON e.account_id = b.account_id AND e.asset_id = b.id
             WHERE e.source_type ~* '^(document|file|asset_file)$' AND e.source_id > 0) x WHERE x.file_id > 0`;
  const REPORTS = `SELECT DISTINCT r.id, r.account_id, r.entries_report_id FROM (${B}) b JOIN ai_execution_reports r ON r.account_id = b.account_id
      AND (r.asset_id = b.id OR r.file_id IN (SELECT d.file_id FROM (${DOCS}) d WHERE d.account_id = b.account_id))`;
  const hasRecoveries = await s.savepoint(() => s.q(`SELECT to_regclass('public.property_recovery_decisions') IS NOT NULL AS ok`)).then((r) => r[0]?.ok === true, () => false);
  const byChamp = (cols: string[]) => (r: Row): Row => {
    const champ = String(r.field_key);
    const out = { ...r };
    for (const c of cols) out[c] = maskValue(champ, r[c]);
    return out;
  };
  const D = PROPERTY_DETAIL_FILES;
  const detail = async (path: string, description: string, text: string, transform?: (r: Row) => Row) => {
    await kit.list(path, description, text, transform, { section: 'tracabilite' });
  };
  await detail(D.preuves, 'Traçabilité des propriétés — preuves (candidates) des biens du filtre, UNE fois chacune : document, page, extrait, confiance, cycle de vie ; citées par identifiant dans tracabilite/proprietes.json',
    `SELECT e.account_id AS compte, e.asset_id AS bien, e.id, e.field_key, e.canonical_key, e.value_json, e.normalized_value, e.raw_value, e.source_type, e.source_id, e.source_version, e.source_location, e.evidence_excerpt,
            e.evidence_origin, e.confidence, e.authority_score, e.status, e.lifecycle_status, e.superseded_at, e.superseded_by_evidence_id, e.analysis_run_id, e.operation_trace_id,
            e.provider, e.model, e.prompt_version, e.document_type, e.document_date, e.extracted_at, e.target_type, e.target_entity_id,
            CASE WHEN e.source_type ~* '^(document|file|asset_file)$' THEN e.source_id END AS document, e.source_location->'page' AS page
       FROM field_evidence e JOIN (${B}) b ON e.account_id = b.account_id AND e.asset_id = b.id ORDER BY e.id`);
  await detail(D.decisions, 'Traçabilité des propriétés — décisions T3 (action, motif, preuves citées, passage) des biens du filtre, une fois chacune',
    `SELECT d.account_id AS compte, d.asset_id AS bien, d.id, d.run_id, d.field_key, d.action, d.reason_code, d.confidence, d.deterministic, d.evidence_ids, d.source_priority, d.created_at,
            r.triggered_by, r.trace_id::text AS run_trace_id, r.status AS run_status, r.shadow
       FROM reconciliation_decisions d JOIN (${B}) b ON d.account_id = b.account_id AND d.asset_id = b.id
       LEFT JOIN reconciliation_runs r ON r.id = d.run_id AND r.account_id = d.account_id ORDER BY d.id`);
  await detail(D.conflits, 'Traçabilité des propriétés — conflits (registre des incohérences) des biens du filtre, une fois chacun',
    `SELECT c.account_id AS compte, c.asset_id AS bien, c.id, c.field_key, c.current_value, c.proposed_value, c.source_type, c.source_detail, c.inconsistency_type, c.status, c.resolution, c.resolved_at, c.resolved_by,
            c.current_evidence_ids, c.proposed_evidence_ids, c.authority_rule, c.decision_mode, c.reason_code, c.current_origin, c.operation_trace_id::text AS operation_trace_id, c.created_at, c.updated_at
       FROM inconsistency_registry c JOIN (${B}) b ON c.account_id = b.account_id AND c.asset_id = b.id ORDER BY c.id`);
  await detail(D.ecritures, 'Traçabilité des propriétés — écritures canoniques (avant / après, résultat) des biens du filtre, une fois chacune',
    `SELECT w.account_id AS compte, w.asset_id AS bien, w.id, w.canonical_key, w.old_value, w.new_value, w.origin, w.actor_user_id, w.source_type, w.source_id, w.trace_id, w.outcome, w.dry_run, w.divergence, w.mirror_columns, w.created_at, w.target_type, w.target_id
       FROM canonical_field_writes w JOIN (${B}) b ON w.account_id = b.account_id AND w.asset_id = b.id ORDER BY w.id`);
  await detail(D.misesAJourIA, 'Traçabilité des propriétés — mises à jour IA des champs des biens du filtre, une fois chacune',
    `SELECT u.account_id AS compte, u.asset_id AS bien, u.id, u.field_key, u.old_value, u.new_value, u.evidence_id, u.decision_type, u.reason_code, u.provider, u.model, u.prompt_version, u.confidence, u.asset_file_id, u.reverted_at, u.reverted_by, u.target_type, u.target_id, u.created_at
       FROM ai_field_updates u JOIN (${B}) b ON u.account_id = b.account_id AND u.asset_id = b.id ORDER BY u.id`);
  if (hasRecoveries) {
    await detail(D.reprises, 'Traçabilité des propriétés — reprises de propriétés manquantes (décision T3 écrite ou abstention motivée) des biens du filtre, une fois chacune',
      `SELECT p.account_id AS compte, p.asset_id AS bien, p.id, p.run_id, p.object_type, p.object_id, p.field_key, p.decision, p.cause, p.value_before, p.value_after, p.proposed_value, p.findings, p.rejected, p.evidence_ids, p.provenance, p.write_outcome, p.prompt_version, p.context_fp, p.created_at
         FROM property_recovery_decisions p JOIN (${B}) b ON p.account_id = b.account_id AND p.asset_id = b.id ORDER BY p.id`, byChamp(['value_before', 'value_after', 'proposed_value']));
  }
  await detail(D.documents, 'Traçabilité des propriétés — documents cités (rattachés, liés, sources de preuves) par les biens du filtre, une fois chacun',
    `SELECT f.account_id AS compte, f.id, f.retained_title, f.document_date, f.analysis_state, f.deleted_at
       FROM asset_files f JOIN (${DOCS}) d ON d.account_id = f.account_id AND d.file_id = f.id ORDER BY f.id`);
  await detail(D.faits, 'Traçabilité des propriétés — faits T1 (clé canonique renseignée) des documents cités, une fois chacun',
    `SELECT f.account_id AS compte, f.id, f.file_id, f.extraction_id, f.fact_key, f.canonical_key, f.raw_key, f.label, f.value_text, f.value_number, f.value_unit, f.value_json, f.normalized_value, f.raw_value,
            f.confidence, f.excerpt, f.location, f.source_unit_ids, f.status, f.target_type, f.target_entity_id, f.provider, f.model, f.prompt_version, f.created_at
       FROM document_facts f JOIN (${DOCS}) d ON d.account_id = f.account_id AND d.file_id = f.file_id WHERE f.canonical_key IS NOT NULL ORDER BY f.id`);
  await detail(D.extractions, 'Traçabilité des propriétés — extractions T1 des documents cités (modèle, version de prompt, trace), une fois chacune',
    `SELECT x.account_id AS compte, x.id, x.file_id AS document, x.analysis_run_id AS analyse, x.model AS modele, x.prompt_version AS "versionPrompt", x.operation_trace_id AS trace, x.fact_count AS faits, x.extracted_at AS "extraitLe"
       FROM document_extractions x JOIN (${DOCS}) d ON d.account_id = x.account_id AND d.file_id = x.file_id ORDER BY x.id`);
  await detail(D.rapports, 'Traçabilité des propriétés — rapports d’exécution (T1 des documents cités, T3 des biens), une fois chacun',
    `SELECT r.account_id AS compte, r.asset_id AS bien, r.id, r.treatment AS traitement, r.status AS statut, r.job_id AS job, r.file_id AS document, r.reconciliation_run_id AS "passageT3", r.trace_ids AS traces, r.created_at AS "creeLe"
       FROM ai_execution_reports r JOIN (SELECT DISTINCT id, account_id FROM (${REPORTS}) z) x ON x.id = r.id AND x.account_id = r.account_id ORDER BY r.id`);
  await detail(D.lignesRapports, 'Traçabilité des propriétés — lignes de rapport par champ (FIELD, PROJECTION, NOT_EXAMINED, DECLARED : écrite / non écrite et motif), une fois chacune ; valeurs masquées selon le champ',
    `SELECT r.account_id AS compte, r.id AS report_id, r.treatment, r.reconciliation_run_id, e.seq, e.section, e.field_key, e.entity_type, e.entity_id, e.old_value, e.value,
            e.write_result, e.reason_code, e.reason, e.record_status, e.table_name, e.record_id
       FROM ai_execution_reports r JOIN (SELECT DISTINCT id, account_id FROM (${REPORTS}) z) x ON x.id = r.id AND x.account_id = r.account_id
       JOIN ai_execution_report_entries e ON e.account_id = r.account_id AND e.report_id = coalesce(r.entries_report_id, r.id)
      WHERE e.field_key IS NOT NULL AND e.section IN ('FIELD', 'PROJECTION', 'NOT_EXAMINED', 'DECLARED')
      ORDER BY r.id, e.seq`, byChamp(['value', 'old_value']));
  await detail(D.biens, 'Traçabilité des propriétés — par bien : rapports T3 du bien et travaux (file IA) de ses rapports, cités une fois par bien (plus répétés dans chaque propriété)',
    `SELECT b.id AS bien, b.account_id AS compte,
            (SELECT coalesce(jsonb_agg(r.id ORDER BY r.id), '[]'::jsonb) FROM ai_execution_reports r WHERE r.account_id = b.account_id AND r.asset_id = b.id AND r.treatment = 'T3') AS "rapportsT3",
            (SELECT coalesce(jsonb_agg(j.job_id ORDER BY j.first_id), '[]'::jsonb) FROM (
               SELECT r.job_id, min(r.id) AS first_id FROM ai_execution_reports r
                WHERE r.account_id = b.account_id AND r.job_id IS NOT NULL
                  AND (r.asset_id = b.id OR r.file_id IN (
                        SELECT f.id FROM asset_files f WHERE f.account_id = b.account_id AND (f.asset_id = b.id OR f.linked_asset_id = b.id)
                        UNION SELECT l.file_id FROM document_asset_links l WHERE l.account_id = b.account_id AND l.asset_id = b.id
                        UNION SELECT e.source_id FROM field_evidence e WHERE e.account_id = b.account_id AND e.asset_id = b.id AND e.source_type ~* '^(document|file|asset_file)$'))
                GROUP BY r.job_id) j) AS jobs
       FROM (${B}) b ORDER BY b.id`);

  // ── Chaîne de chaque propriété : RÉFÉRENCES (identifiants stables), lue et écrite par petits lots ──
  const per = propertyAssetsPerPart();
  const sorted = [...assets].sort((a, b) => a.id - b.id);
  const parts = Math.max(1, Math.ceil(sorted.length / per));
  for (let k = 0; k < parts; k++) {
    const slice = sorted.slice(k * per, (k + 1) * per);
    const path = parts > 1 ? `tracabilite/proprietes.part-${String(k + 1).padStart(4, '0')}.json` : 'tracabilite/proprietes.json';
    kit.entry(path, parts > 1 ? `${PROPERTY_CHAIN_DESCRIPTION} — partie ${k + 1}/${parts} (biens ${slice[0]?.id ?? '-'} à ${slice[slice.length - 1]?.id ?? '-'})` : PROPERTY_CHAIN_DESCRIPTION, async (w) => {
      await w('[');
      const errors: string[] = listError ? [listError] : [];
      let biens = 0;
      let n = 0;
      let chunk = '';
      const flush = async (force = false) => { if (chunk && (force || chunk.length >= PROPERTY_WRITE_CHARS)) { const c = chunk; chunk = ''; await w(c); } };
      try {
        biens = await s.savepoint(() => streamPropertyChain(kit, slice, { hasRecoveries, maskValue }, async (e) => {
          chunk += `${n++ ? ',' : ''}\n  ${kit.safeJson(kit.M(e))}`;
          await flush();
        }, (msg) => errors.push(msg)));
      } catch (e) {
        if ((e as { code?: string })?.code === '25006' || (e as Error)?.name === 'SinkError') throw e;
        errors.push(`biens ${slice[0]?.id ?? '?'} à ${slice[slice.length - 1]?.id ?? '?'} : ${(e as Error)?.message ?? String(e)}`);
      }
      await flush(true);
      await w(`${n ? '\n' : ''}]\n`);
      return { expected: listError ? null : slice.length, count: biens, batches: 1, error: errors.length ? errors.join(' ; ') : null };
    }, parts > 1 ? { index: k + 1, of: parts, group: 'tracabilite/proprietes.json' } : undefined, 'tracabilite');
  }
}

/** Description de la chaîne (manifeste). */
const PROPERTY_CHAIN_DESCRIPTION = 'Chaîne de chaque propriété (bien × champ) : affichage ← API ← persistance ← écritures ← décisions / conflits / reprises ← preuves (candidates) ← faits ← extractions ← documents ← traitements ; verdict donnée / backend / affichage. Lot 113Q : détails cités par identifiant (`refs`), exportés une fois dans tracabilite/proprietes/*.json';

/**
 * Lot 113Q — fichiers DÉTAILLÉS de la traçabilité des propriétés : chaque
 * ligne n'y figure qu'UNE fois (avant : recopiée dans chaque propriété qui la
 * citait — tous les rapports T3 d'un bien dans CHAQUE propriété du bien).
 */
export const PROPERTY_DETAIL_FILES = Object.freeze({
  preuves: 'tracabilite/proprietes/preuves.json',
  decisions: 'tracabilite/proprietes/decisions.json',
  conflits: 'tracabilite/proprietes/conflits.json',
  ecritures: 'tracabilite/proprietes/ecritures.json',
  misesAJourIA: 'tracabilite/proprietes/mises-a-jour-ia.json',
  reprises: 'tracabilite/proprietes/reprises.json',
  documents: 'tracabilite/proprietes/documents.json',
  faits: 'tracabilite/proprietes/faits.json',
  extractions: 'tracabilite/proprietes/extractions.json',
  rapports: 'tracabilite/proprietes/rapports.json',
  lignesRapports: 'tracabilite/proprietes/lignes-rapports.json',
  biens: 'tracabilite/proprietes/biens.json',
});

/** Lot 113Q : biens par partie de `tracabilite/proprietes.json` (DIAG_PROPERTY_ASSETS_PER_PART, 1 à 5 000 ; défaut 200). */
export function propertyAssetsPerPart(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.DIAG_PROPERTY_ASSETS_PER_PART);
  return Number.isInteger(v) && v >= 1 && v <= 5000 ? v : 200;
}
/** Lot 113Q : texte accumulé avant une écriture (moins d'appels, mémoire bornée). */
const PROPERTY_WRITE_CHARS = 256 * 1024;
/** Lot 113Q : lignes par lot des curseurs de la chaîne (colonnes légères : identifiants et corrélations). */
const CHAIN_BATCH_ROWS = 2000;

/** Références d'une propriété vers les fichiers détaillés (identifiants stables). */
export interface PropertyRefs {
  ecritures: number[];
  ecrituresRapport: Array<{ rapport: number; seq: number }>;
  misesAJourIA: number[];
  decisions: Array<{ id: number; ecrituresCorrelees: number[]; resultatRapport: Array<{ rapport: number; seq: number }> }>;
  conflits: number[];
  reprisesProprieteManquante: number[];
  preuves: number[];
  faits: Array<{ id: number; projeteEnPreuve: boolean }>;
  extractions: number[];
  documents: number[];
  documentsIntrouvables: number[];
  /** Rapports des documents de la chaîne ; les rapports T3 du bien et ses travaux : `biens.json` (une fois par bien). */
  rapports: number[];
}

/** Cible SQL d'une ligne (même règle que `target` : le bien lui-même, ou un objet du bien). */
const tgt = (t: string, i: string, asset: string) =>
  `(CASE WHEN coalesce(${t}::text, '') <> '' AND upper(${t}::text) <> 'ASSET' AND ${i} IS NOT NULL THEN upper(${t}::text) || '#' || ${i}::text ELSE 'ASSET#' || ${asset}::text END)`;
const keyOf = (target: string, champ: string) => `${target} || '|' || coalesce(${champ}::text, 'null')`;

/** Ordre des clés : celui de PostgreSQL `COLLATE "C"` (octets UTF-8 = points de code). */
export function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  // Rapide pour l'ASCII (cas réel) ; sinon comparaison exacte par octets UTF-8.
  if (/^[\x00-\x7f]*$/.test(a) && /^[\x00-\x7f]*$/.test(b)) return a < b ? -1 : 1;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Flux trié (bien, clé) lu par lots ; `take` rend les lignes de la clé courante. */
function keyedStream(it: AsyncIterator<Row[]>) {
  let lot: Row[] = [];
  let i = 0;
  let done = false;
  const head = async (): Promise<Row | null> => {
    while (i >= lot.length) {
      if (done) return null;
      const r = await it.next();
      if (r.done) { done = true; return null; }
      lot = r.value;
      i = 0;
    }
    return lot[i];
  };
  return {
    head,
    /** Lignes de (bien, clé), en écartant d'abord les lignes antérieures. */
    async take(a: number, k: string, skipBefore = false): Promise<Row[]> {
      const out: Row[] = [];
      for (;;) {
        const h = await head();
        if (!h) return out;
        const ha = Number(h.a);
        if (ha < a || (ha === a && compareKeys(String(h.k), k) < 0)) {
          if (!skipBefore) throw new Error(`flux de traçabilité désordonné (${ha}|${String(h.k)} avant ${a}|${k})`);
          i++;
          continue;
        }
        if (ha !== a || String(h.k) !== k) return out;
        out.push(h);
        i++;
      }
    },
    async close() { if (!done) { done = true; await it.return?.(undefined); } },
  };
}

/**
 * Lot 113Q — chaîne des propriétés d'un lot de biens, lue → transformée →
 * écrite PAR PROPRIÉTÉ : huit curseurs triés (bien, clé) — preuves,
 * décisions, conflits, écritures, mises à jour IA, reprises, lignes de
 * rapport, faits — ne lisent que les colonnes de corrélation (identifiants,
 * traces, passages, documents) ; une propriété n'est tenue en mémoire que le
 * temps de l'écrire. Par bien : la projection API (une ligne) et un index
 * léger (documents, extractions et rapports par document : identifiants).
 * Mêmes règles qu'avant (cible, clés, corrélations), mêmes informations :
 * les lignes complètes sont dans les fichiers détaillés.
 */
async function streamPropertyChain(
  kit: DiagPlanKit, slice: Array<{ id: number; A: number }>, o: { hasRecoveries: boolean; maskValue: (k: string, v: unknown) => unknown },
  emit: (e: Row) => Promise<void>, onError: (m: string) => void,
): Promise<number> {
  const { s } = kit;
  const { jsonBatches } = await import('@/services/admin/account-data/session');
  const { readCanonicalValue } = await import('@/services/canonical/asset-state/canonical-asset-view');
  const ids = slice.map((x) => x.id);
  const accs = slice.map((x) => x.A);
  const b = `SELECT * FROM unnest($1::int[], $2::int[]) AS b(id, account_id)`;
  const docs = `SELECT DISTINCT x.asset_id, x.account_id, x.file_id FROM (
      SELECT b.id AS asset_id, b.account_id, f.id AS file_id FROM (${b}) b JOIN asset_files f ON f.account_id = b.account_id AND (f.asset_id = b.id OR f.linked_asset_id = b.id)
      UNION ALL SELECT b.id, b.account_id, l.file_id FROM (${b}) b JOIN document_asset_links l ON l.account_id = b.account_id AND l.asset_id = b.id
      UNION ALL SELECT b.id, b.account_id, e.source_id FROM (${b}) b JOIN field_evidence e ON e.account_id = b.account_id AND e.asset_id = b.id
             WHERE e.source_type ~* '^(document|file|asset_file)$' AND e.source_id > 0) x WHERE x.file_id > 0`;
  // ORDER BY sur une expression (COLLATE) : seulement sur les colonnes d'une sous-requête.
  const sorted = (inner: string, tie: string) => `SELECT * FROM (${inner}) z ORDER BY z.a, z.k COLLATE "C", ${tie}`;
  const evT = tgt('e.target_type', 'e.target_entity_id', 'e.asset_id');
  const sqls: Record<string, string> = {
    ev: sorted(`
           SELECT e.asset_id AS a, ${keyOf(evT, 'e.field_key')} AS k, e.id, e.source_type, e.source_id FROM field_evidence e JOIN (${b}) b ON e.account_id = b.account_id AND e.asset_id = b.id
           UNION ALL
           SELECT e.asset_id, ${keyOf(evT, 'e.canonical_key')}, e.id, e.source_type, e.source_id FROM field_evidence e JOIN (${b}) b ON e.account_id = b.account_id AND e.asset_id = b.id
            WHERE coalesce(e.canonical_key, '') <> '' AND e.canonical_key IS DISTINCT FROM e.field_key`, 'z.id'),
    dec: sorted(`SELECT d.asset_id AS a, ${keyOf(`'ASSET#' || d.asset_id::text`, 'd.field_key')} AS k, d.id, d.run_id, r.trace_id::text AS run_trace_id
            FROM reconciliation_decisions d JOIN (${b}) b ON d.account_id = b.account_id AND d.asset_id = b.id
            LEFT JOIN reconciliation_runs r ON r.id = d.run_id AND r.account_id = d.account_id`, 'z.id'),
    con: sorted(`SELECT c.asset_id AS a, ${keyOf(`'ASSET#' || c.asset_id::text`, 'c.field_key')} AS k, c.id FROM inconsistency_registry c JOIN (${b}) b ON c.account_id = b.account_id AND c.asset_id = b.id`, 'z.id'),
    wr: sorted(`SELECT w.asset_id AS a, ${keyOf(tgt('w.target_type', 'w.target_id', 'w.asset_id'), 'w.canonical_key')} AS k, w.id, w.trace_id
           FROM canonical_field_writes w JOIN (${b}) b ON w.account_id = b.account_id AND w.asset_id = b.id`, 'z.id'),
    ai: sorted(`SELECT u.asset_id AS a, ${keyOf(tgt('u.target_type', 'u.target_id', 'u.asset_id'), 'u.field_key')} AS k, u.id FROM ai_field_updates u JOIN (${b}) b ON u.account_id = b.account_id AND u.asset_id = b.id`, 'z.id'),
    rep: sorted(`SELECT rr.asset_id AS a, ${keyOf(tgt('e.entity_type', 'e.entity_id', 'rr.asset_id'), 'e.field_key')} AS k, rr.id AS report_id, e.seq, e.section, rr.reconciliation_run_id
            FROM (SELECT DISTINCT b.id AS asset_id, r.id, r.account_id, r.entries_report_id, r.reconciliation_run_id FROM (${b}) b JOIN ai_execution_reports r ON r.account_id = b.account_id
                   AND (r.asset_id = b.id OR r.file_id IN (SELECT d.file_id FROM (${docs}) d WHERE d.asset_id = b.id))) rr
            JOIN ai_execution_report_entries e ON e.account_id = rr.account_id AND e.report_id = coalesce(rr.entries_report_id, rr.id)
           WHERE e.field_key IS NOT NULL AND e.section IN ('FIELD', 'PROJECTION', 'NOT_EXAMINED', 'DECLARED')
             AND (e.section <> 'DECLARED' OR e.entity_type IS NULL OR upper(e.entity_type::text) = 'ASSET')`, 'z.report_id, z.seq'),
    fa: sorted(`SELECT d.asset_id AS a, 'ASSET#' || d.asset_id::text || '|' || f.canonical_key AS k, f.id, f.file_id
           FROM (${docs}) d JOIN document_facts f ON f.account_id = d.account_id AND f.file_id = d.file_id WHERE f.canonical_key IS NOT NULL`, 'z.id'),
  };
  if (o.hasRecoveries) {
    sqls.rec = sorted(`SELECT p.asset_id AS a, ${keyOf(tgt('p.object_type', 'p.object_id', 'p.asset_id'), 'p.field_key')} AS k, p.id
                  FROM property_recovery_decisions p JOIN (${b}) b ON p.account_id = b.account_id AND p.asset_id = b.id`, 'z.id');
  }
  const streams: Record<string, ReturnType<typeof keyedStream>> = {};
  for (const [name, text] of Object.entries(sqls)) streams[name] = keyedStream(jsonBatches(s, text, [ids, accs], CHAIN_BATCH_ROWS)[Symbol.asyncIterator]());
  const keyed = Object.entries(streams).filter(([n]) => n !== 'fa');
  let done = 0;
  try {
    for (const { id: assetId, A } of slice) {
      const p = await loadProjection(kit, assetId, A);
      if (p.error) onError(`bien #${assetId} : projection API — ${p.error}`);
      const json = p.json ?? {};
      let kc: Record<string, unknown> = {};
      try { kc = json.key_characteristics ? JSON.parse(String(json.key_characteristics)) as Record<string, unknown> : {}; } catch { kc = {}; }
      // Index léger du bien : documents (présents / cités), extractions et rapports par document — identifiants seulement.
      const docIds = (await s.q(`SELECT DISTINCT file_id AS id FROM (${docs}) d WHERE d.asset_id = $3 ORDER BY 1`, [ids, accs, assetId])).map((r) => Number(r.id));
      const present = new Set(docIds.length ? (await s.q(`SELECT id FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[])`, [A, docIds])).map((r) => Number(r.id)) : []);
      const extByFile = new Map<number, number[]>();
      const repByFile = new Map<number, number[]>();
      if (docIds.length) {
        for (const r of await s.q(`SELECT id::bigint AS id, file_id FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[]) ORDER BY id`, [A, docIds])) addTo(extByFile, Number(r.file_id), Number(r.id));
        for (const r of await s.q(`SELECT id::bigint AS id, file_id FROM ai_execution_reports WHERE account_id = $1 AND file_id = ANY($2::int[]) ORDER BY id`, [A, docIds])) addTo(repByFile, Number(r.file_id), Number(r.id));
      }
      const self = `ASSET#${assetId}`;
      const api = p.api;
      const jsKeys = new Set<string>();
      if (api) for (const [section, data] of Object.entries(api.sections)) {
        for (const k of Object.keys(data)) jsKeys.add(`${self}|${k}`);
        for (const f of detailsUiFields(api.uiFamily, section)) jsKeys.add(`${self}|${f.key}`);
      }
      for (const k of Object.keys(kc)) if (!KC_META.test(k)) jsKeys.add(`${self}|${k}`);
      const pending = [...jsKeys].sort(compareKeys);
      let pi = 0;
      for (;;) {
        // Prochaine clé : la plus petite des clés de l'écran / de la fiche et des têtes de flux de CE bien.
        let next: string | null = pi < pending.length ? pending[pi] : null;
        for (const [, st] of keyed) {
          const h = await st.head();
          if (h && Number(h.a) === assetId && (next === null || compareKeys(String(h.k), next) < 0)) next = String(h.k);
        }
        if (next === null) break;
        if (pi < pending.length && pending[pi] === next) pi++;
        const g: Record<string, Row[]> = {};
        for (const [name, st] of keyed) g[name] = await st.take(assetId, next);
        const champ = next.slice(next.indexOf('|') + 1);
        const cible = next.slice(0, next.indexOf('|'));
        const isSelf = cible === self;
        const fa = await streams.fa.take(assetId, next, true);
        await emit(buildEntry({ assetId, cible, champ, isSelf, p, kc, json, g, fa: isSelf ? fa : [], present, extByFile, repByFile, maskValue: o.maskValue, readCanonicalValue }));
      }
      done++;
    }
  } finally {
    for (const st of Object.values(streams)) await st.close().catch(() => undefined);
  }
  return done;
}

const addTo = (m: Map<number, number[]>, k: number, v: number) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/** Entrée d'une propriété (pure) : affichage, API, persistance en clair ; tout le reste par référence. */
function buildEntry(x: {
  assetId: number; cible: string; champ: string; isSelf: boolean; p: Projection; kc: Record<string, unknown>; json: Row; g: Record<string, Row[]>; fa: Row[];
  present: Set<number>; extByFile: Map<number, number[]>; repByFile: Map<number, number[]>; maskValue: (k: string, v: unknown) => unknown;
  readCanonicalValue: (row: never, key: string) => { value: unknown; origin: unknown; from: unknown; updatedAt: unknown } | null;
}): Row {
  const { assetId, cible, champ, isSelf, p, kc, json, g, fa, maskValue } = x;
  const api = p.api;
  const ev = g.ev ?? [];
  const wr = g.wr ?? [];
  const rep = g.rep ?? [];
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
      const st = x.readCanonicalValue(p.json as never, champ);
      canonique = st ? { valeur: maskValue(champ, st.value), origine: st.origin, lu: st.from, misAJour: st.updatedAt } : null;
    } catch { canonique = null; }
  }
  const persisted = !empty(persistedKc) ? persistedKc : (colonne && !empty(colonne.valeur) ? colonne.valeur : null);
  const verdict = isSelf && api ? propertyVerdict({ persisted, apiStatus: api.status, apiSent, apiValue, uiExpects, uiConsumed }) : null;
  const isDoc = (t: unknown) => /^(document|file|asset_file)$/i.test(String(t ?? ''));
  const evFiles = new Set(ev.map((e) => (isDoc(e.source_type) ? Number(e.source_id) : null)).filter((v): v is number => v !== null));
  const factFiles = new Set(fa.map((f) => Number(f.file_id)));
  const fileIds = [...new Set([...evFiles, ...factFiles])].sort((a, b) => a - b);
  const refs: PropertyRefs = {
    ecritures: wr.map((r) => Number(r.id)),
    ecrituresRapport: rep.map((e) => ({ rapport: Number(e.report_id), seq: Number(e.seq) })),
    misesAJourIA: (g.ai ?? []).map((r) => Number(r.id)),
    decisions: (g.dec ?? []).map((d) => ({
      id: Number(d.id),
      ecrituresCorrelees: wr.filter((w) => d.run_trace_id && String(w.trace_id ?? '') === String(d.run_trace_id)).map((w) => Number(w.id)),
      resultatRapport: rep.filter((e) => e.section === 'FIELD' && N(e.reconciliation_run_id) === N(d.run_id)).map((e) => ({ rapport: Number(e.report_id), seq: Number(e.seq) })),
    })),
    conflits: (g.con ?? []).map((r) => Number(r.id)),
    reprisesProprieteManquante: (g.rec ?? []).map((r) => Number(r.id)),
    preuves: ev.map((r) => Number(r.id)),
    faits: fa.map((f) => ({ id: Number(f.id), projeteEnPreuve: ev.some((e) => Number(e.source_id) === Number(f.file_id)) })),
    extractions: fileIds.flatMap((f) => x.extByFile.get(f) ?? []).sort((a, b) => a - b),
    documents: fileIds,
    documentsIntrouvables: fileIds.filter((f) => !x.present.has(f)),
    rapports: [...new Set(fileIds.flatMap((f) => x.repByFile.get(f) ?? []))].sort((a, b) => a - b),
  };
  return {
    bien: assetId, cible, champ, verdict,
    affichage: uiPart, api: apiPart,
    persiste: isSelf ? { fiche: { cle: `key_characteristics.${champ}`, valeur: maskValue(champ, persistedKc ?? null), meta, verrouUtilisateur: meta.userValidated === true || meta.origin === 'USER' }, colonne, canonique } : { motif: 'propriété d’un objet du bien : valeur dans compte/etat-metier (équipements, Pièces)' },
    refs,
  };
}

/** Lignes des fichiers détaillés, indexées (lecture du ZIP : analyse, recette, tests). */
export interface PropertyDetailIndex {
  preuves: Map<number, Row>; decisions: Map<number, Row>; conflits: Map<number, Row>; ecritures: Map<number, Row>; misesAJourIA: Map<number, Row>;
  reprises: Map<number, Row>; documents: Map<string, Row>; faits: Map<number, Row>; extractions: Map<number, Row>; rapports: Map<number, Row>;
  lignesRapports: Map<string, Row>; biens: Map<number, Row>;
}

/** Index des fichiers détaillés (pur) à partir de leurs lignes (parties réunies). */
export function indexPropertyDetails(rows: Partial<Record<keyof typeof PROPERTY_DETAIL_FILES, Row[]>>): PropertyDetailIndex {
  const byId = (l: Row[] | undefined) => new Map((l ?? []).map((r) => [Number(r.id), r]));
  return {
    preuves: byId(rows.preuves), decisions: byId(rows.decisions), conflits: byId(rows.conflits), ecritures: byId(rows.ecritures), misesAJourIA: byId(rows.misesAJourIA),
    reprises: byId(rows.reprises), documents: new Map((rows.documents ?? []).map((r) => [`${r.compte}|${r.id}`, r])), faits: byId(rows.faits), extractions: byId(rows.extractions),
    rapports: byId(rows.rapports), lignesRapports: new Map((rows.lignesRapports ?? []).map((r) => [`${r.report_id}|${r.seq}`, r])), biens: new Map((rows.biens ?? []).map((r) => [Number(r.bien), r])),
  };
}

/**
 * Lot 113Q — chaîne DÉVELOPPÉE d'une propriété (pure) : les références sont
 * remplacées par les lignes des fichiers détaillés — même forme que la chaîne
 * du lot 91A (preuves, décisions, faits, extractions, documents,
 * traitements…). Preuve qu'aucune information n'est perdue (test e2e
 * « avant / après ») et aide de lecture pour l'analyse.
 */
export function expandPropertyChain(e: Row, idx: PropertyDetailIndex): Row {
  const refs = e.refs as PropertyRefs;
  const strip = (r: Row | undefined, ...cols: string[]) => { if (!r) return r; const o = { ...r }; for (const c of cols) delete o[c]; return o; };
  const get = <K extends number | string>(m: Map<K, Row>, k: K, ...cols: string[]) => strip(m.get(k), ...cols) ?? { id: k, $etat: 'reference_absente' };
  const bien = idx.biens.get(Number(e.bien));
  const compte = bien?.compte;
  const ligne = (x: { rapport: number; seq: number }) => idx.lignesRapports.get(`${x.rapport}|${x.seq}`);
  const { refs: _r, ...head } = e;
  void _r;
  const t3 = new Set(((bien?.rapportsT3 as number[] | undefined) ?? []).map(Number));
  return {
    ...head,
    ecritures: refs.ecritures.map((id) => get(idx.ecritures, id, 'compte', 'bien')),
    ecrituresRapport: refs.ecrituresRapport.map((x) => strip(ligne(x), 'compte') ?? { ...x, $etat: 'reference_absente' }),
    misesAJourIA: refs.misesAJourIA.map((id) => get(idx.misesAJourIA, id, 'compte', 'bien')),
    decisions: refs.decisions.map((d) => ({
      ...get(idx.decisions, d.id, 'compte', 'bien'),
      ecrituresCorrelees: d.ecrituresCorrelees,
      resultatRapport: d.resultatRapport.map((x) => { const l = ligne(x); return { rapport: x.rapport, seq: x.seq, ecriture: l?.write_result, motif: l?.reason_code, detail: l?.reason }; }),
    })),
    conflits: refs.conflits.map((id) => get(idx.conflits, id, 'compte', 'bien')),
    reprisesProprieteManquante: refs.reprisesProprieteManquante.map((id) => get(idx.reprises, id, 'compte', 'bien')),
    preuves: refs.preuves.map((id) => get(idx.preuves, id, 'compte', 'bien')),
    faits: refs.faits.map((f) => ({ ...get(idx.faits, f.id, 'compte'), projeteEnPreuve: f.projeteEnPreuve })),
    extractions: refs.extractions.map((id) => get(idx.extractions, id, 'compte')),
    documents: refs.documents.map((id) => (refs.documentsIntrouvables.includes(id) ? { id, motif: 'document absent du compte (supprimé définitivement ?)' } : strip(idx.documents.get(`${compte}|${id}`), 'compte') ?? { id, $etat: 'reference_absente' })),
    traitements: {
      rapports: [...new Set([...refs.rapports, ...t3])].sort((a, b) => a - b).map((id) => get(idx.rapports, id, 'compte', 'bien')),
      jobs: (bien?.jobs as number[] | undefined) ?? [],
    },
  };
}
