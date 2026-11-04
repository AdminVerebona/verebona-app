/**
 * Lot 105A — ticket « Recherche globale : Voir tous les documents (N) ».
 * Tests unitaires : libellé et règles d'affichage du lien (total exact,
 * chargement, 0, erreur, saisie sans mot exploitable), adresse du décompte
 * (même normalisation que le lien et l'écran d'arrivée), lecture de la
 * réponse, requêtes dans le désordre et annulation (`createLiveSearchRunner`,
 * le code réellement utilisé par le Provider), effacement de l'instantané de
 * retour, et gardes de structure (desktop + mobile, même fonction serveur).
 *
 * Le comportement serveur (total = liste, exclusions, pagination, mesure)
 * est vérifié sur PostgreSQL : `l105a-recherche-compteur.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LIVE_MIN_CHARS,
  SEE_ALL_DOCUMENTS_LABEL,
  createLiveSearchRunner,
  documentsCountUrl,
  parseDocumentsCount,
  seeAllDocumentsLabel,
  seeAllLinks,
  type DocumentsCountState,
  type LiveFetchJson,
} from '../live-search';
import { localSearchHref, readLocalQuery } from '@/lib/search/local-search';
import { parseFeedParams } from '@/lib/documents/document-feed';
import { clearListSnapshot, snapshotStorageKey } from '@/components/documents/v2/list-restore';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const doc = { id: 'doc-1', category: 'Document', label: 'Facture Homiris', href: '/documents?document=1' };
const agenda = { id: 'agenda-1', category: 'Agenda', label: 'Échéance Homiris', href: '/agenda?echeance=1' };
const pret = (total: number, searchApplied = true): DocumentsCountState => ({ status: 'ready', total, searchApplied });

describe('L105A — libellé « Voir tous les documents (N) »', () => {
  it('12 correspondances, 6 suggestions : le lien annonce 12, pas le nombre affiché', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...doc, id: `doc-${i}` }));
    const [lien] = seeAllLinks('homiris', rows, pret(12));
    expect(lien).toEqual({ id: 'voir-documents', label: 'Voir tous les documents (12)', href: '/documents?q=homiris', count: 12 });
  });

  it('moins de 6 : total réel ; plus de 6 : total exact (milliers lisibles)', () => {
    expect(seeAllLinks('homiris', [doc], pret(3))[0].label).toBe('Voir tous les documents (3)');
    expect(seeAllLinks('homiris', [doc], pret(1))[0].label).toBe('Voir tous les documents (1)');
    expect(seeAllDocumentsLabel(1234).replace(/\s/g, ' ')).toBe('Voir tous les documents (1 234)');
    expect(seeAllDocumentsLabel(null)).toBe(SEE_ALL_DOCUMENTS_LABEL);
  });

  it('aucun document : ni compteur trompeur, ni lien (même si la recherche suggérait un document)', () => {
    expect(seeAllLinks('homiris', [doc], pret(0))).toEqual([]);
    expect(seeAllLinks('homiris', [], pret(0))).toEqual([]);
  });

  it('saisie sans mot exploitable : jamais « tous les documents du compte »', () => {
    expect(seeAllLinks('de la', [], pret(523, false))).toEqual([]);
  });

  it('total en cours : lien sans chiffre, marqué « en cours », seulement si des documents sont suggérés', () => {
    const [lien] = seeAllLinks('homiris', [doc], { status: 'loading' });
    expect(lien).toEqual({ id: 'voir-documents', label: SEE_ALL_DOCUMENTS_LABEL, href: '/documents?q=homiris', pending: true });
    expect(lien.label).not.toMatch(/\d/);
    expect(seeAllLinks('homiris', [agenda], { status: 'loading' }).map((l) => l.id)).toEqual(['voir-agenda']);
  });

  it('total indisponible : lien sans chiffre (jamais une valeur erronée)', () => {
    const [lien] = seeAllLinks('homiris', [doc], { status: 'error' });
    expect(lien).toEqual({ id: 'voir-documents', label: SEE_ALL_DOCUMENTS_LABEL, href: '/documents?q=homiris' });
    expect(seeAllLinks('homiris', [], { status: 'error' })).toEqual([]);
  });

  it('total connu sans document dans les suggestions (hors aperçu) : le lien apparaît quand même', () => {
    expect(seeAllLinks('homiris', [agenda], pret(4)).map((l) => l.label))
      .toEqual(['Voir tous les documents (4)', 'Voir tous les événements']);
  });

  it('mélange de types : le lien des documents ne compte que les documents (le total vient du décompte documentaire)', () => {
    const rows = [doc, agenda, { id: 'asset-1', category: 'Bien', label: 'Homiris', href: '/assets/1' }];
    const liens = seeAllLinks('homiris', rows, pret(2));
    expect(liens[0]).toMatchObject({ id: 'voir-documents', count: 2 });
    expect(liens[1]).toEqual({ id: 'voir-agenda', label: 'Voir tous les événements', href: '/agenda?q=homiris&view=list' });
  });

  it('appelant historique (sans décompte) : comportement du lot 97C inchangé', () => {
    expect(seeAllLinks('Homiris', [doc])).toEqual([{ id: 'voir-documents', label: 'Voir tous les documents', href: '/documents?q=Homiris' }]);
  });
});

describe('L105A — même normalisation pour le décompte, le lien et l’écran d’arrivée', () => {
  it.each(['homiris', '  Homiris   2024 ', 'Facture  Homiris', 'électricité'])('« %s »', (saisie) => {
    const lien = new URL(localSearchHref('document', saisie.trim()), 'http://x');
    const compte = new URL(documentsCountUrl(saisie)!, 'http://x');
    // Ce que lit l'écran (« Mes documents ») et ce que lit la route du décompte.
    const qEcran = readLocalQuery(lien.searchParams);
    const paramsListe = parseFeedParams(lien.searchParams);
    const paramsCompte = parseFeedParams(compte.searchParams);
    expect(compte.pathname).toBe('/api/v2/documents');
    expect(compte.searchParams.get('count')).toBe('1');
    expect(paramsCompte.q).toBe(qEcran);
    expect(paramsCompte.q).toBe(paramsListe.q);
    // Sans filtre : « Voir tous » ouvre la liste sur la SEULE recherche.
    expect(paramsCompte.filters).toEqual(paramsListe.filters);
    expect(paramsCompte.filters).toEqual({ biens: [], rubrics: [], types: [] });
    expect(paramsCompte.ids).toBeNull();
    expect(paramsCompte.assetIds).toEqual([]);
  });

  it('saisie trop courte : aucun décompte', () => {
    expect(documentsCountUrl('a'.repeat(LIVE_MIN_CHARS - 1))).toBeNull();
    expect(documentsCountUrl('   ')).toBeNull();
  });

  it('réponse validée : entier positif ou nul, sinon erreur', () => {
    expect(parseDocumentsCount({ total: 12, searchApplied: true })).toEqual({ total: 12, searchApplied: true });
    expect(parseDocumentsCount({ total: 0, searchApplied: false })).toEqual({ total: 0, searchApplied: false });
    for (const bad of [null, {}, { total: -1 }, { total: 1.5 }, { total: '12' }, { error: 'DOCUMENTS_UNAVAILABLE' }]) {
      expect(parseDocumentsCount(bad)).toBeNull();
    }
  });
});

/** Réseau simulé : chaque requête attend qu'on la résolve, dans l'ordre voulu. */
function reseau() {
  const enVol: Array<{ url: string; signal: AbortSignal; resolve: (v: unknown) => void }> = [];
  const fetchJson: LiveFetchJson = (url, signal) => new Promise((resolve) => { enVol.push({ url, signal, resolve }); });
  const trouver = (pred: (u: string) => boolean) => enVol.find((r) => pred(r.url))!;
  return { enVol, fetchJson, trouver };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('L105A — requêtes dans le désordre : aucun total périmé', () => {
  it('« homiris » puis « homiris 2024 » : la réponse tardive de la première saisie est ignorée', async () => {
    const net = reseau();
    const vus: Array<{ q: string; state: DocumentsCountState }> = [];
    const runner = createLiveSearchRunner(net.fetchJson, { onResults: () => {}, onDocumentsCount: (q, state) => vus.push({ q, state }) });
    runner.run('homiris');
    const premier = net.trouver((u) => u.includes('count=1') && u.includes('q=homiris') && !u.includes('2024'));
    runner.run('homiris 2024');
    const second = net.trouver((u) => u.includes('count=1') && u.includes('2024'));
    // La première requête est annulée dès la nouvelle saisie.
    expect(premier.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    // Réponses dans le désordre : la plus récente d'abord, puis l'ancienne.
    second.resolve({ total: 3, searchApplied: true });
    await tick();
    premier.resolve({ total: 12, searchApplied: true });
    await tick();
    const prets = vus.filter((v) => v.state.status === 'ready');
    expect(prets).toEqual([{ q: 'homiris 2024', state: { status: 'ready', total: 3, searchApplied: true } }]);
  });

  it('les suggestions ne sont jamais retardées par le décompte, et inversement', async () => {
    const net = reseau();
    const res: string[] = [];
    const runner = createLiveSearchRunner(net.fetchJson, {
      onResults: (q, rows) => res.push(`res:${q}:${rows?.length ?? 'null'}`),
      onDocumentsCount: (q, s) => res.push(`count:${q}:${s.status}${s.status === 'ready' ? `:${s.total}` : ''}`),
    });
    runner.run('homiris');
    expect(net.enVol.map((r) => r.url.split('?')[0]).sort()).toEqual(['/api/search', '/api/v2/documents']);
    net.trouver((u) => u.startsWith('/api/search')).resolve({ results: [doc] });
    await tick();
    expect(res).toEqual(['count:homiris:loading', 'res:homiris:1']);
    net.trouver((u) => u.includes('count=1')).resolve({ total: 12, searchApplied: true });
    await tick();
    expect(res).toEqual(['count:homiris:loading', 'res:homiris:1', 'count:homiris:ready:12']);
  });

  it('annulation (saisie effacée, démontage) : plus aucune mise à jour', async () => {
    const net = reseau();
    const res: string[] = [];
    const runner = createLiveSearchRunner(net.fetchJson, { onResults: () => res.push('res'), onDocumentsCount: (_q, s) => res.push(s.status) });
    runner.run('homiris');
    runner.cancel();
    expect(net.enVol.every((r) => r.signal.aborted)).toBe(true);
    for (const r of net.enVol) r.resolve({ total: 12, results: [doc] });
    await tick();
    expect(res).toEqual(['loading']);
  });

  it('échec du décompte : état « erreur » (lien sans chiffre), jamais un total inventé', async () => {
    const net = reseau();
    let etat: DocumentsCountState | null = null;
    const runner = createLiveSearchRunner(net.fetchJson, { onResults: () => {}, onDocumentsCount: (_q, s) => { etat = s; } });
    runner.run('homiris');
    net.trouver((u) => u.includes('count=1')).resolve(null);
    await tick();
    expect(etat).toEqual({ status: 'error' });
  });
});

describe('L105A — arrivée sur « Mes documents » avec la seule recherche', () => {
  it('l’instantané de retour (filtres d’une visite précédente) est effacé', () => {
    const store = new Map<string, string>([[snapshotStorageKey('mes-documents'), '{"v":1}'], [snapshotStorageKey('bien-4'), '{"v":1}']]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    clearListSnapshot('mes-documents', storage);
    expect(store.has(snapshotStorageKey('mes-documents'))).toBe(false);
    expect(store.has(snapshotStorageKey('bien-4'))).toBe(true);
    expect(() => clearListSnapshot('mes-documents', null)).not.toThrow();
  });
});

describe('L105A — gardes de structure', () => {
  it('le Provider (desktop ET mobile) passe par l’exécuteur annulable et efface les filtres au clic', () => {
    const provider = read('src/components/verebona/space/VerebonaSpaceProvider.tsx');
    expect(provider).toContain('createLiveSearchRunner(');
    expect(provider).toContain('signal');
    expect(provider).toContain("clearListSnapshot('mes-documents')");
    expect(provider).toContain('DOCUMENTS_SEE_ALL_EVENT');
    // Plus de requête directe hors exécuteur (ancienne garde sans annulation).
    expect(provider).not.toMatch(/fetch\(`\/api\/search/);
    // Desktop et mobile rendent le même corps (même lien, même compteur).
    const field = read('src/components/verebona/space/VerebonaField.tsx');
    expect(field).toContain('<SpaceBody variant="desktop"');
    expect(field).toContain('<SpaceBody variant="mobile"');
    const content = read('src/components/verebona/space/SpaceContent.tsx');
    expect(content).toContain('l.pending');
    expect(content).toContain('aria-busy');
  });

  it('l’écran « Mes documents » déjà affiché retire ses filtres sur « Voir tous »', () => {
    const ecran = read('src/components/documents/v2/DocumentsByRubric.tsx');
    expect(ecran).toMatch(/addEventListener\(DOCUMENTS_SEE_ALL_EVENT/);
  });

  it('le décompte et la liste partagent la même résolution d’ensemble côté serveur', () => {
    const svc = read('src/services/documents/rubric-query.service.ts');
    expect(svc).toMatch(/export async function countDocumentFeed[\s\S]*?resolveFeedSet\(query, false\)/);
    expect(svc).toMatch(/export async function getDocumentFeed[\s\S]*?resolveFeedSet\(query, withMeta\)/);
    // Aucune seconde implémentation du périmètre : une seule fonction le construit.
    expect(svc.match(/scopeConditions\(query, searchIds\)/g)).toHaveLength(1);
    const route = read('src/app/api/v2/documents/route.ts');
    expect(route).toContain('countDocumentFeed({ ...params, accountId })');
  });
});
