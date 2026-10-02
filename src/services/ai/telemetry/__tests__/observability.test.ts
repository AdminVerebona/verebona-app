/**
 * Observabilité §18 (lot 17) — un test par indicateur, requêtes simulées.
 *
 * Le simulateur répond selon la requête ; les paramètres reçus sont gardés
 * pour vérifier la période et le filtre de version.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getObservability, setObservabilityQueryRunner, ObservabilityVersionNotFound, T1_SAMPLE, T1_SAMPLE_APP,
  DOMAIN_BUDGET_MS,
  type ObservabilityReport,
} from '../observability.repository';

type Row = Record<string, unknown>;
const calls: Array<{ sql: string; params: unknown[] }> = [];
let responses: Array<[RegExp, Row[] | (() => Row[])]> = [];

const NOW = new Date('2026-09-30T12:00:00Z');

let gate: Promise<void> | null = null;

async function runner(sql: string, params: unknown[]): Promise<Row[]> {
  calls.push({ sql, params });
  if (gate) await gate;
  for (const [re, rows] of responses) {
    if (re.test(sql)) return typeof rows === 'function' ? rows() : rows;
  }
  return [];
}

const val = (r: ObservabilityReport, key: string) => {
  const m = r.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`indicateur absent : ${key}`);
  return m.value;
};
const table = (r: ObservabilityReport, key: string) => r.tables.find((t) => t.key === key)?.rows ?? [];

const USAGE: [RegExp, Row[]] = [/use_case_code = \$3/, [{ calls: 10, cost: 5000, fallbacks: 2 }]];
const PG16: [RegExp, Row[]] = [/server_version_num/, [{ v: 160004 }]];

beforeEach(() => {
  gate = null;
  calls.length = 0;
  responses = [];
  setObservabilityQueryRunner(runner);
});
afterEach(() => setObservabilityQueryRunner(null));

describe('T1', () => {
  beforeEach(() => {
    responses = [
      USAGE, PG16,
      [/FROM document_facts/, [{ total: 10, canonical: 6, generic: 4, unresolved: 1, visual: 2, tabular: 3, textual: 5 }]],
      [/AS runs FROM document_analysis_runs/, [{ runs: 3 }]],
      [/WITH r AS/, [
        { kind: 'warning', code: 'UNIT_MISMATCH', n: 2 },
        { kind: 'warning', code: 'UNVERIFIED_IDENTIFIER', n: 1 },
        { kind: 'warning', code: 'FACT_REQUALIFIED_GENERIC', n: 4 },
        { kind: 'warning', code: 'MASTER_FALLBACK_STEPS', n: 1 },
        { kind: 'warning', code: 'LINE_COUNT_UNKNOWN', n: 5 },
        { kind: 'sampled', code: null, n: 3 },
        { kind: 'candidates', code: null, n: 7 },
      ]],
    ];
  });

  it('faits extraits, canonicalisés, génériques non mappés, cible non résolue', async () => {
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect(val(r, 'analyses')).toBe(3);
    expect(val(r, 'facts_extracted')).toBe(10);
    expect(val(r, 'facts_canonical')).toBe(6);
    expect(val(r, 'facts_canonical_rate')).toBe(60);
    expect(val(r, 'facts_generic')).toBe(4);
    expect(val(r, 'facts_unresolved_target')).toBe(1);
  });

  it('erreurs de cible par code, et leur total', async () => {
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect(val(r, 'warning_unit_mismatch')).toBe(2);
    expect(val(r, 'warning_unverified_identifier')).toBe(1);
    expect(val(r, 'warning_fact_requalified_generic')).toBe(4);
    expect(val(r, 'warning_fact_rejected_by_rule')).toBe(0);
    expect(val(r, 'target_errors')).toBe(7);
    expect(table(r, 't1_warnings').map((x) => x.code)).toContain('LINE_COUNT_UNKNOWN');
  });

  it('provenance texte / visuel / tableau et replis master → étapes', async () => {
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect([val(r, 'provenance_text'), val(r, 'provenance_visual'), val(r, 'provenance_table')]).toEqual([5, 2, 3]);
    expect(val(r, 'master_fallback_steps')).toBe(1);
  });

  it('coût et replis de modèle du traitement', async () => {
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect([val(r, 'ai_calls'), val(r, 'ai_cost'), val(r, 'ai_fallbacks')]).toEqual([10, 5000, 2]);
    expect(calls.find((c) => /use_case_code = \$3/.test(c.sql))!.params[2]).toBe('SOURCE_ANALYSIS');
  });

  it('période bornée : [now - jours, now), échantillon d’analyses borné', async () => {
    await getObservability({ domain: 'T1', days: 7 }, NOW);
    const f = calls.find((c) => /FROM document_facts/.test(c.sql))!;
    expect(f.params).toEqual(['2026-09-23T12:00:00.000Z', '2026-09-30T12:00:00.000Z']);
    expect(calls.find((c) => /WITH r AS/.test(c.sql))!.params[2]).toBe(T1_SAMPLE);
  });

  it('échantillon partiel : l’écran le dit', async () => {
    responses.unshift([/AS runs FROM document_analysis_runs/, [{ runs: 900 }]]);
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect(r.notes.join(' ')).toMatch(/échantillon des 3 analyses les plus récentes sur 900/);
  });

  it('requête en échec : indicateurs nuls AVEC raison, jamais zéro', async () => {
    responses.unshift([/FROM document_facts/, () => { throw new Error('relation absente'); }]);
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    const m = r.metrics.find((x) => x.key === 'facts_extracted')!;
    expect(m.value).toBeNull();
    expect(m.missingReason).toMatch(/indisponible/);
    expect(r.notes.join(' ')).toMatch(/Faits T1 : mesure indisponible/);
    expect(val(r, 'master_fallback_steps')).toBe(1);
  });
});

describe('T3', () => {
  beforeEach(() => {
    responses = [
      USAGE,
      [/FROM field_evidence/, [{ total: 9, active: 5, superseded: 3, withdrawn: 1 }]],
      [/FROM canonical_field_writes/, [{ written: 4, protected: 2, conflict: 1, invalid: 0, shadow_divergences: 6 }]],
      [/action_kind = 'ARBITRATE'/, [{ opened: 3, still_open: 2 }]],
      [/reconciliation_decisions/, [
        { code: 'NO_REMAINING_EVIDENCE', n: 2 }, { code: 'STALE_AUTO_VALUE_REPLACED', n: 1 }, { code: 'NEW_EVIDENCE', n: 8 },
      ]],
    ];
  });

  it('preuves ACTIVE / SUPERSEDED / WITHDRAWN', async () => {
    const r = await getObservability({ domain: 'T3', days: 30 }, NOW);
    expect([val(r, 'evidence_active'), val(r, 'evidence_superseded'), val(r, 'evidence_withdrawn')]).toEqual([5, 3, 1]);
  });

  it('champs mis à jour, écrasements USER bloqués, divergences en observation', async () => {
    const r = await getObservability({ domain: 'T3', days: 30 }, NOW);
    expect(val(r, 'fields_updated')).toBe(4);
    expect(val(r, 'user_overwrites_blocked')).toBe(2);
    expect(val(r, 'write_conflicts')).toBe(1);
    expect(val(r, 'shadow_divergences')).toBe(6);
  });

  it('conflits ouverts et rétractations par motif', async () => {
    const r = await getObservability({ domain: 'T3', days: 30 }, NOW);
    expect([val(r, 'conflicts_opened'), val(r, 'conflicts_open')]).toEqual([3, 2]);
    expect(val(r, 'retractions')).toBe(3);
    expect(val(r, 'retraction_no_evidence')).toBe(2);
    expect(val(r, 'retraction_stale_replaced')).toBe(1);
    expect(table(r, 't3_decisions')).toHaveLength(3);
  });
});

describe('T4', () => {
  beforeEach(() => {
    responses = [
      USAGE, PG16,
      [/FROM agenda_items a/, [{ created: 6, historical: 2, deadline: 4, action: 3, information: 2, unknown: 1, orphans: 1 }]],
      [/FROM agenda_item_sources/, [{ code: 'created', n: 6 }, { code: 'resolved_existing', n: 3 }, { code: 'rejected_orphan', n: 2 }, { code: 'conflict_pending', n: 1 }]],
      [/FROM agenda_item_removals/, [{ code: 'SOURCE_DELETED', n: 2 }, { code: 'NOT_FOUND_ANYMORE', n: 1 }]],
      [/AGENDA-PROPOSAL/, [{ opened: 4, open: 1, accepted: 2 }]],
      [/AS runs FROM document_analysis_runs/, [{ runs: 2 }]],
      [/WITH r AS/, [{ kind: 'sampled', code: null, n: 2 }, { kind: 'candidates', code: null, n: 11 }]],
    ];
  });

  it('candidats, créés, mis à jour, retirés', async () => {
    const r = await getObservability({ domain: 'T4', days: 7 }, NOW);
    expect(val(r, 'candidates')).toBe(11);
    expect(val(r, 'events_created')).toBe(6);
    expect(val(r, 'events_updated')).toBe(3);
    expect(val(r, 'events_removed')).toBe(3);
    expect(table(r, 't4_removals')[0]).toEqual({ code: 'SOURCE_DELETED', count: 2 });
  });

  it('HISTORICAL / DEADLINE, orphelins, classification action / information / inconnue', async () => {
    const r = await getObservability({ domain: 'T4', days: 7 }, NOW);
    expect([val(r, 'events_historical'), val(r, 'events_deadline')]).toEqual([2, 4]);
    expect([val(r, 'orphans'), val(r, 'rejected_orphans'), val(r, 'conflicts_pending')]).toEqual([1, 2, 1]);
    expect([val(r, 'class_action'), val(r, 'class_information'), val(r, 'class_unknown')]).toEqual([3, 2, 1]);
  });

  it('cartes AGENDA-PROPOSAL', async () => {
    const r = await getObservability({ domain: 'T4', days: 7 }, NOW);
    expect([val(r, 'proposal_cards'), val(r, 'proposal_cards_open'), val(r, 'proposal_cards_accepted')]).toEqual([4, 1, 2]);
  });
});

describe('T2', () => {
  beforeEach(() => {
    responses = [
      USAGE,
      [/AS traced/, [{ total: 10, clarifications: 2, revalidations: 3, revalidated_requests: 2, avg_sources: 1.456, traced: 4 }]],
      [/GROUP BY 1, 2$/, [
        { strategy: 'structured.asset_field', truth: null, n: 3 },
        { strategy: 'llm.generate_answer', truth: 'document', n: 2 },
        { strategy: 'retrieval.t1_fact', truth: 'fait', n: 1 },
        { strategy: 'fallback.sources', truth: null, n: 2 },
        { strategy: 'clarification.asset', truth: null, n: 2 },
      ]],
      [/CLAIM_UNSUPPORTED/, [{ code: 'FIELD_NOT_IN_SOURCES', n: 3 }, { code: 'NUMBER_MISMATCH', n: 1 }]],
      [/COALESCE\(intent/, [{ code: 'ASK_DATA', n: 7 }, { code: 'HELP', n: 3 }]],
      [/'target'->>'type'/, [{ type: 'document', origin: 'thread', n: 2 }, { type: 'aucune', origin: '—', n: 2 }]],
      [/jsonb_each_text/, [{ code: 'document', n: 5 }, { code: 'asset_field', n: 2 }]],
    ];
  });

  it('source de vérité ayant répondu (tracée, sinon déduite de la stratégie)', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    const rows = Object.fromEntries(table(r, 't2_truth').map((x) => [x.code, x.count]));
    expect(rows).toEqual({ Canonique: 3, Document: 2, 'Fait T1': 1, 'Sans résultat': 2, Clarification: 2 });
  });

  it('sans résultat, clarifications, revalidations', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect(val(r, 'requests')).toBe(10);
    expect(val(r, 'no_result')).toBe(2);
    expect(val(r, 'no_result_rate')).toBe(20);
    expect(val(r, 'clarifications')).toBe(2);
    expect(val(r, 'revalidations')).toBe(3);
    expect(val(r, 'revalidated_requests')).toBe(2);
  });

  it('claims rejetées par motif, intentions, cibles, nombre et types de sources, coût', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect(val(r, 'claims_rejected')).toBe(4);
    expect(table(r, 't2_claims')).toEqual([{ code: 'FIELD_NOT_IN_SOURCES', count: 3 }, { code: 'NUMBER_MISMATCH', count: 1 }]);
    expect(table(r, 't2_intents')[0]).toEqual({ code: 'ASK_DATA', count: 7 });
    expect(table(r, 't2_targets')[0]).toEqual({ type: 'document', origin: 'thread', count: 2 });
    expect(table(r, 't2_source_types')[0]).toEqual({ code: 'document', count: 5 });
    expect(val(r, 'avg_sources')).toBe(1.46);
    expect(val(r, 'ai_cost')).toBe(5000);
  });

  it('demandes antérieures à la trace : signalé', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect(r.notes.join(' ')).toMatch(/4 demandes sur 10/);
  });
});

describe('Configuration IA', () => {
  beforeEach(() => {
    responses = [
      [/AS models/, [{ calls: 20, with_version: 15, engine_new: 12, engine_legacy: 5, fallbacks: 3, with_reasoning: 18, with_max_tokens: 16, with_trigger: 8, versions: 2, models: 3 }]],
      [/GROUP BY 1, 2, 3, 4, 5, 6, 7, 8/, [{ use_case: 'SOURCE_ANALYSIS', version: 7, engine: 'new', model: 'm1', rank: 'primary', reasoning: 'low', max_tokens: '4000', trigger: 'DOCUMENT_UPLOADED', n: 12 }]],
    ];
  });

  it('version, moteur, modèle, repli, raisonnement, max tokens, déclencheur', async () => {
    const r = await getObservability({ domain: 'CONFIG', days: 7 }, NOW);
    expect(val(r, 'calls')).toBe(20);
    expect(val(r, 'with_version')).toBe(75);
    expect([val(r, 'engine_new'), val(r, 'engine_legacy'), val(r, 'engine_untraced')]).toEqual([12, 5, 3]);
    expect([val(r, 'models'), val(r, 'fallbacks')]).toEqual([3, 3]);
    expect([val(r, 'reasoning_untraced'), val(r, 'max_tokens_untraced'), val(r, 'trigger_traced')]).toEqual([2, 4, 8]);
    expect(table(r, 'config_detail')[0]).toMatchObject({ version: '#7', engine: 'new', trigger: 'DOCUMENT_UPLOADED', count: 12 });
  });
});

describe('Exports', () => {
  beforeEach(() => {
    responses = [
      [/FROM export_generation\s+WHERE created_at >= \$1 AND created_at < \$2\s+\)/, [{
        total: 5, done: 4, failed: 1, canonical: 2, legacy: 3, shadow: 3, diff_fields: 4, diff_documents: 2, diff_events: 1,
        shadow_failed: 1, divergent: 2, unconfirmed_dropped: 2, unconfirmed_shadow: 1,
      }]],
      [/export_generation_items/, [{ code: 'missing', n: 2 }, { code: 'corrupted', n: 1 }, { code: 'occupant_data', n: 1 }, { code: 'section_disabled', n: 9 }]],
      [/status IN \('failed', 'error'\)\s+GROUP BY/, [{ code: 'RENDER_TIMEOUT', n: 1 }]],
    ];
  });

  it('documents liés absents, divergences shadow, périmètre, rattachements non confirmés', async () => {
    const r = await getObservability({ domain: 'EXPORTS', days: 30 }, NOW);
    expect(val(r, 'generations')).toBe(5);
    expect(val(r, 'linked_missing')).toBe(3);
    expect([val(r, 'shadow_divergent'), val(r, 'shadow_diff_fields'), val(r, 'shadow_diff_documents'), val(r, 'shadow_diff_events')]).toEqual([2, 4, 2, 1]);
    expect(val(r, 'shadow_failed')).toBe(1);
    expect(val(r, 'scope_exclusions')).toBe(1);
    expect(val(r, 'unconfirmed_dropped')).toBe(3);
    expect(table(r, 'export_errors')).toEqual([{ code: 'RENDER_TIMEOUT', count: 1 }]);
  });

  it('filtre de version sans objet pour les exports', async () => {
    const r = await getObservability({ domain: 'EXPORTS', days: 30, configVersionId: 7 }, NOW);
    expect(r.version).toMatchObject({ id: 7, scope: 'none' });
    expect(calls.some((c) => /ai_config_versions/.test(c.sql))).toBe(false);
  });
});

describe('filtres', () => {
  it('version : filtre EXACT sur les appels, période d’effet pour les tables métier', async () => {
    responses = [
      [/FROM ai_config_versions v/, [{
        id: 7, visible_number: 3, label: 'Lot 17', status: 'ACTIVE', activated_at: '2026-09-20T00:00:00Z',
        next_activated_at: null, first_call: '2026-09-25T08:00:00Z', last_call: '2026-09-28T10:00:00Z',
      }]],
      USAGE,
    ];
    const r = await getObservability({ domain: 'T1', days: 7, configVersionId: 7 }, NOW);
    expect(r.version).toMatchObject({ id: 7, label: 'v3 — Lot 17 (ACTIVE)', scope: 'exact+period' });
    expect(calls.find((c) => /use_case_code = \$3/.test(c.sql))!.params[3]).toBe(7);
    expect(calls.find((c) => /FROM document_facts/.test(c.sql))!.params)
      .toEqual(['2026-09-25T08:00:00.000Z', '2026-09-28T10:05:00.000Z']);
  });

  it('version sans appel : de l’activation à l’activation suivante', async () => {
    responses = [[/FROM ai_config_versions v/, [{
      id: 7, visible_number: 3, label: null, status: 'ARCHIVED', activated_at: '2026-09-24T00:00:00Z',
      next_activated_at: '2026-09-26T00:00:00Z', first_call: null, last_call: null,
    }]]];
    await getObservability({ domain: 'T4', days: 7, configVersionId: 7 }, NOW);
    expect(calls.find((c) => /FROM agenda_items a/.test(c.sql))!.params)
      .toEqual(['2026-09-24T00:00:00.000Z', '2026-09-26T00:00:00.000Z']);
  });

  it('version sans période d’effet : indicateurs métier nuls avec raison', async () => {
    responses = [[/FROM ai_config_versions v/, [{ id: 7, visible_number: 1, status: 'VALIDATED', activated_at: null }]]];
    const r = await getObservability({ domain: 'T3', days: 7, configVersionId: 7 }, NOW);
    const m = r.metrics.find((x) => x.key === 'evidence_active')!;
    expect(m.value).toBeNull();
    expect(m.missingReason).toMatch(/période d’effet/);
    expect(calls.some((c) => /field_evidence/.test(c.sql))).toBe(false);
  });

  it('version inconnue : refus explicite', async () => {
    await expect(getObservability({ domain: 'T2', days: 7, configVersionId: 999 }, NOW)).rejects.toBeInstanceOf(ObservabilityVersionNotFound);
  });

  it('autre environnement : base distincte, aucune requête', async () => {
    const r = await getObservability({ domain: 'T1', days: 7, environment: 'production' }, NOW);
    expect(r.environment).toEqual({ current: 'local', requested: 'production', readable: false });
    expect(r.metrics).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('environnement courant (synonyme accepté) : lecture normale', async () => {
    responses = [USAGE];
    const r = await getObservability({ domain: 'T2', days: 7, environment: 'dev' }, NOW);
    expect(r.environment.readable).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('fenêtre bornée à 90 jours ; cache par filtres ; rapport incomplet jamais mis en cache', async () => {
    responses = [USAGE];
    const r1 = await getObservability({ domain: 'CONFIG', days: 5000 }, NOW);
    expect(r1.windowDays).toBe(90);
    const n = calls.length;
    const r2 = await getObservability({ domain: 'CONFIG', days: 5000 }, NOW);
    expect(r2.cached).toBe(true);
    expect(calls.length).toBe(n);

    responses = [[/FROM ai_usage_event/, () => { throw new Error('x'); }]];
    await getObservability({ domain: 'T3', days: 1 }, NOW);
    const m = calls.length;
    const r3 = await getObservability({ domain: 'T3', days: 1 }, NOW);
    expect(r3.cached).toBe(false);
    expect(calls.length).toBeGreaterThan(m);
  });
});

describe('relecture lot 17 : résultats T1 illisibles et liste blanche', () => {
  it('PostgreSQL ≥ 16 : conversion sous IS JSON, lignes illisibles comptées, codes inconnus en « AUTRE »', async () => {
    responses = [USAGE, PG16,
      [/AS runs FROM document_analysis_runs/, [{ runs: 3 }]],
      [/WITH r AS/, [
        { kind: 'warning', code: 'UNIT_MISMATCH', n: 1 },
        { kind: 'warning', code: 'Texte libre <script>', n: 2 },
        { kind: 'warning', code: 'NOT_A_CODE', n: 1 },
        { kind: 'sampled', code: null, n: 3 }, { kind: 'invalid', code: null, n: 1 }, { kind: 'candidates', code: null, n: 0 },
      ]]];
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect(calls.find((c) => /WITH r AS/.test(c.sql))!.sql).toMatch(/CASE WHEN t IS JSON OBJECT THEN t::jsonb END/);
    expect(val(r, 'warning_unit_mismatch')).toBe(1);
    expect(table(r, 't1_warnings')).toEqual([{ code: 'AUTRE', count: 3 }, { code: 'UNIT_MISMATCH', count: 1 }]);
    expect(r.notes.join(' ')).toMatch(/1 résultat\(s\) d’analyse illisible/);
    expect(r.notes.join(' ')).not.toMatch(/indisponible/);
  });

  it('PostgreSQL < 16 : lecture applicative tolérante, échantillon réduit', async () => {
    responses = [USAGE, [/server_version_num/, [{ v: 150008 }]],
      [/AS runs FROM document_analysis_runs/, [{ runs: 3 }]],
      [/SELECT raw_response_json AS t/, [
        { t: JSON.stringify({ warnings: [{ code: 'UNIT_MISMATCH' }, { code: 'XYZ' }], agendaCandidates: [{}, {}] }) },
        { t: '{"warnings": [ tronqué' },
        { t: '[1, 2]' },
      ]]];
    const r = await getObservability({ domain: 'T1', days: 7 }, NOW);
    expect(calls.find((c) => /SELECT raw_response_json AS t/.test(c.sql))!.params[2]).toBe(T1_SAMPLE_APP);
    expect(val(r, 'warning_unit_mismatch')).toBe(1);
    expect(table(r, 't1_warnings').find((x) => x.code === 'AUTRE')).toEqual({ code: 'AUTRE', count: 1 });
    expect(r.notes.join(' ')).toMatch(/2 résultat\(s\) d’analyse illisible/);
  });

  it('T4 : candidats comptés malgré une ligne illisible', async () => {
    responses = [USAGE, [/server_version_num/, [{ v: 150008 }]],
      [/AS runs FROM document_analysis_runs/, [{ runs: 2 }]],
      [/SELECT raw_response_json AS t/, [{ t: '{"agendaCandidates":[{},{},{}]}' }, { t: 'pas du json' }]]];
    const r = await getObservability({ domain: 'T4', days: 7 }, NOW);
    expect(val(r, 'candidates')).toBe(3);
  });
});

describe('relecture lot 17 : délais et concurrence', () => {
  it('requête annulée par la base (57014) : indicateur indisponible, la suite continue', async () => {
    responses = [PG16, [/FROM field_evidence/, () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); }]];
    const r = await getObservability({ domain: 'T3', days: 7 }, NOW);
    expect(r.metrics.find((m) => m.key === 'evidence_active')!.value).toBeNull();
    expect(r.notes.join(' ')).toMatch(/Preuves : mesure indisponible \(délai dépassé, requête annulée par la base\)/);
    expect(val(r, 'fields_updated')).toBe(0);
  });

  it('budget du domaine dépassé : les requêtes suivantes ne partent pas', async () => {
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    responses = [[/use_case_code = \$3/, () => { spy.mockReturnValue(t0 + DOMAIN_BUDGET_MS + 1); return [{ calls: 1 }]; }]];
    try {
      const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
      expect(val(r, 'ai_calls')).toBe(1);
      expect(r.notes.join(' ')).toMatch(/budget du domaine dépassé/);
      expect(calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('un seul calcul à la fois : même demande partagée, autre demande : dernier résultat ou « en cours »', async () => {
    responses = [[/use_case_code = \$3/, [{ calls: 4 }]]];
    await getObservability({ domain: 'T2', days: 7 }, NOW); // T2 en cache…
    const PLUS_TARD = new Date(NOW.getTime() + 10 * 60_000); // …puis périmé.

    let libere!: () => void;
    gate = new Promise<void>((r) => { libere = r; });
    const t1 = getObservability({ domain: 'T1', days: 7 }, PLUS_TARD);
    const t1bis = getObservability({ domain: 'T1', days: 7 }, PLUS_TARD);
    const t2 = await getObservability({ domain: 'T2', days: 7 }, PLUS_TARD);
    const t3 = await getObservability({ domain: 'T3', days: 7 }, PLUS_TARD);
    expect(t2).toMatchObject({ stale: true, cached: true });
    expect(val(t2, 'ai_calls')).toBe(4);
    expect(t3).toMatchObject({ busy: true, metrics: [] });

    libere();
    gate = null;
    const [a, b] = await Promise.all([t1, t1bis]);
    expect(b).toBe(a);
    // Une seule exécution de T1 (la seconde demande a attendu la première).
    expect(calls.filter((c) => /FROM document_facts/.test(c.sql))).toHaveLength(1);

    // Libéré : un nouveau calcul part normalement.
    const t3b = await getObservability({ domain: 'T3', days: 7 }, PLUS_TARD);
    expect(t3b.busy).toBeUndefined();
  });
});

describe('T2 — indicateurs techniques §32.2 (lot 19)', () => {
  beforeEach(async () => {
    const { resetBusinessEventsForTests, emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    const { resetScopeIncidentsForTests, recordScopeIncident } = await import('@/services/verebona-assistant/security/scope-incidents');
    resetBusinessEventsForTests();
    resetScopeIncidentsForTests();
    await emitBusinessEvent({ type: 'DOCUMENT_UPLOADED', accountId: 1, entityId: 2 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordScopeIncident('CLIENT_ACCOUNT_OVERRIDE');
    responses = [
      USAGE,
      [/AS traced/, [{ total: 20, clarifications: 0, revalidations: 0, revalidated_requests: 0, avg_sources: 1, traced: 20 }]],
      [/AS scope_incidents/, [{ timeouts: 2, retrieved: 80, shown: 30, scope_incidents: 1 }]],
      [/status = 'error' GROUP BY 1/, [{ code: 'REQUEST_TIMEOUT', n: 2 }, { code: 'ASSISTANT_UNAVAILABLE', n: 1 }]],
      [/AS tout/, [
        { service: 'assistant_generate', calls: 10, errors: 1, tin: 4000, tout: 300 },
        { service: 'assistant_classify', calls: 8, errors: 0, tin: 1000, tout: 50 },
      ]],
      [/GROUPING SETS/, [
        { plan: 'PREMIUM', accounts: 6, calls: 12, cost: 900, median: 300, max: 400 },
        { plan: 'STANDARD', accounts: 4, calls: 6, cost: 100, median: 100, max: 100 },
        { plan: '*', accounts: 10, calls: 18, cost: 1000, median: 250, max: 400 },
      ]],
      [/master_prompt_version/, [
        { model: 'gemini-a', prompt: 'p-1', master: 't2_master@3', n: 10 },
        { model: 'gemini-b', prompt: 'p-1', master: '—', n: 8 },
      ]],
    ];
  });

  it('taux de timeout, erreurs par service, jetons', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect(val(r, 'timeout_rate')).toBe(10);
    expect(val(r, 'timeouts')).toBe(2);
    expect(val(r, 'service_errors')).toBe(4);
    expect([val(r, 'tokens_in'), val(r, 'tokens_out')]).toEqual([5000, 350]);
    expect(table(r, 't2_service_errors')).toContainEqual({ service: 'modèle · assistant_generate', calls: 10, errors: 1, rate: '10 %' });
    expect(table(r, 't2_service_errors')).toContainEqual({ service: 'assistant · REQUEST_TIMEOUT', calls: 20, errors: 2, rate: '10 %' });
  });

  it('coût par compte et par offre, sans identifiant de compte', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect(val(r, 'accounts_using')).toBe(10);
    expect(val(r, 'avg_cost_per_account')).toBe(100);
    const rows = table(r, 't2_cost_by_plan');
    // Moins de 5 comptes : médiane et maximum masqués.
    expect(rows).toEqual([
      { plan: 'PREMIUM', accounts: 6, calls: 12, cost: '0.0009 $', median: '0.0003 $', max: '0.0004 $' },
      { plan: 'STANDARD', accounts: 4, calls: 6, cost: '0.0001 $', median: '< 5 comptes', max: '< 5 comptes' },
    ]);
    // Requête finale : agrégats par offre seulement (aucun account_id rendu).
    const finale = calls.find((c) => /GROUPING SETS/.test(c.sql))!.sql.split('FROM par_compte')[0].split(')\n')[1] ?? '';
    expect(finale).not.toMatch(/account_id/);
    expect(rows.every((x) => Object.keys(x).every((k) => ['plan', 'accounts', 'calls', 'cost', 'median', 'max'].includes(k)))).toBe(true);
  });

  it('volume de sources, incidents de cloisonnement, versions de modèles et prompts', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect([val(r, 'sources_retrieved'), val(r, 'sources_shown')]).toEqual([80, 30]);
    expect(val(r, 'scope_incidents')).toBe(1);
    expect(val(r, 'scope_incidents_instance')).toBe(1);
    expect(val(r, 'model_versions')).toBe(2);
    expect(val(r, 'prompt_versions')).toBe(2);
    expect(table(r, 't2_versions')[0]).toEqual({ model: 'gemini-a', prompt: 'p-1', master: 't2_master@3', count: 10 });
  });

  it('§25.7 : compteurs d’événements métier de l’instance, portée indiquée', async () => {
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect(table(r, 't2_business_events')).toContainEqual({ code: 'DOCUMENT_UPLOADED', count: 1 });
    expect(r.tables.find((t) => t.key === 't2_business_events')!.label).toMatch(/instance .+, depuis/);
    expect(r.notes.join(' ')).toMatch(/non agrégés entre instances/);
  });

  it('filtre de version EXACT sur les appels modèle', async () => {
    responses.unshift([/FROM ai_config_versions v/, [{ id: 5, visible_number: 2, status: 'ACTIVE', activated_at: '2026-09-25T00:00:00Z', first_call: '2026-09-26T00:00:00Z', last_call: '2026-09-27T00:00:00Z' }]]);
    await getObservability({ domain: 'T2', days: 7, configVersionId: 5 }, NOW);
    expect(calls.find((c) => /GROUPING SETS/.test(c.sql))!.params[2]).toBe(5);
    expect(calls.find((c) => /master_prompt_version/.test(c.sql))!.params[2]).toBe(5);
  });
});

describe('T2 — indicateurs d’usage §32.3 (lot 21)', () => {
  it('ouvertures, clics sur l’action principale, sources, copies, retours ; par offre, sans compte', async () => {
    responses = [
      [/AS traced/, [{ total: 10, traced: 10 }]],
      [/FROM verebona_usage_events/, [
        { type: 'ASSISTANT_OPEN', value: '—', plan: 'PREMIUM', n: 12 },
        { type: 'ACTION_CLICK', value: 'primary', plan: 'PREMIUM', n: 4 },
        { type: 'ACTION_CLICK', value: 'secondary', plan: 'STANDARD', n: 1 },
        { type: 'SOURCE_OPEN', value: '—', plan: 'PREMIUM', n: 3 },
        { type: 'ANSWER_COPY', value: '—', plan: 'STANDARD', n: 2 },
        { type: 'FEEDBACK', value: 'helpful', plan: 'PREMIUM', n: 5 },
        { type: 'FEEDBACK', value: 'not_helpful', plan: 'PREMIUM', n: 1 },
      ]],
    ];
    const r = await getObservability({ domain: 'T2', days: 7 }, NOW);
    expect([val(r, 'usage_opens'), val(r, 'usage_primary_clicks'), val(r, 'usage_primary_click_rate')]).toEqual([12, 4, 40]);
    expect([val(r, 'usage_other_clicks'), val(r, 'usage_source_opens'), val(r, 'usage_source_open_rate')]).toEqual([1, 3, 30]);
    expect([val(r, 'usage_copies'), val(r, 'usage_feedback_positive'), val(r, 'usage_feedback_negative')]).toEqual([2, 5, 1]);
    expect(table(r, 't2_usage_by_plan')).toContainEqual({ plan: 'PREMIUM', opens: 12, clicks: 4, sources: 3, copies: 0, feedback: 6 });
    expect(calls.find((c) => /verebona_usage_events/.test(c.sql))!.sql).not.toMatch(/account|user/);
  });
});

