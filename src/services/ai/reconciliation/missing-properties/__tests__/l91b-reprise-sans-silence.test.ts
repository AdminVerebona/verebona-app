/**
 * Lot 91B — ticket P1 « Garantir l'exécution de la reprise des propriétés
 * manquantes et supprimer les sorties silencieuses » : parties testables
 * sans base (journal et collecte simulés). Cycle complet sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l91b-reprise-proprietes-sans-silence.e2e.ts`.
 *
 *  L91B-U-01  service : chaque sortie anticipée est PERSISTÉE avant de rendre la main (contrat absent, nouvelle tentative pas
 *             encore due, tentatives épuisées, budget, panne IA) ; journal inutilisable → anomalie de Supervision ; T3 disponible → décision
 *  L91B-U-02  contrôle : issue des objets non réparés (constat, à blanc, anti-boucle), état du contrat, dernière issue au diagnostic
 *  L91B-U-03  moteur : les objets NON réparés sont transmis au contrôle (`recordOutcomes`), jamais les objets réparés ou cohérents
 *  L91B-U-04  rattrapage BO : bloc déclaré, demande validée, synthèse lisible ; contrôle déclaratif (version 2, Supervision immédiate)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const store = vi.hoisted(() => ({
  GATE_BATCH_PREFIX: 'gate:',
  propertyRecoveryReady: vi.fn(async () => true),
  decisionsFor: vi.fn(async () => new Map()),
  failedRunFor: vi.fn(async (): Promise<unknown> => null),
  latestOutcomeFor: vi.fn(async (): Promise<unknown> => null),
  sharedKnowledgeCallsLastDay: vi.fn(async () => 0),
  saveRun: vi.fn(async (_r: Record<string, unknown>) => 101),
  saveDecision: vi.fn(async (_d: Record<string, unknown>) => 201),
  saveOutcome: vi.fn(async (_o: Record<string, unknown>) => 301),
  reportRecoveryStorageUnavailable: vi.fn(async (_p: Record<string, unknown>) => {}),
}));
vi.mock('../store', () => store);

const VALEUR = '246 802,00';
const collecte = vi.hoisted(() => ({
  loadSubject: vi.fn(async () => ({
    type: 'ASSET', id: 14, accountId: 13, assetId: 14, category: 'IMMOBILIER', subtype: null, family: 'IMMOBILIER', archived: false, fields: {}, kc: {},
  })),
  loadProtections: vi.fn(async () => new Map()),
  collectSubjectContext: vi.fn(async () => ({
    documents: [{ ref: 'D1', fileId: 316, relation: 'LINKED', title: 'Pièce', documentType: null, rubric: null, documentDate: null }],
    elements: [{
      ref: 'F-1473', document: 'D1', fileId: 316, layer: 'FACT', kind: 'cle_voisine', label: 'Montant', value: '246802', text: 'Montant : 246 802,00',
      confidence: 'certain', page: null, provenance: { fileIds: [316], agendaItemIds: [] },
    }],
    collectionDropped: {}, missingLayers: [],
  })),
}));
vi.mock('../collect', () => collecte);

const svc = await import('../service');
const contrat = await import('../contract');
const catalogue = await import('../catalog');
const checkMod = await import('@/services/coherence/registry/checks/missing-properties');
const { listFields } = await import('@/services/canonical/registry');

const SUJET = { type: 'ASSET' as const, category: 'IMMOBILIER', subtype: null };
/** Propriété monétaire de référence, prise dans le registre (aucun nom codé). */
const MONTANT = catalogue.questionOf(listFields('IMMOBILIER').filter((d) => !catalogue.exclusionOf(d, SUJET)).find((d) => d.valueType === 'money_eur')!);

const capacite = (v2: boolean) => async () => ({
  available: true, version: 'v-test', reason: 'AVAILABLE' as const, contracts: v2 ? ['t3-knowledge-query-v1', contrat.MISSING_PROPERTIES_CONTRACT_VERSION] : ['t3-knowledge-query-v1'],
});
const NOW = new Date('2026-10-26T10:00:00Z');
const reponse = (confidence: 'certain' | 'probable') => async () => ({
  traceId: 'tr-1',
  output: {
    task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'simulé',
    findings: [{ target: MONTANT.key, rawValue: VALEUR, evidenceRefs: ['F-1473'], excerpt: VALEUR, confidence, meaning: 'simulé' }],
  },
}) as never;
const lancer = (deps: Record<string, unknown>) => svc.recoverMissingProperties(13, { type: 'ASSET', id: 14 }, {
  trigger: 'COHERENCE:DAILY', runRef: 'coherence:daily-7:COH-MISSING-PROPERTIES', campaignId: 7, today: '2026-10-26',
  deps: { now: () => NOW, perCall: 80, dailyMax: 50, ...deps } as never,
});

beforeEach(() => {
  for (const f of Object.values(store)) if (typeof f === 'function' && 'mockClear' in f) (f as ReturnType<typeof vi.fn>).mockClear();
  store.propertyRecoveryReady.mockResolvedValue(true);
  store.failedRunFor.mockResolvedValue(null);
  store.saveOutcome.mockResolvedValue(301);
  store.sharedKnowledgeCallsLastDay.mockResolvedValue(0);
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L91B-U-01 — aucune sortie anticipée sans issue persistée', () => {
  it('propriété vide + preuves + contrat absent → issue CONTRACT_PENDING persistée AVANT tout appel, avec tous les champs de traçabilité', async () => {
    const call = vi.fn();
    const r = await lancer({ capability: capacite(false), call });
    expect(call).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'CONTRACT_PENDING', persisted: true, runIds: [301] });
    expect(store.saveOutcome).toHaveBeenCalledTimes(1);
    const o = store.saveOutcome.mock.calls[0][0];
    expect(o).toMatchObject({
      accountId: 13, objectType: 'ASSET', objectId: 14, assetId: 14, status: 'CONTRACT_PENDING', contractState: 'MARKER_MISSING',
      promptVersion: 'v-test', contractVersion: 't3-knowledge-query-v2', trigger: 'COHERENCE:DAILY', runRef: 'coherence:daily-7:COH-MISSING-PROPERTIES', campaignId: 7,
    });
    expect(o.properties).toContain(MONTANT.key);
    expect(String(o.contextFp)).toMatch(/^[0-9a-f]{24}$/);
    expect(String(o.cause)).toContain('t3-knowledge-query-v2');
    expect(store.saveRun).not.toHaveBeenCalled();
    expect(store.saveDecision).not.toHaveBeenCalled();
  });

  it('journal inutilisable : tables absentes → MEMORY_UNAVAILABLE + anomalie ; écriture refusée → anomalie, issue non persistée', async () => {
    store.propertyRecoveryReady.mockResolvedValue(false);
    const r = await lancer({ capability: capacite(true), call: vi.fn() });
    expect(r).toMatchObject({ status: 'MEMORY_UNAVAILABLE', persisted: false });
    expect(store.reportRecoveryStorageUnavailable).toHaveBeenCalledWith(expect.objectContaining({ accountId: 13, objectType: 'ASSET', objectId: 14, status: 'MEMORY_UNAVAILABLE' }));
    expect(store.saveOutcome).not.toHaveBeenCalled();

    store.propertyRecoveryReady.mockResolvedValue(true);
    store.saveOutcome.mockRejectedValueOnce(new Error('colonnes 0790 absentes'));
    const r2 = await lancer({ capability: capacite(false), call: vi.fn() });
    expect(r2).toMatchObject({ status: 'CONTRACT_PENDING', persisted: false });
    expect(store.reportRecoveryStorageUnavailable).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'CONTRACT_PENDING', error: 'colonnes 0790 absentes' }));
  });

  it('budget épuisé → analyse BUDGET_EXHAUSTED persistée (cause, prochaine tentative), aucun appel', async () => {
    const call = vi.fn();
    const r = await lancer({ capability: capacite(true), call, dailyMax: 0 });
    expect(call).not.toHaveBeenCalled();
    expect(r.status).toBe('BUDGET_EXHAUSTED');
    expect(r.undecided).toContain(MONTANT.key);
    const run = store.saveRun.mock.calls[0][0];
    expect(run).toMatchObject({ status: 'BUDGET_EXHAUSTED', calls: 0, campaignId: 7, contractState: 'CARRIED', trigger: 'COHERENCE:DAILY' });
    expect(String(run.cause)).toContain('T3_KNOWLEDGE_QUERY_DAILY_MAX');
    expect(new Date(String(run.retryAt)).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('panne IA → AI_FAILED persisté avec nouvelle tentative ; tentative pas encore due → RETRY_SCHEDULED ; tentatives épuisées → AI_FAILED (issue)', async () => {
    const r = await lancer({ capability: capacite(true), call: vi.fn(async () => { throw new Error('fournisseur indisponible'); }) });
    expect(r.status).toBe('AI_FAILED');
    const run = store.saveRun.mock.calls[0][0];
    expect(run).toMatchObject({ status: 'AI_FAILED', calls: 1 });
    expect(String(run.cause)).toMatch(/^AI_CALL_FAILED: fournisseur indisponible/);
    expect(new Date(String(run.retryAt)).getTime()).toBe(NOW.getTime() + 60 * 60_000);

    const retryAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    store.failedRunFor.mockResolvedValue({ id: 55, status: 'AI_FAILED', attempts: 1, retryAt });
    const call = vi.fn();
    const r2 = await lancer({ capability: capacite(true), call });
    expect(call).not.toHaveBeenCalled();
    expect(r2.status).toBe('RETRY_SCHEDULED');
    expect(store.saveOutcome.mock.calls.at(-1)![0]).toMatchObject({ status: 'RETRY_SCHEDULED', retryAt });

    store.failedRunFor.mockResolvedValue({ id: 55, status: 'AI_FAILED', attempts: 3, retryAt: null });
    const r3 = await lancer({ capability: capacite(true), call });
    expect(r3.status).toBe('AI_FAILED');
    expect(String(store.saveOutcome.mock.calls.at(-1)![0].cause)).toMatch(/^MAX_ATTEMPTS_REACHED/);
    expect(call).not.toHaveBeenCalled();
  });

  it('propriété vide + preuves + T3 disponible → analyse ANSWERED et décision par propriété (abstention motivée si non établie)', async () => {
    const r = await lancer({ capability: capacite(true), call: vi.fn(reponse('probable')) });
    expect(r.status).toBe('ANSWERED');
    expect(store.saveRun.mock.calls[0][0]).toMatchObject({ status: 'ANSWERED', calls: 1, cause: null, campaignId: 7, contractState: 'CARRIED' });
    const d = store.saveDecision.mock.calls.map((c) => c[0]).find((x) => x.fieldKey === MONTANT.key)!;
    expect(d).toMatchObject({ decision: 'ABSTAINED', cause: 'INSUFFICIENT_CONFIDENCE', valueAfter: null });
    expect(store.saveOutcome).not.toHaveBeenCalled();
  });

  it('état du contrat T3 en clair', () => {
    const base = { available: true, reason: 'AVAILABLE', contractCarried: false };
    expect(contrat.contractStateOf({ ...base, contractCarried: true })).toBe('CARRIED');
    expect(contrat.contractStateOf(base)).toBe('MARKER_MISSING');
    expect(contrat.contractStateOf({ ...base, available: false, reason: 'BRANCH_MISSING' })).toBe('BRANCH_MISSING');
    expect(contrat.contractStateOf({ ...base, available: false, reason: 'DISABLED' })).toBe('DISABLED');
    expect(contrat.contractStateOf({ ...base, available: false, reason: 'UNREADABLE' })).toBe('UNREADABLE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════

type Etat = Parameters<typeof checkMod.diagnoseMissingProperties>[0] & object;
function etat(p: Partial<Etat> = {}): Etat {
  return {
    subject: { type: 'ASSET', id: 14, accountId: 13, assetId: 14, category: 'IMMOBILIER', subtype: null, family: 'IMMOBILIER', archived: false, fields: {}, kc: {} },
    catalog: { missing: [MONTANT], protectedKeys: [], excluded: { NOT_APPLICABLE: 0, INPUT_ONLY: 0, FREE_TEXT: 0, SENSITIVE: 0, STRUCTURED_JSON: 0 }, filled: 0 },
    documents: [], plan: { pages: [], complete: true, elements: 3, droppedElements: 0, cutElements: 0, byLayer: {}, droppedByLayer: {} },
    collected: { collectionDropped: {}, missingLayers: [] }, complete: true, contextFingerprint: 'fp1',
    capability: { available: true, version: 'v1', reason: 'AVAILABLE', contracts: [contrat.MISSING_PROPERTIES_CONTRACT_VERSION], contractCarried: true },
    decisionPromptVersion: 'v1', memoryReady: true, decided: new Map(), pending: [MONTANT], failedRun: null, lastOutcome: null, ...p,
  } as Etat;
}

describe('L91B-U-02 — issue des objets non réparés, diagnostic', () => {
  const sansContrat = { available: true, version: 'v1', reason: 'AVAILABLE' as const, contracts: [], contractCarried: false };

  it('constat « contrat absent » → CONTRACT_PENDING ; pannes répétées → AI_FAILED ; journal absent → MEMORY_UNAVAILABLE', () => {
    const st = etat({ capability: sansContrat });
    const i = checkMod.diagnoseMissingProperties(st, '2026-10-26');
    const issue = checkMod.unrepairedIssue({ result: 'FINDING', inspection: i }, st)!;
    expect(issue.status).toBe('CONTRACT_PENDING');
    expect(issue.cause).toMatch(/^MARKER_MISSING: .*t3-knowledge-query-v2.*88B-t3-proprietes-manquantes/);
    const st2 = etat({ failedRun: { id: 3, status: 'AI_FAILED', attempts: 3, retryAt: null } });
    expect(checkMod.unrepairedIssue({ result: 'FINDING', inspection: checkMod.diagnoseMissingProperties(st2, '2026-10-26') }, st2)).toMatchObject({ status: 'AI_FAILED' });
    const st3 = etat({ memoryReady: false });
    expect(checkMod.unrepairedIssue({ result: 'FINDING', inspection: checkMod.diagnoseMissingProperties(st3, '2026-10-26') }, st3)).toMatchObject({ status: 'MEMORY_UNAVAILABLE' });
  });

  it('campagne à blanc → DRY_RUN ; anti-boucle → REPAIR_SUPPRESSED avec la dernière issue ; rien en attente → aucune issue', () => {
    const st = etat({ lastOutcome: { id: 9, status: 'BUDGET_EXHAUSTED', cause: 'DAILY_BUDGET: 30 appel(s)', gate: false, contextFp: 'fp1', promptVersion: 'v1', properties: [], calls: 0, attempts: 1, trigger: 'COHERENCE:DAILY', campaignId: 4, retryAt: null, updatedAt: '2026-10-26T05:00:00.000Z' } });
    expect(checkMod.unrepairedIssue({ result: 'WOULD_REPAIR' }, st)).toMatchObject({ status: 'DRY_RUN', cause: expect.stringMatching(/^CAMPAIGN_DRY_RUN/) });
    const s = checkMod.unrepairedIssue({ result: 'REPAIR_SUPPRESSED', previousResult: 'REPAIR_INEFFECTIVE' }, st)!;
    expect(s.status).toBe('REPAIR_SUPPRESSED');
    expect(s.cause).toMatch(/ANTI_LOOP.*REPAIR_INEFFECTIVE.*BUDGET_EXHAUSTED/);
    expect(checkMod.unrepairedIssue({ result: 'WOULD_REPAIR' }, etat({ pending: [] }))).toBeNull();
  });

  it('jamais résolu tant qu’une propriété applicable vide reste sans décision ; la dernière issue persistée figure au détail', () => {
    for (const st of [etat(), etat({ capability: sansContrat }), etat({ memoryReady: false })]) {
      expect(['REPAIRABLE', 'FINDING']).toContain(checkMod.diagnoseMissingProperties(st, '2026-10-26').verdict);
    }
    const st = etat({ capability: sansContrat, lastOutcome: { id: 12, status: 'CONTRACT_PENDING', cause: 'MARKER_MISSING: …', gate: true, contextFp: 'fp1', promptVersion: 'v1', properties: [MONTANT.key], calls: 0, attempts: 2, trigger: 'COHERENCE:DAILY', campaignId: 5, retryAt: null, updatedAt: '2026-10-26T05:10:00.000Z' } });
    const i = checkMod.diagnoseMissingProperties(st, '2026-10-26');
    expect(i.detail!.lastOutcome).toMatchObject({ status: 'CONTRACT_PENDING', runId: 12, trigger: 'COHERENCE:DAILY' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L91B-U-03 — moteur : les objets non réparés sont transmis au contrôle', () => {
  it('FINDING et WOULD_REPAIR transmis avec leur inspection ; CONSISTENT jamais', async () => {
    const { controlObjects } = await import('@/services/coherence/engine');
    const sql = { unsafe: vi.fn(async () => []) } as never;
    const recu: Array<{ id: number; result: string; trigger?: string; campaignId?: number | null }> = [];
    const verdicts: Record<number, import('@/services/coherence/registry/types').Inspection> = {
      1: { verdict: 'FINDING', anomaly: 'X_PENDING', inputHash: 'h1' },
      2: { verdict: 'REPAIRABLE', anomaly: 'X_UNEXAMINED', inputHash: 'h2' },
      3: { verdict: 'CONSISTENT' },
    };
    const check = {
      ...checkMod.missingPropertiesCheck,
      id: 'COH-TEST-91B',
      inspect: async (_c: unknown, _a: number, ids: readonly number[]) => new Map(ids.map((id) => [id, verdicts[id]])),
      repair: vi.fn(),
      recordOutcomes: async (ctx: import('@/services/coherence/registry/types').CheckContext, _a: number, items: readonly import('@/services/coherence/registry/types').UnrepairedOutcome[]) => {
        for (const it of items) recu.push({ id: it.id, result: it.result, trigger: ctx.trigger, campaignId: ctx.campaignId });
      },
    };
    const s = await controlObjects({
      ctx: { sql, now: NOW, today: '2026-10-26', mode: 'DRY_RUN', correlationId: 'coherence:daily-7:COH-TEST-91B' },
      check: check as never, accountId: 13, ids: [1, 2, 3], trigger: 'DAILY', campaignId: 7, stillEligible: async () => ({ eligible: true, reason: 'ELIGIBLE' }),
    });
    expect(s.results).toEqual({ FINDING: 1, WOULD_REPAIR: 1, CONSISTENT: 1 });
    expect(recu).toEqual([
      { id: 1, result: 'FINDING', trigger: 'DAILY', campaignId: 7 },
      { id: 2, result: 'WOULD_REPAIR', trigger: 'DAILY', campaignId: 7 },
    ]);
    expect(check.repair).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L91B-U-04 — rattrapage BO et déclaratif du contrôle', () => {
  it('bloc « missing-properties-catchup » : simulation / application, filtre compte, motif obligatoire pour appliquer ; synthèse', async () => {
    const { backfillDefinition, validateBackfillRequest, BACKFILL_DEFINITIONS } = await import('@/services/admin/ops/backfill/definitions');
    const d = backfillDefinition('missing-properties-catchup')!;
    expect(d).toMatchObject({ actions: ['simulate', 'apply'], accountFilter: true });
    expect(new Set(BACKFILL_DEFINITIONS.map((x) => x.order)).size).toBe(BACKFILL_DEFINITIONS.length);
    expect(validateBackfillRequest({ script: 'missing-properties-catchup', action: 'simulate', accountId: 13 })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'missing-properties-catchup', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const s = summarizeBackfill('missing-properties-catchup', 'apply', null, { result: {
      requested: { 'COH-MISSING-PROPERTIES': 2 }, applied: true,
      items: [{ checkId: 'COH-MISSING-PROPERTIES', accountId: 13, objectId: 14, reason: 'NEVER_CONTROLLED' }, { checkId: 'COH-MISSING-PROPERTIES', accountId: 13, objectId: 15, reason: 'NO_RECENT_OUTCOME' }],
      controls: { processed: 2, results: { REPAIRED: 1, FINDING: 1 }, skippedAccounts: 0, aiCalls: 1 },
    } } as never);
    expect(s.headline).toMatch(/2 objet\(s\) repris \(1 jamais contrôlé/);
    expect(s.counters).toEqual(expect.arrayContaining([{ label: 'Résultat du contrôle : FINDING', value: 1 }]));
  });

  it('contrôles en version 2, issues consignées, rattrapage déclaré, Supervision immédiate du contrat absent', () => {
    for (const c of [checkMod.missingPropertiesCheck, checkMod.missingPropertiesEquipmentCheck]) {
      expect(c.version).toBe(2);
      expect(typeof c.recordOutcomes).toBe('function');
      expect(typeof c.catchupCandidates).toBe('function');
      expect(c.immediateSupervision).toEqual(expect.arrayContaining(['MISSING_PROPERTY_ARBITRATION_PENDING', 'MISSING_PROPERTY_MEMORY_UNAVAILABLE']));
      for (const a of c.immediateSupervision ?? []) expect(c.anomalies).toContain(a);
    }
  });
});
