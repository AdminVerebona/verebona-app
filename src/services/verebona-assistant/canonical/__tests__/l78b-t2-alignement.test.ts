/**
 * Lot 78B (TCO-R-14 : même règle pour T2 et le TCO) — T2 n'additionne jamais
 * une composante que la règle partagée du TCO écarte (doublon présumé,
 * justificatif retiré, prix d'un autre bien, achat non incorporé). Décision
 * prise par `t2CostExclusions` (service TCO), appliquée par `operationCostLines`.
 * Montants réels T2 ↔ TCO sur le jeu #76 : `src/test/e2e/scenarios/l78b-tco-attribution.e2e.ts` (L78B-E05).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operationCostLines, summarizeOperationCosts, type AssistantOperationRead } from '../operations';

const MAISON = 70;
const comp = (id: number, amountMinor: number) => ({
  id, kind: 'REALIZED_COST' as const, amountMinor, currency: 'EUR', amountEurCents: null, economicDate: '2021-06-03', targetAssetId: null, label: null,
});
const op = (components: ReturnType<typeof comp>[]) => ({
  id: 76, active: true, typeCode: 'ACQUISITION', status: 'REALIZED', assetIds: [MAISON], components, documents: [], technicalLabel: 'Achat',
  realizedDate: '2007-05-14', startDate: null, plannedDate: null, provider: null, claimType: null,
}) as unknown as AssistantOperationRead;
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L78B-T2 — T2 aligné sur le TCO', () => {
  it('L78B-T2-01 — composantes écartées par la règle partagée : jamais additionnées (Opération #76 : 490 000 € une fois, chaises hors total)', () => {
    const o = op([comp(1, 27_735), comp(2, 49_000_000), comp(3, 49_000_000)]);
    const avant = summarizeOperationCosts(operationCostLines([o], { assetIds: [MAISON] }), null).part;
    expect(avant.sumCents).toBe(98_027_735); // comportement antérieur (rouge du ticket)
    const apres = summarizeOperationCosts(operationCostLines([o], { assetIds: [MAISON], excludedComponentIds: new Set([1, 3]) }), null).part;
    expect(apres.sumCents).toBe(49_000_000);
  });

  it('L78B-T2-02 — une seule règle : T2 délègue au service TCO, sans logique propre de doublon ni de pertinence', () => {
    const exp = lire('src/services/verebona-assistant/canonical/expenses.ts');
    expect(exp).toContain('t2CostExclusions(accountId, ops, ids)');
    expect(exp).toContain('excludedComponentIds: excl.components');
    const ops = lire('src/services/verebona-assistant/canonical/operations.ts');
    for (const t of [exp, ops]) expect(t).not.toMatch(/presumedDuplicateComponents|purchaseIsOwnershipCost|distinctTransactions/);
    const svc = lire('src/services/business-operations/tco/service.ts');
    expect(svc).toMatch(/readAssetTco\(accountId, assetIds\[0\]/);
    expect(svc).toContain('presumedDuplicateComponents({ typeCode: o.typeCode, components: comps }, prov, force)');
  });
});

// Lot 81D (TCO-R-14) : la non-réalisation (motifs NOT_REALIZED / FUTURE_DATED) s'applique aussi à T2 — pour un bien via
// la décision du TCO, pour le compte entier via la règle sans bien du moteur partagé. E2E : l76g-tco-annuel (L81D-E06).
import { nonRealizedComponentIds } from '@/services/business-operations/tco/model';

describe('L81D-T2 — T2 aligné sur les dépenses non réalisées du TCO', () => {
  const c = (id: number, economicDate: string | null) => ({ id, operationId: 1, kind: 'REALIZED_COST' as const, amountMinor: 100, currency: 'EUR', amountEurCents: null, economicDate, targetAssetId: null });
  it('L81D-T2-01 — compte entier : prévue sans paiement daté et justifié, ou datée après la date de référence → exclue ; réalisée passée → comptée', () => {
    const ids = nonRealizedComponentIds([
      { status: 'ENVISAGED', realizedDate: null, startDate: null, components: [c(1, null), c(2, '2026-05-01'), c(3, '2026-06-01')] },
      { status: 'REALIZED', realizedDate: '2026-12-01', startDate: null, components: [c(4, null), c(5, '2026-10-01')] },
    ], new Map([[3, { documentFileIds: [9] }]]), '2026-10-23');
    expect([...ids].sort()).toEqual([1, 2, 4]);
    const avant = summarizeOperationCosts(operationCostLines([op([comp(1, 30_000), comp(5, 5_000)])], { assetIds: [MAISON] }), null).part;
    const apres = summarizeOperationCosts(operationCostLines([op([comp(1, 30_000), comp(5, 5_000)])], { assetIds: [MAISON], excludedComponentIds: new Set([1]) }), null).part;
    expect(avant.sumCents - apres.sumCents).toBe(30_000);
  });
  it('L81D-T2-02 — une seule règle : motifs repris par `t2CostExclusions`, même date de référence que le TCO', () => {
    const svc = lire('src/services/business-operations/tco/service.ts');
    expect(svc).toMatch(/MOTIFS_78B_COMPOSANTE[^\n]*'NOT_REALIZED', 'FUTURE_DATED'/);
    expect(svc).toMatch(/MOTIFS_78B_DOCUMENT[^\n]*'FUTURE_DATED'/);
    expect(svc).toContain('nonRealizedComponentIds(');
    expect(svc).toContain('readAssetTco(accountId, assetIds[0], { runner: r, today })');
  });
});
