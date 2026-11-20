/**
 * Carte #802 — export diagnostic en ZIP unique (tests unitaires, purs).
 *
 *   C802-U-01  sélection : lecture STRICTE des filtres de l'écran — un filtre
 *              inconnu, illisible ou sans traduction bloque (jamais ignoré)
 *   C802-U-02  filtres de l'onglet « Appels modèles » : même traduction que la
 *              route de la liste (une seule fonction)
 *   C802-U-03  limites techniques : un seul point de réglage, défauts prudents,
 *              borne absolue de l'envoi ; message de refus exact de la carte
 *   C802-U-04  index CSV, plan de l'archive unique, périmètre des appels autonomes
 *   C802-U-05  manifeste : filtres exacts, omissions motivées et distinguées,
 *              statut honnête (appels autonomes compris)
 *   C802-U-06  période de plus de 90 jours : détectée (l'export refuse)
 *   C802-U-07  une seule archive remise, jamais sans vérification ni après échec
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExportSelection, unsupportedMessage } from '../export-selection';
import {
  EXECUTIONS_EXPORT_ENV, SELECTION_TOO_LARGE_MESSAGE, ZIP_OBJECT_HARD_MAX_BYTES, executionsExportLimits, formatBytes, formatDuration, limitBreach,
} from '../export-settings';
import {
  INDEX_COLUMNS, INDEX_HEADER, buildManifest, emptyTotals, exportReadme, exportStatus, indexRowOfAutonomousCall, indexRowOfExecution, initialResumeState,
  parseIndexRow, planArchive, zipPathOf, type ExportPerimeter,
} from '../export-model';
import { periodExceedsMax } from '../period';
import { executionApiFilters } from '../../telemetry/execution-filters';
import type { BusinessExecutionDto } from '../dto';

const NOW = new Date('2026-11-17T10:00:00.000Z');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const keys = (r: ReturnType<typeof parseExportSelection>) => (r.ok ? [] : r.unsupported.map((u) => u.key));
const perimeter = (o: Partial<ExportPerimeter> = {}): ExportPerimeter => ({
  params: { days: '7', nature: 'BUSINESS' }, from: '2026-11-10T10:00:00.000Z', to: '2026-11-17T10:00:00.001Z', rule: 'r', timeZone: 'Europe/Paris',
  treatment: null, outcome: null, nature: 'BUSINESS', origin: null, accountId: null, sensitiveContent: false, fingerprint: 'f', scope: 'executions', ...o,
});
const dto = (o: Partial<BusinessExecutionDto> = {}): BusinessExecutionDto => ({
  id: 'T4:42', treatment: 'T4', mode: null, nature: 'BUSINESS', natureLabel: 'Métier', origin: 'AUTOMATIC', originLabel: 'automatique',
  outcome: 'SUCCEEDED', progress: null, label: 'Réussie', native: { source: 'ai_job_queue', status: 'DONE' }, cause: null, accountId: 7, objectType: 'asset', objectId: 'a;"b"',
  triggeredAt: NOW.toISOString(), startedAt: null, finishedAt: NOW.toISOString(), lastActivityAt: NOW.toISOString(), referenceAt: NOW.toISOString(), resumptions: 0,
  previousExecutionId: null, jobIds: [42], reportIds: [], traceIds: [], calls: null, ...o,
});

describe('C802-U-01 — sélection stricte : jamais un export plus large ou plus étroit', () => {
  it('journal des exécutions : filtres valides acceptés et rendus tels qu’appliqués', () => {
    const r = parseExportSelection({ scope: 'executions', days: '30', treatment: 'T1', outcome: 'FAILED', nature: 'all', origin: 'USER', accountId: 12, contenusSensibles: true, action: 'precheck' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selection.scope).toBe('executions');
    expect(r.selection.params).toEqual({ days: '30', treatment: 'T1', outcome: 'FAILED', nature: 'all', origin: 'USER', accountId: '12' });
    if (r.selection.scope === 'executions') expect(r.selection.journal).toMatchObject({ treatment: 'T1', outcome: 'FAILED', nature: null, origin: 'USER', accountId: 12 });
  });
  it('périmètre absent = journal ; valeurs vides = filtre absent (comme l’écran)', () => {
    const r = parseExportSelection({ treatment: '', outcome: null, accountId: undefined }, NOW);
    expect(r.ok && r.selection.scope).toBe('executions');
    expect(r.ok && r.selection.params).toEqual({ nature: 'BUSINESS' });
  });
  it('valeur que l’écran IGNORERAIT (export plus large) : bloquée, nommée', () => {
    expect(keys(parseExportSelection({ treatment: 'T9' }, NOW))).toEqual(['treatment']);
    expect(keys(parseExportSelection({ outcome: 'PERDU' }, NOW))).toEqual(['outcome']);
    expect(keys(parseExportSelection({ nature: 'metier' }, NOW))).toEqual(['nature']);
    expect(keys(parseExportSelection({ origin: 'robot' }, NOW))).toEqual(['origin']);
    expect(keys(parseExportSelection({ accountId: '12a' }, NOW))).toEqual(['accountId']);
    expect(keys(parseExportSelection({ accountId: { $ne: 1 } }, NOW))).toEqual(['accountId']);
    expect(keys(parseExportSelection({ days: '0' }, NOW))).toEqual(['days']);
    expect(keys(parseExportSelection({ days: '120' }, NOW))).toEqual(['days']);
    expect(keys(parseExportSelection({ from: '2026-02-31' }, NOW))).toEqual(['from']);
    expect(keys(parseExportSelection({ days: '7', from: '2026-11-01' }, NOW))).toEqual(['days']);
  });
  it('filtre d’un autre onglet ou inconnu : bloqué (jamais ignoré), avec la marche à suivre', () => {
    const r = parseExportSelection({ scope: 'executions', model: 'm-1', jobId: '4', inconnu: 'x' }, NOW);
    expect(keys(r).sort()).toEqual(['inconnu', 'jobId', 'model']);
    expect(!r.ok && r.unsupported.find((u) => u.key === 'model')?.reason).toMatch(/onglet « Appels modèles »/);
    expect(keys(parseExportSelection({ scope: 'calls', outcome: 'FAILED', origin: 'USER', days: '7' }, NOW)).sort()).toEqual(['days', 'origin', 'outcome']);
  });
  it('onglets sans traduction (Requêtes T2, Rapports…) : bloqués et nommés ; périmètre inconnu : bloqué', () => {
    for (const [tab, label] of [['t2', 'Requêtes T2'], ['reports', 'Rapports'], ['completeness', 'Complétude T1'], ['qualification', 'Qualification'], ['schemas', 'Schémas'], ['archives', 'Archives']]) {
      const r = parseExportSelection({ scope: tab, accountId: '1' }, NOW);
      expect(keys(r)).toEqual(['scope']);
      expect(!r.ok && r.unsupported[0].reason).toContain(`« ${label} »`);
    }
    expect(keys(parseExportSelection({ scope: 'tout' }, NOW))).toEqual(['scope']);
    expect(keys(parseExportSelection({ scope: 42 }, NOW))).toEqual(['scope']);
  });
  it('message de blocage : chaque filtre, sa valeur, son motif ; « aucun export n’a été lancé »', () => {
    const r = parseExportSelection({ treatment: 'T9' }, NOW);
    expect(!r.ok && unsupportedMessage(r.unsupported)).toBe('Export impossible avec ces filtres : treatment = « T9 » — traitement inconnu. Aucun export n’a été lancé.');
  });
});

describe('C802-U-02 — onglet « Appels modèles » : une seule traduction des filtres', () => {
  const filtres = { treatment: 'T4', accountId: '7', userId: '3', model: 'gemini-x', rank: 'fallback', configVersionId: '12', operationCode: 't4_classify_event', jobId: '99', from: '2026-11-01', to: '2026-11-15', minDurationMs: '500', status: 'error', objectType: 'asset', objectId: 'a:1', trigger: 'source_analyzed', t6Mode: 'displayed', errorsOnly: '1' };
  it('tous les filtres de l’écran sont pris en charge et rendus identiques', () => {
    const r = parseExportSelection({ scope: 'calls', ...filtres }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || r.selection.scope !== 'calls') return;
    expect(r.selection.params).toEqual(filtres);
    expect(r.selection.calls).toEqual(executionApiFilters(new URLSearchParams(filtres)));
    expect(r.selection.calls).toMatchObject({
      treatment: 'T4', accountId: 7, userId: 3, model: 'gemini-x', rank: 'fallback', configVersionId: 12, operationCode: 't4_classify_event', jobId: 99, minDurationMs: 500,
      status: 'error', objectType: 'asset', objectId: 'a:1', trigger: 'source_analyzed', t6Mode: 'displayed', errorsOnly: true,
    });
    // Bornes de l'écran : jours UTC, fin de journée incluse.
    expect(r.selection.calls.since?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(r.selection.calls.until?.toISOString()).toBe('2026-11-15T23:59:59.999Z');
  });
  it('valeur que l’écran n’applique pas : bloquée', () => {
    expect(keys(parseExportSelection({ scope: 'calls', status: 'timeout' }, NOW))).toEqual(['status']);
    expect(keys(parseExportSelection({ scope: 'calls', rank: 'tertiaire' }, NOW))).toEqual(['rank']);
    expect(keys(parseExportSelection({ scope: 'calls', jobId: 'abc' }, NOW))).toEqual(['jobId']);
    expect(keys(parseExportSelection({ scope: 'calls', treatment: 'T5' }, NOW))).toEqual(['treatment']);
    expect(keys(parseExportSelection({ scope: 'calls', errorsOnly: 'oui' }, NOW))).toEqual(['errorsOnly']);
    expect(parseExportSelection({ scope: 'calls', errorsOnly: true }, NOW)).toMatchObject({ ok: true, selection: { params: { errorsOnly: '1' } } });
    expect(parseExportSelection({ scope: 'calls', errorsOnly: false }, NOW)).toMatchObject({ ok: true, selection: { params: {} } });
  });
  it('la route de la liste et l’export partagent `executionApiFilters` et `executionWhere` (aucune seconde traduction)', () => {
    const route = read('src/app/api/admin/ai/executions/route.ts');
    expect(route).toContain('...executionApiFilters(p)');
    const repo = read('src/services/ai/telemetry/execution-log.repository.ts');
    expect(repo).toContain('const { where, params } = executionWhere(f);');
    const exp = read('src/services/ai/business-execution/export.ts');
    expect((exp.match(/executionWhere\(/g) ?? []).length).toBe(2); // précontrôle et génération
    expect(exp).not.toMatch(/e\.model = \$|e\.operation_code = \$|e\.user_id = \$/);
  });
});

describe('C802-U-03 — limites techniques : un point de réglage, message exact', () => {
  it('défauts prudents ; variables d’environnement facultatives ; valeurs illisibles ignorées', () => {
    expect(executionsExportLimits({})).toEqual({ maxZipBytes: 2 * 1024 ** 3, maxRawBytes: 8 * 1024 ** 3, maxDurationMs: 2 * 3600_000, precheckBudgetMs: 20_000 });
    expect(executionsExportLimits({ [EXECUTIONS_EXPORT_ENV.maxZipBytes]: '1048576', [EXECUTIONS_EXPORT_ENV.maxRawBytes]: 'beaucoup', [EXECUTIONS_EXPORT_ENV.maxDurationMs]: '-5' }))
      .toMatchObject({ maxZipBytes: 1_048_576, maxRawBytes: 8 * 1024 ** 3, maxDurationMs: 2 * 3600_000 });
  });
  it('le ZIP ne dépasse jamais la borne absolue de l’envoi (10 000 parties de 8 Mio), quel que soit le réglage', () => {
    expect(ZIP_OBJECT_HARD_MAX_BYTES).toBe(10_000 * 8 * 1024 * 1024);
    expect(executionsExportLimits({ [EXECUTIONS_EXPORT_ENV.maxZipBytes]: String(10 ** 15) }).maxZipBytes).toBe(ZIP_OBJECT_HARD_MAX_BYTES);
  });
  it('aucun plafond en nombre d’exécutions ; aucune limite en dur hors du point de réglage', () => {
    expect(Object.keys(executionsExportLimits({})).sort()).toEqual(['maxDurationMs', 'maxRawBytes', 'maxZipBytes', 'precheckBudgetMs']);
    const exp = read('src/services/ai/business-execution/export.ts');
    expect(exp).not.toMatch(/maxExecutions|MAX_EXECUTIONS|EXPORT_VOLUME_MAX_BYTES/);
    expect(read('src/services/ai/business-execution/export-model.ts')).not.toMatch(/EXPORT_VOLUME_MAX_BYTES|planVolumes/);
  });
  it('message de la carte, mot pour mot, suivi de la cause et de la limite concrète', () => {
    expect(SELECTION_TOO_LARGE_MESSAGE).toBe('Sélection trop volumineuse. Réduisez la période ou affinez les filtres (traitement, compte, statut)');
    const l = executionsExportLimits({});
    expect(limitBreach('RAW_BYTES', 9 * 1024 ** 3, l)).toMatchObject({ code: 'RAW_BYTES', measured: 9 * 1024 ** 3, limit: l.maxRawBytes, cause: 'volume de données 9 Gio avant compression au-delà de la limite de 8 Gio (AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES)' });
    expect(limitBreach('ZIP_BYTES', 3 * 1024 ** 3, l).cause).toBe('archive ZIP de 3 Gio au-delà de la limite de 2 Gio (AI_EXECUTIONS_EXPORT_MAX_ZIP_BYTES)');
    expect(limitBreach('DURATION', 1, l).cause).toBe('génération au-delà de la durée maximale de 2 h (AI_EXECUTIONS_EXPORT_MAX_DURATION_MS)');
    expect(limitBreach('PRECHECK_BUDGET', 1, l).cause).toContain('délai du précontrôle de 20 s (AI_EXECUTIONS_EXPORT_PRECHECK_BUDGET_MS)');
    expect(limitBreach('PROJECTION_CAP', null, l)).toMatchObject({ limit: null, cause: expect.stringContaining('plafond de lecture de la projection') });
    expect(formatBytes(1536)).toBe('1,5 Kio');
    expect(formatBytes(12)).toBe('12 octets');
    expect(formatDuration(90 * 60_000)).toBe('1 h 30 min');
  });
});

describe('C802-U-04 — index CSV, archive unique, appels autonomes', () => {
  it('index : une ligne par exécution, cellules échappées, relues à l’identique ; chemins de l’archive (sans .gz)', () => {
    expect(INDEX_HEADER.split(';')).toEqual([...INDEX_COLUMNS]);
    const line = indexRowOfExecution(dto(), { file: 'executions/executions.part-0001.jsonl.gz', line: 3, diagnostics: 'diagnostics/diagnostics.part-0001.jsonl.gz', callsFile: 'appels/appels.part-0001.jsonl.gz', firstCallLine: 5, calls: 2 });
    const c = parseIndexRow(line);
    expect(c).toHaveLength(INDEX_COLUMNS.length);
    expect(c.slice(0, 11)).toEqual(['EXECUTION', 'T4:42', 'T4', '', 'BUSINESS', 'SUCCEEDED', 'AUTOMATIC', '7', 'asset', 'a;"b"', NOW.toISOString()]);
    expect(c.slice(11)).toEqual(['2', 'executions/executions.part-0001.jsonl', '3', 'diagnostics/diagnostics.part-0001.jsonl', 'appels/appels.part-0001.jsonl', '5']);
    // Sans appel : ni fichier d'appels ni ligne (vide, jamais zéro inventé).
    const sans = parseIndexRow(indexRowOfExecution(dto(), { file: 'e.gz', line: 1, diagnostics: 'd.gz', callsFile: 'a.gz', firstCallLine: null, calls: 0 }));
    expect(sans.slice(11)).toEqual(['0', 'e', '1', 'd', '', '']);
    expect(zipPathOf('appels-autonomes/appels-autonomes.part-0002.jsonl.gz')).toBe('appels-autonomes/appels-autonomes.part-0002.jsonl');
  });
  it('appel autonome : jamais une ligne EXECUTION, identifiant distinct', () => {
    const c = parseIndexRow(indexRowOfAutonomousCall({ id: 91, classe: 'TECHNIQUE', accountId: null, createdAt: NOW.toISOString(), operationCode: 'model_operational_probe' }, { file: 'appels-autonomes/appels-autonomes.part-0001.jsonl.gz', line: 1 }));
    expect(c.slice(0, 5)).toEqual(['APPEL_AUTONOME', 'appel:91', '', 'model_operational_probe', 'TECHNIQUE']);
    expect(c[5]).toBe('');
  });
  it('archive unique : documents en tête, chaque fichier de données une fois, index intermédiaires exclus', () => {
    const f = (kind: 'executions' | 'appels' | 'diagnostics' | 'autonomes' | 'index', part: number, path: string) => ({ path, kind, part, bytes: 10, compressedBytes: 5, sha256: 's' });
    const plan = planArchive([
      f('index', 1, 'index/index.part-0001.csv.gz'), f('diagnostics', 1, 'diagnostics/diagnostics.part-0001.jsonl.gz'), f('executions', 2, 'executions/executions.part-0002.jsonl.gz'),
      f('executions', 1, 'executions/executions.part-0001.jsonl.gz'), f('autonomes', 3, 'appels-autonomes/appels-autonomes.part-0003.jsonl.gz'), f('appels', 1, 'appels/appels.part-0001.jsonl.gz'),
    ], [{ path: 'manifest.json', storedPath: 'zip/manifest.json.gz', bytes: 1, compressedBytes: 1, sha256: 'm' }, { path: 'index.csv', storedPath: 'zip/index.csv.gz', bytes: 1, compressedBytes: 1, sha256: 'i' }, { path: 'LISEZMOI.txt', storedPath: 'zip/LISEZMOI.txt.gz', bytes: 1, compressedBytes: 1, sha256: 'l' }]);
    expect(plan.map((e) => e.path)).toEqual([
      'index.csv', 'manifest.json', 'LISEZMOI.txt', 'executions/executions.part-0001.jsonl', 'executions/executions.part-0002.jsonl', 'appels/appels.part-0001.jsonl',
      'diagnostics/diagnostics.part-0001.jsonl', 'appels-autonomes/appels-autonomes.part-0003.jsonl',
    ]);
  });
  it('appels techniques autonomes : dans le périmètre technique sans filtre d’exécution ; sinon exclus AVEC motif', async () => {
    const { autonomousCallsScope, autonomousCallLine } = await import('../export');
    expect(autonomousCallsScope({ nature: 'TECHNICAL', treatment: null, outcome: null, origin: null }).included).toBe(true);
    expect(autonomousCallsScope({ nature: null, treatment: null, outcome: null, origin: null }).included).toBe(true);
    expect(autonomousCallsScope({ nature: 'BUSINESS', treatment: null, outcome: null, origin: null })).toMatchObject({ included: false, reason: expect.stringContaining('vue métier') });
    expect(autonomousCallsScope({ nature: 'TECHNICAL', treatment: 'T1', outcome: 'FAILED', origin: null })).toMatchObject({ included: false, reason: expect.stringContaining('traitement, issue') });
    // Ligne d'un appel autonome : identité préservée, aucune exécution inventée, absence de capture dite.
    const l = autonomousCallLine({ id: 5, use_case_code: 'AI_GOVERNANCE', operation_code: 'provider_test', business_execution_id: null, history_execution_id: null, shared_execution_ids: null, model: 'm' }, null, true);
    expect(l).toMatchObject({ type: 'APPEL_AUTONOME', classe: 'TECHNIQUE', businessExecutionId: null, id: 5, operation_code: 'provider_test', echange: { $etat: 'absent' } });
    expect('business_execution_id' in l).toBe(false);
    expect(autonomousCallLine({ id: 6, use_case_code: 'DOCUMENT_ANALYSIS' }, null, false)).toMatchObject({ classe: 'NON_RATTACHE', businessExecutionId: null });
    expect(autonomousCallLine({ id: 7, use_case_code: 'DOCUMENT_ANALYSIS' }, null, false, 'T1:job:9')).toMatchObject({ classe: 'EXECUTION_INTROUVABLE', businessExecutionId: 'T1:job:9' });
  });
});

describe('C802-U-05 — manifeste : filtres exacts, omissions distinguées, statut honnête', () => {
  const extra = { generatedAt: 'a', finishedAt: 'b', environment: 'preprod', build: { version: '1.2.3', commit: 'abc123' } };
  it('filtres exacts, environnement, version, limites, précontrôle ; omissions motivées (inexistant / non exporté / masqué)', () => {
    const st = initialResumeState(perimeter(), NOW);
    st.done = true;
    st.limits = executionsExportLimits({});
    st.precontrol = { at: NOW.toISOString(), executions: 3, calls: 4, autonomousCalls: 0, estimatedRawBytes: 100 };
    st.omissions = [{ what: 'Appels techniques autonomes (sondes, qualification, tests)', status: 'NON_APPLICABLE', reason: 'vue métier' }];
    const m = buildManifest('g-1', st, { ...extra, archiveEntries: ['index.csv', 'manifest.json', 'LISEZMOI.txt'] });
    expect(m).toMatchObject({
      schema: 'verebona.ai-executions-export/2', environment: 'preprod', build: { version: '1.2.3', commit: 'abc123' }, status: 'COMPLETE',
      selection: { scope: 'executions', filters: { days: '7', nature: 'BUSINESS' }, sensitiveContent: false }, precontrol: { executions: 3 },
      limits: { maxZipBytes: 2 * 1024 ** 3 }, archive: { fileName: 'verebona-diagnostic-executions-ia-g-1.zip', entries: ['index.csv', 'manifest.json', 'LISEZMOI.txt'] },
    });
    expect('volumes' in m).toBe(false);
    expect(new Set(m.omissions.map((o) => o.status))).toEqual(new Set(['NON_EXPORTE', 'INEXISTANT', 'MASQUE', 'NON_APPLICABLE']));
    expect(m.omissions.every((o) => o.what && o.reason)).toBe(true);
    const txt = exportReadme(m);
    expect(txt).toContain('CONTENU DE L’ARCHIVE (un seul ZIP)');
    expect(txt).toContain('[NON_APPLICABLE] Appels techniques autonomes (sondes, qualification, tests) : vue métier');
    expect(txt).toContain('commit abc123');
    expect(txt).not.toMatch(/volume/i);
  });
  it('export avec contenus : plus d’omission « masqué » générale ; opposition toujours dite', () => {
    const st = initialResumeState(perimeter({ sensitiveContent: true }), NOW);
    st.done = true;
    const m = buildManifest('g', st, extra);
    expect(m.omissions.some((o) => o.what === 'Contenu des échanges IA')).toBe(false);
    expect(m.omissions.some((o) => o.status === 'MASQUE' && /opposés/.test(o.what))).toBe(true);
  });
  it('périmètre « appels » : filtres d’appels au manifeste, jours UTC annoncés', () => {
    const st = initialResumeState(perimeter({ scope: 'calls', timeZone: 'UTC', nature: null, params: { model: 'm' } }), NOW);
    st.callParams = { model: 'm', status: 'error' };
    st.done = true;
    const m = buildManifest('g', st, extra);
    expect(m.selection).toEqual({ scope: 'calls', filters: { model: 'm', status: 'error' }, sensitiveContent: false });
    expect(m.period).toMatchObject({ timeZone: 'UTC', note: expect.stringContaining('date de création') });
  });
  it('statut : un écart sur les appels autonomes interdit COMPLETE (aucune archive ne sera livrée)', () => {
    const st = initialResumeState(perimeter(), NOW);
    st.done = true;
    st.totals = { ...emptyTotals(), autonomousCalls: { expected: 3, exported: 2 } };
    expect(exportStatus(st)).toBe('PARTIAL');
    st.totals.autonomousCalls = { expected: 3, exported: 3 };
    expect(exportStatus(st)).toBe('COMPLETE');
  });
});

describe('C802-U-06 — période de plus de 90 jours (CA11)', () => {
  it('détectée sur les dates saisies (jours de Paris) ; 90 jours exacts et périodes anciennes courtes acceptés', () => {
    expect(periodExceedsMax({ from: '2026-05-01', to: '2026-11-17' }, NOW)).toBe(true);
    expect(periodExceedsMax({ from: '2026-01-01' }, NOW)).toBe(true);
    expect(periodExceedsMax({ from: '2026-08-21', to: '2026-11-17' }, NOW)).toBe(false);
    expect(periodExceedsMax({ from: '2025-01-01', to: '2025-02-15' }, NOW)).toBe(false);
    expect(periodExceedsMax({}, NOW)).toBe(false);
    const r = parseExportSelection({ from: '2026-05-01', to: '2026-11-17' }, NOW);
    expect(!r.ok && r.unsupported[0]).toMatchObject({ key: 'from', reason: expect.stringMatching(/période de plus de 90 jours .* réduisez la période/) });
    expect(parseExportSelection({ from: '2025-01-01', to: '2025-02-15' }, NOW).ok).toBe(true);
  });
});

describe('C802-U-07 — une seule archive remise, jamais sans preuve', () => {
  it('archive remise seulement si la génération a abouti, sans échec, archive vérifiée', async () => {
    const { deliverableArchive } = await import('../export');
    const archive = { fileName: 'a.zip', key: 'k', bytes: 1, sha256: 's', entries: 4, zip64: false, verifiedAt: NOW.toISOString() };
    expect(deliverableArchive(null)).toBeNull();
    expect(deliverableArchive({ done: false, archive, failure: null })).toBeNull();
    expect(deliverableArchive({ done: true, archive: null, failure: null })).toBeNull();
    expect(deliverableArchive({ done: true, archive, failure: { code: 'LIMIT_ZIP_BYTES', message: 'm', at: NOW.toISOString() } })).toBeNull();
    expect(deliverableArchive({ done: true, archive, failure: null })).toBe(archive);
  });
  it('routes : le téléchargement ne sert que l’archive ; volumes et fichiers séparés refusés ; droits revérifiés', () => {
    const dl = read('src/app/api/admin/ai/business-executions/exports/[id]/download/route.ts');
    expect(dl).toContain("code: 'SINGLE_ARCHIVE_ONLY'");
    expect(dl).toContain('isModelOutputAccessAllowed(guard.ctx.adminUserId)');
    expect(dl).toContain('deliverableArchive(st)');
    expect(dl).not.toMatch(/streamStoredZip|executionsDownloadables/);
    const exp = read('src/services/ai/business-execution/export.ts');
    // Une seule chaîne de vérité : l'unitaire et le groupé lisent la profondeur par le même collecteur.
    expect((exp.match(/readUnitDepth\(s\.q, /g) ?? []).length).toBe(2);
    expect((exp.match(/unitDiagnostics\(dto, /g) ?? []).length).toBe(2);
    expect((exp.match(/FROM ai_job_queue WHERE id = ANY/g) ?? []).length).toBe(1);
  });
});
