/**
 * Lot 49 — ticket 3 : T2 réduit le routage déterministe et laisse l'IA gérer
 * les ambiguïtés métier — de bout en bout sur PostgreSQL réel :
 * `runAssistant` + PORTS RÉELS (`buildOrchestratorPorts`), opérations écrites
 * par l'API de production (`withBusinessOperationWrite`), master T2 rejoué
 * par la vraie passerelle (aucun réseau) — `replay.calls` compte les appels.
 *
 *  · « Quand finit le contrat de la Cupra ? » (LLD + assurance) → UNDERSTAND
 *    (1 appel), clarification « De quel contrat parlez-vous ? » aux choix issus
 *    des opérations ; choix → reprise STRUCTURÉE, 0 appel de plus ;
 *  · « Je paye combien pour internet à la maison ? » → montant de l'opération
 *    pertinente, jamais la somme des abonnements ;
 *  · choix revalidés : bien archivé, source d'un autre compte → refusés.
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

scenario('L49-T2SEM', 'Lot 49 — T2 : périmètre sémantique, STRONG / WEAK, opérations sources natives', ({ sql, make, useRecordings }) => {
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

  it('T2SEM-E2E-01 — Cupra LLD + assurance : UNDERSTAND (1 appel), clarification issue des données, reprise structurée sans appel', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra');
    await contrat(c, cupra.id, { label: 'LLD Cupra', provider: 'Leasys', from: '2024-07-01', to: '2027-06-30' });
    await contrat(c, cupra.id, { label: 'Assurance auto', provider: 'MAAF', from: '2026-01-01', to: '2026-12-31' });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Cupra' }], requestedTopics: ['contrat'] }), understand({ intent: 'ACCOUNT_FACT_ASSET', semanticDecision: { decision: 'CLARIFY', selectedCandidateRef: null, confidence: 'probable', reason: 'e2e' } })]);
    const r0 = await demander(c, 'Bonjour');
    const r = await demander(c, 'Quand finit le contrat de la Cupra ?', { conversationId: r0.conversationId });
    // Lot 54E (#419 écart 1) : plusieurs candidats → ARBITRAGE par T2 (2e appel), ici « CLARIFY ».
    expect(replay.calls).toHaveLength(2);
    expect(r.answer).toBe('De quel contrat parlez-vous ?');
    expect(r.clarification?.candidates.map((x) => x.label).sort()).toEqual(['Contrat « Assurance auto »', 'Contrat « LLD Cupra »']);
    const [run] = await sql<{ j: { semantic?: Record<string, unknown> } }[]>`SELECT retrieval_methods_json AS j FROM verebona_request_runs WHERE request_id = ${r.requestId}`;
    expect(run?.j?.semantic).toMatchObject({ deterministicConfidence: 'WEAK', understandCalled: true, clarificationCreated: true, semanticResidue: ['contrat'] });

    // Choix → reprise : la source choisie est relue et revalidée, aucune reformulation.
    const { resoudreClarification } = await import('@/services/verebona-assistant/core/clarification.service');
    const { executerIssueClarification } = await import('@/services/verebona-assistant/core/clarification-flow');
    const { runAssistant } = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
    const { buildOrchestratorPorts } = await import('@/services/verebona-assistant/core/ports');
    const choix = r.clarification!.candidates.find((x) => x.label.includes('LLD'))!;
    const issue = await resoudreClarification({ accountId: c.id, userId: c.ownerUserId, conversationId: r0.conversationId, clarificationId: r.clarification!.clarificationId, choiceId: choix.id });
    expect(issue.kind).toBe('resume');
    const suite = await executerIssueClarification(issue, { accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', locale: 'fr-FR' }, { runAssistant, ports: buildOrchestratorPorts() });
    expect(suite.kind === 'result' && suite.result.answer).toBe('Contrat « LLD Cupra » (Cupra) se termine le 30 juin 2027.');
    expect(replay.calls).toHaveLength(2);
  });

  it('T2SEM-E2E-02 — « Je paye combien pour internet à la maison ? » : montant de l’opération pertinente, jamais la somme des abonnements', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-08-02'], [3999, '2026-09-02']] });
    await contrat(c, maison.id, { label: 'Abonnement Netflix', provider: 'Netflix', from: '2025-01-01', couts: [[1349, '2026-09-10']] });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: ['internet', 'fibre'] })]);
    const r = await demander(c, 'Je paye combien pour internet à la maison ?');
    expect(replay.calls).toHaveLength(1);
    expect(nbsp(r.answer)).toBe('Contrat « Abonnement Orange Fibre » (Maison) : dernier montant documenté 39,99 € (2 septembre 2026) ; total documenté 79,98 € sur 2 montants.');
    expect(r.answer).not.toMatch(/13,49|93,47|Netflix/);
    expect(r.cascade?.semantic?.operationCandidates).toHaveLength(1);
  });

  it('T2SEM-E2E-03 — choix revalidés par le serveur : bien archivé, source d’un autre compte → refusés', async () => {
    const a = await compte();
    const b = await compte();
    const cupra = await bien(a, 'Cupra');
    const opId = await contrat(a, cupra.id, { label: 'LLD Cupra', provider: 'Leasys', from: '2024-07-01', to: '2027-06-30' });
    const { readBusinessSource } = await import('@/services/verebona-assistant/canonical/business-sources');
    const { candidatToujoursValide } = await import('@/services/verebona-assistant/core/clarification.service');
    expect(await readBusinessSource(a.id, `operation:${opId}`, { assetIds: [cupra.id] })).not.toBeNull();
    // Autre compte : jamais lisible.
    expect(await readBusinessSource(b.id, `operation:${opId}`, { assetIds: [] })).toBeNull();
    const cand = { id: 'x', label: 'LLD', sourceRef: `operation:${opId}`, assetId: cupra.id };
    expect(await candidatToujoursValide(a.id, 'business_source', cand)).toBe(true);
    expect(await candidatToujoursValide(b.id, 'business_source', cand)).toBe(false);
    // Sans bien de reprise : une opération liée à un bien n'est jamais relue.
    expect(await readBusinessSource(a.id, `operation:${opId}`, { assetIds: [] })).toBeNull();
    await sql`UPDATE assets SET status = 'ARCHIVED' WHERE id = ${cupra.id}`;
    expect(await candidatToujoursValide(a.id, 'business_source', cand)).toBe(false);
    // Aucun bien disponible : les opérations du bien archivé ne sont pas exposées.
    const { listBusinessSources } = await import('@/services/verebona-assistant/canonical/business-sources');
    const lues = await listBusinessSources(a.id, { assetIds: [], need: { terms: ['contrat'], facts: [], need: 'end_date' } });
    expect(lues.sources.filter((s) => s.domain === 'operation')).toEqual([]);
  });

  it('T2SEM-E2E-04 — agrégation explicite « Combien ai-je dépensé en abonnements pour la Maison ? » : calcul structuré, 0 appel modèle', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Netflix', provider: 'Netflix', from: '2025-01-01', couts: [[1349, '2026-09-10']] });
    const replay = await useRecordings([]);
    const r = await demander(c, 'Combien ai-je dépensé en abonnements pour la Maison ?');
    expect(replay.calls).toHaveLength(0);
    expect(r.cascade?.strategy).toBe('structured.sum_qualified');
    expect(r.cascade?.semantic).toMatchObject({ deterministicConfidence: 'WEAK', trigger: 'none', understandCalled: false, structuredStrategyExecuted: true });
  });
});
