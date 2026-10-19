/**
 * Lot 71 (71D) — ticket « BUG P1 — T2 : rechercher et proposer les
 * équipements et les pièces sans IA » : suggestions pendant la frappe
 * (`toLiveResults`, `liveSubtitle`) et règles de correspondance PURES du
 * moteur unique (`lib/search/match-engine.ts`) appliquées aux deux tables.
 */
import { describe, it, expect } from 'vitest';
import { LIVE_MAX_RESULTS, liveSubtitle, toLiveResults } from '@/lib/verebona/live-search';
import { isExactNameMatch, parseSearchQuery, runSearchPipeline, type SearchCandidate } from '@/lib/search/match-engine';
import { drawerFromHref } from '@/lib/drawers';

const POLICY = { requireAllTokens: true, allowSemantic: false } as const;

const equip = (id: number, name: string, assetName = 'Maison Lyon', type: string | null = null): SearchCandidate => ({
  entityType: 'equipment', entityId: id, displayName: name, retrievalStrategy: 'sql.token_like',
  fields: { name, type, assetName },
});
const piece = (id: number, name: string, assetName = 'Maison Lyon'): SearchCandidate => ({
  entityType: 'room', entityId: id, displayName: name, retrievalStrategy: 'sql.token_like', fields: { name, assetName },
});
const eligibles = (q: string, cands: SearchCandidate[]) => runSearchPipeline(parseSearchQuery(q), cands, POLICY).results.map((r) => r.candidate.displayName);

describe('SRCH-AC01..AC04 — moteur unique : équipements et pièces', () => {
  it('SRCH-AC01 — « Pompe à chaleur » : l’équipement est éligible, correspondance EXACTE sur le nom', () => {
    const q = parseSearchQuery('Pompe à chaleur');
    const [r] = runSearchPipeline(q, [equip(1, 'Pompe à chaleur')], POLICY).results;
    expect(r.candidate.displayName).toBe('Pompe à chaleur');
    expect(r.matchedField).toBe('name');
    expect(isExactNameMatch(q, 'Pompe à chaleur')).toBe(true);
  });

  it('SRCH-AC02 — « Cuisine » : la pièce est éligible', () => {
    expect(eligibles('Cuisine', [piece(1, 'Cuisine'), piece(2, 'Salon')])).toEqual(['Cuisine']);
  });

  it('SRCH-AC03 — accents, casse, mots outils, pluriel : « pompe a chaleur », « POMPES À CHALEUR » = « Pompe à chaleur »', () => {
    for (const saisie of ['pompe a chaleur', 'POMPE À CHALEUR', 'la pompe à chaleur', 'pompes a chaleur', ' Pompe-à-chaleur ']) {
      expect(isExactNameMatch(parseSearchQuery(saisie), 'Pompe à chaleur')).toBe(true);
    }
    expect(eligibles('pompe a chaleur', [equip(1, 'Pompe à chaleur')])).toEqual(['Pompe à chaleur']);
  });

  it('SRCH-AC04 — « Chambre parentale » : la pièce EXACTE est seule certaine (« Chambre enfant » jamais éligible)', () => {
    const q = parseSearchQuery('Chambre parentale');
    expect(eligibles('Chambre parentale', [piece(1, 'Chambre enfant'), piece(2, 'Chambre parentale')])).toEqual(['Chambre parentale']);
    expect(isExactNameMatch(q, 'Chambre enfant')).toBe(false);
  });

  it('SRCH-AC10 — terme partiellement similaire : « pompe » rapproche sans être exact ; « pompe à vélo » n’est jamais éligible', () => {
    expect(isExactNameMatch(parseSearchQuery('pompe'), 'Pompe à chaleur')).toBe(false);
    expect(eligibles('pompe à vélo', [equip(1, 'Pompe à chaleur')])).toEqual([]);
    expect(eligibles('chaudière', [equip(1, 'Pompe à chaleur')])).toEqual([]);
  });

  it('SRCH-AC10 — le bien parent seul ne rend jamais un équipement éligible (relation = complément)', () => {
    expect(eligibles('Lyon', [equip(1, 'Pompe à chaleur', 'Maison Lyon'), piece(2, 'Cuisine', 'Maison Lyon')])).toEqual([]);
    // Complément : nom ET bien → éligible.
    expect(eligibles('pompe lyon', [equip(1, 'Pompe à chaleur', 'Maison Lyon'), equip(2, 'Pompe à chaleur', 'Maison Annecy')])).toEqual(['Pompe à chaleur']);
  });

  it('SRCH-AC10 — le type d’équipement est un complément, jamais un match seul', () => {
    expect(eligibles('HEAT_PUMP', [equip(1, 'PAC salon', 'Maison Lyon', 'HEAT_PUMP')])).toEqual([]);
  });
});

describe('SRCH-AC01/AC02/AC07/AC12 — suggestions (`toLiveResults`)', () => {
  const ligne = (id: string, category: string, label: string, sublabel: string, drawer: { kind: string; id: number }, exact?: boolean) => ({
    id, category, label, sublabel, href: `/assets/10?tab=x&tiroir=${drawer.kind}%3A${drawer.id}`, drawer, ...(exact ? { exact } : {}),
  });

  it('SRCH-AC01 / SRCH-AC02 — catégories Équipement et Pièce : libellé réel, nature et bien parent', () => {
    const r = toLiveResults('xyz', [
      ligne('equipment-1', 'Équipement', 'Pompe à chaleur', 'Maison Lyon', { kind: 'equipement', id: 1 }, true),
      ligne('room-2', 'Pièce', 'Cuisine', 'Maison Lyon', { kind: 'piece', id: 2 }),
    ] as never);
    expect(r.map((x) => [x.kind, x.title, liveSubtitle(x)])).toEqual([
      ['equipment', 'Pompe à chaleur', 'Équipement · Maison Lyon'],
      ['room', 'Cuisine', 'Pièce · Maison Lyon'],
    ]);
    expect(r[0].drawer).toEqual({ kind: 'equipement', id: 1 });
    expect(r[1].drawer).toEqual({ kind: 'piece', id: 2 });
    expect(drawerFromHref(r[0].href)).toEqual({ kind: 'equipement', id: 1 });
  });

  it('SRCH-AC07 — homonymes : deux suggestions distinctes, contextualisées par leur bien', () => {
    const r = toLiveResults('xyz', [
      ligne('equipment-1', 'Équipement', 'Chaudière gaz', 'Maison Lyon', { kind: 'equipement', id: 1 }, true),
      ligne('equipment-2', 'Équipement', 'Chaudière gaz', 'Maison Annecy', { kind: 'equipement', id: 2 }, true),
    ] as never);
    expect(r.map(liveSubtitle)).toEqual(['Équipement · Maison Lyon', 'Équipement · Maison Annecy']);
    expect(new Set(r.map((x) => x.id)).size).toBe(2);
  });

  it('SRCH-AC12 — correspondance exacte servie APRÈS de nombreux résultats : toujours dans les six suggestions, en tête', () => {
    const autres = Array.from({ length: 12 }, (_, i) => ({ id: `doc-${i}`, category: 'Document', label: `Facture pompe chaleur ${i}`, href: `/documents?tiroir=document%3A${i}`, drawer: { kind: 'document', id: i + 1 } }));
    const r = toLiveResults('pompe a chaleur', [
      ...autres,
      ligne('equipment-9', 'Équipement', 'Pompe à chaleur', 'Maison Lyon', { kind: 'equipement', id: 9 }, true),
    ] as never);
    expect(r).toHaveLength(LIVE_MAX_RESULTS);
    expect(r.find((x) => x.kind !== 'nav')!.title).toBe('Pompe à chaleur');
    expect(r.some((x) => x.id === 'equipment-9')).toBe(true);
  });

  it('SRCH-AC12 — pages de navigation bornées : la place des correspondances exactes est réservée', () => {
    const exacts = Array.from({ length: 6 }, (_, i) => ligne(`room-${i}`, 'Pièce', 'Agenda', `Bien ${i}`, { kind: 'piece', id: i + 1 }, true));
    const r = toLiveResults('agenda', exacts as never);
    expect(r.every((x) => x.kind === 'room')).toBe(true);
  });

  it('SRCH-AC09 — tiroir invalide ou inconnu : jamais repris (lien profond validé)', () => {
    const r = toLiveResults('xyz', [
      { id: 'equipment-1', category: 'Équipement', label: 'A', href: '/accueil', drawer: { kind: 'admin', id: 1 } },
      { id: 'equipment-2', category: 'Équipement', label: 'B', href: '/accueil', drawer: { kind: 'equipement', id: -3 } },
      { id: 'x-3', category: 'Inconnue', label: 'C', href: '/accueil' },
    ] as never);
    expect(r.map((x) => x.title)).toEqual(['A', 'B']);
    expect(r.every((x) => x.drawer === undefined)).toBe(true);
  });

  it('SRCH-AC11 — non-régression : biens, documents, échéances inchangés (ordre servi, sous-titre)', () => {
    const r = toLiveResults('xyz', [
      { id: 'asset-1', category: 'Bien', label: 'Polo', sublabel: 'Voiture', href: '/assets/1' },
      { id: 'doc-2', category: 'Document', label: 'Facture', href: '/documents?tiroir=document%3A2', drawer: { kind: 'document', id: 2 } },
      { id: 'agenda-3', category: 'Agenda', label: 'Contrôle technique', sublabel: 'Polo', href: '/agenda?tiroir=echeance%3A3', drawer: { kind: 'echeance', id: 3 } },
    ] as never);
    expect(r.map((x) => [x.kind, x.title, liveSubtitle(x)])).toEqual([
      ['asset', 'Polo', 'Bien · Voiture'], ['document', 'Facture', 'Document'], ['agenda', 'Contrôle technique', 'Échéance · Polo'],
    ]);
  });
});
