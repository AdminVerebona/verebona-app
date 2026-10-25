/**
 * Lot 88B — COLLECTE transversale, LARGE et NEUTRE du contexte d'un objet
 * (bien, équipement), en lecture seule. Jamais le fichier, jamais une
 * relance T1, aucune IA.
 *
 * Sources (selon disponibilité), toutes bornées au COMPTE :
 *   · l'objet : valeurs canoniques existantes (lecteur canonique : fiche,
 *     alias, miroirs) avec leur origine — les valeurs écrites par ce
 *     contrôle sont exclues (jamais d'auto-alimentation) ;
 *   · documents rattachés (lien N-N ACTIF, colonne historique), documents
 *     des Opérations de l'objet et de ses éléments d'Agenda : métadonnées et
 *     classement (titre, Type, Rubrique, date, émetteur, montant lu) ;
 *   · `field_evidence` ACTIVES de l'objet — TOUTES les clés (champs voisins
 *     compris), hors preuves créées par ce contrôle ;
 *   · connaissance T1 persistée de ces documents : faits, faits non
 *     intégrés, unités sources (texte, libellé : valeur, tableaux…) ;
 *   · Opérations de l'objet (type, statut, dates, prestataire, détails de
 *     contrat / financement, références) et composantes économiques
 *     (nature, montant, devise, date économique, période, cible), avec leur
 *     provenance (documents, Agenda, données de la fiche) ;
 *   · éléments d'Agenda de l'objet (titre, dates, statut, Opération, documents) ;
 *   · historique : dernière décision de réconciliation par propriété demandée.
 *
 * AUCUN filtrage sémantique : rien n'est retenu ou écarté d'après ses mots.
 * Les seules exclusions sont de PROVENANCE (données écrites par ce contrôle)
 * ou des drapeaux du REGISTRE (donnée sensible). Les bornes sont des tailles
 * déclarées (`COLLECTION_BOUNDS`) ; toute troncature est COMPTÉE par couche
 * (`collectionDropped`) et rend le contexte incomplet.
 */
import { pgClient } from '@/db';
import { getField } from '@/services/canonical/registry';
import type { CanonicalFieldState } from '@/services/canonical/asset-state';
import type { KnowledgeConfidence } from '../knowledge-query/contract';
import type { ProtectionReason } from './catalog';
import {
  MISSING_PROPERTIES_PROJECTION_RULE,
  type ContextLayer, type ElementProvenance, type PropertyContextDocument, type PropertyContextElement, type SubjectType,
} from './contract';

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[]): Promise<T[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as T[];

/** Bornes DÉCLARÉES de la collecte (tailles, jamais un critère de contenu). */
export const COLLECTION_BOUNDS = {
  documents: 30,
  fieldEvidence: 200,
  facts: 400,
  unresolvedFacts: 200,
  sourceUnits: 600,
  operations: 50,
  components: 150,
  agenda: 100,
} as const;

export interface SubjectRef { type: SubjectType; id: number }

export interface LoadedSubject {
  type: SubjectType;
  id: number;
  accountId: number;
  /** Bien porteur (le bien lui-même, ou le bien de l'équipement). */
  assetId: number;
  category: string | null;
  subtype: string | null;
  family: string | null;
  archived: boolean;
  /** Valeurs canoniques renseignées (lecteur canonique). */
  fields: Record<string, CanonicalFieldState>;
  /** Fiche brute (origines `<clé>__origin`). */
  kc: Record<string, unknown>;
}

const texte = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = (typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').trim();
  return s.length ? s : null;
};
const ids = (v: unknown): number[] => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
const montant = (minor: unknown, devise: unknown): string | null => {
  if (minor === null || minor === undefined) return null;
  const n = Number(minor);
  return Number.isFinite(n) ? `${(n / 100).toFixed(2)} ${String(devise ?? 'EUR').trim()}` : null;
};
const joindre = (parts: Array<[string, unknown]>): string | null =>
  texte(parts.filter(([, v]) => texte(v) !== null).map(([k, v]) => `${k}=${texte(v)}`).join(' ; '));
const confianceFait = (c: unknown): KnowledgeConfidence => (c === 'certain' || c === 'probable' ? c : 'conflictual');
const confianceUnite = (cov: unknown): KnowledgeConfidence => (cov === 'COVERED' ? 'certain' : cov === 'UNRESOLVED' ? 'probable' : 'conflictual');
const HUMAINES = new Set(['USER', 'ADMIN']);

/** Objet du compte (lecteur canonique) ; null si introuvable. Lève sur une lecture en échec. */
export async function loadSubject(accountId: number, ref: SubjectRef): Promise<LoadedSubject | null> {
  const { toAssetFamily } = await import('@/services/canonical/registry');
  if (ref.type === 'ASSET') {
    const { loadAssetRow, buildCanonicalAssetState, parseKc } = await import('@/services/canonical/asset-state');
    const row = await loadAssetRow(pgClient as never, ref.id, accountId);
    if (!row) return null;
    const st = buildCanonicalAssetState(row);
    return {
      type: 'ASSET', id: ref.id, accountId, assetId: ref.id, category: row.category ?? null,
      subtype: typeof row.subtype === 'string' ? row.subtype : null, family: toAssetFamily(row.category) ?? 'OBJECT',
      archived: false, fields: st.fields, kc: parseKc(row.key_characteristics),
    };
  }
  const ent = await import('@/services/canonical/entity-state');
  if (!(await ent.entityCanonicalColumnsReady())) return null;
  const row = await ent.loadEntityRow(pgClient as never, { type: 'EQUIPMENT', id: ref.id }, accountId);
  if (!row) return null;
  const st = ent.buildCanonicalEntityState(row);
  const [bien] = await q<{ category: string | null }>(`SELECT category FROM assets WHERE id = $1 AND account_id = $2`, [row.assetId, accountId]);
  return {
    type: 'EQUIPMENT', id: ref.id, accountId, assetId: row.assetId, category: bien?.category ?? null, subtype: null,
    family: toAssetFamily(bien?.category ?? null) ?? null, archived: row.archived, fields: st.fields, kc: row.kc,
  };
}

/** Condition SQL « écriture canonique de l'objet » (journal 0216, cible 0227). */
const cibleEcriture = (s: LoadedSubject, a = 'w') => (s.type === 'ASSET'
  ? `(to_jsonb(${a}) ->> 'target_type') IS NULL`
  : `(to_jsonb(${a}) ->> 'target_type') = 'EQUIPMENT' AND (to_jsonb(${a}) ->> 'target_id')::int = ${Number(s.id)}`);

/**
 * Protections des propriétés VIDES (corrections et décisions de
 * l'utilisateur, arbitrage en cours), prioritaires sur toute écriture :
 *   · USER_CLEARED     valeur effacée par l'utilisateur / l'administrateur
 *                      (origine humaine posée sur la clé vide, ou dernière
 *                      écriture canonique humaine sans valeur) ;
 *   · USER_DECISION    carte de la propriété tranchée par l'utilisateur
 *                      (arbitrage, « ne s'applique pas ») ;
 *   · OPEN_ARBITRATION carte de la propriété encore ouverte : le mécanisme
 *                      d'arbitrage existant reste seul juge.
 */
export async function loadProtections(accountId: number, s: LoadedSubject, keys: readonly string[]): Promise<Map<string, ProtectionReason>> {
  const out = new Map<string, ProtectionReason>();
  if (!keys.length) return out;
  for (const k of keys) {
    const o = s.kc[`${k}__origin`];
    if ((typeof o === 'string' && HUMAINES.has(o)) || s.kc[`${k}_origin`] === 'manual') out.set(k, 'USER_CLEARED');
  }
  const ecritures = await q<{ canonical_key: string; origin: string; new_value: unknown }>(
    `SELECT DISTINCT ON (w.canonical_key) w.canonical_key, w.origin, w.new_value
       FROM canonical_field_writes w
      WHERE w.account_id = $1 AND w.asset_id = $2 AND w.canonical_key = ANY($3::text[]) AND w.outcome = 'written' AND ${cibleEcriture(s)}
      ORDER BY w.canonical_key, w.id DESC`,
    [accountId, s.assetId, keys],
  );
  for (const w of ecritures) {
    const v = w.new_value;
    if (HUMAINES.has(String(w.origin)) && (v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === ''))) {
      out.set(String(w.canonical_key), 'USER_CLEARED');
    }
  }
  const cartes = await q<{ field_key: string; open: boolean; reason: string | null }>(
    `SELECT field_key, resolved_at IS NULL AS open, resolution_reason AS reason FROM to_process_actions
      WHERE account_id = $1 AND target_type = $2 AND target_id = $3 AND field_key = ANY($4::text[])
        AND (resolved_at IS NULL OR resolution_reason IN ('USER_ARBITRATED', 'NOT_APPLICABLE'))
      ORDER BY id`,
    [accountId, s.type, s.id, keys],
  );
  for (const c of cartes) {
    const k = String(c.field_key);
    if (out.get(k) === 'USER_CLEARED') continue;
    if (!c.open) out.set(k, 'USER_DECISION');
    else if (!out.has(k)) out.set(k, 'OPEN_ARBITRATION');
  }
  return out;
}

export interface CollectedContext {
  documents: PropertyContextDocument[];
  elements: PropertyContextElement[];
  /** Éléments non lus au-delà des bornes de collecte, par couche (troncature tracée). */
  collectionDropped: Record<string, number>;
  /** Couches absentes (migration non appliquée). */
  missingLayers: string[];
}

/** Valeurs canoniques écrites par ce contrôle (exclues du contexte tant qu'elles sont en place). */
export async function ownWrittenValues(accountId: number, s: LoadedSubject): Promise<Map<string, unknown>> {
  const [{ ok }] = await q<{ ok: boolean }>(`SELECT to_regclass('property_recovery_decisions') IS NOT NULL AS ok`, []);
  if (!ok) return new Map();
  const r = await q<{ field_key: string; value_after: unknown }>(
    `SELECT DISTINCT ON (field_key) field_key, value_after FROM property_recovery_decisions
      WHERE account_id = $1 AND object_type = $2 AND object_id = $3 AND decision = 'WRITTEN'
      ORDER BY field_key, id DESC`,
    [accountId, s.type, s.id],
  );
  return new Map(r.map((x) => [String(x.field_key), x.value_after]));
}

/**
 * Contexte transversal de l'objet (lecture seule). `requestedKeys` : seules
 * propriétés dont l'historique de décision est joint (couche DECISION,
 * hors empreinte). Lève sur une lecture en échec (jamais « information absente »).
 */
export async function collectSubjectContext(
  accountId: number, s: LoadedSubject, opts: { requestedKeys: readonly string[] },
): Promise<CollectedContext> {
  const elements: PropertyContextElement[] = [];
  const dropped: Record<string, number> = {};
  const missingLayers: string[] = [];
  const compter = (layer: ContextLayer | 'DOCUMENT', total: unknown, lus: number) => {
    const n = Number(total ?? 0) - lus;
    if (n > 0) dropped[layer] = (dropped[layer] ?? 0) + n;
  };
  const { sameCanonicalValue } = await import('@/services/canonical/asset-state');
  const propres = await ownWrittenValues(accountId, s);
  const B = COLLECTION_BOUNDS;
  const estBien = s.type === 'ASSET';

  // ── Valeurs canoniques existantes de l'objet ──────────────────────────────
  for (const [key, st] of Object.entries(s.fields)) {
    const def = getField(key);
    if (!def || def.sensitive) continue;
    if (propres.has(key) && sameCanonicalValue(key, st.value, propres.get(key))) continue;
    elements.push({
      ref: `K-${key}`, document: 'S', fileId: 0, layer: 'CANONICAL', kind: key, label: def.label, value: texte(st.value),
      text: `origin=${st.origin}`, confidence: 'certain', page: null,
      provenance: { fileIds: [], agendaItemIds: [], derivedFromSubject: true },
    });
  }

  // ── Opérations de l'objet et leurs composantes ────────────────────────────
  const lienOp = estBien
    ? `EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.asset_id = $2 AND l.active)`
    : `EXISTS (SELECT 1 FROM business_operation_equipment_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.equipment_id = $2 AND l.active)`;
  const ops = await q<Row>(
    `SELECT o.id, o.type_code, o.status, o.technical_label, o.provider, o.planned_date::text AS planned, o.start_date::text AS start,
            o.realized_date::text AS realized, o.end_date::text AS end_d,
            (SELECT array_agg(DISTINCT s.source_kind ORDER BY s.source_kind) FROM business_operation_sources s
              WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active) AS kinds,
            (SELECT array_agg(DISTINCT x ORDER BY x) FROM (
               SELECT s.source_entity_key::int AS x FROM business_operation_sources s
                WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]+$'
               UNION SELECT d.file_id FROM business_operation_documents d WHERE d.operation_id = o.id AND d.account_id = o.account_id AND d.active) f) AS files,
            (SELECT array_agg(DISTINCT s.source_entity_key::int ORDER BY s.source_entity_key::int) FROM business_operation_sources s
              WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'AGENDA' AND s.source_entity_key ~ '^[0-9]+$') AS agenda,
            to_jsonb(cd) AS contract, to_jsonb(fd) AS financing,
            (SELECT jsonb_agg(jsonb_build_object('k', r.reference_kind, 'v', r.reference_value) ORDER BY r.id) FROM business_operation_references r
              WHERE r.operation_id = o.id AND r.account_id = o.account_id AND r.active) AS refs,
            count(*) OVER () AS total
       FROM business_operations o
       LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
       LEFT JOIN business_operation_financing_details fd ON fd.operation_id = o.id
      WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND ${lienOp}
      ORDER BY o.id LIMIT ${B.operations}`,
    [accountId, s.id],
  );
  compter('OPERATION', ops[0]?.total, ops.length);
  const opIds = ops.map((o) => Number(o.id));
  const fichiersOp = new Map<number, number[]>();
  for (const o of ops) {
    const kinds = (Array.isArray(o.kinds) ? o.kinds : []).map(String);
    const files = ids(o.files);
    fichiersOp.set(Number(o.id), files);
    const c = (o.contract ?? null) as Row | null;
    const fi = (o.financing ?? null) as Row | null;
    const refs = (Array.isArray(o.refs) ? o.refs : []) as Array<{ k: string; v: string }>;
    elements.push({
      ref: `O-${o.id}`, document: 'S', fileId: 0, layer: 'OPERATION', kind: String(o.type_code ?? 'OPERATION'), label: texte(o.technical_label),
      value: texte(o.status),
      text: joindre([
        ['provider', o.provider], ['plannedDate', o.planned], ['startDate', o.start], ['realizedDate', o.realized], ['endDate', o.end_d],
        ['contractReference', c?.contract_reference], ['periodicity', c?.periodicity], ['contractFrom', c?.effective_from], ['contractTo', c?.effective_to],
        ['financingReference', fi?.financing_reference], ['lender', fi?.lender], ['principal', montant(fi?.principal_amount_minor, fi?.principal_currency)],
        ['financingFrom', fi?.effective_from], ['financingTo', fi?.effective_to],
        ['references', refs.map((r) => `${r.k}:${r.v}`).join(', ')], ['sources', kinds.join(', ')],
      ]),
      confidence: 'certain', page: null,
      provenance: {
        fileIds: files, agendaItemIds: ids(o.agenda), operationId: Number(o.id),
        derivedFromSubject: kinds.length > 0 && kinds.every((k) => k === 'ASSET_DATA' || k === 'EQUIPMENT_DATA'),
      },
    });
  }
  if (opIds.length) {
    const comps = await q<Row>(
      `SELECT c.id, c.operation_id, c.kind, c.amount_minor, c.currency, c.amount_eur_cents, c.economic_date::text AS eco, c.period_start::text AS ps,
              c.period_end::text AS pe, c.target_asset_id, c.target_equipment_id, c.label,
              (SELECT array_agg(DISTINCT s.source_kind ORDER BY s.source_kind) FROM business_operation_financial_component_sources cs
                 JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.active WHERE cs.component_id = c.id) AS kinds,
              (SELECT array_agg(DISTINCT s.source_entity_key::int ORDER BY s.source_entity_key::int) FROM business_operation_financial_component_sources cs
                 JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.active
                WHERE cs.component_id = c.id AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]+$') AS files,
              count(*) OVER () AS total
         FROM business_operation_financial_components c
        WHERE c.account_id = $1 AND c.operation_id = ANY($2::bigint[]) AND c.active
        ORDER BY c.operation_id, c.id LIMIT ${B.components}`,
      [accountId, opIds],
    );
    compter('OPERATION_COMPONENT', comps[0]?.total, comps.length);
    for (const c of comps) {
      const kinds = (Array.isArray(c.kinds) ? c.kinds : []).map(String);
      const opId = Number(c.operation_id);
      const eur = c.currency !== 'EUR' && c.amount_eur_cents != null ? montant(c.amount_eur_cents, 'EUR') : null;
      elements.push({
        ref: `C-${c.id}`, document: 'S', fileId: 0, layer: 'OPERATION_COMPONENT', kind: String(c.kind), label: texte(c.label),
        value: montant(c.amount_minor, c.currency),
        text: joindre([['amountEur', eur], ['economicDate', c.eco], ['periodStart', c.ps], ['periodEnd', c.pe],
          ['target', c.target_equipment_id ? `equipment:${c.target_equipment_id}` : c.target_asset_id ? `asset:${c.target_asset_id}` : null]]),
        confidence: 'certain', page: null, links: [`O-${opId}`],
        provenance: {
          fileIds: ids(c.files).length ? ids(c.files) : (fichiersOp.get(opId) ?? []), agendaItemIds: [], operationId: opId, componentId: Number(c.id),
          derivedFromSubject: kinds.length > 0 && kinds.every((k) => k === 'ASSET_DATA' || k === 'EQUIPMENT_DATA'),
        },
      });
    }
  }

  // ── Éléments d'Agenda de l'objet ──────────────────────────────────────────
  const lienAgenda = estBien
    ? `EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = $2)`
    : `EXISTS (SELECT 1 FROM agenda_equipment_links l WHERE l.agenda_item_id = i.id AND l.equipment_id = $2)`;
  const agenda = await q<Row>(
    `SELECT i.id, i.title, i.description, i.start_date::text AS start, i.end_date::text AS end_d, i.manual_status, i.is_automatic,
            i.origin_type, to_jsonb(i) ->> 'business_type' AS business_type, i.business_operation_id,
            (SELECT array_agg(DISTINCT x ORDER BY x) FROM (
               SELECT fl.asset_file_id AS x FROM agenda_file_links fl WHERE fl.agenda_item_id = i.id
               UNION SELECT s.asset_file_id FROM agenda_item_sources s WHERE s.agenda_item_id = i.id AND s.asset_file_id IS NOT NULL) f) AS files,
            count(*) OVER () AS total
       FROM agenda_items i
      WHERE i.account_id = $1 AND ${lienAgenda}
      ORDER BY i.id LIMIT ${B.agenda}`,
    [accountId, s.id],
  );
  compter('AGENDA', agenda[0]?.total, agenda.length);

  // ── Documents de l'objet (rattachés, des Opérations, de l'Agenda) ────────
  const lienDoc = estBien
    ? `(f.asset_id = $2 OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.account_id = f.account_id AND l.asset_id = $2 AND l.status = 'ACTIVE'))`
    : `EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.account_id = f.account_id AND l.equipment_id = $2 AND l.status = 'ACTIVE')`;
  const lies = await q<{ id: number; total: number }>(
    `SELECT f.id, count(*) OVER () AS total FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AND ${lienDoc}
      ORDER BY f.id LIMIT ${B.documents}`,
    [accountId, s.id],
  );
  const relation = new Map<number, PropertyContextDocument['relation']>();
  for (const r of lies) relation.set(Number(r.id), 'LINKED');
  let totalDocs = Number(lies[0]?.total ?? 0);
  const ajouter = (fid: number, rel: PropertyContextDocument['relation']) => {
    if (relation.has(fid)) return;
    totalDocs += 1;
    if (relation.size < B.documents) relation.set(fid, rel);
  };
  for (const o of ops) for (const fid of ids(o.files)) ajouter(fid, 'OPERATION');
  for (const a of agenda) for (const fid of ids(a.files)) ajouter(fid, 'AGENDA');
  compter('DOCUMENT', totalDocs, relation.size);
  const fileIds = [...relation.keys()];
  const meta = fileIds.length ? await q<Row>(
    `SELECT f.id, COALESCE(to_jsonb(f) ->> 'retained_title', e.title, f.original_filename) AS title,
            COALESCE(f.document_type_code, e.document_type_code) AS type, COALESCE(f.rubric_code, e.rubric_code) AS rubric,
            e.document_date::text AS ddate, e.supplier_name, e.amount_cents, e.currency, e.description, e.id AS extraction_id
       FROM asset_files f
       LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
      WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.deleted_at IS NULL`,
    [accountId, fileIds],
  ) : [];
  const metaParId = new Map(meta.map((m) => [Number(m.id), m]));
  const documents: PropertyContextDocument[] = fileIds.filter((fid) => metaParId.has(fid)).map((fid, i) => {
    const m = metaParId.get(fid)!;
    return {
      ref: `D${i + 1}`, fileId: fid, relation: relation.get(fid)!, title: texte(m.title)?.slice(0, 200) ?? null,
      documentType: texte(m.type), rubric: texte(m.rubric), documentDate: texte(m.ddate),
    };
  });
  const refDoc = new Map(documents.map((d) => [d.fileId, d.ref]));
  const refsDocs = (l: number[]) => l.map((f) => refDoc.get(f)).filter((x): x is string => !!x);
  for (const e of elements) {
    if (e.layer === 'OPERATION') e.links = refsDocs(e.provenance?.fileIds ?? []);
  }
  for (const a of agenda) {
    const files = ids(a.files);
    elements.push({
      ref: `A-${a.id}`, document: 'S', fileId: 0, layer: 'AGENDA', kind: String(a.business_type ?? a.origin_type ?? 'agenda'), label: texte(a.title),
      value: texte(a.start),
      text: joindre([['endDate', a.end_d], ['status', a.manual_status], ['automatic', a.is_automatic === true ? 'yes' : 'no'], ['description', a.description]]),
      confidence: 'certain', page: null,
      links: [...(a.business_operation_id ? [`O-${a.business_operation_id}`] : []), ...refsDocs(files)],
      provenance: { fileIds: files, agendaItemIds: [Number(a.id)], operationId: a.business_operation_id ? Number(a.business_operation_id) : null,
        derivedFromSubject: a.origin_type === 'asset_field' },
    });
  }
  for (const d of documents) {
    const m = metaParId.get(d.fileId)!;
    elements.push({
      ref: `M-${d.fileId}`, document: d.ref, fileId: d.fileId, layer: 'DOCUMENT_METADATA', kind: 'DOCUMENT', label: d.title, value: d.documentType,
      text: joindre([['rubric', d.rubric], ['documentDate', d.documentDate], ['issuer', m.supplier_name], ['amount', montant(m.amount_cents, m.currency)],
        ['description', m.description]]),
      confidence: 'certain', page: null, provenance: { fileIds: [d.fileId], agendaItemIds: [] },
    });
  }

  // ── Preuves de champ de l'objet (toutes les clés : champs voisins compris) ─
  const cibleFe = estBien
    ? `fe.asset_id = $2 AND (fe.target_type IS NULL OR (fe.target_type = 'ASSET' AND COALESCE(fe.target_entity_id, fe.asset_id) = $2))`
    : `fe.target_type = 'EQUIPMENT' AND fe.target_entity_id = $2`;
  const fes = await q<Row>(
    `SELECT fe.id, COALESCE(fe.canonical_key, fe.field_key) AS key, fe.normalized_value, fe.value_json, fe.evidence_excerpt, fe.confidence,
            fe.source_type, fe.source_id, fe.source_location ->> 'page' AS page, count(*) OVER () AS total
       FROM field_evidence fe
      WHERE fe.account_id = $1 AND ${cibleFe} AND fe.status IN ('active', 'conflict')
        AND (fe.lifecycle_status IS NULL OR fe.lifecycle_status = 'ACTIVE')
        AND fe.projection_rule IS DISTINCT FROM $3
      ORDER BY fe.id LIMIT ${B.fieldEvidence}`,
    [accountId, s.id, MISSING_PROPERTIES_PROJECTION_RULE],
  );
  compter('FIELD_EVIDENCE', fes[0]?.total, fes.length);
  for (const e of fes) {
    const key = String(e.key);
    const def = getField(key);
    if (def?.sensitive) continue;
    const doc = e.source_type === 'document' || e.source_type === 'web_link' ? Number(e.source_id) : null;
    const prov: ElementProvenance = { fileIds: doc ? [doc] : [], agendaItemIds: e.source_type === 'agenda' ? [Number(e.source_id)] : [] };
    elements.push({
      ref: `E-${e.id}`, document: (doc && refDoc.get(doc)) || 'S', fileId: doc ?? 0, layer: 'FIELD_EVIDENCE', kind: key, label: def?.label ?? key,
      value: texte(e.normalized_value) ?? texte(e.value_json), text: texte(e.evidence_excerpt), confidence: confianceFait(e.confidence),
      page: e.page != null && /^\d+$/.test(String(e.page)) ? Number(e.page) : null, provenance: prov,
    });
  }

  // ── Connaissance T1 persistée des documents ───────────────────────────────
  if (documents.length) {
    const dids = documents.map((d) => d.fileId);
    const faits = await q<Row>(
      `SELECT f.id, f.file_id, f.fact_key, to_jsonb(f) ->> 'canonical_key' AS canonical, f.label, f.value_text, f.excerpt, f.confidence,
              count(*) OVER () AS total
         FROM document_facts f WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active'
        ORDER BY f.file_id, f.id LIMIT ${B.facts}`,
      [accountId, dids],
    );
    compter('FACT', faits[0]?.total, faits.length);
    for (const r of faits) {
      const valeur = texte(r.value_text);
      const extrait = texte(r.excerpt);
      elements.push({
        ref: `F-${r.id}`, document: refDoc.get(Number(r.file_id)) ?? 'S', fileId: Number(r.file_id), layer: 'FACT',
        kind: String(r.canonical ?? r.fact_key ?? 'fact'), label: texte(r.label) ?? texte(r.fact_key), value: valeur,
        text: extrait && extrait !== valeur ? extrait : null, confidence: confianceFait(r.confidence), page: null,
        provenance: { fileIds: [Number(r.file_id)], agendaItemIds: [] },
      });
    }
    const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
    if (!(await sourceLayerReady())) {
      missingLayers.push('SOURCE_UNITS', 'UNRESOLVED_FACTS');
    } else {
      const { RELIABLE_UNRESOLVED_REASONS } = await import('@/services/ai/reconciliation/document-asset/source-unit-provider');
      const nr = await q<Row>(
        `SELECT id, file_id, raw_key, canonical_key, raw_value, reason, count(*) OVER () AS total FROM document_unresolved_facts
          WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status IN ('UNRESOLVED', 'RETAINED')
          ORDER BY file_id, id LIMIT ${B.unresolvedFacts}`,
        [accountId, dids],
      );
      compter('UNRESOLVED_FACT', nr[0]?.total, nr.length);
      for (const r of nr) {
        elements.push({
          ref: `N-${r.id}`, document: refDoc.get(Number(r.file_id)) ?? 'S', fileId: Number(r.file_id), layer: 'UNRESOLVED_FACT',
          kind: String(r.canonical_key ?? r.raw_key ?? 'unresolved'), label: texte(r.raw_key), value: texte(r.raw_value), text: null,
          confidence: RELIABLE_UNRESOLVED_REASONS.includes(String(r.reason)) ? 'probable' : 'conflictual', page: null,
          provenance: { fileIds: [Number(r.file_id)], agendaItemIds: [] },
        });
      }
      const unites = await q<Row>(
        `SELECT id, file_id, kind, page, label, value_text, content_text, coverage_status, count(*) OVER () AS total
           FROM document_source_units
          WHERE account_id = $1 AND file_id = ANY($2::int[]) AND coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN') AND kind <> 'PAGE_GAP'
          ORDER BY file_id, ordinal, id LIMIT ${B.sourceUnits}`,
        [accountId, dids],
      );
      compter('SOURCE_UNIT', unites[0]?.total, unites.length);
      for (const r of unites) {
        elements.push({
          ref: `U-${r.id}`, document: refDoc.get(Number(r.file_id)) ?? 'S', fileId: Number(r.file_id), layer: 'SOURCE_UNIT',
          kind: String(r.kind), label: texte(r.label), value: texte(r.value_text), text: texte(r.content_text),
          confidence: confianceUnite(r.coverage_status), page: r.page === null || r.page === undefined ? null : Number(r.page),
          provenance: { fileIds: [Number(r.file_id)], agendaItemIds: [] },
        });
      }
    }
  }

  // ── Historique : dernière décision de réconciliation par propriété demandée (hors empreinte) ─
  if (estBien && opts.requestedKeys.length) {
    const dec = await q<Row>(
      `SELECT DISTINCT ON (field_key) field_key, action, reason_code, confidence FROM reconciliation_decisions
        WHERE account_id = $1 AND asset_id = $2 AND field_key = ANY($3::text[])
        ORDER BY field_key, id DESC`,
      [accountId, s.id, opts.requestedKeys],
    );
    for (const d of dec) {
      elements.push({
        ref: `R-${d.field_key}`, document: 'S', fileId: 0, layer: 'DECISION', kind: String(d.field_key), label: getField(String(d.field_key))?.label ?? null,
        value: texte(d.action), text: joindre([['reason', d.reason_code], ['confidence', d.confidence]]), confidence: 'certain', page: null,
        provenance: { fileIds: [], agendaItemIds: [], derivedFromSubject: true },
      });
    }
  }

  return { documents, elements, collectionDropped: dropped, missingLayers };
}
