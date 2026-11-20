/**
 * Lot 115C — Trello #752 « Accueil web/mobile : corriger les délais
 * d'échéances inexacts et afficher l'année », sur PostgreSQL réel.
 *
 * Le délai n'est pas éprouvé sur une fonction isolée mais SUR L'ACCUEIL
 * COMPLET : vrai service de l'Agenda pour écrire les événements, vrai résumé
 * d'accueil (`buildHomeSummary`, qui lit la base et décide du jour de
 * référence), puis vrai rendu de l'interface (le même composant pour le web
 * et pour l'application mobile, décision 108G). Aucune IA, aucune migration.
 *
 * Horloge simulée (`Date` seulement) : aucun test ne dépend de la date du
 * jour. Les instants sont écrits avec leur décalage de Paris, de sorte que
 * la bascule de minuit et le changement d'heure sont réellement traversés.
 *
 * Correspondance avec la section 4 de la carte : voir
 * `docs/exploitation/recette-115c-delais-echeances.md`.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: async () => null }));
// Classification de l'accueil : aucun appel modèle.
vi.mock('@/services/ai/agenda/agenda-intelligence.service', async (o) => ({
  ...(await o<object>()), classifyAgendaCategory: async () => null,
}));
// Composants de l'accueil : seules les lignes d'échéance nous intéressent.
vi.mock('@/lib/drawers', () => ({ openDrawer: () => {} }));
vi.mock('@/hooks/useThumbnailUrl', () => ({ useThumbnailUrl: () => null }));

(globalThis as { React?: typeof React }).React = React;

type Compte = { id: number; ownerUserId: number };

/** Jour civil de référence de la capture iOS de la carte, à Paris (heure d'hiver). */
const JOUR = '2026-11-12';
const MIDI_PARIS = new Date(`${JOUR}T12:00:00+01:00`);

scenario('L115C', 'Accueil : délais d’échéances calendaires exacts, année visible, jour civil de Paris', ({ sql, make }) => {
  let moi: Compte = { id: 0, ownerUserId: 0 };
  let autre: Compte = { id: 0, ownerUserId: 0 };
  let cupra = 0;
  const as = (c: Compte, userId = c.ownerUserId) => { session.userId = userId; session.currentAccountId = c.id; };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MIDI_PARIS); });
  afterEach(() => { vi.useRealTimers(); });

  /** Échéance d'action saisie par le vrai service de l'Agenda. */
  const saisir = async (c: Compte, p: Record<string, unknown>) => {
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    return (await createAgendaItem({ homeCategory: 'action', ...p } as never, c.id, c.ownerUserId)).id;
  };
  const accueil = async (c: Compte) => (await (await import('@/services/home/HomeSummaryService')).buildHomeSummary(c.id)).blocks.upcoming;
  /** Rendu du bloc « Prochaines échéances » : le MÊME composant pour le web et pour l'application mobile. */
  const rendu = async (bloc: Awaited<ReturnType<typeof accueil>>) => {
    const { UpcomingEvents } = await import('@/components/home/HomeBlocks');
    return renderToStaticMarkup(h(UpcomingEvents, { items: bloc.items, toPlan: bloc.toPlan }));
  };
  const dateEnBase = async (id: number) => (await sql<Array<{ d: string | null }>>`
    SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE id = ${id}`)[0]?.d ?? null;

  it('prépare deux comptes et le bien de la capture', async () => {
    moi = await make.account({ plan: 'premium' });
    autre = await make.account({ plan: 'premium' });
    cupra = (await make.asset(moi, { category: 'VEHICULE', name: 'CUPRA LEON E-HYBRID180' })).id;
  });

  it('L115C-E01 — l’anomalie de la carte : « Prochain contrôle technique » au 18/04/2028 se lit « Dans 1 an et 5 mois », avec 2028 à l’écran ; la date en base est intacte', async () => {
    as(moi);
    const id = await saisir(moi, { title: 'Prochain contrôle technique', startDate: '2028-04-18', assetIds: [cupra] });
    const bloc = await accueil(moi);
    const ligne = bloc.items.find((i) => i.id === id)!;
    expect(ligne).toMatchObject({
      date: '2028-04-18', day: '18', month: 'avr.',
      rel: 'Dans 1 an et 5 mois',
      dateWithYear: '18 avr. 2028', dateFull: '18 avril 2028',
    });
    // Jamais les deux libellés faux de l'ancienne règle.
    expect(JSON.stringify(bloc)).not.toMatch(/"Dans 1 an"|Dans 2 ans/);
    // Aucune date métier touchée (point 5 de la carte : rien n'est « corrigé » en base).
    expect(await dateEnBase(id)).toBe('2028-04-18');

    // Interface : l'année est écrite à côté de la pastille, le bouton annonce la date complète.
    const html = await rendu(bloc);
    expect(html).toContain('CUPRA LEON E-HYBRID180 · 18 avr. 2028');
    expect(html).toContain('aria-label="Prochain contrôle technique — CUPRA LEON E-HYBRID180 — 18 avril 2028 — Dans 1 an et 5 mois"');
    expect(html).toContain('>Dans 1 an et 5 mois<');
    // Le délai long n'est plus forcé sur une seule ligne, et sa largeur est bornée (petit écran).
    expect(html).toMatch(/max-w-\[6\.5rem\][^"]*md:max-w-\[9\.5rem\]/);
    expect(html).not.toContain('whitespace-nowrap text-[12px] font-bold');
  });

  it('L115C-E02 — deux jours d’écart ne changent plus le terme : 20/04/2028 se lit aussi « Dans 1 an et 5 mois »', async () => {
    as(moi);
    const id = await saisir(moi, { title: 'Contrôle technique voisin', startDate: '2028-04-20' });
    const bloc = await accueil(moi);
    expect(bloc.items.find((i) => i.id === id)).toMatchObject({ rel: 'Dans 1 an et 5 mois', dateWithYear: '20 avr. 2028' });
  });

  it('L115C-E03 — l’ordre chronologique, le plafond et les tonalités sont inchangés ; chaque ligne porte son propre délai', async () => {
    as(moi);
    const demain = await saisir(moi, { title: 'Demain', startDate: '2026-11-13' });
    const bissextile = await saisir(moi, { title: 'Bissextile', startDate: '2028-02-29' });
    const deuxAns = await saisir(moi, { title: 'Presque deux ans', startDate: '2028-11-10' });
    // Règle existante NON modifiée : l'accueil ne regarde que 730 jours en
    // avant. Une échéance au-delà n'y figure pas (et n'y figurait pas avant).
    const horsHorizon = await saisir(moi, { title: 'Au-delà de l’horizon', startDate: '2029-06-01' });
    const bloc = await accueil(moi);
    expect(bloc.items.map((i) => i.id)).not.toContain(horsHorizon);
    const par = (id: number) => bloc.items.find((i) => i.id === id);
    // Ordre croissant : les deux échéances de 2028-04 (E01, E02) sont entre la bissextile et les deux ans.
    const dates = bloc.items.map((i) => i.date);
    expect([...dates].sort()).toEqual(dates);
    expect(bloc.items).toHaveLength(5); // MAX_UPCOMING
    expect(par(demain)).toMatchObject({ rel: 'Demain', tone: 'amber', dateWithYear: null });
    expect(par(bissextile)).toMatchObject({ rel: 'Dans 1 an et 4 mois', tone: 'green', dateWithYear: '29 févr. 2028', dateFull: '29 février 2028' });
    // 1 an, 11 mois et 29 jours : les jours arrondissent le 12e mois, donc « Dans 2 ans » — jamais « Dans 3 ans ».
    expect(par(deuxAns)).toMatchObject({ rel: 'Dans 2 ans', dateWithYear: '10 nov. 2028' });
    // Mobile : 2 lignes visibles, 3 sur desktop — inchangé.
    const html = await rendu(bloc);
    expect((html.match(/class="hidden md:block"/g) ?? [])).toHaveLength(1);
  });

  it('L115C-E04 — jour civil de Paris : à 00 h 30, une échéance du jour se lit « Aujourd’hui » (le jour UTC disait « Demain »)', async () => {
    as(moi);
    const id = await saisir(moi, { title: 'Ramonage', startDate: '2026-11-13' });

    // Veille, 23 h 30 à Paris : l'échéance du 13 est bien « Demain ».
    vi.setSystemTime(new Date('2026-11-12T23:30:00+01:00'));
    expect((await accueil(moi)).items.find((i) => i.id === id)).toMatchObject({ rel: 'Demain' });

    // Une heure plus tard, 00 h 30 à Paris : le jour UTC est encore le 12, le jour civil est le 13.
    const minuitPasse = new Date('2026-11-13T00:30:00+01:00');
    expect(minuitPasse.toISOString().slice(0, 10)).toBe('2026-11-12');
    vi.setSystemTime(minuitPasse);
    expect((await accueil(moi)).items.find((i) => i.id === id)).toMatchObject({ rel: 'Aujourd’hui' });

    // Et le lendemain à 00 h 30, elle a disparu de l'accueil (date passée, lot 113P) — plus de résurgence d'un jour.
    vi.setSystemTime(new Date('2026-11-14T00:30:00+01:00'));
    expect((await accueil(moi)).items.map((i) => i.id)).not.toContain(id);
    expect(await dateEnBase(id)).toBe('2026-11-13');
  });

  it('L115C-E05 — heure d’été : à 01 h 30 le 15/07, le jour civil de Paris est déjà le 15 (UTC dit le 14)', async () => {
    as(moi);
    const id = await saisir(moi, { title: 'Entretien de la climatisation', startDate: '2027-07-15' });
    const nuitEte = new Date('2027-07-15T01:30:00+02:00');
    expect(nuitEte.toISOString().slice(0, 10)).toBe('2027-07-14');
    vi.setSystemTime(nuitEte);
    // Même année civile que la référence : la pastille suffit, aucune année n'est écrite en plus.
    expect((await accueil(moi)).items.find((i) => i.id === id)).toMatchObject({ rel: 'Aujourd’hui', dateWithYear: null, dateFull: '15 juillet 2027' });
  });

  it('L115C-E06 — une échéance sans date reste dans « À prévoir » (#742) : aucune date, aucun délai, aucune année ; une échéance passée reste exclue', async () => {
    as(moi);
    const sansDate = await saisir(moi, { title: 'Entretien pompe à chaleur', assetIds: [cupra] });
    const passee = await saisir(moi, { title: 'Révision de l’an dernier', startDate: '2026-03-02' });
    const bloc = await accueil(moi);
    expect(bloc.toPlan.items.map((i) => i.id)).toContain(sansDate);
    expect(bloc.items.map((i) => i.id)).not.toContain(sansDate);
    expect(bloc.items.map((i) => i.id)).not.toContain(passee);
    // La ligne « À prévoir » ne porte ni date, ni délai, ni année (règle de la carte #742, intacte).
    const aPrevoir = bloc.toPlan.items.find((i) => i.id === sansDate)!;
    expect(Object.keys(aPrevoir).sort()).toEqual(['assetName', 'id', 'title']);
    const html = await rendu(bloc);
    const groupe = html.slice(html.indexOf('data-home-group="a-prevoir"'));
    expect(groupe).toContain('À prévoir');
    expect(groupe).not.toMatch(/Dans \d|Aujourd’hui|Demain|20\d\d/);
  });

  it('L115C-E07 — isolation des comptes : l’échéance d’un autre compte n’est ni comptée ni datée sur mon accueil', async () => {
    const sien = await saisir(autre, { title: 'Contrôle technique du voisin', startDate: '2028-04-18' });
    as(moi);
    const mien = await accueil(moi);
    expect(mien.items.map((i) => i.id)).not.toContain(sien);
    expect(JSON.stringify(mien)).not.toMatch(/voisin/);
    as(autre);
    const leSien = await accueil(autre);
    expect(leSien.items.find((i) => i.id === sien)).toMatchObject({ rel: 'Dans 1 an et 5 mois', dateWithYear: '18 avr. 2028' });
    expect(JSON.stringify(leSien)).not.toMatch(/CUPRA/);
  });

  it('L115C-E08 — aucun mot « Opération » et aucune couleur brute sur le bloc rendu', async () => {
    as(moi);
    const html = await rendu(await accueil(moi));
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(html).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
  });
});
