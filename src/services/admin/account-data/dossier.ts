/**
 * BO › fiche compte › « Données du compte » — DOSSIER d'une entité (lot 75N).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE SEULE, BORNÉE AU COMPTE, SANS API SQL GÉNÉRIQUE
 *
 *   · toutes les requêtes sont écrites ici, par type d'entité (aucune table
 *     ni colonne fournie par l'appelant) ; chacune est bornée au compte ;
 *   · une transaction `REPEATABLE READ, READ ONLY` par dossier
 *     (`withReadSession`, lot 81C) : un seul instantané pour toutes les
 *     sections ; une écriture serait refusée par PostgreSQL lui-même ;
 *   · l'entité est d'abord relue PAR LE COMPTE (bien parent pour un
 *     équipement / une pièce) : une entité d'un autre compte est « introuvable »
 *     (404), jamais servie ;
 *   · valeurs CANONIQUES lues par les lecteurs existants
 *     (`buildCanonicalAssetState`, `loadEntityRow` + `buildCanonicalEntityState`),
 *     Opérations par `OperationDiagnosticsService.detail` : aucune règle de
 *     consolidation n'est réécrite ; aucun traitement IA n'est déclenché ;
 *   · lot 81C — AUCUN PLAFOND D'EXTRACTION : chaque section tabulaire ou de
 *     relations est une SOURCE (requête écrite ici, ordre total) lue
 *     · en consultation (tiroir) : par PAGE (`DOSSIER_PAGE_SIZE`, navigation
 *       jusqu'à la dernière ligne, recherche serveur) avec son total réel ;
 *     · à l'export (`export.ts`) : INTÉGRALEMENT, par curseur, lot par lot,
 *       décompte attendu et statut COMPLETE / PARTIAL / FAILED par section ;
 *   · masquage (`maskRow`) avant toute sortie : le tiroir, la copie et les
 *     exports partagent donc les mêmes restrictions.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  OPERATION_DETAIL_LISTS, OperationDiagnosticsService, type DiagExecutor, type DiagQuery, type OperationDetail,
} from '@/services/business-operations/diagnostics/service';
import { CANONICAL_FIELDS, getField, resolveAlias, type CanonicalFieldDef } from '@/services/canonical/registry';
import { buildCanonicalAssetState, fromMirrorColumn, parseKc, sameCanonicalValue, type AssetRowJson, type SqlRunner, type CanonicalFieldState } from '@/services/canonical/asset-state';
import { ENTITY_MIRRORS, buildCanonicalEntityState, loadEntityRow } from '@/services/canonical/entity-state';
import { fromEntityMirror, mirrorId } from '@/services/canonical/entity-state/entity-view';
import { ASSET_STATUS_LABELS } from '@/lib/asset-status';
import {
  ACCOUNT_DATA_SCHEMA, DOSSIER_PAGE_MAX, DOSSIER_PAGE_SIZE, ENTITY_LABELS, ENTITY_TABLES, columnField, formatEur, formatMinor, isMarker, kcBaseKey,
  maskDeep, maskRow, originLabel, rowFields, type DossierField, type DossierRelation, type DossierSection, type DossierWindow, type EntityDossier,
  type EntityType, type MaskOptions, type Tab,
} from './model';
import { countRows, decodeJsonRow, jsonBatches, withReadSession, type ReadSession, type SessionWrap } from './session';

export class EntityNotFoundError extends Error {
  constructor() { super('Entité introuvable dans ce compte'); }
}

type Row = Record<string, unknown>;

/** Clé canonique sensible au sens du registre (adresse, n° de contrat d'assurance…). */
export function isSensitiveCanonicalKey(key: string): boolean {
  const def = getField(key) ?? (() => { const k = resolveAlias(key); return k ? getField(k) : undefined; })();
  return def?.sensitive === true;
}
const MASK: MaskOptions = { isSensitiveKey: isSensitiveCanonicalKey };

/** Colonnes miroirs (table `assets`) des champs sensibles du registre (ex. `assets.address`). */
const SENSITIVE_ASSET_COLUMNS: ReadonlySet<string> = new Set(
  CANONICAL_FIELDS.filter((d) => d.sensitive).flatMap((d) => (d.mirrorColumns ?? []).map((m) => m.column)),
);
/** Ligne `assets` : colonnes miroirs sensibles masquées (avant tout rendu). */
function maskAssetRow(row: Row): Row {
  const out: Row = { ...row };
  for (const c of SENSITIVE_ASSET_COLUMNS) if (out[c] !== null && out[c] !== undefined) out[c] = { $etat: 'masque', motif: 'donnée sensible (registre)' };
  return out;
}

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Session de lecture d'un dossier (instantané, curseur, points de reprise). */
export type DossierExecutor = <T>(fn: (s: ReadSession) => Promise<T>) => Promise<T>;

/**
 * Session REPEATABLE READ READ ONLY avec délai côté base et POINTS DE
 * REPRISE réels (`SAVEPOINT`) : une section en erreur n'empêche pas la
 * lecture des suivantes. `wrap` : interception des requêtes (fonction) ou
 * des requêtes ET des curseurs (objet) — tests de panne.
 */
export function readOnlyDossierExecutor(wrap?: ((q: DiagQuery) => DiagQuery) | SessionWrap): DossierExecutor {
  const w: SessionWrap = typeof wrap === 'function' ? { q: wrap } : (wrap ?? {});
  return <T>(fn: (s: ReadSession) => Promise<T>) => withReadSession(fn, w);
}

/** Source d'une section : requête écrite ici (table / relations) ou lignes calculées (moteur existant). */
export type SectionSource =
  | { kind: 'table'; table: string; sql: string; params: unknown[] }
  | { kind: 'relations'; sql: string; params: unknown[] }
  | { kind: 'static'; table: string; rows: Row[] };

interface Ctx {
  s: ReadSession;
  q: DiagQuery;
  accountId: number;
  warnings: string[];
  sections: DossierSection[];
  sources: Map<string, SectionSource>;
  /** Consultation d'UNE section (page suivante, recherche) : les autres ne sont pas lues. */
  only: string | null;
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** Ligne unique en JSON PostgreSQL (`row_to_json` : dates ISO, JSON natifs, toutes les colonnes). */
async function oneRow(q: DiagQuery, sql: string, params: unknown[]): Promise<Row | null> {
  const [r] = await q(`SELECT row_to_json(t) AS r FROM (${sql}) t`, params);
  if (!r) return null;
  return decodeJsonRow(r.r);
}

/** Lignes en JSON PostgreSQL (valeurs fidèles : numeric en nombre, dates ISO) — lectures de synthèse ; masquées. */
async function jsonRows(q: DiagQuery, sql: string, params: unknown[]): Promise<Row[]> {
  const rows = await q(`SELECT row_to_json(t) AS r FROM (${sql}) t`, params);
  return rows.map((x) => maskRow(decodeJsonRow(x.r), MASK));
}

/** Masquage d'une ligne de section (tiroir, copie, exports : mêmes restrictions). */
export const maskSectionRow = (r: Row): Row => maskRow(r, MASK);

/** Relation d'une ligne de requête (colonnes : type, id, label, nature, status, origin, via). */
export function toRelation(r: Row): DossierRelation {
  return {
    type: String(r.type) as EntityType, id: num(r.id), label: str(r.label) ?? `#${r.id}`, nature: String(r.nature),
    status: str(r.status), origin: str(r.origin), via: String(r.via),
  };
}

const errCode = (e: unknown): string | undefined => (e as { code?: string })?.code;

async function section(ctx: Ctx, s: { id: string; tab: Tab; title: string; description?: string }, build: () => Promise<Partial<DossierSection> | null>): Promise<void> {
  if (ctx.only && s.id !== ctx.only) return;
  // Point de reprise : une section en erreur n'interrompt pas la transaction
  // de lecture (les sections suivantes restent lisibles).
  try {
    const built = await ctx.s.savepoint(build);
    if (built === null) return; // section sans objet (aucune ligne de détail)
    ctx.sections.push({ ...s, ...built } as DossierSection);
  } catch (e) {
    const code = errCode(e);
    if (code === '25006') throw e; // une écriture tentée est une erreur de programmation : jamais masquée
    console.error(`[admin/account-data] section ${s.id} :`, (e as Error)?.message ?? e);
    ctx.warnings.push(`Section « ${s.title} » non chargée (erreur de lecture${code ? ` ${code}` : ''}).`);
    ctx.sections.push({ ...s, error: `lecture impossible${code ? ` (${code})` : ''}` });
  }
}

/** Section tabulaire : requête enregistrée comme SOURCE (lue par page ou intégralement, plus tard). */
function tableSection(ctx: Ctx, id: string, tab: Tab, title: string, table: string, sql: string, params: unknown[], description?: string): Promise<void> {
  if (ctx.only && id !== ctx.only) return Promise.resolve();
  ctx.sources.set(id, { kind: 'table', table, sql, params });
  ctx.sections.push({ id, tab, title, ...(description ? { description } : {}), table: { table, columns: [], rows: [], total: null, complete: false } });
  return Promise.resolve();
}

/** Section de relations : requête enregistrée comme SOURCE. */
function relSection(ctx: Ctx, id: string, title: string, sql: string, params: unknown[]): Promise<void> {
  if (ctx.only && id !== ctx.only) return Promise.resolve();
  // Ordre total (pages stables d'une consultation à l'autre) : type, id, via, nature si la requête n'en fixe pas.
  const ordered = /\bORDER\s+BY\b[^()]*$/i.test(sql.trim()) ? sql : `${sql}\n ORDER BY 1, 2, 7, 4`;
  ctx.sources.set(id, { kind: 'relations', sql: ordered, params });
  ctx.sections.push({ id, tab: 'relations', title, relations: [] });
  return Promise.resolve();
}

/** Lignes calculées par un moteur existant (TCO) : source statique, masquée. */
function registerStatic(ctx: Ctx, id: string, table: string, rows: Row[]): DossierSection['table'] {
  ctx.sources.set(id, { kind: 'static', table, rows: rows.map((r) => maskRow(r, MASK)) });
  return { table, columns: [], rows: [], total: rows.length, complete: false };
}

/** Champs « Données BDD » d'une ligne (masquée), dans l'ordre des colonnes. */
function bddFields(table: string, row: Row): DossierField[] {
  return rowFields(table, maskRow(row, MASK));
}

/** Champs sélectionnés d'une ligne (Synthèse), avec libellés métier. */
function pick(table: string, row: Row, cols: Array<[string, string]>): DossierField[] {
  const m = maskRow(row, MASK);
  return cols.map(([c, label]) => columnField(table, c, c in m ? m[c] : undefined, m, label));
}

/** Clés d'une fiche JSON (`key_characteristics`) : une ligne par clé, métadonnées comprises. */
function kcFields(table: string, column: string, kcRaw: unknown): DossierField[] {
  if (kcRaw === null || kcRaw === undefined) return [columnField(table, column, kcRaw)];
  const kc = maskDeep(parseKc(kcRaw), MASK) as Row;
  return Object.keys(kc).sort().map((k) => {
    const f = columnField(table, column, kc[k], kc, k);
    f.path = k;
    const def = getField(kcBaseKey(k));
    if (def && !k.includes('__')) f.label = `${k} — ${def.label}`;
    return f;
  });
}

// ── Valeurs canoniques ──────────────────────────────────────────────────────

function canonicalDisplay(def: CanonicalFieldDef | undefined, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (def?.valueType === 'money_eur' && typeof v === 'number') return formatEur(v);
  if (def?.valueType === 'money_cents' && typeof v === 'number') return formatMinor(v, 'EUR');
  if (def?.valueType === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('/');
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  return typeof v === 'object' ? JSON.stringify(v) : `${String(v)}${def?.unit && def.unit !== 'EUR' ? ` ${def.unit}` : ''}`;
}

function canonicalFields(table: string, states: Record<string, CanonicalFieldState>): DossierField[] {
  return Object.values(states).sort((a, b) => a.key.localeCompare(b.key)).map((st) => {
    const def = getField(st.key);
    const sensitive = def?.sensitive === true;
    const [t, c] = st.from === 'column' && st.fromName?.includes('.') ? st.fromName.split('.') : [table, st.from === 'column' ? (st.fromName ?? '?') : 'key_characteristics'];
    const f: DossierField = {
      table: t, column: c, path: st.from === 'column' ? undefined : (st.from === 'alias' ? st.fromName : st.key),
      label: `${def?.label ?? st.key} (${st.key})`,
      state: sensitive ? 'masked' : 'value', unit: def?.unit ?? null, origin: st.origin, originLabel: originLabel(st.origin), updatedAt: st.updatedAt,
      note: [
        st.from === 'key' ? 'clé canonique' : st.from === 'alias' ? `alias historique ${st.fromName}` : `repli colonne miroir ${st.fromName}`,
        st.source ? `source ${st.source}` : null, st.normalized === false ? 'valeur hors format (brute)' : null,
        sensitive ? 'donnée sensible (registre) masquée' : null,
      ].filter(Boolean).join(' ; '),
    };
    if (!sensitive) { f.raw = st.value; f.display = canonicalDisplay(def, st.value); }
    return f;
  });
}

/** Comparaison canonique ↔ colonne miroir (une ligne par miroir déclaré). */
function mirrorField(key: string, canonical: unknown, mirrorTable: string, mirrorColumn: string, mirrorRaw: unknown, mirrorAsCanonical: unknown): DossierField {
  const def = getField(key);
  if (def?.sensitive) {
    return { table: mirrorTable, column: mirrorColumn, label: `Miroir de ${def.label} (${key})`, state: 'masked', note: 'donnée sensible (registre) : comparaison non rendue' };
  }
  const status = mirrorRaw === undefined ? 'colonne absente'
    : (mirrorRaw === null || mirrorRaw === '') && (canonical === null || canonical === undefined) ? 'canonique et miroir vides'
      : mirrorRaw === null || mirrorRaw === '' ? 'miroir vide'
        : canonical === null || canonical === undefined ? 'canonique vide (miroir seul)'
          : sameCanonicalValue(key, canonical, mirrorAsCanonical) ? 'identiques' : 'DIVERGENTS';
  const f = columnField(mirrorTable, mirrorColumn, mirrorRaw, undefined, `Miroir de ${def?.label ?? key} (${key})`);
  f.note = `${status} — canonique : ${canonical === null || canonical === undefined ? 'vide' : canonicalDisplay(def, canonical)} ; miroir converti : ${mirrorAsCanonical === null || mirrorAsCanonical === undefined ? 'vide' : canonicalDisplay(def, mirrorAsCanonical)}`;
  return f;
}

// ── Sections communes de preuves ────────────────────────────────────────────

/** Preuves, faits, écritures canoniques, cartes « À traiter » et décisions d'une CIBLE (bien / équipement / pièce). */
async function targetEvidence(ctx: Ctx, target: 'ASSET' | 'EQUIPMENT' | 'ROOM', id: number): Promise<void> {
  const A = ctx.accountId;
  const lower = target.toLowerCase();
  const evidenceWhere = target === 'ASSET'
    ? `account_id = $1 AND asset_id = $2 AND (target_type IS NULL OR target_type = 'ASSET')`
    : `account_id = $1 AND target_type = '${target}' AND target_entity_id = $2`;
  await tableSection(ctx, 'field-evidence', 'preuves', 'Preuves de champ (field_evidence) — toutes, y compris retirées', 'field_evidence',
    `SELECT * FROM field_evidence WHERE ${evidenceWhere} ORDER BY coalesce(canonical_key, field_key), extracted_at DESC NULLS LAST, id DESC`, [A, id],
    'status / lifecycle_status : décision et cycle de vie ; source_type + source_id : document ou saisie d’origine ; evidence_origin : T1 (extraction), saisie, règle.');
  if (target !== 'ASSET') {
    await tableSection(ctx, 'document-facts', 'preuves', 'Faits documentaires ciblés (document_facts)', 'document_facts',
      `SELECT * FROM document_facts WHERE account_id = $1 AND target_type = '${target}' AND target_entity_id = $2 ORDER BY file_id, id`, [A, id]);
  }
  await tableSection(ctx, 'canonical-writes', 'preuves', 'Écritures canoniques (canonical_field_writes) — historique', 'canonical_field_writes',
    target === 'ASSET'
      ? `SELECT * FROM canonical_field_writes WHERE account_id = $1 AND asset_id = $2 AND coalesce(upper(target_type), 'ASSET') = 'ASSET' ORDER BY created_at DESC, id DESC`
      : `SELECT * FROM canonical_field_writes WHERE account_id = $1 AND upper(target_type) = '${target}' AND target_id = $2 ORDER BY created_at DESC, id DESC`,
    [A, id], 'origin : USER, ADMIN, DOCUMENT_EXTRACTION (T1), RECONCILIATION (T3), SYSTEM_RULE (règle déterministe).');
  await tableSection(ctx, 'ai-field-updates', 'preuves', 'Mises à jour IA (ai_field_updates)', 'ai_field_updates',
    target === 'ASSET'
      ? `SELECT * FROM ai_field_updates WHERE account_id = $1 AND asset_id = $2 AND coalesce(upper(target_type), 'ASSET') = 'ASSET' ORDER BY created_at DESC, id DESC`
      : `SELECT * FROM ai_field_updates WHERE account_id = $1 AND upper(target_type) = '${target}' AND target_id = $2 ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'to-process', 'preuves', 'Cartes « À traiter » (to_process_actions) et propositions', 'to_process_actions',
    `SELECT * FROM to_process_actions WHERE account_id = $1 AND upper(target_type) = '${target}' AND target_id = $2 ORDER BY resolved_at DESC NULLS FIRST, id DESC`, [A, id],
    'proposals_json : valeurs proposées (evidenceIds → field_evidence.id) et valeur en place ; trigger_context : contexte du déclenchement.');
  await tableSection(ctx, 'to-process-events', 'preuves', 'Historique des cartes « À traiter » (to_process_action_events)', 'to_process_action_events',
    `SELECT e.* FROM to_process_action_events e JOIN to_process_actions a ON a.id = e.action_id AND a.account_id = $1
      WHERE upper(a.target_type) = '${target}' AND a.target_id = $2 ORDER BY e.created_at DESC, e.id DESC`, [A, id]);
  await tableSection(ctx, 'to-process-decisions', 'preuves', 'Décisions du moteur « À traiter » (to_process_decisions)', 'to_process_decisions',
    `SELECT * FROM to_process_decisions WHERE account_id = $1 AND upper(target_type) = '${target}' AND target_id = $2 ORDER BY last_seen_at DESC NULLS LAST, id DESC`, [A, id]);
  await tableSection(ctx, 't3-states', 'preuves', 'États de réconciliation continue T3 (t3_reconciliation_states)', 't3_reconciliation_states',
    `SELECT * FROM t3_reconciliation_states WHERE account_id = $1 AND subject_id = $2 AND lower(subject_type) IN ('${lower}', '${target}') ORDER BY evaluated_at DESC NULLS LAST, relation, subject_type`, [A, id]);
  await tableSection(ctx, 'execution-reports', 'preuves', 'Rapports d’exécution T1 / T3 (ai_execution_reports) — synthèse', 'ai_execution_reports',
    target === 'ASSET'
      ? `SELECT id, treatment, scope, status, report_complete, trigger_code, job_id, file_id, asset_id, target_type, target_id, entry_count, counters, created_at
           FROM ai_execution_reports WHERE account_id = $1 AND asset_id = $2 ORDER BY created_at DESC, id DESC`
      : `SELECT id, treatment, scope, status, report_complete, trigger_code, job_id, file_id, asset_id, target_type, target_id, entry_count, counters, created_at
           FROM ai_execution_reports WHERE account_id = $1 AND upper(target_type) = '${target}' AND target_id = $2 ORDER BY created_at DESC, id DESC`,
    [A, id], 'Contenu détaillé : BO › Exécutions & logs › rapport (consultation journalisée).');
}

// ── Relations communes ──────────────────────────────────────────────────────

const OP_REL = (filter: string) => `
  SELECT 'operation' AS type, o.id, coalesce(o.technical_label, o.type_code, 'Opération') AS label, x.nature, o.status || CASE WHEN o.merged_into_operation_id IS NOT NULL THEN ' (fusionnée)' WHEN o.invalidated_at IS NOT NULL THEN ' (invalidée)' ELSE '' END AS status,
         x.origin, x.via
    FROM (${filter}) x JOIN business_operations o ON o.id = x.op_id AND o.account_id = $1
   ORDER BY o.id, x.nature, x.via`;

// ── Constructeurs par type ──────────────────────────────────────────────────

async function assetDossier(ctx: Ctx, id: number): Promise<EntityDossier['entity']> {
  const A = ctx.accountId;
  const fullRow = await oneRow(ctx.q, `SELECT * FROM assets WHERE id = $1 AND account_id = $2`, [id, A]);
  if (!fullRow) throw new EntityNotFoundError();
  // Lecteur canonique sur la ligne réelle ; tout rendu sur la ligne masquée.
  const row = maskAssetRow(fullRow);
  const deleted = row.deleted_at != null;
  const statusLabel = `${ASSET_STATUS_LABELS[String(row.status) as keyof typeof ASSET_STATUS_LABELS] ?? str(row.status) ?? 'NULL'}${deleted ? ' — supprimé logiquement' : ''}`;

  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Identité et état' }, async () => ({
    fields: pick('assets', row, [['id', 'Identifiant'], ['name', 'Nom'], ['category', 'Catégorie'], ['subtype', 'Sous-type'], ['status', 'Statut'],
      ['purchase_date', 'Date d’achat (colonne)'], ['purchase_price_cents', 'Prix d’achat (colonne miroir)'], ['estimated_value_cents', 'Valeur estimée (colonne)'],
      ['warranty_end_date', 'Fin de garantie (colonne)'], ['created_at', 'Créé le'], ['updated_at', 'Modifié le'], ['deleted_at', 'Supprimé le']]),
  }));
  const state = buildCanonicalAssetState(fullRow as AssetRowJson);
  await section(ctx, { id: 'canonique', tab: 'synthese', title: 'Valeurs canoniques (lecteur canonique du bien)', description: 'Lecture `buildCanonicalAssetState` : fiche, puis alias historiques, puis colonnes miroirs.' },
    async () => ({ fields: canonicalFields('assets', state.fields) }));
  await section(ctx, { id: 'miroirs', tab: 'synthese', title: 'Colonnes miroirs : comparaison avec la valeur canonique' }, async () => {
    const fields: DossierField[] = [];
    for (const key of Object.keys(state.fields).concat(['acquisitionPrice', 'acquisitionDate']).filter((k, i, a) => a.indexOf(k) === i)) {
      const def = getField(key);
      for (const m of def?.mirrorColumns ?? []) {
        const raw = m.column in row ? row[m.column] : undefined;
        fields.push(mirrorField(key, state.fields[key]?.value ?? null, 'assets', m.column, raw, fromMirrorColumn(m, raw)));
      }
    }
    return { fields };
  });
  if (!deleted) {
    await section(ctx, { id: 'tco', tab: 'synthese', title: 'Coût de possession (diagnostic TCO existant, recalculé en lecture)',
      description: 'Moteur TCO existant (readAssetTco), recalculé à l’instant de la lecture (hors instantané de la transaction du dossier). Toutes les lignes économiques.' }, async () => {
      const { readAssetTco } = await import('@/services/business-operations/tco/service');
      const { entries: _entries, ...tco } = await readAssetTco(A, id);
      void _entries;
      const s = tco.summary as unknown as Row;
      return {
        fields: [
          columnField('tco', 'status', tco.status, undefined, 'Statut du calcul'),
          ...Object.keys(s).map((k) => columnField('tco.summary', k, s[k], s, k)),
          columnField('tco', 'reliability', tco.reliability, undefined, 'Fiabilité (avertissements, anomalies)'),
        ],
        table: registerStatic(ctx, 'tco', 'tco.lines', tco.lines as unknown as Row[]),
      };
    });
  }

  await section(ctx, { id: 'bdd-assets', tab: 'bdd', title: 'assets — colonnes persistées' }, async () => ({ fields: bddFields('assets', { ...row, key_characteristics: row.key_characteristics == null ? null : '(voir section key_characteristics)' }) }));
  await section(ctx, { id: 'bdd-kc', tab: 'bdd', title: 'assets.key_characteristics — fiche canonique (clés et métadonnées)' }, async () => ({ fields: kcFields('assets', 'key_characteristics', row.key_characteristics) }));
  await tableSection(ctx, 'bdd-additional', 'bdd', 'asset_additional_infos', 'asset_additional_infos', `SELECT * FROM asset_additional_infos WHERE asset_id = $1 AND account_id = $2 ORDER BY asset_id`, [id, A]);
  await tableSection(ctx, 'bdd-cil', 'bdd', 'asset_cil_profiles', 'asset_cil_profiles', `SELECT c.* FROM asset_cil_profiles c JOIN assets a ON a.id = c.asset_id AND a.account_id = $2 WHERE c.asset_id = $1 ORDER BY c.id`, [id, A]);
  await tableSection(ctx, 'bdd-custom', 'bdd', 'Champs personnalisés (asset_custom_field_values)', 'asset_custom_field_values',
    `SELECT v.* FROM asset_custom_field_values v JOIN assets a ON a.id = v.asset_id AND a.account_id = $2 WHERE v.asset_id = $1 ORDER BY v.id`, [id, A]);

  await relSection(ctx, 'rel-equipements', 'Équipements du bien', `
    SELECT 'equipment' AS type, e.id, e.name AS label, 'équipement du bien' AS nature,
           coalesce(e.status, '') || CASE WHEN e.archived_at IS NOT NULL THEN ' (archivé)' ELSE '' END AS status, NULL AS origin, 'equipments.asset_id' AS via
      FROM equipments e WHERE e.asset_id = $2 AND $1::int IS NOT NULL ORDER BY e.id`, [A, id]);
  await relSection(ctx, 'rel-pieces', 'Pièces', `
    SELECT 'room' AS type, s.id, s.name AS label, 'pièce du bien' AS nature, s.room_type AS status, NULL AS origin, 'substructures.asset_id' AS via
      FROM substructures s WHERE s.asset_id = $2 AND $1::int IS NOT NULL ORDER BY s.id`, [A, id]);
  await relSection(ctx, 'rel-documents', 'Documents', `
    SELECT 'document' AS type, f.id, coalesce(f.retained_title, f.document_type_code, f.document_type, 'Document') AS label, x.nature,
           coalesce(f.analysis_state, '') || CASE WHEN f.deleted_at IS NOT NULL THEN ' (supprimé)' ELSE '' END AS status, x.origin, x.via
      FROM (SELECT id AS fid, 'rattaché (asset_id)' AS nature, NULL AS origin, 'asset_files.asset_id' AS via FROM asset_files WHERE account_id = $1 AND asset_id = $2
            UNION ALL SELECT id, 'lié (linked_asset_id)', NULL, 'asset_files.linked_asset_id' FROM asset_files WHERE account_id = $1 AND linked_asset_id = $2
            UNION ALL SELECT file_id, 'lien ' || coalesce(link_role, '') || ' (' || coalesce(status, '') || ')', origin, 'document_asset_links' FROM document_asset_links WHERE account_id = $1 AND asset_id = $2) x
      JOIN asset_files f ON f.id = x.fid AND f.account_id = $1
     ORDER BY f.id, x.via, x.nature`, [A, id]);
  await relSection(ctx, 'rel-agenda', 'Échéances (agenda)', `
    SELECT 'agenda' AS type, i.id, i.title AS label, 'échéance liée au bien' AS nature, i.manual_status AS status, i.origin_type AS origin, 'agenda_asset_links' AS via
      FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1 WHERE l.asset_id = $2 ORDER BY i.start_date, i.id`, [A, id]);
  await relSection(ctx, 'rel-deadlines', 'Échéances historiques (deadlines)', `
    SELECT 'deadline' AS type, d.id, d.label, 'échéance historique' AS nature, CASE WHEN d.is_done THEN 'faite' ELSE 'ouverte' END AS status, NULL AS origin, 'deadlines.asset_id' AS via
      FROM deadlines d WHERE d.account_id = $1 AND (d.asset_id = $2 OR d.linked_asset_id = $2) ORDER BY d.deadline_date, d.id`, [A, id]);
  await relSection(ctx, 'rel-operations', 'Opérations', OP_REL(`
    SELECT operation_id AS op_id, 'bien ' || link_role || CASE WHEN active THEN '' ELSE ' (lien inactif)' END AS nature, authority AS origin, 'business_operation_asset_links' AS via
      FROM business_operation_asset_links WHERE account_id = $1 AND asset_id = $2`), [A, id]);

  await targetEvidence(ctx, 'ASSET', id);
  await tableSection(ctx, 'reco-decisions', 'preuves', 'Décisions de réconciliation T3 du bien (reconciliation_decisions)', 'reconciliation_decisions',
    `SELECT * FROM reconciliation_decisions WHERE account_id = $1 AND asset_id = $2 ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'reco-runs', 'preuves', 'Passages de réconciliation (reconciliation_runs)', 'reconciliation_runs',
    `SELECT * FROM reconciliation_runs WHERE account_id = $1 AND asset_id = $2 ORDER BY started_at DESC NULLS LAST, id DESC`, [A, id]);
  // Lot 81C (complément 81A) : registre des incohérences et contrôle exhaustif T3 de l'onglet Informations (lot 76J).
  await tableSection(ctx, 'inconsistencies', 'preuves', 'Registre des incohérences (inconsistency_registry) — toutes, y compris résolues', 'inconsistency_registry',
    `SELECT * FROM inconsistency_registry WHERE account_id = $1 AND asset_id = $2 ORDER BY created_at DESC NULLS LAST, id DESC`, [A, id],
    'current_value / proposed_value : valeur en place et proposée (masquées si la clé est sensible) ; current_evidence_ids / proposed_evidence_ids → field_evidence.id ; status / resolution : décision.');
  await tableSection(ctx, 't3-information-checks', 'preuves', 'Contrôle T3 de l’onglet Informations (t3_information_checks)', 't3_information_checks',
    `SELECT * FROM t3_information_checks WHERE account_id = $1 AND asset_id = $2 ORDER BY asset_id`, [A, id],
    'Version de contrôle appliquée, synthèse et arbitrages croisés déjà proposés (lot 76J).');
  await tableSection(ctx, 'events', 'preuves', 'Historique du bien (events)', 'events',
    `SELECT * FROM events WHERE account_id = $1 AND (asset_id = $2 OR linked_asset_id = $2) AND equipment_id IS NULL ORDER BY date_evenement DESC NULLS LAST, id DESC`, [A, id]);
  await tableSection(ctx, 'space-moves', 'preuves', 'Déplacements entre espaces (asset_space_moves)', 'asset_space_moves',
    `SELECT * FROM asset_space_moves WHERE asset_id = $2 AND (from_account_id = $1 OR to_account_id = $1) ORDER BY created_at DESC, id DESC`, [A, id]);

  return { type: 'asset', typeLabel: ENTITY_LABELS.asset, id, table: 'assets', name: str(row.name) ?? `Bien #${id}`, status: str(row.status), statusLabel };
}

async function entityRunner(q: DiagQuery): Promise<SqlRunner> {
  return { unsafe: (sql: string, params?: never[]) => q(sql, params ?? []) } as SqlRunner;
}

async function equipmentDossier(ctx: Ctx, id: number): Promise<EntityDossier['entity']> {
  const A = ctx.accountId;
  const row = await oneRow(ctx.q, `SELECT e.* FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 WHERE e.id = $1`, [id, A]);
  if (!row) throw new EntityNotFoundError();
  const [parent] = await ctx.q(`SELECT id, name, deleted_at, status FROM assets WHERE id = $1 AND account_id = $2`, [row.asset_id, A]);
  const archived = row.archived_at != null;
  const statusLabel = `${str(row.status) ?? 'NULL'}${archived ? ' — archivé' : ''}${parent?.deleted_at ? ' — bien parent supprimé' : ''}`;

  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Identité et état de l’équipement', description: 'Données PROPRES à l’équipement (table equipments) — jamais celles du bien parent.' }, async () => ({
    fields: pick('equipments', row, [['id', 'Identifiant'], ['name', 'Nom'], ['type', 'Type'], ['category', 'Catégorie'], ['status', 'Statut'],
      ['asset_id', 'Bien parent (id)'], ['substructure_id', 'Pièce (id)'], ['purchase_price_cents', 'Prix d’achat — colonne miroir'], ['estimated_value_cents', 'Valeur estimée — colonne miroir'],
      ['archived_at', 'Archivé le'], ['created_at', 'Créé le'], ['updated_at', 'Modifié le']]),
  }));

  const run = await entityRunner(ctx.q);
  const entityRow = await loadEntityRow(run, { type: 'EQUIPMENT', id }, A).catch(() => null);
  const state = entityRow ? buildCanonicalEntityState(entityRow) : null;
  await section(ctx, { id: 'canonique', tab: 'synthese', title: 'Valeurs canoniques de l’équipement (lecteur canonique)', description: 'Lecture `loadEntityRow` + `buildCanonicalEntityState` : fiche 0227, puis colonne miroir.' }, async () => (
    state ? { fields: canonicalFields('equipments', state.fields) }
      : { fields: [{ table: 'equipments', column: 'key_characteristics', label: 'Vue canonique', state: 'not_loaded', note: parent?.deleted_at ? 'bien parent supprimé : le lecteur canonique ne sert que les biens actifs' : 'lecteur canonique indisponible' } as DossierField] }
  ));
  await section(ctx, { id: 'miroirs', tab: 'synthese', title: 'Colonnes miroirs : comparaison avec la valeur canonique' }, async () => ({
    fields: Object.entries(ENTITY_MIRRORS.EQUIPMENT).map(([key, m]) => {
      const raw = entityRow ? entityRow.columns[mirrorId(m)] : (m.table === 'equipments' && m.column in row ? row[m.column] : undefined);
      return mirrorField(key, state?.fields[key]?.value ?? null, m.table, m.column, raw, fromEntityMirror(key, m, raw));
    }),
  }));
  await section(ctx, { id: 'prix-achat', tab: 'synthese', title: 'Prix d’achat : canonique, miroir, preuves et propositions d’arbitrage', description: 'Comparaison du ticket §4 (Équipements) : toutes les sources du prix d’achat de CET équipement.' }, async () => {
    const fields: DossierField[] = [];
    const can = state?.fields.acquisitionPrice;
    fields.push(can ? canonicalFields('equipments', { acquisitionPrice: can })[0] : { table: 'equipments', column: 'key_characteristics', path: 'acquisitionPrice', label: 'Prix d’achat canonique', state: state ? 'absent' : 'not_loaded', note: state ? 'aucune valeur canonique' : 'lecteur canonique indisponible' });
    fields.push(columnField('equipments', 'purchase_price_cents', row.purchase_price_cents, row, 'Prix d’achat — colonne miroir'));
    const ev = await jsonRows(ctx.q, `SELECT id, value_json, normalized_value, raw_value, canonical_unit, source_type, source_id, evidence_origin, status, lifecycle_status, confidence, extracted_at
                              FROM field_evidence WHERE account_id = $1 AND target_type = 'EQUIPMENT' AND target_entity_id = $2
                               AND (canonical_key = 'acquisitionPrice' OR field_key = 'acquisitionPrice') ORDER BY extracted_at DESC NULLS LAST, id DESC`, [A, id]);
    for (const e of ev) {
      const f = columnField('field_evidence', 'value_json', e.value_json, e, `Preuve #${e.id} (${str(e.source_type) ?? '?'} #${str(e.source_id) ?? '?'})`);
      f.unit = str(e.canonical_unit);
      f.origin = str(e.evidence_origin);
      f.note = `normalisée=${str(e.normalized_value) ?? 'NULL'} ; brute=${str(e.raw_value) ?? 'NULL'} ; statut=${str(e.status)} / ${str(e.lifecycle_status) ?? 'NULL'} ; confiance=${str(e.confidence) ?? 'NULL'}`;
      fields.push(f);
    }
    const facts = await jsonRows(ctx.q, `SELECT id, file_id, value_number, value_text, value_unit, canonical_unit, raw_value, label, confidence, status
                                 FROM document_facts WHERE account_id = $1 AND target_type = 'EQUIPMENT' AND target_entity_id = $2 AND canonical_key = 'acquisitionPrice'
                                 ORDER BY id`, [A, id]);
    for (const x of facts) {
      const f = columnField('document_facts', 'value_number', x.value_number, x, `Fait T1 #${x.id} (document #${x.file_id})`);
      f.unit = str(x.value_unit) ?? str(x.canonical_unit);
      f.origin = 'DOCUMENT_EXTRACTION';
      f.originLabel = originLabel('DOCUMENT_EXTRACTION');
      f.note = `libellé=${str(x.label) ?? 'NULL'} ; brute=${str(x.raw_value) ?? 'NULL'} ; texte=${str(x.value_text) ?? 'NULL'} ; statut=${str(x.status)}`;
      fields.push(f);
    }
    const cards = await jsonRows(ctx.q, `SELECT id, rule_code, action_kind, question, proposals_json, trigger_context, resolved_at, resolution_reason, created_at
                                 FROM to_process_actions WHERE account_id = $1 AND upper(target_type) = 'EQUIPMENT' AND target_id = $2 AND field_key = 'acquisitionPrice'
                                 ORDER BY resolved_at DESC NULLS FIRST, id DESC`, [A, id]);
    for (const c of cards) {
      const f = columnField('to_process_actions', 'proposals_json', c.proposals_json, c, `Carte « À traiter » #${c.id} (${str(c.rule_code)}) — propositions`);
      f.note = `${c.resolved_at ? `résolue ${str(c.resolution_reason) ?? ''}` : 'OUVERTE'} ; question=${str(c.question) ?? ''}`;
      f.origin = 'RECONCILIATION';
      f.originLabel = originLabel('RECONCILIATION');
      fields.push(f);
    }
    return { fields };
  });

  await section(ctx, { id: 'bdd-equipments', tab: 'bdd', title: 'equipments — colonnes persistées' }, async () => ({ fields: bddFields('equipments', { ...row, key_characteristics: row.key_characteristics == null ? null : '(voir section key_characteristics)' }) }));
  await section(ctx, { id: 'bdd-kc', tab: 'bdd', title: 'equipments.key_characteristics — fiche canonique (clés et métadonnées)' }, async () => ({ fields: kcFields('equipments', 'key_characteristics', row.key_characteristics) }));
  await tableSection(ctx, 'bdd-specs', 'bdd', 'equipment_cil_specs', 'equipment_cil_specs', `SELECT * FROM equipment_cil_specs WHERE equipment_id = $1 AND $2::int IS NOT NULL ORDER BY id`, [id, A]);
  await tableSection(ctx, 'bdd-suppliers', 'bdd', 'equipment_suppliers', 'equipment_suppliers', `SELECT * FROM equipment_suppliers WHERE equipment_id = $1 AND $2::int IS NOT NULL ORDER BY supplier_id, relationship_type`, [id, A]);

  await relSection(ctx, 'rel-parent', 'Bien parent et pièce', `
    SELECT 'asset' AS type, a.id, a.name AS label, 'bien parent' AS nature, a.status || CASE WHEN a.deleted_at IS NOT NULL THEN ' (supprimé)' ELSE '' END AS status, NULL AS origin, 'equipments.asset_id' AS via
      FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.id = $2
    UNION ALL
    SELECT 'room', s.id, s.name, 'pièce de l’équipement', s.room_type, NULL, 'equipments.substructure_id'
      FROM equipments e JOIN substructures s ON s.id = e.substructure_id JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 WHERE e.id = $2`, [A, id]);
  await relSection(ctx, 'rel-documents', 'Documents', `
    SELECT 'document' AS type, f.id, coalesce(f.retained_title, f.document_type_code, f.document_type, 'Document') AS label, x.nature,
           coalesce(f.analysis_state, '') || CASE WHEN f.deleted_at IS NOT NULL THEN ' (supprimé)' ELSE '' END AS status, x.origin, x.via
      FROM (SELECT id AS fid, 'rattaché (equipment_id)' AS nature, NULL AS origin, 'asset_files.equipment_id' AS via FROM asset_files WHERE account_id = $1 AND equipment_id = $2
            UNION ALL SELECT file_id, 'lien ' || coalesce(link_role, '') || ' (' || coalesce(status, '') || ')', origin, 'document_asset_links' FROM document_asset_links WHERE account_id = $1 AND equipment_id = $2
            UNION ALL SELECT DISTINCT file_id, 'source de faits ciblés', 'DOCUMENT_EXTRACTION', 'document_facts.target_entity_id' FROM document_facts WHERE account_id = $1 AND target_type = 'EQUIPMENT' AND target_entity_id = $2
            UNION ALL SELECT DISTINCT source_id, 'source de preuves', 'DOCUMENT_EXTRACTION', 'field_evidence.source_id' FROM field_evidence WHERE account_id = $1 AND target_type = 'EQUIPMENT' AND target_entity_id = $2 AND source_type = 'document') x
      JOIN asset_files f ON f.id = x.fid AND f.account_id = $1
     ORDER BY f.id, x.via, x.nature`, [A, id]);
  await relSection(ctx, 'rel-agenda', 'Échéances et historique', `
    SELECT 'agenda' AS type, i.id, i.title AS label, 'échéance de l’équipement' AS nature, i.manual_status AS status, i.origin_type AS origin, 'agenda_equipment_links' AS via
      FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1 WHERE l.equipment_id = $2
    UNION ALL
    SELECT 'deadline', d.id, d.label, 'échéance historique', CASE WHEN d.is_done THEN 'faite' ELSE 'ouverte' END, NULL, 'deadlines.equipment_id'
      FROM deadlines d WHERE d.account_id = $1 AND d.equipment_id = $2`, [A, id]);
  await relSection(ctx, 'rel-operations', 'Opérations', OP_REL(`
    SELECT operation_id AS op_id, 'équipement' || CASE WHEN active THEN '' ELSE ' (lien inactif)' END AS nature, authority AS origin, 'business_operation_equipment_links' AS via
      FROM business_operation_equipment_links WHERE account_id = $1 AND equipment_id = $2
    UNION ALL
    SELECT operation_id, 'cible de la composante ' || kind || CASE WHEN active THEN '' ELSE ' (inactive)' END, NULL, 'business_operation_financial_components.target_equipment_id'
      FROM business_operation_financial_components WHERE account_id = $1 AND target_equipment_id = $2`), [A, id]);

  await targetEvidence(ctx, 'EQUIPMENT', id);
  await tableSection(ctx, 'events', 'preuves', 'Historique de l’équipement (events)', 'events',
    `SELECT * FROM events WHERE account_id = $1 AND equipment_id = $2 ORDER BY date_evenement DESC NULLS LAST, id DESC`, [A, id]);

  return { type: 'equipment', typeLabel: ENTITY_LABELS.equipment, id, table: 'equipments', name: str(row.name) ?? `Équipement #${id}`, status: str(row.status), statusLabel };
}

async function roomDossier(ctx: Ctx, id: number): Promise<EntityDossier['entity']> {
  const A = ctx.accountId;
  const row = await oneRow(ctx.q, `SELECT s.* FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $2 WHERE s.id = $1`, [id, A]);
  if (!row) throw new EntityNotFoundError();
  const [parent] = await ctx.q(`SELECT deleted_at FROM assets WHERE id = $1 AND account_id = $2`, [row.asset_id, A]);

  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Identité de la pièce', description: 'Table technique substructures (Pièces, décision D-G) — l’ancienne table rooms n’est pas une source métier.' }, async () => ({
    fields: pick('substructures', row, [['id', 'Identifiant'], ['name', 'Nom'], ['room_type', 'Type'], ['area', 'Surface — colonne miroir'], ['asset_id', 'Bien parent (id)'],
      ['legacy_room_id', 'Ancienne pièce (rooms.id, historique)'], ['created_at', 'Créée le'], ['updated_at', 'Modifiée le']]),
  }));
  const run = await entityRunner(ctx.q);
  const entityRow = await loadEntityRow(run, { type: 'ROOM', id }, A).catch(() => null);
  const state = entityRow ? buildCanonicalEntityState(entityRow) : null;
  await section(ctx, { id: 'canonique', tab: 'synthese', title: 'Valeurs canoniques de la pièce (lecteur canonique)' }, async () => (
    state ? { fields: canonicalFields('substructures', state.fields) }
      : { fields: [{ table: 'substructures', column: 'key_characteristics', label: 'Vue canonique', state: 'not_loaded', note: parent?.deleted_at ? 'bien parent supprimé' : 'lecteur canonique indisponible' } as DossierField] }
  ));
  await section(ctx, { id: 'miroirs', tab: 'synthese', title: 'Colonnes miroirs : comparaison avec la valeur canonique' }, async () => ({
    fields: Object.entries(ENTITY_MIRRORS.ROOM).map(([key, m]) => {
      const raw = entityRow ? entityRow.columns[mirrorId(m)] : row[m.column];
      return mirrorField(key, state?.fields[key]?.value ?? null, m.table, m.column, raw, fromEntityMirror(key, m, raw));
    }),
  }));
  await section(ctx, { id: 'bdd-substructures', tab: 'bdd', title: 'substructures — colonnes persistées' }, async () => ({ fields: bddFields('substructures', { ...row, key_characteristics: row.key_characteristics == null ? null : '(voir section key_characteristics)' }) }));
  await section(ctx, { id: 'bdd-kc', tab: 'bdd', title: 'substructures.key_characteristics — fiche canonique' }, async () => ({ fields: kcFields('substructures', 'key_characteristics', row.key_characteristics) }));

  await relSection(ctx, 'rel-parent', 'Bien parent', `
    SELECT 'asset' AS type, a.id, a.name AS label, 'bien parent' AS nature, a.status || CASE WHEN a.deleted_at IS NOT NULL THEN ' (supprimé)' ELSE '' END AS status, NULL AS origin, 'substructures.asset_id' AS via
      FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 WHERE s.id = $2`, [A, id]);
  await relSection(ctx, 'rel-equipements', 'Équipements présents', `
    SELECT 'equipment' AS type, e.id, e.name AS label, 'équipement de la pièce' AS nature, e.status AS status, NULL AS origin, 'equipments.substructure_id' AS via
      FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.substructure_id = $2 ORDER BY e.id`, [A, id]);
  await relSection(ctx, 'rel-documents', 'Documents (directs et par les équipements de la pièce)', `
    SELECT 'document' AS type, f.id, coalesce(f.retained_title, f.document_type_code, f.document_type, 'Document') AS label, x.nature,
           coalesce(f.analysis_state, '') || CASE WHEN f.deleted_at IS NOT NULL THEN ' (supprimé)' ELSE '' END AS status, x.origin, x.via
      FROM (SELECT id AS fid, 'direct (substructure_id)' AS nature, NULL AS origin, 'asset_files.substructure_id' AS via FROM asset_files WHERE account_id = $1 AND substructure_id = $2
            UNION ALL SELECT file_id, 'lien ' || coalesce(link_role, '') || ' (' || coalesce(status, '') || ')', origin, 'document_asset_links.substructure_id' FROM document_asset_links WHERE account_id = $1 AND substructure_id = $2
            UNION ALL SELECT f.id, 'indirect : équipement #' || e.id, NULL, 'asset_files.equipment_id → equipments.substructure_id'
              FROM equipments e JOIN asset_files f ON f.equipment_id = e.id AND f.account_id = $1 WHERE e.substructure_id = $2) x
      JOIN asset_files f ON f.id = x.fid AND f.account_id = $1
     ORDER BY f.id, x.nature, x.via`, [A, id]);
  await relSection(ctx, 'rel-agenda', 'Échéances', `
    SELECT 'agenda' AS type, i.id, i.title AS label, 'échéance de la pièce' AS nature, i.manual_status AS status, i.origin_type AS origin, 'agenda_room_links' AS via
      FROM agenda_room_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1 WHERE l.substructure_id = $2
    UNION ALL
    SELECT 'deadline', d.id, d.label, 'échéance historique', CASE WHEN d.is_done THEN 'faite' ELSE 'ouverte' END, NULL, 'deadlines.substructure_id'
      FROM deadlines d WHERE d.account_id = $1 AND d.substructure_id = $2`, [A, id]);

  await targetEvidence(ctx, 'ROOM', id);
  await tableSection(ctx, 'events', 'preuves', 'Historique de la pièce (events)', 'events',
    `SELECT * FROM events WHERE account_id = $1 AND substructure_id = $2 ORDER BY date_evenement DESC NULLS LAST, id DESC`, [A, id]);

  return { type: 'room', typeLabel: ENTITY_LABELS.room, id, table: 'substructures', name: str(row.name) ?? `Pièce #${id}`, status: parent?.deleted_at ? 'BIEN_SUPPRIME' : null, statusLabel: parent?.deleted_at ? 'bien parent supprimé' : 'active' };
}

async function documentDossier(ctx: Ctx, id: number): Promise<EntityDossier['entity']> {
  const A = ctx.accountId;
  const row = await oneRow(ctx.q, `SELECT * FROM asset_files WHERE id = $1 AND account_id = $2`, [id, A]);
  if (!row) throw new EntityNotFoundError();
  const deleted = row.deleted_at != null;
  const name = str(row.retained_title) ?? `${str(row.document_type_code) ?? str(row.document_type) ?? 'Document'}${row.document_date ? ` du ${String(row.document_date).split('-').reverse().join('/')}` : ''}`;

  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Document : classification, montants et état',
    description: 'Données structurées persistées. Le fichier original (nom, emplacement de stockage, URL) et son texte intégral ne sont jamais servis par le back-office.' }, async () => ({
    fields: pick('asset_files', row, [['id', 'Identifiant'], ['retained_title', 'Titre retenu'], ['document_type_code', 'Type (code)'], ['document_type', 'Type (historique)'],
      ['rubric_code', 'Rubrique'], ['type_origin', 'Origine du type'], ['type_user_validated', 'Type validé par l’utilisateur'], ['document_date', 'Date du document'],
      ['amount_cents', 'Montant documentaire (colonne)'], ['supplier', 'Fournisseur'], ['asset_id', 'Bien (asset_id)'], ['linked_asset_id', 'Bien lié'],
      ['equipment_id', 'Équipement'], ['substructure_id', 'Pièce'], ['analysis_state', 'État d’analyse'], ['analysis_fail_reason', 'Motif d’échec'], ['last_analysis_at', 'Dernière analyse'],
      ['is_web_link', 'Lien web'], ['file_extension', 'Extension'], ['mime_type', 'Type MIME'], ['size', 'Taille (octets)'], ['filename', 'Nom du fichier'], ['extracted_text', 'Texte extrait'],
      ['uploaded_at', 'Déposé le'], ['deleted_at', 'Supprimé le'], ['grouped_into_file_id', 'Regroupé dans le document']]),
  }));
  await tableSection(ctx, 'extractions', 'synthese', 'Extractions T1 (document_extractions) — montant, devise, date, fournisseur', 'document_extractions',
    `SELECT * FROM document_extractions WHERE account_id = $1 AND file_id = $2 ORDER BY extracted_at DESC NULLS LAST, id DESC`, [A, id],
    'amount_cents + currency : montant documentaire extrait ; full_text masqué (longueur seule).');
  await tableSection(ctx, 'field-values', 'synthese', 'Champs documentaires validés (document_field_values)', 'document_field_values',
    `SELECT * FROM document_field_values WHERE account_id = $1 AND file_id = $2 ORDER BY field_key, id`, [A, id]);

  await section(ctx, { id: 'bdd-asset-files', tab: 'bdd', title: 'asset_files — colonnes persistées' }, async () => ({ fields: bddFields('asset_files', row) }));
  await tableSection(ctx, 'bdd-runs', 'bdd', 'Analyses (document_analysis_runs)', 'document_analysis_runs',
    `SELECT * FROM document_analysis_runs WHERE account_id = $1 AND asset_file_id = $2 ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'bdd-cil', 'bdd', 'document_cil_metadata', 'document_cil_metadata',
    `SELECT m.* FROM document_cil_metadata m JOIN asset_files f ON f.id = m.asset_file_id AND f.account_id = $1 WHERE m.asset_file_id = $2 ORDER BY m.id`, [A, id]);

  await relSection(ctx, 'rel-cibles', 'Biens, équipements et pièces associés', `
    SELECT * FROM (
      SELECT 'asset' AS type, a.id, a.name AS label, 'bien (asset_id)' AS nature, a.status AS status, NULL AS origin, 'asset_files.asset_id' AS via
        FROM assets a WHERE a.id = (SELECT asset_id FROM asset_files WHERE id = $2) AND a.account_id = $1
      UNION ALL SELECT 'asset', a.id, a.name, 'bien lié (linked_asset_id)', a.status, NULL, 'asset_files.linked_asset_id'
        FROM assets a WHERE a.id = (SELECT linked_asset_id FROM asset_files WHERE id = $2) AND a.account_id = $1
      UNION ALL SELECT 'equipment', e.id, e.name, 'équipement (equipment_id)', e.status, NULL, 'asset_files.equipment_id'
        FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.id = (SELECT equipment_id FROM asset_files WHERE id = $2)
      UNION ALL SELECT 'room', s.id, s.name, 'pièce (substructure_id)', s.room_type, NULL, 'asset_files.substructure_id'
        FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 WHERE s.id = (SELECT substructure_id FROM asset_files WHERE id = $2)
      UNION ALL SELECT CASE WHEN l.equipment_id IS NOT NULL THEN 'equipment' WHEN l.substructure_id IS NOT NULL THEN 'room' ELSE 'asset' END,
             coalesce(l.equipment_id, l.substructure_id, l.asset_id), coalesce(e.name, s.name, a.name),
             'lien ' || coalesce(l.link_role, '') || CASE WHEN l.removed_at IS NOT NULL THEN ' (retiré)' ELSE '' END, l.status, l.origin, 'document_asset_links#' || l.id
        FROM document_asset_links l
        LEFT JOIN assets a ON a.id = l.asset_id AND a.account_id = $1
        LEFT JOIN equipments e ON e.id = l.equipment_id LEFT JOIN assets ea ON ea.id = e.asset_id AND ea.account_id = $1
        LEFT JOIN substructures s ON s.id = l.substructure_id
       WHERE l.account_id = $1 AND l.file_id = $2 AND coalesce(l.equipment_id, l.substructure_id, l.asset_id) IS NOT NULL
         AND (l.equipment_id IS NULL OR ea.id IS NOT NULL) AND (l.asset_id IS NULL OR a.id IS NOT NULL)
      UNION ALL SELECT 'document', g.id, coalesce(g.retained_title, g.document_type_code, 'Document'), 'regroupé dans', g.analysis_state, NULL, 'asset_files.grouped_into_file_id'
        FROM asset_files g WHERE g.id = (SELECT grouped_into_file_id FROM asset_files WHERE id = $2) AND g.account_id = $1
      UNION ALL SELECT 'document', g.id, coalesce(g.retained_title, g.document_type_code, 'Document'), 'a absorbé', g.analysis_state, NULL, 'asset_files.grouped_into_file_id'
        FROM asset_files g WHERE g.grouped_into_file_id = $2 AND g.account_id = $1
    ) r`, [A, id]);
  await relSection(ctx, 'rel-agenda', 'Échéances générées ou associées', `
    SELECT 'agenda' AS type, i.id, i.title AS label, x.nature, i.manual_status AS status, x.origin, x.via
      FROM (SELECT agenda_item_id AS iid, 'document lié' AS nature, NULL AS origin, 'agenda_file_links' AS via FROM agenda_file_links WHERE asset_file_id = $2
            UNION ALL SELECT agenda_item_id, 'source : ' || coalesce(effect_type, '') || coalesce(' / ' || source_role, ''), 'DOCUMENT_EXTRACTION', 'agenda_item_sources' FROM agenda_item_sources WHERE asset_file_id = $2) x
      JOIN agenda_items i ON i.id = x.iid AND i.account_id = $1
     ORDER BY i.id, x.via, x.nature`, [A, id]);
  await relSection(ctx, 'rel-operations', 'Opérations générées ou associées', OP_REL(`
    SELECT operation_id AS op_id, 'source ' || coalesce(source_role, source_kind) || CASE WHEN active THEN '' ELSE ' (supersédée)' END AS nature, authority AS origin, 'business_operation_sources' AS via
      FROM business_operation_sources WHERE account_id = $1 AND source_kind = 'DOCUMENT' AND source_entity_key = ($2::int)::text
    UNION ALL
    SELECT t3_operation_id, 'candidat T1 ' || candidate_key || ' → issue T3 ' || coalesce(t3_outcome, 'en attente'), 'RECONCILIATION', 'document_operation_candidates.t3_operation_id'
      FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND t3_operation_id IS NOT NULL`), [A, id]);

  await interventionDuplicatesSections(ctx, id);
  await tableSection(ctx, 'facts', 'preuves', 'Faits T1 (document_facts) — valeurs brutes et normalisées', 'document_facts',
    `SELECT * FROM document_facts WHERE account_id = $1 AND file_id = $2 ORDER BY extraction_id DESC NULLS LAST, id`, [A, id]);
  await tableSection(ctx, 'unresolved', 'preuves', 'Faits non résolus (document_unresolved_facts)', 'document_unresolved_facts',
    `SELECT * FROM document_unresolved_facts WHERE account_id = $1 AND file_id = $2 ORDER BY id`, [A, id]);
  await tableSection(ctx, 'source-units', 'preuves', 'Unités sources (document_source_units)', 'document_source_units',
    `SELECT * FROM document_source_units WHERE account_id = $1 AND file_id = $2 ORDER BY extraction_id DESC NULLS LAST, page NULLS LAST, ordinal NULLS LAST, id`, [A, id],
    'Couche de preuve du T1 : unité, page, libellé, valeur, couverture.');
  await tableSection(ctx, 'field-evidence', 'preuves', 'Preuves de champ issues du document (field_evidence)', 'field_evidence',
    `SELECT * FROM field_evidence WHERE account_id = $1 AND source_type = 'document' AND source_id = $2 ORDER BY coalesce(canonical_key, field_key), id`, [A, id]);
  await tableSection(ctx, 'proposals', 'preuves', 'Propositions d’analyse (document_analysis_proposals)', 'document_analysis_proposals',
    `SELECT * FROM document_analysis_proposals WHERE account_id = $1 AND asset_file_id = $2 ORDER BY id`, [A, id]);
  await tableSection(ctx, 'candidates', 'preuves', 'Candidats d’Opération T1 et issue T3 (document_operation_candidates)', 'document_operation_candidates',
    `SELECT * FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'ai-field-updates', 'preuves', 'Écritures IA issues du document (ai_field_updates)', 'ai_field_updates',
    `SELECT * FROM ai_field_updates WHERE account_id = $1 AND asset_file_id = $2 ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'canonical-writes', 'preuves', 'Écritures canoniques sourcées par le document (canonical_field_writes)', 'canonical_field_writes',
    `SELECT * FROM canonical_field_writes WHERE account_id = $1 AND source_type IN ('document', 'DOCUMENT') AND source_id = ($2::int)::text ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'to-process', 'preuves', 'Cartes « À traiter » du document', 'to_process_actions',
    `SELECT * FROM to_process_actions WHERE account_id = $1 AND upper(target_type) = 'DOCUMENT' AND target_id = $2 ORDER BY resolved_at DESC NULLS FIRST, id DESC`, [A, id]);
  await tableSection(ctx, 'execution-reports', 'preuves', 'Rapports d’exécution T1 / T3 (ai_execution_reports) — synthèse', 'ai_execution_reports',
    `SELECT id, treatment, scope, status, report_complete, trigger_code, job_id, file_id, asset_id, target_type, target_id, entry_count, counters, created_at
       FROM ai_execution_reports WHERE account_id = $1 AND file_id = $2 ORDER BY created_at DESC, id DESC`, [A, id],
    'Contenu détaillé : BO › Exécutions & logs › rapport (consultation journalisée).');

  return { type: 'document', typeLabel: ENTITY_LABELS.document, id, table: 'asset_files', name, status: str(row.analysis_state), statusLabel: `${str(row.analysis_state) ?? 'NULL'}${deleted ? ' — supprimé logiquement' : ''}` };
}

// ── Lot 76H : diagnostic des doublons d'interventions (cause réelle, §3.1) ──

/**
 * Sections « Doublons d'interventions » d'un DOCUMENT : par date, verdict
 * (une Opération / plusieurs / aucune) et données qui le fondent — candidats
 * T1 et issue T3, Opérations actives et exclusivité, événements, décisions
 * T4 (historique, retraits), cartes de rapprochement, journal 0591. Lecture
 * seule, bornée au compte (transaction READ ONLY du dossier).
 */
async function interventionDuplicatesSections(ctx: Ctx, fileId: number): Promise<void> {
  const A = ctx.accountId;
  const { classifyDuplicateCause } = await import('@/services/business-operations/diagnostics/agenda-duplicates');
  const { EXCLUSIVE_FILES_RAW } = await import('@/services/business-operations/agenda-projection/service');
  const itemsSql = `
    SELECT i.id, i.title, i.start_date::text AS date, i.business_type, i.event_nature, i.business_operation_id::int AS business_operation_id,
           i.projection_origin, i.is_automatic, i.is_automatic_modified, i.manual_status, i.requires_qualification, i.occurrence_nature,
           i.confirmation_mode, i.origin_type, i.origin_ref_type, i.origin_ref_id, i.origin_field_key, i.functional_key, i.created_at, i.updated_at
      FROM agenda_items i
     WHERE i.account_id = $1 AND (
           (i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2)
        OR EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = $2)
        OR EXISTS (SELECT 1 FROM agenda_item_sources x WHERE x.agenda_item_id = i.id AND x.asset_file_id = $2))
     ORDER BY i.start_date NULLS LAST, i.id`;
  const candSql = `
    SELECT dc.id, dc.candidate_key, dc.type_hint, dc.status_hint, dc.established, dc.confidence, dc.summary, dc.t3_pending,
           dc.t3_outcome, dc.t3_reason, dc.t3_operation_id::int AS t3_operation_id,
           (WITH RECURSIVE ch(id, m, n) AS (
              SELECT x.id, x.merged_into_operation_id, 0 FROM business_operations x WHERE x.id = dc.t3_operation_id AND x.account_id = $1
              UNION ALL SELECT y.id, y.merged_into_operation_id, ch.n + 1 FROM business_operations y JOIN ch ON y.id = ch.m WHERE ch.n < 20)
            SELECT ch.id::int FROM ch WHERE ch.m IS NULL LIMIT 1) AS canonical_operation_id,
           COALESCE((SELECT array_agg(DISTINCT upper(r->>'kind') || ':' || lower(regexp_replace(r->>'value', '[^A-Za-z0-9]', '', 'g')))
                       FROM jsonb_array_elements(COALESCE(dc.payload->'businessReferences', '[]'::jsonb)) r
                      WHERE upper(r->>'kind') NOT IN ('CUSTOMER', 'OTHER')), '{}') AS refs,
           dc.payload->'temporalHints' AS temporal_hints, dc.payload->>'provider' AS provider, dc.created_at
      FROM document_operation_candidates dc
     WHERE dc.account_id = $1 AND dc.file_id = $2 AND dc.status = 'ACTIVE'
     ORDER BY dc.id`;
  const opsSql = `
    SELECT o.id::int AS id, o.type_code, o.status, COALESCE(o.realized_date, o.planned_date)::text AS date, o.technical_label, o.provider,
           ($2::int = ANY(${EXCLUSIVE_FILES_RAW})) AS exclusive,
           (SELECT count(*)::int FROM agenda_items ai WHERE ai.account_id = o.account_id AND ai.business_operation_id = o.id) AS linked_items
      FROM business_operations o
     WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'
                    AND s.source_entity_key = ($2::int)::text)
     ORDER BY o.id`;
  await section(ctx, {
    id: 'doublons-interventions', tab: 'synthese', title: 'Doublons d’interventions — diagnostic de la cause (lot 76H)',
    description: 'Par date : événements d’entretien / réparation produits par ce document, Opérations actives qu’il prouve, issue T3 de ses candidats T1. '
      + 'Verdict : une Opération (convergence Agenda), plusieurs (consolidation T3 ou interventions distinctes), aucune (T3 n’a rien établi).',
  }, async () => {
    const items = await ctx.q(itemsSql, [A, fileId]);
    const cands = await ctx.q(candSql, [A, fileId]);
    const ops = await ctx.q(opsSql, [A, fileId]);
    const parDate = new Map<string, Row[]>();
    for (const i of items) {
      if (!['maintenance', 'repair'].includes(String(i.business_type))) continue;
      const d = str(i.date) ?? 'sans date';
      parDate.set(d, [...(parDate.get(d) ?? []), i]);
    }
    const fields: DossierField[] = [];
    const touche = (i: Row) => i.is_automatic !== true || i.is_automatic_modified === true || (i.manual_status !== null && i.manual_status !== '') || i.confirmation_mode === 'USER';
    for (const [date, groupe] of parDate) {
      const v = classifyDuplicateCause({
        items: groupe.map((i) => ({ id: num(i.id), title: str(i.title) ?? '', date: str(i.date), businessType: str(i.business_type), businessOperationId: i.business_operation_id == null ? null : num(i.business_operation_id), projected: i.projection_origin === 'OPERATION', touched: touche(i) })),
        operations: ops.map((o) => ({ id: num(o.id), typeCode: str(o.type_code), status: String(o.status), date: str(o.date), label: str(o.technical_label), exclusive: o.exclusive === true })),
        candidates: cands.map((c) => ({ candidateKey: String(c.candidate_key), typeHint: str(c.type_hint), established: c.established === true, t3Pending: c.t3_pending === true, t3Outcome: str(c.t3_outcome), t3Reason: str(c.t3_reason), canonicalOperationId: c.canonical_operation_id == null ? null : num(c.canonical_operation_id), refs: Array.isArray(c.refs) ? (c.refs as unknown[]).map(String) : [] })),
      });
      fields.push({ table: 'diagnostic', column: 'cause', label: `${date.split('-').reverse().join('/')} — ${v.label}`, state: 'value', raw: v.cause, display: v.cause, note: [...v.findings, `Correctif : ${v.remedy}`].join(' · ') });
    }
    if (!fields.length) fields.push({ table: 'diagnostic', column: 'cause', label: 'Aucun événement d’entretien / réparation produit par ce document', state: 'value', raw: 'NO_DUPLICATE', display: 'NO_DUPLICATE' });
    return { fields };
  });
  await tableSection(ctx, 'doublons-evenements', 'preuves', 'Doublons d’interventions — événements du document (agenda_items)', 'agenda_items', itemsSql, [A, fileId],
    'business_operation_id : Opération représentée ; projection_origin = OPERATION : événement projeté ; is_automatic_modified / manual_status / confirmation_mode : touché par l’utilisateur (jamais absorbé).');
  await tableSection(ctx, 'doublons-candidats', 'preuves', 'Doublons d’interventions — candidats T1 et décisions T3', 'document_operation_candidates', candSql, [A, fileId],
    'canonical_operation_id : Opération retenue par T3 (fusions suivies) ; refs : références identifiantes normalisées.');
  await tableSection(ctx, 'doublons-operations', 'preuves', 'Doublons d’interventions — Opérations actives prouvées par le document', 'business_operations', opsSql, [A, fileId],
    'exclusive : T3 a consolidé toute la preuve d’intervention du document dans cette Opération (condition de la convergence automatique).');
  await tableSection(ctx, 'doublons-decisions-t4', 'preuves', 'Doublons d’interventions — décisions T4 et projection (historique des événements)', 'agenda_occurrence_events',
    `SELECT e.* FROM agenda_occurrence_events e WHERE e.account_id = $1 AND e.agenda_item_id IN (SELECT id FROM (${itemsSql}) it) ORDER BY e.created_at DESC, e.id DESC`, [A, fileId]);
  await tableSection(ctx, 'doublons-retraits', 'preuves', 'Doublons d’interventions — événements retirés (agenda_item_removals)', 'agenda_item_removals',
    `SELECT id, agenda_item_id, functional_key, start_date, title, source_file_id, asset_id, reason, removed_at FROM agenda_item_removals
      WHERE account_id = $1 AND (source_file_id = $2 OR (item_snapshot->>'origin_ref_id') = ($2::int)::text) ORDER BY removed_at DESC, id DESC`, [A, fileId]);
  await tableSection(ctx, 'doublons-cartes', 'preuves', 'Doublons d’interventions — cartes de rapprochement et d’arbitrage', 'to_process_actions',
    `SELECT id, rule_code, target_type, target_id, relation_key, question, resolved_at, resolution_reason, trigger_context, created_at FROM to_process_actions
      WHERE account_id = $1 AND ((rule_code = 'AGENDA-PROJECTION-MATCH' AND (trigger_context->>'operationId')::bigint IN (SELECT id FROM (${opsSql}) o))
         OR (upper(target_type) IN ('AGENDA_ITEM', 'AGENDA') AND target_id IN (SELECT id FROM (${itemsSql}) it)))
      ORDER BY resolved_at DESC NULLS FIRST, id DESC`, [A, fileId]);
  await tableSection(ctx, 'doublons-projection-jobs', 'preuves', 'Doublons d’interventions — passages de la projection Agenda du compte (tous, échecs compris)', 'ai_job_queue',
    `SELECT * FROM (SELECT id, status, origin, trigger_code, business_result, attempts, last_error, created_at, finished_at,
            payload -> 'events' -> -1 ->> 'correlationId' AS correlation_id
       FROM ai_job_queue WHERE treatment = 'T3' AND account_id = $1 AND target_type = 'business_operations_agenda' AND $2::int IS NOT NULL
      ) j ORDER BY j.id DESC`, [A, fileId],
    'business_result : APPLIED / NO_CHANGE et compteurs (consolidated, abstained, matchCards…) ; last_error : échec technique de projection (rejoué).');
  await tableSection(ctx, 'doublons-journal', 'preuves', 'Doublons d’interventions — consolidations appliquées (journal 0591, restaurable)', 'agenda_intervention_consolidations',
    `SELECT id, run_id, origin, kind, operation_id, principal_item_id, absorbed_item_id, reason, correlation_id, created_at, restored_at, restore_run_id,
            detail->'item'->>'title' AS absorbed_title, detail->'from' AS title_from, detail->'to' AS title_to
       FROM agenda_intervention_consolidations k
      WHERE k.account_id = $1 AND (k.operation_id IN (SELECT id FROM (${opsSql}) o) OR (k.detail->'item'->>'origin_ref_id') = ($2::int)::text)
      ORDER BY k.id DESC`, [A, fileId],
    'Restauration : BO › Exploitation › Rattrapages › « Agenda : doublons d’interventions » › Restaurer (identifiant d’exécution).');
}

async function agendaDossier(ctx: Ctx, id: number): Promise<EntityDossier['entity']> {
  const A = ctx.accountId;
  const row = await oneRow(ctx.q, `SELECT * FROM agenda_items WHERE id = $1 AND account_id = $2`, [id, A]);
  if (!row) throw new EntityNotFoundError();
  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Échéance (agenda actif)' }, async () => ({
    fields: pick('agenda_items', row, [['id', 'Identifiant'], ['title', 'Titre'], ['start_date', 'Date'], ['start_time', 'Heure'], ['end_date', 'Fin'], ['manual_status', 'Statut'],
      ['event_nature', 'Nature'], ['business_type', 'Type métier'], ['origin_type', 'Origine'], ['origin_ref_type', 'Référence d’origine (type)'], ['origin_ref_id', 'Référence d’origine (id)'],
      ['origin_field_key', 'Champ d’origine'], ['is_automatic', 'Automatique'], ['is_automatic_modified', 'Automatique modifiée'], ['recurrence_json', 'Récurrence'],
      ['forecast_initial_date', 'Date prévisionnelle initiale'], ['confirmed_at', 'Confirmée le'], ['confirmation_mode', 'Mode de confirmation'], ['confirmation_source', 'Source de confirmation'],
      ['business_operation_id', 'Opération'], ['projection_origin', 'Projection'], ['created_at', 'Créée le'], ['updated_at', 'Modifiée le']]),
  }));
  await section(ctx, { id: 'bdd-agenda', tab: 'bdd', title: 'agenda_items — colonnes persistées' }, async () => ({ fields: bddFields('agenda_items', row) }));
  await relSection(ctx, 'rel-cibles', 'Biens, équipements, pièces, documents et Opération', `
    SELECT 'asset' AS type, a.id, a.name AS label, 'bien' AS nature, a.status AS status, NULL AS origin, 'agenda_asset_links' AS via
      FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 WHERE l.agenda_item_id = $2
    UNION ALL SELECT 'equipment', e.id, e.name, 'équipement', e.status, NULL, 'agenda_equipment_links'
      FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE l.agenda_item_id = $2
    UNION ALL SELECT 'room', s.id, s.name, 'pièce', s.room_type, NULL, 'agenda_room_links'
      FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 WHERE l.agenda_item_id = $2
    UNION ALL SELECT 'document', f.id, coalesce(f.retained_title, f.document_type_code, 'Document'), 'document lié', f.analysis_state, NULL, 'agenda_file_links'
      FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.account_id = $1 WHERE l.agenda_item_id = $2
    UNION ALL SELECT 'document', f.id, coalesce(f.retained_title, f.document_type_code, 'Document'), 'source : ' || coalesce(s.effect_type, '') || coalesce(' / ' || s.source_role, ''), f.analysis_state, 'DOCUMENT_EXTRACTION', 'agenda_item_sources'
      FROM agenda_item_sources s JOIN asset_files f ON f.id = s.asset_file_id AND f.account_id = $1 WHERE s.agenda_item_id = $2
    UNION ALL SELECT 'operation', o.id, coalesce(o.technical_label, o.type_code, 'Opération'), 'Opération projetée / rapprochée', o.status, i.projection_origin, 'agenda_items.business_operation_id'
      FROM agenda_items i JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = $1 WHERE i.id = $2`, [A, id]);
  await tableSection(ctx, 'sources', 'preuves', 'Sources documentaires (agenda_item_sources)', 'agenda_item_sources',
    `SELECT s.* FROM agenda_item_sources s JOIN agenda_items i ON i.id = s.agenda_item_id AND i.account_id = $1 WHERE s.agenda_item_id = $2 ORDER BY s.id`, [A, id]);
  await tableSection(ctx, 'evidence', 'preuves', 'Preuves citées par les sources (field_evidence)', 'field_evidence',
    `SELECT e.* FROM field_evidence e WHERE e.account_id = $1 AND e.id IN (SELECT evidence_id FROM agenda_item_sources WHERE agenda_item_id = $2 AND evidence_id IS NOT NULL) ORDER BY e.id`, [A, id]);
  await tableSection(ctx, 'conflicts', 'preuves', 'Conflits de données (agenda_data_conflicts)', 'agenda_data_conflicts',
    `SELECT * FROM agenda_data_conflicts WHERE account_id = $1 AND (agenda_item_id = $2 OR result_agenda_item_id = $2) ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'occurrences', 'preuves', 'Historique de l’échéance (agenda_occurrence_events)', 'agenda_occurrence_events',
    `SELECT * FROM agenda_occurrence_events WHERE account_id = $1 AND agenda_item_id = $2 ORDER BY created_at DESC, id DESC`, [A, id]);
  await tableSection(ctx, 'to-process', 'preuves', 'Cartes « À traiter » de l’échéance', 'to_process_actions',
    `SELECT * FROM to_process_actions WHERE account_id = $1 AND upper(target_type) IN ('AGENDA_ITEM', 'AGENDA') AND target_id = $2 ORDER BY id DESC`, [A, id]);
  // Lot 76H : événement produit par un document — diagnostic des doublons d'interventions de ce document.
  if (row.origin_ref_type === 'asset_file' && row.origin_ref_id != null) await interventionDuplicatesSections(ctx, num(row.origin_ref_id));
  return { type: 'agenda', typeLabel: ENTITY_LABELS.agenda, id, table: 'agenda_items', name: str(row.title) ?? `Échéance #${id}`, status: str(row.manual_status), statusLabel: str(row.manual_status) };
}

async function deadlineDossier(ctx: Ctx, id: number): Promise<EntityDossier['entity']> {
  const A = ctx.accountId;
  const row = await oneRow(ctx.q, `SELECT * FROM deadlines WHERE id = $1 AND account_id = $2`, [id, A]);
  if (!row) throw new EntityNotFoundError();
  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Échéance historique (table deadlines)', description: 'Donnée historique, distincte de l’agenda actif (agenda_items) : aucune fusion ni dédoublonnage n’est calculé ici.' }, async () => ({
    fields: pick('deadlines', row, [['id', 'Identifiant'], ['label', 'Libellé'], ['deadline_date', 'Date'], ['deadline_type', 'Type'], ['is_done', 'Faite'], ['done_date', 'Faite le'],
      ['asset_id', 'Bien'], ['equipment_id', 'Équipement'], ['substructure_id', 'Pièce'], ['created_at', 'Créée le'], ['updated_at', 'Modifiée le']]),
  }));
  await section(ctx, { id: 'bdd-deadlines', tab: 'bdd', title: 'deadlines — colonnes persistées' }, async () => ({ fields: bddFields('deadlines', row) }));
  await relSection(ctx, 'rel-cibles', 'Rattachements', `
    SELECT 'asset' AS type, a.id, a.name AS label, 'bien' AS nature, a.status AS status, NULL AS origin, 'deadlines.asset_id' AS via
      FROM assets a WHERE a.account_id = $1 AND a.id IN (SELECT asset_id FROM deadlines WHERE id = $2 UNION SELECT linked_asset_id FROM deadlines WHERE id = $2)
    UNION ALL SELECT 'equipment', e.id, e.name, 'équipement', e.status, NULL, 'deadlines.equipment_id'
      FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 WHERE e.id = (SELECT equipment_id FROM deadlines WHERE id = $2)
    UNION ALL SELECT 'room', s.id, s.name, 'pièce', s.room_type, NULL, 'deadlines.substructure_id'
      FROM substructures s JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 WHERE s.id = (SELECT substructure_id FROM deadlines WHERE id = $2)`, [A, id]);
  return { type: 'deadline', typeLabel: ENTITY_LABELS.deadline, id, table: 'deadlines', name: str(row.label) ?? `Échéance historique #${id}`, status: row.is_done ? 'DONE' : 'OPEN', statusLabel: row.is_done ? 'faite' : 'ouverte' };
}

/** Sections du détail d'Opération exportées intégralement (mêmes requêtes que l'écran, sans borne). */
const OP_SECTIONS: Array<[string, Tab, string, keyof typeof OPERATION_DETAIL_LISTS]> = [
  ['components', 'synthese', 'Composantes financières', 'components'],
  ['sources', 'preuves', 'Sources (actives et historiques)', 'sources'],
  ['references', 'preuves', 'Références', 'references'],
  ['match-decisions', 'preuves', 'Décisions de rapprochement', 'matchDecisions'],
  ['candidates', 'preuves', 'Candidats T1 liés et issue T3', 'candidates'],
  ['history', 'preuves', 'Historique', 'history'],
  ['agenda', 'preuves', 'Agenda (projection)', 'agendaItems'],
  ['suppressions', 'preuves', 'Suppressions durables de projection', 'projectionSuppressions'],
];

async function operationDossier(ctx: Ctx, id: number, withDetail: boolean): Promise<{ entity: EntityDossier['entity']; detail: OperationDetail | null }> {
  const A = ctx.accountId;
  const row = await oneRow(ctx.q, `SELECT * FROM business_operations WHERE id = $1 AND account_id = $2`, [id, A]);
  if (!row) throw new EntityNotFoundError();
  // Détail d'écran (listes d'AFFICHAGE) lu DANS l'instantané du dossier, en point de reprise.
  const exec: DiagExecutor = <T>(fn: (q: DiagQuery) => Promise<T>) => ctx.s.savepoint(() => fn(ctx.q));
  const detail = withDetail ? await new OperationDiagnosticsService(exec).detail(id) : null;
  if (withDetail && (!detail || detail.operation.accountId !== A)) throw new EntityNotFoundError();

  await section(ctx, { id: 'identite', tab: 'synthese', title: 'Opération (OperationDiagnosticsService)', description: 'Détail rendu par la vue de diagnostic existante (listes d’affichage) ; ci-dessous les données BDD, relations et listes INTÉGRALES.' }, async () => ({
    fields: pick('business_operations', row, [['id', 'Identifiant'], ['type_code', 'Type'], ['status', 'Statut'], ['technical_label', 'Libellé technique'], ['provider', 'Prestataire'],
      ['planned_date', 'Date prévue'], ['start_date', 'Début'], ['realized_date', 'Réalisation'], ['end_date', 'Fin'], ['invalidated_at', 'Invalidée le'], ['invalidation_reason', 'Motif d’invalidation'],
      ['merged_into_operation_id', 'Fusionnée dans'], ['parent_operation_id', 'Parent'], ['last_reconciled_at', 'Dernière réconciliation'], ['created_at', 'Créée le'], ['updated_at', 'Modifiée le']]),
  }));
  await tableSection(ctx, 'components', 'synthese', 'Composantes financières', OPERATION_DETAIL_LISTS.components.table, OPERATION_DETAIL_LISTS.components.sql, [id, A]);
  await section(ctx, { id: 'bdd-operation', tab: 'bdd', title: 'business_operations — colonnes persistées' }, async () => ({ fields: bddFields('business_operations', row) }));
  const details: Array<[string, string, string]> = [
    ['bdd-contract', 'business_operation_contract_details', `SELECT contract_reference, periodicity, effective_from::text AS effective_from, effective_to::text AS effective_to, updated_at
       FROM business_operation_contract_details WHERE operation_id = $1`],
    ['bdd-financing', 'business_operation_financing_details', `SELECT financing_reference, lender, principal_amount_minor, principal_currency,
       effective_from::text AS effective_from, effective_to::text AS effective_to, updated_at FROM business_operation_financing_details WHERE operation_id = $1`],
    // Sinistre : champs structurés et décomptes seulement — aucun texte libre.
    ['bdd-claim', 'business_operation_claim_details (champs structurés)', `SELECT cd.claim_type, cd.declared_on::text AS declared_on, cd.insurer_claim_ref, cd.insurance_contract_operation_id,
       cd.status, cd.estimated_damage_minor, cd.updated_at,
       (SELECT count(*) FROM business_operation_claim_damages d WHERE d.operation_id = cd.operation_id)::int AS damages,
       (SELECT count(*) FROM business_operation_claim_actions a WHERE a.operation_id = cd.operation_id)::int AS actions,
       (SELECT count(*) FROM business_operation_claim_exchanges x WHERE x.operation_id = cd.operation_id)::int AS exchanges
       FROM business_operation_claim_details cd WHERE cd.operation_id = $1`],
  ];
  for (const [sid, title, sql] of details) {
    await section(ctx, { id: sid, tab: 'bdd', title }, async () => {
      const r = await oneRow(ctx.q, sql, [id]);
      return r ? { fields: bddFields(title.split(' ')[0], r) } : null;
    });
  }

  await relSection(ctx, 'rel-operation', 'Biens, équipements, documents, échéances et Opérations liées', `
    SELECT 'asset' AS type, al.asset_id AS id, coalesce(a.name, 'Bien') AS label, 'bien ' || coalesce(al.link_role, '') || CASE WHEN al.active THEN '' ELSE ' (lien inactif)' END AS nature,
           CASE WHEN a.deleted_at IS NOT NULL THEN 'supprimé' END AS status, al.authority AS origin, 'business_operation_asset_links' AS via
      FROM business_operation_asset_links al LEFT JOIN assets a ON a.id = al.asset_id AND a.account_id = $2 WHERE al.operation_id = $1 AND al.account_id = $2
    UNION ALL
    SELECT 'equipment', el.equipment_id, coalesce(e.name, 'Équipement'), 'équipement' || CASE WHEN el.active THEN '' ELSE ' (lien inactif)' END, NULL, el.authority, 'business_operation_equipment_links'
      FROM business_operation_equipment_links el LEFT JOIN equipments e ON e.id = el.equipment_id WHERE el.operation_id = $1 AND el.account_id = $2
    UNION ALL
    SELECT 'asset', c.target_asset_id, 'Bien #' || c.target_asset_id, 'cible de la composante #' || c.id || ' (' || c.kind || ') — TCO', CASE WHEN c.active THEN 'active' ELSE 'inactive' END, NULL, 'business_operation_financial_components.target_asset_id'
      FROM business_operation_financial_components c WHERE c.operation_id = $1 AND c.account_id = $2 AND c.target_asset_id IS NOT NULL
    UNION ALL
    SELECT 'equipment', c.target_equipment_id, 'Équipement #' || c.target_equipment_id, 'cible de la composante #' || c.id || ' (' || c.kind || ') — TCO', CASE WHEN c.active THEN 'active' ELSE 'inactive' END, NULL, 'business_operation_financial_components.target_equipment_id'
      FROM business_operation_financial_components c WHERE c.operation_id = $1 AND c.account_id = $2 AND c.target_equipment_id IS NOT NULL
    UNION ALL
    SELECT 'document', f.id, coalesce(f.document_type, 'Document') || ' #' || f.id, 'source ' || coalesce(s.source_role, s.source_kind) || CASE WHEN s.active THEN '' ELSE ' (supersédée)' END,
           CASE WHEN f.deleted_at IS NOT NULL THEN 'supprimé' END, s.authority, 'business_operation_sources'
      FROM business_operation_sources s JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AND f.account_id = s.account_id
     WHERE s.operation_id = $1 AND s.account_id = $2 AND s.source_kind = 'DOCUMENT'
    UNION ALL
    SELECT 'agenda', i.id, coalesce(i.title, 'Échéance'), CASE WHEN i.projection_origin = 'OPERATION' THEN 'échéance projetée (T4)' ELSE 'échéance rapprochée' END, i.manual_status, i.projection_origin, 'agenda_items.business_operation_id'
      FROM agenda_items i WHERE i.business_operation_id = $1 AND i.account_id = $2
    UNION ALL
    SELECT 'operation', p.id, coalesce(p.technical_label, p.type_code, 'Opération'), 'Opération parente', p.status, NULL, 'business_operations.parent_operation_id'
      FROM business_operations o JOIN business_operations p ON p.id = o.parent_operation_id AND p.account_id = $2 WHERE o.id = $1
    UNION ALL
    SELECT 'operation', c.id, coalesce(c.technical_label, c.type_code, 'Opération'), 'Opération enfant', c.status, NULL, 'business_operations.parent_operation_id'
      FROM business_operations c WHERE c.parent_operation_id = $1 AND c.account_id = $2
    UNION ALL
    SELECT 'operation', m.id, 'Opération #' || m.id, 'fusionnée dans', NULL, NULL, 'business_operations.merged_into_operation_id'
      FROM business_operations o JOIN business_operations m ON m.id = o.merged_into_operation_id AND m.account_id = $2 WHERE o.id = $1
    UNION ALL
    SELECT 'operation', m.id, coalesce(m.technical_label, 'Opération'), 'a absorbé', m.status, NULL, 'business_operations.merged_into_operation_id'
      FROM business_operations m WHERE m.merged_into_operation_id = $1 AND m.account_id = $2
    UNION ALL
    SELECT 'document', c.file_id, 'Document #' || c.file_id, 'candidat T1 ' || c.candidate_key || ' (' || coalesce(c.t3_outcome, 'en attente T3') || ')', c.status, 'DOCUMENT_EXTRACTION', 'document_operation_candidates'
      FROM (${OPERATION_DETAIL_LISTS.candidates.sql}) c WHERE c.file_id IS NOT NULL`, [id, A]);

  for (const [sid, tab, title, k] of OP_SECTIONS.slice(1)) {
    await tableSection(ctx, sid, tab, title, OPERATION_DETAIL_LISTS[k].table, OPERATION_DETAIL_LISTS[k].sql, [id, A]);
  }
  if (detail) {
    await section(ctx, { id: 'reconciliation', tab: 'preuves', title: 'État de réconciliation et dernier passage T3' }, async () => ({
      fields: [
        columnField('diagnostic', 'reconciliation', detail.reconciliation, undefined, 'État de réconciliation'),
        columnField('ai_job_queue', 'last_t3_pass', detail.lastT3Pass ?? null, undefined, 'Dernier passage T3 du compte'),
      ],
    }));
  }
  const label = str(row.technical_label) ?? str(row.type_code) ?? 'Opération';
  const status = String(row.status);
  return {
    entity: { type: 'operation', typeLabel: ENTITY_LABELS.operation, id, table: 'business_operations', name: detail ? (detail.operation.label ?? detail.operation.typeLabel) : label, status,
      statusLabel: `${status}${row.merged_into_operation_id ? ' — fusionnée' : row.invalidated_at ? ' — invalidée' : ''}` },
    detail,
  };
}

// ── Plan, consultation paginée ──────────────────────────────────────────────

/** Dossier planifié : sections (données des sources non encore lues) + sources. */
export interface DossierPlan {
  dossier: EntityDossier;
  sources: Map<string, SectionSource>;
}

/**
 * Construit le dossier DANS une session : entité relue PAR LE COMPTE
 * (`EntityNotFoundError` sinon), champs et sections calculées lues, sections
 * tabulaires et de relations enregistrées comme SOURCES (lues ensuite par
 * page — `fillPage` — ou intégralement — `export.ts`).
 */
export async function planEntityDossier(
  s: ReadSession, accountId: number, type: EntityType, id: number,
  opts: { only?: string | null; now?: () => Date; mode?: 'consultation' | 'export' } = {},
): Promise<DossierPlan> {
  const extractedAt = (opts.now ?? (() => new Date()))().toISOString();
  const ctx: Ctx = { s, q: s.q, accountId, warnings: [], sections: [], sources: new Map(), only: opts.only ?? null };
  let entity: EntityDossier['entity'];
  let operationDetail: unknown;
  switch (type) {
    case 'asset': entity = await assetDossier(ctx, id); break;
    case 'equipment': entity = await equipmentDossier(ctx, id); break;
    case 'room': entity = await roomDossier(ctx, id); break;
    case 'document': entity = await documentDossier(ctx, id); break;
    case 'agenda': entity = await agendaDossier(ctx, id); break;
    case 'deadline': entity = await deadlineDossier(ctx, id); break;
    case 'operation': {
      // Détail d'écran : seulement pour le dossier complet (pas pour une page d'une section).
      const r = await operationDossier(ctx, id, !ctx.only || ctx.only === 'reconciliation');
      entity = r.entity;
      if (r.detail) operationDetail = r.detail;
      break;
    }
    default: throw new EntityNotFoundError();
  }
  const dossier: EntityDossier = {
    schema: ACCOUNT_DATA_SCHEMA, extractedAt, accountId,
    entity: { ...entity, table: ENTITY_TABLES[type] },
    complete: ctx.warnings.length === 0, warnings: ctx.warnings, sections: ctx.sections,
    mode: opts.mode ?? 'consultation',
    snapshot: { isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot },
  };
  if (operationDetail !== undefined) dossier.operationDetail = operationDetail;
  return { dossier, sources: ctx.sources };
}

export interface PageRequest { offset?: number; size?: number; q?: string | null }

/** Fenêtre normalisée (pagination technique : taille bornée à `DOSSIER_PAGE_MAX`). */
export function normalizePage(p: PageRequest = {}): { offset: number; size: number; q: string | null } {
  const size = Math.min(DOSSIER_PAGE_MAX, Math.max(1, Math.floor(Number(p.size) || DOSSIER_PAGE_SIZE)));
  const offset = Math.max(0, Math.floor(Number(p.offset) || 0));
  const q = typeof p.q === 'string' && p.q.trim() ? p.q.trim().slice(0, 200) : null;
  return { offset, size, q };
}

const matches = (needle: string) => (v: unknown) => JSON.stringify(v).toLowerCase().includes(needle);

/**
 * Remplit la fenêtre d'une section : total réel (instantané), page
 * `[offset, offset + size[`. Recherche : parcours INTÉGRAL par curseur des
 * lignes masquées (jamais limitée aux lignes chargées), page des
 * correspondances et leur nombre.
 */
async function fillPage(s: ReadSession, sec: DossierSection, src: SectionSource, page: { offset: number; size: number; q: string | null }): Promise<void> {
  const masker = src.kind === 'relations' ? (r: Row) => toRelation(r) as unknown as Row : (r: Row) => (src.kind === 'static' ? r : maskRow(r, MASK));
  let total: number;
  let window: Row[] = [];
  let matched: number | null = null;
  if (src.kind === 'static') {
    const all = page.q ? src.rows.filter(matches(page.q.toLowerCase())) : src.rows;
    total = src.rows.length;
    matched = page.q ? all.length : null;
    window = all.slice(page.offset, page.offset + page.size);
  } else if (!page.q) {
    total = await countRows(s.q, src.sql, src.params);
    const rows = await s.q(`SELECT row_to_json(t) AS r FROM (${src.sql}) t LIMIT ${page.size} OFFSET ${page.offset}`, src.params);
    window = rows.map((x) => masker(decodeJsonRow(x.r)));
  } else {
    const test = matches(page.q.toLowerCase());
    total = 0;
    matched = 0;
    for await (const lot of jsonBatches(s, src.sql, src.params)) {
      for (const raw of lot) {
        total++;
        const r = masker(raw);
        if (!test(r)) continue;
        if (matched >= page.offset && window.length < page.size) window.push(r);
        matched++;
      }
    }
  }
  const w: DossierWindow = { total, offset: page.offset, size: page.size, ...(page.q ? { query: page.q, matched } : {}) };
  sec.window = w;
  if (src.kind === 'relations') {
    sec.relations = window as unknown as DossierRelation[];
  } else {
    sec.table = { table: src.table, columns: window.length ? Object.keys(window[0]) : [], rows: window, total, complete: true };
  }
}

/** Remplit toutes les sources d'un dossier planifié (point de reprise par section). */
async function fillPages(s: ReadSession, plan: DossierPlan, page: { offset: number; size: number; q: string | null }): Promise<void> {
  const d = plan.dossier;
  for (const sec of d.sections) {
    const src = plan.sources.get(sec.id);
    if (!src) continue;
    try {
      await s.savepoint(() => fillPage(s, sec, src, page));
    } catch (e) {
      const code = errCode(e);
      if (code === '25006') throw e;
      console.error(`[admin/account-data] section ${sec.id} :`, (e as Error)?.message ?? e);
      d.warnings.push(`Section « ${sec.title} » non chargée (erreur de lecture${code ? ` ${code}` : ''}).`);
      sec.error = `lecture impossible${code ? ` (${code})` : ''}`;
      delete sec.table;
      delete sec.relations;
    }
  }
  d.complete = d.warnings.length === 0;
}

/**
 * Dossier complet d'une entité du compte, en CONSULTATION : chaque section
 * tabulaire ou de relations porte sa première page et son total réel.
 * Lève `EntityNotFoundError` si l'entité n'existe pas DANS CE COMPTE.
 */
export async function buildEntityDossier(
  accountId: number, type: EntityType, id: number,
  opts: { exec?: DossierExecutor; page?: PageRequest; now?: () => Date } = {},
): Promise<EntityDossier> {
  const exec = opts.exec ?? readOnlyDossierExecutor();
  return exec(async (s) => {
    const plan = await planEntityDossier(s, accountId, type, id, { now: opts.now });
    await fillPages(s, plan, normalizePage(opts.page));
    return plan.dossier;
  });
}

/**
 * Lot 81C — page d'UNE section (navigation, recherche serveur). Mêmes
 * contrôles que le dossier (entité relue par le compte, masquage).
 * `null` : section inconnue.
 */
export async function loadSectionPage(
  accountId: number, type: EntityType, id: number, sectionId: string, page: PageRequest = {},
  opts: { exec?: DossierExecutor; now?: () => Date } = {},
): Promise<DossierSection | null> {
  const exec = opts.exec ?? readOnlyDossierExecutor();
  return exec(async (s) => {
    const plan = await planEntityDossier(s, accountId, type, id, { only: sectionId, now: opts.now });
    const sec = plan.dossier.sections.find((x) => x.id === sectionId);
    if (!sec) return null;
    await fillPages(s, plan, normalizePage(page));
    return sec;
  });
}

/** Vrai si un objet ne contient AUCUNE valeur interdite (contrôle de sortie, tests). */
export function containsForbiddenKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(containsForbiddenKey);
  if (v && typeof v === 'object' && !isMarker(v)) {
    return Object.entries(v as Row).some(([k, x]) => (/^(s3_key|s3_bucket|filename|original_filename|web_link_url)$/.test(k) && x !== null && !isMarker(x)) || containsForbiddenKey(x));
  }
  return false;
}
