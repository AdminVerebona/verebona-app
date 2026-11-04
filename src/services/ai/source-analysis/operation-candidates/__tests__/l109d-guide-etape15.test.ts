/**
 * Lot 109D — guide du PO, étape 15 (T1 `t1-commercial-adjustments-v1`, FACULTATIVE) :
 * le bloc est collé dans le texte T1 LIVRÉ comme le ferait le PO, puis vérifié
 * contre le code réel (contrôles d'activation du BO, schéma des candidats T1,
 * barrière T1, plan commun des montants). Le code est sûr sans ce bloc (L109D-U-GATE).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMasterTemplate } from '@/services/ai/prompts/prompt-loader';
import { checkMasterPromptContent } from '@/services/ai/master-prompts/master-prompt-checks';
import { guideBlock } from '@/services/ai/prompt-conformity/guide-blocks';
import { t1OperationCandidate } from '../../master/t1-contract';
import { gateOperationCandidates, type AnchoredOperationCandidate } from '../prepare';
import { planDocumentAdjustments } from '@/services/business-operations/finance/commercial-adjustments';

const T1_LIVRE = readFileSync(join(process.cwd(), 'src', 'services', 'ai', 'prompts', 'source-analysis', 't1_master_v1.txt'), 'utf-8');
const occurrences = (t: string, m: string) => t.split(m).length - 1;

describe('L109D-U-GUIDE-15 — étape 15 : bloc T1 `t1-commercial-adjustments-v1`', () => {
  const b = guideBlock('t1-commercial-adjustments-v1')!;

  it('bloc balisé, ligne repère unique ; collé : aucun bloquant BO, aucun emplacement ni branche ajoutés', () => {
    expect(b).toMatchObject({ prompt: 't1', action: 'insert-before', anchor: 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.' });
    expect(occurrences(T1_LIVRE, b.anchor!)).toBe(1);
    const apres = T1_LIVRE.replace(b.anchor!, `${b.text}\n\n${b.anchor}`);
    expect(apres).toContain('t1-commercial-adjustments-v1');
    expect(checkMasterPromptContent('T1', apres).blocking).toEqual(checkMasterPromptContent('T1', T1_LIVRE).blocking);
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(apres).branches).toEqual(inspectMasterTemplate(T1_LIVRE).branches);
  });

  it('exemple : candidat valide (schéma T1 réel) ; barrière + plan commun → un achat net de 277,35 €, payé, remise intégrée', () => {
    const json = b.text.split('\n').find((l) => l.startsWith('{"candidateKey"'))!;
    const c = t1OperationCandidate.parse(JSON.parse(json));
    const ancre: AnchoredOperationCandidate = {
      candidateKey: c.candidateKey, established: c.established, confidence: c.confidence, typeHint: c.typeHint, statusHint: c.statusHint, summary: c.summary,
      sourceRoleHint: c.sourceRoleHint, provider: c.provider ?? null, targetHints: c.targetHints.map((t) => ({ type: t.type, entityId: t.entityId, rawLabel: t.rawLabel ?? null, confidence: t.confidence })),
      businessReferences: c.businessReferences, temporalHints: {}, evidenceFactRefs: ['f0', 'f1', 'f2'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [],
      financialHints: c.financialHints.map((h) => ({ role: h.role, amountMinor: h.amountMinor, currency: h.currency, amountScope: h.amountScope ?? null, economicDate: h.economicDate ?? null,
        periodStart: null, periodEnd: null, factRef: `f${h.factIndex}` })),
    };
    const g = gateOperationCandidates([ancre], {
      hasExploitableContent: true, documentTypeCode: 'ACQUISITION_ORDER', capabilities: { rooms: true, equipments: true }, keptFactRefs: new Set(['f0', 'f1', 'f2']),
      verifiedIds: { ASSET: new Set(), EQUIPMENT: new Set([12]), ROOM: new Set() },
    });
    expect(g.candidates).toHaveLength(1);
    const p = planDocumentAdjustments([{ id: 1, sourceRole: g.candidates[0].sourceRoleHint, statusHint: g.candidates[0].statusHint, hints: g.candidates[0].financialHints }],
      { documentTotalMinor: 27_735, today: '2026-11-04' });
    expect(p.purchases).toEqual([expect.objectContaining({ netMinor: 27_735, kind: 'REALIZED_COST', discountsMinor: 2000, paidBy: { date: '2021-04-24', amountMinor: 27_735 } })]);
    expect(p.codes).toEqual(expect.arrayContaining(['COMMERCIAL_ADJUSTMENT_INTEGRATED', 'ORDER_PAID_REALIZED']));
  });
});
