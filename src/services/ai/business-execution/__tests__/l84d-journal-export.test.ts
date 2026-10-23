/**
 * Lot 84D — CDC Pilotage IA V2 P3 : règles PURES du journal, des cartes, du
 * détail et des exports (sans base). Les preuves sur PostgreSQL 16 sont dans
 * `src/test/e2e/scenarios/l84d-bo-executions-exports.e2e.ts`.
 *
 *   L84D-U-01  cartes = liste filtrée sur l'issue (R24) ; technique hors cartes (BO-02)
 *   L84D-U-02  filtres du journal : lecture tolérante, aller-retour d'URL, empreinte stable
 *   L84D-U-03  export : tranches, fin figée à l'instant de lecture (R28/R64), volumes ZIP
 *              (fractionnement, index commun), statut honnête (R27/R63)
 *   L84D-U-04  échanges : masqués (longueur + SHA-256) sans droit, intégraux (secrets masqués)
 *              avec droit, absence signalée sans reconstitution (LOG-08)
 *   L84D-U-05  détail : ce qui manque, cause non établie, relances EXISTANTES seulement (BO-03, BO-10)
 *   L84D-U-06  BO-11 : une source d'alerte par nature ; R23/R59 : sonde « Technique »,
 *              rattachement absent signalé ; comptages remplacés retirés (Configuration IA,
 *              Supervision, tableau de bord)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALERT_SOURCES, cardCounts, cardJournalFilter, compareJournal, journalFilterFingerprint, journalFilterToParams, matchesJournalFilter, parseJournalFilter,
} from '../journal';
import {
  EXPORT_MIN_SLICE_MS, addToTotals, buildManifest, emptyTotals, executionLine, exportStatus, initialResumeState, partPath, planVolumes, readEnd, sliceAt,
  type ExportFile, type ExportPerimeter,
} from '../export-model';
import { causeCode, isCauseUnknown, missingOf, relaunchOptions } from '../detail-model';
import type { BusinessExecutionDto } from '../dto';
import type { BusinessExecution } from '../types';

const NOW = new Date('2026-10-23T10:00:00Z');
const x = (o: Partial<BusinessExecution>): BusinessExecution => ({
  id: 'T4:1', treatment: 'T4', mode: null, nature: 'BUSINESS', origin: 'AUTOMATIC', accountId: 7, objectType: 'asset', objectId: '1',
  triggeredAt: NOW, startedAt: NOW, referenceAt: NOW, resumptions: 0, previousExecutionId: null, jobIds: [1], reportIds: [], traceIds: [],
  outcome: 'SUCCEEDED', progress: null, cause: null, native: { source: 'ai_job_queue', status: 'DONE' }, finishedAt: NOW, lastActivityAt: NOW, ...o,
});
const dto = (o: Partial<BusinessExecutionDto>): BusinessExecutionDto => ({
  id: 'T4:1', treatment: 'T4', mode: null, nature: 'BUSINESS', natureLabel: 'Métier', origin: 'AUTOMATIC', originLabel: 'automatique',
  outcome: 'FAILED', progress: null, label: 'Échouée', native: { source: 'ai_job_queue', status: 'FAILED' }, cause: null, accountId: 7,
  objectType: 'asset', objectId: '1', triggeredAt: NOW.toISOString(), startedAt: null, finishedAt: NOW.toISOString(), lastActivityAt: NOW.toISOString(),
  referenceAt: NOW.toISOString(), resumptions: 0, previousExecutionId: null, jobIds: [1], reportIds: [], traceIds: [], calls: null, ...o,
});

describe('L84D-U-01 — cartes = liste filtrée (R24, BO-01, BO-02, BO-04)', () => {
  const rows = [
    x({ id: 'T4:1', outcome: 'FAILED' }), x({ id: 'T4:2', outcome: 'FAILED', accountId: 8 }), x({ id: 'T4:3', outcome: 'INCOMPLETE' }),
    x({ id: 'T3:4', treatment: 'T3', outcome: 'FAILED', nature: 'TECHNICAL' }), x({ id: 'T4:5', outcome: 'SUCCEEDED' }),
    x({ id: 'T1:6', treatment: 'T1', outcome: 'INCOMPLETE', origin: 'ADMIN' }), x({ id: 'T4:7', outcome: 'NOT_FINAL', finishedAt: null }),
  ];
  it('L84D-U-01 : chaque carte = total de la liste métier filtrée sur son issue, mêmes identifiants ; le technique n’y entre jamais', () => {
    const f = parseJournalFilter(new URLSearchParams(), NOW);
    const c = cardCounts(rows, f);
    expect(c).toEqual({ failed: 2, incomplete: 2 });
    for (const card of ['FAILED', 'INCOMPLETE'] as const) {
      const lf = cardJournalFilter(f, card);
      const list = rows.filter((r) => matchesJournalFilter(r, lf));
      expect(list.length).toBe(card === 'FAILED' ? c.failed : c.incomplete);
      expect(list.every((r) => r.nature === 'BUSINESS' && r.outcome === card)).toBe(true);
    }
    // Filtres de périmètre : traitement, origine, compte — mêmes règles pour la carte et la liste.
    const t1 = parseJournalFilter(new URLSearchParams('treatment=T1&origin=ADMIN'), NOW);
    expect(cardCounts(rows, t1)).toEqual({ failed: 0, incomplete: 1 });
    expect(cardCounts(rows, parseJournalFilter(new URLSearchParams('accountId=8'), NOW))).toEqual({ failed: 1, incomplete: 0 });
  });
  it('L84D-U-01 : ordre du journal déterministe (plus récente, puis identifiant)', () => {
    const a = x({ id: 'B', referenceAt: new Date(1000) });
    const b = x({ id: 'A', referenceAt: new Date(1000) });
    const c = x({ id: 'C', referenceAt: new Date(2000) });
    expect([a, b, c].sort(compareJournal).map((r) => r.id)).toEqual(['C', 'A', 'B']);
  });
});

describe('L84D-U-02 — filtres du journal', () => {
  it('L84D-U-02 : lecture tolérante (valeurs illisibles ignorées), nature métier par défaut, « all » = toutes', () => {
    const f = parseJournalFilter(new URLSearchParams('treatment=T9&outcome=NIMP&origin=ADMIN&accountId=12x&nature=all&days=30'), NOW);
    expect(f).toMatchObject({ treatment: null, outcome: null, origin: 'ADMIN', accountId: null, nature: null });
    expect(f.period.to.getTime() - f.period.from.getTime()).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(parseJournalFilter(new URLSearchParams(), NOW).nature).toBe('BUSINESS');
  });
  it('L84D-U-02 : aller-retour URL → filtre → URL (liens partagés, export) ; jours de Paris', () => {
    const q = new URLSearchParams('from=2026-10-01&to=2026-10-07&treatment=T3&outcome=FAILED&origin=USER&accountId=42&nature=BUSINESS');
    const f = parseJournalFilter(q, NOW);
    expect(Object.fromEntries(journalFilterToParams(f))).toEqual(Object.fromEntries(q));
    expect(f.period.from.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(f.period.to.toISOString()).toBe('2026-10-07T22:00:00.000Z');
    expect(journalFilterFingerprint(f)).toBe(journalFilterFingerprint(parseJournalFilter(q, new Date('2026-12-01T00:00:00Z'))));
  });
});

const perimeter = (o: Partial<ExportPerimeter> = {}): ExportPerimeter => ({
  params: { days: '7', nature: 'BUSINESS' }, from: '2026-10-16T10:00:00.000Z', to: '2026-10-23T10:00:00.001Z', rule: 'r', timeZone: 'Europe/Paris',
  treatment: null, outcome: null, nature: 'BUSINESS', origin: null, accountId: null, sensitiveContent: false, fingerprint: 'f', ...o,
});
const file = (part: number, kind: ExportFile['kind'], compressed: number): ExportFile => ({
  path: kind === 'documentation' ? 'LISEZMOI.txt' : partPath(kind, part), kind, part: kind === 'documentation' ? null : part, expected: 1, exported: 1,
  bytes: compressed * 3, compressedBytes: compressed, sha256: 'x', status: 'COMPLETE',
});

describe('L84D-U-03 — export : tranches, périmètre figé, volumes, statut', () => {
  it('L84D-U-03 : la fin de lecture ne dépasse jamais l’instant de lecture figé (aucun ajout lors d’une reprise)', () => {
    expect(readEnd(perimeter(), '2026-10-23T09:00:00.000Z').toISOString()).toBe('2026-10-23T09:00:00.000Z');
    expect(readEnd(perimeter({ to: '2026-10-20T00:00:00.000Z' }), '2026-10-23T09:00:00.000Z').toISOString()).toBe('2026-10-20T00:00:00.000Z');
    const s = sliceAt(new Date('2026-10-22T00:00:00Z'), new Date('2026-10-22T12:00:00Z'), 24 * 3600_000);
    expect(s.to.toISOString()).toBe('2026-10-22T12:00:00.000Z');
    expect(initialResumeState(perimeter(), NOW, { sliceMs: 1 }).sliceMs).toBe(EXPORT_MIN_SLICE_MS);
  });
  it('L84D-U-03 : volumes ZIP — parties entières, ordre conservé, aucun volume au-delà du plafond (sauf partie isolée)', () => {
    const files = [file(1, 'executions', 40), file(1, 'appels', 30), file(2, 'executions', 50), file(2, 'appels', 10), file(3, 'executions', 200), file(0, 'documentation', 1)];
    const v = planVolumes(files, 100);
    expect(v.map((x) => x.files)).toEqual([
      ['appels/appels.part-0001.jsonl.gz', 'executions/executions.part-0001.jsonl.gz'],
      ['appels/appels.part-0002.jsonl.gz', 'executions/executions.part-0002.jsonl.gz'],
      ['executions/executions.part-0003.jsonl.gz'],
    ]);
    expect(v.flatMap((x) => x.files).sort()).toEqual(files.filter((f) => f.kind !== 'documentation').map((f) => f.path).sort());
  });
  it('L84D-U-03 : statut honnête — interrompu = FAILED, lecture plafonnée = PARTIAL, attendu = exporté = COMPLETE', () => {
    const st = initialResumeState(perimeter(), NOW);
    st.files = [file(1, 'executions', 1), file(1, 'appels', 1)];
    st.totals.executions = { expected: 3, exported: 3 };
    expect(exportStatus(st)).toBe('FAILED');
    st.done = true;
    expect(exportStatus(st)).toBe('COMPLETE');
    st.partial = true;
    expect(exportStatus(st)).toBe('PARTIAL');
    st.partial = false;
    st.totals.calls = { expected: 2, exported: 1 };
    expect(exportStatus(st)).toBe('PARTIAL');
    const m = buildManifest('g', { ...st, totals: { ...st.totals, calls: { expected: 1, exported: 1 } } }, { generatedAt: 'a', finishedAt: 'b', environment: 'test', build: { version: null, commit: null } });
    expect(m).toMatchObject({ schema: 'verebona.ai-executions-export/1', status: 'COMPLETE', period: { timeZone: 'Europe/Paris', readAt: NOW.toISOString() } });
    expect(m.absent.join(' ')).toMatch(/masqué/);
  });
  it('L84D-U-03 : totaux = cartes du même périmètre ; exécutions non finales signalées « en cours »', () => {
    const t = emptyTotals();
    for (const r of [dto({ outcome: 'FAILED' }), dto({ outcome: 'INCOMPLETE' }), dto({ outcome: 'FAILED', nature: 'TECHNICAL' }), dto({ outcome: 'NOT_FINAL', progress: 'RUNNING' })]) addToTotals(t, r);
    expect(t.cards).toEqual({ failed: 1, incomplete: 1 });
    expect(t.nonFinal).toBe(1);
    expect(executionLine(dto({ outcome: 'NOT_FINAL', progress: 'RUNNING' }))).toMatchObject({ final: false, enCours: 'RUNNING' });
    expect(executionLine(dto({}))).toMatchObject({ final: true, enCours: null });
  });
});

describe('L84D-U-04 — échanges capturés dans les exports', async () => {
  const { exchangeOf, callLine } = await import('../export');
  const meta = {
    capture_status: 'CAPTURED', prompt_status: 'CAPTURED', response_status: 'CAPTURED',
    // Longueur et empreinte calculées EN BASE : sans droit, le contenu n'est même pas lu.
    prompt_text_len: 44, prompt_text_sha: 'abc', response_raw_len: 11, response_raw_sha: 'def', variables_len: 30, variables_sha: '123',
    request_params_len: 18, request_params_sha: '456', parsed_output_len: 10, parsed_output_sha: '789',
  };
  const capture = {
    ...meta, prompt_text: 'Analyse ce document. Bearer abcdefghijklmnop', response_raw: '{"ok":true}', variables: { doc: 'contact@exemple.fr' }, messages: null, attachments: null,
    request_params: { temperature: 0 }, provider_steps: null, parsed_output: { ok: true },
  };
  it('L84D-U-04 : sans droit, contenu = longueur + SHA-256 (jamais le texte), absence distinguée', () => {
    const e = exchangeOf(meta, false);
    expect(e.prompt).toEqual({ $etat: 'masque', motif: expect.stringMatching(/AI_MODEL_OUTPUT_ADMIN_IDS/), longueur: 44, sha256: 'abc' });
    expect(e.parsed).toMatchObject({ $etat: 'masque', longueur: 10 });
    expect(e.messages).toBeNull();
    expect(exchangeOf({ ...meta, response_status: 'NO_RESPONSE', response_raw_len: null }, false).response).toEqual({ $etat: 'absent', motif: 'NO_RESPONSE' });
  });
  it('L84D-U-04 : avec droit, contenu intégral, secrets et e-mails masqués', () => {
    const e = exchangeOf(capture, true);
    expect(String(e.prompt)).toContain('Analyse ce document.');
    expect(String(e.prompt)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(e.variables)).not.toContain('contact@exemple.fr');
    expect(e.response).toBe('{"ok":true}');
  });
  it('L84D-U-04 : aucune capture = absence signalée, jamais reconstituée (LOG-08) ; ligne d’appel corrélée', () => {
    expect(exchangeOf(null, true)).toMatchObject({ $etat: 'absent' });
    const l = callLine('T4:9', { id: 1, model: 'gemini-x', status: 'error', error_message: 'jeton sk-ABCDEFGHIJKLMNOPQRSTUV refusé', business_execution_id: 'T4:9' }, null, false);
    expect(l).toMatchObject({ businessExecutionId: 'T4:9', model: 'gemini-x', echange: { $etat: 'absent' } });
    expect(JSON.stringify(l)).not.toContain('ABCDEFGHIJKLMNOPQRSTUV');
  });
});

describe('L84D-U-05 — détail : ce qui manque, causes, relances existantes', () => {
  it('L84D-U-05 : ce qui manque vient de la cause établie et des étapes en échec ; rien pour une réussite', () => {
    expect(causeCode('T1_VERIFICATION_INCOMPLETE : couverture du document non vérifiée')).toBe('T1_VERIFICATION_INCOMPLETE');
    expect(missingOf(dto({ outcome: 'INCOMPLETE', cause: 'T1_VERIFICATION_INCOMPLETE : couverture du document non vérifiée' }))[0]).toMatch(/non vérifiées/);
    expect(missingOf(dto({ outcome: 'INCOMPLETE', cause: 'T4_INCOMPLETE : x', native: { source: 's', status: 'FAILED', detail: { failedSteps: ['AGENDA_SYNC'] } } })))
      .toEqual([expect.stringMatching(/Décision manquante/), 'Étapes en échec : AGENDA_SYNC.']);
    expect(missingOf(dto({ outcome: 'SUCCEEDED' }))).toEqual([]);
    expect(isCauseUnknown(dto({ outcome: 'FAILED', cause: null }))).toBe(true);
    expect(isCauseUnknown(dto({ outcome: 'FAILED', cause: 'T4_FAILED : x' }))).toBe(false);
  });
  it('L84D-U-05 : relances = routes EXISTANTES (File IA, complétude T1, Supervision T6), liées à l’exécution ; T2 jamais relancé', () => {
    const q = relaunchOptions(dto({ id: 'T4:5' }), [{ id: 5, status: 'FAILED' }]);
    expect(q).toEqual([expect.objectContaining({ kind: 'queue-retry', endpoint: '/api/admin/ai/queue/jobs/5/retry', body: { businessExecutionId: 'T4:5' } })]);
    expect(relaunchOptions(dto({}), [{ id: 5, status: 'DONE' }])).toEqual([]);
    const t1 = relaunchOptions(dto({ id: 'T1:job:9', treatment: 'T1', outcome: 'INCOMPLETE', objectType: 'document', objectId: '33', native: { source: 'r', status: 'SUCCESS', result: 'VERIFICATION_INCOMPLETE' } }), []);
    expect(t1).toEqual([expect.objectContaining({ kind: 't1-completeness-retry', endpoint: '/api/admin/ai/t1-completeness/retry', body: { fileId: 33, businessExecutionId: 'T1:job:9' } })]);
    expect(relaunchOptions(dto({ treatment: 'T6', mode: 'EVALUATE' }), [])[0]).toMatchObject({ kind: 't6-supervision', endpoint: null, href: '/admin/supervision' });
    expect(relaunchOptions(dto({ treatment: 'T2', mode: 'ai', jobIds: [] }), [])).toEqual([]);
    // Aucune NOUVELLE route de relance : seules les trois actions existantes.
    const endpoints = [...q, ...t1].map((o) => o.endpoint);
    expect(endpoints.every((e) => e === null || /^\/api\/admin\/ai\/(queue\/jobs\/\d+\/retry|t1-completeness\/retry)$/.test(e))).toBe(true);
  });
});

describe('L84D-U-06 — BO-11, R23 / R59, comptages remplacés retirés', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('L84D-U-06 : une source par nature d’alerte (aucune nature sans écran, échecs et incomplètes dans Exécutions & logs)', () => {
    expect(ALERT_SOURCES.BUSINESS_FAILED.screen).toBe('/admin/ai-executions');
    expect(ALERT_SOURCES.BUSINESS_INCOMPLETE.screen).toBe('/admin/ai-executions');
    for (const v of Object.values(ALERT_SOURCES)) expect(v.where.length).toBeGreaterThan(10);
  });
  it('L84D-U-06 : R23 / R59 — sonde « Technique », rattachement absent signalé, jamais « traitement inconnu »', async () => {
    const { executionScopeLabel } = await import('@/services/ai/telemetry/execution-filters');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 'model_operational_probe' })).toBe('Technique');
    expect(executionScopeLabel({ treatment: null, useCaseCode: null, operationCode: 't1_analyze_document' })).toBe('Non rattaché (historique)');
    for (const p of ['src/app/admin/ai-executions/page.tsx', 'src/app/admin/ai-executions/_components/BusinessJournal.tsx', 'src/app/admin/ai-executions/_components/BusinessExecutionDetail.tsx']) {
      expect(src(p)).not.toMatch(/traitement inconnu/i);
    }
  });
  it('L84D-U-06 : C-Q9 — panneau P2, alerte du tableau de bord, « jobs en échec » de Supervision et échecs de Configuration IA retirés', () => {
    expect(src('src/app/admin/ai-executions/_components/BusinessExecutionsPanel.tsx')).not.toMatch(/export function BusinessExecutionsPanel/);
    expect(src('src/app/admin/ai-executions/page.tsx')).not.toMatch(/<BusinessExecutionsPanel|<T1CompletenessPanel \/>\s*\}\s*\n\s*\{\/\* Filtres/);
    expect(src('src/app/api/admin/ai/dashboard/route.ts')).not.toMatch(/exécution\$\{e\.failed > 1/);
    expect(src('src/services/admin/supervision-sweep.service.ts')).not.toMatch(/WHERE j\.status = 'FAILED'/);
    const metrics = src('src/services/ai/config/treatment-metrics.repository.ts');
    expect(metrics).not.toMatch(/M\('failed'|M\('failure_rate'|M\('errors'/);
  });
});
