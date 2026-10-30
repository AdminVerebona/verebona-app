/**
 * Lot 100B — harnais des scénarios de STRESS (E2E_MÉTIER, ticket #601) sur
 * PostgreSQL réel, avec DONNÉES PERSISTÉES. En attendant les 15
 * spécifications du ZIP, un scénario GÉNÉRIQUE montre l'usage du harnais
 * (`certification/stress.ts`) de bout en bout :
 *
 *   L100B-S01  « une preuve de réalisation N-1 ne clôture pas l'occurrence N »
 *              (recette bloquante 5) : échéance d'entretien persistée, rapport
 *              d'entretien de l'année précédente analysé (faits persistés) puis
 *              réconciliation locale du bien (production) → l'occurrence N
 *              reste ouverte, aucune carte, aucun lien de preuve ;
 *   L100B-S02  témoin positif (même chaîne, preuve de l'année N) → « réalisé »,
 *              preuve liée — le scénario S01 n'est donc pas vert par vacuité ;
 *   L100B-S03  le rapport attribue un défaut de la chaîne serveur à la couche
 *              SERVEUR, jamais à une réponse IA.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import type { AgendaDecision } from '@/services/ai/agenda';
import type { StressScenario } from '@/services/ai/governance/master-corpus/certification/stress';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {} }));

const trace = { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'] };
const fait = (assetId: number, value: string): ProjectedFact => ({
  canonicalKey: 'lastRevision', rawKey: 'Date d’intervention', label: null, subject: null, attribute: null,
  rawValue: value, value, valueType: 'date', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: `Entretien effectué le ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
});
const echeance = (fileId: number, date: string): AgendaDecision => ({
  action: 'create', title: 'Entretien annuel', date, category: 'action', confidence: 'certain', reasonCode: 'E2E', deterministic: true, sourceFileId: fileId, originFieldKey: 'maintenanceDueDate',
});

type Ctx = { sql: import('postgres').Sql; make: import('../factories').Factories; data: Record<string, number> };

scenario('L100B-STRESS', 'Harnais E2E_MÉTIER : preuve N-1 et occurrence N (données persistées)', ({ sql, make }) => {
  let persist: typeof import('@/services/agenda/agenda-persistence').persistAgendaDecisions;
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let harnais: typeof import('@/services/ai/governance/master-corpus/certification/stress');
  beforeAll(async () => {
    ({ persistAgendaDecisions: persist } = await import('@/services/agenda/agenda-persistence'));
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    harnais = await import('@/services/ai/governance/master-corpus/certification/stress');
  });

  /** Scénario générique paramétré : échéance de l'année N, preuve datée `preuve`. */
  const preuveEtOccurrence = (id: string, preuve: string, attendu: 'ouverte' | 'realise'): StressScenario<Ctx> => ({
    id, title: attendu === 'ouverte' ? 'une preuve N-1 ne clôture pas l’occurrence N' : 'témoin : une preuve N clôture l’occurrence N',
    async setup(ctx) {
      const compte = await ctx.make.account();
      const bien = await ctx.make.asset(compte, { category: 'VEHICULE' });
      const docA = await ctx.make.assetFile(compte, { assetId: bien.id });
      await persist([echeance(docA.id, '2027-03-10')], compte.id, bien.id);
      const [{ id: itemId }] = await ctx.sql<{ id: number }[]>`SELECT i.id FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id WHERE l.asset_id = ${bien.id}`;
      const docB = await ctx.make.assetFile(compte, { assetId: bien.id });
      Object.assign(ctx.data, { accountId: compte.id, ownerId: compte.ownerUserId, assetId: bien.id, itemId, docB: docB.id });
    },
    steps: [
      {
        label: 'rapport d’entretien analysé : faits persistés (T1)',
        async run(ctx) {
          await persistProjectedFacts({
            input: { sourceType: 'file', sourceIds: [ctx.data.docB], accountId: ctx.data.accountId, userId: ctx.data.ownerId, mimeTypes: [], displayNames: [] },
            leadSourceId: ctx.data.docB, trace, analysisRunId: 1, documentType: 'RAPPORT_ENTRETIEN', documentDate: preuve, facts: [fait(ctx.data.assetId, preuve)],
          });
        },
      },
      {
        label: 'réconciliation locale du bien (production : statut des échéances, cartes)',
        async run(ctx) { await reconcileAsset({ accountId: ctx.data.accountId, userId: ctx.data.ownerId, assetId: ctx.data.assetId, triggeredBy: 'document_analyzed', sourceFileId: ctx.data.docB }); },
      },
    ],
    assertions: [
      {
        label: attendu === 'ouverte' ? 'occurrence 2027 toujours ouverte' : 'occurrence 2027 réalisée', layer: 'DONNEES',
        async check(ctx) {
          const [r] = await ctx.sql<{ s: string | null }[]>`SELECT manual_status AS s FROM agenda_items WHERE id = ${ctx.data.itemId}`;
          const ok = attendu === 'ouverte' ? r.s === null : r.s === 'realise';
          return ok ? null : `statut persisté « ${r.s ?? 'aucun'} »`;
        },
      },
      {
        label: attendu === 'ouverte' ? 'aucun lien de preuve ni carte « À traiter »' : 'preuve liée à l’occurrence', layer: 'DONNEES',
        async check(ctx) {
          const liens = await ctx.sql`SELECT 1 FROM agenda_file_links WHERE agenda_item_id = ${ctx.data.itemId} AND asset_file_id = ${ctx.data.docB}`;
          const cartes = await ctx.sql`SELECT 1 FROM to_process_actions WHERE account_id = ${ctx.data.accountId} AND target_type = 'AGENDA_ITEM' AND target_id = ${ctx.data.itemId} AND resolved_at IS NULL`;
          if (attendu === 'ouverte') return liens.length || cartes.length ? `${liens.length} lien(s), ${cartes.length} carte(s)` : null;
          return liens.length ? null : 'preuve non liée';
        },
      },
    ],
  });

  it('L100B-S01 — preuve N-1 : l’occurrence N n’est pas clôturée (données persistées)', async () => {
    const r = await harnais.runStressScenario(preuveEtOccurrence('S-GEN-01', '2026-03-08', 'ouverte'), { sql, make, data: {} });
    expect(r.passed, harnais.stressReportText(r)).toBe(true);
  });

  it('L100B-S02 — témoin : une preuve de l’année N clôture N (S01 n’est pas vert par vacuité)', async () => {
    const r = await harnais.runStressScenario(preuveEtOccurrence('S-GEN-02', '2027-03-08', 'realise'), { sql, make, data: {} });
    expect(r.passed, harnais.stressReportText(r)).toBe(true);
  });

  it('L100B-S03 — défaut de chaîne serveur : attribué à la couche SERVEUR, scénario en échec, assertions non évaluées', async () => {
    const s = preuveEtOccurrence('S-GEN-03', '2026-03-08', 'ouverte');
    s.steps.splice(1, 0, { label: 'étape serveur défaillante (injectée)', run: async () => { throw new Error('violation de contrainte simulée'); } });
    const r = await harnais.runStressScenario(s, { sql, make, data: {} });
    expect(r.passed).toBe(false);
    expect(r.steps.find((x) => !x.ok)?.layer).toBe('SERVEUR');
    expect(r.assertions.every((a) => !a.ok && a.detail === 'non évaluée : scénario interrompu')).toBe(true);
  });
});
