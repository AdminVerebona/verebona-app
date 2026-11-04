/**
 * T3 DOCUMENT_ASSET — SOURCES du graphe d'identité (lot 108E, ticket « T3
 * DOCUMENT_ASSET — correctif #626 bis », A1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ : le graphe (lot 105D) ne lisait que l'extraction (texte
 * borné à 60 000 caractères pour un document sans bien, 8 000 pour un
 * document rattaché) et certains faits actifs. Les unités source, tableaux,
 * faits non résolus, preuves de T1 et relations d'événements de référence —
 * pourtant persistés — étaient ignorés : une identité lue seulement dans une
 * ligne de tableau ou un fait non intégré ne reconstituait aucun groupe.
 *
 * TOUTE LA CONNAISSANCE PERSISTÉE, PAR PAGES, SANS RESCAN (jamais le fichier,
 * jamais d'OCR, jamais T1) :
 *   · EXTRACTION      titre, description, résumé visuel, type, fournisseur,
 *                     multibiens ;
 *   · TRANSCRIPTION   texte INTÉGRAL (aucune fenêtre) ;
 *   · FACTS           faits ACTIFS d'identité (adresse, cadastre, plaque, VIN,
 *                     série, IMEI, marque / modèle, contrats, DPE) ;
 *   · SOURCE_UNITS    `document_source_units` COVERED / UNRESOLVED / UNCERTAIN
 *                     (lacunes de pages, FAILED et NON_INFORMATIONAL écartés ;
 *                     unité de texte COUVERTE dont le texte figure DÉJÀ dans la
 *                     transcription écartée — dédoublonnage exact, jamais une
 *                     borne), page et unité conservées, UNCERTAIN = indice ;
 *   · TABLES          lignes / tableaux (cellules de la charge utile) ;
 *   · UNRESOLVED_FACTS charge brute des faits non intégrés (UNRESOLVED,
 *                     RETAINED) — un motif non fiable = indice seulement ;
 *   · T1_CANDIDATES   preuves lues par T1 pour ses candidats (indice) ;
 *   · OPERATIONS      relations ACTIVES du document à un événement de
 *                     référence (autorité forte → un saut ; sinon indice).
 *
 * Lectures GROUPÉES par page de documents (`PAGE_DOCUMENTS`), jamais une
 * requête par document ; un profil est calculé page par page puis le texte
 * est libéré (mémoire bornée sans borne de découverte). Une source dont la
 * couche n'existe pas (migration absente) est DÉCLARÉE absente dans la
 * couverture ; une lecture en échec LÈVE (le graphe est alors indisponible,
 * jamais silencieusement partiel).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { IdentityProfileInput } from './signals';
import { RELIABLE_UNRESOLVED_REASONS } from '../source-unit-provider';

type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Documents lus par requête groupée (texte intégral : page modeste). */
export const PAGE_DOCUMENTS = 100;

/** Clés canoniques d'identité lues dans `document_facts`. */
export const IDENTITY_FACT_KEYS: readonly string[] = [
  'address1', 'postalCode', 'city', 'cadastralRef', 'registrationNumber', 'vin', 'serialNumber', 'imei', 'imeiNumber', 'modelName', 'model', 'brand', 'make',
  'insuranceContractNumber', 'contractNumber', 'dpeAdemeNumber',
];

/** Sources du graphe (journal T3 : sources exploitées / absentes). */
export const IDENTITY_SOURCE_KINDS = ['EXTRACTION', 'TRANSCRIPTION', 'FACTS', 'SOURCE_UNITS', 'TABLES', 'UNRESOLVED_FACTS', 'T1_CANDIDATES', 'OPERATIONS'] as const;
export type IdentitySourceKind = (typeof IDENTITY_SOURCE_KINDS)[number];

/** Couverture des sources d'UN document (sans valeur). */
export interface IdentitySourceCoverage {
  fileId: number;
  /** Éléments lus par source (0 : source présente, rien pour ce document). */
  counts: Partial<Record<IdentitySourceKind, number>>;
  /** Sources dont la couche n'existe pas (migration absente) ou vide pour ce document. */
  absent: IdentitySourceKind[];
  /** Caractères de transcription lus (intégralité). */
  transcriptionChars: number;
}

/** Autorités d'une relation d'événement de référence assez fortes pour un saut. */
const STRONG_OPERATION_AUTHORITIES = ['USER', 'DOCUMENT', 'STRUCTURED'];

/** Une relation d'événement de référence est-elle une preuve (autorité forte, confiance certaine) ? Pure. */
export function strongOperationRelation(r: { authority: string | null; confidence: string | null }): boolean {
  if (!r.authority || !STRONG_OPERATION_AUTHORITIES.includes(r.authority)) return false;
  return r.authority === 'USER' || r.confidence === 'certain';
}

/** Valeurs textuelles d'une charge utile (cellules d'une ligne), sans clés techniques. Pure. */
export function payloadCells(v: unknown, depth = 0): string[] {
  if (v === null || v === undefined || depth > 3) return [];
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (typeof v === 'number') return [String(v)];
  if (Array.isArray(v)) return v.flatMap((x) => payloadCells(x, depth + 1));
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !['confidence', 'score', 'provenance', 'page', 'index', 'row', 'column', 'pass', 'bbox', 'region'].includes(k))
      .flatMap(([k, x]) => (typeof x === 'string' || typeof x === 'number' ? [`${k} : ${String(x).trim()}`] : payloadCells(x, depth + 1)));
  }
  return [];
}

async function tableExists(sql: Sql, name: string): Promise<boolean> {
  const r = (await sql.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name] as never[])) as Array<{ ok: boolean }>;
  return r[0]?.ok === true;
}

/** Disponibilité des couches facultatives (mémorisée par appelant). */
export interface IdentityLayers { sourceUnits: boolean; unresolvedFacts: boolean; operations: boolean; resolutions: boolean }

export async function identityLayers(sql: Sql): Promise<IdentityLayers> {
  const [sourceUnits, unresolvedFacts, operations, resolutions] = await Promise.all([
    tableExists(sql, 'document_source_units'), tableExists(sql, 'document_unresolved_facts'),
    tableExists(sql, 'business_operation_sources'), tableExists(sql, 'document_asset_resolutions'),
  ]);
  return { sourceUnits, unresolvedFacts, operations, resolutions };
}

type Input = IdentityProfileInput & { texts: IdentityProfileInput['texts'][number][]; facts: IdentityProfileInput['facts'][number][] };

/**
 * Entrées des profils d'une PAGE de documents (lectures groupées). Lève sur
 * une lecture en échec ; une couche absente est déclarée dans la couverture.
 */
export async function loadIdentityInputs(
  sql: Sql, accountId: number, ids: readonly number[], layers: IdentityLayers,
): Promise<Map<number, { input: IdentityProfileInput; coverage: IdentitySourceCoverage }>> {
  const out = new Map<number, { input: Input; coverage: IdentitySourceCoverage }>();
  if (ids.length === 0) return out as never;
  const page = [...ids];
  const ext = (await sql.unsafe(
    `SELECT file_id, title, description, visual_summary, document_type_code, supplier_name, multi_asset, COALESCE(full_text, '') AS txt
       FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`,
    [accountId, page] as never[],
  )) as Array<{ file_id: number; title: string | null; description: string | null; visual_summary: string | null; document_type_code: string | null; supplier_name: string | null; multi_asset: boolean | null; txt: string }>;
  for (const e of ext) {
    const fileId = Number(e.file_id);
    const texts: Input['texts'] = [];
    if (e.title) texts.push({ origin: 'EXTRACTION', zone: 'TITLE', text: e.title });
    if (e.description) texts.push({ origin: 'EXTRACTION', zone: 'DESCRIPTION', text: e.description });
    if (e.visual_summary) texts.push({ origin: 'EXTRACTION', zone: 'DESCRIPTION', text: e.visual_summary });
    if (e.txt) texts.push({ origin: 'TRANSCRIPTION', zone: 'BODY', text: e.txt });
    out.set(fileId, {
      input: { fileId, title: e.title, description: e.description, documentType: e.document_type_code, supplier: e.supplier_name, multiAsset: e.multi_asset, texts, facts: [], operations: [] },
      coverage: {
        fileId, counts: { EXTRACTION: 1, TRANSCRIPTION: e.txt ? 1 : 0 }, absent: e.txt ? [] : ['TRANSCRIPTION'], transcriptionChars: e.txt.length,
      },
    });
  }
  const bump = (fileId: number, k: IdentitySourceKind, n = 1) => {
    const c = out.get(fileId)?.coverage;
    if (c) c.counts[k] = (c.counts[k] ?? 0) + n;
  };

  // ── Faits ACTIFS d'identité.
  const facts = (await sql.unsafe(
    `SELECT file_id, canonical_key, label, subject, raw_key, excerpt, confidence, COALESCE(normalized_value, value_text, value_number::text) AS v
       FROM document_facts
      WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' AND canonical_key = ANY($3::text[])
      ORDER BY id`,
    [accountId, page, [...IDENTITY_FACT_KEYS]] as never[],
  )) as Array<{ file_id: number; canonical_key: string | null; label: string | null; subject: string | null; raw_key: string | null; excerpt: string | null; confidence: string | null; v: string | null }>;
  for (const f of facts) {
    const it = out.get(Number(f.file_id));
    if (!it) continue;
    it.input.facts.push({ canonicalKey: f.canonical_key, label: f.label, subject: f.subject, rawKey: f.raw_key, excerpt: f.excerpt, confidence: f.confidence, value: f.v, origin: 'FACT' });
    bump(it.input.fileId, 'FACTS');
  }

  // ── Unités source (texte, libellé : valeur, tableaux) — dédoublonnage exact avec la transcription.
  if (layers.sourceUnits) {
    const units = (await sql.unsafe(
      `SELECT s.file_id, s.source_unit_id, s.kind, s.page, s.coverage_status, s.content_text, s.label, s.value_text, s.payload
         FROM document_source_units s
         LEFT JOIN document_extractions e ON e.file_id = s.file_id AND e.account_id = s.account_id
        WHERE s.account_id = $1 AND s.file_id = ANY($2::int[])
          AND s.coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN') AND s.kind <> 'PAGE_GAP'
          AND NOT (s.kind IN ('TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD') AND s.coverage_status = 'COVERED'
                   AND length(COALESCE(s.content_text, '')) > 0 AND strpos(COALESCE(e.full_text, ''), s.content_text) > 0)
        ORDER BY s.file_id, s.ordinal`,
      [accountId, page] as never[],
    )) as Array<{ file_id: number; source_unit_id: string; kind: string; page: number | null; coverage_status: string; content_text: string | null; label: string | null; value_text: string | null; payload: unknown }>;
    for (const u of units) {
      const it = out.get(Number(u.file_id));
      if (!it) continue;
      const table = u.kind === 'TABLE' || u.kind === 'TABLE_ROW';
      const charge = typeof u.payload === 'string' ? (() => { try { return JSON.parse(u.payload as string); } catch { return null; } })() : u.payload;
      const text = [
        (u.content_text ?? '').trim(),
        [u.label, u.value_text].filter((x) => x && String(x).trim()).join(' : '),
        ...(table ? payloadCells(charge) : []),
      ].filter(Boolean).join('\n');
      if (!text) continue;
      it.input.texts.push({
        origin: 'SOURCE_UNITS', zone: 'BODY', text, unitIds: [u.source_unit_id], page: u.page == null ? null : Number(u.page),
        ...(u.coverage_status === 'UNCERTAIN' ? { uncertain: true } : {}),
      });
      bump(it.input.fileId, table ? 'TABLES' : 'SOURCE_UNITS');
    }
  }

  // ── Faits non résolus (charge brute) : jamais une donnée canonique.
  if (layers.unresolvedFacts) {
    const nr = (await sql.unsafe(
      `SELECT id::float8 AS id, file_id, reason, raw_key, canonical_key, raw_value, original_payload, source_unit_ids
         FROM document_unresolved_facts
        WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status IN ('UNRESOLVED', 'RETAINED') AND reason <> 'FIELD_PRUNED'
        ORDER BY id`,
      [accountId, page] as never[],
    )) as Array<{ id: number; file_id: number; reason: string; raw_key: string | null; canonical_key: string | null; raw_value: string | null; original_payload: unknown; source_unit_ids: string[] | null }>;
    for (const f of nr) {
      const it = out.get(Number(f.file_id));
      if (!it) continue;
      const valeur = f.raw_value?.trim() || [...new Set(payloadCells(f.original_payload))].join(' — ');
      if (!valeur) continue;
      const fiable = RELIABLE_UNRESOLVED_REASONS.includes(f.reason);
      const unitIds = (f.source_unit_ids ?? []).length ? [...(f.source_unit_ids ?? [])] : [`unresolved:${Number(f.id)}`];
      // Fait (clé brute exploitable) ET texte (adresses, séries libellées dans la valeur).
      it.input.facts.push({
        canonicalKey: f.canonical_key && IDENTITY_FACT_KEYS.includes(f.canonical_key) ? f.canonical_key : null, label: f.raw_key, subject: null,
        rawKey: f.raw_key, excerpt: null, confidence: null, value: valeur, origin: 'UNRESOLVED_FACT', unitIds, ...(fiable ? {} : { uncertain: true }),
      });
      it.input.texts.push({
        origin: 'UNRESOLVED_FACTS', zone: 'BODY', text: [f.raw_key ?? f.canonical_key, valeur].filter(Boolean).join(' : '), unitIds,
        ...(fiable ? {} : { uncertain: true }),
      });
      bump(it.input.fileId, 'UNRESOLVED_FACTS');
    }
  }

  // ── Preuves lues par T1 pour ses candidats (indice de lecture).
  if (layers.resolutions) {
    const t1 = (await sql.unsafe(
      `SELECT file_id, t1_candidates FROM document_asset_resolutions WHERE account_id = $1 AND file_id = ANY($2::int[]) AND jsonb_array_length(COALESCE(t1_candidates, '[]'::jsonb)) > 0`,
      [accountId, page] as never[],
    )) as Array<{ file_id: number; t1_candidates: unknown }>;
    for (const r of t1) {
      const it = out.get(Number(r.file_id));
      if (!it) continue;
      const cands = (typeof r.t1_candidates === 'string' ? JSON.parse(r.t1_candidates) : r.t1_candidates) as Array<{ signals?: string; reason?: string }>;
      for (const c of Array.isArray(cands) ? cands : []) {
        for (const t of [c.signals, c.reason]) {
          if (typeof t === 'string' && t.trim()) { it.input.texts.push({ origin: 'T1_CANDIDATES', zone: 'SIGNAL', text: t, uncertain: true }); bump(it.input.fileId, 'T1_CANDIDATES'); }
        }
      }
    }
  }

  // ── Relations ACTIVES à un événement de référence (Opérations).
  if (layers.operations) {
    const ops = (await sql.unsafe(
      `SELECT s.source_entity_key AS file_key, s.operation_id::float8 AS operation_id, s.source_role, s.authority, s.confidence
         FROM business_operation_sources s
         JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
        WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ANY($2::text[])
          AND o.invalidated_at IS NULL AND o.status <> 'CANCELLED'
        ORDER BY s.id`,
      [accountId, page.map(String)] as never[],
    )) as Array<{ file_key: string; operation_id: number; source_role: string | null; authority: string | null; confidence: string | null }>;
    for (const o of ops) {
      const it = out.get(Number(o.file_key));
      if (!it) continue;
      (it.input.operations as Array<{ operationId: number; role: string | null; strong: boolean }>).push({
        operationId: Number(o.operation_id), role: o.source_role, strong: strongOperationRelation(o),
      });
      bump(it.input.fileId, 'OPERATIONS');
    }
  }

  for (const { coverage: c } of out.values()) {
    const absentes = new Set(c.absent);
    for (const k of IDENTITY_SOURCE_KINDS) {
      const couche = k === 'SOURCE_UNITS' || k === 'TABLES' ? layers.sourceUnits : k === 'UNRESOLVED_FACTS' ? layers.unresolvedFacts
        : k === 'OPERATIONS' ? layers.operations : k === 'T1_CANDIDATES' ? layers.resolutions : true;
      if (!couche || !(c.counts[k] ?? 0)) absentes.add(k);
    }
    c.absent = IDENTITY_SOURCE_KINDS.filter((k) => absentes.has(k));
  }
  return out as never;
}
