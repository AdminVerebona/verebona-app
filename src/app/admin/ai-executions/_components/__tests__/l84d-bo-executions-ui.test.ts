/**
 * Lot 84D — CDC Pilotage IA V2 P3 : composants du BO « Exécutions & logs »
 * (rendu statique, sans réseau). Un seul composant par élément, mise en page
 * fluide : identique sur desktop et mobile (Capacitor) — la largeur mobile est
 * contrôlée par les classes (une colonne puis deux, retour à la ligne, aucune
 * largeur fixe au-delà de l'écran).
 *
 *   L84D-C-01  cartes : deux cartes, nombres, carte active, une colonne sur mobile
 *   L84D-C-02  journal : lignes courtes (issue, traitement, objet, origine, cause),
 *              vue métier / technique, état vide explicite, filtres complets
 *   L84D-C-03  détail : ce qui manque, cause non établie, appels (tous modèles),
 *              état de capture, contenu réservé sans droit, écritures, relance existante
 *   L84D-C-04  exports : génération interrompue → « Reprendre » ; terminée → volumes ZIP
 *   L84D-C-05  Configuration IA : avertissement contextuel seulement, sans comptage
 *   L84D-C-06  largeur mobile : aucune largeur fixe > 360 px, enroulement partout
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BusinessExecutionDto } from '@/services/ai/business-execution/dto';
import type { BusinessExecutionDetailDto } from '@/services/ai/business-execution/detail-model';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => h('a', { href, ...p }, children) }));

const { ExecutionCardsView, JournalRowsView, JournalFiltersView, journalParams } = await import('../BusinessJournal');
const { ExecutionDetailView } = await import('../BusinessExecutionDetail');
const { ExportGenerationView } = await import('../ExecutionExportsPanel');
const { ConfigExecutionWarningView } = await import('../../../ai-config/_components/ConfigExecutionWarning');

const NOW = '2026-10-23T10:00:00.000Z';
const row = (o: Partial<BusinessExecutionDto> = {}): BusinessExecutionDto => ({
  id: 'T1:job:42', treatment: 'T1', mode: null, nature: 'BUSINESS', natureLabel: 'Métier', origin: 'USER', originLabel: 'utilisateur',
  outcome: 'INCOMPLETE', progress: null, label: 'Incomplète', native: { source: 'ai_execution_reports', status: 'SUCCESS', result: 'VERIFICATION_INCOMPLETE' },
  cause: 'T1_VERIFICATION_INCOMPLETE : couverture du document non vérifiée (pages non vérifiées)', accountId: 7, objectType: 'document', objectId: '33',
  triggeredAt: NOW, startedAt: NOW, finishedAt: NOW, lastActivityAt: NOW, referenceAt: NOW, resumptions: 1, previousExecutionId: null,
  jobIds: [42], reportIds: [9], traceIds: ['tr-1'], calls: { calls: 2, failedCalls: 1, repairCalls: 0, costMicros: null, models: ['m1', 'm2'], usageEventIds: [1, 2] }, ...o,
});
const detail = (o: Partial<BusinessExecutionDetailDto> = {}): BusinessExecutionDetailDto => ({
  readAt: NOW, execution: row(), missing: ['Pages ou couverture du document non vérifiées : l’exhaustivité de l’analyse n’est pas démontrée.'],
  cause: row().cause, causeUnknown: false,
  calls: [
    { id: 1, createdAt: NOW, operationCode: 't1_analyze_document', model: 'm1', modelRank: 'primary', status: 'error', errorCode: 'TIMEOUT', callKind: 'analysis', durationMs: 120000, costMicros: null, traceId: 'tr-1', captureStatus: 'CAPTURED', promptStatus: 'CAPTURED', responseStatus: 'NO_RESPONSE', promptChars: 900, responseChars: null },
    { id: 2, createdAt: NOW, operationCode: 't1_analyze_document', model: 'm2', modelRank: 'fallback_1', status: 'success', errorCode: null, callKind: 'analysis', durationMs: 9000, costMicros: 1200, traceId: 'tr-1', captureStatus: null, promptStatus: null, responseStatus: null, promptChars: null, responseChars: null },
  ],
  callsTruncated: false,
  jobs: [{ id: 42, treatment: 'T1', status: 'DONE', attempts: 2, origin: 'auto', triggerCode: 'files/confirm', lastError: null, businessResult: null, createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
  reports: [{ id: 9, status: 'SUCCESS', createdAt: NOW, failedSteps: [], writes: { WRITTEN: 12, REFUSED: 1 }, entryCount: 13 }],
  relaunch: [{ kind: 't1-completeness-retry', label: 'Reprendre la vérification du document', endpoint: '/api/admin/ai/t1-completeness/retry', body: { fileId: 33 }, href: null, note: 'Reprise existante.' }],
  canReadContents: false, ...o,
});

describe('L84D-C-01 — cartes « Échecs » et « Incomplètes » (BO-01, BO-07)', () => {
  it('L84D-C-01 : deux cartes cliquables avec leurs nombres, carte active marquée, une colonne sur mobile', () => {
    const html = renderToStaticMarkup(h(ExecutionCardsView, { cards: { failed: 3, incomplete: 12 }, periodLabel: '7 derniers jours', active: 'FAILED', onOpen: () => {} }));
    expect(html).toContain('data-testid="card-failed"');
    expect(html).toContain('data-testid="card-incomplete"');
    expect(html).toMatch(/Échecs[\s\S]*>3<[\s\S]*Exécutions incomplètes[\s\S]*>12</);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="card-failed"/);
    expect(html).toContain('grid-cols-1 sm:grid-cols-2');
    expect(html).toContain('7 derniers jours · exécutions métier, issue finale');
  });
  it('L84D-C-01 : avant lecture, « — » (jamais 0) ; erreur nommée', () => {
    const html = renderToStaticMarkup(h(ExecutionCardsView, { cards: null, periodLabel: '7 derniers jours', active: null, onOpen: () => {}, error: 'base injoignable' }));
    expect(html).toMatch(/data-testid="card-count">—</);
    expect(html).toContain('Cartes indisponibles : base injoignable');
  });
});

describe('L84D-C-02 — Journal complet (BO-02, BO-08)', () => {
  it('L84D-C-02 : une ligne par exécution — issue, traitement, objet, compte, origine, cause, appels, identifiant', () => {
    const html = renderToStaticMarkup(h(JournalRowsView, { rows: [row(), row({ id: 'T3:5', treatment: 'T3', nature: 'TECHNICAL', natureLabel: 'Technique', outcome: 'SUCCEEDED', label: 'Réussie', cause: null })], view: 'metier', onOpen: () => {} }));
    expect((html.match(/data-testid="journal-row"/g) ?? []).length).toBe(2);
    expect(html).toContain('Incomplète');
    expect(html).toContain('document 33');
    expect(html).toContain('compte 7');
    expect(html).toContain('origine utilisateur');
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('2 appels dont 1 en échec');
    expect(html).toContain('T1:job:42');
    expect(html).toContain('>technique<');
    expect(html).not.toMatch(/traitement inconnu/i);
  });
  it('L84D-C-02 : état vide propre à chaque vue', () => {
    expect(renderToStaticMarkup(h(JournalRowsView, { rows: [], view: 'metier', onOpen: () => {} }))).toContain('Aucune exécution métier');
    expect(renderToStaticMarkup(h(JournalRowsView, { rows: [], view: 'technique', onOpen: () => {} }))).toContain('sonde, qualification, test');
  });
  it('L84D-C-02 : filtres — période, traitement, issue, origine, compte ; paramètres d’API identiques à ceux de l’export', () => {
    const f = { days: '7', from: '', to: '', treatment: 'T3', outcome: 'FAILED', origin: 'ADMIN', accountId: '12' };
    const html = renderToStaticMarkup(h(JournalFiltersView, { f, onChange: () => {}, view: 'metier' }));
    for (const l of ['Période', 'Traitement', 'Issue', 'Origine', 'Compte']) expect(html).toContain(`aria-label="${l}"`);
    expect(html).toContain('flex-wrap');
    expect(Object.fromEntries(journalParams(f, 'BUSINESS'))).toEqual({ days: '7', treatment: 'T3', outcome: 'FAILED', origin: 'ADMIN', accountId: '12', nature: 'BUSINESS' });
    expect(Object.fromEntries(journalParams({ ...f, from: '2026-10-01', to: '2026-10-07' }, 'TECHNICAL'))).toMatchObject({ from: '2026-10-01', to: '2026-10-07', nature: 'TECHNICAL' });
  });
});

describe('L84D-C-03 — détail d’une exécution (BO-03, BO-10, LOG-07)', () => {
  it('L84D-C-03 : ce qui manque, cause, TOUS les appels (deux modèles), état de capture, écritures, relance existante', () => {
    const html = renderToStaticMarkup(h(ExecutionDetailView, { d: detail() }));
    expect(html).toContain('Ce qui manque');
    expect(html).toContain('Pages ou couverture du document non vérifiées');
    expect(html).toContain('Cause : T1_VERIFICATION_INCOMPLETE');
    expect((html.match(/data-testid="execution-call"/g) ?? []).length).toBe(2);
    expect(html).toContain('m1 (primary)');
    expect(html).toContain('m2 (fallback_1)');
    expect(html).toContain('tarif inconnu');
    expect(html).toContain('échange : capturé (prompt 900 car., réponse 0 car.)');
    expect(html).toContain('échange : non conservé historiquement');
    expect(html).toContain('WRITTEN : 12 · REFUSED : 1');
    expect(html).toContain('data-testid="relaunch-t1-completeness-retry"');
    expect(html).toContain('Reprendre la vérification du document');
  });
  it('L84D-C-03 : administrateur sans AI_MODEL_OUTPUT_ADMIN_IDS → aucun accès au contenu (mention), aucun bouton d’échanges', () => {
    const html = renderToStaticMarkup(h(ExecutionDetailView, { d: detail({ canReadContents: false }) }));
    expect(html).toContain('data-testid="execution-contents-restricted"');
    expect(html).not.toContain('execution-model-output-button');
    const ok = renderToStaticMarkup(h(ExecutionDetailView, { d: detail({ canReadContents: true }) }));
    expect(ok).toContain('data-testid="execution-contents"');
    expect(ok).toContain('execution-model-output-button');
  });
  it('L84D-C-03 : cause non établie dite telle quelle ; aucune relance applicable ; exécution non finale', () => {
    const html = renderToStaticMarkup(h(ExecutionDetailView, {
      d: detail({ execution: row({ outcome: 'NOT_FINAL', label: 'Non finale — en cours', cause: null }), missing: [], cause: null, causeUnknown: true, relaunch: [], calls: [], reports: [] }),
    }));
    expect(html).toContain('non établie');
    expect(html).toContain('Aucune relance existante n’est applicable');
    expect(html).toContain('Exécution non finale');
  });
});

describe('L84D-C-04 — exports (EXP-03, EXP-04, R64)', () => {
  const g = { id: 'g1', status: 'FAILED' as const, interrupted: false, rowsExpected: null, rowsExported: 400, files: 4, error: 'génération interrompue — reprise possible', startedAt: NOW, finishedAt: NOW, heartbeatAt: NOW, perimeter: { days: '7', nature: 'BUSINESS' } };
  it('L84D-C-04 : génération interrompue → « Reprendre la génération » et point de reprise annoncé', () => {
    const html = renderToStaticMarkup(h(ExportGenerationView, {
      g, onResume: () => {}, detail: { manifest: null, downloadables: [], resumable: true, resume: { cursorAt: NOW, partsWritten: 2, executionsWritten: 400, done: false, resumes: 0 } },
    }));
    expect(html).toContain('data-testid="export-resume"');
    expect(html).toContain('reprise après 2 partie(s) écrite(s)');
    expect(html).toContain('400 exécution(s) écrite(s)');
  });
  it('L84D-C-04 : génération terminée → volumes ZIP, manifeste, fichiers JSONL', () => {
    const manifest = {
      status: 'COMPLETE', totals: { executions: { expected: 650, exported: 650 }, calls: { expected: 1300, exported: 1300 }, cards: { failed: 3, incomplete: 2 } },
      resumes: [{ at: NOW, adminUserId: 1, fromCursor: NOW }], volumes: [{ index: 1, files: ['a'], compressedBytes: 1 }, { index: 2, files: ['b'], compressedBytes: 1 }],
    } as never;
    const html = renderToStaticMarkup(h(ExportGenerationView, {
      g: { ...g, status: 'COMPLETE', error: null }, detail: { manifest, downloadables: ['executions/executions.part-0001.jsonl.gz', 'manifeste.json'], resumable: false, resume: null },
    }));
    expect((html.match(/data-testid="export-volume"/g) ?? []).length).toBe(2);
    expect(html).toContain('ZIP 2/2');
    expect(html).toContain('650 / 650 exécution(s)');
    expect(html).toContain('1 reprise(s)');
    expect(html).not.toContain('export-resume');
  });
});

describe('L84D-C-05 — Configuration IA : avertissement contextuel seulement (BO-06)', () => {
  it('L84D-C-05 : une ligne avec accès aux exécutions en cause, sans comptage ; rien sinon', () => {
    const html = renderToStaticMarkup(h(ConfigExecutionWarningView, { treatment: 'T3', show: true }));
    expect(html).toContain('href="/admin/ai-executions?treatment=T3"');
    expect(html).not.toMatch(/\d+ (échec|exécution)/);
    expect(renderToStaticMarkup(h(ConfigExecutionWarningView, { treatment: 'T3', show: false }))).toBe('');
  });
});

describe('L84D-C-06 — largeur mobile (BO desktop ET Capacitor)', () => {
  const files = ['BusinessJournal.tsx', 'BusinessExecutionDetail.tsx', 'ExecutionExportsPanel.tsx'].map((f) => readFileSync(join(process.cwd(), 'src/app/admin/ai-executions/_components', f), 'utf8'));
  it('L84D-C-06 : aucune largeur fixe au-delà de 360 px ; enroulement (flex-wrap) et coupure des identifiants', () => {
    for (const src of files) {
      for (const m of src.matchAll(/\b(?:w|min-w)-\[(\d+)px\]/g)) expect(Number(m[1])).toBeLessThanOrEqual(360);
      expect(src).toContain('flex-wrap');
      expect(src).toMatch(/break-all|break-words/);
    }
  });
  it('L84D-C-06 : le détail s’ouvre dans le tiroir de base 81F, pleine largeur sur mobile', () => {
    expect(files[1]).toContain("from '@/components/ui/sheet'");
    expect(files[1]).toMatch(/SheetContent side="right" className="w-full sm:max-w-2xl/);
  });
});
