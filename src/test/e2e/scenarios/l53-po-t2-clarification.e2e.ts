/**
 * Lot 53 (53F) — retours PO D21 / D22 / Q24, de bout en bout sur PostgreSQL
 * réel : `runAssistant` + ports RÉELS, opérations écrites par l'API de
 * production, master T2 rejoué (aucun réseau ; `replay.calls` compte les
 * appels modèle).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

const svc = () => import('@/services/business-operations/write');
const bus = () => import('@/services/business-operations/events');
type Repo = import('@/services/business-operations/repository').BusinessOperationRepository;
type Compte = { id: number; ownerUserId: number };

const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', confidence: 'probable', requestedFacts: [], requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});
const nbsp = (t: string | undefined) => (t ?? '').replace(/[  ]/g, ' ');

scenario('L53-PO-T2', 'Lot 53 (53F) — retours PO D21, D22, Q24 sur PostgreSQL réel', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  afterEach(async () => { (await bus()).resetBusinessOperationEventBusForTests(); });

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, category = 'VEHICULE') => make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category, name });
  const ecrire = async <T>(c: Compte, fn: (r: Repo) => Promise<T>) => (await svc()).withBusinessOperationWrite(c.id, fn);
  /** Contrat consolidé (opération CONTRACT) sur un document source, période et montants. */
  async function contrat(c: Compte, assetId: number, v: { label: string; provider: string; from: string; to?: string | null; couts?: Array<[number, string]> }) {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId, name: `${v.label}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${v.label}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return ecrire(c, async (r) => {
      const { id, sourceId } = await r.create({
        type: { code: 'CONTRACT' }, status: 'REALIZED', technicalLabel: v.label, provider: v.provider, startDate: v.from,
        source: { kind: 'DOCUMENT', entityKey: f.id, role: 'CONTRACT_DOCUMENT', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
      } as never);
      await r.upsertContractDetails(id, { contractReference: null, periodicity: 'MONTHLY', effectiveFrom: v.from, effectiveTo: v.to ?? null } as never);
      for (const [cents, date] of v.couts ?? []) {
        await r.addFinancialComponent(id, { kind: 'REALIZED_COST', amountMinor: cents, currency: 'EUR', economicDate: date, sources: [{ sourceId }] } as never);
      }
      return id;
    });
  }

  it('PO-D21-E2E-01 — période « en 2025 » : total de la période seulement (montants réels datés)', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3499, '2025-04-02'], [3499, '2025-11-02'], [3999, '2026-09-02']] });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: ['internet', 'fibre'] })]);
    const r = await demander(c, 'Combien ai-je payé pour internet en 2025 à la maison ?');
    expect(replay.calls).toHaveLength(1);
    expect(nbsp(r.answer)).toBe('Contrat « Abonnement Orange Fibre » (Maison) : total documenté 69,98 € sur l’année 2025 (2 montants, dernier 34,99 € le 2 novembre 2025).');
  });

  it('PO-D21-E2E-02 — plusieurs biens sans bien nommé : choix distingués par le bien, un seul appel modèle', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    const appart = await bien(c, 'Appartement Lyon', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-09-02']] });
    await contrat(c, appart.id, { label: 'Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[2999, '2026-09-02']] });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [], requestedTopics: ['internet', 'fibre'] }), understand({ intent: 'ACCOUNT_FACT_ASSET', semanticDecision: { decision: 'CLARIFY', selectedCandidateRef: null, confidence: 'probable', reason: 'e2e' } })]);
    const r0 = await demander(c, 'Bonjour');
    const r = await demander(c, 'Je paye combien pour internet ?', { conversationId: r0.conversationId });
    // Lot 54E (#419 écart 1) : plusieurs candidats → ARBITRAGE par T2 (2e appel), ici « CLARIFY ».
    expect(replay.calls).toHaveLength(2);
    expect(r.clarification?.candidates.map((x) => x.secondaryLabel?.split(' · ')[0]).sort()).toEqual(['Appartement Lyon', 'Maison']);
  });

  it('PO-Q24-E2E-01 — aucun libellé ne correspond, plusieurs contrats sur le bien : « De quel contrat ou service parlez-vous ? »', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Box SFR', provider: 'SFR', from: '2025-01-01', couts: [[2999, '2026-09-03']] });
    await contrat(c, maison.id, { label: 'Abonnement Netflix', provider: 'Netflix', from: '2025-01-01', couts: [[1349, '2026-09-10']] });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: ['internet'] }), understand({ intent: 'ACCOUNT_FACT_ASSET', semanticDecision: { decision: 'CLARIFY', selectedCandidateRef: null, confidence: 'probable', reason: 'e2e' } })]);
    const r0 = await demander(c, 'Bonjour');
    const r = await demander(c, 'Je paye combien pour internet à la maison ?', { conversationId: r0.conversationId });
    // Lot 54E (#419 écart 1) : plusieurs candidats → ARBITRAGE par T2 (2e appel), ici « CLARIFY ».
    expect(replay.calls).toHaveLength(2);
    expect(r.answer).toBe('Je n’ai trouvé aucun élément mentionnant « internet » pour Maison. De quel contrat ou service parlez-vous ?');
    expect(r.clarification?.candidates.map((x) => x.label).sort()).toEqual(['Contrat « Abonnement Netflix »', 'Contrat « Box SFR »']);
  });
});
