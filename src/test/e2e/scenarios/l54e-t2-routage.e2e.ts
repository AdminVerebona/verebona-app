/**
 * Lot 54E — « T2 : finaliser le routage sémantique IA et résorber les écarts
 * avec le #419 » — de bout en bout sur PostgreSQL 16 réel : `runAssistant` +
 * PORTS RÉELS (`buildOrchestratorPorts`), opérations écrites par l'API de
 * production, master T2 rejoué par la vraie passerelle (aucun réseau) :
 * `replay.calls` compte les appels (UNDERSTAND, arbitrage).
 *
 *  · A  — « internet » : T2 arbitre entre les candidats exposés (références
 *         opaques), Orange Fibre servi, jamais Netflix ;
 *  · B  — opération sans montant + facture qui le porte : la facture répond ;
 *  · D  — Orange / Free, T2 « CLARIFY » : clarification issue des données ;
 *  · E  — « La date de fin de LLD de la Cupra est le 21/05/2027 » : plan
 *         PENDING_CONFIRMATION, rien écrit avant la confirmation explicite
 *         (même CommandPlan que les commandes), puis écriture USER ;
 *  · F  — information de contexte + question : aucun plan ;
 *  · G / I — fast-paths déterministes : 0 appel modèle.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, fiche, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

const svc = () => import('@/services/business-operations/write');
const bus = () => import('@/services/business-operations/events');
type Repo = import('@/services/business-operations/repository').BusinessOperationRepository;
type Compte = { id: number; ownerUserId: number };

const understand = (output: Record<string, unknown>, promptIncludes?: string) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND', ...(promptIncludes ? { promptIncludes } : {}),
  output: { mode: 'UNDERSTAND', confidence: 'probable', requestedFacts: [], requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});
/** Décision d'arbitrage rejouée pour le candidat dont le libellé figure à la référence `ref`. */
const arbitrage = (ref: string, label: string, decision: 'SELECT' | 'CLARIFY' = 'SELECT') => understand({
  intent: 'ACCOUNT_FACT_ASSET', semanticDecision: { decision, selectedCandidateRef: decision === 'SELECT' ? ref : null, confidence: 'probable', reason: 'e2e' },
}, `{"ref":"${ref}","kind":"contrat","label":"${label}"`);
const nbsp = (t: string | undefined) => (t ?? '').replace(/[  ]/g, ' ');

scenario('L54E-T2-419', 'Lot 54E — T2 : arbitrage sémantique IA, capacité des sources, informations apportées', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  afterEach(async () => { (await bus()).resetBusinessOperationEventBusForTests(); });

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, category = 'VEHICULE', kc?: Record<string, unknown>) =>
    make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category, name, ...(kc ? { keyCharacteristics: kc } : {}) });
  const ecrire = async <T>(c: Compte, fn: (r: Repo) => Promise<T>) => (await svc()).withBusinessOperationWrite(c.id, fn);
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
  const trace = async (requestId: string | undefined) => {
    const [run] = await sql<{ j: { semantic?: Record<string, unknown> } }[]>`SELECT retrieval_methods_json AS j FROM verebona_request_runs WHERE request_id = ${requestId ?? ''}`;
    return run?.j?.semantic ?? null;
  };

  it('T2-419-E2E-01 (A) — internet : T2 arbitre entre candidats opaques prévalidés, Orange Fibre servi, jamais Netflix', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-09-02']] });
    await contrat(c, maison.id, { label: 'Abonnement Netflix', provider: 'Netflix', from: '2025-01-01', couts: [[1349, '2026-09-10']] });
    const replay = await useRecordings([
      understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: ['internet'] }, 'Candidats métier exposés par le serveur (arbitrage) : null'),
      arbitrage('C1', 'Contrat « Abonnement Orange Fibre »'),
      arbitrage('C2', 'Contrat « Abonnement Orange Fibre »'),
    ]);
    const r = await demander(c, 'Je paye combien pour internet à la maison ?');
    expect(replay.calls).toHaveLength(2);
    const prompt = replay.calls[1].prompt;
    expect(prompt).toContain('"ref":"C1"');
    expect(prompt).not.toMatch(/operation:\d|asset_files|business_operations/);
    expect(nbsp(r.answer)).toMatch(/^Contrat « Abonnement Orange Fibre » \(Maison\) : dernier montant documenté 39,99 €/);
    expect(r.answer).not.toMatch(/Netflix|13,49/);
    expect(await trace(r.requestId)).toMatchObject({ candidateSelectionMode: 'ai', semanticDecision: 'SELECT', candidateRefValidated: true });
  });

  it('T2-419-E2E-02 (B) — opération Internet sans montant + facture Internet 39,99 € : la facture répond', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Internet', provider: 'Sosh', from: '2025-01-01' });
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: maison.id, name: 'facture.pdf' });
    await sql`UPDATE asset_files SET retained_title = 'Facture Internet août', amount_cents = 3999, document_date = '2026-08-31', supplier = 'Bouygues', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: ['internet'] })]);
    const r = await demander(c, 'Je paye combien pour internet à la maison ?');
    expect(replay.calls).toHaveLength(1);
    expect(nbsp(r.answer)).toBe('« Facture Internet août » (Maison) : 39,99 € (31 août 2026).');
    expect(r.answer).not.toMatch(/aucun montant/);
  });

  it('T2-419-E2E-03 (D) — Orange Fibre / Free Fibre, T2 « CLARIFY » : clarification aux choix issus des données', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-09-02']] });
    await contrat(c, maison.id, { label: 'Free Fibre', provider: 'Free', from: '2025-01-01', couts: [[2999, '2026-09-05']] });
    const replay = await useRecordings([
      understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: ['fibre'] }),
      understand({ intent: 'ACCOUNT_FACT_ASSET', semanticDecision: { decision: 'CLARIFY', selectedCandidateRef: null, confidence: 'probable', reason: 'e2e' } }),
    ]);
    const r0 = await demander(c, 'Bonjour');
    const r = await demander(c, 'Je paye combien pour internet à la maison ?', { conversationId: r0.conversationId });
    expect(replay.calls).toHaveLength(2);
    expect(r.clarification?.candidates.map((x) => x.label).sort()).toEqual(['Contrat « Abonnement Orange Fibre »', 'Contrat « Free Fibre »']);
    expect(r.answer).not.toMatch(/€/);
  });

  it('T2-419-E2E-04 (E) — information apportée : plan PENDING_CONFIRMATION, rien écrit avant confirmation, puis écriture USER', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra', 'VEHICULE', { vehicleOwnershipStatus: 'LLD' });
    const replay = await useRecordings([understand({
      intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Cupra' }], interactionMode: 'UPDATE_PROPOSAL',
      suppliedFacts: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', topic: 'fin de LLD', value: '21/05/2027', normalizedValue: '2027-05-21', role: 'update', confidence: 'exact' }],
    })]);
    const r = await demander(c, 'La date de fin de LLD de la Cupra est le 21/05/2027');
    expect(replay.calls).toHaveLength(1);
    expect(r.commandPlan?.summary).toBe('Modifier « Fin de contrat prévue » de Cupra : non renseigné → 21 mai 2027. Confirmez-vous ?');
    const [plan] = await sql<{ status: string }[]>`SELECT status FROM verebona_command_plans WHERE plan_id = ${r.commandPlan!.planId}`;
    expect(plan.status).toBe('PENDING_CONFIRMATION');
    // Aucune écriture automatique.
    expect((await fiche(sql, cupra.id)).leaseEndDate ?? null).toBeNull();
    expect(await trace(r.requestId)).toMatchObject({
      interactionMode: 'UPDATE_PROPOSAL', suppliedFactsCount: 1, updateCapabilityResolved: true, updateTargetType: 'asset_tenure_end', confirmationPlanCreated: true,
    });
    // Confirmation EXPLICITE par le mécanisme existant des commandes.
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    expect(await confirmCommandPlan({ planId: r.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true });
    expect(await fiche(sql, cupra.id)).toMatchObject({ leaseEndDate: '2027-05-21', leaseEndDate__origin: 'USER' });
    // L'autre membre / un autre compte ne confirme pas ; une 2e confirmation ne rejoue rien.
    expect(await confirmCommandPlan({ planId: r.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: false });
  });

  it('T2-419-E2E-05 (F) — information de contexte + question (MIXED) : aucun plan, aucune écriture', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra', 'VEHICULE', { vehicleOwnershipStatus: 'LLD' });
    await useRecordings([understand({
      intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Cupra' }], requestedTopics: ['mensualités'], interactionMode: 'MIXED',
      suppliedFacts: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', normalizedValue: '2027-05-21', role: 'context' }],
    })]);
    const r = await demander(c, 'La LLD de la Cupra finit le 21/05/2027, combien de mensualités me reste-t-il ?');
    expect(r.commandPlan ?? null).toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`;
    expect(n).toBe(0);
    expect((await fiche(sql, cupra.id)).leaseEndDate ?? null).toBeNull();
  });

  it('T2-419-E2E-06 (G, I) — fast-paths déterministes conservés : commande explicite et questions fortes, 0 appel modèle', async () => {
    const c = await compte();
    await bien(c, 'Polo', 'VEHICULE', { mileage: 80000 });
    const replay = await useRecordings([]);
    const cmd = await demander(c, 'Mets le kilométrage de la Polo à 45 000 km.');
    expect(cmd.cascade?.strategy).toBe('command.preview');
    expect(nbsp(cmd.commandPlan?.summary)).toMatch(/80 000 km → 45 000 km/);
    for (const q of ['Quelles sont mes échéances ?', 'Que dois-je traiter ?', 'Quels documents ne sont rattachés à aucun bien ?']) await demander(c, q);
    expect(replay.calls).toHaveLength(0);
  });
});
