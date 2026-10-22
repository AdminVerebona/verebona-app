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
