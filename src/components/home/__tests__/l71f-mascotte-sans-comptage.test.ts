/**
 * Lot 71F — BUG P1 « Mascotte : supprimer définitivement les introductions
 * « X sujets méritent votre attention » ». Rendu serveur complet
 * (`renderToStaticMarkup`) de `MascotSpeaks` à partir de présentations du
 * VRAI moteur (signaux → sélection → présentation). Desktop et mobile : un
 * seul composant, une seule bulle (les classes `md:` ne changent que la
 * mise en page) — le texte n'y figure qu'une fois.
 *
 *  L71F-CAPTURE  scénario exact de la capture : bien « garage », aucun document, ONB-DOC
 *  L71F-ONB      ONB-DOC / ONB-ASSET : instruction directe, sans introduction
 *  L71F-ATP      1 et 2 « À traiter » : cartes directes, sans comptage
 *  L71F-DUO      invitation Duo seule ; Duo + « À traiter » : aucune introduction
 *  L71F-T6       1 ou 2 sujets T6 : textes directs ; message T6 historique (cache) non affiché
 *  L71F-ETAT     T6 indisponible, aucun sujet, information seule : messages d'état conservés
 *  L71F-UI       aucun doublon, aucun paragraphe vide, actions accessibles, desktop = mobile
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
const mascot = vi.hoisted(() => ({ presentation: null as unknown, failed: false }));
vi.mock('@/components/home/useMascotPresentation', () => ({
  useMascotPresentation: () => ({ presentation: mascot.presentation, failed: mascot.failed, refresh: async () => {}, trackClick: () => {} }),
  prefetchMascotPresentation: () => {},
}));
vi.mock('@/components/verebona/space/VerebonaSpaceProvider', () => ({ useVerebonaSpace: () => null }));
vi.mock('@/contexts/WriteGuardContext', () => ({ useWriteGuard: () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} }) }));
(globalThis as { React?: typeof React }).React = React;

const { MascotSpeaks } = await import('../MascotSpeaks');
const { buildCandidates } = await import('@/services/home/mascot/signals');
const { selectSubjects, buildSecondaries } = await import('@/services/home/mascot/selector');
const { buildPresentation } = await import('@/services/home/mascot/presentation');
const B = await import('@/services/home/mascot/bubble');
type Raw = import('@/services/home/mascot/signals').MascotRawData;
type Row = import('@/services/home/mascot/signals').MascotAgendaRow;
type Decided = import('@/services/home/mascot/signals').MascotDecidedAgenda;

const TODAY = '2026-10-19';
/** Toute introduction de comptage, accents et apostrophes indifférents. */
const COMPTAGE = /\b(un|une|deux|trois|\d+)\s+(sujets?|points?|éléments?)\s+(m[ée]rit|n[ée]cessit)|votre attention/i;

const GARAGE = { id: 3, name: 'garage' };
const raw = (over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [], ...over,
} as Raw);
const VISITE: Row = { id: 1, title: 'Visite expert bois', date: '2026-10-22', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'SCHEDULED_EVENT', seriesKey: null };
const RAMONAGE: Row = { id: 2, title: 'Ramonage cheminée', date: '2026-11-04', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'DEADLINE', seriesKey: 'r' };
const informe = (id: number): Decided => ({ agendaItemId: id, interpellation: { mode: 'INFORM', priority: 'LOW', code: 'AI_INFORM', reasonCode: 'INFORMATIVE_REMINDER', category: 'INFORMATION' }, action: null, reminder: { agendaItemId: id, suggestedDate: '2026-10-21', hasSeries: false } });
const action = (id: number): Decided => ({ agendaItemId: id, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW', reasonCode: 'ACTION_REQUIRED_SOON', category: 'ACTION_NOW' }, action: 'Prendre rendez-vous pour le ramonage', reminder: { agendaItemId: id, suggestedDate: '2026-10-28', hasSeries: true } });
const DUO = { href: '/mon-compte?panneau=duo', title: 'Inviter quelqu’un', subtitle: 'Premium Duo', cta: 'Inviter' };
const todo = (id: string, title: string) => ({ todoId: id, actionKind: 'COMPLETE', priority: 'DO_FIRST', title, subtitle: 'Maison', cta: 'Ouvrir', entityType: 'ASSET', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Numéro ?' } }) as never;

function accueil(r: Raw, shown: Decided[] = [], o: Partial<Parameters<typeof buildPresentation>[0]> = {}): MascotPresentation {
  const c = buildCandidates(r, { interpellation: { shown } });
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, todo: { total: 0, items: [] }, ...o });
}
const rendu = (p: MascotPresentation | null, o: { empty?: boolean; failed?: boolean } = {}) => {
  mascot.presentation = p;
  mascot.failed = o.failed ?? false;
  return renderToStaticMarkup(h(MascotSpeaks, { greetingName: 'Fabien', empty: o.empty ?? false, onCreateAsset: () => {}, onUploadDocument: () => {}, pageSuggestions: [] }));
};
/** Texte VISIBLE de la bulle (balises et attributs retirés). */
const bulle = (html: string) => {
  const i = html.indexOf('data-mascot-bubble');
  const j = html.indexOf('aria-label="Ou demandez-moi"');
  return html.slice(html.indexOf('>', i) + 1, j > i ? j : undefined)
    .replace(/<\/?(span|strong)\b[^>]*>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/\s+/g, ' ').trim();
};
const compter = (t: string, s: string) => t.split(s).length - 1;
/** Paragraphe d'en-tête de la bulle (hors blocs de sujet), ou null s'il n'est pas rendu. */
const entete = (html: string) => /<div aria-live="polite" aria-busy="false"><p\b[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? null;

describe('L71F-CAPTURE — scénario exact de la capture (bien « garage », aucun document, ONB-DOC)', () => {
  const p = accueil(raw({ onboarding: { activeAssets: [GARAGE], activeAssetCount: 1, documentCount: 0 } }));
  const html = rendu(p);
  const t = bulle(html);

  it('L71F-CAPTURE-01 — instruction directe, une seule fois, sans préambule ni « maintenant »', () => {
    expect(p.paragraphs.map((x) => x.sourceCode)).toEqual(['ONB-DOC']);
    expect(t).toBe('Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie. Déposer un document');
    expect(t).not.toMatch(COMPTAGE);
    expect(t).not.toMatch(/maintenant|aujourd’hui/);
    expect(compter(t, 'Ajoutez votre premier document')).toBe(1);
  });

  it('L71F-CAPTURE-02 — action « Déposer un document » (dépôt sur le bien), une seule fois, bouton accessible', () => {
    expect(compter(t, 'Déposer un document')).toBe(1);
    expect(html).toMatch(/<button type="button"[^>]*data-block-action="ONB-DOC:upload"[^>]*>Déposer un document/);
    const [b] = B.subjectBlocks(p);
    expect(b.actions[0].action.target).toEqual({ kind: 'upload_document', assetId: 3 });
    // Pas de carte « Déposer un document » qui répète le texte sous la bulle.
    expect(html).not.toContain('aria-label="Pour continuer"');
    expect(html).not.toContain('aria-label="Sujets à traiter"');
  });

  it('L71F-CAPTURE-03 — aucun en-tête rendu (ni texte, ni paragraphe vide) ; pas présenté comme une urgence', () => {
    expect(B.bubbleLead({ presentation: p, empty: false }).text).toBe('');
    expect(entete(html)).toBeNull();
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(html).not.toContain('data-subject-badge');
  });

  it('L71F-CAPTURE-04 — desktop et mobile : un seul composant, le texte n’est rendu qu’une fois (aucune variante masquée)', () => {
    expect(compter(html, 'data-mascot-bubble')).toBe(1);
    expect(compter(html, ' pour garage : une facture, un contrat ou une garantie.')).toBe(1);
    expect(compter(html, 'data-subject-block=')).toBe(1);
    const src = readFileSync(join(process.cwd(), 'src/components/home/MascotSpeaks.tsx'), 'utf8');
    // Code (commentaires retirés) : aucune introduction de comptage.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/todoSummary|sujets? (mérite|nécessite)|votre attention/);
  });
});

describe('L71F — autres parcours, desktop et mobile (même rendu)', () => {
  it('L71F-ONB — ONB-ASSET : instruction directe, sans introduction', () => {
    const p = accueil(raw({ onboarding: { activeAssets: [], activeAssetCount: 0, documentCount: 2 } }));
    const t = bulle(rendu(p));
    expect(t.startsWith('Pour commencer, ajoutez votre premier bien')).toBe(true);
    expect(t).not.toMatch(COMPTAGE);
  });

  it('L71F-ATP — 1 puis 2 « À traiter » : cartes directes, aucun en-tête de comptage, jamais « rien à signaler »', () => {
    for (const items of [[todo('t1', 'Numéro à compléter')], [todo('t1', 'Numéro à compléter'), todo('t2', 'Date à vérifier')]]) {
      const html = rendu(accueil(raw(), [], { todo: { total: items.length, items } }));
      const t = bulle(html);
      expect(t).not.toMatch(COMPTAGE);
      expect(t).not.toMatch(/Rien de particulier|Aucun sujet à traiter/);
      expect(entete(html)).toBeNull();
      expect(html.match(/data-todo-id=/g)).toHaveLength(items.length);
      expect(t.startsWith('Numéro à compléter')).toBe(true);
    }
  });

  it('L71F-DUO — invitation Duo seule, puis Duo + « À traiter » : proposition directe, aucune introduction', () => {
    const seul = rendu(accueil(raw(), [], { duoInvite: DUO }));
    expect(bulle(seul).startsWith('Inviter quelqu’un')).toBe(true);
    expect(bulle(seul)).not.toMatch(COMPTAGE);
    expect(entete(seul)).toBeNull();
    const avec = rendu(accueil(raw(), [], { duoInvite: DUO, todo: { total: 1, items: [todo('t1', 'Numéro à compléter')] } }));
    expect(bulle(avec)).not.toMatch(COMPTAGE);
    expect(bulle(avec).indexOf('Inviter quelqu’un')).toBeLessThan(bulle(avec).indexOf('Numéro à compléter'));
    // Compte encore vide : message d'accueil puis la carte, sans comptage.
    const vide = bulle(rendu(accueil(raw(), [], { duoInvite: DUO }), { empty: true }));
    expect(vide).toContain('Votre espace est prêt, mais encore vide.');
    expect(vide).not.toMatch(COMPTAGE);
  });

  it('L71F-T6 — 1 ou 2 sujets T6 (secours et formulés) : textes directs', () => {
    for (const shown of [[informe(1)], [action(2), informe(1)]]) {
      const html = rendu(accueil(raw({ agenda: [VISITE, RAMONAGE] }), shown));
      expect(bulle(html)).not.toMatch(COMPTAGE);
      expect(html.match(/data-subject-block=/g)).toHaveLength(shown.length);
      expect(entete(html)).toBeNull();
    }
    const c = buildCandidates(raw({ agenda: [VISITE] }), { interpellation: { shown: [informe(1)] } });
    const s = selectSubjects(c.candidates);
    const ok = 'La visite de l’expert bois pour la maison est prévue le 22 octobre 2026.';
    const p = buildPresentation({ subjects: s, secondaries: [], degraded: false, messages: [{ subjectId: s[0].subjectId, text: ok, highlight: null }], today: TODAY });
    expect(bulle(rendu(p)).startsWith(ok)).toBe(true);
  });

  it('L71F-T6-CACHE — message T6 historique (cache, sans accent / apostrophe droite / pluriel) : formulation interdite jamais affichée', () => {
    const c = buildCandidates(raw({ agenda: [VISITE] }), { interpellation: { shown: [informe(1)] } });
    const s = selectSubjects(c.candidates);
    for (const ancien of [
      'Un sujet mérite votre attention aujourd’hui : la visite expert bois de la maison, le 22 octobre 2026.',
      'UN SUJET MERITE VOTRE ATTENTION AUJOURD\'HUI : la visite expert bois de la maison, le 22 octobre 2026.',
      'Deux sujets nécessitent votre attention. La visite expert bois de la maison est prévue le 22 octobre 2026.',
    ]) {
      const p = buildPresentation({ subjects: s, secondaries: [], degraded: false, messages: [{ subjectId: s[0].subjectId, text: ancien, highlight: null }], today: TODAY });
      // Serveur : texte de secours du sujet.
      expect(p.paragraphs[0].text).toBe(s[0].fallbackText);
      const t = bulle(rendu(p));
      expect(t).not.toMatch(COMPTAGE);
      expect(t).not.toMatch(/MERITE/);
    }
    // Présentation servie par un serveur antérieur (paragraphe déjà porteur
    // d'une introduction) : retirée à l'écran, sans phrase de remplacement.
    const ancienne = accueil(raw({ onboarding: { activeAssets: [GARAGE], activeAssetCount: 1, documentCount: 0 } }));
    const p = { ...ancienne, paragraphs: ancienne.paragraphs.map((x) => ({ ...x, text: `Un sujet mérite votre attention aujourd’hui : Ajoutez maintenant votre premier document pour garage : une facture, un contrat ou une garantie.` })) };
    const t = bulle(rendu(p));
    expect(t).toBe('Ajoutez maintenant votre premier document pour garage : une facture, un contrat ou une garantie. Déposer un document');
  });

  it('L71F-ETAT — T6 indisponible, évaluation en cours, panne, aucun sujet, information seule : messages d’état conservés', () => {
    expect(bulle(rendu(accueil(raw({ agenda: [VISITE] }), [], { evaluation: 'UNAVAILABLE' })))).toContain(B.EVALUATION_UNAVAILABLE_SPEECH.replace(/'/g, '’'));
    expect(bulle(rendu(accueil(raw({ agenda: [VISITE] }), [], { evaluation: 'PENDING' })))).toContain(B.EVALUATION_PENDING_SPEECH);
    expect(bulle(rendu(accueil(raw())))).toBe(B.NOTHING_TO_REPORT_SPEECH);
    expect(bulle(rendu(accueil(raw(), [], { todo: { total: 3, items: [] } })))).toBe(B.NOTHING_PRIORITY);
    expect(bulle(rendu(null, { failed: true }))).toBe(B.DEGRADED_SPEECH);
    const info = bulle(rendu(accueil(raw({ processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-19T08:00:00Z' }], exports: [] } }))));
    expect(info.startsWith('Le document « Facture garage » est en cours d’analyse.')).toBe(true);
    expect(info).not.toMatch(COMPTAGE);
  });
});
