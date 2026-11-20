/**
 * Carte #802 — interface de l'export diagnostic (rendu pur, sans réseau).
 *
 *   C802-C-01  bouton « Exporter le diagnostic complet (ZIP) » ; précontrôle
 *              affiché (attendu, taille estimée, limites, annonces)
 *   C802-C-02  blocage : message de la carte, cause, « filtres conservés »,
 *              AUCUN bouton de lancement
 *   C802-C-03  suivi : en cours, échec explicite sans téléchargement, lien
 *              UNIQUE « Télécharger le ZIP complet » une fois vérifié
 *   C802-C-04  ordinateur et mobile, charte Sérénité (aucune couleur brute)
 *   C802-C-05  la page transmet les filtres ACTIFS de chaque onglet
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ExportGenerationView, ExportPrecheckPanel, UNSUPPORTED_EXPORT_TABS } = await import('../ExecutionExportsPanel');
type Precheck = import('../ExecutionExportsPanel').ExportPrecheckView;

const NOW = '2026-11-17T10:00:00.000Z';
const MESSAGE = 'Sélection trop volumineuse. Réduisez la période ou affinez les filtres (traitement, compte, statut)';
const limits = { maxZipBytes: 2 * 1024 ** 3, maxRawBytes: 8 * 1024 ** 3, maxDurationMs: 2 * 3600_000, precheckBudgetMs: 20_000 };
const precheck = (o: Partial<Precheck> = {}): Precheck => ({
  ok: true, scope: 'executions', sensitiveContent: false, executions: 137, calls: 200, autonomousCalls: 3, autonomous: { included: true, reason: '' },
  estimatedRawBytes: 1_199_500, limits, refusal: null, notices: [], ...o,
});
const g = { id: 'g1', status: 'RUNNING' as const, interrupted: false, rowsExpected: null, rowsExported: 40, files: 2, error: null, startedAt: NOW, finishedAt: null, heartbeatAt: NOW, perimeter: { days: '7' } };
const src = readFileSync(join(process.cwd(), 'src/app/admin/ai-executions/_components/ExecutionExportsPanel.tsx'), 'utf8');

describe('C802-C-01 — précontrôle affiché avant tout lancement', () => {
  it('nombre attendu, appels, appels autonomes, taille estimée et limites ; confirmation proposée', () => {
    const html = renderToStaticMarkup(h(ExportPrecheckPanel, { p: precheck({ notices: ['Données de plus de 90 jours : purgées.'] }), onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain('data-ok="1"');
    expect(html).toMatch(/<strong>137<\/strong> exécutions · 200 appels IA · 3 appels techniques autonomes/);
    expect(html).toContain('Taille estimée avant compression : 1,1 Mio (limite 8 Gio) · ZIP limité à 2 Gio · durée limitée à 2 h · contenus des échanges masqués');
    expect(html).toContain('Données de plus de 90 jours : purgées.');
    expect(html).toContain('data-testid="export-confirm"');
    expect(html).toContain('Confirmer et générer le ZIP');
  });
  it('le bouton de l’écran porte le libellé de la carte', () => {
    expect(src).toContain('Exporter le diagnostic complet (ZIP)');
    expect(src).not.toContain('Exporter le journal filtré');
  });
  it('appels autonomes exclus : motif affiché (vue métier, filtre actif)', () => {
    const html = renderToStaticMarkup(h(ExportPrecheckPanel, { p: precheck({ autonomousCalls: 0, autonomous: { included: false, reason: 'vue métier' } }) }));
    expect(html).toContain('non inclus : vue métier.');
  });
});

describe('C802-C-02 — blocage explicite : rien n’est lancé', () => {
  it('message de la carte, cause et limite, filtres conservés, AUCUN bouton de lancement', () => {
    const message = `${MESSAGE} — volume de données 9 Gio avant compression au-delà de la limite de 8 Gio (AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES).`;
    const html = renderToStaticMarkup(h(ExportPrecheckPanel, {
      p: precheck({ ok: false, refusal: { code: 'LIMIT_RAW_BYTES', message, cause: 'volume…' }, estimatedRawBytes: 9 * 1024 ** 3 }), onConfirm: () => {}, onCancel: () => {},
    }));
    expect(html).toContain('data-ok="0"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(MESSAGE);
    expect(html).toContain('au-delà de la limite de 8 Gio');
    expect(html).toContain('Aucun export n’a été lancé. Vos filtres sont conservés');
    expect(html).not.toContain('export-confirm');
    expect(html).toContain('Fermer');
    // Le nombre attendu reste affiché avec le refus.
    expect(html).toMatch(/<strong>137<\/strong> exécutions/);
  });
  it('onglets sans traduction : le blocage est dit avant tout clic, bouton désactivé', () => {
    expect(Object.keys(UNSUPPORTED_EXPORT_TABS).sort()).toEqual(['archives', 'completeness', 'qualification', 'reports', 'schemas', 't2']);
    expect(src).toContain('disabled={busy || !!unsupportedTab}');
    expect(src).toContain('data-testid="export-unsupported-tab"');
  });
  it('un refus du serveur au lancement est affiché tel quel, sans relance ni changement des filtres', () => {
    expect(src).toContain("setBlocked((e as Error).message || 'Export impossible.')");
    expect(src).toContain('data-testid="export-blocked"');
    // Un précontrôle ne vaut que pour les filtres sur lesquels il a porté.
    expect(src).toContain('useEffect(() => { setPrecheck(null); setBlocked(null); }, [key]);');
  });
});

describe('C802-C-03 — suivi et lien unique', () => {
  it('en cours : suivi affiché, aucun téléchargement', () => {
    const html = renderToStaticMarkup(h(ExportGenerationView, { g, detail: { manifest: null, archive: null, failure: null, resumable: false, resume: null } }));
    expect(html).toContain('data-testid="export-progress"');
    expect(html).toContain('40 exécution(s) écrite(s)');
    expect(html).not.toContain('export-download');
  });
  it('arrêt pendant la génération : échec explicite, aucun ZIP, aucune reprise proposée', () => {
    const message = `${MESSAGE} — génération au-delà de la durée maximale de 2 h (AI_EXECUTIONS_EXPORT_MAX_DURATION_MS).`;
    const html = renderToStaticMarkup(h(ExportGenerationView, {
      g: { ...g, status: 'FAILED', error: message, finishedAt: NOW }, onResume: () => {},
      detail: { manifest: null, archive: null, failure: { code: 'LIMIT_DURATION', message, at: NOW }, resumable: false, resume: null },
    }));
    expect(html).toContain('en échec');
    expect(html).toContain(MESSAGE);
    expect(html).toContain('Aucun ZIP n’a été produit ; les fichiers intermédiaires ont été supprimés.');
    expect(html).not.toContain('export-download');
    expect(html).not.toContain('export-resume');
  });
  it('terminé et vérifié : UN lien « Télécharger le ZIP complet », taille, empreinte, omissions motivées', () => {
    const manifest = {
      status: 'COMPLETE', totals: { executions: { expected: 137, exported: 137 }, calls: { expected: 200, exported: 200 }, cards: { failed: 0, incomplete: 0 }, autonomousCalls: { expected: 3, exported: 3 } },
      resumes: [], omissions: [{ what: 'Contenu des échanges IA', status: 'MASQUE', reason: 'export sans contenus sensibles' }],
    } as never;
    const html = renderToStaticMarkup(h(ExportGenerationView, {
      g: { ...g, status: 'COMPLETE', finishedAt: NOW, rowsExpected: 137, rowsExported: 137 },
      detail: { manifest, archive: { fileName: 'verebona-diagnostic-executions-ia-g1.zip', bytes: 22_208, sha256: 'cd'.repeat(32), entries: 6, zip64: false, verifiedAt: NOW }, failure: null, resumable: false, resume: null },
    }));
    expect((html.match(/<a /g) ?? []).length).toBe(1);
    expect(html).toContain('Télécharger le ZIP complet');
    expect(html).toContain('21,7 Kio · 6 fichier(s)');
    expect(html).toContain(`SHA-256 ${'cd'.repeat(32)}`);
    expect(html).toContain('137 / 137 exécution(s) · 200 / 200 appel(s) · 3 / 3 appel(s) technique(s) autonome(s)');
    expect(html).toContain('[MASQUE] Contenu des échanges IA : export sans contenus sensibles');
  });
  it('génération d’un ancien format (sans archive) : aucun lien, invitation à relancer', () => {
    const html = renderToStaticMarkup(h(ExportGenerationView, { g: { ...g, status: 'COMPLETE', finishedAt: NOW }, detail: { manifest: null, archive: null, failure: null, resumable: false, resume: null } }));
    expect(html).toContain('data-testid="export-no-archive"');
    expect(html).not.toContain('export-download');
  });
});

describe('C802-C-04 — ordinateur et mobile, charte Sérénité', () => {
  it('aucune couleur brute : variables de la charte seulement', () => {
    // (« #802 » est le numéro de la carte dans les commentaires, pas une couleur.)
    expect(src.replace(/#802\b/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|rose|zinc|neutral)-\d{2,3}\b/);
    expect(src).not.toMatch(/rgba?\(/);
    expect((src.match(/var\(--[a-z-]+\)/g) ?? []).length).toBeGreaterThan(20);
  });
  it('mobile : enroulement, coupure des identifiants, cibles tactiles ≥ 44 px, aucune largeur fixe', () => {
    expect(src).toContain("const TOUCH = 'min-h-[44px] sm:min-h-0'");
    expect((src.match(/className=\{TOUCH\}|\$\{TOUCH\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(src).toContain('min-h-[44px] sm:min-h-[36px]'); // lien de téléchargement
    expect(src).toMatch(/flex flex-wrap/);
    expect(src).toMatch(/break-all font-mono/);
    expect(src).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
  });
});

describe('C802-C-05 — la page transmet les filtres actifs de chaque onglet', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/admin/ai-executions/page.tsx'), 'utf8');
  it('journal (vue métier, exécutions techniques), appels modèles (filtres d’appels), autres onglets (bloqués)', () => {
    expect(page).toContain(`<ExecutionExportsPanel scope="executions" params={journalParams(jf, vue === 'metier' ? 'BUSINESS' : 'TECHNICAL')}`);
    expect(page).toContain('<ExecutionExportsPanel scope="calls" params={executionFiltersToParams(filters)}');
    expect(page).toContain('<ExecutionExportsPanel scope={tab} params={new URLSearchParams()} summary="" />');
  });
});
