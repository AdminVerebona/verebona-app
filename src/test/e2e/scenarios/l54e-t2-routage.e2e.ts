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
import { setDefaultResponder } from '../replay-gateway';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';

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

  // ════════════════════════════════════════════════════════════════════════
  // LOT 59 (59B) — finalisation du #419 : R01…R08 sur PostgreSQL 16 réel,
  // rattachements documentaires effectifs, isolation des comptes,
  // confirmation des modifications, réponses IA NON scriptées (R10).
  // ════════════════════════════════════════════════════════════════════════
  const piece = async (c: Compte, assetId: number | null, v: { title: string; amount?: number | null; date?: string | null; supplier?: string | null }) => {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId, name: `${v.title}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${v.title}, amount_cents = ${v.amount ?? null}, document_date = ${v.date ?? null},
              supplier = ${v.supplier ?? null}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id as number;
  };
  const rattacher = (c: Compte, opId: number, fileId: number) => ecrire(c, (r) => r.addSource(opId, {
    kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain',
  } as never));
  const MAISON_U = (topics: string[], extra: Record<string, unknown> = {}) =>
    understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'maison' }], requestedTopics: topics, ...extra }, 'Candidats métier exposés par le serveur (arbitrage) : null');
  afterEach(() => setDefaultResponder('t2_understand', 'UNDERSTAND', null));

  it('T2-419-R01-E2E — contrat Internet sans montant + facture 39,99 € RATTACHÉE (source active de l’Opération) : montant restitué, 1 seul appel', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    const opId = await contrat(c, maison.id, { label: 'Contrat Internet', provider: 'Sosh', from: '2025-01-01' });
    await rattacher(c, opId, await piece(c, maison.id, { title: 'Facture Sosh octobre', amount: 3999, date: '2026-10-02', supplier: 'Sosh' }));
    const replay = await useRecordings([MAISON_U(['internet'])]);
    const r = await demander(c, 'Je paye combien pour internet à la maison ?');
    expect(replay.calls).toHaveLength(1);
    expect(nbsp(r.answer)).toBe('« Facture Sosh octobre » (Maison) : 39,99 € (2 octobre 2026).');
    expect(r.answer).not.toMatch(/aucun montant|79,98/);
  });

  it('T2-419-R02-E2E — contrat sans date de fin + facture datée : aucune date de fin inventée', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Contrat Internet', provider: 'Sosh', from: '2025-01-01' });
    await piece(c, maison.id, { title: 'Facture Internet septembre', amount: 3999, date: '2026-09-02', supplier: 'Sosh' });
    await useRecordings([MAISON_U(['contrat', 'internet'])]);
    const r = await demander(c, 'Quand se termine mon contrat internet à la maison ?');
    expect(r.answer).not.toMatch(/2 septembre 2026/);
    expect(r.answer).not.toMatch(/se termine le/);
  });

  it('T2-419-R03-E2E — deux contrats chez le même fournisseur, même bien : aucune fusion ; l’Opération d’un AUTRE compte n’est jamais candidate', async () => {
    const autre = await compte();
    const sa = await bien(autre, 'Maison', 'IMMOBILIER');
    await contrat(autre, sa.id, { label: 'Orange Box Pro', provider: 'Orange', from: '2025-01-01', couts: [[9999, '2026-09-01']] });
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-09-02']] });
    await contrat(c, maison.id, { label: 'Orange Mobile', provider: 'Orange', from: '2025-01-01', couts: [[1999, '2026-09-05']] });
    const replay = await useRecordings([MAISON_U(['orange']), arbitrage('C1', 'Contrat « Orange Mobile »'), arbitrage('C2', 'Contrat « Orange Mobile »')]);
    const r = await demander(c, 'Je paye combien chez orange à la maison ?');
    expect(replay.calls).toHaveLength(2);
    expect(replay.calls[1].prompt).not.toMatch(/Box Pro|99,99/);
    expect(nbsp(r.answer)).toMatch(/^Contrat « Orange Mobile » \(Maison\) : dernier montant documenté 19,99 €/);
    expect(await trace(r.requestId)).toMatchObject({ selectionReason: 'MULTIPLE_PLAUSIBLE', candidateSelectionMode: 'ai' });
  });

  it('T2-419-R04-E2E — formulation différente des libellés : T2 reçoit des candidats de plusieurs domaines (opération ET document)', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Sosh', provider: 'Sosh', from: '2025-01-01', couts: [[2999, '2026-09-02']] });
    await piece(c, maison.id, { title: 'Relevé box', amount: 3500, date: '2026-09-20' });
    const replay = await useRecordings([MAISON_U(['connexion']), understand({ intent: 'ACCOUNT_FACT_ASSET', semanticDecision: { decision: 'CLARIFY', selectedCandidateRef: null, confidence: 'probable', reason: 'e2e' } })]);
    const r = await demander(c, 'Combien me coûte ma connexion à la maison ?');
    expect(replay.calls).toHaveLength(2);
    expect(replay.calls[1].prompt).toContain('"kind":"document"');
    expect(replay.calls[1].prompt).toContain('"kind":"contrat"');
    expect(r.answer).not.toMatch(/€/);
  });

  it('T2-419-R05-E2E — T2 « ambiguous », une seule source correspond : arbitrage « probable » refusé (exact exigé), clarification', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra', 'VEHICULE');
    await contrat(c, cupra.id, { label: 'LLD Cupra Formentor', provider: 'Leasys', from: '2024-07-01', to: '2027-06-30' });
    const replay = await useRecordings([
      understand({ intent: 'ACCOUNT_FACT_ASSET', confidence: 'ambiguous', entityHints: [{ type: 'asset', value: 'Cupra' }], requestedTopics: ['formentor'] }, 'Candidats métier exposés par le serveur (arbitrage) : null'),
      arbitrage('C1', 'Contrat « LLD Cupra Formentor »'),
    ]);
    const r = await demander(c, 'Quand finit la Formentor de la Cupra ?');
    expect(replay.calls).toHaveLength(2);
    expect(r.answer).not.toMatch(/se termine le/);
    expect(r.answer).toMatch(/votre question porte-t-elle sur Contrat « LLD Cupra Formentor »/);
    expect(await trace(r.requestId)).toMatchObject({
      candidateValidationFailure: 'INSUFFICIENT_CONFIDENCE', clarificationReason: 'SEMANTIC_UNDERSTANDING_AMBIGUOUS',
      t2PromptCapabilities: { arbitration: true, interaction: true },
    });
  });

  it('T2-419-R06-E2E — « Combien m’a coûté Internet au total pour la maison ? » : jamais le coût de possession de la maison', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-08-02'], [3999, '2026-09-02']] });
    await contrat(c, maison.id, { label: 'Abonnement Netflix', provider: 'Netflix', from: '2025-01-01', couts: [[1349, '2026-09-10']] });
    await useRecordings([MAISON_U(['internet']), arbitrage('C1', 'Contrat « Abonnement Orange Fibre »'), arbitrage('C2', 'Contrat « Abonnement Orange Fibre »')]);
    const r = await demander(c, 'Combien m’a coûté Internet au total pour la maison ?');
    expect(r.cascade?.strategy).not.toBe('structured.ownership_cost');
    expect(r.answer).not.toMatch(/possession|Netflix|13,49/);
    expect(nbsp(r.answer)).toMatch(/Orange Fibre.*79,98 €/);
  });

  it('T2-419-R07-E2E — information de contexte (MIXED) : calcul avec la date apportée, rien enregistré ; contradiction avec la fiche signalée', async () => {
    const { remainingPeriods } = await import('@/services/verebona-assistant/core/semantic-scope');
    const { aujourdhuiParis } = await import('@/services/verebona-assistant/core/query-period');
    const mixed = () => understand({
      intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Cupra' }], requestedTopics: ['mensualités'], interactionMode: 'MIXED',
      suppliedFacts: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', value: '21/05/2027', normalizedValue: '2027-05-21', role: 'context' }],
    });
    const Q = 'La LLD de la Cupra finit le 21/05/2027, combien de mensualités me reste-t-il ?';
    const c = await compte();
    const cupra = await bien(c, 'Cupra', 'VEHICULE', { vehicleOwnershipStatus: 'LLD' });
    await useRecordings([mixed()]);
    const r = await demander(c, Q);
    expect(nbsp(r.answer)).toContain(`il reste ${remainingPeriods(aujourdhuiParis(), '2027-05-21', 'month')} mois`);
    expect(r.commandPlan ?? null).toBeNull();
    expect((await fiche(sql, cupra.id)).leaseEndDate ?? null).toBeNull();
    expect(await trace(r.requestId)).toMatchObject({ contextFactsUsed: ['leaseEndDate'], calculation: 'remaining_periods' });
    const c2 = await compte();
    const cupra2 = await bien(c2, 'Cupra', 'VEHICULE', { vehicleOwnershipStatus: 'LLD', leaseEndDate: '2027-06-30' });
    await useRecordings([mixed()]);
    const r2 = await demander(c2, Q);
    expect(r2.answer).toMatch(/Je ne tranche pas/);
    expect((await fiche(sql, cupra2.id)).leaseEndDate).toBe('2027-06-30');
  });

  it('T2-419-R08-E2E — deux modifications sur un même bien : UN plan à deux actions, rien écrit avant confirmation ; un autre compte ne confirme pas', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE', { mileage: 80000 });
    await useRecordings([understand({
      intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Polo' }], interactionMode: 'UPDATE_PROPOSAL',
      suppliedFacts: [
        { targetHint: 'Polo', fieldKey: 'mileage', value: '45 000 km', normalizedValue: '45000', unit: 'km', role: 'update' },
        { targetHint: 'Polo', fieldKey: 'estimatedValue', value: '12 000 €', normalizedValue: '12000', role: 'update' },
      ],
    })]);
    const r = await demander(c, 'Le kilométrage de la Polo est de 45 000 km et sa valeur est de 12 000 €');
    expect(r.commandPlan?.actions).toHaveLength(2);
    expect(r.commandPlan?.summary).toMatch(/^Je vais effectuer 2 modifications/);
    expect(Number((await fiche(sql, polo.id)).mileage)).toBe(80000);
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    const intrus = await compte();
    expect(await confirmCommandPlan({ planId: r.commandPlan!.planId, accountId: intrus.id, userId: intrus.ownerUserId })).toMatchObject({ ok: false });
    expect(await confirmCommandPlan({ planId: r.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true });
    const apres = await fiche(sql, polo.id);
    expect(Number(apres.mileage)).toBe(45000);
    expect(Number(apres.estimatedValue)).toBe(12000);
  });

  it('T2-419-R10-E2E — arbitrage T2 NON scripté (réponses génériques aléatoires reproductibles) : la validation serveur tient sur PG réel', async () => {
    let graine = 4190;
    const alea = () => ((graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648);
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Abonnement Orange Fibre', provider: 'Orange', from: '2025-01-01', couts: [[3999, '2026-09-02']] });
    await contrat(c, maison.id, { label: 'Free Fibre', provider: 'Free', from: '2025-01-01', couts: [[2999, '2026-09-05']] });
    const decisions: string[] = [];
    // Modèle GÉNÉRIQUE : lit les candidats réellement présentés et répond au hasard (référence, confiance, décision).
    setDefaultResponder('t2_understand', 'UNDERSTAND', (input) => {
      const m = input.prompt.match(/Candidats métier exposés par le serveur \(arbitrage\) : (\[.*\])/);
      const cands = m ? (JSON.parse(m[1]) as Array<{ ref: string }>) : [];
      const refs = [...cands.map((x) => x.ref), 'C7', 'operation:1'];
      const decision = ['SELECT', 'SELECT', 'CLARIFY', 'NONE'][Math.floor(alea() * 4)];
      const ref = decision === 'SELECT' ? refs[Math.floor(alea() * refs.length)] : null;
      const confidence = ['exact', 'probable', 'ambiguous'][Math.floor(alea() * 3)];
      decisions.push(`${decision}:${ref}:${confidence}`);
      return { mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'probable', entityHints: [], requestedFacts: [], requestedTopics: [], filters: {}, reason: 'générique',
        semanticDecision: { decision, selectedCandidateRef: ref, confidence, reason: 'générique' } };
    });
    const rejouer = useRecordings; // appel répété (boucle) : pas un hook React
    for (let i = 0; i < 8; i += 1) {
      await rejouer([MAISON_U(['fibre'])]);
      const r = await demander(c, 'Je paye combien pour internet à la maison ?');
      const t = await trace(r.requestId) as Record<string, unknown>;
      const d = decisions[decisions.length - 1];
      if (/€/.test(r.answer)) {
        expect(t).toMatchObject({ candidateSelectionMode: 'ai', candidateRefValidated: true });
        expect(d).toMatch(/^SELECT:C[12]:(exact|probable)$/);
      } else {
        // Clarification (carte ou question en texte) ou information insuffisante — jamais un montant.
        expect(r.clarification != null || /parlez-vous|Je n’ai trouvé aucune donnée/.test(r.answer)).toBe(true);
      }
    }
    expect(new Set(decisions).size).toBeGreaterThan(1);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`;
    expect(n).toBe(0);
  });
  // ════════════════════════════════════════════════════════════════════════
  // LOT 75J — écarts résiduels du #419 (R01, R02, R04, R07, R08) et
  // cohérence T2 / TCO (couverture incertaine), PostgreSQL 16 réel,
  // fournisseurs de sources RÉELS, rattachements documentaires effectifs.
  // ════════════════════════════════════════════════════════════════════════
  const typer = (fileId: number, code: string) => sql`UPDATE asset_files SET document_type_code = ${code} WHERE id = ${fileId}`;

  it('T2-419-75J-R01-E2E — factures mensuelles rattachées à un contrat sans montant : total demandé = somme serveur ; facture + preuve de paiement : la facture', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    const opId = await contrat(c, maison.id, { label: 'Contrat Internet', provider: 'Sosh', from: '2025-01-01' });
    for (const [d, m] of [['2026-08-02', 'août'], ['2026-09-02', 'septembre'], ['2026-10-02', 'octobre']]) {
      const f = await piece(c, maison.id, { title: `Facture Sosh ${m}`, amount: 3999, date: d, supplier: 'Sosh' });
      await typer(f, 'TELECOM_INVOICE');
      await rattacher(c, opId, f);
    }
    // Preuve de paiement rattachée, même montant : jamais additionnée, jamais substituée.
    const preuve = await piece(c, maison.id, { title: 'Prélèvement Sosh octobre', amount: 3999, date: '2026-10-05', supplier: 'Sosh' });
    await typer(preuve, 'SUBSCRIPTION_PAYMENT_PROOF');
    await rattacher(c, opId, preuve);
    await useRecordings([MAISON_U(['internet'])]);
    const total = await demander(c, 'Combien m’a coûté internet au total pour la maison ?');
    expect(nbsp(total.answer)).toBe('Contrat « Contrat Internet » (Maison) : total documenté 119,97 € sur 3 montants (dernier 39,99 € le 2 octobre 2026).');
    expect(total.answer).not.toMatch(/159,96|réglé/);
    await useRecordings([MAISON_U(['internet'])]);
    const courant = await demander(c, 'Je paye combien pour internet à la maison ?');
    expect(nbsp(courant.answer)).toBe('« Facture Sosh octobre » (Maison) : 39,99 € (2 octobre 2026).');
  });

  it('T2-419-75J-R02-E2E — agenda : prochaine facturation (sans type métier) ≠ fin ; fin de contrat (type « contrat ») servie', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await contrat(c, maison.id, { label: 'Contrat Internet', provider: 'Sosh', from: '2025-01-01' });
    const f = await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title: 'Prochaine facturation internet Sosh', startDate: '2027-02-02', assetIds: [maison.id] });
    await sql`UPDATE agenda_items SET occurrence_nature = 'FORECAST' WHERE id = ${f.id}`;
    await useRecordings([MAISON_U(['contrat', 'internet'])]);
    const r = await demander(c, 'Quand se termine mon contrat internet à la maison ?');
    expect(r.answer).not.toMatch(/2 février 2027/);
    expect(nbsp(r.answer)).toBe('Contrat « Contrat Internet » (Maison) : aucune date de fin n’est renseignée.');
    // Fin EXPLICITE (type métier « contrat », nature DEADLINE) : la source le justifie.
    const c2 = await compte();
    const m2 = await bien(c2, 'Maison', 'IMMOBILIER');
    const fin = await make.agendaItem({ id: c2.id, ownerUserId: c2.ownerUserId } as never, { title: 'Fin du contrat internet Sosh', startDate: '2027-03-31', assetIds: [m2.id] });
    await sql`UPDATE agenda_items SET event_nature = 'DEADLINE', business_type = 'contract' WHERE id = ${fin.id}`;
    await useRecordings([MAISON_U(['contrat', 'internet'])]);
    const r2 = await demander(c2, 'Quand se termine mon contrat internet à la maison ?');
    expect(nbsp(r2.answer)).toMatch(/31 mars 2027/);
  });

  it('T2-419-75J-R04-E2E — sans bien nommé : pièce du compte sans bien examinée ; deux comptes aux sources similaires : aucune fuite', async () => {
    const autre = await compte();
    await bien(autre, 'Maison', 'IMMOBILIER');
    const fb = await piece(autre, null, { title: 'Facture Spotify', amount: 1799, date: '2026-10-01', supplier: 'Spotify' });
    const c = await compte();
    await bien(c, 'Maison', 'IMMOBILIER');
    await bien(c, 'Polo', 'VEHICULE');
    await piece(c, null, { title: 'Facture Spotify', amount: 1199, date: '2026-10-01', supplier: 'Spotify' });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', requestedTopics: ['spotify'] }, 'Candidats métier exposés par le serveur (arbitrage) : null')]);
    const r = await demander(c, 'Combien je paye pour Spotify ?');
    expect(replay.calls).toHaveLength(1);
    expect(nbsp(r.answer)).toBe('« Facture Spotify » : 11,99 € (1 octobre 2026).');
    expect(r.answer).not.toMatch(/17,99/);
    const { readBusinessSource, listBusinessSources } = await import('@/services/verebona-assistant/canonical/business-sources');
    expect(await readBusinessSource(c.id, `document:${fb}`, { assetIds: [] })).toBeNull();
    const lus = await listBusinessSources(c.id, { assetIds: [], includeUntargeted: true, need: { terms: ['spotify'], facts: [], need: 'amount' } });
    expect(lus.sources.map((x) => x.ref)).not.toContain(`document:${fb}`);
  });

  it('T2-419-75J-R07-E2E — question MIXED non décomptée : la date apportée répond, rien enregistré, aucun plan', async () => {
    const c = await compte();
    const cupra = await bien(c, 'Cupra', 'VEHICULE', { vehicleOwnershipStatus: 'LLD' });
    await useRecordings([understand({
      intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Cupra' }], requestedTopics: ['fin de location'], requestedFacts: ['leaseEndDate'], interactionMode: 'MIXED',
      suppliedFacts: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', value: '21/05/2027', normalizedValue: '2027-05-21', role: 'context' }],
    })]);
    const r = await demander(c, 'Ma location de la Cupra finit le 21/05/2027, à quelle date dois-je rendre la voiture ?');
    expect(nbsp(r.answer)).toMatch(/21 mai 2027 — valeur indiquée dans votre message, utilisée pour cette réponse seulement : elle n’a pas été enregistrée/);
    expect(r.commandPlan ?? null).toBeNull();
    expect((await fiche(sql, cupra.id)).leaseEndDate ?? null).toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`;
    expect(n).toBe(0);
    expect(await trace(r.requestId)).toMatchObject({ interactionMode: 'MIXED', contextFactsUsed: ['leaseEndDate'] });
  });

  it('T2-419-75J-R08-E2E — une modification valide + une sans valeur : aucun plan enregistré, valeur manquante demandée, rien écrit', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE', { mileage: 80000 });
    await useRecordings([understand({
      intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Polo' }], interactionMode: 'UPDATE_PROPOSAL',
      suppliedFacts: [
        { targetHint: 'Polo', fieldKey: 'mileage', value: '45 000 km', normalizedValue: '45000', unit: 'km', role: 'update' },
        { targetHint: 'Polo', fieldKey: 'estimatedValue', value: null, normalizedValue: null, role: 'update' },
      ],
    })]);
    const r = await demander(c, 'Le kilométrage de la Polo est de 45 000 km et mets à jour sa valeur');
    expect(r.commandPlan ?? null).toBeNull();
    expect(r.answer).toMatch(/Il me manque la valeur de/);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`;
    expect(n).toBe(0);
    expect(Number((await fiche(sql, polo.id)).mileage)).toBe(80000);
    expect(await trace(r.requestId)).toMatchObject({ updateFactsRefused: [{ fieldKey: 'estimatedValue', reason: 'VALUE_MISSING' }] });
  });

  it('T2-419-75J-T1-E2E — cohérence T2 / TCO : justificatif sans montant → TCO INCOMPLETE et total T2 « peut être incomplet » (même règle)', async () => {
    const c = await compte();
    const velo = await make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000, keyCharacteristics: { acquisitionDate: '2026-01-10' } });
    const ok = await piece(c, velo.id, { title: 'Réparation cadre', amount: 18_000, date: '2026-06-01', supplier: 'Atelier' });
    await typer(ok, 'REPAIR_INVOICE');
    const { sumQualifiedExpenses } = await import('@/services/verebona-assistant/canonical/expenses');
    const avant = await sumQualifiedExpenses(c.id, { assetIds: [velo.id] });
    expect(avant.qualifiedSumCents).toBe(18_000);
    expect(avant.coverage).toMatchObject({ uncertain: { count: 0 }, amountUnknown: { count: 0 } });
    const illisible = await piece(c, velo.id, { title: 'Révision (illisible)', amount: null, date: '2026-07-01', supplier: 'Atelier' });
    await typer(illisible, 'MAINTENANCE_INVOICE');
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    expect((await readAssetTco(c.id, velo.id, { today: '2026-10-14' })).status).toBe('INCOMPLETE');
    const apres = await sumQualifiedExpenses(c.id, { assetIds: [velo.id] });
    expect(apres.qualifiedSumCents).toBe(18_000);
    expect(apres.complete).toBe(false);
    expect(apres.coverage?.amountUnknown.fileIds).toEqual([illisible]);
    const { mixedExpenseNotes } = await import('@/services/verebona-assistant/canonical/expenses');
    expect(mixedExpenseNotes(apres, { scopeLabel: 'Vélo' }).join(' ')).toMatch(/sans montant lisible \(Révision \(illisible\)\) : montant inconnu, non compté — le total peut être incomplet/);
  });

  it('T2-419-75J-T2-E2E — cohérence T2 / TCO : acompte du même fournisseur sans lien (rapprochement INCERTAIN) → TCO INCOMPLETE, T2 incomplet et dit', async () => {
    const k = operationsKit(sql, make as never);
    const ac = await make.account({ plan: 'premium' });
    const cargo = await make.asset(ac, { category: 'OBJET', name: 'Cargo', purchasePriceCents: 100_000, keyCharacteristics: { acquisitionDate: '2025-01-01' } });
    const p = { provider: 'Atelier Cargo', targetHints: [cible(cargo.id)] };
    await k.document(ac, cargo.id, [cand({ ...p, businessReferences: [ref('ORDER', 'CMD-75J')], financialHints: [fh('REALIZED_COST', 20_000)] })], { type: 'WORKS_INVOICE', title: 'Facture caisse', amountCents: 20_000 });
    const libre = await k.document(ac, cargo.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 1_000, { amountScope: 'DEPOSIT' })] })], { type: 'WORKS_INVOICE', title: 'Acompte divers', amountCents: 1_000 });
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const t = await readAssetTco(ac.id, cargo.id, { today: '2026-10-14' });
    expect(t.status).toBe('INCOMPLETE');
    const { sumQualifiedExpenses, mixedExpenseNotes } = await import('@/services/verebona-assistant/canonical/expenses');
    const q = await sumQualifiedExpenses(ac.id, { assetIds: [cargo.id] });
    expect(q.qualifiedSumCents).toBe(t.summary.additionalCostsCents);
    expect(q.complete).toBe(false);
    expect(q.coverage?.uncertain.fileIds).toEqual([libre]);
    expect(mixedExpenseNotes(q, { scopeLabel: 'Cargo' }).join(' ')).toMatch(/acompte ou solde.*le total peut être incomplet/);
  });
});
