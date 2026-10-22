/**
 * Lot 78A (§2A) — fusion des candidats T1 entre lots de pages : un même
 * libellé ne regroupe jamais deux transactions contradictoires ; les copies
 * d'une même transaction restent fusionnées (enrichissement).
 */
import { describe, expect, it } from 'vitest';
import { candidatesCompatible, mergeOperationCandidates, type AnchoredOperationCandidate } from '../prepare';

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
    summary: 'Achat', sourceRoleHint: 'INVOICE', provider: null, targetHints: [], businessReferences: [], temporalHints: {},
    financialHints: [], evidenceFactRefs: ['f1'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (amountMinor: number, factRef = 'f1') =>
  ({ role: 'REALIZED_COST', amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef }) as AnchoredOperationCandidate['financialHints'][number];

describe('L78A §2A — mergeOperationCandidates', () => {
  it('L78A-T1-01 — même libellé, montants d\'ordres de grandeur différents (277,35 € / 490 000 €) → deux candidats, jamais un regroupement', () => {
    const out = mergeOperationCandidates([cand({ financialHints: [fh(27735)] })], [cand({ financialHints: [fh(49_000_000, 'f9')], evidenceFactRefs: ['f9'] })]);
    expect(out.map((c) => c.candidateKey)).toEqual(['op1', 'op1~2']);
    expect(out[0].financialHints.map((h) => h.amountMinor)).toEqual([27735]);
  });

  it('L78A-T1-02 — même libellé, dates de réalisation ou prestataires différents → deux candidats', () => {
    expect(candidatesCompatible(cand({ temporalHints: { realizedDate: '2007-04-02' } }), cand({ temporalHints: { realizedDate: '2021-06-30' } }))).toBe(false);
    expect(candidatesCompatible(cand({ provider: 'Tikamoon' }), cand({ provider: 'Office notarial' }))).toBe(false);
    expect(candidatesCompatible(
      cand({ targetHints: [{ type: 'EQUIPMENT', entityId: 1, rawLabel: null, confidence: 'certain' }] }),
      cand({ targetHints: [{ type: 'EQUIPMENT', entityId: 2, rawLabel: null, confidence: 'certain' }] }),
    )).toBe(false);
  });

  it('L78A-T1-03 — même transaction vue par deux lots (même référence, montant complété) → un candidat enrichi', () => {
    const ref = [{ kind: 'INVOICE', value: 'F-1' }];
    const out = mergeOperationCandidates(
      [cand({ businessReferences: ref, provider: 'Tikamoon', temporalHints: { realizedDate: '2025-05-12' } })],
      [cand({ businessReferences: ref, provider: 'TIKAMOON', financialHints: [fh(27735, 'f2')], evidenceFactRefs: ['f2'] })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].financialHints.map((h) => h.amountMinor)).toEqual([27735]);
    expect(out[0].evidenceFactRefs).toEqual(['f1', 'f2']);
  });
});
