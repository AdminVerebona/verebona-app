/**
 * Lot 99A (ticket P1 T3, §3) — BO › Exécutions & logs › Journal complet :
 * vue synthétique par défaut (rendu statique, sans réseau).
 *
 *   L99A-J01  état global calculé sur les issues réelles : OK / À surveiller / Incident (seuils isolés)
 *   L99A-J02  synthèse par traitement : total, réussies, en cours ; échecs / incomplètes en liens, jamais en tuiles
 *   L99A-J03  bouton « Voir les exécutions » / « Masquer les exécutions » (aria-expanded), aucune ligne en vue synthétique
 *   L99A-J04  liste ouverte d'emblée seulement sur demande ou par un lien filtré ; `liste=0` respecté
 *   L99A-J05  usage de l'IA par traitement en compteurs distincts (appels réels / cache / réutilisées)
 *   L99A-J06  desktop et mobile : une colonne puis deux, enroulement, cibles ≥ 40 px ; page câblée (rows=0, cartes)
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { JournalSynthesisView, initialJournalListOpen } = await import('../BusinessJournal');
const { journalSynthesis, JOURNAL_HEALTH_RULES } = await import('@/services/ai/business-execution/journal');
type Row = Parameters<typeof journalSynthesis>[0][number];

const r = (treatment: Row['treatment'], outcome: Row['outcome'], o: Partial<Row> = {}): Row =>
  ({ treatment, outcome, nature: 'BUSINESS', origin: 'AUTOMATIC', accountId: 13, ...o });
const F = { treatment: null, origin: null, accountId: null, nature: 'BUSINESS' as const };
const sp = (q: string) => new URLSearchParams(q);

describe('L99A-J01 — état global sur les issues réelles', () => {
  it('OK : uniquement des réussites, des exécutions en cours ou sans objet', () => {
    const s = journalSynthesis([...Array(24)].map(() => r('T3', 'SUCCEEDED')).concat([r('T3', 'NOT_FINAL'), r('T4', 'VOID')]), F);
    expect(s).toMatchObject({ health: 'OK', healthLabel: 'OK', total: 26, finals: 24, reasons: [] });
  });
  it('À surveiller : une incomplète ou un échec isolé sous le seuil', () => {
    const rows = [...Array(40)].map(() => r('T1', 'SUCCEEDED'));
    expect(journalSynthesis([...rows, r('T1', 'INCOMPLETE')], F)).toMatchObject({ health: 'WATCH', healthLabel: 'À surveiller' });
    const s = journalSynthesis([...rows, r('T3', 'FAILED')], F);
    expect(s.health).toBe('WATCH');
    expect(s.reasons[0]).toBe('1 échec sur 41 exécutions finales (T3 : 1)');
  });
  it('Incident : au moins INCIDENT_MIN_FAILED échecs, ou une part d’échecs ≥ INCIDENT_FAILED_RATE', () => {
    expect(JOURNAL_HEALTH_RULES).toEqual({ INCIDENT_MIN_FAILED: 3, INCIDENT_FAILED_RATE: 0.1 });
    const succes = [...Array(100)].map(() => r('T1', 'SUCCEEDED'));
    expect(journalSynthesis([...succes, r('T1', 'FAILED'), r('T3', 'FAILED'), r('T4', 'FAILED')], F).health).toBe('INCIDENT');
    expect(journalSynthesis([r('T2', 'SUCCEEDED'), r('T2', 'FAILED')], F).health).toBe('INCIDENT');
  });
  it('mêmes filtres que les cartes : nature de la vue, traitement, origine, compte (l’issue n’est pas filtrée)', () => {
    const rows = [r('T3', 'FAILED'), r('T3', 'SUCCEEDED', { nature: 'TECHNICAL' }), r('T1', 'FAILED', { accountId: 7 })];
    expect(journalSynthesis(rows, { ...F, accountId: 13 })).toMatchObject({ total: 1, health: 'INCIDENT' });
    expect(journalSynthesis(rows, { ...F, nature: 'TECHNICAL' })).toMatchObject({ total: 1, health: 'OK' });
    expect(journalSynthesis(rows, { ...F, treatment: 'T1' }).byTreatment.map((x) => x.treatment)).toEqual(['T1']);
  });
});

describe('L99A-J02/J03/J05 — bloc compact', () => {
  const synthesis = journalSynthesis([
    ...[...Array(24)].map(() => r('T3', 'SUCCEEDED')), r('T1', 'SUCCEEDED'), r('T1', 'INCOMPLETE'), r('T1', 'FAILED'), r('T4', 'NOT_FINAL'),
  ], F);
  const aiUsage = { available: true, byTreatment: { T3: { providerCalls: 1, cacheResponses: 0, decisionsReused: 23 }, T1: { providerCalls: 3, cacheResponses: 0, decisionsReused: 0 } } };
  const rendu = (open: boolean) => renderToStaticMarkup(h(JournalSynthesisView, {
    synthesis, aiUsage, view: 'metier', periodLabel: 'dernières 24 h', open, onToggle: () => {}, onOpenFiltered: () => {},
  }));

  it('L99A-J02 : état, période, total ; une ligne par traitement ; échecs et incomplètes en liens (pas de tuile en double)', () => {
    const html = rendu(false);
    expect(html).toContain('data-health="WATCH"');
    expect(html).toContain('État : À surveiller');
    expect(html).toContain('dernières 24 h · 28 exécutions métiers');
    expect((html.match(/data-testid="journal-synthese-traitement"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/T3<\/span><span[^>]*>24 exécutions<\/span><span[^>]*>24 réussies/);
    expect(html).toContain('data-testid="synthese-failed"');
    expect(html).toContain('data-testid="synthese-incomplete"');
    expect(html).toContain('1 en cours');
    expect(html).not.toContain('card-failed');
  });
  it('L99A-J03 : « Voir les exécutions » replié, « Masquer les exécutions » déplié ; aucune ligne de journal dans le bloc', () => {
    expect(rendu(false)).toMatch(/aria-expanded="false"[^>]*data-testid="journal-toggle"[\s\S]*Voir les exécutions/);
    expect(rendu(true)).toMatch(/aria-expanded="true"[^>]*data-testid="journal-toggle"[\s\S]*Masquer les exécutions/);
    expect(rendu(false)).not.toContain('journal-row');
  });
  it('L99A-J05 : usage de l’IA par traitement — appels réels, réponses du cache, décisions réutilisées', () => {
    expect(rendu(false)).toContain('IA : 1 appel réel · 0 réponse du cache · 23 décisions réutilisées');
  });
  it('avant lecture : « — », jamais 0 ; période vide : message explicite', () => {
    const vide = renderToStaticMarkup(h(JournalSynthesisView, { synthesis: null, view: 'technique', periodLabel: '7 derniers jours', open: false, onToggle: () => {}, onOpenFiltered: () => {}, loading: true }));
    expect(vide).toContain('État : calcul…');
    expect(vide).toContain('7 derniers jours · —');
    const aucune = renderToStaticMarkup(h(JournalSynthesisView, { synthesis: journalSynthesis([], F), view: 'technique', periodLabel: '7 derniers jours', open: false, onToggle: () => {}, onOpenFiltered: () => {} }));
    expect(aucune).toContain('Aucune exécution technique sur la période.');
  });
});

describe('L99A-J04 — ouverture de la liste', () => {
  it('par défaut : vue synthétique ; sur demande (liste=1) ou lien filtré : liste ouverte ; liste=0 : repliée', () => {
    expect(initialJournalListOpen(sp(''))).toBe(false);
    expect(initialJournalListOpen(sp('days=7&vue=metier'))).toBe(false);
    expect(initialJournalListOpen(sp('liste=1'))).toBe(true);
    expect(initialJournalListOpen(sp('outcome=FAILED'))).toBe(true);
    expect(initialJournalListOpen(sp('treatment=T3'))).toBe(true); // lien de Configuration IA
    expect(initialJournalListOpen(sp('vue=technique&model=gemini&rank=fallback_1'))).toBe(true); // liens Coûts / File IA
    expect(initialJournalListOpen(sp('vue=technique&tab=calls&liste=0'))).toBe(false);
  });
});

describe('L99A-J06 — mobile et câblage de la page', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/admin/ai-executions/_components/BusinessJournal.tsx'), 'utf8');
  const page = readFileSync(join(process.cwd(), 'src/app/admin/ai-executions/page.tsx'), 'utf8');
  const route = readFileSync(join(process.cwd(), 'src/app/api/admin/ai/business-executions/route.ts'), 'utf8');
  it('une colonne puis deux, enroulement, cibles tactiles ≥ 40 px, aucune largeur fixe', () => {
    const bloc = src.slice(src.indexOf('export function JournalSynthesisView'));
    expect(bloc).toContain('grid-cols-1 sm:grid-cols-2');
    expect(bloc).toContain('flex-wrap');
    expect(bloc).toContain('min-h-[40px]');
    expect(bloc).not.toMatch(/\bw-\[\d+px\]/);
  });
  it('vue synthétique : rows=0 (aucune ligne lue) ; cartes → liste filtrée ; liste dans l’URL ; exports toujours présents', () => {
    expect(page).toContain("{ rows: '0' }");
    expect(page).toMatch(/const openCard[\s\S]*setListeOuverte\(true\)/);
    expect(page).toContain("q.set('liste', listeOuverte ? '1' : '0')");
    expect(page).toContain("{(vue === 'metier' || tab === 'tech') && (\n        <ExecutionExportsPanel");
    expect(route).toContain("p.get('rows') === '0'");
    expect(route).toContain('synthesis: { ...journalSynthesis(proj.rows, f), aiUsage: usage }');
  });
});
