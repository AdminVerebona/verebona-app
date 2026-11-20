/**
 * Carte #811 (P1-A) — registre de mesure de l'activité IA : terminologie unique,
 * aucun double compte, mesure ou demandes déclarées (jamais un mélange).
 */
import { describe, expect, it } from 'vitest';
import {
  aiCostNatureOf, compactAiActivity, measureAiActivity, noteAiDecisionReuse, noteAiUsageEvent, openAiActivity,
  publishedAiCounters, trackAiLogicalRequest, withAiActivityPhase, aiActivityActive, type AiUsageEventFact,
} from '../ai-activity';
import { jobAiText } from '@/app/admin/ai-queue/_components/T3Supervision';
import { runAiLine } from '@/app/admin/ai-queue/_components/T3OpenActionsDiagnostic';
import { measuredCallsByOperation, runAiCounters } from '@/services/ai/queue/t3-open-actions-diagnostic';
import { withJobAiActivity } from '@/services/ai/reconciliation/t3-queue';
import { declaredAiRequests } from '@/services/ai/reconciliation/account-reconciliation.service';

const ev = (over: Partial<AiUsageEventFact> = {}): AiUsageEventFact => ({
  traceId: 't1', operationCode: 't3_value_conflict', treatment: 'T3', model: 'm-principal', rank: 'primary', callKind: 'analysis',
  status: 'success', networkRequests: 1, inputTokens: 100, outputTokens: 10, costMicros: 42, costNature: 'OBSERVED', ...over,
});
const T3 = { operationCode: 't3_value_conflict', treatment: 'T3' };

describe('C811-U01 — une demande logique n’est pas un appel', () => {
  it('hors mesure : aucun effet, la fonction est simplement appelée', async () => {
    expect(aiActivityActive()).toBe(false);
    noteAiUsageEvent(ev());
    expect(await trackAiLogicalRequest(T3, async () => 7)).toBe(7);
  });
  it('appel réussi, cache, partage, échec sans contact, échec après envoi', async () => {
    const { activity: a } = await measureAiActivity(async () => {
      await trackAiLogicalRequest(T3, async () => { noteAiUsageEvent(ev()); return { fromCache: false }; });
      await trackAiLogicalRequest(T3, async () => ({ fromCache: true, cacheOutcome: 'CACHE_HIT' }));
      await trackAiLogicalRequest(T3, async () => ({ fromCache: true, cacheOutcome: 'SHARED' }));
      await trackAiLogicalRequest(T3, async () => { throw new Error('AI_BLOCKED'); }).catch(() => undefined);
      await trackAiLogicalRequest(T3, async () => {
        noteAiUsageEvent(ev({ traceId: 't2', status: 'error', inputTokens: 0, outputTokens: 0, costMicros: 0, costNature: 'UNKNOWN' }));
        throw new Error('TIMEOUT');
      }).catch(() => undefined);
      // Refus avant appel tracé : un événement d'usage, aucune requête.
      await trackAiLogicalRequest(T3, async () => {
        noteAiUsageEvent(ev({ traceId: 't3', status: 'error', networkRequests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, costNature: 'NONE' }));
        throw new Error('RUNTIME_CONTRACT_MISMATCH');
      }).catch(() => undefined);
    });
    expect(a.total).toMatchObject({
      logicalRequests: 6, cacheResponses: 1, sharedResponses: 1, requestsWithoutContact: 2, usageEvents: 3, usageEventsWithoutSend: 1,
      providerAttempts: 2, networkRequests: 2, costObservedMicros: 42, costUnknownEvents: 1,
    });
    expect(a.traceIds.sort()).toEqual(['t1', 't2', 't3']);
  });
  it('repli, essai sans schéma et réparation : tentatives et requêtes distinguées, par modèle et par rang', async () => {
    const { activity: a } = await measureAiActivity(() => trackAiLogicalRequest(T3, async () => {
      noteAiUsageEvent(ev({ status: 'error', networkRequests: 2, costNature: 'OBSERVED', costMicros: 0, inputTokens: 0, outputTokens: 0 }));
      noteAiUsageEvent(ev({ model: 'm-secours', rank: 'fallback_1' }));
      noteAiUsageEvent(ev({ model: 'm-secours', rank: 'fallback_1', callKind: 'repair', costMicros: 5 }));
      return { fromCache: false };
    }));
    expect(a.total).toMatchObject({ logicalRequests: 1, providerAttempts: 2, repairAttempts: 1, networkRequests: 4, usageEvents: 3, costObservedMicros: 47 });
    expect(a.byModelRank).toEqual([
      { model: 'm-principal', rank: 'primary', attempts: 1, networkRequests: 2, succeeded: 0, failed: 1 },
      { model: 'm-secours', rank: 'fallback_1', attempts: 2, networkRequests: 2, succeeded: 2, failed: 0 },
    ]);
  });
});

describe('C811-U02 — sous-phases, autre traitement, registres emboîtés : jamais deux fois', () => {
  it('T4 déclenché pendant T3 est compté à part ; chaque axe redonne le total ; le registre englobant voit tout une fois', async () => {
    const job = openAiActivity();
    let compte: ReturnType<typeof openAiActivity> | null = null;
    await job.run(async () => {
      compte = openAiActivity();
      await compte.run(async () => {
        await withAiActivityPhase('ASSETS', () => trackAiLogicalRequest(T3, async () => { noteAiUsageEvent(ev()); return {}; }));
        await withAiActivityPhase('OPEN_ACTIONS', async () => {
          await trackAiLogicalRequest({ operationCode: 't4_classify_event', treatment: 'T4' }, async () => {
            noteAiUsageEvent(ev({ traceId: 't4', operationCode: 't4_classify_event', treatment: 'T4' })); return {};
          });
          noteAiDecisionReuse({ kind: 'DECISION_REUSED', operationCode: 't3_link_ambiguity', treatment: 'T3' });
          noteAiDecisionReuse({ kind: 'USER_ARBITRATION_KEPT', operationCode: 't3_value_conflict', treatment: 'T3' });
        });
      });
      // Hors du passage du compte, dans le même travail.
      await trackAiLogicalRequest(T3, async () => { noteAiUsageEvent(ev({ traceId: 't9' })); return {}; });
    });
    const c = compte!.snapshot();
    const j = job.snapshot();
    expect(c.total).toMatchObject({ logicalRequests: 2, networkRequests: 2, decisionsReused: 1, userArbitrationsKept: 1 });
    expect(c.byTreatment.T3.networkRequests).toBe(1);
    expect(c.byTreatment.T4.networkRequests).toBe(1);
    expect(c.byPhase.ASSETS.networkRequests).toBe(1);
    expect(c.byPhase.OPEN_ACTIONS).toMatchObject({ networkRequests: 1, decisionsReused: 1 });
    for (const axe of [c.byTreatment, c.byOperation, c.byPhase]) expect(Object.values(axe).reduce((n, x) => n + x.networkRequests, 0)).toBe(2);
    expect(j.total).toMatchObject({ logicalRequests: 3, networkRequests: 3 });
    expect(publishedAiCounters(c, 2, 'T3')).toMatchObject({ semantics: 'MEASURED_V1', providerCalls: 2, providerCallsOtherTreatments: 1, logicalRequests: 2, declaredRequests: 2 });
  });
  it('un registre garde son relevé même si l’exécution lève', async () => {
    const m = openAiActivity();
    await m.run(async () => { await trackAiLogicalRequest(T3, async () => { noteAiUsageEvent(ev()); return {}; }); throw new Error('interrompu'); }).catch(() => undefined);
    expect(m.snapshot().total.networkRequests).toBe(1);
  });
});

describe('C811-U03 — mesure ou demandes déclarées, jamais un mélange ; zéro n’est pas « inconnu »', () => {
  it('passerelle observée → mesure ; rien de déclaré → mesure à zéro ; déclaré sans passerelle → DECLARED', async () => {
    const vide = (await measureAiActivity(async () => undefined)).activity;
    expect(publishedAiCounters(vide, 0, 'T3')).toMatchObject({ semantics: 'MEASURED_V1', providerCalls: 0 });
    expect(publishedAiCounters(vide, 3, 'T3')).toMatchObject({ semantics: 'DECLARED', providerCalls: 3, declaredRequests: 3 });
    expect(publishedAiCounters(null, 2, 'T3')).toMatchObject({ semantics: 'DECLARED', providerCalls: 2 });
    // Trois demandes déclarées, toutes servies sans appel : la mesure dit 0 requête.
    const cache = (await measureAiActivity(async () => { for (let i = 0; i < 3; i++) await trackAiLogicalRequest(T3, async () => ({ fromCache: true })); })).activity;
    expect(publishedAiCounters(cache, 3, 'T3')).toMatchObject({ semantics: 'MEASURED_V1', providerCalls: 0, logicalRequests: 3, cacheResponses: 3, declaredRequests: 3 });
  });
  it('nature du coût : nul certain, observé, estimé, inconnu', () => {
    const b = { status: 'success' as const, inputTokens: 10, outputTokens: 2, pricingStatus: 'applied', failureFamily: null, priceConfirmed: true };
    expect(aiCostNatureOf({ ...b, networkRequests: 0 })).toBe('NONE');
    expect(aiCostNatureOf({ ...b, networkRequests: 1 })).toBe('OBSERVED');
    expect(aiCostNatureOf({ ...b, networkRequests: 1, pricingStatus: 'zero_or_rounded' })).toBe('OBSERVED');
    expect(aiCostNatureOf({ ...b, networkRequests: 1, priceConfirmed: false })).toBe('ESTIMATED');
    expect(aiCostNatureOf({ ...b, networkRequests: 1, pricingStatus: 'missing' })).toBe('UNKNOWN');
    expect(aiCostNatureOf({ ...b, networkRequests: 1, inputTokens: 0, outputTokens: 0, pricingStatus: 'insufficient_usage' })).toBe('UNKNOWN');
    const echec = { ...b, status: 'error' as const, networkRequests: 1, inputTokens: 0, outputTokens: 0, pricingStatus: 'zero_or_rounded' };
    expect(aiCostNatureOf({ ...echec, failureFamily: 'TIMEOUT' })).toBe('UNKNOWN');
    expect(aiCostNatureOf({ ...echec, failureFamily: 'NETWORK_ERROR' })).toBe('UNKNOWN');
    expect(aiCostNatureOf({ ...echec, failureFamily: null })).toBe('UNKNOWN');
    expect(aiCostNatureOf({ ...echec, failureFamily: 'RATE_LIMIT' })).toBe('OBSERVED');
  });
  it('demandes déclarées par les phases (ancienne somme) : pure', () => {
    const d = (over: Record<string, unknown>) => ({ objectType: 'asset' as const, objectId: 1, status: 'SUCCESS' as const, applied: 0, conflicts: 0, aiReviews: 2, ...over });
    expect(declaredAiRequests([d({}), d({ providerCalls: 3 }), d({ providerCalls: 3, declaredRequests: 1 })], { aiCalls: 4 }, { aiCalls: 5 })).toBe(2 + 3 + 1 + 4 + 5);
    expect(declaredAiRequests([], null, undefined)).toBe(0);
  });
});

describe('C811-U04 — File IA, diagnostic et supervision annoncent la mesure (ou disent « ancienne sémantique »)', () => {
  it('détail du travail : relevé ajouté seulement s’il y a eu de l’activité ; un compteur publié n’est jamais écrasé', async () => {
    const vide = (await measureAiActivity(async () => undefined)).activity;
    const r0 = { result: 'NO_CHANGE' as const, detail: { enqueued: 0 } };
    expect(withJobAiActivity(r0, vide)).toBe(r0);
    const a = (await measureAiActivity(() => trackAiLogicalRequest(T3, async () => { noteAiUsageEvent(ev({ networkRequests: 2 })); return {}; }))).activity;
    expect(withJobAiActivity({ result: 'APPLIED', detail: { fileId: 9 } }, a).detail).toMatchObject({
      fileId: 9, aiCalls: 2, aiCountersSemantics: 'MEASURED_V1', aiLogicalRequests: 1, aiProviderAttempts: 1, withoutAiCall: false,
      aiActivity: { semantics: 'ai-activity-v1' },
    });
    expect(withJobAiActivity({ result: 'APPLIED', detail: { aiCalls: 7 } }, a).detail).toMatchObject({ aiCalls: 7 });
    expect(compactAiActivity(a)).toHaveProperty('byModelRank');
  });
  it('textes du BO', () => {
    expect(jobAiText({ aiCalls: 3, aiCountersSemantics: 'MEASURED_V1', aiLogicalRequests: 2, aiProviderAttempts: 3, aiCallsOtherTreatments: 1 }))
      .toBe(' · 3 requête(s) réellement émise(s) vers le modèle en 3 tentative(s) pour 2 demande(s) logique(s) dont 1 pour un autre traitement que T3');
    expect(jobAiText({ aiCalls: 0, aiCountersSemantics: 'MEASURED_V1', aiLogicalRequests: 0, aiProviderAttempts: 0, aiCallsOtherTreatments: 0 })).toBe(' · aucune requête émise vers le modèle');
    expect(jobAiText({ aiCalls: 4, aiCountersSemantics: null })).toContain('4 demande(s) IA déclarée(s) (ancienne sémantique');
    expect(jobAiText({ aiCalls: 4, aiCountersSemantics: null })).not.toContain('appel(s) au modèle');
    expect(runAiLine({ ai: null })).toContain('ancienne sémantique');
  });
  it('ligne d’un passage : mesure lue telle quelle ; passage antérieur → null (jamais recalculé)', () => {
    expect(runAiCounters({ provider_calls: 7 })).toBeNull();
    expect(measuredCallsByOperation({ provider_calls: 7 })).toBeNull();
    const ligne = {
      ai_counters_semantics: 'MEASURED_V1', provider_calls: 3, provider_calls_other_treatments: 1, provider_attempts: 3, ai_logical_requests: 2,
      ai_requests_declared: 2, ai_cache_hits: 0, decisions_reused: 4,
      ai_activity: { total: { usageEvents: 4, usageEventsWithoutSend: 1, costObservedMicros: 1200, costEstimatedMicros: 0, costUnknownEvents: 1 },
        byOperation: { t3_value_conflict: { networkRequests: 2 }, t4_classify_event: { networkRequests: 1 }, t3_document_naming: { networkRequests: 0 } } },
    };
    expect(measuredCallsByOperation(ligne)).toEqual({ t3_value_conflict: 2, t4_classify_event: 1 });
    const ai = runAiCounters(ligne)!;
    expect(ai).toMatchObject({ providerCalls: 3, logicalRequests: 2, declaredRequests: 2, usageEvents: 4, costUnknownEvents: 1 });
    const texte = runAiLine({ ai, aiCallsBasis: 'MEASURED' });
    expect(texte).toContain('2 demande(s) logique(s) · 3 requête(s) réellement émise(s) en 3 tentative(s) dont 1 pour un autre traitement que T3');
    expect(texte).toContain('4 événement(s) d’usage dont 1 sans requête émise');
    expect(texte).toContain('1 événement(s) au coût inconnu');
  });
});
