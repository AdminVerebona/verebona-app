/**
 * Lot 100E — décision PO A8 « Recherche Agenda et filtre « À venir » » :
 * toute recherche sans critère temporel couvre le passé, le futur et les
 * éléments sans date ; « Tous » affiché visiblement ; période choisie
 * explicitement conservée ; effacement : retour à l'état précédent.
 *
 *  L100E-U-A8-01  transitions (lancement, modification, effacement, choix explicite)
 *  L100E-U-A8-02  URL de « Mon agenda » (vue Liste du lot 97C, période, période suspendue)
 *  L100E-U-A8-03  ligne d'état (jamais une restriction cachée) et rendu desktop / mobile
 *  L100E-U-A8-04  écrans branchés (« Mon agenda », onglet Agenda d'un bien), aucun « Opération »
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AGENDA_PERIOD_OPTIONS, SUSPENDED_PERIOD_PARAM, agendaSearchParams, parseSuspended, periodOnExplicitChoice, periodOnSearchChange, searchPeriodNotice,
} from '../agenda-filters';
import { searchWithLocalQuery } from '@/lib/search/local-search';
import { AgendaSearchPeriodNotice } from '@/components/agenda/AgendaSearchPeriodNotice';

// Composants compilés en JSX classique dans les tests (même convention que L71C).
(globalThis as { React?: typeof React }).React = React;

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const url = (search: string, q: string) => agendaSearchParams(search, q, (s, v) => searchWithLocalQuery(s, v, { switchToList: true }));

describe('L100E-U-A8 — recherche et période de l’agenda', () => {
  it('L100E-U-A8-01 — lancement : « À venir » neutralisé (→ « Tous ») et mémorisé ; modification : inchangé ; effacement : retour', () => {
    const lance = periodOnSearchChange({ period: 'upcoming', suspended: null }, '', 'chaudière');
    expect(lance).toEqual({ period: 'all', suspended: 'upcoming' });
    expect(periodOnSearchChange(lance, 'chaudière', 'chaudière gaz')).toEqual(lance);
    expect(periodOnSearchChange(lance, 'chaudière gaz', '')).toEqual({ period: 'upcoming', suspended: null });
    // Période déjà « Tous » : rien à suspendre.
    expect(periodOnSearchChange({ period: 'all', suspended: null }, '', 'x')).toEqual({ period: 'all', suspended: null });
    // Choix EXPLICITE pendant la recherche : conservé pendant la recherche ET après l'effacement (dernier choix de l'utilisateur).
    const choisi = periodOnExplicitChoice('past');
    expect(choisi).toEqual({ period: 'past', suspended: null });
    expect(periodOnSearchChange(choisi, 'chaudière', 'chaudière 2')).toEqual(choisi);
    expect(periodOnSearchChange(choisi, 'chaudière', '')).toEqual({ period: 'past', suspended: null });
    // « Tous » choisi explicitement pendant la recherche : l'ancienne période suspendue est oubliée.
    expect(periodOnSearchChange(periodOnExplicitChoice('all'), 'x', '')).toEqual({ period: 'all', suspended: null });
  });

  it('L100E-U-A8-02 — URL : vue Liste (97C), « Tous » = paramètre retiré, période suspendue mémorisée puis rétablie ; autres filtres intacts', () => {
    const p1 = new URLSearchParams(url('?period=upcoming&view=calendar&assetIds=3', 'chaudière').slice(1));
    expect(p1.get('q')).toBe('chaudière');
    expect(p1.get('view')).toBe('list');
    expect(p1.get('period')).toBeNull();
    expect(p1.get(SUSPENDED_PERIOD_PARAM)).toBe('upcoming');
    expect(p1.get('assetIds')).toBe('3');
    const p2 = new URLSearchParams(url(`?${p1}`, '').slice(1));
    expect(p2.get('q')).toBeNull();
    expect(p2.get('period')).toBe('upcoming');
    expect(p2.get(SUSPENDED_PERIOD_PARAM)).toBeNull();
    expect(p2.get('assetIds')).toBe('3');
    // Période explicite pendant la recherche (« Passés ») : conservée à la modification et à l'effacement.
    const p3 = new URLSearchParams(url('?q=chaudi%C3%A8re&period=past&view=list', 'chaudière gaz').slice(1));
    expect(p3.get('period')).toBe('past');
    expect(new URLSearchParams(url(`?${p3}`, '').slice(1)).get('period')).toBe('past');
    expect(parseSuspended('all')).toBeNull();
    expect(parseSuspended('n_importe')).toBeNull();
    expect(parseSuspended('upcoming')).toBe('upcoming');
  });

  it('L100E-U-A8-03 — ligne d’état : ce qui est réellement cherché, avec la commande pour changer', () => {
    expect(AGENDA_PERIOD_OPTIONS[0]).toEqual({ value: 'all', label: 'Tous' });
    expect(searchPeriodNotice('', { period: 'upcoming', suspended: null })).toBeNull();
    const n = searchPeriodNotice('chaudière', { period: 'all', suspended: 'upcoming' })!;
    expect(n.text).toContain('toutes les dates (passées, à venir et sans date)');
    expect(n.text).toContain('période « Tous »');
    expect(n.text).toContain('« À venir » est suspendu');
    expect(n.action).toEqual({ label: 'Limiter à « À venir »', period: 'upcoming' });
    expect(searchPeriodNotice('chaudière', { period: 'all', suspended: null })).toMatchObject({ action: null });
    const e = searchPeriodNotice('chaudière', { period: 'upcoming', suspended: null })!;
    expect(e.text).toBe('Recherche limitée à la période « À venir », choisie dans les filtres.');
    expect(e.action).toEqual({ label: 'Chercher sur toutes les dates', period: 'all' });
    const html = renderToStaticMarkup(h(AgendaSearchPeriodNotice, { q: 'chaudière', state: { period: 'all', suspended: 'upcoming' }, onChoose: () => {} }));
    expect(html).toContain('data-testid="recherche-agenda-periode-active"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Limiter à « À venir »');
    // Mobile : cible tactile de 44 px ; jetons de la charte.
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('var(--accent)');
    expect(renderToStaticMarkup(h(AgendaSearchPeriodNotice, { q: '', state: { period: 'all', suspended: null }, onChoose: () => {} }))).toBe('');
  });

  it('L100E-U-A8-04 — « Mon agenda » et l’onglet Agenda d’un bien branchés ; jamais le mot « Opération »', () => {
    const page = lire('src/app/(dashboard)/agenda/page.tsx');
    expect(page).toContain('agendaSearchParams(search, next');
    expect(page).toContain('<AgendaSearchPeriodNotice q={q} state={{ period, suspended: periodeSuspendue }} onChoose={choisirPeriode} />');
    expect(page).toContain('onSelect={(v) => choisirPeriode(parseAgendaPeriod(v))}');
    const onglet = lire('src/components/assets/AssetAgendaTab.tsx');
    expect(onglet).toContain('periodOnSearchChange({ period, suspended: periodeSuspendue }, q, next)');
    expect(onglet).toContain('onPeriod={choisirPeriode}');
    expect(onglet).toContain('<AgendaSearchPeriodNotice');
    for (const src of [lire('src/components/agenda/AgendaSearchPeriodNotice.tsx'), lire('src/lib/agenda/agenda-filters.ts')]) {
      expect(src).not.toMatch(/[«"'`][^»"'`]*Op[ée]ration/);
    }
  });
});
