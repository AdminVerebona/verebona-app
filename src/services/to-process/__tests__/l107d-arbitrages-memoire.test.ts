/**
 * Lot 107D — mémoire des arbitrages tranchés par l'utilisateur, par CONTENU des
 * preuves (parties pures : clé de contenu, verdict). Aucune base.
 */
import { describe, expect, it } from 'vitest';
import { contentKeyOf, judgeAgainstUserDecision, proposalEvidenceIds, type EvidenceKeyInfo, type UserDecisionMemory } from '../arbitration-memory';
import { nonAttributableDecision } from '@/services/ai/reconciliation/multi-article-evidence';

const info = (o: Partial<EvidenceKeyInfo> & { source: string; value: unknown }): EvidenceKeyInfo => ({
  key: contentKeyOf({ sourceType: o.source.split(':')[0], sourceId: o.source.split(':')[1], fieldKey: 'acquisitionPrice', value: o.value, targetType: 'ASSET', targetId: 7 }),
  evidenceId: o.evidenceId ?? '1', confidence: o.confidence ?? 'certain', projectionRule: null, ...o,
});
const memoire = (infos: EvidenceKeyInfo[]): UserDecisionMemory => ({
  actionId: 41, resolvedAt: '2026-11-01T10:00:00.000Z', reason: 'USER_ARBITRATED',
  keys: new Set(infos.map((i) => i.key)), sources: new Set(infos.map((i) => i.source)),
});

describe('L107D-U-MEMORY — décision utilisateur persistante', () => {
  it('L107D-U-MEMORY-01 — clé de contenu stable : même document, même valeur (formats différents), autre identifiant de preuve → même clé', () => {
    const a = contentKeyOf({ sourceType: 'document', sourceId: 12, fieldKey: 'acquisitionPrice', value: 127.93, targetType: 'ASSET', targetId: 7 });
    const b = contentKeyOf({ sourceType: 'document', sourceId: '12', fieldKey: 'acquisitionPrice', value: '127.93', targetType: 'ASSET', targetId: 7 });
    expect(a).toBe(b);
    expect(contentKeyOf({ sourceType: 'document', sourceId: 13, fieldKey: 'acquisitionPrice', value: 127.93, targetType: 'ASSET', targetId: 7 })).not.toBe(a);
    expect(contentKeyOf({ sourceType: 'document', sourceId: 12, fieldKey: 'acquisitionPrice', value: 127.93, targetType: 'EQUIPMENT', targetId: 7 })).not.toBe(a);
  });

  it('L107D-U-MEMORY-02 — aucune décision : comportement antérieur', () => {
    expect(judgeAgainstUserDecision(null, [info({ source: 'document:12', value: 127.93 })])).toEqual({ reopen: false, code: 'NO_USER_DECISION' });
  });

  it('L107D-U-MEMORY-03 — mêmes preuves réémises (nouvel identifiant de preuve) : aucune réouverture', () => {
    const m = memoire([info({ source: 'document:12', value: 127.93, evidenceId: '100' })]);
    expect(judgeAgainstUserDecision(m, [info({ source: 'document:12', value: 127.93, evidenceId: '250' })])).toMatchObject({ reopen: false, code: 'SAME_EVIDENCE', decidedActionId: 41 });
  });

  it('L107D-U-MEMORY-04 — même document réanalysé avec une autre valeur : pas une nouvelle contradiction', () => {
    const m = memoire([info({ source: 'document:12', value: 127.93 })]);
    expect(judgeAgainstUserDecision(m, [info({ source: 'document:12', value: 125.5 })])).toMatchObject({ reopen: false, code: 'SAME_SOURCE_REEXTRACTED' });
  });

  it('L107D-U-MEMORY-05 — nouveau document mais preuve probable : aucune réouverture ; certaine : nouvel arbitrage motivé (source et valeur citées)', () => {
    const m = memoire([info({ source: 'document:12', value: 127.93 })]);
    expect(judgeAgainstUserDecision(m, [info({ source: 'document:30', value: 74.5, confidence: 'probable' })])).toMatchObject({ reopen: false, code: 'NEW_EVIDENCE_NOT_RELIABLE' });
    expect(judgeAgainstUserDecision(m, [info({ source: 'document:30', value: 74.5, evidenceId: '301' })])).toEqual({
      reopen: true, code: 'NEW_INDEPENDENT_EVIDENCE', decidedActionId: 41, sources: [{ source: 'document:30', evidenceId: '301', value: 74.5 }],
    });
  });

  it('L107D-U-MEMORY-06 — preuves de la carte : propositions non courantes seulement', () => {
    expect(proposalEvidenceIds([{ evidenceIds: ['1', '2'] }, { evidenceIds: ['2', '3'] }, { isCurrentValue: true, evidenceIds: ['9'] }])).toEqual(['1', '2', '3']);
  });

  it('L107D-U-MEMORY-07 — toutes les preuves du prix écartées (total multi-articles) : valeur en place conservée (arbitrage clos) ; champ vide : aucune valeur inventée', () => {
    const ex = [{ evidenceId: 5, sourceId: 12, value: 127.93, cents: 12793, reason: 'BASKET_TOTAL_MULTI_ARTICLE' as const, summaryRoles: ['TOTAL_PAID' as const], projectionRule: null }];
    expect(nonAttributableDecision('acquisitionPrice', { value: 69.99, normalized: '69.99', origin: 'USER', updatedAt: null }, ex))
      .toMatchObject({ action: 'keep', reasonCode: 'NON_ATTRIBUTABLE_AMOUNT', proposedValue: 69.99 });
    expect(nonAttributableDecision('acquisitionPrice', null, ex)).toMatchObject({ action: 'ignore', reasonCode: 'NO_EVIDENCE', proposedValue: null });
  });
});
