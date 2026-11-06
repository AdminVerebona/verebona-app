/**
 * Projection T3 DOCUMENTAIRE vers les structures CIL spécialisées (lot 111U).
 *
 * Déterministe, sans IA, sans relecture de fichier : lit les faits T1
 * PERSISTÉS (`document_facts` actifs) des documents ouverts du bien dont la
 * nature relève de la performance énergétique (`CIL_ENERGY_SOURCE_KINDS` :
 * DPE, audit, documents techniques énergie — référentiel V2/V1 existant, pas
 * une exception codée sur le DPE), les reconnaît par le référentiel de
 * vocabulaire (`lib/cil/cil-fact-vocabulary.ts`) et écrit :
 *   · B5 `energy_materials` : UNE ligne DOCUMENT par poste (`cil:mat:<poste>`),
 *     état « constaté », document source et preuves (faits) ;
 *   · B6 `equipments` + `equipment_cil_specs` : équipement de l'usage
 *     complété (champs VIDES seulement) ou créé s'il n'en existe aucun ;
 *     plusieurs candidats → ambigu, rien n'est écrit ;
 *   · B7 : RIEN — une recommandation, un scénario ou un projet de travaux est
 *     journalisé `RECOMMENDATION_ONLY`, jamais un travail réalisé.
 *
 * Garanties : verrou transactionnel par bien ; idempotence (empreinte des
 * entrées, clé de projection, journal `cil_projection_journal`) ; une ligne
 * ou un champ USER / ADMIN n'est jamais modifié (PROTECTED) ; une ligne
 * DOCUMENT supprimée par l'utilisateur n'est pas recréée tant que la source
 * est inchangée ; le DPE le plus RÉCENT fait foi (versions antérieures
 * conservées dans le journal) ; deux sources de même date divergentes →
 * CONFLICT (à confirmer) ; source disparue → ligne DOCUMENT retirée (B5) ou
 * constat SOURCE_REMOVED (équipement créé : jamais supprimé). Aucun contenu
 * documentaire n'est journalisé (identifiants, codes, motifs).
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import {
  recognizeCilFact, sameCilValue, CIL_MATERIAL_POSTS,
  type CilFactInput, type CilMaterialAttribute, type CilMaterialPost, type CilSystemAttribute,
} from '@/lib/cil/cil-fact-vocabulary';
import { classifyCilEnergyEquipment, type CilEnergyUsage } from '@/lib/cil/energy-equipment';
import { documentKind, type DocKind } from '@/services/exports/v12/data/documents';
import { CIL_DOCUMENT_SCOPE_SQL, cilProjectionSchemaReady, cilSecondPassSchemaReady } from '../state/load';
import { recognizeCilContextFact, type CilTriggerType } from '@/lib/cil/cil-fact-vocabulary';

/** Natures documentaires sources des structures B5 / B6 (matrice, colonne « sources admissibles »). */
export const CIL_ENERGY_SOURCE_KINDS: ReadonlySet<DocKind> = new Set(['DPE', 'AUDIT_ENERGETIQUE', 'ENERGIE_TECHNIQUE']);

const USAGES: readonly CilEnergyUsage[] = ['chauffage', 'ecs', 'ventilation', 'refroidissement', 'enr'];
const USAGE_LABEL: Record<CilEnergyUsage, string> = {
  chauffage: 'Chauffage', ecs: 'Eau chaude sanitaire', ventilation: 'Ventilation', refroidissement: 'Climatisation', enr: 'Production d’énergie renouvelable',
};

type Tx = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
type Row = Record<string, unknown>;
const q = async (tx: Tx, text: string, params: unknown[] = []): Promise<Row[]> => (await tx.unsafe(text, params as never[])) as Row[];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);

export interface CilProjectionReport {
  assetId: number;
  skipped?: 'SCHEMA_NOT_READY' | 'ASSET_NOT_FOUND';
  sourceDocuments: number;
  factsRead: number;
  recognized: number;
  /** Faits écartés (autre bien, document multi-biens sans cible…) — motifs comptés. */
  abstentions: Record<string, number>;
  outcomes: Record<string, number>;
  createdEquipmentIds: number[];
  /** Écriture métier (matériau, équipement, caractéristiques) faite — ou à faire en mode à blanc. */
  changed: boolean;
  /** Décisions du journal nouvelles ou modifiées (à blanc : à écrire). */
  journalChanges: number;
}

interface SourceDoc { id: number; date: string | null; multiAsset: boolean | null }
type Values = Map<string, Array<{ value: string | number; factId: number }>>;

/** Valeurs d'un document pour un sujet ; `ambiguous` si un attribut porte plusieurs valeurs distinctes. */
function collapse(values: Values): { picked: Record<string, string | number>; factIds: number[]; ambiguous: string[] } {
  const picked: Record<string, string | number> = {};
  const factIds: number[] = [];
  const ambiguous: string[] = [];
  for (const [attr, list] of values) {
    const distinct: Array<string | number> = [];
    for (const v of list) if (!distinct.some((d) => sameCilValue(d, v.value))) distinct.push(v.value);
    if (distinct.length > 1) ambiguous.push(attr);
    else picked[attr] = distinct[0];
    factIds.push(...list.map((v) => v.factId));
  }
  return { picked, factIds, ambiguous };
}

const sameRecord = (a: Record<string, string | number>, b: Record<string, string | number>) =>
  Object.keys({ ...a, ...b }).every((k) => a[k] !== undefined && b[k] !== undefined && sameCilValue(a[k], b[k]));

/** Choix de la source qui fait foi : la plus récente non ambiguë ; égalité de date divergente = conflit. */
function chooseSource(perDoc: Array<{ doc: SourceDoc; c: ReturnType<typeof collapse> }>):
  { status: 'OK'; doc: SourceDoc; c: ReturnType<typeof collapse>; superseded: number[] } | { status: 'AMBIGUOUS' | 'CONFLICT'; docs: number[] } | null {
  if (!perDoc.length) return null;
  const sorted = [...perDoc].sort((x, y) => String(y.doc.date ?? '').localeCompare(String(x.doc.date ?? '')) || y.doc.id - x.doc.id);
  const top = sorted[0];
  if (top.c.ambiguous.length) return { status: 'AMBIGUOUS', docs: [top.doc.id] };
  const sameDate = sorted.filter((x) => x !== top && (x.doc.date ?? '') === (top.doc.date ?? '') && !x.c.ambiguous.length);
  if (sameDate.some((x) => !sameRecord(x.c.picked, top.c.picked))) return { status: 'CONFLICT', docs: [top.doc.id, ...sameDate.map((x) => x.doc.id)] };
  return { status: 'OK', doc: top.doc, c: top.c, superseded: sorted.slice(1).map((x) => x.doc.id) };
}

interface JournalWrite {
  key: string; table: string; targetId: number | null; status: string; reason: string | null;
  sourceFileIds: number[]; factIds: number[]; fingerprint: string | null; detail?: Record<string, unknown>;
}

async function journal(tx: Tx, accountId: number, assetId: number, w: JournalWrite): Promise<void> {
  await q(tx, `
    INSERT INTO cil_projection_journal (account_id, asset_id, projection_key, target_table, target_id, status, reason, source_file_ids, fact_ids, fingerprint, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::int[], $9::bigint[], $10, $11::jsonb)
    ON CONFLICT (asset_id, projection_key) DO UPDATE SET
      target_table = EXCLUDED.target_table, target_id = EXCLUDED.target_id,
      previous_status = CASE WHEN cil_projection_journal.status <> EXCLUDED.status THEN cil_projection_journal.status ELSE cil_projection_journal.previous_status END,
      status = EXCLUDED.status, reason = EXCLUDED.reason, source_file_ids = EXCLUDED.source_file_ids, fact_ids = EXCLUDED.fact_ids,
      fingerprint = EXCLUDED.fingerprint, detail = EXCLUDED.detail, updated_at = now()`,
  [accountId, assetId, w.key, w.table, w.targetId, w.status, w.reason, `{${w.sourceFileIds.join(',')}}`, `{${w.factIds.join(',')}}`, w.fingerprint, JSON.stringify(w.detail ?? {})]);
}

/**
 * Projette les faits documentaires persistés du bien vers B5 / B6. Rejouable
 * à volonté (deuxième passage, réimport identique : aucune écriture).
 * `dryRun` : calcule le compte rendu sans rien écrire (contrôle de cohérence).
 */
export async function projectCilDocumentsForAsset(p: { accountId: number; assetId: number; dryRun?: boolean }): Promise<CilProjectionReport> {
  const report: CilProjectionReport = { assetId: p.assetId, sourceDocuments: 0, factsRead: 0, recognized: 0, abstentions: {}, outcomes: {}, createdEquipmentIds: [], changed: false, journalChanges: 0 };
  if (!(await cilProjectionSchemaReady())) return { ...report, skipped: 'SCHEMA_NOT_READY' };
  const abst = (r: string) => { report.abstentions[r] = (report.abstentions[r] ?? 0) + 1; };
  const out = (s: string) => { report.outcomes[s] = (report.outcomes[s] ?? 0) + 1; };

  const ready2 = await cilSecondPassSchemaReady();
  const run = async (tx: Tx) => {
    // À blanc (contrôle de cohérence) : lecture seule, aucun verrou.
    const [asset] = await q(tx, `SELECT id FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL${p.dryRun ? '' : ' FOR UPDATE'}`, [p.assetId, p.accountId]);
    if (!asset) { report.skipped = 'ASSET_NOT_FOUND'; return; }
    if (!p.dryRun) await q(tx, `SELECT pg_advisory_xact_lock(hashtext('cil_projection:' || $1::text))`, [p.assetId]);

    // 1. Documents sources (nature énergétique, rattachés au bien : colonnes ou liens N-N actifs).
    const docRows = await q(tx, `
      SELECT f.id, f.document_type, f.document_type_code, f.retained_function_code, f.cil_rubric_codes,
             to_char(f.document_date, 'YYYY-MM-DD') AS document_date, x.multi_asset
        FROM asset_files f LEFT JOIN document_extractions x ON x.file_id = f.id
       WHERE ${CIL_DOCUMENT_SCOPE_SQL} ORDER BY f.id`, [p.assetId, p.accountId]);
    const docs: SourceDoc[] = docRows
      .filter((d) => CIL_ENERGY_SOURCE_KINDS.has(documentKind({
        id: Number(d.id), documentType: d.document_type as string | null, documentTypeCode: d.document_type_code as string | null,
        retainedFunctionCode: d.retained_function_code as string | null,
        cilRubricCodes: Array.isArray(d.cil_rubric_codes) ? d.cil_rubric_codes as string[] : null,
      })))
      .map((d) => ({ id: Number(d.id), date: (d.document_date as string) ?? null, multiAsset: d.multi_asset == null ? null : d.multi_asset === true }));
    report.sourceDocuments = docs.length;
    const docById = new Map(docs.map((d) => [d.id, d]));

    // 2. Faits actifs persistés (T1) — aucune lecture de fichier.
    const facts = docs.length ? await q(tx, `
      SELECT id::float8 AS id, file_id, fact_key, canonical_key, raw_key, subject, attribute, label, value_text,
             value_number::float8 AS value_number, value_unit, normalized_value, confidence, target_type, target_entity_id, semantic_event_nature
        FROM document_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' ORDER BY id`,
    [p.accountId, `{${docs.map((d) => d.id).join(',')}}`]) : [];
    report.factsRead = facts.length;

    const equipRows = await q(tx, `
      SELECT e.id, e.name, e.type, e.category, e.energy_usage, e.key_characteristics, s.id AS specs_id, s.brand, s.model, s.energy_type, s.power_kw,
             s.evacuation_mode, s.heat_network_delivery_station, COALESCE(s.field_origins, '{}'::jsonb) AS field_origins
        FROM equipments e LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id
       WHERE e.asset_id = $1 AND e.archived_at IS NULL ORDER BY e.id`, [p.assetId]);
    const equipIds = new Set(equipRows.map((e) => Number(e.id)));

    // 3. Reconnaissance et regroupement par document.
    const mat = new Map<CilMaterialPost, Map<number, Values>>();
    const sys = new Map<CilEnergyUsage, Map<number, Values>>();
    const sysTarget = new Map<CilEnergyUsage, Set<number>>();
    const recByDoc = new Map<number, number[]>();
    const lacunes: Record<string, number> = {};
    for (const r of facts) {
      const f: CilFactInput = {
        id: Number(r.id), fileId: Number(r.file_id), factKey: String(r.fact_key), canonicalKey: r.canonical_key as string | null,
        rawKey: r.raw_key as string | null, subject: r.subject as string | null, attribute: r.attribute as string | null, label: r.label as string | null,
        valueText: r.value_text as string | null, valueNumber: r.value_number == null ? null : Number(r.value_number), valueUnit: r.value_unit as string | null,
        normalizedValue: r.normalized_value as string | null, confidence: String(r.confidence), targetType: r.target_type as string | null,
        targetEntityId: r.target_entity_id == null ? null : Number(r.target_entity_id), semanticEventNature: r.semantic_event_nature as string | null,
      };
      const tt = (f.targetType ?? 'GENERIC').toUpperCase();
      if (tt === 'ASSET' && f.targetEntityId != null && f.targetEntityId !== p.assetId) { abst('OTHER_ASSET_TARGET'); continue; }
      if (tt === 'EQUIPMENT' && f.targetEntityId != null && !equipIds.has(f.targetEntityId)) { abst('OTHER_EQUIPMENT_TARGET'); continue; }
      const rec = recognizeCilFact(f);
      if (!rec) continue;
      // Document concernant plusieurs biens : un fait sans cible vérifiée n'est jamais attribué à CE bien.
      if (docById.get(f.fileId)?.multiAsset === true && (f.targetEntityId == null || tt === 'GENERIC')) { abst('MULTI_ASSET_UNTARGETED'); continue; }
      if (f.confidence === 'conflictual') { abst('CONFLICTUAL_FACT'); continue; }
      report.recognized++;
      if (rec.kind === 'recommendation') { recByDoc.set(f.fileId, [...(recByDoc.get(f.fileId) ?? []), f.id]); continue; }
      if (rec.kind === 'material') {
        // Migration 1301 absente : U reste dans les faits (lacune comptée), jamais converti en R.
        if (rec.attribute === 'uValue' && !ready2) { lacunes[`${rec.post}.uValue`] = (lacunes[`${rec.post}.uValue`] ?? 0) + 1; continue; }
        const byDoc = mat.get(rec.post) ?? new Map<number, Values>(); mat.set(rec.post, byDoc);
        const vals = byDoc.get(f.fileId) ?? new Map(); byDoc.set(f.fileId, vals);
        vals.set(rec.attribute, [...(vals.get(rec.attribute) ?? []), { value: rec.value, factId: f.id }]);
      } else {
        const byDoc = sys.get(rec.usage) ?? new Map<number, Values>(); sys.set(rec.usage, byDoc);
        const vals = byDoc.get(f.fileId) ?? new Map(); byDoc.set(f.fileId, vals);
        vals.set(rec.attribute, [...(vals.get(rec.attribute) ?? []), { value: rec.value, factId: f.id }]);
        if (tt === 'EQUIPMENT' && f.targetEntityId != null) sysTarget.set(rec.usage, new Set([...(sysTarget.get(rec.usage) ?? []), f.targetEntityId]));
      }
    }

    const prevRows = await q(tx, `SELECT projection_key, status, reason, target_id, fingerprint FROM cil_projection_journal WHERE asset_id = $1`, [p.assetId]);
    const prev = new Map(prevRows.map((j) => [String(j.projection_key), j]));
    const write = async (w: JournalWrite) => {
      out(w.status);
      const j = prev.get(w.key);
      // Même décision, mêmes entrées : rien n'est réécrit (deuxième passage, réimport identique).
      // « Écrit » puis « inchangé » = même état (aucune réécriture du journal).
      const st = (x: unknown) => (x === 'UNCHANGED' ? 'WRITTEN' : String(x));
      const same = j && st(j.status) === st(w.status) && (w.status === 'UNCHANGED' || (j.reason ?? null) === w.reason)
        && (j.fingerprint ?? null) === w.fingerprint && (j.target_id == null ? null : Number(j.target_id)) === w.targetId;
      if (!same) report.journalChanges++;
      if (!p.dryRun && !same) await journal(tx, p.accountId, p.assetId, w);
    };

    // 4. B5 — matériaux par poste.
    const matRows = await q(tx, `SELECT id, category, origin, projection_key, material_nature, thermal_resistance_r::float8 AS r, thickness_mm FROM energy_materials WHERE asset_id = $1`, [p.assetId]);
    for (const post of CIL_MATERIAL_POSTS) {
      const key = `cil:mat:${post}`;
      const perDoc = [...(mat.get(post) ?? new Map()).entries()].map(([id, v]) => ({ doc: docById.get(id)!, c: collapse(v) }));
      const choice = chooseSource(perDoc);
      const docRow = matRows.find((m) => m.projection_key === key && m.origin === 'DOCUMENT');
      const userRows = matRows.filter((m) => m.category === post && m.origin !== 'DOCUMENT');
      if (!choice) {
        if (docRow) {
          if (!p.dryRun) await q(tx, `DELETE FROM energy_materials WHERE id = $1 AND origin = 'DOCUMENT'`, [docRow.id]);
          report.changed = true;
          await write({ key, table: 'energy_materials', targetId: null, status: 'RETRACTED', reason: 'SOURCE_NO_LONGER_PROVES', sourceFileIds: [], factIds: [], fingerprint: null });
        } else if (prev.has(key) && !['RETRACTED'].includes(String(prev.get(key)!.status))) {
          await write({ key, table: 'energy_materials', targetId: null, status: 'RETRACTED', reason: 'SOURCE_NO_LONGER_PROVES', sourceFileIds: [], factIds: [], fingerprint: null });
        }
        continue;
      }
      if (choice.status !== 'OK') {
        await write({ key, table: 'energy_materials', targetId: docRow ? Number(docRow.id) : null, status: choice.status, reason: choice.status === 'AMBIGUOUS' ? 'SEVERAL_VALUES_IN_DOCUMENT' : 'SAME_DATE_SOURCES_DIFFER', sourceFileIds: choice.docs, factIds: [], fingerprint: null });
        continue;
      }
      const v = choice.c.picked as Partial<Record<CilMaterialAttribute, string | number>>;
      const fingerprint = hash({ post, doc: choice.doc.id, v });
      const base = { key, table: 'energy_materials', sourceFileIds: [choice.doc.id], factIds: choice.c.factIds, fingerprint, detail: { superseded: choice.superseded, lacunes: Object.keys(lacunes).filter((k) => k.startsWith(post)) } };
      if (userRows.length) {
        const differs = userRows.some((u) => (v.materialNature && u.material_nature && !sameCilValue(String(u.material_nature), v.materialNature))
          || (v.thermalResistanceR != null && u.r != null && !sameCilValue(Number(u.r), Number(v.thermalResistanceR)))
          || (v.thicknessMm != null && u.thickness_mm != null && !sameCilValue(Number(u.thickness_mm), Number(v.thicknessMm))));
        if (docRow && !p.dryRun) await q(tx, `DELETE FROM energy_materials WHERE id = $1 AND origin = 'DOCUMENT'`, [docRow.id]);
        await write({ ...base, targetId: Number(userRows[0].id), status: 'PROTECTED', reason: differs ? 'USER_VALUE_DIFFERS' : 'USER_VALUE_PRESENT' });
        continue;
      }
      const j = prev.get(key);
      if (!docRow && j && ['WRITTEN', 'UNCHANGED'].includes(String(j.status)) && j.target_id != null && j.fingerprint === fingerprint) {
        // Ligne DOCUMENT supprimée par l'utilisateur, source inchangée : son geste fait foi.
        await write({ ...base, targetId: null, status: 'ABSTAINED', reason: 'USER_REMOVED' });
        continue;
      }
      if (!docRow && j && j.status === 'ABSTAINED' && j.reason === 'USER_REMOVED' && j.fingerprint === fingerprint) {
        await write({ ...base, targetId: null, status: 'ABSTAINED', reason: 'USER_REMOVED' });
        continue;
      }
      const evidence = { factIds: choice.c.factIds, fileId: choice.doc.id, documentDate: choice.doc.date };
      const cols = [v.materialNature ?? null, v.brand ?? null, v.reference ?? null, v.thermalResistanceR ?? null, v.lambda ?? null, v.thicknessMm ?? null, v.surfaceSqm ?? null];
      if (docRow) {
        if (j?.fingerprint === fingerprint) { await write({ ...base, targetId: Number(docRow.id), status: 'UNCHANGED', reason: null }); continue; }
        if (!p.dryRun) await q(tx, `UPDATE energy_materials SET material_nature = $2, brand = $3, reference = $4, thermal_resistance_r = $5, lambda = $6, thickness_mm = $7,
            surface_sqm = $8, document_id = $9, source_file_id = $9, installation_state = 'constate', evidence = $10::jsonb, updated_at = now() WHERE id = $1 AND origin = 'DOCUMENT'`,
        [docRow.id, ...cols, choice.doc.id, JSON.stringify(evidence)]);
        if (!p.dryRun && ready2) await q(tx, `UPDATE energy_materials SET u_value = $2 WHERE id = $1 AND origin = 'DOCUMENT'`, [docRow.id, v.uValue ?? null]);
        report.changed = true;
        await write({ ...base, targetId: Number(docRow.id), status: 'WRITTEN', reason: 'SOURCE_UPDATED' });
      } else {
        let id: number | null = null;
        if (!p.dryRun) {
          const [ins] = await q(tx, `INSERT INTO energy_materials (asset_id, category, material_nature, brand, reference, thermal_resistance_r, lambda, thickness_mm, surface_sqm,
              document_id, source_file_id, origin, installation_state, projection_key, evidence, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'DOCUMENT', 'constate', $11, $12::jsonb, now(), now()) RETURNING id`,
          [p.assetId, post, ...cols, choice.doc.id, key, JSON.stringify(evidence)]);
          id = Number(ins.id);
          if (ready2 && v.uValue != null) await q(tx, `UPDATE energy_materials SET u_value = $2 WHERE id = $1`, [id, v.uValue]);
        }
        report.changed = true;
        await write({ ...base, targetId: id, status: 'WRITTEN', reason: 'CREATED' });
      }
    }

    // 5. B6 — équipements par usage.
    for (const usage of USAGES) {
      const key = `cil:eq:${usage}`;
      const perDoc = [...(sys.get(usage) ?? new Map()).entries()].map(([id, v]) => ({ doc: docById.get(id)!, c: collapse(v) }));
      const choice = chooseSource(perDoc);
      const j = prev.get(key);
      if (!choice) {
        if (j && j.reason === 'CREATED_FROM_DOCUMENT' && j.target_id != null) {
          await write({ key, table: 'equipments', targetId: Number(j.target_id), status: 'SOURCE_REMOVED', reason: 'CREATED_FROM_DOCUMENT', sourceFileIds: [], factIds: [], fingerprint: null });
        } else if (j && j.status !== 'RETRACTED' && j.status !== 'SOURCE_REMOVED') {
          await write({ key, table: 'equipments', targetId: j.target_id == null ? null : Number(j.target_id), status: 'RETRACTED', reason: 'SOURCE_NO_LONGER_PROVES', sourceFileIds: [], factIds: [], fingerprint: null });
        }
        continue;
      }
      if (choice.status !== 'OK') {
        await write({ key, table: 'equipments', targetId: null, status: choice.status, reason: choice.status === 'AMBIGUOUS' ? 'SEVERAL_VALUES_IN_DOCUMENT' : 'SAME_DATE_SOURCES_DIFFER', sourceFileIds: choice.docs, factIds: [], fingerprint: null });
        continue;
      }
      const v = choice.c.picked as Partial<Record<CilSystemAttribute, string | number>>;
      const fingerprint = hash({ usage, doc: choice.doc.id, v });
      const base = { key, table: 'equipments', sourceFileIds: [choice.doc.id], factIds: choice.c.factIds, fingerprint, detail: { superseded: choice.superseded } };

      // Cible : équipement désigné par les faits, sinon celui créé précédemment, sinon l'unique équipement de l'usage.
      const candidates = equipRows.filter((e) => classifyCilEnergyEquipment({
        energyUsage: e.energy_usage as string | null, type: e.type as string | null, category: e.category as string | null,
        energyType: e.energy_type as string | null, evacuationMode: e.evacuation_mode as string | null, heatNetworkDeliveryStation: e.heat_network_delivery_station as string | null,
      })?.usage === usage);
      const designated = [...(sysTarget.get(usage) ?? [])];
      let target: Row | undefined;
      if (designated.length === 1) target = equipRows.find((e) => Number(e.id) === designated[0]);
      else if (designated.length > 1) { await write({ ...base, targetId: null, status: 'AMBIGUOUS', reason: 'SEVERAL_DESIGNATED_EQUIPMENTS' }); continue; }
      else if (j?.target_id != null && equipRows.some((e) => Number(e.id) === Number(j.target_id))) target = equipRows.find((e) => Number(e.id) === Number(j.target_id));
      else if (candidates.length === 1) target = candidates[0];
      else if (candidates.length > 1) { await write({ ...base, targetId: null, status: 'AMBIGUOUS', reason: 'SEVERAL_EQUIPMENTS_FOR_USAGE' }); continue; }

      if (!target) {
        // Équipement créé par T3 seulement si son existence est décrite (type ou énergie) ; le créé puis supprimé par l'utilisateur n'est pas recréé.
        if (j?.reason === 'CREATED_FROM_DOCUMENT' && j.fingerprint === fingerprint) {
          await write({ ...base, targetId: null, status: 'ABSTAINED', reason: 'USER_REMOVED' });
          continue;
        }
        if (j?.status === 'ABSTAINED' && j.reason === 'USER_REMOVED' && j.fingerprint === fingerprint) {
          await write({ ...base, targetId: null, status: 'ABSTAINED', reason: 'USER_REMOVED' });
          continue;
        }
        if (v.type == null && v.energy == null) { await write({ ...base, targetId: null, status: 'ABSTAINED', reason: 'EXISTENCE_NOT_DESCRIBED' }); continue; }
        let id: number | null = null;
        if (!p.dryRun) {
          const name = v.type != null ? String(v.type).slice(0, 200) : USAGE_LABEL[usage];
          const [ins] = await q(tx, `INSERT INTO equipments (asset_id, name, type, category, status, key_characteristics, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'EN_SERVICE', $5::jsonb, now(), now()) RETURNING id`,
          [p.assetId, name, v.type != null ? String(v.type) : null, usage, JSON.stringify({ __cilProjection: { origin: 'DOCUMENT', fileId: choice.doc.id, usage } })]);
          id = Number(ins.id);
          const origins: Record<string, string> = {};
          if (v.energy != null) origins.energy_type = 'DOCUMENT';
          if (v.powerKw != null) origins.power_kw = 'DOCUMENT';
          if (v.brand != null) origins.brand = 'DOCUMENT';
          if (v.model != null) origins.model = 'DOCUMENT';
          await q(tx, `INSERT INTO equipment_cil_specs (equipment_id, energy_type, power_kw, brand, model, field_origins, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), now()) ON CONFLICT (equipment_id) DO NOTHING`,
          [id, v.energy ?? null, v.powerKw ?? null, v.brand ?? null, v.model ?? null, JSON.stringify(origins)]);
          report.createdEquipmentIds.push(id);
        }
        report.changed = true;
        await write({ ...base, targetId: id, status: 'WRITTEN', reason: 'CREATED_FROM_DOCUMENT' });
        continue;
      }

      // Enrichissement : champs VIDES ou déjà d'origine DOCUMENT ; un champ renseigné sans origine = saisie USER, protégée.
      const origins = (target.field_origins ?? {}) as Record<string, string>;
      const cols: Array<[string, CilSystemAttribute]> = [['energy_type', 'energy'], ['power_kw', 'powerKw'], ['brand', 'brand'], ['model', 'model']];
      const sets: Array<[string, string | number]> = [];
      let protectedDiff = false;
      for (const [col, attr] of cols) {
        const val = v[attr];
        if (val == null) continue;
        const cur = target[col];
        const empty = cur == null || String(cur).trim() === '';
        if (empty || origins[col] === 'DOCUMENT') {
          if (empty || !sameCilValue(typeof val === 'number' ? Number(cur) : String(cur), val)) sets.push([col, val]);
        } else if (!sameCilValue(typeof val === 'number' ? Number(cur) : String(cur), val)) protectedDiff = true;
      }
      const createdByUs = j?.reason === 'CREATED_FROM_DOCUMENT' && Number(j.target_id) === Number(target.id);
      if (!sets.length) {
        await write({ ...base, targetId: Number(target.id), status: protectedDiff ? 'PROTECTED' : 'UNCHANGED', reason: createdByUs ? 'CREATED_FROM_DOCUMENT' : protectedDiff ? 'USER_VALUE_DIFFERS' : null });
        continue;
      }
      if (!p.dryRun) {
        const next = { ...origins, ...Object.fromEntries(sets.map(([c]) => [c, 'DOCUMENT'])) };
        const names = sets.map(([c]) => c);
        const vals = sets.map(([, x]) => x);
        await q(tx, `INSERT INTO equipment_cil_specs (equipment_id, ${names.join(', ')}, field_origins, created_at, updated_at)
          VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')}, $${names.length + 2}::jsonb, now(), now())
          ON CONFLICT (equipment_id) DO UPDATE SET ${names.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, field_origins = EXCLUDED.field_origins, updated_at = now()`,
        [Number(target.id), ...vals, JSON.stringify(next)]);
      }
      report.changed = true;
      await write({ ...base, targetId: Number(target.id), status: 'WRITTEN', reason: createdByUs ? 'CREATED_FROM_DOCUMENT' : protectedDiff ? 'PARTIAL_USER_PROTECTED' : 'ENRICHED' });
    }

    // 6. B2 — contexte de constitution, établi par un fait EXPLICITE d'un document du bien (jamais déduit).
    if (ready2) await projectProfile(tx, p, prev, write);

    // 7. B7 — travaux RÉALISÉS et PROUVÉS : Opérations d'intervention existantes (identité économique unique).
    await projectWorks(tx, p, prev, write, equipRows);

    // 8. Recommandations : tracées, jamais des travaux réalisés.
    for (const [fileId, ids] of recByDoc) {
      await write({ key: `cil:rec:${fileId}`, table: 'none', targetId: null, status: 'RECOMMENDATION_ONLY', reason: 'NOT_REALIZED_WORKS', sourceFileIds: [fileId], factIds: ids, fingerprint: hash(ids) });
    }
    for (const [k, j] of prev) {
      if (k.startsWith('cil:rec:') && !recByDoc.has(Number(k.slice(8))) && j.status !== 'RETRACTED') {
        await write({ key: k, table: 'none', targetId: null, status: 'RETRACTED', reason: 'SOURCE_NO_LONGER_PROVES', sourceFileIds: [], factIds: [], fingerprint: null });
      }
    }
  };

  await pgClient.begin(async (tx) => run(tx as unknown as Tx));

  if (report.changed && !p.dryRun) {
    try {
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: p.accountId, entityId: p.assetId });
    } catch { /* jamais bloquant */ }
  }
  return report;
}


type Prev = Map<string, Row>;
type Write = (w: JournalWrite) => Promise<void>;

const allDocFacts = async (tx: Tx, accountId: number, fileIds: number[]): Promise<CilFactInput[]> => {
  if (!fileIds.length) return [];
  const rows = await q(tx, `
    SELECT id::float8 AS id, file_id, fact_key, canonical_key, raw_key, subject, attribute, label, value_text,
           value_number::float8 AS value_number, value_unit, normalized_value, confidence, target_type, target_entity_id, semantic_event_nature
      FROM document_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' ORDER BY id`, [accountId, `{${fileIds.join(',')}}`]);
  return rows.map((r) => ({
    id: Number(r.id), fileId: Number(r.file_id), factKey: String(r.fact_key), canonicalKey: r.canonical_key as string | null,
    rawKey: r.raw_key as string | null, subject: r.subject as string | null, attribute: r.attribute as string | null, label: r.label as string | null,
    valueText: r.value_text as string | null, valueNumber: r.value_number == null ? null : Number(r.value_number), valueUnit: r.value_unit as string | null,
    normalizedValue: r.normalized_value as string | null, confidence: String(r.confidence), targetType: r.target_type as string | null,
    targetEntityId: r.target_entity_id == null ? null : Number(r.target_entity_id), semanticEventNature: r.semantic_event_nature as string | null,
  }));
};

/**
 * B2 — `asset_cil_profiles` : motif, date et autorisation établis par un fait
 * explicite (`recognizeCilContextFact`) d'un document ouvert du bien. Profil
 * USER / ADMIN : jamais modifié (PROTECTED). Valeurs divergentes entre
 * documents : CONFLICT, rien n'est écrit. Plus aucune source : le profil
 * DOCUMENT est retiré (le motif redevient « à saisir »).
 */
async function projectProfile(tx: Tx, p: { accountId: number; assetId: number; dryRun?: boolean }, prev: Prev, write: Write): Promise<void> {
  const key = 'cil:profile';
  const docs = await q(tx, `SELECT f.id, to_char(f.document_date, 'YYYY-MM-DD') AS d, x.multi_asset FROM asset_files f LEFT JOIN document_extractions x ON x.file_id = f.id
     WHERE ${CIL_DOCUMENT_SCOPE_SQL} ORDER BY f.id`, [p.assetId, p.accountId]);
  const single = docs.filter((d) => d.multi_asset !== true).map((d) => Number(d.id));
  const found: { trigger: Map<CilTriggerType, number[]>; date: Map<string, number[]>; auth: Map<string, number[]> } = { trigger: new Map(), date: new Map(), auth: new Map() };
  const facts: number[] = [];
  for (const f of await allDocFacts(tx, p.accountId, single)) {
    if ((f.targetType ?? '').toUpperCase() === 'ASSET' && f.targetEntityId != null && f.targetEntityId !== p.assetId) continue;
    if (f.confidence === 'conflictual') continue;
    const c = recognizeCilContextFact(f);
    if (!c) continue;
    const m = c.kind === 'trigger' ? found.trigger : c.kind === 'triggerDate' ? found.date : found.auth;
    m.set(c.value as never, [...(m.get(c.value as never) ?? []), f.fileId]);
    facts.push(f.id);
  }
  const [prof] = await q(tx, `SELECT id, trigger_type, to_char(trigger_date, 'YYYY-MM-DD') AS trigger_date, authorization_type, origin FROM asset_cil_profiles WHERE asset_id = $1`, [p.assetId]);
  const sources = [...new Set([...found.trigger.values(), ...found.date.values(), ...found.auth.values()].flat())].sort((a, b) => a - b);
  if (!found.trigger.size && !found.date.size && !found.auth.size) {
    if (prof && prof.origin === 'DOCUMENT') {
      if (!p.dryRun) await q(tx, `DELETE FROM asset_cil_profiles WHERE id = $1 AND origin = 'DOCUMENT'`, [prof.id]);
      await write({ key, table: 'asset_cil_profiles', targetId: null, status: 'RETRACTED', reason: 'SOURCE_NO_LONGER_PROVES', sourceFileIds: [], factIds: [], fingerprint: null });
    } else if (prev.has(key) && prev.get(key)!.status !== 'RETRACTED') {
      await write({ key, table: 'asset_cil_profiles', targetId: null, status: 'RETRACTED', reason: 'SOURCE_NO_LONGER_PROVES', sourceFileIds: [], factIds: [], fingerprint: null });
    }
    return;
  }
  if (found.trigger.size > 1 || found.date.size > 1 || found.auth.size > 1) {
    await write({ key, table: 'asset_cil_profiles', targetId: prof ? Number(prof.id) : null, status: 'CONFLICT', reason: 'DOCUMENTS_DIFFER', sourceFileIds: sources, factIds: facts, fingerprint: hash({ sources, facts }) });
    return;
  }
  const v = { trigger: [...found.trigger.keys()][0] ?? null, date: [...found.date.keys()][0] ?? null, auth: [...found.auth.keys()][0] ?? null };
  const fingerprint = hash(v);
  const base = { key, table: 'asset_cil_profiles', sourceFileIds: sources, factIds: facts, fingerprint, detail: v };
  if (prof && prof.origin !== 'DOCUMENT') {
    const differs = (v.trigger && prof.trigger_type !== 'inconnu' && prof.trigger_type !== v.trigger) || (v.date && prof.trigger_date && prof.trigger_date !== v.date);
    await write({ ...base, targetId: Number(prof.id), status: 'PROTECTED', reason: differs ? 'USER_VALUE_DIFFERS' : 'USER_VALUE_PRESENT' });
    return;
  }
  const same = prof && (prof.trigger_type === (v.trigger ?? 'inconnu')) && (prof.trigger_date ?? null) === v.date && (prof.authorization_type ?? null) === v.auth;
  if (same) { await write({ ...base, targetId: Number(prof.id), status: 'UNCHANGED', reason: null }); return; }
  let id: number | null = prof ? Number(prof.id) : null;
  if (!p.dryRun) {
    const [r] = await q(tx, `
      INSERT INTO asset_cil_profiles (asset_id, trigger_type, trigger_date, authorization_type, origin, source_file_id, evidence, created_at, updated_at)
      VALUES ($1, $2, $3::date, $4, 'DOCUMENT', $5, $6::jsonb, now(), now())
      ON CONFLICT (asset_id) DO UPDATE SET trigger_type = EXCLUDED.trigger_type, trigger_date = EXCLUDED.trigger_date,
        authorization_type = EXCLUDED.authorization_type, source_file_id = EXCLUDED.source_file_id, evidence = EXCLUDED.evidence, updated_at = now()
        WHERE asset_cil_profiles.origin = 'DOCUMENT'
      RETURNING id`, [p.assetId, v.trigger ?? 'inconnu', v.date, v.auth, sources[0] ?? null, JSON.stringify({ factIds: facts })]);
    id = r ? Number(r.id) : id;
  }
  await write({ ...base, targetId: id, status: 'WRITTEN', reason: prof ? 'SOURCE_UPDATED' : 'CREATED' });
}

/** Rôles de source qui PROUVENT la réalisation (une facture, un rapport / une attestation) ; jamais un devis ni une commande. */
export const CIL_WORK_PROOF_ROLES: ReadonlySet<string> = new Set(['INVOICE', 'REPORT']);

const POST_WORK: Record<CilMaterialPost, string> = {
  toiture: 'isolation_toiture', murs_exterieurs: 'isolation_murs', parois_vitrees: 'isolation_parois', planchers_bas: 'isolation_planchers',
};

/**
 * B7 — travaux de rénovation énergétique RÉALISÉS : les Opérations
 * d'intervention existantes (identité économique unique, aucun doublon, aucune
 * écriture dans les Opérations ni dans `energy_works`) sont QUALIFIÉES ici :
 *   · énergétique si un équipement à incidence énergétique y est lié, ou si
 *     un document de l'Opération décrit un poste d'enveloppe / un système
 *     (même vocabulaire que B5 / B6, recommandations exclues) ;
 *   · réalisée seulement si l'Opération est REALIZED ET porte une source
 *     facture ou rapport / attestation (`CIL_WORK_PROOF_ROLES`) ;
 *   · une Opération envisagée (devis, projet) n'est JAMAIS un travail
 *     réalisé (journal ABSTAINED / NOT_REALIZED).
 * Le journal (`cil:work:<opération>`) porte la qualification lue par l'état.
 */
async function projectWorks(tx: Tx, p: { accountId: number; assetId: number }, prev: Prev, write: Write, equipRows: Row[]): Promise<void> {
  const ops = await q(tx, `
    SELECT o.id::int AS id, o.status, to_char(o.realized_date, 'YYYY-MM-DD') AS realized
      FROM business_operations o
      JOIN business_operation_asset_links l ON l.operation_id = o.id AND l.account_id = o.account_id AND l.active AND l.asset_id = $1
     WHERE o.account_id = $2 AND o.type_code = 'INTERVENTION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     ORDER BY o.id`, [p.assetId, p.accountId]);
  const ids = ops.map((o) => Number(o.id));
  const seen = new Set<string>();
  if (ids.length) {
    const arr = `{${ids.join(',')}}`;
    const roles = await q(tx, `SELECT operation_id::int AS op, array_agg(DISTINCT source_role) FILTER (WHERE source_role IS NOT NULL) AS roles
        FROM business_operation_sources WHERE account_id = $1 AND operation_id = ANY($2::bigint[]) AND active GROUP BY 1`, [p.accountId, arr]);
    const docs = await q(tx, `SELECT operation_id::int AS op, file_id FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND f.deleted_at IS NULL
        WHERE d.account_id = $1 AND d.operation_id = ANY($2::bigint[]) AND d.active`, [p.accountId, arr]);
    const eqs = await q(tx, `SELECT operation_id::int AS op, equipment_id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = ANY($2::bigint[]) AND active`, [p.accountId, arr]);
    const facts = await allDocFacts(tx, p.accountId, [...new Set(docs.map((d) => Number(d.file_id)))]);
    const usageOf = new Map(equipRows.map((e) => [Number(e.id), classifyCilEnergyEquipment({
      energyUsage: e.energy_usage as string | null, type: e.type as string | null, category: e.category as string | null,
      energyType: e.energy_type as string | null, evacuationMode: e.evacuation_mode as string | null, heatNetworkDeliveryStation: e.heat_network_delivery_station as string | null,
    })?.usage ?? null]));
    for (const o of ops) {
      const id = Number(o.id);
      const key = `cil:work:${id}`;
      seen.add(key);
      const fileIds = docs.filter((d) => Number(d.op) === id).map((d) => Number(d.file_id));
      const cats = new Set<string>();
      const factIds: number[] = [];
      for (const e of eqs.filter((x) => Number(x.op) === id)) { const u = usageOf.get(Number(e.equipment_id)); if (u) cats.add(u); }
      for (const f of facts.filter((x) => fileIds.includes(x.fileId))) {
        const r = recognizeCilFact(f);
        if (!r || r.kind === 'recommendation') continue;
        cats.add(r.kind === 'material' ? POST_WORK[r.post] : r.usage);
        factIds.push(f.id);
      }
      const categories = [...cats].sort();
      if (!categories.length) {
        // Intervention sans incidence énergétique établie : hors B7 (ex. plomberie, peinture).
        if (prev.has(key) && prev.get(key)!.status !== 'RETRACTED') await write({ key, table: 'business_operations', targetId: id, status: 'RETRACTED', reason: 'NOT_ENERGY_WORK', sourceFileIds: [], factIds: [], fingerprint: null });
        continue;
      }
      const rs = ((roles.find((r) => Number(r.op) === id)?.roles as string[] | null) ?? []).filter(Boolean).sort();
      const fingerprint = hash({ status: o.status, categories, realized: o.realized ?? null, rs, fileIds });
      const base = { key, table: 'business_operations', targetId: id, sourceFileIds: fileIds, factIds, fingerprint, detail: { categories, realizedDate: o.realized ?? null, roles: rs } };
      if (o.status !== 'REALIZED') await write({ ...base, status: 'ABSTAINED', reason: o.status === 'CANCELLED' ? 'CANCELLED' : 'NOT_REALIZED' });
      else if (!rs.some((r) => CIL_WORK_PROOF_ROLES.has(r))) await write({ ...base, status: 'ABSTAINED', reason: 'REALIZATION_NOT_PROVEN' });
      else await write({ ...base, status: 'WRITTEN', reason: 'REALIZED_ENERGY_WORK' });
    }
  }
  // Opération disparue (invalidée, fusionnée, détachée du bien) : qualification retirée.
  for (const [k, j] of prev) {
    if (k.startsWith('cil:work:') && !seen.has(k) && j.status !== 'RETRACTED') {
      await write({ key: k, table: 'business_operations', targetId: j.target_id == null ? null : Number(j.target_id), status: 'RETRACTED', reason: 'OPERATION_GONE', sourceFileIds: [], factIds: [], fingerprint: null });
    }
  }
}
