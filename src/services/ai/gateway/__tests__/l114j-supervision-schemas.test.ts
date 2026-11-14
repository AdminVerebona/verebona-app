/**
 * Lot 114 (carte #776 — travail 10, AC17) — SUPERVISION des sorties
 * structurées : taux, sommes et rapport (exécuteur de lecture simulé ; la
 * requête SQL réelle est vérifiée par le scénario de bout en bout
 * `l114j-t1-schemas-gemini-couverture.e2e.ts`). Instant fixe.
 */
import { describe, expect, it } from 'vitest';
import { getSchemaUsageReport, schemaUsageRates, sumSchemaUsage, STATIC_OMISSION_REASONS, type SchemaUsageCounts } from '../schema-compat/supervision';
import { schemaIncompatibilityMessage, SCHEMA_COMPAT_ALERT_CODE } from '../schema-compat/alerts';
import { applySchemaOutcome } from '../schema-compat/policy';

const NOW = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
const counts = (over: Partial<SchemaUsageCounts>): SchemaUsageCounts => ({
  calls: 0, schemaSent: 0, schemaAccepted: 0, schemaRefused400: 0, schemaFailedOther: 0, retriesWithoutSchema: 0, answeredAfterRetry: 0,
  skippedKnownRejection: 0, omittedStatic: 0, notRequested: 0, retests: 0, finalSuccess: 0, providerRequests: 0, inputTokens: 0, outputTokens: 0,
  costMicros: 0, failedAttemptMs: 0, ...over,
});

describe('L114J-SUP — taux d’usage du schéma imposé', () => {
  it('L114J-SUP-01 — profil de la fenêtre décrite par la carte : 68 appels, 0 accepté, 4 refus puis repli, 63 refus mémorisés, 1 en JSON direct', () => {
    const c = counts({ calls: 68, schemaSent: 4, schemaAccepted: 0, schemaRefused400: 4, retriesWithoutSchema: 4, answeredAfterRetry: 4, skippedKnownRejection: 63, notRequested: 1, finalSuccess: 68, providerRequests: 72 });
    const r = schemaUsageRates(c);
    // Réussite finale 68/68, mais 0 % d'appels structurés acceptés : la dégradation est VISIBLE.
    expect(r).toEqual({ acceptedRate: 0, refusal400Rate: 1, jsonModeRate: 1, requestsPerCall: 1.06 });
  });

  it('L114J-SUP-02 — dénominateur nul : taux « non mesurable » (null), jamais 0', () => {
    expect(schemaUsageRates(counts({}))).toEqual({ acceptedRate: null, refusal400Rate: null, jsonModeRate: null, requestsPerCall: null });
    expect(schemaUsageRates(counts({ calls: 3, notRequested: 3, providerRequests: 3 }))).toMatchObject({ acceptedRate: null, refusal400Rate: null, jsonModeRate: null, requestsPerCall: 1 });
  });

  it('L114J-SUP-03 — sommes : un coût non calculable dans un groupe rend le total non calculable (jamais sous-estimé)', () => {
    const a = counts({ calls: 2, schemaSent: 2, schemaAccepted: 2, finalSuccess: 2, providerRequests: 2, inputTokens: 100, outputTokens: 20, costMicros: 500 });
    const b = counts({ calls: 1, schemaSent: 1, schemaRefused400: 1, retriesWithoutSchema: 1, answeredAfterRetry: 1, finalSuccess: 1, providerRequests: 2, inputTokens: 50, outputTokens: 10, costMicros: 300, failedAttemptMs: 420 });
    expect(sumSchemaUsage([a, b])).toMatchObject({ calls: 3, schemaAccepted: 2, schemaRefused400: 1, providerRequests: 4, inputTokens: 150, outputTokens: 30, costMicros: 800, failedAttemptMs: 420 });
    expect(sumSchemaUsage([a, { ...b, costMicros: null }]).costMicros).toBeNull();
    expect(sumSchemaUsage([])).toMatchObject({ calls: 0, costMicros: 0 });
  });
});

describe('L114J-SUP — rapport', () => {
  it('L114J-SUP-04 — groupes par opération, modèle et contrat ; filtres transmis ; aucun contenu', async () => {
    const vus: Array<{ sql: string; params: unknown[] }> = [];
    const run = async (sql: string, params: unknown[]) => {
      vus.push({ sql, params });
      if (sql.includes('GROUP BY 1 ORDER BY 1')) {
        return [{ day: '2026-11-12', calls: 3, schema_sent: 1, schema_accepted: 0, schema_refused_400: 1, skipped_known_rejection: 2, omitted_static: 0, not_requested: 0 }];
      }
      return [{
        operation_code: 't1_analyze_document', model: 'modele-a', contract_id: 'T1_ANALYZE_DOCUMENT', contract_version: '7', schema_hash: 'aaaaaaaaaaaa',
        provider_schema_hash: 'bbbbbbbbbbbb', calls: 3, schema_sent: 1, schema_accepted: 0, schema_refused_400: 1, schema_failed_other: 0,
        skipped_known_rejection: 2, omitted_static: 0, not_requested: 0, retries_without_schema: 1, answered_after_retry: 1, retests: 0, final_success: 3,
        provider_requests: 4, input_tokens: '3000', output_tokens: '900', cost_micros: '1200', cost_unknown: 0, failed_attempt_ms: '350', duration_p50: 4000, duration_p95: 9000,
      }];
    };
    const r = await getSchemaUsageReport({ days: 30, operationCode: 't1_analyze_document', model: 'modele-a', contractVersion: 7 }, NOW, run);
    expect(r).toMatchObject({ days: 30, to: NOW.toISOString(), unavailable: null, filters: { operationCode: 't1_analyze_document', model: 'modele-a', contractVersion: 7 } });
    expect(r.from).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({
      operationCode: 't1_analyze_document', model: 'modele-a', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7, schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb',
      calls: 3, schemaRefused400: 1, retriesWithoutSchema: 1, skippedKnownRejection: 2, finalSuccess: 3, providerRequests: 4, inputTokens: 3000, outputTokens: 900,
      costMicros: 1200, failedAttemptMs: 350, durationP50Ms: 4000, durationP95Ms: 9000,
      rates: { acceptedRate: 0, refusal400Rate: 1, jsonModeRate: 1, requestsPerCall: 1.33 },
    });
    expect(r.totals).toMatchObject({ calls: 3, finalSuccess: 3, providerRequests: 4, rates: { acceptedRate: 0 } });
    expect(r.trend).toEqual([expect.objectContaining({ day: '2026-11-12', calls: 3, schemaRefused400: 1, skippedKnownRejection: 2, acceptedRate: 0 })]);
    // Filtres passés en paramètres (jamais concaténés), motifs statiques inclus.
    expect(vus).toHaveLength(2);
    expect(vus[0].params.slice(2)).toEqual(['t1_analyze_document', 'modele-a', [...STATIC_OMISSION_REASONS], '7']);
    // La requête ne lit que des compteurs, codes et empreintes des traces : ni prompt, ni sortie, ni capture.
    for (const v of vus) {
      expect(v.sql).toContain('ai_usage_event');
      expect(v.sql).not.toMatch(/ai_call_captures|output_preview|error_message|prompt|raw_response/i);
    }
  });

  it('L114J-SUP-05 — lecture impossible : indicateurs absents et raison, jamais des zéros présentés comme une mesure', async () => {
    const r = await getSchemaUsageReport({ days: 7 }, NOW, async () => { throw new Error('délai dépassé, requête annulée par la base'); });
    expect(r.unavailable).toContain('délai dépassé');
    expect(r.groups).toEqual([]);
    expect(r.totals.rates).toEqual({ acceptedRate: null, refusal400Rate: null, jsonModeRate: null, requestsPerCall: null });
  });

  it('L114J-SUP-06 — période bornée (1 à 90 jours)', async () => {
    const run = async () => [];
    expect((await getSchemaUsageReport({ days: 500 }, NOW, run)).days).toBe(90);
    expect((await getSchemaUsageReport({ days: 0 }, NOW, run)).days).toBe(7);
    expect((await getSchemaUsageReport({ days: -3 }, NOW, run)).days).toBe(1);
  });
});

describe('L114J-SUP — texte de l’alerte de compatibilité', () => {
  it('L114J-SUP-07 — aucune cause inventée, aucun contenu : opération, modèle, contrat, empreinte, prochain essai', () => {
    const key = { provider: 'gemini', model: 'modele-a', operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7, schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-test' };
    const t0 = Date.UTC(2026, 10, 13, 8, 0, 0);
    const generique = schemaIncompatibilityMessage(applySchemaOutcome(null, key, { kind: 'REJECTED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' }, t0));
    expect(generique).toContain('t1_analyze_document · modele-a');
    expect(generique).toContain('HTTP 400 sans précision');
    expect(generique).toContain('T1_ANALYZE_DOCUMENT v7, aaaaaaaaaaaa');
    expect(generique).toContain('2026-11-13 14:00 UTC');
    expect(generique).toContain('La cause interne du refus n’est pas indiquée par le fournisseur.');
    expect(generique).not.toMatch(/indisponible|panne/i);
    const explicite = schemaIncompatibilityMessage(applySchemaOutcome(null, key, { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, t0));
    expect(explicite).toContain('le fournisseur a refusé le schéma de sortie');
    expect(SCHEMA_COMPAT_ALERT_CODE).toBe('ai_schema_incompatibility');
  });
});
