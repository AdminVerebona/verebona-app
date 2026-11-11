/**
 * Lot 113AJ — Trello #735 « [P1][Pré-MEP] Cohérence — Ne plus déclarer
 * « réparé » sans modification réelle (alerte #89) » : parties testables sans
 * base. Cycle complet sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l113aj-coherence-reparations.e2e.ts`.
 *
 *  L113AJ-U-01  qualification PURE des reprises de propriétés manquantes : REPAIRED seulement avec une écriture ; abstention,
 *               absence de changement, échec technique / IA (panne, disjoncteur, budget, contrat), inefficace ; autres contrôles inchangés
 *  L113AJ-U-02  moteur : journal et preuve d'après la qualification du contrôle (40 abstentions → 0 réparation) ; base non migrée → jamais REPAIRED
 *  L113AJ-U-03  Supervision : seules les vraies réparations comptent (historique requalifié à la lecture), champ réécrit et écrivain de l'effacement
 */
import { describe, expect, it, vi } from 'vitest';
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../registry/types';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const NOW = new Date('2026-11-10T10:00:00Z');
const rep = await import('../registry/checks/missing-properties-repairs');
const { recheckOutcome } = await import('../engine');

const reprise = (o: Partial<{ status: string; cause: string | null; written: string[]; abstained: number; undecided: number }>): RepairResult => ({
  called: true, service: 'recoverMissingProperties',
  result: {
    status: o.status ?? 'ANSWERED', cause: o.cause ?? null, written: o.written ?? [],
    abstained: Array.from({ length: o.abstained ?? 0 }, (_, i) => ({ key: `p${i}`, cause: 'NOT_FOUND' })),
    undecided: Array.from({ length: o.undecided ?? 0 }, (_, i) => `u${i}`),
  },
});
const AVANT: Inspection = { verdict: 'REPAIRABLE', anomaly: 'MISSING_PROPERTIES_UNEXAMINED', inputHash: 'h' };
const qualifier = (r: RepairResult | null, recheck: Inspection) =>
  rep.qualifyMissingPropertiesRepair({ repair: r, recheck, generic: recheckOutcome(AVANT, recheck) });

describe('L113AJ-U-01 — qualification réelle des reprises de propriétés manquantes', () => {
  it('40 abstentions, 0 écrit, recontrôle cohérent → ABSTAINED, preuve CONSISTENT (avant : REPAIRED)', () => {
    expect(recheckOutcome(AVANT, { verdict: 'CONSISTENT' })).toEqual({ journal: 'REPAIRED', result: 'REPAIRED' });
    expect(qualifier(reprise({ abstained: 40 }), { verdict: 'CONSISTENT' })).toEqual({ journal: 'ABSTAINED', result: 'CONSISTENT', error: null });
    // Abstentions ambiguës : constat d'arbitrage conservé, jamais « réparé ».
    expect(qualifier(reprise({ abstained: 3 }), { verdict: 'AMBIGUOUS', anomaly: 'MISSING_PROPERTY_ABSTENTION' }))
      .toEqual({ journal: 'ABSTAINED', result: 'AMBIGUOUS', error: null });
  });

  it('au moins une écriture effective → REPAIRED (même si une autre propriété reste en attente)', () => {
    expect(qualifier(reprise({ written: ['k1'], abstained: 39 }), { verdict: 'CONSISTENT' })).toEqual({ journal: 'REPAIRED', result: 'REPAIRED', error: null });
    expect(qualifier(reprise({ written: ['k1'], status: 'BUDGET_EXHAUSTED', undecided: 2 }), { ...AVANT, inputHash: 'h2' }))
      .toMatchObject({ journal: 'REPAIRED', result: 'FINDING' });
  });

  it('AI_FAILED (panne, disjoncteur) / budget / nouvelle tentative / contrat absent → FAILED explicite, jamais REPAIRED', () => {
    // 3e panne : le recontrôle porte une AUTRE anomalie (ARBITRATION_FAILED) — avant 113AJ, journal REPAIRED.
    const apresPanne: Inspection = { verdict: 'FINDING', anomaly: 'MISSING_PROPERTY_ARBITRATION_FAILED' };
    expect(recheckOutcome(AVANT, apresPanne).journal).toBe('REPAIRED');
    const q = qualifier(reprise({ status: 'AI_FAILED', cause: 'AI_CALL_FAILED: circuit ouvert', undecided: 40 }), apresPanne);
    expect(q).toMatchObject({ journal: 'FAILED', result: 'FINDING' });
    expect(q.error).toMatch(/^AI_FAILED: AI_CALL_FAILED: circuit ouvert — aucune propriété écrite$/);
    for (const status of ['BUDGET_EXHAUSTED', 'RETRY_SCHEDULED', 'CONTRACT_PENDING', 'MEMORY_UNAVAILABLE']) {
      expect(qualifier(reprise({ status, undecided: 5 }), AVANT), status).toMatchObject({ journal: 'FAILED', result: 'REPAIR_INEFFECTIVE' });
    }
  });

  it('analyse sans décision → INEFFECTIVE ; rien à changer / objet disparu → UNCHANGED (preuve CONSISTENT / GONE)', () => {
    expect(qualifier(reprise({ undecided: 2 }), AVANT)).toMatchObject({ journal: 'INEFFECTIVE', result: 'REPAIR_INEFFECTIVE' });
    expect(qualifier(reprise({ status: 'NOTHING_PENDING' }), { verdict: 'CONSISTENT' })).toMatchObject({ journal: 'UNCHANGED', result: 'CONSISTENT' });
    expect(qualifier(reprise({ status: 'GONE' }), { verdict: 'GONE' })).toMatchObject({ journal: 'UNCHANGED', result: 'GONE' });
    expect(qualifier(null, { verdict: 'CONSISTENT' })).toMatchObject({ journal: 'UNCHANGED', result: 'CONSISTENT' });
  });

  it('effet lu sur le résumé journalisé (effet, écritures et références d’abord, borné sous 4 000 caractères)', () => {
    const r = rep.repairJournalResult({
      status: 'ANSWERED', calls: 1, contextFingerprint: 'fp', runIds: [7],
      written: [{ key: 'k1', canonicalWriteId: 501, decisionId: 61, runId: 7 }],
      abstained: Array.from({ length: 40 }, (_, i) => ({ key: `propriete_longue_${i}`, cause: 'NOT_FOUND_IN_COMPLETE_CONTEXT' })),
      undecided: Array.from({ length: 40 }, (_, i) => `propriete_non_decidee_${i}`),
    });
    expect(Object.keys(r).slice(0, 3)).toEqual(['effect', 'written', 'writes']);
    expect(r).toMatchObject({ effect: 'WRITTEN', written: ['k1'], writes: [{ key: 'k1', canonicalWriteId: 501, decisionId: 61, runId: 7 }], counts: { written: 1, abstained: 40, undecided: 40 } });
    expect(JSON.stringify(r).length).toBeLessThan(4000);
    expect(rep.repairEffectOf(r)).toBe('WRITTEN');
  });

  it('déclaratif : seuls les deux contrôles de propriétés manquantes qualifient leurs réparations', async () => {
    const { COHERENCE_REGISTRY } = await import('../registry');
    const qualifiants = COHERENCE_REGISTRY.filter((c) => c.qualifyRepair || c.effectiveRepairSql || c.explainRepeatedRepairs).map((c) => c.id).sort();
    expect(qualifiants).toEqual(['COH-MISSING-PROPERTIES', 'COH-MISSING-PROPERTIES-EQUIPMENT']);
    // Sens générique inchangé pour les autres contrôles.
    expect(recheckOutcome({ verdict: 'REPAIRABLE', anomaly: 'A' }, { verdict: 'REPAIRABLE', anomaly: 'B' })).toEqual({ journal: 'REPAIRED', result: 'FINDING' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

/** SQL simulé : capture des écritures du moteur ; `contrainte` = définition lue de coherence_repairs_outcome_check. */
function sqlSimule(contrainte: string | null) {
  const appels: Array<{ q: string; p: unknown[] }> = [];
  const sql = {
    unsafe: vi.fn(async (q: string, p: unknown[] = []) => {
      appels.push({ q, p });
      if (q.includes('pg_get_constraintdef')) return contrainte === null ? [] : [{ d: contrainte }];
      return [];
    }),
  };
  return { sql: sql as never, appels };
}

async function controler(o: { check: Partial<CoherenceCheck>; repair: RepairResult; recheck: Inspection; contrainte?: string | null }) {
  vi.resetModules();
  const { controlObjects } = await import('../engine');
  const { sql, appels } = sqlSimule(o.contrainte === undefined ? "CHECK (outcome IN ('REPAIRED','ABSTAINED','UNCHANGED'))" : o.contrainte);
  let n = 0;
  const check = {
    id: 'COH-TEST-113AJ', version: 1, objectType: 'asset', services: ['svc'], ...o.check,
    inspect: async (_c: CheckContext, _a: number, ids: readonly number[]) => new Map(ids.map((id) => [id, n++ === 0 ? AVANT : o.recheck])),
    repair: vi.fn(async () => new Map([[1, o.repair]])),
  } as unknown as CoherenceCheck;
  const s = await controlObjects({
    ctx: { sql, now: NOW, today: '2026-11-10', mode: 'CORRECTIVE', correlationId: 'coherence:manual-1:COH-TEST-113AJ' },
    check, accountId: 10, ids: [1], trigger: 'MANUAL', campaignId: 1, stillEligible: async () => ({ eligible: true, reason: 'ELIGIBLE' }),
  });
  const journal = appels.find((a) => a.q.includes('INSERT INTO coherence_repairs'))!;
  const preuve = appels.find((a) => a.q.includes('UPDATE coherence_object_proofs p'))!;
  return { s, outcome: journal.p[13], error: journal.p[16], result: JSON.parse(String(journal.p[12])), proof: preuve.p[7] };
}

describe('L113AJ-U-02 — moteur : journal et preuve suivent la qualification du contrôle', () => {
  const mp = { qualifyRepair: rep.qualifyMissingPropertiesRepair };

  it('40 abstentions, 0 écrit : journal ABSTAINED, preuve CONSISTENT, 0 réparation au bilan', async () => {
    const r = await controler({ check: mp, repair: reprise({ abstained: 40 }), recheck: { verdict: 'CONSISTENT' } });
    expect(r).toMatchObject({ outcome: 'ABSTAINED', proof: 'CONSISTENT', error: null });
    expect(r.s.results).toEqual({ CONSISTENT: 1 });
  });

  it('AI_FAILED : journal FAILED avec la cause, preuve = constat restant (jamais REPAIRED)', async () => {
    const r = await controler({ check: mp, repair: reprise({ status: 'AI_FAILED', cause: 'MAX_ATTEMPTS_REACHED', undecided: 3 }), recheck: { verdict: 'FINDING', anomaly: 'MISSING_PROPERTY_ARBITRATION_FAILED' } });
    expect(r).toMatchObject({ outcome: 'FAILED', proof: 'FINDING' });
    expect(String(r.error)).toMatch(/AI_FAILED: MAX_ATTEMPTS_REACHED/);
  });

  it('écriture effective : REPAIRED ; contrôle sans qualification : sens générique inchangé', async () => {
    expect(await controler({ check: mp, repair: reprise({ written: ['k1'] }), recheck: { verdict: 'CONSISTENT' } })).toMatchObject({ outcome: 'REPAIRED', proof: 'REPAIRED' });
    expect(await controler({ check: {}, repair: reprise({ abstained: 40 }), recheck: { verdict: 'CONSISTENT' } })).toMatchObject({ outcome: 'REPAIRED', proof: 'REPAIRED' });
  });

  it('base sans la migration 1635 : ABSTAINED retombe sur INEFFECTIVE (jamais REPAIRED), effet lisible dans le résultat', async () => {
    const r = await controler({
      check: mp, repair: { ...reprise({ abstained: 2 }), result: { effect: 'ABSTAINED', ...reprise({ abstained: 2 }).result } },
      recheck: { verdict: 'CONSISTENT' }, contrainte: "CHECK (outcome IN ('REPAIRED','INEFFECTIVE','FAILED','PENDING'))",
    });
    expect(r).toMatchObject({ outcome: 'INEFFECTIVE', proof: 'CONSISTENT', result: { effect: 'ABSTAINED' } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L113AJ-U-03 — Supervision : vraies réparations seulement, champ réécrit et origine de l’effacement', () => {
  it('prédicat de requalification : `result.written` non vide (résultat borné compris)', () => {
    const p = rep.effectiveMissingPropertiesRepairSql('r');
    expect(p).toMatch(/r\.outcome = 'REPAIRED'/);
    expect(p).toMatch(/jsonb_array_length\(r\.result -> 'written'\) > 0/);
    expect(p).toMatch(/"written":\["/);
  });

  it('décompte : prédicat des contrôles qualifiants dans la requête, autres contrôles inchangés ; détail de l’explication', async () => {
    vi.resetModules();
    const { repeatedRepairAlerts } = await import('../supervision');
    const requetes: Array<{ q: string; p: unknown[] }> = [];
    const sql = {
      unsafe: vi.fn(async (q: string, p: unknown[] = []) => {
        requetes.push({ q, p });
        if (q.includes('GROUP BY r.check_id, r.account_id, r.object_id')) {
          return [
            { check_id: 'COH-MISSING-PROPERTIES', account_id: 10, object_id: 32, n: 3 },
            { check_id: 'COH-DOC-LINKS', account_id: 10, object_id: 5, n: 4 },
          ];
        }
        if (q.includes('FROM coherence_repairs r') && q.includes('ORDER BY r.account_id, r.object_id, r.id')) {
          return [1, 2, 3].map((i) => ({ id: i, account_id: 10, object_id: 32, created_at: NOW.toISOString(), result: { effect: 'WRITTEN', written: ['k1'] } }));
        }
        if (q.includes('FROM canonical_field_writes')) {
          return [
            { id: 101, created_at: '2026-11-04T08:00:00Z', old_value: null, new_value: 120, origin: 'RECONCILIATION', source_type: 'coherence_missing_property', source_id: 'COH-MISSING-PROPERTIES:7', par_utilisateur: false },
            { id: 120, created_at: '2026-11-05T08:00:00Z', old_value: 120, new_value: null, origin: 'DOCUMENT_EXTRACTION', source_type: 'document', source_id: '55', par_utilisateur: false },
            { id: 140, created_at: '2026-11-06T08:00:00Z', old_value: null, new_value: 120, origin: 'RECONCILIATION', source_type: 'coherence_missing_property', source_id: 'COH-MISSING-PROPERTIES:9', par_utilisateur: false },
          ];
        }
        return [];
      }),
    } as never;
    const alertes = await repeatedRepairAlerts(sql, NOW);
    const q = requetes.find((r) => r.q.includes('GROUP BY r.check_id, r.account_id, r.object_id'))!;
    expect(q.q).toMatch(/NOT \(r\.check_id = ANY\(\$3::text\[\]\)\)/);
    expect(q.q).toMatch(/jsonb_array_length\(r\.result -> 'written'\)/);
    expect(q.p[2]).toEqual(['COH-MISSING-PROPERTIES', 'COH-MISSING-PROPERTIES-EQUIPMENT']);
    const mp = alertes.find((a) => a.fingerprint === 'other:coherence:coh-missing-properties:repeated_repairs')!;
    expect(mp).toMatchObject({ title: 'Cohérence COH-MISSING-PROPERTIES : objets réparés de façon répétée (1)', count: 1 });
    expect(mp.detail.counting).toMatch(/réparations réelles seulement/);
    expect(mp.detail.evidence).toEqual([expect.objectContaining({
      accountId: 10, objectId: 32, realRepairs: 3,
      fields: [expect.objectContaining({ key: 'k1', restorations: 3, sameValue: true, canonicalWriteIds: [101, 140], erasure: 'JOURNALED',
        erasedBy: [expect.objectContaining({ canonicalWriteId: 120, origin: 'DOCUMENT_EXTRACTION', source: 'document:55', byUser: false })] })],
    })]);
    expect(String(mp.detail.summary)).toBe('Compte 10 · bien 32 : « k1 » restauré 3 fois (même valeur 120) — écritures n° 101, 140 ; remis à vide par DOCUMENT_EXTRACTION (document:55) le 2026-11-05 (écriture n° 120)');
    // Autre contrôle : décompte des lignes REPAIRED inchangé, sans explication.
    const autre = alertes.find((a) => a.fingerprint === 'other:coherence:coh-doc-links:repeated_repairs')!;
    expect(autre.detail).not.toHaveProperty('counting');
    expect(autre.detail.objects).toBe('compte 10 · objet 5 : 4 réparation(s) en 7 jours');
  });

  it('effacement hors du writer canonique : signalé comme non journalisé', async () => {
    const explain = rep.explainRepeatedMissingProperties('ASSET', 'COH-MISSING-PROPERTIES');
    const sql = {
      unsafe: vi.fn(async (q: string) => (q.includes('FROM coherence_repairs r')
        ? [1, 2, 3].map((i) => ({ id: i, account_id: 10, object_id: 31, created_at: NOW.toISOString(), result: { written: ['k2'] } }))
        : q.includes('FROM canonical_field_writes')
          ? [{ id: 9, created_at: NOW.toISOString(), old_value: null, new_value: 'A', origin: 'RECONCILIATION', source_type: 'coherence_missing_property', source_id: 'x', par_utilisateur: false }]
          : [])),
    } as never;
    const r = await explain(sql, [{ accountId: 10, objectId: 31 }], new Date(NOW.getTime() - 7 * 86_400_000));
    expect(r.evidence).toEqual([expect.objectContaining({ fields: [expect.objectContaining({ key: 'k2', erasure: 'NOT_JOURNALED', erasedBy: [] })] })]);
    expect(String(r.summary)).toMatch(/aucune remise à vide journalisée dans canonical_field_writes : effacement hors du writer canonique/);
  });
});
