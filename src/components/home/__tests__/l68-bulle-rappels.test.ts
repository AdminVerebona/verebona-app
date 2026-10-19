/**
 * Lot 68 — bulle de l'accueil allégée et menu « Rappels » : rendu serveur
 * (`renderToStaticMarkup`) de `MascotSpeaks` à partir de présentations
 * produites par le VRAI moteur (signaux → sélection → présentation), et
 * lecture des sources. Desktop et mobile : un seul composant.
 *
 *  T6-RAP-12  un bloc par sujet : texte une fois, « Voir » et « Rappels » ; plus d'introduction de
 *             comptage ni de carte imbriquée ; rappel informatif sans « Action à prévoir »
 *  T6-RAP-13  menu « Rappels » : bouton accessible (clavier, mobile), rattaché au bon sujet,
 *             « Me le rappeler plus tard » / « Ne plus me rappeler », date, portée, confirmations
 *  T6-RAP-14  desktop ET mobile : même composant, zones tactiles conservées (44 px mobile),
 *             aucun texte tronqué, jetons de la charte uniquement
 *  T6-RAP-15  « À traiter », invitation Duo et étape d'accueil toujours en cartes ; 0 / 1 / 2 sujets
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

const { MascotSpeaks } = await import('../MascotSpeaks');
const { buildCandidates } = await import('@/services/home/mascot/signals');
const { selectSubjects, buildSecondaries } = await import('@/services/home/mascot/selector');
const { buildPresentation } = await import('@/services/home/mascot/presentation');
type Raw = import('@/services/home/mascot/signals').MascotRawData;
type Row = import('@/services/home/mascot/signals').MascotAgendaRow;
type Decided = import('@/services/home/mascot/signals').MascotDecidedAgenda;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const TODAY = '2026-10-18';
const VISITE: Row = { id: 1, title: 'Visite expert bois', date: '2026-10-22', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'SCHEDULED_EVENT', seriesKey: null };
const RAMONAGE: Row = { id: 2, title: 'Ramonage cheminée', date: '2026-11-04', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'DEADLINE', seriesKey: 'r' };
const raw = (agenda: Row[], over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda, acknowledgments: [], overdueAgenda: [], ...over,
} as Raw);
const informe = (id: number): Decided => ({ agendaItemId: id, interpellation: { mode: 'INFORM', priority: 'LOW', code: 'AI_INFORM', reasonCode: 'INFORMATIVE_REMINDER', category: 'INFORMATION' }, action: null, reminder: { agendaItemId: id, suggestedDate: '2026-10-21', hasSeries: false } });
const action = (id: number): Decided => ({ agendaItemId: id, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW', reasonCode: 'ACTION_REQUIRED_SOON', category: 'ACTION_NOW' }, action: 'Prendre rendez-vous pour le ramonage', reminder: { agendaItemId: id, suggestedDate: '2026-10-28', hasSeries: true } });
function accueil(r: Raw, shown: Decided[], o: Partial<Parameters<typeof buildPresentation>[0]> = {}): MascotPresentation {
  const c = buildCandidates(r, { interpellation: { shown } });
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, todo: { total: 0, items: [] }, ...o });
}
const rendu = (p: MascotPresentation) => {
  mascot.presentation = p;
  return renderToStaticMarkup(h(MascotSpeaks, { greetingName: 'Fabien', empty: false, onCreateAsset: () => {}, onUploadDocument: () => {}, pageSuggestions: [] }));
};
/** Texte VISIBLE de la bulle (balises et attributs retirés). */
const bulleVisible = (html: string) => {
  const i = html.indexOf('data-mascot-bubble');
  const j = html.indexOf('aria-label="Ou demandez-moi"');
  return html.slice(html.indexOf('>', i) + 1, j > i ? j : undefined)
    .replace(/<\/?(span|strong)\b[^>]*>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/\s+/g, ' ');
};
const n = (t: string, re: RegExp) => (t.match(new RegExp(re.source, 'gi')) ?? []).length;

describe('Bulle allégée — un bloc par sujet', () => {
  it('T6-RAP-12 — cas de la capture : un seul bloc, sujet / bien / date une fois, « Voir » et « Rappels », aucune introduction ni « Action à prévoir »', () => {
    const html = rendu(accueil(raw([VISITE]), [informe(1)]));
    const t = bulleVisible(html);
    expect(t).toContain('La visite expert bois de la maison est prévue le 22 octobre 2026.');
    expect(n(t, /22 octobre 2026/)).toBe(1);
    expect(n(t, /expert bois/)).toBe(1);
    expect(n(t, /maison/)).toBe(1);
    expect(t).not.toMatch(/mérite votre attention|méritent votre attention|À prévoir :|Action à prévoir|préparer/i);
    expect(html.match(/data-subject-block=/g)).toHaveLength(1);
    expect(html).toContain('data-subject-nature="information"');
    expect(html).not.toContain('data-subject-badge');
    expect(t).toMatch(/Voir .*Rappels/);
    // Plus de carte imbriquée (ItemButton) pour le sujet.
    expect(html).not.toContain('aria-label="Sujets à traiter"');
    // Le bouton « Rappels » renvoie au texte du sujet au lieu de le répéter.
    const id = /<p id="([^"]+)"[^>]*>(?:<span>)?La visite expert bois/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-describedby="${id}"`);
  });

  it('T6-RAP-12 — action établie : nature visible (« Action à prévoir »), action réelle sans préfixe, avant le rappel', () => {
    const html = rendu(accueil(raw([VISITE, RAMONAGE]), [action(2), informe(1)]));
    const t = bulleVisible(html);
    expect(html.match(/data-subject-block=/g)).toHaveLength(2);
    expect(t.indexOf('ramonage')).toBeLessThan(t.indexOf('expert bois'));
    expect(n(t, /Action à prévoir/)).toBe(1);
    expect(t).toContain('Prendre rendez-vous pour le ramonage.');
    expect(t).not.toMatch(/À prévoir :|mérite/);
    expect(html.match(/data-subject-nature="action"/g)).toHaveLength(1);
    expect(html.match(/data-subject-nature="information"/g)).toHaveLength(1);
  });
});

describe('Menu « Rappels »', () => {
  it('T6-RAP-13 — un bouton « Rappels » par sujet décidé, accessible au clavier et sur mobile, rattaché à SON échéance', () => {
    const html = rendu(accueil(raw([VISITE, RAMONAGE]), [action(2), informe(1)]));
    expect(html.match(/data-t6-reminder="2"/g)).toHaveLength(1);
    expect(html.match(/data-t6-reminder="1"/g)).toHaveLength(1);
    // Bouton natif + menu Radix : Entrée / Espace / flèches / Échap, toucher sur mobile.
    const boutons = html.match(/<button[^>]*data-t6-reminder-menu[^>]*>/g) ?? [];
    expect(boutons).toHaveLength(2);
    for (const b of boutons) expect(b).toMatch(/aria-haspopup="menu"/);
    for (const b of boutons) expect(b).toMatch(/type="button"/);
    const src = read('src/components/home/T6ReminderControls.tsx');
    expect(src).toContain("from '@/components/ui/dropdown-menu'");
    expect(src).toContain('<DropdownMenu modal={false}>');
    expect(src).toMatch(/onSelect=\{\(\) => setSnooze\(true\)\}[^>]*>\s*<BellRing aria-hidden \/> Me le rappeler plus tard/);
    expect(src).toMatch(/onSelect=\{\(\) => setDismiss\(true\)\}[^>]*>\s*<BellOff aria-hidden \/> Ne plus me rappeler/);
    // Date, portée occurrence / série, confirmations, erreurs et modification : conservées.
    for (const c of ['<DatePicker id="t6-snooze-date"', 'Cette échéance seulement', 'Cette échéance et les prochaines de la même série',
      'C’est noté : je vous le rappellerai le', 'C’est noté : je ne vous le rappellerai plus', 'Votre choix n’a pas pu être enregistré. Réessayez.',
      "label: 'Annuler'", 'export function T6ReminderSettings']) expect(src).toContain(c);
    // Sujet sans échéance décidée (document en analyse) : aucun menu.
    const doc = rendu(accueil(raw([], { processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-18T08:00:00Z' }], exports: [] } }), []));
    expect(doc).not.toContain('data-t6-reminder');
    expect(bulleVisible(doc)).toContain('Le document « Facture garage » est en cours d’analyse.');
    expect(bulleVisible(doc)).toMatch(/Voir/);
  });
});

describe('Desktop et mobile', () => {
  it('T6-RAP-14 — même composant, zones tactiles 44 px (mobile) / 36 px (ordinateur), aucun texte tronqué, jetons de la charte', () => {
    const actions = read('src/components/home/bubble-actions.ts');
    expect(actions).toContain('min-h-[44px]');
    expect(actions).toContain('md:min-h-[36px]');
    const ms = read('src/components/home/MascotSpeaks.tsx');
    const bloc = ms.slice(ms.indexOf('function SubjectBlockView'), ms.indexOf('function ItemButton'));
    expect(bloc).not.toMatch(/(^|\s)(sm:|md:|lg:)?hidden(\s|["`])/);
    expect(bloc).not.toMatch(/truncate|line-clamp/);
    expect(bloc).toContain('break-words');
    for (const f of ['src/components/home/bubble-actions.ts', 'src/components/home/T6ReminderControls.tsx']) {
      const s = read(f);
      expect(s).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
      expect(s).not.toMatch(/focus-visible:ring|focus:ring/); // règle globale de focus (lot 66)
    }
    expect(bloc).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    // Le menu tient sur mobile (largeur bornée à l'écran), items de 44 px.
    const src = read('src/components/home/T6ReminderControls.tsx');
    expect(src).toContain('w-[min(18rem,calc(100vw-2rem))]');
    expect(src).toContain("const MENU_ITEM = 'min-h-[44px]");
  });
});

describe('Cartes conservées et nombre de sujets', () => {
  it('T6-RAP-15 — « À traiter » et Duo en cartes sous l’en-tête qui les compte ; 0, 1 et 2 sujets', () => {
    const duo = { href: '/mon-compte?panneau=duo', title: 'Inviter quelqu’un', subtitle: 'Premium Duo', cta: 'Inviter' };
    const item = { todoId: 't1', actionKind: 'COMPLETE', priority: 'DO_FIRST', title: 'Numéro à compléter', subtitle: 'Maison', cta: 'Ouvrir', entityType: 'ASSET', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Numéro ?' } } as never;
    const html = rendu(accueil(raw([VISITE]), [informe(1)], { todo: { total: 2, items: [item] }, duoInvite: duo }));
    const t = bulleVisible(html);
    expect(t.indexOf('Deux sujets nécessitent votre attention aujourd’hui.')).toBeLessThan(t.indexOf('Inviter quelqu’un'));
    expect(t.indexOf('Numéro à compléter')).toBeLessThan(t.indexOf('La visite expert bois'));
    expect(html).toContain('data-action-type="DUO_INVITE"');
    expect(html).toContain('data-todo-id="t1"');
    // 0 sujet : phrase proportionnée ; 1 et 2 sujets : jamais « rien à signaler ».
    expect(bulleVisible(rendu(accueil(raw([VISITE]), [])))).toContain('Rien de particulier à vous signaler pour le moment.');
    expect(bulleVisible(rendu(accueil(raw([VISITE]), [], { evaluation: 'UNAVAILABLE' })))).toContain('Je ne peux pas examiner vos échéances');
    for (const shown of [[informe(1)], [action(2), informe(1)]]) {
      const v = bulleVisible(rendu(accueil(raw([VISITE, RAMONAGE]), shown)));
      expect(v).not.toMatch(/Rien de particulier|mérite votre attention/);
    }
  });
});
