/**
 * Lot 91C — rattrapage des PROPRIÉTÉS neutralisées par l'ancienne règle
 * « acquisition sans preuve d'achat » (ACQUISITION_WITHOUT_PURCHASE_PROOF).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE STOCK À REPRENDRE
 *
 * Jusqu'au lot 91C, la projection T1 confondait la preuve de RÉALISATION
 * d'un achat et la preuve d'une PROPRIÉTÉ : un document qui engage sans
 * réaliser (compromis…) voyait son prix d'acquisition, pourtant extrait,
 * ciblé et prouvé, rangé en connaissance générique (`canonical_key` NULL,
 * `projection_rule` = ACQUISITION_WITHOUT_PURCHASE_PROOF). La preuve
 * n'atteignait jamais `field_evidence` et T3 ne pouvait pas l'arbitrer.
 *
 * CE QUE FAIT LE RATTRAPAGE (sans nouvel envoi, sans appel T1)
 *
 *   1. sélection : faits ACTIFS encore marqués par l'ancienne règle, du
 *      document courant (fichier non supprimé), comptes éligibles ;
 *   2. clé d'origine : la règle ne visait que acquisitionDate / acquisitionPrice
 *      et le fait garde le type de valeur de SA clé du registre (`date` /
 *      `money_eur`) — la clé est retrouvée sans deviner ; la date reste une
 *      RÉALISATION, jamais reprise ;
 *   3. décision : la MÊME règle pure que la projection
 *      (`admitsPropertyWithoutRealization` : registre, catalogue documentaire,
 *      matrice d'autorité, cible vérifiée, preuve littérale, paiement partiel,
 *      estimation, confiance) — un fait refusé garde son état, motif compté ;
 *      cible : le bien (identifiant vérifié dans le compte, non supprimé)
 *      encore rattaché au document (jamais l'ancien bien d'un document
 *      déplacé) ;
 *   4. application, fait par fait : mise à jour CONDITIONNELLE du fait
 *      (clé canonique — aussi clé historique `fact_key`, comme l'écrit la
 *      projection ; clé lue `raw_key` conservée —, origine du modèle, règle PROPERTY_EVIDENCE_WITHOUT_
 *      REALIZATION, aucun événement) — rejouée, elle ne retrouve plus rien ;
 *      preuve de champ écrite par le chemin commun (`persistEvidence`,
 *      empreinte unique : jamais de doublon) ; réconciliation T3 du bien en
 *      file. T3 arbitre avec la matrice d'autorité et la préséance des
 *      origines : une valeur saisie ou corrigée par l'utilisateur n'est
 *      jamais écrasée. Aucun statut d'Opération ni date d'acquisition touché.
 *
 * Trace : le fait lui-même porte la nouvelle règle (`projection_rule`) ; le
 * rapport liste les faits repris et les refus par motif. Restauration : le
 * point de restauration de la base (bloc 0 des Rattrapages).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import { pgClient } from '@/db';
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { resolveDocumentType } from '@/services/canonical/registry';
import {
  admitsPropertyWithoutRealization, PROJECTION_RULES, transactionNature, type PropertyRefusal,
} from './rules';

type RepriseOrigin = 'SCHEDULED' | 'BO';
type Row = Record<string, unknown>;

export type PropertyRepriseRefusal = PropertyRefusal | 'KEY_NOT_RECOVERABLE' | 'DOCUMENT_NOT_LINKED_TO_TARGET' | 'MULTI_ASSET_UNKNOWN';

export interface PropertyRepriseItem {
  factId: number;
  accountId: number;
  fileId: number;
  assetId: number | null;
  fieldKey: string | null;
  documentType: string | null;
  outcome: 'REQUALIFIED' | 'TO_REQUALIFY' | 'REFUSED' | 'SKIPPED_CONCURRENT' | 'ERROR';
  reason?: PropertyRepriseRefusal;
  evidenceId?: number | null;
  error?: string;
}

export interface PropertyRepriseReport {
  mode: 'simulate' | 'apply';
  runId: string;
  origin: RepriseOrigin;
  /** Faits neutralisés examinés. */
  scanned: number;
  /** Faits admis (à reprendre en simulation, repris en application). */
  admitted: number;
  requalified: number;
  evidenceWritten: number;
  /** Biens mis en file de réconciliation T3. */
  assetsReconciled: number;
  refused: Partial<Record<PropertyRepriseRefusal, number>>;
  items: PropertyRepriseItem[];
  failed: number;
  more: boolean;
}

interface Options {
  apply: boolean;
  origin: RepriseOrigin;
  accountId?: number | null;
  reason?: string | null;
  batchSize?: number;
  maxFacts?: number;
  deadline?: number;
  log?: (m: string) => void;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const ITEMS_MAX = 500;

/** Clé d'origine d'un fait neutralisé : le type de valeur est celui de SA clé du registre. */
export function originalAcquisitionKey(valueType: string | null): 'acquisitionPrice' | 'acquisitionDate' | null {
  if (valueType === 'money_eur') return 'acquisitionPrice';
  if (valueType === 'date') return 'acquisitionDate';
  return null;
}

async function selectNeutralized(accountId: number | null, afterId: number, limit: number): Promise<Row[]> {
  return (await pgClient.unsafe(
    `SELECT f.id, f.account_id, f.file_id, f.raw_key, f.label, f.attribute, f.excerpt, f.evidence_origin, f.confidence,
            f.value_type, f.target_type, f.target_entity_id,
            e.title, e.document_type_code, e.multi_asset, e.metadata ->> 'legacyDocumentType' AS legacy_type,
            EXISTS (SELECT 1 FROM assets a WHERE a.id = f.target_entity_id AND a.account_id = f.account_id AND a.deleted_at IS NULL) AS target_ok,
            (af.asset_id = f.target_entity_id OR EXISTS (
               SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.file_id
                  AND l.asset_id = f.target_entity_id AND l.status = 'ACTIVE')) AS linked
       FROM document_facts f
       JOIN document_extractions e ON e.id = f.extraction_id AND e.account_id = f.account_id
       JOIN asset_files af ON af.id = f.file_id AND af.account_id = f.account_id AND af.deleted_at IS NULL
      WHERE f.status = 'active' AND f.canonical_key IS NULL AND f.projection_rule = $1
        AND f.id > $2 AND ($3::int IS NULL OR f.account_id = $3::int)
        AND ${processingEligibleSql('f.account_id')}
      ORDER BY f.id LIMIT $4`,
    [PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF, afterId, accountId, limit] as never[],
  )) as unknown as Row[];
}

/** Décision PURE sur une ligne (exportée pour les tests). */
export function decideNeutralizedFact(r: Row): { ok: true; fieldKey: string; assetId: number; documentType: string | null } | { ok: false; reason: PropertyRepriseRefusal; fieldKey: string | null } {
  const fieldKey = originalAcquisitionKey(str(r.value_type));
  if (!fieldKey) return { ok: false, reason: 'KEY_NOT_RECOVERABLE', fieldKey };
  const legacy = str(r.legacy_type);
  const v2 = str(r.document_type_code);
  const entry = resolveDocumentType(legacy) ?? resolveDocumentType(v2);
  if (r.multi_asset === null || r.multi_asset === undefined) return { ok: false, reason: 'MULTI_ASSET_UNKNOWN', fieldKey };
  const assetId = r.target_entity_id === null || r.target_entity_id === undefined ? null : num(r.target_entity_id);
  const decision = admitsPropertyWithoutRealization({
    fieldKey, entry,
    nature: transactionNature({ documentTypeCode: v2, texts: [str(r.title)] }),
    // Seuls des faits EXTRAITS par le modèle ont pu recevoir l'ancienne règle
    // (finalité OTHER : aucune règle déterministe n'y produit de fait).
    origin: 'MODEL_CANONICAL',
    provenance: str(r.evidence_origin), excerpt: str(r.excerpt), labels: [str(r.raw_key), str(r.label), str(r.attribute)],
    targetType: str(r.target_type), targetEntityId: r.target_ok === true ? assetId : null,
    multiAsset: r.multi_asset === true, confidence: str(r.confidence),
  });
  if (!decision.ok) return { ok: false, reason: decision.reason, fieldKey };
  if (r.linked !== true) return { ok: false, reason: 'DOCUMENT_NOT_LINKED_TO_TARGET', fieldKey };
  return { ok: true, fieldKey, assetId: assetId as number, documentType: entry?.code ?? legacy ?? v2 };
}

/** Mise à jour conditionnelle du fait (rend vrai si appliquée). */
async function requalify(factId: number, accountId: number, fieldKey: string): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `UPDATE document_facts
        SET canonical_key = $3, fact_key = $3, projection_origin = 'MODEL_CANONICAL', projection_rule = $4,
            semantic_event_type = NULL, semantic_event_nature = NULL
      WHERE id = $1 AND account_id = $2 AND status = 'active' AND canonical_key IS NULL AND projection_rule = $5
      RETURNING id`,
    [factId, accountId, fieldKey, PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION, PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF] as never[],
  )) as unknown as Row[];
  return rows.length > 0;
}

/** Preuve de champ du fait repris, par le chemin commun du rattachement (empreinte unique). */
async function writeEvidence(p: { accountId: number; userId: number; fileId: number; assetId: number; factExcerpt: string | null }): Promise<number | null> {
  const k = await import('@/services/ai/knowledge/document-knowledge.service');
  const knowledge = await k.getDocumentKnowledge(p.accountId, p.fileId);
  if (!knowledge) return null;
  const fields = k.linkedAssetProjectionFields(knowledge, p.assetId).filter((f) => f.canonicalKey === 'acquisitionPrice'
    && f.ruleCode === PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION
    && (f.excerpt ?? null) === p.factExcerpt
    && f.target?.targetType === 'ASSET' && f.target.targetEntityId === p.assetId);
  if (fields.length === 0) return null;
  const { persistEvidence } = await import('../steps/persist-evidence.step');
  const byField = await persistEvidence({
    input: {
      sourceType: knowledge.extraction.sourceType === 'web_link' ? 'web_link' : 'file',
      sourceIds: [p.fileId], accountId: p.accountId, userId: p.userId, mimeTypes: [], displayNames: [],
    } as never,
    leadSourceId: p.fileId,
    assetId: p.assetId,
    fields,
    documentType: (knowledge.extraction.metadata?.legacyDocumentType as string | undefined) ?? undefined,
    documentDate: knowledge.extraction.documentDate ?? undefined,
    promptVersion: knowledge.extraction.promptVersion ?? null,
    trace: {
      traceIds: [], operationCodes: ['l91c_property_evidence_reprise'], totalInputTokens: 0, totalOutputTokens: 0,
      totalCostMicros: 0, totalDurationMs: 0, usedFallback: false,
      models: knowledge.extraction.model ? [knowledge.extraction.model] : [],
    },
  });
  return byField.get('acquisitionPrice') ?? [...byField.values()][0] ?? null;
}

async function ownerOf(accountId: number): Promise<number | null> {
  const [r] = (await pgClient.unsafe(`SELECT owner_user_id FROM accounts WHERE id = $1`, [accountId] as never[])) as unknown as Row[];
  return r?.owner_user_id == null ? null : num(r.owner_user_id);
}

/**
 * Rattrapage des propriétés neutralisées. Ne lève pas pour un fait : son
 * échec est rapporté et le fait, resté dans l'ancien état, est repris au
 * passage suivant.
 */
export async function runPropertyEvidenceReprise(o: Options): Promise<PropertyRepriseReport> {
  const report: PropertyRepriseReport = {
    mode: o.apply ? 'apply' : 'simulate', runId: randomUUID(), origin: o.origin,
    scanned: 0, admitted: 0, requalified: 0, evidenceWritten: 0, assetsReconciled: 0, refused: {}, items: [], failed: 0, more: false,
  };
  const log = o.log ?? (() => undefined);
  const batch = Math.max(1, Math.min(o.batchSize ?? 200, 500));
  const max = Math.max(1, o.maxFacts ?? 5_000);
  const accountId = o.accountId ?? null;
  const motif = o.reason ?? (o.origin === 'SCHEDULED' ? 'Tâche planifiée « projection-property-evidence-reprise » (lot 91C)' : 'Rattrapage BO (lot 91C)');
  const aReconcilier = new Map<string, { accountId: number; assetId: number; fileId: number }>();
  const note = (it: PropertyRepriseItem) => { if (report.items.length < ITEMS_MAX) report.items.push(it); };

  let curseur = 0;
  for (;;) {
    if (o.deadline && Date.now() > o.deadline) { report.more = true; break; }
    const restant = max - report.scanned;
    if (restant <= 0) { report.more = (await selectNeutralized(accountId, curseur, 1)).length > 0; break; }
    const rows = await selectNeutralized(accountId, curseur, Math.min(batch, restant));
    if (rows.length === 0) break;
    for (const r of rows) {
      curseur = num(r.id);
      report.scanned += 1;
      const base = { factId: num(r.id), accountId: num(r.account_id), fileId: num(r.file_id) };
      const d = decideNeutralizedFact(r);
      if (!d.ok) {
        report.refused[d.reason] = (report.refused[d.reason] ?? 0) + 1;
        if (d.fieldKey === 'acquisitionPrice') {
          note({ ...base, assetId: r.target_entity_id == null ? null : num(r.target_entity_id), fieldKey: d.fieldKey,
            documentType: str(r.legacy_type) ?? str(r.document_type_code), outcome: 'REFUSED', reason: d.reason });
        }
        continue;
      }
      report.admitted += 1;
      if (!o.apply) {
        note({ ...base, assetId: d.assetId, fieldKey: d.fieldKey, documentType: d.documentType, outcome: 'TO_REQUALIFY' });
        continue;
      }
      try {
        if (!(await requalify(base.factId, base.accountId, d.fieldKey))) {
          note({ ...base, assetId: d.assetId, fieldKey: d.fieldKey, documentType: d.documentType, outcome: 'SKIPPED_CONCURRENT' });
          continue;
        }
        report.requalified += 1;
        const userId = await ownerOf(base.accountId);
        const evidenceId = userId === null ? null
          : await writeEvidence({ accountId: base.accountId, userId, fileId: base.fileId, assetId: d.assetId, factExcerpt: str(r.excerpt) });
        if (evidenceId !== null) report.evidenceWritten += 1;
        aReconcilier.set(`${base.accountId}:${d.assetId}`, { accountId: base.accountId, assetId: d.assetId, fileId: base.fileId });
        note({ ...base, assetId: d.assetId, fieldKey: d.fieldKey, documentType: d.documentType, outcome: 'REQUALIFIED', evidenceId });
        log(`fait ${base.factId} (compte ${base.accountId}, document ${base.fileId}) : prix d'acquisition repris (preuve ${evidenceId ?? '—'})`);
      } catch (e) {
        report.failed += 1;
        note({ ...base, assetId: d.assetId, fieldKey: d.fieldKey, documentType: d.documentType, outcome: 'ERROR', error: (e as Error).message.slice(0, 300) });
      }
    }
  }

  // T3 : même moteur que pour un document analysé (matrice d'autorité, préséance USER / ADMIN).
  if (o.apply && aReconcilier.size > 0) {
    const { enqueueT3ForAssets } = await import('@/services/ai/reconciliation/t3-queue');
    for (const x of aReconcilier.values()) {
      const userId = await ownerOf(x.accountId);
      if (userId === null) continue;
      try {
        await enqueueT3ForAssets({ accountId: x.accountId, userId, assetIds: [x.assetId], sourceFileId: x.fileId, reason: motif.slice(0, 200) });
        report.assetsReconciled += 1;
      } catch (e) {
        report.failed += 1;
        log(`bien ${x.assetId} (compte ${x.accountId}) : réconciliation non programmée — ${(e as Error).message}`);
      }
    }
  }
  return report;
}

/** Résumé court (tâche planifiée). */
export function formatPropertyEvidenceReprise(r: PropertyRepriseReport): string {
  const refus = Object.entries(r.refused).map(([k, v]) => `${k} ${v}`).join(', ') || 'aucun';
  return `${r.mode === 'apply' ? 'Application' : 'Simulation'} : ${r.scanned} fait(s) neutralisé(s) examiné(s), ${r.admitted} admis, `
    + `${r.requalified} repris, ${r.evidenceWritten} preuve(s) écrite(s), ${r.assetsReconciled} bien(s) en réconciliation T3, `
    + `${r.failed} échec(s) ; refus : ${refus}${r.more ? ' — reste à traiter' : ''}.`;
}
