/**
 * Lot 109D — reprise de l'HISTORIQUE des remises lues comme des avoirs et des
 * achats fragmentés (ticket P1 « TCO — remises vs avoirs », §3E).
 *
 * Le TCO documentaire est recalculé à chaque lecture par le moteur corrigé
 * (`finance/economic-lines` + `finance/commercial-adjustments`) : rien à
 * écrire pour lui. Les écritures PERSISTÉES par T3 avant ce lot, en revanche,
 * restent fausses tant que l'Opération n'est pas reconsolidée :
 *   · composante `REDUCTION` / `REFUND` née d'une remise de commande / facture
 *     (faux avoir, double déduction) ;
 *   · source « remise seule » maintenant une Opération autonome ;
 *   · composantes de lignes / frais au lieu du net de l'achat (278,00 € au
 *     lieu de 277,35 €), commande payée restée en prévision.
 *
 * DIAGNOSTIC (lecture seule) : composantes ATTENDUES de chaque candidat du
 * document (`buildCandidateIdentity` + `componentsFromIdentity`, mêmes
 * constructeurs que T3, contexte documentaire compris) comparées aux
 * composantes PERSISTÉES que seules ses sources documentaires soutiennent.
 *
 * RÉPARATION : reconsolidation T3 DÉTERMINISTE des Opérations concernées
 * (`reconsolidateOperations`, aucun appel IA) — sources gérées seulement :
 * saisies (formulaires, migrations), décisions de montant / devise et gestes
 * « Ajouter / Retirer du TCO » de l'utilisateur jamais modifiés ; une
 * Opération soutenue par une décision de l'utilisateur est seulement signalée.
 * Idempotent : rejouée, plus aucun écart.
 */
import type { Sql } from '@/services/coherence/registry/types';
import { rows, type Row } from '@/services/coherence/registry/util';
import { planDocumentAdjustments } from '../finance/commercial-adjustments';
import { buildCandidateIdentity, componentsFromIdentity, type CandidateRecord } from './model';

export interface ComponentGap {
  componentId: number;
  operationId: number;
  kind: string;
  amountMinor: number;
  currency: string;
  candidateKeys: string[];
  /** FALSE_CREDIT : remise lue comme un avoir ; NOT_EXPECTED : ligne / frais / prévision au lieu du net de l'achat. */
  gap: 'FALSE_CREDIT' | 'NOT_EXPECTED';
}

export interface DocumentAdjustmentDiagnosis {
  fileId: number;
  gone: boolean;
  /** Codes de qualification du document (remise intégrée, commande payée, remise non ventilée…). */
  codes: string[];
  gaps: ComponentGap[];
  /** Sources actives d'un candidat « remise seule » (faux avoir autonome). */
  adjustmentOnlySources: Array<{ sourceId: number; operationId: number; candidateKey: string }>;
  /** Opérations à reconsolider (hors décisions de l'utilisateur). */
  operationIds: number[];
  /** Opérations portant une décision de l'utilisateur (montant, devise) : jamais réparées automatiquement. */
  userDecisionOperationIds: number[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function diagnoseDocumentAdjustments(sql: Sql, accountId: number, fileId: number, today: string): Promise<DocumentAdjustmentDiagnosis> {
  const vide = (gone: boolean): DocumentAdjustmentDiagnosis => ({ fileId, gone, codes: [], gaps: [], adjustmentOnlySources: [], operationIds: [], userDecisionOperationIds: [] });
  const [f] = await rows(sql, `SELECT id, deleted_at IS NOT NULL AS deleted, amount_cents FROM asset_files WHERE id = $1 AND account_id = $2`, [fileId, accountId]);
  if (!f || f.deleted) return vide(true);
  const cands: CandidateRecord[] = (await rows(sql, `
    SELECT id, account_id, file_id, candidate_key, established, confidence, type_hint, status_hint, summary, payload
      FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' ORDER BY candidate_key, id`, [accountId, fileId]))
    .map((r: Row) => ({
      id: Number(r.id), accountId: Number(r.account_id), fileId: Number(r.file_id), candidateKey: String(r.candidate_key), established: !!r.established,
      confidence: r.confidence as CandidateRecord['confidence'], typeHint: (r.type_hint as string | null) ?? null, statusHint: (r.status_hint as string | null) ?? null,
      summary: String(r.summary ?? ''), payload: (r.payload ?? {}) as CandidateRecord['payload'],
    }));
  const total = num(f.amount_cents);
  const etablis = cands.filter((c) => c.established);
  const plan = planDocumentAdjustments(etablis.map((c) => ({
    id: c.id, sourceRole: c.payload?.sourceRoleHint ?? null, statusHint: c.statusHint,
    hints: (c.payload?.financialHints ?? []).filter(Boolean).map((h) => ({ ...h, amountMinor: Number(h.amountMinor) })),
  })), { documentTotalMinor: total, today });
  const out = vide(false);
  out.codes = plan.codes;
  if (!plan.costBearing) return out;

  // Composantes attendues par candidat (mêmes constructeurs que T3, contexte du document).
  const attendues = new Map<string, Set<string>>();
  const retires = new Set<string>();
  for (const c of etablis) {
    const id = buildCandidateIdentity(c, {
      fileAssetId: null, liveAssetIds: new Set(), equipmentAssets: new Map(), documentCandidates: etablis, documentTotalMinor: total, today,
    });
    if (!id.established) { retires.add(c.candidateKey); continue; }
    attendues.set(c.candidateKey, new Set(componentsFromIdentity(id).map((x) => `${x.kind}:${x.amountMinor}:${x.currency}`)));
  }

  const sources = await rows(sql, `
    SELECT s.id, s.operation_id, s.locator->>'candidateKey' AS key
      FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
     WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text AND s.locator ? 'candidateKey'
       AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`, [accountId, fileId]);
  const ops = [...new Set(sources.map((s) => Number(s.operation_id)))];
  if (!ops.length) return out;
  const decisions = new Set((await rows(sql, `
    SELECT DISTINCT operation_id FROM business_operation_sources
     WHERE account_id = $1 AND active AND operation_id = ANY($2::bigint[]) AND locator ? 'decision'`, [accountId, ops])).map((r) => Number(r.operation_id)));
  out.userDecisionOperationIds = ops.filter((o) => decisions.has(o));
  for (const s of sources) {
    if (retires.has(String(s.key))) out.adjustmentOnlySources.push({ sourceId: Number(s.id), operationId: Number(s.operation_id), candidateKey: String(s.key) });
  }
  // Composantes actives que SEULES des sources de ce document soutiennent (jamais celles d'une saisie ou d'un autre justificatif).
  const comps = await rows(sql, `
    SELECT c.id, c.operation_id, c.kind, c.amount_minor, c.currency,
           array_agg(DISTINCT s.locator->>'candidateKey') FILTER (WHERE s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text) AS keys,
           bool_and(s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text AND s.locator ? 'candidateKey') AS only_this
      FROM business_operation_financial_components c
      JOIN business_operation_financial_component_sources cs ON cs.component_id = c.id
      JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.active
     WHERE c.account_id = $1 AND c.active AND c.operation_id = ANY($3::bigint[])
     GROUP BY c.id, c.operation_id, c.kind, c.amount_minor, c.currency`, [accountId, fileId, ops]);
  for (const c of comps) {
    if (!c.only_this) continue;
    const keys = ((c.keys as string[] | null) ?? []).filter(Boolean);
    const voulu = keys.some((k) => attendues.get(k)?.has(`${c.kind}:${Number(c.amount_minor)}:${String(c.currency).trim()}`));
    if (voulu) continue;
    const credit = c.kind === 'REDUCTION' || c.kind === 'REFUND';
    out.gaps.push({
      componentId: Number(c.id), operationId: Number(c.operation_id), kind: String(c.kind), amountMinor: Number(c.amount_minor), currency: String(c.currency).trim(),
      candidateKeys: keys, gap: credit ? 'FALSE_CREDIT' : 'NOT_EXPECTED',
    });
  }
  out.operationIds = [...new Set([...out.gaps.map((g) => g.operationId), ...out.adjustmentOnlySources.map((s) => s.operationId)])]
    .filter((o) => !decisions.has(o)).sort((a, b) => a - b);
  return out;
}

/** Réparation déterministe : reconsolidation T3 des Opérations concernées (aucune IA). */
export async function repairDocumentAdjustments(accountId: number, d: DocumentAdjustmentDiagnosis, opts: { today: string; correlationId?: string }): Promise<{ reconsolidated: number[]; changes: number }> {
  if (!d.operationIds.length) return { reconsolidated: [], changes: 0 };
  const { reconsolidateOperations } = await import('./consolidator');
  const changes = await reconsolidateOperations(accountId, d.operationIds, { today: opts.today, ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) });
  return { reconsolidated: d.operationIds, changes };
}
