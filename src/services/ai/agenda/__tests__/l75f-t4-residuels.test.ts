/**
 * Lot 75F — ticket « [P1] T4 — Corriger les derniers risques de modification
 * et suppression injustifiées des échéances ». Tests unitaires (aucune base,
 * modèle simulé) ; les scénarios PG16 du tableau §3 sont dans
 * `src/test/e2e/scenarios/l75f-t4-residuels.e2e.ts` (`npm run test:e2e:t4`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { T4EventDecision, ClassifyEventContext } from '../master/classify-event';

vi.mock('../master/t4-decision-trace', async (orig) => ({
  ...(await orig<typeof import('../master/t4-decision-trace')>()),
  attachT4DecisionToTrace: vi.fn(async () => true),
}));

const { processAgendaCandidates } = await import('../agenda-intelligence.service');
const { translateEventDecision } = await import('../master/classify-event');
const { T4ClassifyEventV2Output } = await import('../master/t4-contract');
const { planSourceSync, computeAgendaFunctionalKey, isUserTouched, agendaUntouchedSql } = await import('@/services/agenda/agenda-functional-key');
const { runT4Job, T4IncompleteJobError, t4SyncFailure } = await import('../index');
const { NO_GUARD } = await import('../../queue/execution-control');
const { parseRecurrenceFr } = await import('../rules/recurrence');
const { resolveRecurrenceEnd } = await import('../rules/recurrence-end');

type SourceItem = import('@/services/agenda/agenda-functional-key').SourceItem;
const TODAY = '2026-10-19';

const t4 = (agenda: 'accept' | 'reject' | 'abstain', recurrence: 'accept' | 'abstain' = 'abstain') => vi.fn(async (_i: unknown, ctx: ClassifyEventContext): Promise<T4EventDecision> => {
  const out = T4ClassifyEventV2Output.parse({
    task: 'CLASSIFY_EVENT', agendaDecision: agenda,
    recurrenceDecision: ctx.recurrenceCandidate ? recurrence : 'not_applicable',
    homeCategory: agenda === 'accept' ? 'action' : 'unknown', businessType: null,
    confidence: agenda === 'abstain' ? 'ambiguous' : 'certain', reason: 'simulé',
    recurrenceReason: ctx.recurrenceCandidate ? 'simulé' : null,
  });
  return translateEventDecision(out, Boolean(ctx.recurrenceCandidate));
});
const item = (o: Partial<SourceItem>): SourceItem => ({
  id: 1, functionalKey: null, title: 'Alpha', startDate: '2027-03-01', originFieldKey: null,
  isAutomatic: true, isAutomaticModified: false, manualStatus: null, ...o,
});
const cle = (date: string, rang = 1) => {
  const k = computeAgendaFunctionalKey({ sourceFileId: 40, target: { type: 'ASSET', id: 3 }, businessType: null, originFieldKey: null, occurrence: date });
  return rang === 1 ? k : `${k}#${rang}`;
};
const plan = (items: SourceItem[], decisions: Array<Record<string, unknown>>) => planSourceSync({
  sourceFileId: 40, assetId: 3, items,
  decisions: decisions.map((d, index) => ({ index, sourceFileId: 40, date: '2027-03-01', ...d })) as never,
});

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('§A — tout choix utilisateur protège l’événement', () => {
  it('T4-RES-A — règle unique : manuel, modifié, statut renseigné, prévision confirmée par l’utilisateur', () => {
    const base = { isAutomatic: true, isAutomaticModified: false, manualStatus: null as string | null };
    expect(isUserTouched(base)).toBe(false);
    expect(isUserTouched({ ...base, confirmationMode: 'SOURCE' })).toBe(false);
    expect(isUserTouched({ ...base, isAutomatic: false })).toBe(true);
    expect(isUserTouched({ ...base, isAutomaticModified: true })).toBe(true);
    expect(isUserTouched({ ...base, manualStatus: 'realise' })).toBe(true);
    expect(isUserTouched({ ...base, manualStatus: 'annule' })).toBe(true);
    expect(isUserTouched({ ...base, confirmationMode: 'USER' })).toBe(true);
    // Garde SQL : mêmes conditions.
    expect(agendaUntouchedSql('i')).toBe("i.is_automatic AND NOT COALESCE(i.is_automatic_modified, false) AND (i.manual_status IS NULL OR i.manual_status = '') AND i.confirmation_mode IS DISTINCT FROM 'USER'");
  });

  it('T4-RES-01 — fin de récurrence : aucune prévision au statut utilisateur (« réalisé ») n’est retirée ; prévision intacte retirée (T4-RES-04)', async () => {
    // Lot 99D : la fin est une fin QUALIFIÉE (résiliation constatée, datée, preuve fiable) — plus un mot-clé.
    const excerpt = 'Entretien chaudière tous les 12 mois';
    const end = resolveRecurrenceEnd({ texts: [{ text: 'Le contrat d’entretien a été résilié le 15/10/2026.', confidence: 'certain', fieldKey: 'contractNote' }], endDates: [] }, { today: TODAY });
    expect(end).toMatchObject({ status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: '2026-10-15' });
    const c = { title: 'Entretien chaudière', date: '2026-11-15', confidence: 'certain', excerpt, documentType: 'RAPPORT_ENTRETIEN', recurrence: { ...parseRecurrenceFr(excerpt)!, end } };
    const serie = (manual: boolean) => [
      { id: 10, title: 'Entretien chaudière', date: '2026-11-15', category: 'action', status: null, manual: false, originFieldKey: null, nature: 'CONFIRMED' },
      { id: 11, title: 'Entretien chaudière', date: '2027-11-15', category: 'action', status: manual ? 'realise' : null, manual, originFieldKey: null, nature: 'FORECAST' },
    ];
    const run = (existing: unknown[]) => processAgendaCandidates({
      accountId: 1, assetId: 3, sourceFileId: 40, today: TODAY, existing: existing as never, candidates: [c] as never, decide: t4('accept', 'accept') as never,
    });
    expect((await run(serie(true))).filter((d) => d.action === 'retire_forecast')).toEqual([]);
    expect((await run(serie(false))).filter((d) => d.action === 'retire_forecast').map((d) => d.existingItemId)).toEqual([11]);
  });

  it('T4-RES-02 — prévision protégée (statut renseigné) lue à une autre date : arbitrage, jamais une confirmation qui déplace la date', async () => {
    const existing = [{ id: 11, title: 'Entretien chaudière', date: '2027-11-15', category: 'action', status: 'annule', manual: true, originFieldKey: 'boilerServiceDueDate', nature: 'FORECAST' }];
    const [d] = await processAgendaCandidates({
      accountId: 1, assetId: 3, sourceFileId: 41, today: TODAY, existing: existing as never, decide: t4('accept') as never,
      candidates: [{ title: 'Entretien chaudière', date: '2027-11-17', confidence: 'certain', excerpt: 'le 17/11/2027', originFieldKey: 'boilerServiceDueDate', documentType: 'RAPPORT_ENTRETIEN' }] as never,
    });
    expect(d).toMatchObject({ action: 'arbitrate_duplicate', reasonCode: 'FORECAST_USER_MODIFIED_DIVERGENCE', existingItemId: 11 });
  });

  it('T4-RES-03 — plan de synchronisation : prévision confirmée par l’utilisateur ni mise à jour ni retirée', () => {
    const p = plan([item({ id: 1, functionalKey: cle('2027-03-01'), confirmationMode: 'USER' }), item({ id: 2, title: 'Beta', startDate: '2027-05-01', functionalKey: cle('2027-05-01'), manualStatus: 'realise' })],
      [{ action: 'create', title: 'Alpha' }]);
    expect(p.steps).toMatchObject([{ kind: 'protected', itemId: 1 }]);
    expect(p.remove).toEqual([]);
  });
});

describe('§B — rapprochement fiable des échéances historiques', () => {
  it('T4-RES-05 — sans clé ni champ d’origine : null = null ne prouve rien ; date ET intitulé exigés', () => {
    const items = [item({ id: 1, title: 'Ramonage cheminée' }), item({ id: 2, title: 'Révision chaudière gaz' })];
    // Rejet de la révision : seule la révision est ciblée.
    expect(plan(items, [{ action: 'ignore', title: 'Révision chaudière gaz', t4Outcome: 'reject' }]).targetedRemove).toEqual([2]);
    // Nouvelle échéance de même date : création, aucune adoption d'un ancien.
    const p = plan(items, [{ action: 'create', title: 'Vidange fosse septique' }]);
    expect(p.steps).toMatchObject([{ kind: 'create' }]);
    // Intitulé identique : adoption (clé posée), même identifiant.
    expect(plan(items, [{ action: 'create', title: 'Ramonage  CHEMINÉE' }]).steps).toMatchObject([{ kind: 'update', itemId: 1, adopted: true }]);
    // Champ d'origine renseigné : critère inchangé (même champ, occurrence unique).
    const f = plan([item({ id: 5, title: 'Fin contrat', originFieldKey: 'contractEndDate' })], [{ action: 'create', title: 'Échéance du contrat', originFieldKey: 'contractEndDate', date: '2027-04-01' }]);
    expect(f.steps).toMatchObject([{ kind: 'update', itemId: 5, adopted: true }]);
  });

  it('T4-RES-06 — plusieurs correspondances : aucun retrait arbitraire, ambiguïté signalée, éléments conservés', () => {
    // Doublons indiscernables sans clé.
    const p = plan([item({ id: 1 }), item({ id: 2 })], [{ action: 'ignore', title: 'Alpha', t4Outcome: 'reject' }]);
    expect(p.targetedRemove).toEqual([]);
    expect(p.ambiguous).toEqual([{ index: 0, itemIds: [1, 2] }]);
    expect(p.remove).toEqual([]);
    // Famille de clés `k` / `k#2` : le rang ne désigne pas l'événement — l'intitulé départage.
    const fam = [item({ id: 1, title: 'Ramonage', functionalKey: cle('2027-03-01') }), item({ id: 2, title: 'Révision', functionalKey: cle('2027-03-01', 2) })];
    expect(plan(fam, [{ action: 'ignore', title: 'Révision', t4Outcome: 'reject' }]).targetedRemove).toEqual([2]);
    expect(plan(fam, [{ action: 'ignore', title: 'Autre', t4Outcome: 'reject' }]).targetedRemove).toEqual([]);
    // Ordre inversé à la réanalyse : chacun garde son identifiant ET sa clé (aucune collision).
    const inv = plan(fam, [{ action: 'create', title: 'Révision' }, { action: 'create', title: 'Ramonage' }]);
    expect(inv.steps).toMatchObject([
      { kind: 'update', itemId: 2, key: cle('2027-03-01', 2) },
      { kind: 'update', itemId: 1, key: cle('2027-03-01') },
    ]);
    // Nouvelle échéance dans une famille ambiguë : création sous une clé LIBRE (jamais celle d'un autre élément).
    const neu = plan(fam, [{ action: 'create', title: 'Taxe' }, { action: 'create', title: 'Ramonage' }]);
    expect(neu.steps[0]).toMatchObject({ kind: 'create', key: cle('2027-03-01', 3) });
    expect(neu.steps[1]).toMatchObject({ kind: 'update', itemId: 1 });
    expect(neu.remove).toEqual([2]);
    // Abstention dans une famille ambiguë : tous les éléments plausibles conservés.
    expect(plan(fam, [{ action: 'ignore', title: 'Autre', t4Outcome: 'abstain' }]).keep).toEqual(expect.arrayContaining([1, 2]));
  });

  it('T4-RES-07 — reclassement fiable : même identifiant, aucun retrait ni recréation (non-régression T4-FIX-07)', () => {
    const ancienne = computeAgendaFunctionalKey({ sourceFileId: 40, target: { type: 'ASSET', id: 3 }, businessType: 'insurance', originFieldKey: null, occurrence: '2027-03-01' });
    const p = plan([item({ id: 7, functionalKey: ancienne, title: 'Échéance Alpha' })], [{ action: 'create', title: 'Echeance alpha', businessType: 'warranty' }]);
    expect(p.steps).toMatchObject([{ kind: 'update', itemId: 7, adopted: true }]);
    expect(p.remove).toEqual([]);
  });
});

describe('§C — date non tranchée', () => {
  it('T4-RES-08/09 — TEMPORAL_AMBIGUITY : éléments concernés conservés (toute date), indécision comptée ; décisions fiables planifiées', () => {
    const p = plan([
      item({ id: 1, title: 'Échéance Alpha', startDate: '2027-03-04', functionalKey: cle('2027-03-04') }),
      item({ id: 2, title: 'Échéance Bêta', startDate: '2027-05-01', functionalKey: cle('2027-05-01') }),
    ], [
      { action: 'propose', title: 'Échéance Alpha', date: '2027-04-03', temporalAmbiguity: true },
      { action: 'create', title: 'Échéance Delta', date: '2027-06-01' },
    ]);
    expect(p.temporalAmbiguities).toBe(1);
    expect(p.keep).toContain(1);
    expect(p.remove).toEqual([2]); // retrait GLOBAL — suspendu par la persistance (TEMPORAL_AMBIGUITY)
    expect(p.steps).toMatchObject([{ kind: 'create', index: 0 }, { kind: 'create', index: 1 }]);
  });
});

describe('§D — échecs de retrait remontés à la file', () => {
  const job = (payload: Record<string, unknown>) => ({
    id: 90, treatment: 'T4', accountId: 5, targetType: 'asset_file', targetId: '40', status: 'RUNNING', origin: 'automatic',
    triggerCode: 'source_analyzed', attempts: 1, lastError: null, availableAt: new Date(), coalesceRequested: false,
    headPriority: false, createdAt: new Date(), startedAt: new Date(), finishedAt: null, payload, executionId: 'e-9',
    workerId: null, leaseExpiresAt: null, recoveredCount: 0, configVersionId: null,
  }) as never;
  const bilan = (o: Record<string, unknown>) => ({
    writeFailures: 0, undetermined: 0, removal: 'GLOBAL' as const, removed: [], corrected: 0, removalOutcome: 'NOTHING_TO_REMOVE' as const,
    removalFailure: null, blockedBy: [], preserved: [], temporalAmbiguities: 0, ambiguousMatches: 0, ...o,
  });

  it('T4-RES-11 — retrait en échec : T4_SYNC_FAILED (erreur ordinaire, reprise), motif précis, décisions conservées pour la reprise', async () => {
    const savePayload = vi.fn(async () => true);
    const err = await runT4Job(job({ assetId: 3, userId: 1, leadSourceId: 40, analysisComplete: true, candidates: [{ title: 'Alpha', date: '2027-03-01', confidence: 'certain', excerpt: 'x', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true }] }), NO_GUARD, {
      loadExisting: async () => [], savePayload,
      persist: async () => bilan({ removalOutcome: 'FAILED', removalFailure: { code: 'REMOVAL_FAILED', message: 'deadlock detected' } }),
      process: (i) => processAgendaCandidates({ ...i, today: TODAY, decide: t4('accept') as never }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(T4IncompleteJobError);
    expect(err.code).toBe('T4_SYNC_FAILED');
    expect(err.message).toMatch(/REMOVAL_FAILED : deadlock detected/);
    const [[, , patch]] = savePayload.mock.calls as unknown as [[number, string, { t4Resolved: { decisions: Record<string, unknown> }; t4Retry: Record<string, unknown> }]];
    expect(Object.keys(patch.t4Resolved.decisions)).toHaveLength(1);
    expect(patch.t4Retry).toMatchObject({ syncFailure: 'REMOVAL_FAILED : deadlock detected' });
  });

  it('T4-RES-12 — réanalyse vide : retrait impossible → travail NON réussi ; réussite → résultat métier exposé', async () => {
    const vide = { assetId: 3, userId: 1, leadSourceId: 40, analysisComplete: true, candidates: [] };
    const deps = (b: ReturnType<typeof bilan>) => ({ loadExisting: async () => [], savePayload: async () => true, persist: async () => b, process: processAgendaCandidates });
    const err = await runT4Job(job(vide), NO_GUARD, deps(bilan({ removalOutcome: 'FAILED', removalFailure: { code: 'TRACE_UNAVAILABLE', message: 'journal indisponible' } }))).catch((e) => e);
    expect(err).toBeInstanceOf(T4IncompleteJobError);
    expect(err.message).toMatch(/T4_SYNC_FAILED.*TRACE_UNAVAILABLE/);
    expect(await runT4Job(job(vide), NO_GUARD, deps(bilan({ removalOutcome: 'REMOVED', removed: [4] })))).toMatchObject({ result: 'APPLIED', detail: { removalOutcome: 'REMOVED', removed: 1 } });
    expect(await runT4Job(job(vide), NO_GUARD, deps(bilan({})))).toMatchObject({ result: 'NO_CHANGE' });
    // Suspension volontaire (BLOCKED), simulation (DRY_RUN) : jamais un échec.
    expect(t4SyncFailure(bilan({ removalOutcome: 'BLOCKED', blockedBy: ['TEMPORAL_AMBIGUITY'] }))).toBeNull();
    expect(t4SyncFailure(bilan({ removalOutcome: 'DRY_RUN' }))).toBeNull();
    expect(t4SyncFailure(undefined)).toBeNull();
  });
});
