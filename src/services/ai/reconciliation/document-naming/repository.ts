/**
 * T3 — harmonisation du nommage documentaire (lot 61) : accès base.
 *
 * Toutes les lectures sont bornées au COMPTE (`account_id = $1` sur chaque
 * table) : aucune donnée d'un autre compte n'est lue ni écrite.
 *
 * ÉCRITURE D'UN NOM (`applyRename`) — une transaction :
 *   1. UPDATE asset_files … RETURNING, sous compare-and-swap : même compte,
 *      document actif, titre SYSTEM (jamais un titre utilisateur), marque
 *      historique du tiroir absente, nom en place = nom ATTENDU (celui lu
 *      dans le contexte envoyé à l'IA). Seul `retained_title` change (plus
 *      `title_checked_at` / `updated_at`) : ni le fichier stocké, ni son
 *      identifiant, ni ses liens, ni aucune Opération ;
 *   2. INSERT du journal (APPLIED, ancien et nouveau nom, origine, date,
 *      justification, références), clé d'idempotence unique.
 * Un renommage manuel intervenu entre l'analyse IA et l'écriture fait
 * échouer le compare-and-swap : CONFLICT, jamais écrasé.
 *
 * LOT 76B (C2) — DÉCISION PERSISTÉE AVANT SON APPLICATION : chaque
 * proposition validée par les garde-fous est d'abord enregistrée
 * (`persistChunk`, ligne `DECIDED` / `PENDING`, dans la MÊME transaction que
 * la progression de l'examen) ; l'écriture (`applyRename`) supprime cette
 * ligne dans sa propre transaction (renommage + historique APPLIED +
 * résolution : jamais l'un sans l'autre). Un échec d'écriture la convertit en
 * `FAILED` / `PENDING` (reprise sans nouvel appel IA) ; si même cette mise à
 * jour échoue, la ligne reste `DECIDED` / `PENDING` : jamais perdue. Les
 * écritures restantes se lisent donc toujours en base, tous passages
 * confondus (`pendingWritesByGroup`, C1).
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { isValidBusinessTitle } from '@/lib/documents/document-title-rules';
import { T1_SETTLED_STATES } from '../document-asset/question-gate';
import { isDiscriminantReference, REFERENCE_KEYS } from '../document-asset/matching-index';
import type { KnownDocumentData, NameOrigin } from './guards';
import { NAMING_TEXT_WINDOW, selectFacts, selectPassages, type NamingDoc, type NamingDocDetail, type RawFact } from './context';

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

let pret: boolean | null = null;
/**
 * Tables de la migration 0450 ET de la migration 0513 (lot 72B : index
 * persistant, reprise des écritures) présentes ? (mémorisé une fois vrai).
 * Sinon la phase n'est pas exécutée (NOT_READY, signalé) : jamais un
 * fonctionnement dégradé à moitié migré.
 */
export async function namingTablesReady(): Promise<boolean> {
  if (pret) return true;
  const [r] = (await pgClient.unsafe(
    `SELECT to_regclass('document_naming_groups') IS NOT NULL AND to_regclass('document_rename_events') IS NOT NULL
            AND to_regclass('document_naming_members') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema() AND table_name = 'document_rename_events' AND column_name = 'retry_of')
            AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema() AND table_name = 'document_naming_groups' AND column_name = 'context_version')
            -- Lot 76B : migrations 0578 (décisions persistées, recalage) et 0579 (indices textuels).
            AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema() AND table_name = 'document_naming_groups' AND column_name = 'upgrade_state')
            AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema() AND table_name = 'document_naming_members' AND column_name = 'text_keys') AS ok`,
  )) as unknown as Array<{ ok: boolean }>;
  pret = !!r?.ok;
  return pret;
}
export function resetNamingTablesReady(): void { pret = null; }

/**
 * Documents du compte éligibles au nommage : analysés par T1 (état abouti),
 * visibles (ni supprimés, ni regroupés, ni brouillons, ni ignorés, ni liens
 * web), avec un nom. AUCUNE condition sur les Opérations, le classement ou
 * le rattachement.
 *
 * Lot 87D : un document dont le titre relève d'une CONVENTION du service de
 * nommage centralisé (`title_convention`, ex. facture périodique « Facture
 * Homiris — Février 2026 ») n'est plus harmonisé par T3 — une seule logique
 * nomme chaque document (sinon les deux mécanismes se renommeraient l'un
 * l'autre). Il sort de l'index au cycle de lecture suivant (purge des
 * documents devenus inéligibles).
 */
const ELIGIBLE = `f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
        AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
        AND COALESCE(f.is_web_link, false) = false
        AND f.analysis_state IN ('${T1_SETTLED_STATES.join("', '")}')
        AND NULLIF(btrim(f.retained_title), '') IS NOT NULL
        AND f.title_convention IS NULL`;

/**
 * Lecture d'un document pour le nommage (lot 72B, E3) : outre les données du
 * lot 61, des VERSIONS et EMPREINTES déterministes de tout ce que l'IA lit —
 * extraction (identifiant, dates, taille du texte, nombre de faits), faits
 * actifs (valeurs, périodes, cibles), références de contrat (faits du
 * référentiel et Opérations), Opérations liées, liens document ↔ bien,
 * rubrique, SIREN de l'émetteur. Aucun texte intégral relu ni haché ici.
 * `$1` = compte, `$2` = clés canoniques de référence de contrat.
 */
const docSelect = (where: string, tail: string) => `
  SELECT f.id, f.retained_title, f.original_filename, f.filename, f.s3_key, f.public_id::text AS public_id,
         f.title_source, COALESCE((f.user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy_user_edit,
         COALESCE(f.document_type_code, e.document_type_code, f.document_type) AS type_code, f.rubric_code,
         COALESCE(NULLIF(btrim(f.supplier), ''), NULLIF(btrim(e.supplier_name), '')) AS supplier, e.supplier_siret,
         to_char(COALESCE(f.document_date, e.document_date), 'YYYY-MM-DD') AS document_date,
         a.id AS asset_id, a.name AS asset_name,
         e.id AS extraction_id, e.extracted_at, e.title AS extraction_title,
         CASE WHEN e.id IS NULL THEN NULL
              ELSE concat_ws('|', e.id, to_char(e.extracted_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'), to_char(e.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'), e.full_text_chars, e.fact_count) END AS extraction_version,
         CASE WHEN e.id IS NULL THEN 0 WHEN COALESCE(e.full_text_chars, 0) > 0 THEN e.full_text_chars ELSE length(COALESCE(e.full_text, '')) END AS text_chars,
         COALESCE(f.amount_cents::bigint, e.amount_cents) AS amount_cents,
         fx.digest AS facts_digest, fx.digest_v2 AS facts_digest_v2, fx.n AS facts_n, fx.max_len AS fact_max_len, fx.refs AS fact_refs,
         ops.ids AS operation_ids, ops.refs AS operation_refs, ops.digest AS operations_digest, lk.digest AS links_digest,
         GREATEST(e.updated_at, fx.changed_at, ops.changed_at, lk.changed_at) AS context_changed_at,
         m.text_keys, m.text_version
    FROM asset_files f
    LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
    LEFT JOIN assets a ON a.id = COALESCE(f.asset_id, f.linked_asset_id) AND a.account_id = f.account_id AND a.deleted_at IS NULL
    LEFT JOIN document_naming_members m ON m.account_id = f.account_id AND m.file_id = f.id
    LEFT JOIN LATERAL (
      -- Lot 76B (C4) : libellé et provenance des faits dans l'empreinte ; formule du lot 72B conservée (recalage prouvé).
      SELECT md5(string_agg(concat_ws('|', x.id, x.canonical_key, x.fact_key, x.value_text, x.normalized_value, x.value_number, x.value_unit,
                                      x.period_start, x.period_end, x.target_type, x.target_entity_id, x.label, x.provenance), ',' ORDER BY x.id)) AS digest,
             md5(string_agg(concat_ws('|', x.id, x.canonical_key, x.fact_key, x.value_text, x.normalized_value, x.value_number, x.value_unit,
                                      x.period_start, x.period_end, x.target_type, x.target_entity_id), ',' ORDER BY x.id)) AS digest_v2,
             count(*)::int AS n,
             max(length(COALESCE(x.value_text, x.normalized_value, x.value_number::text))) AS max_len,
             max(x.created_at) AS changed_at,
             array_agg(DISTINCT upper(regexp_replace(COALESCE(x.normalized_value, x.value_text), '[^A-Za-z0-9]', '', 'g')))
               FILTER (WHERE x.canonical_key = ANY($2::text[]) AND COALESCE(x.normalized_value, x.value_text) IS NOT NULL) AS refs
        FROM document_facts x
       WHERE x.account_id = f.account_id AND x.file_id = f.id AND x.status = 'active') fx ON true
    LEFT JOIN LATERAL (
      -- Lot 76B (C4) : nature, statut, contrat et documents reliés de chaque Opération dans l'empreinte.
      SELECT array_agg(y.id ORDER BY y.id) AS ids,
             array_agg(DISTINCT y.ref) FILTER (WHERE y.ref IS NOT NULL) AS refs,
             md5(string_agg(y.sig, ',' ORDER BY y.id)) AS digest,
             max(y.changed_at) AS changed_at
        FROM (
          SELECT o.id, upper(regexp_replace(cd.contract_reference, '[^A-Za-z0-9]', '', 'g')) AS ref,
                 concat_ws('|', o.id, o.type_code, o.status, cd.contract_reference,
                   (SELECT string_agg(s2.source_entity_key, ',' ORDER BY s2.source_entity_key) FROM business_operation_sources s2
                     WHERE s2.account_id = o.account_id AND s2.operation_id = o.id AND s2.active AND s2.source_kind = 'DOCUMENT')) AS sig,
                 GREATEST(o.updated_at, max(s.created_at), cd.updated_at) AS changed_at
            FROM business_operation_sources s
            JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL
            LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
           WHERE s.account_id = f.account_id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = f.id::text
           GROUP BY o.id, o.account_id, o.type_code, o.status, o.updated_at, cd.contract_reference, cd.updated_at) y) ops ON true
    LEFT JOIN LATERAL (
      SELECT md5(string_agg(concat_ws('|', l.asset_id, l.room_id, l.equipment_id, l.link_role), ',' ORDER BY l.id)) AS digest,
             max(GREATEST(l.created_at, l.updated_at)) AS changed_at
        FROM document_asset_links l WHERE l.file_id = f.id AND l.account_id = f.account_id AND l.status = 'ACTIVE') lk ON true
   WHERE f.account_id = $1 AND ${ELIGIBLE} AND ${where}
   ${tail}`;

const refsOf = (...listes: unknown[]): string[] => [...new Set(listes.flatMap((l) => (Array.isArray(l) ? l : []))
  .map((x) => String(x ?? '')).filter((x) => isDiscriminantReference(x)))].sort();

function mapDoc(r: Row): NamingDoc {
  return {
    id: Number(r.id), name: String(r.retained_title), originalName: s(r.original_filename), filename: s(r.filename),
    s3Key: s(r.s3_key), publicId: s(r.public_id), titleSource: String(r.title_source ?? 'SYSTEM'), legacyUserEdit: r.legacy_user_edit === true,
    typeCode: s(r.type_code), supplier: s(r.supplier), documentDate: s(r.document_date),
    assetId: n(r.asset_id), assetName: s(r.asset_name), extractionId: n(r.extraction_id), extractedAt: iso(r.extracted_at),
    extractionTitle: s(r.extraction_title), amountCents: n(r.amount_cents),
    rubricCode: s(r.rubric_code), supplierSiret: s(r.supplier_siret), extractionVersion: s(r.extraction_version),
    factsDigest: s(r.facts_digest), contractRefs: refsOf(r.fact_refs, r.operation_refs),
    operationIds: Array.isArray(r.operation_ids) ? [...new Set((r.operation_ids as unknown[]).map(Number))].sort((a, b) => a - b) : [],
    linksDigest: s(r.links_digest),
    operationsDigest: s(r.operations_digest), factsDigestV2: s(r.facts_digest_v2),
    factsCount: Number(r.facts_n ?? 0), factMaxLength: Number(r.fact_max_len ?? 0), textChars: Number(r.text_chars ?? 0),
    contextChangedAt: iso(r.context_changed_at),
    textRefs: Array.isArray(r.text_keys) ? (r.text_keys as unknown[]).map(String) : [],
    textVersion: r.text_version == null ? null : String(r.text_version),
  };
}

/** Version du texte d'un document pour le cache des indices (C6) : extraction, ou '' sans extraction. */
export const textVersionOf = (d: Pick<NamingDoc, 'extractionVersion'>): string => d.extractionVersion ?? '';

/**
 * Lot 76B (C6) : texte extrait (fenêtre `NAMING_TEXT_WINDOW`) des documents
 * dont les indices textuels sont à (re)calculer — lu par petits paquets, une
 * seule fois par version d'extraction (cache de l'index).
 */
export async function loadTextsForHints(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const lot = ids.slice(i, i + 100);
    const rows = (await pgClient.unsafe(
      `SELECT file_id, left(COALESCE(NULLIF(full_text, ''), description, ''), ${NAMING_TEXT_WINDOW}) AS txt
         FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`,
      [accountId, lot] as never[],
    )) as unknown as Row[];
    for (const r of rows) out.set(Number(r.file_id), String(r.txt ?? ''));
  }
  return out;
}

/**
 * Page de documents éligibles APRÈS le curseur (identifiant croissant) —
 * lecture exhaustive du stock, sans plafond (E1).
 */
export async function loadNamingDocsPage(accountId: number, afterId: number, pageSize: number): Promise<NamingDoc[]> {
  const rows = (await pgClient.unsafe(docSelect('f.id > $3', 'ORDER BY f.id LIMIT $4'),
    [accountId, [...REFERENCE_KEYS], afterId, pageSize] as never[])) as unknown as Row[];
  return rows.map(mapDoc);
}

/** Documents éligibles d'un lot (lus par identifiant, toujours bornés au compte). */
export async function loadNamingDocsByIds(accountId: number, ids: readonly number[]): Promise<NamingDoc[]> {
  if (!ids.length) return [];
  const rows = (await pgClient.unsafe(docSelect('f.id = ANY($3::int[])', 'ORDER BY f.id'),
    [accountId, [...REFERENCE_KEYS], ids] as never[])) as unknown as Row[];
  return rows.map(mapDoc);
}

// ── Index persistant (lot 72B, E1 / E4) ────────────────────────────────────

export interface MemberRow {
  id: number; keys: string[]; hash: string;
  /** Lot 76B (C6) : cache des indices textuels et version d'extraction correspondante. Absents : inchangés. */
  textKeys?: string[]; textVersion?: string;
}

/** Enregistre une page de l'index ; rend le nombre de documents nouveaux ou modifiés. */
export async function upsertMembers(accountId: number, rows: readonly MemberRow[]): Promise<number> {
  if (!rows.length) return 0;
  const res = (await pgClient.unsafe(
    `INSERT INTO document_naming_members (account_id, file_id, link_keys, doc_hash, text_keys, text_version)
     SELECT $1, x.id, ARRAY(SELECT jsonb_array_elements_text(x.keys)), x.hash,
            CASE WHEN x.tkeys IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(x.tkeys)) END, x.tver
       FROM jsonb_to_recordset($2::jsonb) AS x(id int, keys jsonb, hash text, tkeys jsonb, tver text)
     ON CONFLICT (account_id, file_id) DO UPDATE SET link_keys = EXCLUDED.link_keys, doc_hash = EXCLUDED.doc_hash, updated_at = now(),
            text_keys = COALESCE(EXCLUDED.text_keys, document_naming_members.text_keys),
            text_version = COALESCE(EXCLUDED.text_version, document_naming_members.text_version)
      WHERE document_naming_members.doc_hash IS DISTINCT FROM EXCLUDED.doc_hash
         OR document_naming_members.link_keys IS DISTINCT FROM EXCLUDED.link_keys
         OR (EXCLUDED.text_version IS NOT NULL AND document_naming_members.text_version IS DISTINCT FROM EXCLUDED.text_version)
     RETURNING file_id`,
    [accountId, JSON.stringify(rows.map((r) => ({ id: r.id, keys: r.keys, hash: r.hash, tkeys: r.textKeys ?? null, tver: r.textVersion ?? null })))] as never[],
  )) as unknown as Row[];
  return res.length;
}

/** Index complet du compte (identifiants, clés, empreintes — jamais le contenu). */
export async function loadMembers(accountId: number): Promise<MemberRow[]> {
  const rows = (await pgClient.unsafe(
    `SELECT file_id, link_keys, doc_hash FROM document_naming_members WHERE account_id = $1 ORDER BY file_id`,
    [accountId] as never[],
  )) as unknown as Row[];
  return rows.map((r) => ({ id: Number(r.file_id), keys: (r.link_keys as string[] | null) ?? [], hash: String(r.doc_hash) }));
}

/** Empreintes mises à jour après un examen (noms écrits) : l'index reflète l'état réel. */
export async function updateMemberHashes(accountId: number, rows: ReadonlyArray<{ id: number; hash: string }>): Promise<void> {
  if (!rows.length) return;
  await pgClient.unsafe(
    `UPDATE document_naming_members m SET doc_hash = x.hash, updated_at = now()
       FROM jsonb_to_recordset($2::jsonb) AS x(id int, hash text)
      WHERE m.account_id = $1 AND m.file_id = x.id AND m.doc_hash IS DISTINCT FROM x.hash`,
    [accountId, JSON.stringify(rows)] as never[],
  );
}

/** Retire de l'index des documents (devenus inéligibles). */
export async function deleteMembers(accountId: number, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await pgClient.unsafe(`DELETE FROM document_naming_members WHERE account_id = $1 AND file_id = ANY($2::int[])`, [accountId, ids] as never[]);
}

/** Fin de cycle de lecture : retire de l'index les documents qui ne sont plus éligibles (supprimés, regroupés…). */
export async function purgeIneligibleMembers(accountId: number): Promise<number> {
  const rows = (await pgClient.unsafe(
    // Différence ensembliste (HashSetOp, linéaire) : une anti-jointure corrélée pouvait être
    // planifiée en boucle imbriquée sur l'index du compte (quadratique sur un gros stock).
    `DELETE FROM document_naming_members m
      USING (SELECT file_id FROM document_naming_members WHERE account_id = $1
             EXCEPT
             SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND ${ELIGIBLE}) x
      WHERE m.account_id = $1 AND m.file_id = x.file_id
      RETURNING m.file_id`,
    [accountId] as never[],
  )) as unknown as Row[];
  return rows.length;
}

/** Dernières écritures journalisées d'un document (harmonisation, titre T1/T3). */
export interface NameTrace {
  /** Lot 76B (C3) : `oldName` — nom remplacé par cette écriture (justification d'un renommage fait par l'examen). */
  harmonization: { name: string; at: string; fingerprint: string | null; oldName?: string | null } | null;
  titleEvent: { name: string | null; at: string; origin: string } | null;
}

/**
 * Origine du nom EN PLACE (pure) — auto-validante : une écriture journalisée
 * ne vaut origine que si son nom est TOUJOURS le nom en place.
 */
export function deriveNameOrigin(d: Pick<NamingDoc, 'name' | 'titleSource' | 'legacyUserEdit' | 'originalName' | 'filename' | 's3Key' | 'publicId'>, t: NameTrace | undefined): NameOrigin {
  if (d.titleSource === 'USER') return 'USER';
  if (d.legacyUserEdit && isValidBusinessTitle(d.name, { s3Key: d.s3Key, publicId: d.publicId })) return 'USER';
  const nom = d.name.trim();
  const h = t?.harmonization && t.harmonization.name.trim() === nom ? t.harmonization : null;
  const e = t?.titleEvent && (t.titleEvent.name ?? '').trim() === nom ? t.titleEvent : null;
  if (h && (!e || h.at >= e.at)) return 'T3_HARMONIZATION';
  if (e) return e.origin === 'T1' ? 'T1' : 'T3';
  if ([d.originalName, d.filename].some((x) => x && x.trim() === nom)) return 'UPLOAD';
  return 'UNKNOWN';
}

export async function loadNameTraces(accountId: number, ids: readonly number[]): Promise<Map<number, NameTrace>> {
  const out = new Map<number, NameTrace>();
  if (!ids.length) return out;
  const [h, e] = await Promise.all([
    pgClient.unsafe(
      `SELECT DISTINCT ON (file_id) file_id, applied_name, created_at, document_fingerprint, old_name
         FROM document_rename_events
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'APPLIED'
        ORDER BY file_id, id DESC`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT DISTINCT ON (file_id) file_id, new_title, created_at, origin
         FROM document_title_events
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'UPDATED'
        ORDER BY file_id, id DESC`,
      [accountId, ids] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
  ]);
  const get = (id: number) => out.get(id) ?? (out.set(id, { harmonization: null, titleEvent: null }), out.get(id)!);
  for (const r of h) get(Number(r.file_id)).harmonization = { name: String(r.applied_name), at: iso(r.created_at)!, fingerprint: s(r.document_fingerprint), oldName: s(r.old_name) };
  for (const r of e) get(Number(r.file_id)).titleEvent = { name: s(r.new_title), at: iso(r.created_at)!, origin: String(r.origin) };
  return out;
}

/**
 * Détail des documents d'UN appel (lot 72B, E5) : TOUS les faits actifs, le
 * texte intégral (fenêtre `NAMING_TEXT_WINDOW`, la même que les garde-fous —
 * lot 76B, C6), toutes les
 * Opérations actives liées (contrat, documents reliés) et l'historique du
 * nom — puis une SÉLECTION pertinente sous budget (`selectFacts`,
 * `selectPassages`), avec la provenance de chaque élément transmis.
 */
export async function loadDocDetails(accountId: number, ids: readonly number[]): Promise<Map<number, NamingDocDetail>> {
  const out = new Map<number, NamingDocDetail>();
  for (const id of ids) out.set(id, { facts: [], excerpt: null, operations: [], history: [], passages: [], contracts: [] });
  if (!ids.length) return out;
  const [faits, extraits, ops, histo, titres] = await Promise.all([
    pgClient.unsafe(
      `SELECT f.file_id, f.id, COALESCE(f.canonical_key, f.label, f.fact_key) AS key, f.canonical_key IS NOT NULL AS canonical,
              f.canonical_key = ANY($3::text[]) AS contract_ref, COALESCE(f.provenance, 'T1_EXTRACTION') AS provenance,
              COALESCE(f.value_text, f.normalized_value, CASE WHEN f.value_number IS NULL THEN NULL ELSE f.value_number::text || COALESCE(' ' || f.value_unit, '') END) AS value,
              CASE WHEN f.period_start IS NULL AND f.period_end IS NULL THEN NULL
                   ELSE COALESCE(to_char(f.period_start, 'YYYY-MM-DD'), '?') || ' → ' || COALESCE(to_char(f.period_end, 'YYYY-MM-DD'), '?') END AS period
         FROM document_facts f
        WHERE f.account_id = $1 AND f.file_id = ANY($2::int[]) AND f.status = 'active'
        ORDER BY f.file_id, f.id`,
      [accountId, ids, [...REFERENCE_KEYS]] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, left(COALESCE(NULLIF(full_text, ''), description, ''), ${NAMING_TEXT_WINDOW}) AS txt,
              GREATEST(COALESCE(full_text_chars, 0), length(COALESCE(NULLIF(full_text, ''), description, ''))) AS full_text_chars
         FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT s.source_entity_key::int AS file_id, o.id, o.type_code, o.status, cd.contract_reference,
              ARRAY(SELECT DISTINCT s2.source_entity_key::int FROM business_operation_sources s2
                     WHERE s2.account_id = s.account_id AND s2.operation_id = o.id AND s2.active AND s2.source_kind = 'DOCUMENT'
                       AND s2.source_entity_key <> s.source_entity_key AND s2.source_entity_key ~ '^[0-9]+$' ORDER BY 1 LIMIT 20) AS related
         FROM business_operation_sources s
         JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL
         LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
        WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ANY($2::text[])
        ORDER BY 1, o.id`,
      [accountId, ids.map(String)] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, old_name, applied_name, created_at FROM (
         SELECT file_id, old_name, applied_name, created_at, row_number() OVER (PARTITION BY file_id ORDER BY id DESC) AS rang
           FROM document_rename_events WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'APPLIED') x
        WHERE rang <= 3`,
      [accountId, ids] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT file_id, old_title, new_title, created_at, origin FROM (
         SELECT file_id, old_title, new_title, created_at, origin, row_number() OVER (PARTITION BY file_id ORDER BY id DESC) AS rang
           FROM document_title_events WHERE account_id = $1 AND file_id = ANY($2::int[]) AND outcome = 'UPDATED') x
        WHERE rang <= 3`,
      [accountId, ids] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
  ]);
  const brutParDoc = new Map<number, RawFact[]>();
  for (const r of faits) {
    if (r.value == null) continue;
    const l = brutParDoc.get(Number(r.file_id)) ?? [];
    l.push({ id: Number(r.id), key: String(r.key), value: String(r.value), period: s(r.period), provenance: String(r.provenance),
      canonical: r.canonical === true, contractReference: r.contract_ref === true });
    brutParDoc.set(Number(r.file_id), l);
  }
  const texte = new Map<number, { txt: string; chars: number }>(extraits.map((r) => [Number(r.file_id), { txt: String(r.txt ?? ''), chars: Number(r.full_text_chars ?? 0) }]));
  for (const [id, d] of out) {
    const brut = brutParDoc.get(id) ?? [];
    const { selected, omitted } = selectFacts(brut);
    d.facts = selected;
    const t = texte.get(id);
    const { head, passages, textChars, omittedPassages } = selectPassages(t?.txt);
    d.excerpt = head;
    d.passages = passages;
    const contrats = new Map<string, string>();
    for (const f of brut) if (f.contractReference) contrats.set(f.value.trim(), `T1_FACT#${f.id}`);
    d.contracts = [...contrats].map(([reference, source]) => ({ reference, source }));
    const total = Math.max(textChars, t?.chars ?? 0);
    // Lot 76B (C6) : omissions signalées au modèle (abstention possible) et au rapport.
    const omissions = {
      factsOmitted: omitted, factValuesShortened: selected.filter((f) => f.truncated).length,
      discriminantPassagesOmitted: omittedPassages, textBeyondWindow: Math.max(0, total - NAMING_TEXT_WINDOW),
      significant: omitted > 0 || omittedPassages > 0 || total > NAMING_TEXT_WINDOW,
    };
    d.context = {
      factsTotal: brut.length, factsProvided: selected.length, textChars: total, passagesProvided: passages.length,
      sufficient: selected.length > 0 || passages.length > 0 || (head?.length ?? 0) >= 40, omissions,
    };
  }
  for (const r of ops) {
    const d = out.get(Number(r.file_id));
    if (!d) continue;
    d.operations.push({ id: Number(r.id), type: s(r.type_code), status: String(r.status), contractReference: s(r.contract_reference),
      relatedDocumentIds: Array.isArray(r.related) ? (r.related as unknown[]).map(Number).filter((x) => Number.isFinite(x)) : [],
      source: 'BUSINESS_OPERATION' });
    if (r.contract_reference) d.contracts!.push({ reference: String(r.contract_reference), source: `OPERATION#${r.id}` });
  }
  for (const r of histo) out.get(Number(r.file_id))?.history.push({ at: iso(r.created_at)!, from: s(r.old_name), to: s(r.applied_name), origin: 'T3_HARMONIZATION' });
  for (const r of titres) out.get(Number(r.file_id))?.history.push({ at: iso(r.created_at)!, from: s(r.old_title), to: s(r.new_title), origin: String(r.origin) });
  for (const d of out.values()) d.history.sort((a, b) => (a.at < b.at ? 1 : -1)).splice(3);
  return out;
}

/**
 * Données connues d'un document (garde « aucune invention ») : date, périodes
 * et valeurs des faits, montant, titre et texte d'extraction, bien,
 * fournisseur, nom déposé. Lot 76B (C6) : MÊME fenêtre de texte que le
 * contexte transmis à l'IA (`NAMING_TEXT_WINDOW`, auparavant 60 000 contre
 * 100 000), valeurs de faits entières, noms antérieurs transmis à l'IA
 * (historique) : une information transmise n'est jamais refusée pour être
 * hors de la fenêtre de validation.
 */
export async function loadKnownData(accountId: number, doc: NamingDoc): Promise<KnownDocumentData> {
  const [faits, ext, ops, histo] = await Promise.all([
    pgClient.unsafe(
      `SELECT COALESCE(value_text, normalized_value, value_number::text) AS v, normalized_value AS nv, label,
              to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe
         FROM document_facts WHERE account_id = $1 AND file_id = $2 AND status = 'active' ORDER BY id LIMIT 10000`,
      [accountId, doc.id] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT title, description, supplier_name, to_char(document_date, 'YYYY-MM-DD') AS d, amount_cents,
              left(COALESCE(NULLIF(full_text, ''), description, ''), ${NAMING_TEXT_WINDOW}) AS txt
         FROM document_extractions WHERE account_id = $1 AND file_id = $2`,
      [accountId, doc.id] as never[],
    ) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT cd.contract_reference AS r FROM business_operation_sources s
         JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id AND o.invalidated_at IS NULL
         JOIN business_operation_contract_details cd ON cd.operation_id = o.id
        WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2 AND cd.contract_reference IS NOT NULL`,
      [accountId, String(doc.id)] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
    pgClient.unsafe(
      `SELECT old_name AS n FROM document_rename_events WHERE account_id = $1 AND file_id = $2 AND outcome = 'APPLIED' AND old_name IS NOT NULL
       UNION SELECT old_title FROM document_title_events WHERE account_id = $1 AND file_id = $2 AND outcome = 'UPDATED' AND old_title IS NOT NULL`,
      [accountId, doc.id] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
  ]);
  const e = ext[0];
  const textes = [
    doc.extractionTitle, doc.supplier, doc.assetName, doc.originalName,
    s(e?.title), s(e?.description), s(e?.supplier_name), s(e?.txt),
    ...faits.flatMap((f) => [s(f.v), s(f.nv), s(f.label)]),
    ...ops.map((o) => s(o.r)),
    ...histo.map((h) => s(h.n)),
  ].filter((t): t is string => !!t && t.trim().length > 0);
  return {
    dates: [doc.documentDate, s(e?.d)].filter((x): x is string => !!x),
    periods: faits.filter((f) => f.ps || f.pe).map((f) => ({ start: s(f.ps), end: s(f.pe) })),
    amountsCents: [doc.amountCents, n(e?.amount_cents)].filter((x): x is number => x != null),
    texts: textes,
  };
}

// ── État des lots ───────────────────────────────────────────────────────────

/**
 * DONE : examen complet, écritures finalisées. IN_PROGRESS : examen commencé
 * (progression persistée). DEFERRED : reporté (plafond de coût, IA bloquée).
 * ERROR : erreur ou sortie incomplète, reprise datée et bornée.
 * PROMPT_UNAVAILABLE : version active du prompt inutilisable pour le nommage.
 * WRITE_PENDING (lot 72B, E6) : examen IA terminé, écritures à reprendre.
 * Ligne « * » du compte : état global (stock, curseur de lecture, reprise).
 */
export type GroupStatus = 'DONE' | 'IN_PROGRESS' | 'DEFERRED' | 'ERROR' | 'PROMPT_UNAVAILABLE' | 'WRITE_PENDING' | 'UPGRADE_REVIEW';
export interface GroupProgress {
  nextChunk: number; chunks: number; examined: number[]; startedAt: string;
  /** Lot 76B (C3) : empreinte du contexte EXAMINÉ de chaque document (`examinedContextHash`) et partie d'examen. */
  ctx?: Record<string, string>;
  /** Lot 76B (C5) : empreinte (v3) du lot au moment où son réexamen a été programmé. */
  upgradeFp?: string;
}
/** Lot 76B (C5) : recalage d'un lot d'une version antérieure du contexte. */
export type UpgradeState = 'TECHNICAL' | 'EXPECTED' | 'REVIEWED';
export interface GroupState {
  key: string;
  status: GroupStatus;
  fingerprint: string | null;
  progress: GroupProgress | null;
  /** Empreinte de chaque document au dernier examen complet (`docSnapshotHash`). */
  snapshot: Record<string, string> | null;
  conventions: unknown[];
  promptVersion: string | null;
  lastReviewedAt: string | null;
  retryAfter: string | null;
  attempts: number;
  /** Lot 72B : version du contexte ayant produit `fingerprint` (null : lot 61). */
  contextVersion?: string | null;
  lastError?: string | null;
  documentCount?: number;
  /** Lot 76B : dernière mise à jour de l'état (date d'examen à défaut de `lastReviewedAt`). */
  updatedAt?: string | null;
  upgradeState?: UpgradeState | null;
  upgradeFrom?: string | null;
}

export async function loadGroupStates(accountId: number): Promise<Map<string, GroupState>> {
  const rows = (await pgClient.unsafe(
    `SELECT group_key, status, fingerprint, progress, snapshot, conventions, prompt_version, last_reviewed_at, retry_after, attempts,
            context_version, last_error, document_count, updated_at, upgrade_state, upgrade_from
       FROM document_naming_groups WHERE account_id = $1`,
    [accountId] as never[],
  )) as unknown as Row[];
  return new Map(rows.map((r) => [String(r.group_key), {
    key: String(r.group_key), status: String(r.status) as GroupStatus, fingerprint: s(r.fingerprint),
    progress: (r.progress as GroupProgress | null) ?? null, snapshot: (r.snapshot as Record<string, string> | null) ?? null,
    conventions: Array.isArray(r.conventions) ? r.conventions as unknown[] : [],
    promptVersion: s(r.prompt_version), lastReviewedAt: iso(r.last_reviewed_at), retryAfter: iso(r.retry_after), attempts: Number(r.attempts ?? 0),
    contextVersion: s(r.context_version), lastError: s(r.last_error), documentCount: Number(r.document_count ?? 0),
    updatedAt: iso(r.updated_at), upgradeState: (s(r.upgrade_state) as UpgradeState | null), upgradeFrom: s(r.upgrade_from),
  }]));
}

export type SaveGroupState = Omit<GroupState, 'lastReviewedAt' | 'progress' | 'updatedAt'> & {
  progress: unknown;
  documentCount: number; lastError?: string | null; reviewed?: boolean;
  /** Lot 76B (C5) : nouvel état de recalage (absent : inchangé). */
  upgrade?: { state: UpgradeState; from: string | null; reason: string | null } | null;
};

type SqlClient = Pick<typeof pgClient, 'unsafe'>;

export async function saveGroupState(accountId: number, st: SaveGroupState, client: SqlClient = pgClient): Promise<void> {
  const up = st.upgrade ?? null;
  await client.unsafe(
    `INSERT INTO document_naming_groups (account_id, group_key, status, fingerprint, document_count, progress, snapshot, conventions, prompt_version,
                                         last_reviewed_at, retry_after, last_error, attempts, context_version,
                                         upgrade_state, upgrade_from, upgrade_reason, upgrade_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $13::jsonb, $7::jsonb, $8, CASE WHEN $9::boolean THEN now() END, $10::timestamptz, $11, $12, $14,
             $16, $17, $18, CASE WHEN $15::boolean THEN now() END)
     ON CONFLICT (account_id, group_key) DO UPDATE SET
       status = EXCLUDED.status, fingerprint = EXCLUDED.fingerprint, document_count = EXCLUDED.document_count,
       progress = EXCLUDED.progress, snapshot = EXCLUDED.snapshot, conventions = EXCLUDED.conventions, prompt_version = EXCLUDED.prompt_version,
       last_reviewed_at = COALESCE(EXCLUDED.last_reviewed_at, document_naming_groups.last_reviewed_at),
       retry_after = EXCLUDED.retry_after, last_error = EXCLUDED.last_error, attempts = EXCLUDED.attempts,
       context_version = EXCLUDED.context_version, updated_at = now(),
       upgrade_state = CASE WHEN $15::boolean THEN EXCLUDED.upgrade_state ELSE document_naming_groups.upgrade_state END,
       upgrade_from = CASE WHEN $15::boolean THEN EXCLUDED.upgrade_from ELSE document_naming_groups.upgrade_from END,
       upgrade_reason = CASE WHEN $15::boolean THEN EXCLUDED.upgrade_reason ELSE document_naming_groups.upgrade_reason END,
       upgrade_at = CASE WHEN $15::boolean THEN now() ELSE document_naming_groups.upgrade_at END`,
    [accountId, st.key, st.status, st.fingerprint, st.documentCount, st.progress ? JSON.stringify(st.progress) : null,
      JSON.stringify(st.conventions ?? []), st.promptVersion, st.reviewed === true, st.retryAfter, st.lastError ?? null, st.attempts,
      st.snapshot ? JSON.stringify(st.snapshot) : null, st.contextVersion ?? null,
      up != null, up?.state ?? null, up?.from ?? null, up?.reason?.slice(0, 300) ?? null] as never[],
  );
}

/**
 * Lot 76B (C5) — recalage des versions antérieures, pour le reporting du
 * compte (BO) : migrations techniques, réexamens attendus, réexamens faits.
 */
export async function upgradeTotals(accountId: number): Promise<{ technical: number; expected: number; reviewed: number }> {
  const rows = (await pgClient.unsafe(
    `SELECT upgrade_state AS s, count(*)::int AS n FROM document_naming_groups
      WHERE account_id = $1 AND group_key <> '*' AND upgrade_state IS NOT NULL GROUP BY upgrade_state`,
    [accountId] as never[],
  )) as unknown as Row[];
  const n = (k: string) => Number(rows.find((r) => r.s === k)?.n ?? 0);
  return { technical: n('TECHNICAL'), expected: n('EXPECTED'), reviewed: n('REVIEWED') };
}

/**
 * Lot 76B (C5) : dernière modification de FAITS du compte (journal de
 * connaissance 0292 : création, modification, désactivation, suppression) —
 * une modification sans date propre au document rend la preuve du recalage
 * impossible (prudence). null : journal absent ou vide.
 */
export async function lastFactsChangeAt(accountId: number): Promise<string | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT max(changed_at) AS at FROM account_knowledge_changes WHERE account_id = $1 AND kind = 'FACT'`,
    [accountId] as never[],
  ).catch(() => [{ at: null }])) as unknown as Array<{ at: unknown }>;
  return iso(r?.at);
}

/** Lot 76B (C5) : réexamens de recalage commencés ou terminés sur 24 h glissantes, TOUS comptes (borne globale). */
export async function upgradeReviewsLastDay(): Promise<number> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM document_naming_groups
      WHERE (upgrade_state = 'REVIEWED' AND upgrade_at > now() - interval '24 hours')
         OR (upgrade_state = 'EXPECTED' AND status <> 'UPGRADE_REVIEW' AND updated_at > now() - interval '24 hours')`,
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

/** États de lots disparus de l'index (lot recomposé, documents supprimés) : retirés en fin de cycle de lecture. */
export async function deleteGroupStates(accountId: number, keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  await pgClient.unsafe(`DELETE FROM document_naming_groups WHERE account_id = $1 AND group_key = ANY($2::text[]) AND group_key <> '*'`, [accountId, keys] as never[]);
}

// ── Journal et écriture ────────────────────────────────────────────────────

/** Lot 76B (C2) : DECIDED — décision validée, persistée AVANT son application (transitoire). */
export type RenameOutcome = 'APPLIED' | 'REFUSED' | 'CONFLICT' | 'NO_CHANGE' | 'FAILED' | 'DECIDED';
/** Écriture restant à faire : décision persistée non appliquée, ou écriture en échec (C1, C2). */
const PENDING = `outcome IN ('FAILED', 'DECIDED') AND retry_status = 'PENDING'`;
export type RetryStatus = 'PENDING' | 'RESOLVED' | 'CONFLICT' | 'SUPERSEDED' | 'ABANDONED';
export interface RenameEvent {
  accountId: number;
  fileId: number;
  groupKey: string;
  accountRunId: number | null;
  outcome: RenameOutcome;
  reasonCode: string | null;
  oldName: string | null;
  expectedName: string;
  proposedName: string;
  appliedName: string | null;
  referenceIds: number[];
  aiReason: string;
  confidence: string;
  nameOrigin: NameOrigin;
  documentFingerprint: string;
  promptVersion: string | null;
  traceId: string | null;
  /** Empreinte de l'appel (lot + partie) : clé d'idempotence avec le document et les noms. */
  callKey: string;
  /** Lot 72B (E6) : nom validé par les garde-fous, à écrire lors d'une reprise. */
  validatedName?: string | null;
  retryStatus?: RetryStatus | null;
  /** Lot 72B : APPLIED issu de la reprise de cet échec. */
  retryOf?: number | null;
}

export function renameIdempotencyKey(e: Pick<RenameEvent, 'accountId' | 'fileId' | 'expectedName' | 'proposedName' | 'callKey' | 'outcome'>): string {
  return createHash('sha256').update(JSON.stringify([e.accountId, e.fileId, e.expectedName, e.proposedName, e.callKey, e.outcome === 'APPLIED'])).digest('hex');
}

const EVENT_COLS = `account_id, file_id, group_key, account_run_id, origin, outcome, reason_code, old_name, expected_name, proposed_name,
  applied_name, reference_document_ids, ai_reason, confidence, name_origin, document_fingerprint, prompt_version, trace_id, idempotency_key,
  call_key, validated_name, retry_status, retry_of`;
const eventParams = (e: RenameEvent) => [
  e.accountId, e.fileId, e.groupKey, e.accountRunId, 'T3_HARMONIZATION', e.outcome, e.reasonCode, e.oldName, e.expectedName.slice(0, 500),
  e.proposedName.slice(0, 500), e.appliedName, e.referenceIds, e.aiReason.slice(0, 400), e.confidence, e.nameOrigin, e.documentFingerprint,
  e.promptVersion, e.traceId, renameIdempotencyKey(e), e.callKey, e.validatedName ?? null, e.retryStatus ?? null, e.retryOf ?? null,
];
const EVENT_VALUES = '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::int[],$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23';

/** Journalise une issue SANS écriture du nom (refus, conflit, équivalent, échec). Rend l'identifiant, ou null (déjà journalisé). */
export async function recordRenameEvent(e: RenameEvent): Promise<number | null> {
  const rows = (await pgClient.unsafe(
    `INSERT INTO document_rename_events (${EVENT_COLS}) VALUES (${EVENT_VALUES})
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    eventParams(e) as never[],
  )) as unknown as Row[];
  return rows[0] ? Number(rows[0].id) : null;
}

/** Décision persistée non appliquée, ou dont l'écriture a échoué : à reprendre sans appel IA (E6, C1, C2). */
export interface PendingWrite extends RenameEvent { eventId: number; retryAttempts: number; validatedName: string; pendingOutcome: 'FAILED' | 'DECIDED' }

export async function loadPendingWrites(accountId: number, groupKey?: string): Promise<PendingWrite[]> {
  const rows = (await pgClient.unsafe(
    `SELECT id, outcome, file_id, group_key, old_name, expected_name, proposed_name, validated_name, reference_document_ids, ai_reason, confidence,
            name_origin, document_fingerprint, prompt_version, trace_id, call_key, retry_attempts
       FROM document_rename_events
      WHERE account_id = $1 AND ${PENDING} AND ($2::text IS NULL OR group_key = $2)
      ORDER BY id`,
    [accountId, groupKey ?? null] as never[],
  )) as unknown as Row[];
  return rows.filter((r) => r.validated_name && r.call_key).map((r) => ({
    eventId: Number(r.id), accountId, fileId: Number(r.file_id), groupKey: String(r.group_key), accountRunId: null, outcome: 'FAILED',
    reasonCode: 'WRITE_FAILED', oldName: s(r.old_name), expectedName: String(r.expected_name ?? ''), proposedName: String(r.proposed_name ?? ''),
    appliedName: null, referenceIds: ((r.reference_document_ids as number[] | null) ?? []).map(Number), aiReason: String(r.ai_reason ?? ''),
    confidence: String(r.confidence ?? 'certain'), nameOrigin: String(r.name_origin ?? 'UNKNOWN') as NameOrigin,
    documentFingerprint: String(r.document_fingerprint ?? ''), promptVersion: s(r.prompt_version), traceId: s(r.trace_id),
    callKey: String(r.call_key), validatedName: String(r.validated_name), retryAttempts: Number(r.retry_attempts ?? 0),
    pendingOutcome: r.outcome === 'DECIDED' ? 'DECIDED' : 'FAILED',
  }));
}

/** Écritures en attente de reprise du compte (reporting exact, E6 / E8 ; décisions persistées non appliquées comprises, C1). */
export async function countPendingWrites(accountId: number): Promise<number> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM document_rename_events WHERE account_id = $1 AND ${PENDING}`,
    [accountId] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

/** Lot 76B (C1) : écritures restantes par lot, lues en base — tous passages confondus. */
export async function pendingWritesByGroup(accountId: number): Promise<Map<string, number>> {
  const rows = (await pgClient.unsafe(
    `SELECT COALESCE(group_key, '') AS k, count(*)::int AS n FROM document_rename_events WHERE account_id = $1 AND ${PENDING} GROUP BY 1`,
    [accountId] as never[],
  )) as unknown as Row[];
  return new Map(rows.map((r) => [String(r.k), Number(r.n)]));
}

/**
 * Issue d'une reprise d'écriture sur la décision d'origine (jamais une
 * nouvelle ligne d'échec). Lot 76B (C2) : `failed` — l'écriture d'une décision
 * persistée (DECIDED) a échoué : elle devient FAILED / PENDING (reprise).
 */
export async function markRetry(accountId: number, eventId: number, status: RetryStatus, opts: { attempted?: boolean; failed?: boolean } = {}): Promise<void> {
  await pgClient.unsafe(
    `UPDATE document_rename_events SET retry_status = $3, retry_attempts = retry_attempts + CASE WHEN $4::boolean THEN 1 ELSE 0 END, retried_at = now(),
            outcome = CASE WHEN $5::boolean THEN 'FAILED' ELSE outcome END,
            reason_code = CASE WHEN $5::boolean THEN 'WRITE_FAILED' ELSE reason_code END
      WHERE account_id = $1 AND id = $2 AND outcome IN ('FAILED', 'DECIDED')`,
    [accountId, eventId, status, opts.attempted === true, opts.failed === true] as never[],
  );
}

/** Décisions en attente d'un lot devenues sans objet (contexte changé : le lot est réexaminé). */
export async function supersedePendingWrites(accountId: number, groupKeys: readonly string[]): Promise<number> {
  if (!groupKeys.length) return 0;
  const rows = (await pgClient.unsafe(
    `UPDATE document_rename_events SET retry_status = 'SUPERSEDED', retried_at = now()
      WHERE account_id = $1 AND ${PENDING} AND group_key = ANY($2::text[]) RETURNING id`,
    [accountId, groupKeys] as never[],
  )) as unknown as Row[];
  return rows.length;
}

/** Lot 76B (C3) : décisions en attente de documents réexaminés, sortis ou déplacés du lot (remplacées par le nouvel examen). */
export async function supersedePendingWritesForFiles(accountId: number, groupKey: string, fileIds: readonly number[]): Promise<number> {
  if (!fileIds.length) return 0;
  const rows = (await pgClient.unsafe(
    `UPDATE document_rename_events SET retry_status = 'SUPERSEDED', retried_at = now()
      WHERE account_id = $1 AND ${PENDING} AND group_key = $2 AND file_id = ANY($3::int[]) RETURNING id`,
    [accountId, groupKey, fileIds] as never[],
  )) as unknown as Row[];
  return rows.length;
}

/** Lot 76B (C1) : fin de cycle de lecture — décisions en attente d'un lot qui n'existe plus (recomposé) : sans objet. */
export async function supersedePendingWritesExcept(accountId: number, activeKeys: readonly string[]): Promise<number> {
  const rows = (await pgClient.unsafe(
    `UPDATE document_rename_events SET retry_status = 'SUPERSEDED', retried_at = now()
      WHERE account_id = $1 AND ${PENDING} AND NOT (COALESCE(group_key, '') = ANY($2::text[])) RETURNING id`,
    [accountId, activeKeys] as never[],
  )) as unknown as Row[];
  return rows.length;
}

/** Lot 76B (C2) : écriture refusée par le compare-and-swap — la décision devient la trace du conflit (jamais forcé). */
export async function resolveDecisionConflict(accountId: number, eventId: number, reason: string): Promise<void> {
  await pgClient.unsafe(
    `UPDATE document_rename_events SET outcome = 'CONFLICT', reason_code = $3, retry_status = NULL, retried_at = now()
      WHERE account_id = $1 AND id = $2 AND outcome IN ('DECIDED', 'FAILED')`,
    [accountId, eventId, reason] as never[],
  );
}

/** Décision validée à persister avant son application (C2). */
export interface ChunkDecision { event: RenameEvent & { validatedName: string } }

/**
 * Lot 76B (C2) — persistance d'une partie d'examen, dans UNE transaction :
 * état du lot (progression : documents examinés et empreinte de leur
 * contexte) et décisions validées (DECIDED / PENDING), AVANT toute écriture.
 * Rejouée (reprise) : mêmes clés d'idempotence, aucun doublon ; une décision
 * déjà traitée est rendue avec son état (jamais réappliquée).
 * Rend, par document, la décision persistée.
 */
export async function persistChunk(accountId: number, state: SaveGroupState, decisions: readonly ChunkDecision[]): Promise<Map<number, { eventId: number; retryStatus: string | null; outcome: string }>> {
  const out = new Map<number, { eventId: number; retryStatus: string | null; outcome: string }>();
  await pgClient.begin(async (tx) => {
    for (const d of decisions) {
      const e: RenameEvent = { ...d.event, outcome: 'DECIDED', reasonCode: 'DECIDED', retryStatus: 'PENDING' };
      const [r] = (await tx.unsafe(
        `INSERT INTO document_rename_events (${EVENT_COLS}) VALUES (${EVENT_VALUES})
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id, retry_status, outcome`,
        eventParams(e) as never[],
      )) as unknown as Row[];
      out.set(d.event.fileId, { eventId: Number(r.id), retryStatus: s(r.retry_status), outcome: String(r.outcome) });
    }
    await saveGroupState(accountId, state, tx as unknown as SqlClient);
  });
  return out;
}

export type ApplyResult =
  | { status: 'APPLIED'; eventId: number }
  | { status: 'CONFLICT'; reason: 'CONCURRENT_USER_RENAME' | 'CONCURRENT_NAME_CHANGE' | 'DOCUMENT_GONE'; currentName: string | null }
  | { status: 'ALREADY_APPLIED' };

/**
 * Écrit le nom harmonisé sous compare-and-swap et le journalise, dans UNE
 * transaction (jamais l'un sans l'autre). Lot 76B (C2) : `decision` — la
 * décision persistée est résolue dans la MÊME transaction (DECIDED retirée,
 * FAILED marquée RESOLVED) : une interruption ne laisse jamais un renommage
 * fait avec une décision encore « à reprendre », ni l'inverse.
 */
export async function applyRename(e: RenameEvent & { appliedName: string }, decision?: { id: number; outcome: 'DECIDED' | 'FAILED' } | null): Promise<ApplyResult> {
  let res: ApplyResult | null = null;
  const resoudre = async (tx: SqlClient) => {
    if (!decision) return;
    if (decision.outcome === 'DECIDED') {
      await tx.unsafe(`DELETE FROM document_rename_events WHERE account_id = $1 AND id = $2 AND outcome = 'DECIDED'`, [e.accountId, decision.id] as never[]);
    } else {
      await tx.unsafe(
        `UPDATE document_rename_events SET retry_status = 'RESOLVED', retry_attempts = retry_attempts + 1, retried_at = now()
          WHERE account_id = $1 AND id = $2 AND outcome = 'FAILED'`,
        [e.accountId, decision.id] as never[],
      );
    }
  };
  await pgClient.begin(async (tx) => {
    const up = (await tx.unsafe(
      `UPDATE asset_files
          SET retained_title = $3, title_source = 'SYSTEM', title_checked_at = now(), updated_at = now()
        WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
          AND title_source = 'SYSTEM'
          AND NOT COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false)
          -- Lot 87D : titre sous convention du service de nommage : jamais renommé par T3.
          AND title_convention IS NULL
          AND retained_title IS NOT DISTINCT FROM $4::text
        RETURNING id`,
      [e.fileId, e.accountId, e.appliedName, e.oldName] as never[],
    )) as unknown as Row[];
    if (!up.length) return;
    const ev = (await tx.unsafe(
      `INSERT INTO document_rename_events (${EVENT_COLS}) VALUES (${EVENT_VALUES})
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      eventParams({ ...e, outcome: 'APPLIED' }) as never[],
    )) as unknown as Row[];
    // Même décision déjà journalisée (reprise) : aucune écriture sans trace — annulation.
    if (!ev.length) throw new AlreadyApplied();
    await resoudre(tx as unknown as SqlClient);
    res = { status: 'APPLIED', eventId: Number(ev[0].id) };
  }).catch((err) => { if (err instanceof AlreadyApplied) res = { status: 'ALREADY_APPLIED' }; else throw err; });
  if (res) {
    // Déjà appliquée (journal APPLIED présent) : la décision en attente est résolue — jamais réappliquée.
    if ((res as ApplyResult).status === 'ALREADY_APPLIED') await resoudre(pgClient);
    return res;
  }
  const [apres] = (await pgClient.unsafe(
    `SELECT retained_title, title_source, COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy
       FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [e.fileId, e.accountId] as never[],
  )) as unknown as Row[];
  if (!apres) return { status: 'CONFLICT', reason: 'DOCUMENT_GONE', currentName: null };
  if (apres.title_source === 'USER' || apres.legacy === true) return { status: 'CONFLICT', reason: 'CONCURRENT_USER_RENAME', currentName: s(apres.retained_title) };
  return { status: 'CONFLICT', reason: 'CONCURRENT_NAME_CHANGE', currentName: s(apres.retained_title) };
}
class AlreadyApplied extends Error { constructor() { super('renommage déjà journalisé'); } }

/** Relecture du journal transactionnel : renommages APPLIED réellement présents (confirmation du rapport). */
export async function confirmedRenames(accountId: number, eventIds: readonly number[]): Promise<Map<number, { fileId: number; appliedName: string }>> {
  if (!eventIds.length) return new Map();
  const rows = (await pgClient.unsafe(
    `SELECT id, file_id, applied_name FROM document_rename_events WHERE account_id = $1 AND id = ANY($2::bigint[]) AND outcome = 'APPLIED'`,
    [accountId, eventIds] as never[],
  )) as unknown as Row[];
  return new Map(rows.map((r) => [Number(r.id), { fileId: Number(r.file_id), appliedName: String(r.applied_name) }]));
}

/**
 * Fenêtre glissante de 24 h des appels DOCUMENT_NAMING du compte : nombre et
 * date à laquelle le plus ancien en sortira (reprise datée au plafond).
 */
export async function namingCallsWindow(accountId: number): Promise<{ count: number; oldestAt: string | null }> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n, min(created_at) AS oldest FROM ai_usage_event
      WHERE account_id = $1 AND operation_code = 't3_document_naming' AND created_at > now() - interval '24 hours'`,
    [accountId] as never[],
  ).catch(() => [{ n: 0, oldest: null }])) as unknown as Array<{ n: number; oldest: unknown }>;
  return { count: Number(r?.n ?? 0), oldestAt: iso(r?.oldest) };
}

/** Appels DOCUMENT_NAMING du compte sur 24 h glissantes (traces de la passerelle). */
export async function namingCallsLastDay(accountId: number): Promise<number> {
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM ai_usage_event
      WHERE account_id = $1 AND operation_code = 't3_document_naming' AND created_at > now() - interval '24 hours'`,
    [accountId] as never[],
  ).catch(() => [{ n: 0 }])) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}
