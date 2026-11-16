/**
 * Lot 114 (carte #776 — travail 10, AC17) — SUPERVISION des sorties
 * structurées : taux, sommes et rapport (exécuteur de lecture simulé ; la
 * requête SQL réelle est vérifiée par le scénario de bout en bout
 * `l114j-t1-schemas-gemini-couverture.e2e.ts`). Instant fixe.
 */
import { describe, expect, it } from 'vitest';
import {
  getSchemaUsageReport, schemaUsageRates, sumSchemaUsage, STATIC_OMISSION_REASONS, SCHEMA_USAGE_GROUP_PAGE,
  type SchemaUsageCounts,
} from '../schema-compat/supervision';
import { schemaIncompatibilityMessage, SCHEMA_COMPAT_ALERT_CODE } from '../schema-compat/alerts';
import { applySchemaOutcome } from '../schema-compat/policy';

const NOW = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
const counts = (over: Partial<SchemaUsageCounts>): SchemaUsageCounts => ({
  calls: 0, schemaSent: 0, schemaAccepted: 0, schemaRefused400: 0, schemaFailedOther: 0, retriesWithoutSchema: 0, answeredAfterRetry: 0,
  skippedKnownRejection: 0, omittedStatic: 0, notRequested: 0, retests: 0, finalSuccess: 0, providerRequests: 0, inputTokens: 0, outputTokens: 0,
  costMicros: 0, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0, failedAttemptMs: 0, ...over,
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
    // Règle complétée (carte #784, §D2) : TROIS lectures — ventilation paginée, TOTAUX de l'ensemble
    // filtré (sans regroupement) et tendance journalière. Les totaux ne sont plus la somme des groupes.
    expect(vus).toHaveLength(3);
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

  /**
   * Lot 115 (carte #784, §D2) — le défaut constaté : les totaux étaient la SOMME des 200 groupes lus.
   * Au-delà, ils devenaient incomplets. Ils sont désormais lus sur l'ensemble filtré, sans regroupement
   * ni borne, AVANT pagination : la ventilation affichée peut être tronquée, les totaux restent exacts.
   */
  it('L784-SUP-01 — PLUS DE 200 combinaisons : ventilation tronquée mais TOTAUX exacts (jamais la somme de la page)', async () => {
    const COMBINAISONS = 250;
    const groupe = (i: number) => ({
      operation_code: 't1_analyze_document', model: `modele-${i}`, contract_id: 'T1', contract_version: '7',
      schema_hash: `h${i}`, provider_schema_hash: `p${i}`, calls: 1, schema_sent: 1, schema_accepted: 0, schema_refused_400: 1,
      schema_failed_other: 0, skipped_known_rejection: 0, omitted_static: 0, not_requested: 0, retries_without_schema: 1,
      answered_after_retry: 1, retests: 0, final_success: 1, provider_requests: 2, input_tokens: '10', output_tokens: '2',
      cost_micros: '7', cost_unknown: 0, failed_attempt_ms: '5', duration_p50: 100, duration_p95: 200,
      attempts_cost_observed: 1, attempts_cost_zero: 0, attempts_cost_unknown: 1,
    });
    const run = async (sql: string) => {
      if (sql.includes('GROUP BY 1 ORDER BY 1')) return [];
      // Lecture SANS regroupement : les totaux de l'ensemble (250 appels), pas ceux d'une page.
      if (!sql.includes('GROUP BY 1, 2, 3, 4, 5, 6')) {
        return [{
          calls: COMBINAISONS, schema_sent: COMBINAISONS, schema_accepted: 0, schema_refused_400: COMBINAISONS, schema_failed_other: 0,
          skipped_known_rejection: 0, omitted_static: 0, not_requested: 0, retries_without_schema: COMBINAISONS,
          answered_after_retry: COMBINAISONS, retests: 0, final_success: COMBINAISONS, provider_requests: COMBINAISONS * 2,
          input_tokens: String(COMBINAISONS * 10), output_tokens: String(COMBINAISONS * 2), cost_micros: String(COMBINAISONS * 7),
          cost_unknown: 0, failed_attempt_ms: String(COMBINAISONS * 5), duration_p50: 100, duration_p95: 200,
          attempts_cost_observed: COMBINAISONS, attempts_cost_zero: 0, attempts_cost_unknown: COMBINAISONS,
          group_count: COMBINAISONS,
        }];
      }
      // La ventilation est lue avec UNE ligne de plus que la page, pour SAVOIR qu'elle est tronquée.
      return Array.from({ length: SCHEMA_USAGE_GROUP_PAGE + 1 }, (_, i) => groupe(i));
    };
    const r = await getSchemaUsageReport({ days: 30 }, NOW, run);
    // Ventilation : exactement une page, et le fait qu'il en reste est DIT (jamais silencieux).
    expect(r.groups).toHaveLength(SCHEMA_USAGE_GROUP_PAGE);
    expect(r.groupsTruncated).toBe(true);
    expect(r.groupCount).toBe(COMBINAISONS);
    // Totaux : ceux des 250 combinaisons, pas ceux des 200 affichées (l'ancien calcul aurait donné 200).
    expect(r.totals.calls).toBe(COMBINAISONS);
    expect(r.totals.providerRequests).toBe(COMBINAISONS * 2);
    expect(r.totals.inputTokens).toBe(COMBINAISONS * 10);
    expect(r.totals.costMicros).toBe(COMBINAISONS * 7);
    expect(r.totals.durationP50Ms).toBe(100);
    expect(r.totals.durationP95Ms).toBe(200);
    // Et ils DIFFÈRENT de la somme de la page : c'est précisément le défaut corrigé.
    expect(r.totals.calls).not.toBe(sumSchemaUsage(r.groups).calls);
    // Taux calculés sur les totaux exacts.
    expect(r.totals.rates).toMatchObject({ acceptedRate: 0, refusal400Rate: 1, requestsPerCall: 2 });
  });

  it('L784-SUP-02 — natures de coût distinguées : observé, 0 € justifié, inconnu — « non mesurable » n’est jamais 0', async () => {
    const run = async (sql: string) => {
      if (sql.includes('GROUP BY 1 ORDER BY 1')) return [];
      const ligne = {
        operation_code: 't1_analyze_document', model: 'modele-a', contract_id: 'T1', contract_version: '7', schema_hash: 'h', provider_schema_hash: 'p',
        calls: 2, schema_sent: 2, schema_accepted: 1, schema_refused_400: 1, schema_failed_other: 0, skipped_known_rejection: 0, omitted_static: 0,
        not_requested: 0, retries_without_schema: 1, answered_after_retry: 1, retests: 0, final_success: 2, provider_requests: 3,
        input_tokens: '100', output_tokens: '20', cost_micros: '900', cost_unknown: 0, failed_attempt_ms: '40', duration_p50: 1, duration_p95: 2,
        // 2 tentatives chiffrées, 1 à consommation explicitement nulle, 1 refusée au coût INCONNU.
        attempts_cost_observed: 2, attempts_cost_zero: 1, attempts_cost_unknown: 1, group_count: 1,
      };
      return [ligne];
    };
    const r = await getSchemaUsageReport({ days: 7 }, NOW, run);
    // Le coût confirmé reste lisible, et ce qui n'est pas établi est compté À PART (jamais fondu dans 0 €).
    expect(r.totals.costMicros).toBe(900);
    expect(r.totals).toMatchObject({ attemptsCostObserved: 2, attemptsCostZero: 1, attemptsCostUnknown: 1 });
    expect(r.groups[0]).toMatchObject({ attemptsCostObserved: 2, attemptsCostZero: 1, attemptsCostUnknown: 1 });
    // Une tentative au coût inconnu ne disparaît pas des requêtes fournisseur réelles.
    expect(r.totals.providerRequests).toBe(3);
  });

  it('L784-SUP-03 — traces d’AVANT ce lot (aucune nature de coût relevée) : compteurs à 0, et le coût confirmé reste lu', async () => {
    const run = async (sql: string) => {
      if (sql.includes('GROUP BY 1 ORDER BY 1')) return [];
      // Anciennes traces : ni `costStatus`, ni `attempts_cost_*` — la lecture rend NULL, pas une erreur.
      return [{
        operation_code: 't1_analyze_document', model: 'modele-a', contract_id: 'T1', contract_version: '7', schema_hash: 'h', provider_schema_hash: 'p',
        calls: 1, schema_sent: 1, schema_accepted: 1, schema_refused_400: 0, schema_failed_other: 0, skipped_known_rejection: 0, omitted_static: 0,
        not_requested: 0, retries_without_schema: 0, answered_after_retry: 0, retests: 0, final_success: 1, provider_requests: 1,
        input_tokens: '10', output_tokens: '2', cost_micros: '50', cost_unknown: 0, failed_attempt_ms: '0', duration_p50: 1, duration_p95: 1,
        attempts_cost_observed: null, attempts_cost_zero: null, attempts_cost_unknown: null, group_count: 1,
      }];
    };
    const r = await getSchemaUsageReport({ days: 7 }, NOW, run);
    expect(r.totals).toMatchObject({ calls: 1, costMicros: 50, attemptsCostObserved: 0, attemptsCostZero: 0, attemptsCostUnknown: 0 });
    expect(r.unavailable).toBeNull();
  });

  it('L784-SUP-04 — ensemble VIDE : totaux à zéro mesurés, taux « non mesurables », ventilation non tronquée', async () => {
    const r = await getSchemaUsageReport({ days: 7 }, NOW, async () => []);
    expect(r.groups).toEqual([]);
    expect(r.groupsTruncated).toBe(false);
    // Aucune ligne d'agrégat rendue : rien n'est inventé, les taux restent « non mesurables ».
    expect(r.groupCount).toBeNull();
    expect(r.totals.rates).toEqual({ acceptedRate: null, refusal400Rate: null, jsonModeRate: null, requestsPerCall: null });
    expect(r.totals.durationP50Ms).toBeNull();
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
