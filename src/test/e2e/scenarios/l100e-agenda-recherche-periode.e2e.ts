/**
 * Lot 100E — décision PO A8 « Recherche Agenda et filtre « À venir » », sur
 * PostgreSQL 16 réel : parcours de « Mon agenda » rejoué avec la MÊME logique
 * d'URL que l'écran (`agendaSearchParams`, `searchWithLocalQuery` du lot 97C)
 * et la MÊME route (`GET /api/agenda`) — desktop et mobile partagent l'écran.
 *
 *  L100E-E2E-A8-01  « À venir » actif → recherche : « Tous » visible, passés + futurs + sans date trouvés (aucune restriction cachée)
 *  L100E-E2E-A8-02  période choisie EXPLICITEMENT pendant la recherche : conservée (modification, effacement)
 *  L100E-E2E-A8-03  effacement sans choix : retour à « À venir » ; onglet Agenda d'un bien : même règle
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
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

const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

scenario('L100E-AGENDA-A8', 'Agenda : une recherche sans critère temporel couvre toutes les dates, « Tous » visible (lot 100E, A8)', ({ make }) => {
  const filtres = async () => import('@/lib/agenda/agenda-filters');
  /** Écran « Mon agenda » : URL → requête envoyée par la page → éléments affichés + ligne d'état. */
  const ecran = async (url: string) => {
    const { parseAgendaPeriod, parseSuspended, SUSPENDED_PERIOD_PARAM, searchPeriodNotice } = await filtres();
    const p = new URLSearchParams(url.replace(/^\?/, ''));
    const q = p.get('q') ?? '';
    const period = parseAgendaPeriod(p.get('period'));
    const params = new URLSearchParams({ period, includeCancelled: 'false' });
    if (q) params.set('q', q);
    const { GET } = await import('@/app/api/agenda/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda?${params}`));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { items: Array<{ id: number }> }).items.map((i) => i.id).sort((a, b) => a - b);
    return { ids, period, notice: searchPeriodNotice(q, { period, suspended: parseSuspended(p.get(SUSPENDED_PERIOD_PARAM)) }) };
  };
  const rechercher = async (url: string, q: string) => {
    const { agendaSearchParams } = await filtres();
    const { searchWithLocalQuery } = await import('@/lib/search/local-search');
    return agendaSearchParams(url, q, (s, v) => searchWithLocalQuery(s, v, { switchToList: true }));
  };
  const choisir = (url: string, period: string) => {
    const p = new URLSearchParams(url.replace(/^\?/, ''));
    if (period === 'all') p.delete('period'); else p.set('period', period);
    p.delete('periodeAvantRecherche');
    return `?${p}`;
  };

  it('L100E-E2E-A8-01..03 — recherche globale, filtre explicite conservé, effacement cohérent', async () => {
    const compte = await make.account();
    session.userId = compte.ownerUserId; session.currentAccountId = compte.id;
    const passe = (await make.agendaItem(compte, { title: 'Entretien chaudière 2025', startDate: jour(-200) })).id;
    const futur = (await make.agendaItem(compte, { title: 'Entretien chaudière 2027', startDate: jour(200) })).id;
    const sansDate = (await make.agendaItem(compte, { title: 'Entretien chaudière à planifier' })).id;
    const autre = (await make.agendaItem(compte, { title: 'Vidange voiture', startDate: jour(30) })).id;
    const tri = (v: number[]) => [...v].sort((a, b) => a - b);

    // L'utilisateur consulte « À venir » (futurs + sans date, comme avant).
    let url = '?period=upcoming';
    expect((await ecran(url)).ids).toEqual(tri([futur, sansDate, autre]));

    // A8-01 — il cherche « chaudière » : « Tous » visible, PASSÉ compris (aucune restriction cachée).
    url = await rechercher(url, 'chaudière');
    let e = await ecran(url);
    expect(e.period).toBe('all');
    expect(e.ids).toEqual(tri([passe, futur, sansDate]));
    expect(e.notice?.text).toContain('période « Tous »');
    expect(e.notice?.text).toContain('« À venir » est suspendu');
    expect(new URLSearchParams(url.slice(1)).get('view')).toBe('list');

    // A8-02 — il choisit EXPLICITEMENT « Passés » : appliqué et conservé pendant la recherche.
    url = choisir(url, 'past');
    // Les éléments sans date restent listés avec toute période (comportement existant de l'agenda).
    expect((await ecran(url)).ids).toEqual(tri([passe, sansDate]));
    url = await rechercher(url, 'chaudière 2025');
    e = await ecran(url);
    expect(e.period).toBe('past');
    expect(e.ids).toEqual([passe]);
    expect(e.notice?.text).toBe('Recherche limitée à la période « Passés », choisie dans les filtres.');
    // Effacement après un choix explicite : le dernier choix de l'utilisateur fait foi (pas de remise à zéro silencieuse).
    url = await rechercher(url, '');
    e = await ecran(url);
    expect(e.period).toBe('past');
    expect(e.notice).toBeNull();

    // A8-03 — sans choix pendant la recherche : l'effacement rétablit « À venir ».
    url = choisir('?', 'upcoming');
    url = await rechercher(url, 'chaudière');
    expect((await ecran(url)).ids).toEqual(tri([passe, futur, sansDate]));
    url = await rechercher(url, '');
    e = await ecran(url);
    expect(e.period).toBe('upcoming');
    expect(e.ids).toEqual(tri([futur, sansDate, autre]));

    // Onglet Agenda d'un bien (état local) : même règle.
    const { periodOnSearchChange, periodOnExplicitChoice } = await filtres();
    let s = periodOnSearchChange(periodOnExplicitChoice('upcoming'), '', 'chaudière');
    expect(s).toEqual({ period: 'all', suspended: 'upcoming' });
    s = periodOnSearchChange(s, 'chaudière', '');
    expect(s).toEqual({ period: 'upcoming', suspended: null });
  });
});
