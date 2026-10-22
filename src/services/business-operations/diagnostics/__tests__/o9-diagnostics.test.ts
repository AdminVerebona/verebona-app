/**
 * Lot 47A — O9, BO diagnostic des Opérations : règles pures, service (SQL en
 * lecture seule, exécuteur simulé), alerte d'exploitation, tâche planifiée,
 * mode économique T2 (CDC Opérations V1 ch. 21, B23, C21, C25, C26.1,
 * C26.2, C27 ; F-191 à F-200 ; décisions PO Q8, Q9).
 *
 * Les comportements sur base réelle (chaque indicateur sur un jeu construit,
 * chaque anomalie dure, filtres, pagination, détail, READ ONLY) sont dans
 * `src/test/e2e/scenarios/l47a-o9-bo-diagnostic.e2e.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CORRECTION_PROCEDURE, DIAG_MAX_PAGE_SIZE, DIAG_MAX_PERIOD_DAYS, HARD_ANOMALY_CODES, HARD_ANOMALY_INDICATOR, INDICATORS, INDICATOR_KEYS,
  explainReason, indicativeNetCents, maskSensitive, parseHoldFilters, parseOperationListFilters, pct, principalDate,
  resolveDiagPeriod, typeLabel, type HardAnomalyResult,
} from '../model';
import { OperationDiagnosticsService, type DiagExecutor, type DiagQuery } from '../service';
import {
  OPERATIONS_ANOMALY_PREFIX, operationsAnomalyFingerprint, planQualityAlerts, runOperationsQualityCheck,
} from '../alerts';
import { economicModeOf, buildT2ObservabilityTrace } from '@/services/ai/telemetry/t2-observability';
import { buildFingerprint } from '@/services/admin/anomaly.service';

const ROOT = process.cwd();
const params = (o: Record<string, string>) => new URLSearchParams(o);

describe('O9-01 filtres de la liste (C26.1) — liste blanche, bornés', () => {
  it('valeurs admises', () => {
    const f = parseOperationListFilters(params({
      accountId: '12', type: 'CLAIM', status: 'REALIZED', state: 'merged', withoutAsset: '1', withoutSource: 'true',
      from: '2026-01-01', to: '2026-02-01', page: '3', pageSize: '50',
    }));
    expect(f).toEqual({
      accountId: 12, type: 'CLAIM', status: 'REALIZED', state: 'merged', withoutAsset: true, withoutSource: true,
      from: '2026-01-01', to: '2026-02-01', page: 3, pageSize: 50,
    });
  });

  it('type non qualifié, valeurs inconnues ignorées, page bornée', () => {
    const f = parseOperationListFilters(params({ type: 'NULL', status: 'X', state: "x'; DROP", accountId: '-1', from: '2026-13-45', pageSize: '100000' }));
    expect(f).toMatchObject({ type: 'NULL', status: null, state: 'all', accountId: null, from: null, page: 1, pageSize: DIAG_MAX_PAGE_SIZE });
    expect(parseOperationListFilters(params({ type: 'TCO' })).type).toBeNull();
  });

  it('candidats en attente : issue, motif (jeton) ou préfixe des erreurs techniques', () => {
    expect(parseHoldFilters(params({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED', accountId: '4' })))
      .toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED', accountId: 4 });
    expect(parseHoldFilters(params({ outcome: 'CREATE_NEW', reason: "a'b" }))).toMatchObject({ outcome: null, reason: null });
    expect(parseHoldFilters(params({ reason: 'TECHNICAL_ERROR:PARENT_CYCLE' })).reason).toBe('TECHNICAL_ERROR:PARENT_CYCLE');
  });
});

describe('O9-02 période des indicateurs', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  it('30 derniers jours par défaut (Paris), bornes remises dans l’ordre, 366 jours au plus', () => {
    expect(resolveDiagPeriod(null, null, now)).toEqual({ from: '2026-09-13', to: '2026-10-12', days: 30 });
    expect(resolveDiagPeriod('2026-10-05', '2026-10-01', now)).toEqual({ from: '2026-10-01', to: '2026-10-05', days: 5 });
    expect(resolveDiagPeriod('2020-01-01', '2026-10-12', now).days).toBe(DIAG_MAX_PERIOD_DAYS);
  });
});

describe('O9-03 / C26.1 raisons lisibles', () => {
  it('motifs de création / rapprochement / fusion en clair', () => {
    expect(explainReason('MATCH_M1')).toBe('référence métier identique');
    expect(explainReason('MATCH_M0')).toBe('arbitrage utilisateur');
    expect(explainReason('MATCH_M3')).toBe('comparaison sémantique certaine');
    expect(explainReason('REFERENCE QUOTE:DV42')).toBe('référence de devis identique');
    expect(explainReason('MATCH_MERGE')).toMatch(/fusion/);
    expect(explainReason('TECHNICAL_ERROR:PARENT_CYCLE')).toMatch(/erreur technique.*PARENT_CYCLE/);
    expect(explainReason('PROBABLE_WITHOUT_MATCH')).toMatch(/pas de création/);
    expect(explainReason('INCONNU_42')).toBe('INCONNU_42');
    expect(explainReason(null)).toBe('—');
    expect(typeLabel(null)).toBe('Type non qualifié');
    expect(typeLabel('DISPOSAL')).toBe('Cession / sortie de possession');
  });

  it('net indicatif (B23) : coûts réalisés − réductions / indemnités, sans prévisionnel ; devise non convertie signalée', () => {
    const c = (kind: string, amountMinor: number, currency = 'EUR', amountEurCents: number | null = null, active = true) =>
      ({ kind: kind as never, amountMinor, currency, amountEurCents, active });
    expect(indicativeNetCents([c('REALIZED_COST', 10_000), c('INDEMNITY', 3_000), c('FORECAST_COST', 99_999)])).toEqual({ cents: 7_000, partial: false });
    expect(indicativeNetCents([c('REALIZED_COST', 500, 'USD'), c('REALIZED_COST', 100)])).toEqual({ cents: 100, partial: true });
    expect(indicativeNetCents([c('FORECAST_COST', 100)])).toEqual({ cents: null, partial: false });
    expect(principalDate({ realizedDate: null, startDate: null, plannedDate: '2026-03-01', endDate: '2026-04-01' })).toBe('2026-03-01');
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 0)).toBeNull();
  });
});

describe('C26-01 les 13 indicateurs C26.2, exactement', () => {
  it('13 clés, libellés du CDC, lecture attendue', () => {
    expect(INDICATOR_KEYS.length).toBe(13);
    expect(INDICATORS.map((i) => i.key)).toEqual([...INDICATOR_KEYS]);
    // Libellés recopiés du tableau C26.2 (le CDC n'est pas versionné dans le dépôt).
    expect(INDICATORS.map((i) => i.label)).toEqual([
      'Opérations créées par jour / par source_kind',
      '% documents T1 produisant ≥ 1 candidat certain',
      '% candidats certains aboutissant CREATE vs MATCH',
      '% type_code null',
      '% OTHER',
      'Fusions dans les 7 jours suivant création',
      'Invalidations dans les 7 jours suivant création',
      'Opérations sans cible : 0-24h / 1-7j / 8-30j / >30j',
      'Sources en ambiguïté / À traiter',
      'Composantes sans source active',
      'Opérations actives sans source active',
      'Liens cross-account / cycles parent',
      'T2 réponses économiques Operation-only / mixtes / fallback-only',
    ]);
    expect(INDICATORS.filter((i) => i.hard).map((i) => i.key)).toEqual(['componentsWithoutActiveSource', 'activeWithoutActiveSource', 'crossAccountOrParentCycles']);
  });

  it('anomalies dures : les 4 de C26.2 / ACC-022 portées par un indicateur, + contrôles complémentaires', () => {
    expect(HARD_ANOMALY_CODES).toEqual([
      'ACTIVE_OPERATION_WITHOUT_SOURCE', 'ACTIVE_COMPONENT_WITHOUT_SOURCE', 'CROSS_ACCOUNT_LINK', 'PARENT_CYCLE',
      'PARENT_DEPTH_EXCEEDED', 'NEGATIVE_COMPONENT', 'OTHER_AS_FALLBACK',
      // Lot 54D (§4.5, E01) : contrôles financiers et reprises T3 épuisées.
      'FIN_INDEMNITY_DUPLICATED', 'FIN_PRINCIPAL_AS_COST', 'T3_TECHNICAL_ERROR_EXHAUSTED',
      // Lot 78A (§5, §6) : doutes d'identité signalés, attributs contradictoires.
      'IDENTITY_SUSPECT_ATTACHMENT', 'IDENTITY_ATTRIBUTE_CONFLICT',
    ]);
    expect(Object.values(HARD_ANOMALY_INDICATOR).filter(Boolean).length).toBe(4);
    expect(CORRECTION_PROCEDURE).toMatch(/ne modifie jamais/);
    expect(CORRECTION_PROCEDURE).toMatch(/File IA/);
  });
});

describe('O9-04 / C25 masquage : rien au-delà de ce que le BO montre déjà', () => {
  it('IBAN masqué, noms de fichier et URL retirés, en profondeur', () => {
    const out = maskSensitive({
      summary: 'Virement sur FR76 3000 6000 0112 3456 7890 189 reçu',
      locator: { page: 2, filename: 'facture-dupont.pdf', nested: [{ iban: 'FR7630006000011234567890189' }] },
      n: 3,
    });
    expect(JSON.stringify(out)).not.toMatch(/3000 6000 0112|dupont|7630006000011234567890189/);
    expect(out.summary).toMatch(/FR76 •••• \(IBAN masqué\)/);
    expect(out.locator.page).toBe(2);
    expect(out.n).toBe(3);
  });
});

// ── Service : exécuteur simulé ─────────────────────────────────────────────

function fakeExecutor(answer: (sql: string) => Record<string, unknown>[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const q: DiagQuery = async (sql, params = []) => { calls.push({ sql, params }); return answer(sql); };
  const exec: DiagExecutor = async (fn) => fn(q);
  return { calls, exec };
}
const WRITE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|CREATE\s+(TABLE|INDEX|UNIQUE))/i;

describe('O9-05 service : lectures seules, bornées, paramétrées', () => {
  it('liste : filtres en paramètres ($n), LIMIT/OFFSET, tri stable, aucune écriture', async () => {
    const { calls, exec } = fakeExecutor((sql) => (sql.includes('count(*)::int AS n') ? [{ n: 51 }] : []));
    const r = await new OperationDiagnosticsService(exec).list(parseOperationListFilters(params({ accountId: '7', type: 'NULL', state: 'active', withoutAsset: '1', page: '3' })));
    expect(r).toMatchObject({ total: 51, page: 3, pageSize: 25, totalPages: 3, items: [] });
    const list = calls[1].sql;
    expect(list).toMatch(/o\.account_id = \$1/);
    expect(list).toMatch(/o\.type_code IS NULL/);
    expect(list).toMatch(/LIMIT 25 OFFSET 50/);
    expect(list).toMatch(/ORDER BY o\.created_at DESC, o\.id DESC/);
    expect(calls[1].params).toEqual([7]);
    for (const c of calls) expect(c.sql).not.toMatch(WRITE);
  });

  it('indicateurs + anomalies dures : uniquement des SELECT / WITH, filtre compte paramétré', async () => {
    const { calls, exec } = fakeExecutor();
    const report = await new OperationDiagnosticsService(exec).indicators({ from: '2026-09-01', to: '2026-09-30', days: 30 }, 42);
    expect(report.indicators.map((i) => i.key)).toEqual([...INDICATOR_KEYS]);
    expect(report.anomalies.map((a) => a.code)).toEqual([...HARD_ANOMALY_CODES]);
    expect(report.hardAnomalyTotal).toBe(0);
    for (const c of calls) {
      expect(c.sql.trim()).toMatch(/^(SELECT|WITH)\b/);
      expect(c.sql).not.toMatch(WRITE);
      expect(c.params).toContain(42);
    }
  });

  it('détail inconnu → null ; route de lecture par l’index de l’Opération', async () => {
    const { calls, exec } = fakeExecutor();
    expect(await new OperationDiagnosticsService(exec).detail(99)).toBeNull();
    expect(calls[0].sql).toMatch(/WHERE o\.id = \$1/);
  });

  it('session par défaut : transaction READ ONLY et statement_timeout côté base', () => {
    const src = readFileSync(join(ROOT, 'src/services/business-operations/diagnostics/service.ts'), 'utf8');
    expect(src).toMatch(/pgClient\.begin\('read only'/);
    expect(src).toMatch(/SET LOCAL statement_timeout/);
    expect(src).not.toMatch(/from '@\/services\/business-operations\/(write|repository)'|from '\.\.\/(write|repository)'/);
  });
});

// ── Alerte d'exploitation (C26.2 : « alerte technique ») ───────────────────

const anomaly = (code: HardAnomalyResult['code'], count: number, accountIds: number[] = []): HardAnomalyResult => ({
  code, label: code, count, accountIds, samples: accountIds.map((a) => ({ accountId: a, operationId: a * 10, detail: 'x' })),
});

describe('O9-06 / C26.2 alerte d’exploitation sur anomalie dure (modèle des alertes existantes)', () => {
  it('empreinte = forme `buildFingerprint` du domaine « other »', () => {
    expect(operationsAnomalyFingerprint('PARENT_CYCLE')).toBe(buildFingerprint('other', 'business-operations', 'PARENT_CYCLE'));
    expect(operationsAnomalyFingerprint('PARENT_CYCLE').startsWith(OPERATIONS_ANOMALY_PREFIX)).toBe(true);
  });

  it('plan : signaler les codes non nuls, résoudre les seules empreintes Opérations revenues à 0', () => {
    const plan = planQualityAlerts(
      [anomaly('PARENT_CYCLE', 2, [5]), anomaly('CROSS_ACCOUNT_LINK', 0)],
      [operationsAnomalyFingerprint('CROSS_ACCOUNT_LINK'), operationsAnomalyFingerprint('PARENT_CYCLE'), 'other:autre-chose'],
    );
    expect(plan.toReport.map((a) => a.code)).toEqual(['PARENT_CYCLE']);
    expect(plan.toResolve).toEqual([operationsAnomalyFingerprint('CROSS_ACCOUNT_LINK')]);
  });

  it('exécution : un signalement par code (compte unique rattaché, lien BO, procédure), résolution automatique', async () => {
    const report = vi.fn(async () => 1);
    const resolve = vi.fn(async () => true);
    const r = await runOperationsQualityCheck({
      detect: async () => [anomaly('ACTIVE_OPERATION_WITHOUT_SOURCE', 1, [9]), anomaly('NEGATIVE_COMPONENT', 0)],
      openFingerprints: async () => [operationsAnomalyFingerprint('NEGATIVE_COMPONENT')],
      report, resolve,
    });
    expect(r).toMatchObject({ reported: 1, resolved: 1 });
    expect(r.counts.ACTIVE_OPERATION_WITHOUT_SOURCE).toBe(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'other', accountId: 9, fingerprint: operationsAnomalyFingerprint('ACTIVE_OPERATION_WITHOUT_SOURCE'),
      detail: expect.objectContaining({ boLink: '/admin/operations?tab=indicateurs&accountId=9', procedure: CORRECTION_PROCEDURE }),
    }));
    expect(resolve).toHaveBeenCalledWith(operationsAnomalyFingerprint('NEGATIVE_COMPONENT'));
  });

  it('tâche planifiée interne quotidienne (pas de cron externe), lecture seule, non critique', async () => {
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = findTask('operations-quality-check');
    expect(t).toMatchObject({ schedule: { kind: 'daily', at: [6, 50] } });
    expect(t?.critical).toBeUndefined();
  });
});

// ── T2 : réponses économiques (indicateur C26.2 n° 13) ─────────────────────

describe('C26-13 T2 réponses économiques Operation-only / mixtes / fallback-only', () => {
  const exp = (meta: Record<string, unknown>) => ({ id: 'expenses:all:account', type: 'document_extraction', meta });
  it('classement par stratégie et métadonnées des sources (jamais leur contenu)', () => {
    expect(economicModeOf('structured.operation_cost', [])).toBe('operation_only');
    expect(economicModeOf('structured.contracts', [])).toBe('operation_only');
    expect(economicModeOf('structured.sum_amounts', [{ type: 'document' }])).toBe('fallback_only');
    expect(economicModeOf('structured.sum_qualified', [exp({ operationCount: 2, documentFallbackCents: 0 })])).toBe('operation_only');
    expect(economicModeOf('structured.sum_qualified', [exp({ operationCount: 2, documentFallbackCents: 4500 })])).toBe('mixed');
    expect(economicModeOf('structured.sum_qualified', [exp({ documentCount: 3 })])).toBe('fallback_only');
    expect(economicModeOf('structured.sum_qualified', [exp({ documentCount: 0 })])).toBeNull();
    expect(economicModeOf('structured.acquisition_price', [{ type: 'asset_field', meta: { operationKind: 'achat' } }])).toBe('operation_only');
    expect(economicModeOf('structured.acquisition_price', [{ type: 'asset_field', meta: {} }])).toBe('fallback_only');
    expect(economicModeOf('structured.payments', [{ type: 'document', meta: { fileId: 3 } }])).toBe('fallback_only');
    expect(economicModeOf('retrieval.document', [{ type: 'document' }])).toBeNull();
    expect(economicModeOf(undefined)).toBeNull();
  });

  it('trace : `economicMode` seulement pour une réponse économique', () => {
    expect(buildT2ObservabilityTrace({ strategy: 'structured.operation_cost', sources: [] }).economicMode).toBe('operation_only');
    expect('economicMode' in buildT2ObservabilityTrace({ strategy: 'retrieval.document', sources: [] })).toBe(false);
  });
});

// ── F-191 à F-200 (observabilité / architecture, C29) ──────────────────────

function fichiers(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return n === 'node_modules' || n === '__tests__' ? [] : fichiers(f);
    return /\.(ts|tsx)$/.test(n) ? [f] : [];
  });
}

describe('F-191 à F-200 — observabilité sans interrupteur ni réparation', () => {
  const diag = fichiers(join(ROOT, 'src/services/business-operations/diagnostics'));
  const routes = fichiers(join(ROOT, 'src/app/api/admin/operations'));
  const pages = fichiers(join(ROOT, 'src/app/admin/operations'));

  it('F-194 type inconnu en hausse : métrique (% null) — aucun repli automatique vers OTHER', async () => {
    const { resolveOperationTypeInput, normalizeOperationTypeHint } = await import('../../model');
    expect(normalizeOperationTypeHint('INCONNU')).toBeNull();
    expect(() => resolveOperationTypeInput({ code: 'OTHER' } as never)).toThrow();
    expect(INDICATORS.find((i) => i.key === 'typeNull')?.reading).toMatch(/pas d’auto-correction/);
  });

  it('F-195 pic de créations : visible au BO (par jour / source_kind), le système reste actif (aucun seuil d’arrêt)', () => {
    expect(INDICATORS[0].key).toBe('createdPerDayBySourceKind');
    for (const f of [...diag, ...routes, ...pages]) {
      expect(readFileSync(f, 'utf8'), relative(ROOT, f)).not.toMatch(/emergencyStop|setTreatmentState|suspend\w*\(|disable\w*\(/);
    }
  });

  it('F-196 / F-197 / Q8 : ni interrupteur OPERATIONS_ENABLED ni mode shadow dans le diagnostic', () => {
    for (const f of [...diag, ...routes, ...pages]) {
      expect(readFileSync(f, 'utf8'), relative(ROOT, f)).not.toMatch(/OPERATIONS?_ENABLED|SHADOW/i);
    }
  });

  it('F-198 : le diagnostic ne lit jamais `ai_operations`', () => {
    for (const f of diag) expect(readFileSync(f, 'utf8')).not.toMatch(/\bai_operations?\b/);
  });

  it('F-182 / INV-032 / Q9 : aucune écriture métier depuis le diagnostic (service, routes, pages)', () => {
    for (const f of [...diag.filter((x) => !x.endsWith('alerts.ts')), ...routes, ...pages]) {
      const src = readFileSync(f, 'utf8');
      expect(src, relative(ROOT, f)).not.toMatch(WRITE);
      expect(src, relative(ROOT, f)).not.toMatch(/business-operations\/(write|repository)|withBusinessOperationWrite/);
    }
    // L'alerte n'écrit que la Supervision (anomaly.service), jamais une Opération.
    const alerts = readFileSync(join(ROOT, 'src/services/business-operations/diagnostics/alerts.ts'), 'utf8');
    expect(alerts).not.toMatch(/business_operation\w*\s+SET|INSERT INTO business_operation/);
  });

  it('F-191 / F-192 / F-193 / F-200 : motifs HOLD, décisions REJECTED et sources supersédées exposés au détail', () => {
    const svc = readFileSync(join(ROOT, 'src/services/business-operations/diagnostics/service.ts'), 'utf8');
    expect(svc).toMatch(/FROM business_operation_match_decisions WHERE candidate_operation_id = \$1/);
    expect(svc).toMatch(/s\.active, s\.superseded_at/);
    expect(svc).toMatch(/c\.t3_outcome IN \('HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED'\)/);
    expect(explainReason('PROBABLE_WITHOUT_MATCH')).toMatch(/pas de création/);
    expect(explainReason('M3_AMBIGUOUS')).toMatch(/arbitrage/);
  });

  it('F-199 : un candidat T1 au-delà de 20 événements reste borné (garde T1 existante, lot 40)', () => {
    const t1 = readFileSync(join(ROOT, 'src/services/ai/source-analysis/operation-candidates/__tests__/c3-candidats-t1.test.ts'), 'utf8');
    expect(t1).toMatch(/F-199 — au plus 20 candidats/);
  });
});
