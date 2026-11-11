/**
 * Lot 113AL (Trello #737, §3 B) — CONTEXTE TRANSVERSE de l'arbitrage
 * sémantique d'un document (lecture seule, bornée au compte et au bien,
 * jamais le fichier, jamais une relance T1).
 *
 * Réunit, pour le document cible et les documents de la même réalité métier
 * (Opération commune, référence métier commune, autres documents du bien) :
 * unités sources T1 et extraits, faits T1 persistés, montants, type,
 * documents liés, champs corrigés par l'utilisateur, périodes métier,
 * lignes économiques actuelles du moteur (statut et motif : décisions et
 * exclusions antérieures), Opérations, et les faits déjà COMPTÉS du bien
 * (fiche, composantes, justificatifs retenus). N'exige ni
 * `document_operation_candidate` ni `financialHint`. Aucun contenu n'est
 * filtré d'après ses mots : la pertinence est l'affaire de T3.
 */
import type postgres from 'postgres';
import type { TcoResult } from '../model';
import { tcoLineKeys } from '../user-decisions';
import { QUALIFICATION_CONTEXT_BOUNDS as B, type RawQualificationAmount, type RawQualificationContext, type RawQualificationDocument } from './contract';
import { countedFactsOf } from './targets';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;
const q = async (sql: Sql, text: string, params: unknown[]): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as unknown as Row[];
const intArray = (v: readonly number[]) => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const tableMissing = (e: unknown) => (e as { code?: string })?.code === '42P01';
const chiffres = (s: string) => s.replace(/[^\d]/g, '');

/** Unités sources d'un document (lecture seule) ; celles qui portent un montant à arbitrer d'abord. */
async function excerptsOf(sql: Sql, accountId: number, fileIds: readonly number[], max: (fileId: number) => number, amounts: ReadonlyMap<number, number[]>): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!fileIds.length) return out;
  const r = await q(sql, `
    SELECT x.file_id, x.label, x.value_text, x.content_text FROM (
      SELECT u.file_id, u.label, u.value_text, u.content_text,
             row_number() OVER (PARTITION BY u.file_id ORDER BY u.salient DESC, u.page NULLS LAST, u.ordinal, u.id) AS n
        FROM document_source_units u
       WHERE u.account_id = $1 AND u.file_id = ANY($2::int[])
         AND u.kind IN ('LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW', 'TEXT_BLOCK')
         AND (COALESCE(btrim(u.content_text), '') <> '' OR COALESCE(btrim(u.value_text), '') <> '')
    ) x WHERE x.n <= 80 ORDER BY x.file_id, x.n`, [accountId, intArray(fileIds)]);
  const parFichier = new Map<number, string[]>();
  for (const x of r) {
    const lv = [x.label, x.value_text].filter((v) => v && String(v).trim()).join(' : ');
    const brut = x.value_text && String(x.value_text).trim() ? lv : (x.content_text && String(x.content_text).trim() ? String(x.content_text) : lv);
    const t = brut.replace(/\s+/g, ' ').trim();
    if (t) parFichier.set(Number(x.file_id), [...(parFichier.get(Number(x.file_id)) ?? []), t.slice(0, B.maxExcerptLength)]);
  }
  for (const [f, textes] of parFichier) {
    // Ordre de présentation seulement (jamais une décision) : passages qui portent un montant à arbitrer d'abord.
    const cibles = (amounts.get(f) ?? []).map((m) => String(Math.floor(m / 100)));
    const porte = (t: string) => cibles.some((c) => c.length >= 2 && chiffres(t).includes(c));
    out.set(f, [...textes.filter(porte), ...textes.filter((t) => !porte(t))].slice(0, max(f)));
  }
  return out;
}

/**
 * Contexte BRUT d'un document à arbitrer (null : document disparu du compte). `tco` : calcul du moteur pour le
 * bien (lecture déjà faite par l'appelant), `amounts` : montants à arbitrer de ce document.
 */
export async function loadQualificationContext(sql: Sql, accountId: number, x: {
  assetId: number; assetCategory: string | null; fileId: number; tco: Pick<TcoResult, 'lines'>; amounts: RawQualificationAmount[]; today: string;
}): Promise<RawQualificationContext | null> {
  const { loadDocuments } = await import('@/services/business-operations/semantic/load');
  const [cible] = await loadDocuments(sql, accountId, [x.fileId]);
  if (!cible) return null;
  // Documents de la même réalité métier : Opération commune, référence métier commune ; puis autres documents du bien
  // portant une ligne économique, les plus proches en date (bornés).
  const refs = cible.references.map((r) => r.value).filter((v) => v && v.length >= 3);
  const parOperation = cible.operationIds.length ? (await q(sql, `
    SELECT DISTINCT s.source_entity_key::int AS id FROM business_operation_sources s
      JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$'
       AND s.operation_id = ANY($2::bigint[]) AND s.source_entity_key <> $3::text LIMIT 20`, [accountId, intArray(cible.operationIds), String(x.fileId)])).map((r) => Number(r.id)) : [];
  const parReference = refs.length ? (await q(sql, `
    SELECT DISTINCT c.file_id AS id FROM document_operation_candidates c
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'businessReferences') = 'array' THEN c.payload->'businessReferences' ELSE '[]'::jsonb END) r
      JOIN asset_files f ON f.id = c.file_id AND f.account_id = c.account_id AND f.deleted_at IS NULL
     WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.file_id <> $2 AND r->>'value' = ANY($3::text[]) LIMIT 20`, [accountId, x.fileId, `{${refs.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')}}`])).map((r) => Number(r.id)) : [];
  const dateCible = cible.date ?? '';
  const ecart = (d: string | null) => (d && dateCible ? Math.abs(Date.parse(d) - Date.parse(dateCible)) : Number.MAX_SAFE_INTEGER);
  const lignesParFichier = new Map<number, TcoResult['lines']>();
  for (const l of x.tco.lines) if (l.fileId != null) lignesParFichier.set(l.fileId, [...(lignesParFichier.get(l.fileId) ?? []), l]);
  const memeBien = [...lignesParFichier.keys()].filter((f) => f !== x.fileId);
  const relation = new Map<number, string>();
  for (const f of parOperation) relation.set(f, 'SAME_OPERATION');
  for (const f of parReference) if (!relation.has(f)) relation.set(f, 'SAME_REFERENCE');
  const autresBruts = await loadDocuments(sql, accountId, [...new Set([...relation.keys(), ...memeBien])]);
  const autres = autresBruts
    .map((d) => ({ d, rel: relation.get(d.id) ?? 'SAME_ASSET' }))
    .sort((a, b) => (a.rel === 'SAME_ASSET' ? 1 : 0) - (b.rel === 'SAME_ASSET' ? 1 : 0) || ecart(a.d.date) - ecart(b.d.date) || a.d.id - b.d.id)
    .slice(0, B.maxDocuments);
  const ids = [x.fileId, ...autres.map((a) => a.d.id)];
  const montants = new Map<number, number[]>([[x.fileId, x.amounts.map((a) => a.amountMinor)]]);
  const extraits = await excerptsOf(sql, accountId, ids, (f) => (f === x.fileId ? B.maxExcerptsTarget : B.maxExcerptsRelated), montants);
  // Faits T1 persistés, champs corrigés, document commun à plusieurs biens.
  const faits = await q(sql, `
    SELECT file_id, fact_key, label, COALESCE(value_text, normalized_value) AS value, excerpt FROM document_facts
     WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' ORDER BY file_id, id LIMIT 200`, [accountId, intArray(ids)]).catch((e) => { if (tableMissing(e)) return [] as Row[]; throw e; });
  const fiches = await q(sql, `
    SELECT f.id, COALESCE((SELECT array_agg(k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(f.user_edited_fields) = 'object' THEN f.user_edited_fields ELSE '{}'::jsonb END) k), '{}') AS corrected,
           COALESCE((SELECT x.multi_asset FROM document_extractions x WHERE x.file_id = f.id AND x.account_id = f.account_id ORDER BY x.id DESC LIMIT 1), false) AS multi,
           (SELECT count(DISTINCT l.asset_id) FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE') AS linked
      FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[])`, [accountId, intArray(ids)]);
  let periodes: Row[] = [];
  try {
    periodes = await q(sql, `SELECT file_id, period_kind, start_on, end_on FROM document_business_periods WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'ACTIVE' ORDER BY file_id, id LIMIT 60`, [accountId, intArray(ids)]);
  } catch (e) { if (!tableMissing(e)) throw e; }
  const fiche = new Map(fiches.map((f) => [Number(f.id), f]));
  const doc = (d: (typeof autresBruts)[number], rel: string): RawQualificationDocument => {
    const f = fiche.get(d.id);
    return {
      id: d.id, type: d.type, title: d.title, date: d.date, provider: d.provider, references: d.references, relation: rel,
      excerpts: extraits.get(d.id) ?? d.excerpts,
      facts: faits.filter((r) => Number(r.file_id) === d.id).map((r) => ({ key: String(r.fact_key), label: txt(r.label), value: txt(r.value), quote: txt(r.excerpt) })),
      periods: periodes.filter((r) => Number(r.file_id) === d.id).map((r) => ({ kind: String(r.period_kind), start: txt(r.start_on), end: txt(r.end_on) })),
      userCorrectedFields: (Array.isArray(f?.corrected) ? f!.corrected as unknown[] : []).map(String),
      multiAsset: f?.multi === true, linkedAssetCount: Number(f?.linked ?? 0),
      lines: (lignesParFichier.get(d.id) ?? []).map((l) => ({ kind: l.kind, amountMinor: l.amountMinor, currency: String(l.currency || 'EUR').toUpperCase(), status: l.status, reason: l.reason })),
    };
  };
  // Faits déjà comptés : ceux des documents liés d'abord, puis la fiche et les équipements, puis par proximité de date.
  const lies = new Set(ids);
  const comptes = countedFactsOf(x.tco, (l) => tcoLineKeys(l).primary)
    .sort((a, b) => (lies.has(a.fileId ?? -1) ? 0 : 1) - (lies.has(b.fileId ?? -1) ? 0 : 1)
      || (a.source === 'ASSET_DATA' || a.source === 'EQUIPMENT_DATA' ? 0 : 1) - (b.source === 'ASSET_DATA' || b.source === 'EQUIPMENT_DATA' ? 0 : 1)
      || ecart(a.date) - ecart(b.date) || a.lineId.localeCompare(b.lineId));
  // Opérations dont le document cible est une source (libellé, type, justificatifs présents dans le contexte).
  const ops = cible.operationIds.length ? await q(sql, `
    SELECT o.id, o.type_code, o.technical_label,
           ARRAY(SELECT s.source_entity_key::int FROM business_operation_sources s WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active
                   AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$') AS files
      FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) ORDER BY o.id`, [accountId, intArray(cible.operationIds)]) : [];
  const anterieurs = await q(sql, `
    SELECT to_char(decided_at, 'YYYY-MM-DD') AS at, status, COALESCE(reason, '') AS reason FROM economic_qualification_reviews
     WHERE account_id = $1 AND file_id = $2 AND asset_id = $3 AND status IN ('DECIDED', 'ABSTAINED', 'NOT_CERTAIN', 'REJECTED', 'SUPERSEDED') AND decided_at IS NOT NULL
     ORDER BY decided_at DESC LIMIT ${B.maxPrior}`, [accountId, x.fileId, x.assetId]).catch((e) => { if (tableMissing(e)) return [] as Row[]; throw e; });
  return {
    today: x.today, asset: { id: x.assetId, category: x.assetCategory }, targetFileId: x.fileId, amounts: x.amounts,
    documents: [doc(cible, 'TARGET'), ...autres.map((a) => doc(a.d, a.rel))],
    countedFacts: comptes,
    operations: ops.map((o) => ({
      label: txt(o.technical_label) ?? String(o.type_code ?? 'OTHER'), typeCode: txt(o.type_code),
      fileIds: (Array.isArray(o.files) ? o.files : []).map(Number).filter((f) => ids.includes(f)),
    })),
    priorReviews: anterieurs.map((r) => ({ at: String(r.at), status: String(r.status), summary: String(r.reason) })),
  };
}
