/**
 * Lot 103F — « Mes documents » : sections de filtres repliables, filtres
 * « Date du document » / « Date d'ajout », tri, synthèse des filtres actifs.
 *
 * Règles de période (bornes inclusives, bissextiles, frontières de mois et
 * d'année, fuseau de Paris), dates partielles, contrat de la route, état des
 * sections (mobile / large, mémoire de session), rendu accessible des
 * composants partagés. Le SQL réel est vérifié par le scénario e2e
 * `l103f-filtres-documents.e2e.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

(globalThis as { React?: typeof React }).React = React;
vi.mock('@/db', () => ({ db: {}, pgClient: vi.fn() }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: 1, currentAccountId: 10 })),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
const svc = vi.hoisted(() => ({ getDocumentFeed: vi.fn() }));
vi.mock('@/services/documents/rubric-query.service', async (orig) => ({
  ...(await orig<typeof import('@/services/documents/rubric-query.service')>()),
  getDocumentFeed: (...a: unknown[]) => svc.getDocumentFeed(...a),
}));

const D = await import('@/lib/filters/date-filter');
const { buildFeedQuery, parseFeedParams } = await import('@/lib/documents/document-feed');
const { buildFeedMeta, matchesFilters } = await import('@/services/documents/rubric-query.service');
const V = await import('@/components/documents/v2/documents-view');
const { parseSnapshot, saveListSnapshot, snapshotStorageKey } = await import('@/components/documents/v2/list-restore');
const S = await import('@/components/documents/v2/filter-sections');
const { ActiveFilterChips, FilterPillSection } = await import('@/components/filters/FilterControls');
const { DocumentsFilterPanel, describeDocumentCount } = await import('@/components/documents/v2/DocumentsFilterPanel');
const { DateFilterSection } = await import('@/components/filters/DateFilterSection');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const noop = () => {};

// ── Règles de période ──────────────────────────────────────────────────────

describe('103F — périodes calendaires explicites', () => {
  it('Ce mois / Cette année / Année précédente : bornes calendaires inclusives', () => {
    expect(D.presetRange('thisMonth', '2026-11-02')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(D.presetRange('thisMonth', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(D.presetRange('thisYear', '2026-11-02')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(D.presetRange('lastYear', '2026-01-01')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('février : 29 jours les années bissextiles seulement (400 / 100 / 4)', () => {
    expect(D.presetRange('thisMonth', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(D.presetRange('thisMonth', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(D.isLeapYear(2000)).toBe(true);
    expect(D.isLeapYear(2100)).toBe(false);
    expect(D.isValidDay('2028-02-29')).toBe(true);
    expect(D.isValidDay('2026-02-29')).toBe(false);
    expect(D.isValidDay('2026-04-31')).toBe(false);
    expect(D.isValidDay('2026-13-01')).toBe(false);
    expect(D.isValidDay('26-01-01')).toBe(false);
  });

  it('12 derniers mois : période GLISSANTE de douze mois exactement, distincte de « Cette année »', () => {
    expect(D.presetRange('last12Months', '2026-11-02')).toEqual({ from: '2025-11-03', to: '2026-11-02' });
    expect(D.presetRange('last12Months', '2026-12-31')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(D.presetRange('last12Months', '2026-01-01')).toEqual({ from: '2025-01-02', to: '2026-01-01' });
    // 29/02 : un an plus tôt n'existe pas → 28/02, puis le lendemain.
    expect(D.presetRange('last12Months', '2028-02-29')).toEqual({ from: '2027-03-01', to: '2028-02-29' });
    expect(D.presetRange('last12Months', '2029-02-28')).toEqual({ from: '2028-02-29', to: '2029-02-28' });
    expect(D.presetRange('last12Months', '2026-11-02')).not.toEqual(D.presetRange('thisYear', '2026-11-02'));
  });

  it('jour suivant : fins de mois, d’année et 29 février', () => {
    expect(D.nextDay('2026-01-31')).toBe('2026-02-01');
    expect(D.nextDay('2026-12-31')).toBe('2027-01-01');
    expect(D.nextDay('2028-02-28')).toBe('2028-02-29');
    expect(D.nextDay('2026-02-28')).toBe('2026-03-01');
  });

  it('« aujourd’hui » se lit à Paris, jamais en UTC (frontières de jour et d’année)', () => {
    // 31/12/2026 23:30 UTC = 01/01/2027 00:30 à Paris (hiver, UTC+1).
    expect(D.todayIn(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    // 30/06 22:30 UTC = 01/07 00:30 à Paris (été, UTC+2).
    expect(D.todayIn(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01');
    expect(D.todayIn(new Date('2026-06-30T21:30:00Z'))).toBe('2026-06-30');
    expect(D.DATE_FILTER_TIME_ZONE).toBe('Europe/Paris');
  });

  it('période personnalisée : une seule borne possible, bornes égales admises, début > fin refusé', () => {
    expect(D.makeDateFilter('custom', '2026-11-02', { from: '2024-03-01' })).toEqual({ preset: 'custom', from: '2024-03-01' });
    expect(D.makeDateFilter('custom', '2026-11-02', { to: '2024-03-31' })).toEqual({ preset: 'custom', to: '2024-03-31' });
    expect(D.makeDateFilter('custom', '2026-11-02', { from: '2024-03-01', to: '2024-03-01' })).toEqual({ preset: 'custom', from: '2024-03-01', to: '2024-03-01' });
    expect(D.makeDateFilter('custom', '2026-11-02', { from: '2024-03-02', to: '2024-03-01' })).toBeNull();
    expect(D.makeDateFilter('custom', '2026-11-02', {})).toBeNull();
    expect(D.validateDateRange('2024-03-02', '2024-03-01')).toBe('START_AFTER_END');
    expect(D.validateDateRange('2024-02-30', null)).toBe('INVALID_DAY');
    expect(D.validateDateRange(null, null)).toBeNull();
    expect(D.makeDateFilter('none', '2026-11-02')).toEqual({ preset: 'none' });
    expect(D.makeDateFilter('thisYear', '2026-11-02')).toEqual({ preset: 'thisYear', from: '2026-01-01', to: '2026-12-31' });
  });

  it('résumés et format français', () => {
    expect(D.formatDayFr('2024-01-05')).toBe('05/01/2024');
    expect(D.dateFilterSummary({ preset: 'thisYear', from: '2024-01-01', to: '2024-12-31' })).toBe('01/01/2024 – 31/12/2024');
    expect(D.dateFilterSummary({ preset: 'custom', from: '2026-03-01' })).toBe('Depuis le 01/03/2026');
    expect(D.dateFilterSummary({ preset: 'custom', to: '2025-12-31' })).toBe("Jusqu'au 31/12/2025");
    expect(D.dateFilterSummary({ preset: 'custom', from: '2026-03-01', to: '2026-03-01' })).toBe('Le 01/03/2026');
    expect(D.dateFilterSummary({ preset: 'none' })).toBe('Sans date');
    expect(D.dateFilterChipLabel('addedDate', { preset: 'custom', from: '2026-01-01' })).toBe("Date d'ajout : Depuis le 01/01/2026");
  });
});

describe('103F — dates partielles : aucun jour inventé, règle du chevauchement', () => {
  it('intervalle connu : jour, mois, année', () => {
    expect(D.partialDateInterval('2024-03-15')).toEqual({ from: '2024-03-15', to: '2024-03-15', granularity: 'day' });
    expect(D.partialDateInterval('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29', granularity: 'month' });
    expect(D.partialDateInterval('2023-02')).toEqual({ from: '2023-02-01', to: '2023-02-28', granularity: 'month' });
    expect(D.partialDateInterval('2022')).toEqual({ from: '2022-01-01', to: '2022-12-31', granularity: 'year' });
    expect(D.partialDateInterval('2024-13')).toBeNull();
    expect(D.partialDateInterval('mars 2024')).toBeNull();
  });

  it('une valeur partielle correspond à une période qui chevauche son intervalle', () => {
    const mars = { preset: 'custom' as const, from: '2024-03-15', to: '2024-03-20' };
    expect(D.partialDateMatchesRange('2024-03', mars)).toBe(true);
    expect(D.partialDateMatchesRange('2024-04', mars)).toBe(false);
    expect(D.partialDateMatchesRange('2024', { preset: 'custom', from: '2024-12-31' })).toBe(true);
    expect(D.partialDateMatchesRange('2024', { preset: 'custom', from: '2025-01-01' })).toBe(false);
    // Jour : bornes incluses.
    expect(D.partialDateMatchesRange('2024-03-20', mars)).toBe(true);
    expect(D.partialDateMatchesRange('2024-03-21', mars)).toBe(false);
  });

  it('« Sans date » : absente ou illisible ; sans filtre, tout passe', () => {
    expect(D.partialDateMatchesRange(null, { preset: 'none' })).toBe(true);
    expect(D.partialDateMatchesRange('2024-03-01', { preset: 'none' })).toBe(false);
    expect(D.partialDateMatchesRange(null, { preset: 'custom', from: '2024-01-01' })).toBe(false);
    expect(D.partialDateMatchesRange(null, undefined)).toBe(true);
  });

  it('le contrat T1 n’accepte que des jours complets : une date partielle est écartée, jamais complétée', async () => {
    const { normalizeDateValue } = await import('@/services/canonical/registry/normalize');
    expect(normalizeDateValue('2024-03')).toBeNull();
    expect(normalizeDateValue('2024')).toBeNull();
    expect(normalizeDateValue('15/03/2024')).toBe('2024-03-15');
    expect(lire('src/services/ai/source-analysis/master/t1-contract.ts')).toMatch(/const isoDate = z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\)/);
  });
});

// ── Contrat de la route ────────────────────────────────────────────────────

describe('103F — contrat GET /api/v2/documents', () => {
  const base = { assetIds: [], sort: 'added' as const, direction: 'desc' as const, grouped: false, ids: null };

  it('les bornes résolues font partie de la clé ; aller-retour sans perte', () => {
    const filters = {
      biens: ['4'], rubrics: [], types: [],
      documentDate: { preset: 'lastYear' as const, from: '2025-01-01', to: '2025-12-31' },
      addedDate: { preset: 'custom' as const, from: '2026-03-01' },
    };
    const q = buildFeedQuery({ ...base, filters });
    expect(q).toContain('docFrom=2025-01-01');
    expect(q).toContain('docTo=2025-12-31');
    expect(q).toContain('addedFrom=2026-03-01');
    expect(q).not.toContain('addedTo');
    const back = parseFeedParams(new URLSearchParams(q));
    expect(back.filters.documentDate).toEqual({ preset: 'custom', from: '2025-01-01', to: '2025-12-31' });
    expect(back.filters.addedDate).toEqual({ preset: 'custom', from: '2026-03-01' });
    expect(back.dateRangeError).toBeUndefined();
    // Même filtre, raccourci différent : même requête serveur.
    expect(buildFeedQuery({ ...base, filters: { ...filters, documentDate: { preset: 'custom', from: '2025-01-01', to: '2025-12-31' } } })).toBe(q);
  });

  it('« Sans date » ; aucune période par défaut', () => {
    const q = buildFeedQuery({ ...base, filters: { biens: [], rubrics: [], types: [], documentDate: { preset: 'none' } } });
    expect(q).toContain('docNone=1');
    expect(parseFeedParams(new URLSearchParams(q)).filters.documentDate).toEqual({ preset: 'none' });
    const sans = buildFeedQuery({ ...base, filters: V.EMPTY_FILTERS });
    expect(sans).not.toMatch(/doc(From|To|None)|added(From|To)/);
    expect(parseFeedParams(new URLSearchParams(sans)).filters).toEqual({ biens: [], rubrics: [], types: [] });
  });

  it('période invalide : 400 INVALID_DATE_RANGE, jamais élargie en silence', async () => {
    expect(parseFeedParams(new URLSearchParams('docFrom=2025-02-01&docTo=2025-01-01')).dateRangeError).toBe('START_AFTER_END');
    expect(parseFeedParams(new URLSearchParams('addedFrom=2025-02-30')).dateRangeError).toBe('INVALID_DAY');
    const { GET } = await import('@/app/api/v2/documents/route');
    svc.getDocumentFeed.mockReset();
    const r = await GET(new NextRequest('http://x/api/v2/documents?docFrom=2025-02-01&docTo=2025-01-01'));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'INVALID_DATE_RANGE', code: 'START_AFTER_END' });
    expect(svc.getDocumentFeed).not.toHaveBeenCalled();
  });

  it('période valide transmise au service ; journal sans bornes', async () => {
    const { GET } = await import('@/app/api/v2/documents/route');
    svc.getDocumentFeed.mockReset().mockResolvedValue({ documents: [], nextCursor: null, hasMore: false, limit: 50 });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = await GET(new NextRequest('http://x/api/v2/documents?docFrom=2022-01-01&docTo=2022-12-31&addedFrom=2026-01-01&addedTo=2026-12-31'));
    expect(r.status).toBe(200);
    const arg = svc.getDocumentFeed.mock.calls[0][0] as { filters: Record<string, unknown>; accountId: number };
    expect(arg.accountId).toBe(10);
    expect(arg.filters.documentDate).toEqual({ preset: 'custom', from: '2022-01-01', to: '2022-12-31' });
    expect(arg.filters.addedDate).toEqual({ preset: 'custom', from: '2026-01-01', to: '2026-12-31' });
    const log = info.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(log).toMatch(/"dated":true/);
    expect(log).not.toMatch(/2022-01-01|2026-12-31/);
    info.mockRestore();
  });

  it('compteurs : le total filtré tient compte des dates, les options de pastilles non (sémantique inchangée)', () => {
    const context = { families: [], hasRentedAsset: false };
    const rows = [
      { assetId: 1, assetName: 'Maison', rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'INVOICE', count: 3, dateMatch: true },
      { assetId: 1, assetName: 'Maison', rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'INVOICE', count: 5, dateMatch: false },
    ];
    const meta = buildFeedMeta(rows, { biens: [], rubrics: [], types: [], documentDate: { preset: 'custom', from: '2022-01-01' } }, context);
    expect(meta.total).toBe(3);
    expect(meta.scopeTotal).toBe(8);
    expect(meta.facets.biens.find((b) => b.value === '1')?.count).toBe(8);
    expect(meta.rubrics.find((r) => r.code === 'MAINTENANCE_WORKS')?.count).toBe(3);
    expect(matchesFilters(rows[1], { biens: ['1'], rubrics: [], types: [] })).toBe(false);
    expect(matchesFilters({ ...rows[1], dateMatch: undefined }, { biens: ['1'], rubrics: [], types: [] })).toBe(true);
  });

  it('SQL : date du document sur `document_date` (bornes incluses), date d’ajout sur `uploaded_at` en jours de Paris', () => {
    const code = lire('src/services/documents/rubric-query.service.ts');
    expect(code).toMatch(/\$\{assetFiles\.documentDate\} >= \$\{f\.from\}::date/);
    expect(code).toMatch(/\$\{assetFiles\.documentDate\} <= \$\{f\.to\}::date/);
    expect(code).toMatch(/\$\{assetFiles\.documentDate\} IS NULL/);
    expect(code).toMatch(/\$\{assetFiles\.uploadedAt\} >= \(\(\$\{f\.from\}::date\)::timestamp AT TIME ZONE \$\{tz\}\)/);
    expect(code).toMatch(/\$\{assetFiles\.uploadedAt\} < \(\(\$\{nextDay\(f\.to\)\}::date\)::timestamp AT TIME ZONE \$\{tz\}\)/);
    // Filtrage AVANT tri et découpage en lots.
    expect(code.indexOf('if (dateCondition) where.push(dateCondition)')).toBeLessThan(code.indexOf('.orderBy(...components'));
    expect(code).not.toMatch(/last_analysis_at|updated_at.*dateCondition/);
  });

  it('tri : dates absentes en dernier dans les deux sens, critère secondaire déterministe ; tri par défaut inchangé', async () => {
    const { keyComponents } = await import('@/services/documents/document-cursor');
    expect(keyComponents('docDate', 'asc', false)).toEqual([
      { key: 'documentDate', dir: 'asc', nullable: true },
      { key: 'uploadedAt', dir: 'desc', nullable: false },
      { key: 'id', dir: 'desc', nullable: false },
    ]);
    expect(keyComponents('added', 'asc', false).map((c) => c.key)).toEqual(['uploadedAt', 'id']);
    expect(lire('src/services/documents/rubric-query.service.ts')).toMatch(/NULLS LAST`\)\)/);
    const { DEFAULT_PREFS } = await import('@/components/documents/v2/view-prefs');
    expect(DEFAULT_PREFS).toMatchObject({ sort: 'added', dir: 'desc' });
    expect(V.sortOptionsFor(false, 'mes-documents').map((o) => o.label)).toEqual(["Date d'ajout", 'Date du document', 'Nom', 'Bien', 'Rubrique']);
  });

  it('index de la migration 0955 : additifs, CONCURRENTLY, optionnels', () => {
    for (const n of [1, 2]) {
      const sql = lire(`src/db/migrations/0955_l103f_dates_documents_idx_${n}.sql`);
      expect(sql).toMatch(/verebona:optional-index/);
      expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_account_(document_date|uploaded_at)_idx/);
      expect(sql).not.toMatch(/DROP|DELETE|ALTER/);
    }
  });
});

// ── Filtres de l'écran ─────────────────────────────────────────────────────

describe('103F — filtres de l’écran : dates indépendantes, synthèse, retour', () => {
  const doc2022 = { preset: 'custom' as const, from: '2022-01-01', to: '2022-12-31' };
  const ajout2026 = { preset: 'thisYear' as const, from: '2026-01-01', to: '2026-12-31' };

  it('retirer une date garde l’autre ; changer de bien garde les dates ; compteurs par section', () => {
    let f = V.setDateFilter(V.EMPTY_FILTERS, 'documentDate', doc2022);
    f = V.setDateFilter(f, 'addedDate', ajout2026);
    f = V.toggleFilter(f, 'biens', '4');
    expect(f.documentDate).toEqual(doc2022);
    expect(f.addedDate).toEqual(ajout2026);
    expect(V.activeFilterCount(f)).toBe(3);
    expect(V.sectionActiveCount(f, 'dateDocument')).toBe(1);
    expect(V.sectionActiveCount(f, 'bien')).toBe(1);
    expect(V.sectionActiveCount(f, 'rubrique')).toBe(0);
    const sansDoc = V.setDateFilter(f, 'documentDate', null);
    expect(sansDoc.documentDate).toBeUndefined();
    expect(sansDoc.addedDate).toEqual(ajout2026);
  });

  it('synthèse : libellés des périodes, retirables, dans l’ordre des sections', () => {
    const f = { ...V.EMPTY_FILTERS, types: ['INVOICE'], documentDate: doc2022, addedDate: ajout2026 };
    const options = V.filterOptionsFromFacets({ biens: [], rubrics: [], types: [{ value: 'INVOICE', label: 'Facture', count: 2 }] }, f, []);
    expect(V.activeFilterChips(f, options).map((c) => [c.dim, c.label])).toEqual([
      ['types', 'Facture'],
      ['documentDate', 'Date du document : 01/01/2022 – 31/12/2022'],
      ['addedDate', "Date d'ajout : 01/01/2026 – 31/12/2026"],
    ]);
  });

  it('retour sur l’écran : pièce et périodes reprises ; liste vide gardée pour ses critères', () => {
    const base = { v: 1, key: 'k', documents: [], meta: null, nextCursor: null, pageEnds: [], scrollTop: 0, savedAt: 1000 };
    const f = parseSnapshot({ ...base, filters: { biens: ['1'], rubrics: [], types: [], piece: '7', documentDate: { preset: 'none' }, addedDate: ajout2026 } }, 1000)!.filters;
    expect(f).toEqual({ biens: ['1'], rubrics: [], types: [], piece: '7', documentDate: { preset: 'none' }, addedDate: ajout2026 });
    // « Sans date » n'existe pas pour la date d'ajout ; période inversée écartée.
    const g = parseSnapshot({ ...base, filters: { biens: [], rubrics: [], types: [], addedDate: { preset: 'none' }, documentDate: { preset: 'custom', from: '2025-02-01', to: '2025-01-01' } } }, 1000)!.filters;
    expect(g).toEqual({ biens: [], rubrics: [], types: [] });

    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
    saveListSnapshot('mes-documents', { ...base, v: 1, filters: V.EMPTY_FILTERS } as never, s);
    expect(m.size).toBe(0);
    saveListSnapshot('mes-documents', { ...base, v: 1, key: '', filters: { ...V.EMPTY_FILTERS, addedDate: ajout2026 } } as never, s);
    expect(JSON.parse(m.get(snapshotStorageKey('mes-documents'))!).filters.addedDate).toEqual(ajout2026);
  });
});

// ── Sections repliables ────────────────────────────────────────────────────

describe('103F — sections repliables : état initial, mémoire de session, largeur', () => {
  const vide = { v: 1 as const, open: {} };

  it('téléphone sans préférence : « Bien » ouvert, les autres repliées', () => {
    const o = S.resolveSectionsOpen('mobile', V.EMPTY_FILTERS, vide);
    expect(o).toEqual({ bien: true, rubrique: false, type: false, piece: false, equipement: false, dateDocument: false, dateAjout: false });
  });

  it('ordinateur / tablette : toutes ouvertes', () => {
    expect(Object.values(S.resolveSectionsOpen('wide', V.EMPTY_FILTERS, vide)).every(Boolean)).toBe(true);
  });

  it('téléphone : une section qui porte déjà une sélection à l’arrivée s’ouvre (rien de caché)', () => {
    const o = S.resolveSectionsOpen('mobile', { ...V.EMPTY_FILTERS, types: ['INVOICE'], addedDate: { preset: 'thisYear', from: '2026-01-01', to: '2026-12-31' } }, vide);
    expect(o.type).toBe(true);
    expect(o.dateAjout).toBe(true);
    expect(o.rubrique).toBe(false);
  });

  it('plusieurs sections ouvertes à la fois ; les choix explicites priment, y compris après un changement de largeur', () => {
    const memoire = { v: 1 as const, open: { type: true, rubrique: true, bien: false } };
    const mobile = S.resolveSectionsOpen('mobile', V.EMPTY_FILTERS, memoire);
    expect([mobile.type, mobile.rubrique, mobile.bien]).toEqual([true, true, false]);
    const large = S.resolveSectionsOpen('wide', V.EMPTY_FILTERS, memoire);
    expect([large.type, large.rubrique, large.bien, large.dateDocument]).toEqual([true, true, false, true]);
  });

  it('mémoire de session : lecture validée, stockage bloqué sans erreur', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    S.saveSectionsMemory('mes-documents', { v: 1, panel: true, open: { type: true, bien: false } }, s);
    expect(S.loadSectionsMemory('mes-documents', s)).toEqual({ v: 1, panel: true, open: { type: true, bien: false } });
    m.set(S.sectionsStorageKey('mes-documents'), '{"open":{"type":"oui","inconnue":true},"panel":3}');
    expect(S.loadSectionsMemory('mes-documents', s)).toEqual({ v: 1, open: {} });
    m.set(S.sectionsStorageKey('mes-documents'), '{pas du json');
    expect(S.loadSectionsMemory('mes-documents', s)).toEqual({ v: 1, open: {} });
    const bloque = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
    expect(S.loadSectionsMemory('x', bloque)).toEqual({ v: 1, open: {} });
    expect(() => S.saveSectionsMemory('x', { v: 1, open: { bien: true } }, bloque)).not.toThrow();
    expect(S.sectionsStorageKey('bien-4')).not.toBe(S.sectionsStorageKey('mes-documents'));
  });

  it('l’état des sections ne vit jamais dans les filtres ni dans la requête', () => {
    const page = lire('src/components/documents/v2/DocumentsByRubric.tsx');
    expect(page).toMatch(/const sections = useFilterSections\(restoreScope, filters, ready\)/);
    expect(page).toMatch(/sort,\s*direction: prefs\.dir,\s*grouped: prefs\.grouped,\s*filters,/);
    expect(lire('src/components/documents/v2/filter-sections.ts')).toMatch(/window\.sessionStorage/);
    expect(lire('src/components/documents/v2/filter-sections.ts')).toMatch(/try \{[\s\S]*catch/);
  });
});

// ── Rendu accessible ───────────────────────────────────────────────────────

describe('103F — rendu : en-têtes accessibles, compteurs distincts, pas de tiroir', () => {
  const options = {
    biens: [{ value: '1', label: 'Appareil photo Sony Alpha 7 IV', count: 9, active: true }, { value: '2', label: 'Maison', count: 1, active: true }],
    rubrics: [{ value: 'MAINTENANCE_WORKS', label: 'Entretien et travaux', count: 44, active: false }],
    types: [],
  };
  const filters = { ...V.EMPTY_FILTERS, biens: ['1', '2'] };
  const open = { bien: false, rubrique: true, type: false, piece: false, equipement: false, dateDocument: false, dateAjout: false };
  const html = renderToStaticMarkup(h(DocumentsFilterPanel, {
    id: 'f', context: 'mes-documents', options, onToggle: noop, filters, onDate: noop,
    sections: { open, onOpenChange: noop },
  }));

  it('en-tête : bouton aria-expanded / aria-controls, cible existante même repliée', () => {
    const boutons = html.match(/<button[^>]*aria-controls="[^"]+"[^>]*aria-expanded="(true|false)"[^>]*>|<button[^>]*aria-expanded="(true|false)"[^>]*aria-controls="[^"]+"[^>]*>/g) ?? [];
    expect(boutons.length).toBe(5); // Bien, Rubrique, Type, Date du document, Date d'ajout
    for (const b of boutons) {
      const cible = /aria-controls="([^"]+)"/.exec(b)![1];
      expect(html).toContain(`id="${cible}"`);
    }
    expect(html).toMatch(/aria-expanded="false"[\s\S]*?<span id="f-bien" class="vb-app-label">Bien<\/span>/);
    expect(html).toMatch(/min-h-11/);
    expect(html).toMatch(/motion-reduce:transition-none/);
    expect(html).not.toMatch(/role="dialog"|data-slot="sheet/);
  });

  it('section repliée : titre et « 2 actifs » visibles, options masquées (hidden)', () => {
    expect(html).toContain('2 actifs');
    expect(html).toContain('2 filtres actifs');
    const bien = html.slice(html.indexOf('data-filter-section="f-bien"'), html.indexOf('data-filter-section="f-rubrique"'));
    expect(bien).toMatch(/hidden=""/);
    // Aucun compteur de sélections sans sélection.
    const rubrique = html.slice(html.indexOf('data-filter-section="f-rubrique"'), html.indexOf('data-filter-section="f-type"'));
    expect(rubrique).not.toMatch(/actif/);
  });

  it('pastilles : « · 9 » visible, « 9 documents » annoncé ; aide en tête du panneau', () => {
    expect(html).toContain('Appareil photo Sony Alpha 7 IV · 9');
    expect(html).toContain('aria-label="Appareil photo Sony Alpha 7 IV, 9 documents"');
    expect(html).toContain('aria-label="Entretien et travaux, 44 documents"');
    expect(html).toContain('aria-label="Maison, 1 document"');
    expect(describeDocumentCount(0)).toBe('0 document');
    expect(html).toContain('data-testid="aide-compteurs"');
  });

  it('sections de dates : radiogroup, « Toutes les dates » par défaut, « Sans date » pour la date du document seulement', () => {
    const doc = renderToStaticMarkup(h(DateFilterSection, { id: 'dd', title: 'Date du document', value: undefined, onChange: noop, allowNone: true }));
    expect(doc).toContain('role="radiogroup" aria-labelledby="dd"');
    expect(doc).toMatch(/aria-checked="true"[^>]*>Toutes les dates</);
    for (const l of ['Ce mois', 'Cette année', 'Année précédente', '12 derniers mois', 'Période personnalisée', 'Sans date']) expect(doc).toContain(`>${l}<`);
    const ajout = renderToStaticMarkup(h(DateFilterSection, { id: 'da', title: "Date d'ajout", value: undefined, onChange: noop, allowNone: false }));
    expect(ajout).not.toContain('Sans date');
    const perso = renderToStaticMarkup(h(DateFilterSection, { id: 'dp', title: "Date d'ajout", value: { preset: 'custom', from: '2026-03-01' }, onChange: noop, allowNone: false }));
    expect(perso).toContain('<label for="dp-du"');
    expect(perso).toContain('<label for="dp-au"');
    expect(perso).toContain('01/03/2026');
    expect(perso).toContain('Depuis le 01/03/2026');
  });

  it('synthèse compacte : quatre pastilles puis « + N autres », « Réinitialiser les filtres »', () => {
    const chips = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `Filtre ${i}` }));
    const compact = renderToStaticMarkup(h(ActiveFilterChips, { chips, onRemove: noop, onClear: noop, clearLabel: 'Réinitialiser les filtres', maxVisible: 4 }));
    expect(compact.match(/Retirer le filtre/g)).toHaveLength(4);
    expect(compact).toContain('+ 2 autres');
    expect(compact).toContain('Réinitialiser les filtres');
    expect(compact).toContain('role="group" aria-label="Filtres actifs"');
    // Sans option : comportement inchangé (« Mon agenda »).
    const agenda = renderToStaticMarkup(h(ActiveFilterChips, { chips, onRemove: noop, onClear: noop }));
    expect(agenda.match(/Retirer le filtre/g)).toHaveLength(6);
    expect(agenda).toContain('Tout effacer');
  });

  it('composant partagé : sans `collapse`, rendu historique inchangé (« Mon agenda »)', () => {
    const pills = renderToStaticMarkup(h(FilterPillSection, { id: 's', title: 'Bien', options: [{ value: '1', label: 'Maison', count: 2, active: false }], onToggle: noop }));
    expect(pills).toContain('<p id="s" class="vb-app-label">Bien</p>');
    expect(pills).not.toContain('aria-expanded');
    expect(pills).not.toContain('aria-label=');
  });
});
