/**
 * Lot 113Q (Trello #714, P1) — diagnostic complet : MÉMOIRE BORNÉE et ZIP
 * DÉFINITIF, sur PostgreSQL 16 réel, avec un jeu VOLUMINEUX simulé : un bien
 * à LONG HISTORIQUE (milliers de preuves, décisions, écritures, rapports T3
 * et lignes de rapport) et de GROS TEXTES IA (faits de dizaines de Ko, une
 * ligne plus grosse que la borne d'un lot), plus un second bien au TRIPLE du
 * volume. Stockage OVH simulé en mémoire (envois en plusieurs parties,
 * lecture partielle `Range`, journal des commandes).
 *
 *   · E01 mémoire : la traçabilité des propriétés n'est plus proportionnelle
 *     à l'historique d'un bien — mesure du tas VIVANT (après ramasse-miettes)
 *     pendant la production, comparée à l'ancien algorithme (tout charger,
 *     tout construire) sur les deux volumes : l'ancien croît avec le volume,
 *     le nouveau non (seuils relatifs, aucun chiffre fragile) ; lots bornés
 *     en octets, très grosse ligne lue seule et COMPLÈTE ;
 *   · E02 égalité de contenu : chaque propriété développée (références →
 *     fichiers détaillés) = la chaîne de l'ancien algorithme (preuves,
 *     décisions et corrélations, conflits, écritures, lignes de rapport,
 *     mises à jour IA, faits, extractions, documents, traitements) ; volumes
 *     avant / après (répétitions supprimées) ;
 *   · E03 travail durable du compte : COMPLETE, ZIP définitif stocké, vérifié,
 *     lisible ; manifeste = entrées de l'archive ; deux téléchargements =
 *     mêmes octets, SANS nouvelle extraction ni compression (seule l'archive
 *     est relue) ; mesures persistées (mémoire par étape et par fichier,
 *     requêtes) ;
 *   · E04 MEMORY_GUARD : FAILED explicite, AUCUNE relance automatique (dite
 *     au BO), profilage clos (plus d'étape « en cours »), tentative close,
 *     aucun fichier ni envoi incomplet laissé ;
 *   · E05 exports successifs : pas d'accumulation durable de mémoire.
 */
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { expandedProperties, logicalRows } from '../property-chain';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

// Borne d'un lot de lecture réduite pour le test (2 Mio) : l'effet de la borne en OCTETS est net.
process.env.DIAG_EXPORT_BATCH_BYTES = String(2 * 1024 * 1024);

const s3 = vi.hoisted(() => {
  const objects = new Map<string, { body: Buffer }>();
  const uploads = new Map<string, { key: string; parts: Buffer[] }>();
  const log: Array<{ cmd: string; key: string }> = [];
  let n = 0;
  const client = {
    async send(c: { constructor: { name: string }; input: Record<string, any> }) {
      const i = c.input;
      log.push({ cmd: c.constructor.name, key: String(i.Key ?? i.Prefix ?? '') });
      switch (c.constructor.name) {
        case 'CreateMultipartUploadCommand': { const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id }; }
        case 'UploadPartCommand': { uploads.get(i.UploadId)!.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
        case 'CompleteMultipartUploadCommand': { const u = uploads.get(i.UploadId)!; objects.set(i.Key, { body: Buffer.concat(u.parts) }); uploads.delete(i.UploadId); return {}; }
        case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
        case 'ListMultipartUploadsCommand': return { Uploads: [...uploads.entries()].filter(([, u]) => u.key.startsWith(i.Prefix ?? '')).map(([UploadId, u]) => ({ Key: u.key, UploadId })), IsTruncated: false };
        case 'HeadObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: o.body.length };
        }
        case 'ListObjectsV2Command':
          return { Contents: [...objects.entries()].filter(([k]) => k.startsWith(i.Prefix ?? '')).sort(([a], [b]) => a.localeCompare(b)).map(([Key, o]) => ({ Key, Size: o.body.length })), IsTruncated: false };
        case 'GetObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          const m = /^bytes=-(\d+)$/.exec(String(i.Range ?? ''));
          const body = m ? o.body.subarray(Math.max(0, o.body.length - Number(m[1]))) : o.body;
          const { Readable } = await import('node:stream');
          const chunks: Buffer[] = [];
          for (let k = 0; k < body.length; k += 65_536) chunks.push(body.subarray(k, k + 65_536));
          const r = Readable.from(chunks, { objectMode: false }) as unknown as Record<string, unknown>;
          r.transformToByteArray = async () => new Uint8Array(body);
          return { Body: r };
        }
        case 'DeleteObjectsCommand': for (const x of i.Delete.Objects) objects.delete(x.Key); return {};
        default: throw new Error(`commande S3 non simulée : ${c.constructor.name}`);
      }
    },
  };
  return { objects, uploads, client, log };
});

vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => s3.client,
}));

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
/** Mémoire VIVANTE (après ramasse-miettes) : tas V8 + ArrayBuffer. */
const live = () => { gc(); gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const FIELDS = Array.from({ length: 24 }, (_, i) => `champL113q${String(i).padStart(2, '0')}`);
const HUGE_CHARS = 5 * MB;

scenario('L113Q', 'Diagnostic complet : mémoire bornée, références au lieu des répétitions, ZIP définitif vérifié', ({ sql, make }) => {
  afterAll(() => { vi.restoreAllMocks(); });
  const storage = { client: s3.client as never, bucket: 'bucket-e2e' };
  let A: AccountRow;
  let admin: { id: number };
  const assets: Record<'v1' | 'v3', number> = { v1: 0, v3: 0 };
  let hugeFact = 0;

  /** Historique dense d'UN bien, au volume `n` (facteur). */
  async function seed(assetId: number, n: number, huge: boolean) {
    const docs: number[] = [];
    for (let d = 0; d < 4; d++) {
      const f = await make.assetFile(A, { assetId });
      await sql`UPDATE asset_files SET retained_title = ${`Facture ${d} du bien ${assetId}`}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
      docs.push(f.id);
    }
    const ex: number[] = [];
    for (const f of docs) ex.push(Number((await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, operation_trace_id, fact_count)
      VALUES (${A.id}, ${f}, 'gemini', 'gemini-2.5-pro', 't1@v7', ${`tr-l113q-${f}`}, 10) RETURNING id`)[0].id));
    // Passages T3 (traces), décisions, écritures corrélées, rapports T3 et leurs lignes FIELD.
    const runs = 40 * n;
    await sql`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, shadow, trace_id, status)
              SELECT ${A.id}, ${assetId}, 'document_analyzed', false, gen_random_uuid(), 'completed' FROM generate_series(1, ${runs})`;
    const runRows = await sql<{ id: number; trace: string }[]>`SELECT id, trace_id::text AS trace FROM reconciliation_runs WHERE asset_id = ${assetId} ORDER BY id`;
    const runIds = runRows.map((r) => Number(r.id));
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
              SELECT r, ${A.id}, ${assetId}, f, 'apply', 'SINGLE_SOURCE', 'certain', true, '[]'::jsonb FROM unnest(${runIds}::int[]) r, unnest(${FIELDS}::text[]) f`;
    await sql`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, trace_id, outcome, dry_run)
              SELECT ${A.id}, ${assetId}, f, 'null'::jsonb, to_jsonb(repeat('valeur ', 40)), 'RECONCILIATION', 'document', ${String(docs[0])}, rr.trace_id::text, 'written', false
                FROM reconciliation_runs rr, unnest(${FIELDS}::text[]) f WHERE rr.asset_id = ${assetId}`;
    await sql`INSERT INTO ai_execution_reports (account_id, treatment, scope, asset_id, reconciliation_run_id, status, entry_count, counters)
              SELECT ${A.id}, 'T3', 'ASSET', ${assetId}, r, 'SUCCESS', ${FIELDS.length}, '{}'::jsonb FROM unnest(${runIds}::int[]) r`;
    await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, field_key, entity_type, entity_id, value, write_result, reason_code, reason)
              SELECT x.id, f.o::int, ${A.id}, 'FIELD', f.k, 'ASSET', ${assetId}, to_jsonb(repeat('v', 60)), 'WRITTEN', 'APPLIED', repeat('motif détaillé ', 20)
                FROM ai_execution_reports x, unnest(${FIELDS}::text[]) WITH ORDINALITY AS f(k, o) WHERE x.asset_id = ${assetId} AND x.treatment = 'T3'`;
    // Rapports T1 des documents (cités par les propriétés via leurs documents).
    for (let d = 0; d < docs.length; d++) {
      await sql`INSERT INTO ai_execution_reports (account_id, treatment, scope, file_id, asset_id, extraction_id, status, entry_count, counters)
                VALUES (${A.id}, 'T1', 'DOCUMENT', ${docs[d]}, ${assetId}, ${ex[d]}, 'SUCCESS', 0, '{}'::jsonb)`;
    }
    // Preuves : par champ, `60 n` candidates (extraits de ~2 Ko), clé canonique distincte pour un tiers ; quelques preuves d'équipement.
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, normalized_value, source_type, source_id, source_location, evidence_excerpt,
                                         confidence, authority_score, status, lifecycle_status, fingerprint, provider, model, prompt_version, target_type, target_entity_id)
              SELECT ${A.id}, ${assetId}, f, CASE WHEN g % 3 = 0 THEN 'canon_' || f ELSE f END, to_jsonb(g), g::text, 'document', (${docs}::int[])[1 + g % 4],
                     jsonb_build_object('page', 1 + g % 9), repeat('extrait de preuve ', 120), 'certain', 80, 'active', 'ACTIVE', ${`l113q-${assetId}-`} || f || '-' || g,
                     'gemini', 'gemini-2.5-pro', 't1@v7', 'ASSET', ${assetId}
                FROM unnest(${FIELDS}::text[]) f, generate_series(1, ${60 * n}) g`;
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, source_location, evidence_excerpt, confidence, authority_score, status, fingerprint, target_type, target_entity_id)
              SELECT ${A.id}, ${assetId}, 'brand', '"Marque"'::jsonb, 'document', ${docs[1]}, '{}'::jsonb, 'marque lue', 'certain', 50, 'active', ${`l113q-eq-${assetId}-`} || g, 'EQUIPMENT', 900000 + g
                FROM generate_series(1, 20) g`;
    // Faits T1 : GROS TEXTES IA (~70 Ko chacun) sur les clés des champs.
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_text, confidence, excerpt, location, status, provider, model, prompt_version)
              SELECT ${A.id}, (${docs}::int[])[1 + g % 4], (${ex}::int[])[1 + g % 4], f, f, f, repeat('Texte long produit par l’IA. ', 2500), 'certain', 'extrait', '{"page": 1}'::jsonb, 'active', 'gemini', 'gemini-2.5-pro', 't1@v7'
                FROM unnest(${FIELDS.slice(0, 6)}::text[]) f, generate_series(1, ${5 * n}) g`;
    if (huge) {
      hugeFact = Number((await sql<{ id: number }[]>`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_text, confidence, excerpt, location, status)
        VALUES (${A.id}, ${docs[0]}, ${ex[0]}, ${FIELDS[0]}, ${FIELDS[0]}, 'énorme', repeat('X', ${HUGE_CHARS}), 'certain', 'extrait', '{}'::jsonb, 'active') RETURNING id`)[0].id);
    }
    // Conflits (résolus) et mises à jour IA.
    await sql`INSERT INTO inconsistency_registry (account_id, asset_id, field_key, current_value, proposed_value, source_type, inconsistency_type, status, reason_code)
              SELECT ${A.id}, ${assetId}, f, 'a', 'b', 'document', 'VALUE_CONFLICT', 'resolved', 'CONFLICTING_SOURCES' FROM unnest(${FIELDS}::text[]) f, generate_series(1, ${2 * n})`;
    await sql`INSERT INTO ai_field_updates (account_id, asset_id, field_key, old_value, new_value, decision_type, provider, model)
              SELECT ${A.id}, ${assetId}, f, 'ancien', repeat('nouveau ', 30), 'apply', 'gemini', 'gemini-2.5-pro' FROM unnest(${FIELDS}::text[]) f, generate_series(1, ${8 * n})`;
  }

  beforeAll(async () => {
    admin = await make.user({ role: 'ADMIN' });
    A = await make.account({ plan: 'premium', name: 'Compte Historique L113Q' });
    for (const [k, n, huge] of [['v1', 1, true], ['v3', 3, false]] as const) {
      const a = await make.asset(A, { category: 'IMMOBILIER', name: `Bien historique ${k}`, keyCharacteristics: { acquisitionPrice: 250000, [FIELDS[0]]: 'x' } });
      assets[k] = a.id;
      await seed(a.id, n, huge);
    }
  }, 600_000);

  // ── Ancien algorithme (lot 91A) : tout l'historique du bien chargé, toutes ses propriétés construites ──
  async function legacyParts(assetId: number): Promise<Map<string, Json>> {
    const { maskForExport } = await import('@/services/admin/diagnostics-export/model');
    const { isSensitiveCanonicalKey } = await import('@/services/admin/account-data/dossier');
    const M = (v: unknown) => maskForExport(v, { isSensitiveKey: isSensitiveCanonicalKey });
    const maskValue = (k: string, v: unknown) => (isSensitiveCanonicalKey(k) && v !== null && v !== undefined && v !== '' ? { $etat: 'masque', motif: 'donnée sensible (registre)' } : v);
    const N = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const Acc = A.id;
    const q = async (text: string, params: unknown[] = [Acc, assetId]): Promise<Json[]> =>
      (await sql.unsafe(`SELECT row_to_json(x) AS r FROM (${text}) x`, params as never[])).map((r: Json) => (typeof r.r === 'string' ? JSON.parse(r.r) : r.r));
    const evidences = await q(`SELECT id, field_key, canonical_key, value_json, normalized_value, raw_value, source_type, source_id, source_version, source_location, evidence_excerpt,
         evidence_origin, confidence, authority_score, status, lifecycle_status, superseded_at, superseded_by_evidence_id, analysis_run_id, operation_trace_id,
         provider, model, prompt_version, document_type, document_date, extracted_at, target_type, target_entity_id FROM field_evidence WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
    const decisions = await q(`SELECT d.id, d.run_id, d.field_key, d.action, d.reason_code, d.confidence, d.deterministic, d.evidence_ids, d.source_priority, d.created_at,
         r.triggered_by, r.trace_id::text AS run_trace_id, r.status AS run_status, r.shadow
    FROM reconciliation_decisions d LEFT JOIN reconciliation_runs r ON r.id = d.run_id AND r.account_id = d.account_id WHERE d.account_id = $1 AND d.asset_id = $2 ORDER BY d.id`);
    const conflicts = await q(`SELECT id, field_key, current_value, proposed_value, source_type, source_detail, inconsistency_type, status, resolution, resolved_at, resolved_by,
         current_evidence_ids, proposed_evidence_ids, authority_rule, decision_mode, reason_code, current_origin, operation_trace_id::text AS operation_trace_id, created_at, updated_at
    FROM inconsistency_registry WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
    const writes = await q(`SELECT id, canonical_key, old_value, new_value, origin, actor_user_id, source_type, source_id, trace_id, outcome, dry_run, divergence, mirror_columns, created_at, target_type, target_id
    FROM canonical_field_writes WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
    const aiUpdates = await q(`SELECT id, field_key, old_value, new_value, evidence_id, decision_type, reason_code, provider, model, prompt_version, confidence, asset_file_id, reverted_at, reverted_by, target_type, target_id, created_at
    FROM ai_field_updates WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
    const recoveries = await q(`SELECT id, run_id, object_type, object_id, field_key, decision, cause, value_before, value_after, proposed_value, findings, rejected, evidence_ids, provenance, write_outcome, prompt_version, context_fp, created_at
    FROM property_recovery_decisions WHERE account_id = $1 AND asset_id = $2 ORDER BY id`);
    const docIds = [...new Set([
      ...(await q(`SELECT id FROM asset_files WHERE account_id = $1 AND (asset_id = $2 OR linked_asset_id = $2) UNION SELECT file_id FROM document_asset_links WHERE account_id = $1 AND asset_id = $2`)).map((r) => Number(r.id)),
      ...evidences.filter((e) => /^(document|file|asset_file)$/i.test(String(e.source_type ?? ''))).map((e) => Number(e.source_id)),
    ].filter((x) => Number.isSafeInteger(x) && x > 0))].sort((a, b) => a - b);
    const docs = await q(`SELECT id, retained_title, document_date, analysis_state, deleted_at FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[]) ORDER BY id`, [Acc, docIds]);
    const facts = await q(`SELECT id, file_id, extraction_id, fact_key, canonical_key, raw_key, label, value_text, value_number, value_unit, value_json, normalized_value, raw_value,
         confidence, excerpt, location, source_unit_ids, status, target_type, target_entity_id, provider, model, prompt_version, created_at
    FROM document_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND canonical_key IS NOT NULL ORDER BY id`, [Acc, docIds]);
    const extractions = await q(`SELECT id, file_id, analysis_run_id, provider, model, prompt_version, operation_trace_id, document_type_code, fact_count, extracted_at
    FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[]) ORDER BY id`, [Acc, docIds]);
    const reports = await q(`SELECT id, treatment, status, job_id, file_id, asset_id, extraction_id, reconciliation_run_id, trace_ids, counters, created_at
    FROM ai_execution_reports WHERE account_id = $1 AND (asset_id = $2 OR file_id = ANY($3::int[])) ORDER BY id`, [Acc, assetId, docIds]);
    const entries = await q(`SELECT r.id AS report_id, r.treatment, r.reconciliation_run_id, e.seq, e.section, e.field_key, e.entity_type, e.entity_id, e.old_value, e.value,
         e.write_result, e.reason_code, e.reason, e.record_status, e.table_name, e.record_id
    FROM ai_execution_reports r JOIN ai_execution_report_entries e ON e.account_id = r.account_id AND e.report_id = coalesce(r.entries_report_id, r.id)
   WHERE r.account_id = $1 AND r.id = ANY($2::bigint[]) AND e.field_key IS NOT NULL AND e.section IN ('FIELD', 'PROJECTION', 'NOT_EXAMINED', 'DECLARED') ORDER BY r.id, e.seq`, [Acc, reports.map((r) => Number(r.id))]);
    const jobIds = [...new Set(reports.map((r) => N(r.job_id)).filter((x): x is number => x !== null))];
    const target = (t: unknown, id: unknown) => (t && String(t).toUpperCase() !== 'ASSET' && id != null ? `${String(t).toUpperCase()}#${id}` : `ASSET#${assetId}`);
    const key = (c: string, f: string) => `${c}|${f}`;
    const group = (rows: Json[], keys: (r: Json) => unknown[]) => {
      const m = new Map<string, Json[]>();
      for (const r of rows) for (const k of new Set(keys(r).map(String))) { if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
      return m;
    };
    const evBy = group(evidences, (e) => [key(target(e.target_type, e.target_entity_id), String(e.field_key)), ...(e.canonical_key && e.canonical_key !== e.field_key ? [key(target(e.target_type, e.target_entity_id), String(e.canonical_key))] : [])]);
    const decBy = group(decisions, (d) => [key(`ASSET#${assetId}`, String(d.field_key))]);
    const conBy = group(conflicts, (c) => [key(`ASSET#${assetId}`, String(c.field_key))]);
    const wrBy = group(writes, (x) => [key(target(x.target_type, x.target_id), String(x.canonical_key))]);
    const recBy = group(recoveries, (x) => [key(target(x.object_type, x.object_id), String(x.field_key))]);
    const aiBy = group(aiUpdates, (x) => [key(target(x.target_type, x.target_id), String(x.field_key))]);
    const repBy = group(entries.filter((e) => e.section !== 'DECLARED' || e.entity_type == null || String(e.entity_type).toUpperCase() === 'ASSET'), (e) => [key(target(e.entity_type, e.entity_type && String(e.entity_type).toUpperCase() !== 'ASSET' ? e.entity_id : null), String(e.field_key))]);
    const factsBy = group(facts, (f) => [String(f.canonical_key)]);
    const keys = new Set<string>();
    for (const m of [evBy, decBy, conBy, wrBy, aiBy, repBy, recBy]) for (const k of m.keys()) keys.add(k);
    const docById = new Map(docs.map((d) => [Number(d.id), d]));
    const out = new Map<string, Json>();
    for (const k of keys) {
      const cible = k.slice(0, k.indexOf('|'));
      const champ = k.slice(k.indexOf('|') + 1);
      const isSelf = cible === `ASSET#${assetId}`;
      const ev = evBy.get(k) ?? []; const wr = wrBy.get(k) ?? []; const rep = repBy.get(k) ?? [];
      const fa = isSelf ? (factsBy.get(champ) ?? []) : [];
      const evFiles = new Set(ev.map((e) => (/^(document|file|asset_file)$/i.test(String(e.source_type ?? '')) ? Number(e.source_id) : null)).filter((x): x is number => x !== null));
      const fileIds = [...new Set([...evFiles, ...fa.map((f) => Number(f.file_id))])].sort((a, b) => a - b);
      out.set(`${assetId}|${k}`, JSON.parse(JSON.stringify(M({
        ecritures: wr, ecrituresRapport: rep.map((e) => ({ ...e, value: maskValue(champ, e.value), old_value: maskValue(champ, e.old_value) })), misesAJourIA: aiBy.get(k) ?? [],
        decisions: (decBy.get(k) ?? []).map((d) => ({
          ...d,
          ecrituresCorrelees: wr.filter((x) => d.run_trace_id && String(x.trace_id ?? '') === String(d.run_trace_id)).map((x) => x.id),
          resultatRapport: rep.filter((e) => e.section === 'FIELD' && N(e.reconciliation_run_id) === N(d.run_id)).map((e) => ({ rapport: e.report_id, seq: e.seq, ecriture: e.write_result, motif: e.reason_code, detail: e.reason })),
        })),
        conflits: conBy.get(k) ?? [],
        reprisesProprieteManquante: (recBy.get(k) ?? []).map((r) => ({ ...r, value_before: maskValue(champ, r.value_before), value_after: maskValue(champ, r.value_after), proposed_value: maskValue(champ, r.proposed_value) })),
        preuves: ev.map((e) => ({ ...e, document: /^(document|file|asset_file)$/i.test(String(e.source_type ?? '')) ? N(e.source_id) : null, page: (e.source_location as Json | null)?.page ?? null })),
        faits: fa.map((f) => ({ ...f, projeteEnPreuve: ev.some((e) => Number(e.source_id) === Number(f.file_id)) })),
        extractions: extractions.filter((x) => fileIds.includes(Number(x.file_id))).map((x) => ({ id: x.id, document: x.file_id, analyse: x.analysis_run_id, modele: x.model, versionPrompt: x.prompt_version, trace: x.operation_trace_id, faits: x.fact_count, extraitLe: x.extracted_at })),
        documents: fileIds.map((f) => docById.get(f) ?? { id: f, motif: 'document absent du compte (supprimé définitivement ?)' }),
        traitements: {
          rapports: reports.filter((r) => fileIds.includes(Number(r.file_id)) || (N(r.asset_id) === assetId && r.treatment === 'T3')).map((r) => ({ id: r.id, traitement: r.treatment, statut: r.status, job: r.job_id, document: r.file_id, passageT3: r.reconciliation_run_id, traces: r.trace_ids, creeLe: r.created_at })),
          jobs: jobIds,
        },
      }))));
    }
    return out;
  }

  const out: Record<string, { files: Record<string, string>; peak: number; stats: Json | null }> = {};
  it('L113Q-E01 mémoire : l’ancien algorithme croît avec l’historique du bien, le nouveau non ; lots bornés en octets, très grosse ligne lue seule et complète', async () => {
    // Mesure : production SANS garder le texte écrit (seule la mémoire de travail du moteur compte) ;
    // puis une seconde production garde le contenu pour la comparaison (E02).
    const run = async (assetId: number, keep: boolean) => {
      const { withDiagnosticPlan } = await import('@/services/admin/diagnostics-export/collect');
      const files: Record<string, string> = {};
      let stats: Json | null = null;
      const base = live();
      let peak = 0;
      let k = 0;
      await withDiagnosticPlan({ scope: 'asset', id: assetId, reinforced: false } as never, { adminUserId: admin.id }, async (plan, s) => {
        for (const e of plan.entries.filter((x) => x.path.startsWith('tracabilite/proprietes'))) {
          const parts: string[] = [];
          await e.produce({ write: async (c: string) => { if (keep) parts.push(c); else if (++k % 3 === 0) peak = Math.max(peak, live() - base); } });
          if (keep) files[e.path] = parts.join('');
        }
        stats = { ...((s as unknown as { stats?: Json }).stats ?? {}) };
      });
      return { files, peak: Math.max(0, peak), stats };
    };
    const measure = async (assetId: number) => {
      const m = await run(assetId, false);
      const c = await run(assetId, true);
      return { files: c.files, peak: m.peak, stats: m.stats };
    };
    out.v1 = await measure(assets.v1);
    out.v3 = await measure(assets.v3);
    const legacyRetained = async (assetId: number) => { const b = live(); const parts = await legacyParts(assetId); const r = live() - b; expect(parts.size).toBeGreaterThan(FIELDS.length); return r; };
    const old1 = await legacyRetained(assets.v1);
    const old3 = await legacyRetained(assets.v3);
    const fmt = (x: number) => `${Math.round(x / MB)} Mo`;
    console.info(`[l113q-mesure] ${JSON.stringify({ ancien: { v1: fmt(old1), v3: fmt(old3) }, nouveau: { v1: fmt(out.v1.peak), v3: fmt(out.v3.peak) }, lots: out.v3.stats })}`);
    // L'ancien algorithme retient l'historique ENTIER : il croît nettement avec le volume.
    expect(old3).toBeGreaterThan(old1 * 1.8);
    // Le nouveau : mémoire de travail sans rapport avec l'historique (au plus la moitié de la croissance de l'ancien),
    // et inférieure à l'ancien sur le gros volume.
    expect(out.v3.peak - out.v1.peak).toBeLessThan((old3 - old1) / 2);
    expect(out.v3.peak).toBeLessThan(old3);
    // Lots bornés en OCTETS : la très grosse ligne (5 Mio > borne de 2 Mio) est lue seule, jamais tronquée.
    expect(out.v1.stats?.oversizedRows).toBeGreaterThanOrEqual(1);
    expect(out.v1.stats?.maxRowBytes).toBeGreaterThan(HUGE_CHARS);
    const faits = logicalRows(out.v1.files, 'tracabilite/proprietes/faits.json');
    expect(faits.find((f) => Number(f.id) === hugeFact)?.value_text).toHaveLength(HUGE_CHARS);
  }, 600_000);

  it('L113Q-E02 égalité de contenu : chaque propriété développée = l’ancienne chaîne ; les répétitions sont remplacées par des références', async () => {
    for (const k of ['v1', 'v3'] as const) {
      const assetId = assets[k];
      const legacy = await legacyParts(assetId);
      const props = expandedProperties(out[k].files);
      const byKey = new Map(props.map((p) => [`${p.bien}|${p.cible}|${p.champ}`, p]));
      // Toute propriété de l'ancienne chaîne est présente, avec EXACTEMENT les mêmes informations et relations.
      for (const [key, old] of legacy) {
        const p = byKey.get(key);
        expect(p, key).toBeDefined();
        for (const part of Object.keys(old)) expect(canon(p![part]), `${key} › ${part}`).toBe(canon(old[part]));
      }
      // Propriétés sans historique (lues seulement par l'écran / la fiche) : aucune référence inventée.
      for (const p of props) if (!legacy.has(`${p.bien}|${p.cible}|${p.champ}`)) expect(p.preuves.length + p.decisions.length + p.ecritures.length, `${p.cible}|${p.champ}`).toBe(0);
      // Volumes avant / après : l'ancienne chaîne recopiait tout l'historique ; les références + détails sont bien plus légers.
      const before = [...legacy.values()].reduce((n, v) => n + JSON.stringify(v).length, 0);
      const after = Object.values(out[k].files).reduce((n, c) => n + c.length, 0);
      const chain = logicalRows(out[k].files, 'tracabilite/proprietes.json');
      console.info(`[l113q-volumes] ${JSON.stringify({ bien: k, proprietes: chain.length, ancienneChaineOctets: before, chaineEtDetailsOctets: after, chaineSeuleOctets: JSON.stringify(chain).length })}`);
      expect(after).toBeLessThan(before);
      // Rapports T3 du bien : une fois (biens.json), plus dans chaque propriété.
      const bien = logicalRows(out[k].files, 'tracabilite/proprietes/biens.json').find((b) => Number(b.bien) === assetId)!;
      expect(bien.rapportsT3.length).toBe(k === 'v1' ? 40 : 120);
      expect(JSON.stringify(chain)).not.toMatch(/"traitements"/);
    }
  }, 600_000);

  let jobId = '';
  it('L113Q-E03 travail du compte : COMPLETE, ZIP définitif stocké et vérifié ; deux téléchargements sans nouvelle extraction ni compression', async () => {
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    const { job } = await repo.enqueueDiagnosticJob({ adminUserId: admin.id, request: { scope: 'account', id: A.id, reinforced: false } });
    jobId = job.id;
    const [st] = await drainDiagnosticJobs({ onlyId: job.id, storage, workerId: `e2e-l113q:${process.pid}:a`, heartbeatMs: 500 });
    expect(st).toBe('COMPLETE');
    const archive = (await repo.readDiagnosticArchive(job.id))!;
    expect(archive).toMatchObject({ zip64: false });
    expect(archive.key).toMatch(new RegExp(`^admin-exports/diagnostics/${job.id}/a1/archive/.+\\.zip$`));
    const stored = s3.objects.get(archive.key)!.body;
    expect(stored.length).toBe(archive.bytes);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(archive.sha256);
    // Deux téléchargements : mêmes octets ; seule l'archive est lue (aucun envoi, aucun .gz relu).
    const dl = await import('@/services/admin/diagnostic-jobs/download');
    const { PassThrough } = await import('node:stream');
    const download = async () => {
      const outS = new PassThrough();
      const chunks: Buffer[] = [];
      outS.on('data', (c: Buffer) => chunks.push(c));
      const from = s3.log.length;
      const r = await dl.streamStoredArchive(storage, archive.key, outS);
      expect(r.ok).toBe(true);
      const cmds = s3.log.slice(from);
      expect(cmds.every((c) => c.cmd === 'GetObjectCommand' && c.key === archive.key), JSON.stringify(cmds.slice(0, 3))).toBe(true);
      return Buffer.concat(chunks);
    };
    const one = await download();
    const two = await download();
    expect(one.equals(two)).toBe(true);
    expect(one.equals(stored)).toBe(true);
    // Archive lisible ; entrées = fichiers du manifeste + index d'intégrité + sommes ; contenu = fichiers stockés.
    const z = await JSZip.loadAsync(one);
    const names = Object.values(z.files).filter((f) => !f.dir).map((f) => f.name);
    const files: Record<string, string> = {};
    for (const n of names) files[n] = await z.files[n].async('string');
    const m = JSON.parse(files['manifeste.json']);
    expect(names.sort()).toEqual([...(m.files as Json[]).map((f) => f.path), 'integrite.json', 'SHA256SUMS.txt'].sort());
    const prefix = `admin-exports/diagnostics/${job.id}/a1/`;
    for (const n of ['manifeste.json', 'tracabilite/proprietes.json', 'tracabilite/proprietes/faits.json']) {
      const key = [...s3.objects.keys()].find((k) => k === `${prefix}${n}.gz` || k.startsWith(`${prefix}${n.replace(/\.json$/, '')}.part-`))!;
      if (key === `${prefix}${n}.gz`) expect(files[n]).toBe(gunzipSync(s3.objects.get(key)!.body).toString('utf8'));
    }
    // Contenu exhaustif : chaîne des deux biens, mêmes informations que l'ancienne chaîne (échantillon : bien v1).
    const legacy = await legacyParts(assets.v1);
    const props = new Map(expandedProperties(files).map((p) => [`${p.bien}|${p.cible}|${p.champ}`, p]));
    for (const [key, old] of legacy) for (const part of Object.keys(old)) expect(canon(props.get(key)?.[part]), `${key} › ${part}`).toBe(canon(old[part]));
    expect(m.status).toBe('COMPLETE');
    // Mesures persistées (BO) : mémoire initiale / pic / par étape / par fichier, requêtes, étapes ZIP.
    const extras = await repo.readDiagnosticJobExtras(job.id);
    const t = extras.phaseTimings as Json;
    expect(t.final).toMatchObject({ status: 'COMPLETE' });
    expect(t.current).toBeNull();
    expect(t.phases).toHaveProperty('ASSEMBLAGE_ZIP');
    expect(t.phases).toHaveProperty('VERIFICATION_ZIP');
    expect(t.memory.initial.rssMb).toBeGreaterThan(0);
    expect(t.memory.peak.rssMb).toBeGreaterThanOrEqual(t.memory.initial.rssMb);
    expect(Object.keys(t.memory.byPhase)).toEqual(expect.arrayContaining(['EXTRACTION', 'TRACABILITE']));
    expect(t.memory.files.length).toBeGreaterThan(0);
    expect(t.queries.count).toBeGreaterThan(0);
    expect(t.queries.oversizedRows).toBeGreaterThanOrEqual(1);
    console.info(`[l113q-travail] ${JSON.stringify({ archiveOctets: archive.bytes, fichiers: archive.entries, phases: t.phases, memoire: { initial: t.memory.initial, pic: t.memory.peak }, requetes: { n: t.queries.count, ms: t.queries.ms, grossesLignes: t.queries.oversizedRows } })}`);
  }, 600_000);

  it('L113Q-E04 MEMORY_GUARD : FAILED explicite, aucune relance automatique (dite au BO), profilage clos, aucun fichier laissé', async () => {
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    const { retryPolicy } = await import('@/services/admin/diagnostic-jobs/state');
    const prev = process.env.DIAG_JOB_MAX_RSS_MB;
    process.env.DIAG_JOB_MAX_RSS_MB = '870';
    try {
      const { job } = await repo.enqueueDiagnosticJob({ adminUserId: admin.id, request: { scope: 'asset', id: assets.v1, reinforced: false } });
      // Mesure imposée : 871 Mo (cas de la demande c02611d6…).
      const [st] = await drainDiagnosticJobs({ onlyId: job.id, storage, workerId: `e2e-l113q:${process.pid}:g`, heartbeatMs: 500, rssMb: () => 871 });
      expect(st).toBe('FAILED');
      const [row] = await sql<Json[]>`SELECT status, error_code, error_phase, phase, attempt, max_attempts, next_attempt_at, attempts_log, phase_timings, error FROM admin_export_generations WHERE id = ${job.id}::uuid`;
      expect(row).toMatchObject({ status: 'FAILED', error_code: 'MEMORY_GUARD', phase: 'TERMINE', attempt: 1, next_attempt_at: null });
      expect(row.error).toMatch(/871 Mo > seuil 870 Mo/);
      expect(row.error).toMatch(/tas .* Mo, natif .* Mo, ArrayBuffer/);
      const log = row.attempts_log as Json[];
      expect(log.at(-1)).toMatchObject({ outcome: 'FAILED', errorCode: 'MEMORY_GUARD' });
      expect(log.at(-1)!.endedAt).toBeTruthy();
      const t = row.phase_timings as Json;
      expect(t.current).toBeNull();
      expect(t.ended).toMatchObject({ status: 'FAILED', code: 'MEMORY_GUARD' });
      expect(t.memory.initial.rssMb).toBe(871);
      const r = retryPolicy({ status: row.status, errorCode: row.error_code, attempt: row.attempt, maxAttempts: row.max_attempts, nextAttemptAt: null });
      expect(r.state).toBe('NOT_TRANSIENT');
      expect(r.label).toMatch(/Aucune relance automatique/);
      expect([...s3.objects.keys()].filter((k) => k.includes(job.id))).toEqual([]);
      expect([...s3.uploads.values()].filter((u) => u.key.includes(job.id))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.DIAG_JOB_MAX_RSS_MB; else process.env.DIAG_JOB_MAX_RSS_MB = prev;
    }
  }, 300_000);

  it('L113Q-E05 exports successifs : pas d’accumulation durable de mémoire', async () => {
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    const after: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { job } = await repo.enqueueDiagnosticJob({ adminUserId: admin.id, request: { scope: 'asset', id: assets.v3, reinforced: false }, idempotencyKey: `l113q-suite-${i}-${jobId.slice(0, 8)}` });
      const [st] = await drainDiagnosticJobs({ onlyId: job.id, storage, workerId: `e2e-l113q:${process.pid}:s${i}`, heartbeatMs: 500 });
      expect(st).toBe('COMPLETE');
      // Le stockage simulé garde les archives en mémoire du test : retirées avant la mesure.
      for (const k of [...s3.objects.keys()]) if (k.includes(job.id)) s3.objects.delete(k);
      after.push(live());
    }
    console.info(`[l113q-successifs] ${JSON.stringify(after.map((x) => `${Math.round(x / MB)} Mo`))}`);
    expect(after[2] - after[0]).toBeLessThan(24 * MB);
  }, 600_000);
});
