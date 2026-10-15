/**
 * Lot 60 — cartes T6 de l'accueil : commandes « Me le rappeler plus tard » et
 * « Ne plus me rappeler », desktop ET mobile (un seul composant, aucune
 * variante masquée selon la largeur), et réglage depuis le détail de
 * l'échéance. Rendu serveur (`renderToStaticMarkup`) + lecture des sources.
 *
 *  T6-INT-15  chaque carte d'échéance porte SES commandes (id de l'échéance) ;
 *             une carte sans rappel (traitement, « À traiter ») n'en a pas ;
 *  T6-INT-16  intitulés de carte non concaténés ;
 *  T6-INT-23  desktop et mobile : mêmes commandes, jetons existants ;
 *             modifiables depuis le détail de l'échéance (agenda).
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MascotPresentation } from '@/services/home/mascot/types';

vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
const mascot = vi.hoisted(() => ({ presentation: null as unknown }));
vi.mock('@/components/home/useMascotPresentation', () => ({
  useMascotPresentation: () => ({ presentation: mascot.presentation, failed: false, refresh: async () => {}, trackClick: () => {} }),
  prefetchMascotPresentation: () => {},
}));
vi.mock('@/components/verebona/space/VerebonaSpaceProvider', () => ({ useVerebonaSpace: () => null }));
vi.mock('@/contexts/WriteGuardContext', () => ({ useWriteGuard: () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} }) }));
(globalThis as { React?: typeof React }).React = React;

const { MascotSpeaks, withoutSubjects } = await import('../MascotSpeaks');
const { reminderStatusLabel, reminderDateLabel } = await import('../T6ReminderControls');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const para = (id: number, titre: string, reminder = true) => ({
  subjectId: `DATE-NEXT:${id}`, sourceCode: 'DATE-NEXT', occurrenceKey: `DATE-NEXT:${id}`,
  text: `${titre} est à prévoir.`, highlight: null,
  actions: [{ actionId: `DATE:${id}:open`, label: 'Voir l’échéance', target: { kind: 'drawer' as const, drawer: 'echeance' as const, id, mode: 'view' as const } }],
  tile: { tone: 'amber' as const, icon: 'calendar-days' as const, label: titre, assetName: 'Maison', status: 'Action à prévoir · 4 novembre 2026', attention: true, kind: 'action' as const },
  ...(reminder ? { reminder: { agendaItemId: id, suggestedDate: '2026-10-28', hasSeries: id === 2 } } : {}),
});
const pres = (paragraphs: unknown[]): MascotPresentation => ({
  schemaVersion: 'mascot-presentation-v1', status: 'ok', source: 'fallback', contextHash: 'h', paragraphs: paragraphs as never,
  secondaries: [], degradedNotice: null, computedAt: '2026-10-15T08:00:00Z', todo: { total: 0, items: [] },
});
const rendu = (p: MascotPresentation) => {
  mascot.presentation = p;
  return renderToStaticMarkup(h(MascotSpeaks, { greetingName: 'Fabien', empty: false, onCreateAsset: () => {}, onUploadDocument: () => {}, pageSuggestions: [] }));
};

describe('Cartes T6 de l’accueil — commandes de rappel', () => {
  it('T6-INT-15 / T6-INT-16 — une carte par échéance, chacune avec SES deux commandes ; intitulés distincts', () => {
    const html = rendu(pres([para(1, 'Révision chaudière'), para(2, 'Entretien pompe à chaleur')]));
    expect(html.match(/data-t6-reminder="1"/g)).toHaveLength(1);
    expect(html.match(/data-t6-reminder="2"/g)).toHaveLength(1);
    expect(html.match(/Me le rappeler plus tard/g)).toHaveLength(2);
    expect(html.match(/Ne plus me rappeler/g)).toHaveLength(2);
    expect(html).toContain('Révision chaudière');
    expect(html).not.toMatch(/Révision chaudière et /);
  });

  it('carte sans rappel (sujet hors décision d’interpellation) : aucune commande', () => {
    const html = rendu(pres([para(3, 'Document en analyse', false)]));
    expect(html).not.toContain('Me le rappeler plus tard');
    expect(html).not.toContain('data-t6-reminder');
  });

  it('retrait immédiat d’une carte reportée ou refusée : texte et carte disparaissent ensemble', () => {
    const p = withoutSubjects(pres([para(1, 'Révision chaudière'), para(2, 'Entretien pompe à chaleur')]), new Set(['DATE-NEXT:1']))!;
    expect(p.paragraphs.map((x) => x.occurrenceKey)).toEqual(['DATE-NEXT:2']);
    const html = rendu(p);
    expect(html).not.toContain('Révision chaudière');
  });

  it('T6-INT-23 — desktop et mobile : même composant, aucune variante masquée, jetons existants ; détail de l’échéance', () => {
    const src = read('src/components/home/T6ReminderControls.tsx');
    expect(src).not.toMatch(/className=\{?["`][^"`]*(^|\s)(sm:|md:|lg:)?hidden(\s|["`])/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b/); // aucune couleur en dur
    for (const c of ['@/components/ui/dialog', '@/components/ui/date-picker', '@/components/ui/radio-group', '@/components/ui/button']) expect(src).toContain(c);
    expect(src).toContain('Cette échéance et les prochaines de la même série');
    const drawer = read('src/components/agenda/AgendaItemDrawer.tsx');
    expect(drawer).toMatch(/<T6ReminderSettings agendaItemId=\{item\.id\}/);
    expect(read('src/components/home/MascotSpeaks.tsx')).toContain('<T6ReminderActions');
  });

  it('état affiché dans le détail : actif, reporté (date), refusé (occurrence / série)', () => {
    expect(reminderDateLabel('2026-11-04')).toBe('4 novembre 2026');
    expect(reminderStatusLabel({ occurrence: null, series: null })).toMatch(/^Actifs/);
    expect(reminderStatusLabel({ occurrence: { scope: 'OCCURRENCE', decision: 'SNOOZED', remindAt: '2026-11-04', updatedAt: '' }, series: null })).toBe('Reportés au 4 novembre 2026');
    expect(reminderStatusLabel({ occurrence: { scope: 'OCCURRENCE', decision: 'DISMISSED', remindAt: null, updatedAt: '' }, series: null })).toBe('Désactivés pour cette échéance');
    expect(reminderStatusLabel({ occurrence: null, series: { scope: 'SERIES', decision: 'DISMISSED', remindAt: null, updatedAt: '' } })).toMatch(/série/);
  });
});
