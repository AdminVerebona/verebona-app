/**
 * DOC-PERF — chargement progressif des documents : contrat d'API, curseur,
 * état du chargement, compteurs, restauration au retour.
 *
 * Tout est testé sans navigateur ni base : la pagination SQL réelle est
 * couverte par le scénario E2E `doc-perf-chargement-progressif.e2e.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  buildFeedQuery,
  parseFeedParams,
  type FeedMeta,
  type FeedResponse,
} from '@/lib/documents/document-feed';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  keyComponents,
  keysetCondition,
  orderSignature,
  rubricRank,
  type KeyComponent,
  type KeysetNode,
} from '@/services/documents/document-cursor';
import { buildFeedMeta, matchesFilters } from '@/services/documents/rubric-query.service';
import {
  INITIAL_FEED,
  boundedList,
  feedReducer,
  nextRequest,
  type FeedAction,
  type FeedState,
} from '../documents-feed';
import { NO_ASSET, NO_TYPE, UNFILED, filterOptionsFromFacets, type DocumentItem } from '../documents-view';
import {
  RESTORE_MAX_DOCUMENTS,
  RESTORE_TTL_MS,
  parseSnapshot,
  saveListSnapshot,
  snapshotStorageKey,
  takeListSnapshot,
  type ListSnapshot,
} from '../list-restore';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

// ── Contrat d'API ────────────────────────────────────────────────────────

describe('paramètres de l’API', () => {
  it('lot de 50 par défaut, plafond serveur à 100 quoi que demande le client', () => {
    expect(parseFeedParams(new URLSearchParams('')).limit).toBe(FEED_DEFAULT_LIMIT);
    expect(FEED_DEFAULT_LIMIT).toBe(50);
    expect(parseFeedParams(new URLSearchParams('limit=5000')).limit).toBe(FEED_MAX_LIMIT);
    expect(FEED_MAX_LIMIT).toBe(100);
    expect(parseFeedParams(new URLSearchParams('limit=-3')).limit).toBe(50);
    expect(parseFeedParams(new URLSearchParams('limit=abc')).limit).toBe(50);
  });

  it('`pageSize=all` n’existe plus : un lot, jamais tout le périmètre', () => {
    const p = parseFeedParams(new URLSearchParams('pageSize=all'));
    expect(p.limit).toBe(50);
    expect(p).not.toHaveProperty('pageSize');
  });

  it('tri, sens, regroupement, filtres, recherche, périmètre ; valeurs illisibles ignorées', () => {
    const p = parseFeedParams(new URLSearchParams(
      'sort=docDate&direction=asc&grouped=1&assets=12,x,-1&biens=4,__NO_ASSET__,abc&rubrics=MEDIA,__UNFILED__&types=DPE&ids=3,4,x&cursor=abc',
    ));
    expect(p).toEqual({
      assetIds: [12], sort: 'docDate', direction: 'asc', grouped: true,
      filters: { biens: ['4', '__NO_ASSET__'], rubrics: ['MEDIA', '__UNFILED__'], types: ['DPE'] },
      ids: [3, 4], limit: 50, cursor: 'abc',
    });
    expect(parseFeedParams(new URLSearchParams('sort=poids')).sort).toBe('added');
    expect(parseFeedParams(new URLSearchParams('sort=documentDate')).sort).toBe('docDate');
    expect(parseFeedParams(new URLSearchParams('ids=none')).ids).toEqual([]);
    expect(parseFeedParams(new URLSearchParams('')).ids).toBeNull();
  });

  it('la requête construite par l’écran est relue à l’identique par la route', () => {
    const q = {
      assetIds: [7], sort: 'title' as const, direction: 'asc' as const, grouped: true,
      filters: { biens: ['9', '2'], rubrics: [UNFILED], types: [NO_TYPE] }, ids: [] as number[],
    };
    const parsed = parseFeedParams(new URLSearchParams(buildFeedQuery({ ...q, cursor: 'c1' })));
    expect(parsed).toEqual({ ...q, filters: { ...q.filters, biens: ['2', '9'] }, limit: 50, cursor: 'c1' });
    // Deux états équivalents : la même clé.
    expect(buildFeedQuery({ ...q, filters: { ...q.filters, biens: ['2', '9'] } })).toBe(buildFeedQuery(q));
  });
});

// ── Curseur : ordre total, condition « après » ───────────────────────────

describe('curseur', () => {
  it('opaque, lié à l’ordre : un curseur d’un autre tri est refusé', () => {
    const sig = orderSignature('docDate', 'desc', false);
    const c = encodeFeedCursor(sig, ['2024-01-01', null, '12']);
    expect(c).not.toMatch(/2024/);
    expect(decodeFeedCursor(c, sig, 3)).toEqual(['2024-01-01', null, '12']);
    expect(decodeFeedCursor(c, orderSignature('docDate', 'asc', false), 3)).toBeNull();
    expect(decodeFeedCursor(c, sig, 4)).toBeNull();
    expect(decodeFeedCursor('pas-du-base64-json', sig, 3)).toBeNull();
    expect(decodeFeedCursor(encodeFeedCursor(sig, [{ x: 1 } as never, null, '1']), sig, 3)).toBeNull();
  });

  it('ordre stable : se termine toujours par l’identifiant ; regroupé, la Rubrique d’abord', () => {
    for (const sort of ['added', 'docDate', 'title', 'bien', 'rubric'] as const) {
      const keys = keyComponents(sort, 'desc', false).map((k) => k.key);
      expect(keys[keys.length - 1]).toBe('id');
    }
    expect(keyComponents('docDate', 'desc', false).map((k) => `${k.key}:${k.dir}`))
      .toEqual(['documentDate:desc', 'uploadedAt:desc', 'id:desc']);
    expect(keyComponents('added', 'asc', true).map((k) => k.key))
      .toEqual(['rubricRank', 'rubricCode', 'uploadedAt', 'id']);
  });

  it('rang de Rubrique : « Sans rubrique », référentiel, puis codes inconnus', () => {
    expect(rubricRank(null)).toBeLessThan(rubricRank('PROPERTY_MANAGEMENT'));
    expect(rubricRank('PROPERTY_MANAGEMENT')).toBeLessThan(rubricRank('OTHER_DOCUMENTS'));
    expect(rubricRank('OTHER_DOCUMENTS')).toBeLessThan(rubricRank('LEGACY_X'));
  });

  // Évaluation en mémoire de l'arbre que le service traduit en SQL.
  type Row = { id: number; v: Array<string | number | null> };
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
  function evaluate(node: KeysetNode, row: Row, cursor: Array<string | number | null>): boolean {
    switch (node.op) {
      case 'false': return false;
      case 'and': return node.items.every((n) => evaluate(n, row, cursor));
      case 'or': return node.items.some((n) => evaluate(n, row, cursor));
      case 'isNull': return row.v[node.index] === null;
      case 'cmp': {
        const a = row.v[node.index];
        const b = cursor[node.index];
        if (a === null || b === null) return false; // SQL : comparaison à NULL jamais vraie
        const c = cmp(a, b);
        return node.cmp === '>' ? c > 0 : node.cmp === '<' ? c < 0 : c === 0;
      }
    }
  }
  function orderBy(components: KeyComponent[]) {
    return (x: Row, y: Row) => {
      for (let i = 0; i < components.length; i += 1) {
        const a = x.v[i];
        const b = y.v[i];
        if (a === b) continue;
        if (a === null) return 1; // NULLS LAST, dans les deux sens
        if (b === null) return -1;
        const c = cmp(a, b) * (components[i].dir === 'asc' ? 1 : -1);
        if (c !== 0) return c;
      }
      return 0;
    };
  }

  it('aucun doublon, aucun oubli : égalités et valeurs absentes à chaque frontière de lot', () => {
    let graine = 42;
    const hasard = (n: number) => { graine = (graine * 1103515245 + 12345) % 2 ** 31; return graine % n; };
    for (const sort of ['added', 'docDate', 'title', 'bien', 'rubric'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        for (const grouped of [false, true]) {
          const components = keyComponents(sort, dir, grouped);
          const rows: Row[] = Array.from({ length: 97 }, (_, i) => ({
            id: i + 1,
            v: components.map((c) => {
              if (c.key === 'id') return i + 1;
              if (c.nullable && hasard(3) === 0) return null;
              return c.key === 'rubricRank' ? hasard(3) - 1 : `v${hasard(4)}`; // beaucoup d'égalités
            }),
          }));
          const attendu = [...rows].sort(orderBy(components)).map((r) => r.id);
          for (const limit of [1, 7, 50]) {
            const vus: number[] = [];
            let cursor: Array<string | number | null> | null = null;
            for (let garde = 0; garde < 200; garde += 1) {
              const restants = rows.filter((r) => !cursor || evaluate(keysetCondition(components, cursor as never), r, cursor));
              const lot = restants.sort(orderBy(components)).slice(0, limit + 1);
              const page = lot.slice(0, limit);
              vus.push(...page.map((r) => r.id));
              if (lot.length <= limit) break;
              cursor = page[page.length - 1].v;
            }
            expect(vus, `${sort} ${dir} ${grouped} ${limit}`).toEqual(attendu);
          }
        }
      }
    }
  });
});

// ── Compteurs globaux ────────────────────────────────────────────────────

describe('compteurs globaux (une agrégation du périmètre)', () => {
  const rows = [
    { assetId: 1, assetName: 'Appartement', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'INVOICE', count: 40 },
    { assetId: 1, assetName: 'Appartement', rubricCode: null, documentTypeCode: null, count: 3 },
    { assetId: null, assetName: null, rubricCode: 'MEDIA', documentTypeCode: 'INVOICE', count: 5 },
    { assetId: 2, assetName: 'Vélo', rubricCode: 'LEGACY_X', documentTypeCode: 'INCONNU', count: 2 },
  ];
  const context = { families: ['IMMOBILIER' as const], hasRentedAsset: false };

  it('total et Rubriques : ensemble filtré entier, pas le lot ; options : périmètre', () => {
    const meta = buildFeedMeta(rows, { biens: [], rubrics: [], types: ['INVOICE'] }, context);
    expect(meta.total).toBe(45);
    expect(meta.scopeTotal).toBe(50);
    expect(meta.rubrics.find((r) => r.code === 'PROPERTY_MANAGEMENT')).toMatchObject({ count: 40, scopeCount: 40 });
    expect(meta.unfiledCount).toBe(0);
    // Rubrique hors référentiel mais non vide : rendue, en dernier.
    expect(meta.rubrics[meta.rubrics.length - 1]).toMatchObject({ code: 'LEGACY_X', count: 0, scopeCount: 2 });
    expect(meta.facets.types.reduce((s, t) => s + t.count, 0)).toBe(50);
    expect(meta.facets.biens.find((b) => b.value === NO_ASSET)?.count).toBe(5);
  });

  it('même règle de filtre que la requête SQL : ET entre dimensions, OU dedans', () => {
    const f = { biens: [NO_ASSET, '2'], rubrics: [], types: [NO_TYPE, 'INVOICE'] };
    expect(matchesFilters(rows[2], f)).toBe(true);
    expect(matchesFilters(rows[3], f)).toBe(false);
    expect(matchesFilters(rows[0], f)).toBe(false);
  });

  it('options de filtre de l’écran construites à partir des compteurs serveur', () => {
    const meta = buildFeedMeta(rows, { biens: [], rubrics: [], types: [] }, context);
    const rubrics = meta.rubrics.map((r) => ({ code: r.code, label: r.label }));
    const o = filterOptionsFromFacets(meta.facets, { biens: [], rubrics: [], types: ['QUOTE'] }, rubrics);
    expect(o.biens.map((b) => `${b.label}:${b.count}`)).toEqual(['Appartement:43', 'Vélo:2', 'Sans bien:5']);
    expect(o.rubrics.find((r) => r.value === UNFILED)?.count).toBe(3);
    expect(o.types.map((t) => t.label)).toContain('Type à compléter');
    // Option active à 0 conservée pour pouvoir la retirer.
    expect(o.types.find((t) => t.value === 'QUOTE')).toMatchObject({ count: 0, active: true });
  });
});

// ── État du chargement ───────────────────────────────────────────────────

let n = 0;
function doc(p: Partial<DocumentItem> = {}): DocumentItem {
  n += 1;
  return {
    id: n, publicId: `p${n}`, title: `Doc ${n}`, originalFilename: null, assetId: 1, rubricCode: 'MEDIA',
    documentTypeCode: 'INVOICE', documentTypeLabel: 'Facture', documentDate: null, uploadedAt: null, mimeType: null,
    assetNames: ['Bien'], ...p,
  };
}
const META: FeedMeta = {
  total: 120, scopeTotal: 130, unfiledCount: 10,
  rubrics: [{ code: 'MEDIA', label: 'Photos et vidéos', count: 110, scopeCount: 120 }],
  facets: {
    biens: [{ value: '1', label: 'Bien', count: 130 }],
    rubrics: [{ value: 'MEDIA', label: null, count: 120 }, { value: UNFILED, label: null, count: 10 }],
    types: [{ value: 'INVOICE', label: 'Facture', count: 130 }],
  },
};
const lot = (documents: DocumentItem[], nextCursor: string | null, meta?: FeedMeta): FeedResponse =>
  ({ documents: documents as FeedResponse['documents'], nextCursor, hasMore: nextCursor !== null, limit: 50, ...(meta ? { meta } : {}) });
const run = (s: FeedState, ...actions: FeedAction[]) => actions.reduce(feedReducer, s);

describe('état du chargement', () => {
  it('premier lot seulement au démarrage, puis la suite par curseur', () => {
    let s = run(INITIAL_FEED, { type: 'reset', key: 'k' });
    expect(s.status).toBe('idle');
    expect(nextRequest(s)).toBeNull(); // premier lot
    s = run(s, { type: 'start', key: 'k', requestId: 1, kind: 'first' });
    expect(s.status).toBe('loading');
    s = run(s, { type: 'success', key: 'k', requestId: 1, response: lot([doc(), doc()], 'c2', META) });
    expect(s.status).toBe('success');
    expect(s.meta?.total).toBe(120);
    expect(nextRequest(s)).toBe('c2');
  });

  it('un seul appel à la fois : la sentinelle ne relance pas le même curseur', () => {
    let s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' });
    expect(nextRequest(s)).toBeUndefined();
    const avant = s;
    s = run(s, { type: 'start', key: 'k', requestId: 2, kind: 'first' });
    expect(s).toBe(avant); // second départ refusé
    s = run(s, { type: 'success', key: 'k', requestId: 2, response: lot([doc()], null) });
    expect(s).toBe(avant); // réponse d'un appel qui n'est pas le sien : ignorée
  });

  it('fin de liste : statut `end`, plus aucun appel', () => {
    const s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' },
      { type: 'success', key: 'k', requestId: 1, response: lot([doc()], null, META) });
    expect(s.status).toBe('end');
    expect(nextRequest(s)).toBeUndefined();
  });

  it('nouveaux critères : liste vidée, curseur réinitialisé, ancienne réponse ignorée', () => {
    let s = run(INITIAL_FEED, { type: 'reset', key: 'tri-a' }, { type: 'start', key: 'tri-a', requestId: 1, kind: 'first' },
      { type: 'success', key: 'tri-a', requestId: 1, response: lot([doc()], 'c2', META) },
      { type: 'start', key: 'tri-a', requestId: 2, kind: 'next' });
    s = run(s, { type: 'reset', key: 'tri-b' });
    expect(s.documents).toEqual([]);
    expect(s.nextCursor).toBeNull();
    expect(s.meta).toBeNull();
    s = run(s, { type: 'start', key: 'tri-b', requestId: 3, kind: 'first' });
    const tard = run(s, { type: 'success', key: 'tri-a', requestId: 2, response: lot([doc()], 'zz') });
    expect(tard).toBe(s);
  });

  it('lot suivant en échec : documents conservés, erreur locale, relance manuelle seulement', () => {
    const premier = [doc(), doc()];
    let s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' },
      { type: 'success', key: 'k', requestId: 1, response: lot(premier, 'c2', META) },
      { type: 'start', key: 'k', requestId: 2, kind: 'next' },
      { type: 'failure', key: 'k', requestId: 2 });
    expect(s.status).toBe('error');
    expect(s.error).toBe('next');
    expect(s.documents).toEqual(premier);
    expect(nextRequest(s)).toBeUndefined(); // pas de relance automatique
    s = run(s, { type: 'retry' });
    expect(nextRequest(s)).toBe('c2'); // même curseur, ni trou ni doublon
  });

  it('premier lot en échec : erreur d’écran (aucun document à garder)', () => {
    const s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' },
      { type: 'failure', key: 'k', requestId: 1 });
    expect(s.error).toBe('first');
    expect(nextRequest(run(s, { type: 'retry' }))).toBeNull();
  });

  it('un document déjà reçu n’est jamais ajouté deux fois', () => {
    const a = doc();
    const s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' },
      { type: 'success', key: 'k', requestId: 1, response: lot([a], 'c2', META) },
      { type: 'start', key: 'k', requestId: 2, kind: 'next' },
      { type: 'success', key: 'k', requestId: 2, response: lot([a, doc()], null) });
    expect(s.documents.map((d) => d.id)).toEqual([a.id, a.id + 1]);
  });

  it('suppression : retrait immédiat, compteurs à jour, lots conservés', () => {
    const docs = [doc(), doc({ rubricCode: null }), doc()];
    let s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' },
      { type: 'success', key: 'k', requestId: 1, response: lot(docs, 'c2', META) });
    s = run(s, { type: 'remove', id: docs[1].id });
    expect(s.documents.map((d) => d.id)).toEqual([docs[0].id, docs[2].id]);
    expect(s.meta).toMatchObject({ total: 119, scopeTotal: 129, unfiledCount: 9 });
    expect(s.meta?.facets.rubrics.find((r) => r.value === UNFILED)?.count).toBe(9);
    expect(s.meta?.rubrics[0].count).toBe(110);
    expect(s.pageEnds).toEqual([{ size: 2, cursor: 'c2' }]);
    expect(s.status).toBe('success');
    expect(nextRequest(s)).toBe('c2');
  });

  it('revalidation (ajout, modification) : remplace d’un bloc ; en échec, la liste reste', () => {
    let s = run(INITIAL_FEED, { type: 'reset', key: 'k' }, { type: 'start', key: 'k', requestId: 1, kind: 'first' },
      { type: 'success', key: 'k', requestId: 1, response: lot([doc()], 'c2', META) },
      { type: 'start', key: 'k', requestId: 2, kind: 'refresh' });
    expect(s.documents).toHaveLength(1); // rien n'est vidé pendant la revalidation
    const echec = run(s, { type: 'failure', key: 'k', requestId: 2 });
    expect(echec).toMatchObject({ status: 'success', error: null, pending: null });
    const nouveaux = [doc(), doc()];
    s = run(s, { type: 'replace', key: 'k', requestId: 2, documents: nouveaux, meta: META, nextCursor: null, pageEnds: [{ size: 2, cursor: null }] });
    expect(s.documents).toEqual(nouveaux);
    expect(s.status).toBe('end');
  });

  it('liste bornée, coupée à une fin de lot : la suite repart du bon curseur', () => {
    const docs = Array.from({ length: 350 }, () => doc());
    const s: FeedState = {
      ...INITIAL_FEED, key: 'k', status: 'success', documents: docs, nextCursor: 'c8',
      pageEnds: [50, 100, 150, 200, 250, 300, 350].map((size, i) => ({ size, cursor: `c${i + 2}` })),
    };
    const b = boundedList(s, RESTORE_MAX_DOCUMENTS);
    expect(b.documents).toHaveLength(300);
    expect(b.nextCursor).toBe('c7');
    expect(b.documents[299].id).toBe(docs[299].id);
  });
});

// ── Retour sur l'écran ───────────────────────────────────────────────────

function memoire(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    has: (k: string) => m.has(k),
  };
}
const instantane = (p: Partial<ListSnapshot> = {}): ListSnapshot => ({
  v: 1, key: 'k', filters: { biens: [], rubrics: ['MEDIA'], types: [] }, documents: [doc()], meta: META,
  nextCursor: 'c2', pageEnds: [{ size: 1, cursor: 'c2' }], scrollTop: 1840, savedAt: 1_000_000, ...p,
});

describe('retour depuis une fiche', () => {
  it('filtres, lots chargés et position restaurés une fois, puis effacés', () => {
    const s = memoire();
    saveListSnapshot('mes-documents', instantane(), s);
    const lu = takeListSnapshot('mes-documents', 1_000_000 + 1000, s);
    expect(lu).toMatchObject({ key: 'k', scrollTop: 1840, nextCursor: 'c2', filters: { rubrics: ['MEDIA'] } });
    expect(s.has(snapshotStorageKey('mes-documents'))).toBe(false);
    expect(takeListSnapshot('mes-documents', 1_000_000 + 2000, s)).toBeNull();
  });

  it('bornée dans le temps et en taille ; stockage malformé ou bloqué : rien, sans erreur', () => {
    expect(parseSnapshot(instantane(), 1_000_000 + RESTORE_TTL_MS + 1)).toBeNull();
    const trop = instantane({ documents: Array.from({ length: RESTORE_MAX_DOCUMENTS + 1 }, () => doc()) });
    const s = memoire();
    saveListSnapshot('x', trop, s);
    expect(s.has(snapshotStorageKey('x'))).toBe(false);
    expect(parseSnapshot({ ...instantane(), filters: { biens: 'x' } }, 1_000_000)).toBeNull();
    const bloque = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(takeListSnapshot('x', 0, bloque)).toBeNull();
    expect(() => saveListSnapshot('x', instantane(), bloque)).not.toThrow();
  });
});

// ── Écran ────────────────────────────────────────────────────────────────

describe('écran Mes documents', () => {
  const VUE = read('src/components/documents/v2/DocumentsByRubric.tsx');
  const FLUX = read('src/components/documents/v2/useDocumentsFeed.ts');

  it('chargement automatique par sentinelle ; ni numéro de page ni « Page suivante »', () => {
    expect(VUE).toMatch(/new IntersectionObserver\(/);
    expect(VUE).toMatch(/rootMargin: '0px 0px 600px 0px'/);
    expect(VUE).not.toMatch(/>\s*Page suivante|Page \{|params\.set\('pageSize'/);
    expect(VUE).not.toMatch(/RENDER_STEP|Afficher \{/);
  });

  it('indicateur discret et erreur locale relançable en bas de liste', () => {
    expect(VUE).toMatch(/role="status" aria-live="polite"[\s\S]{0,200}Chargement des documents…/);
    expect(VUE).toMatch(/role="alert"[\s\S]{0,200}Impossible de charger les documents suivants\.[\s\S]{0,120}Réessayer/);
  });

  it('secours clavier : visible au focus, le parcours normal reste automatique', () => {
    expect(VUE).toMatch(/observerOk \? 'sr-only focus:not-sr-only' : ''/);
    expect(VUE).toMatch(/Charger les documents suivants/);
  });

  it('compteurs de section et total issus du serveur, pas des documents chargés', () => {
    expect(VUE).toMatch(/countLabel\(total, scopeTotal, filtered, context\)/);
    expect(VUE).toMatch(/groupCounts\.get\(group\.code\)/);
  });

  it('suppression sans rechargement complet ; ajout et modification revalident', () => {
    expect(VUE).toMatch(/addEventListener\('document-deleted'/);
    expect(VUE).toMatch(/onRefresh=\{apresModification\}/);
    expect(FLUX).toMatch(/type: 'replace', key: requestKey, requestId/);
  });

  it('retour sur l’écran : instantané de session borné, position restaurée sans animation', () => {
    expect(VUE).toMatch(/takeListSnapshot\(restoreScope\)/);
    expect(VUE).toMatch(/saveListSnapshot\(restoreScope/);
    expect(VUE).toMatch(/behavior: 'instant'/);
  });

  it('aucune journalisation de contenu, de curseur ou d’URL dans la route', () => {
    const route = read('src/app/api/v2/documents/route.ts');
    const log = route.slice(route.indexOf("console.info('[documents/feed]'"), route.indexOf('return new NextResponse'));
    expect(log).not.toMatch(/params\.cursor|nextCursor|\.title|url|JSON\.stringify\(page\)/i);
    expect(log).toMatch(/count: page\.documents\.length/);
    expect(route).toMatch(/'Cache-Control': 'private, no-store'/);
  });
});
