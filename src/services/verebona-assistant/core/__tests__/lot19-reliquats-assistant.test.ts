/**
 * Lot 19, volet C — reliquats de l'assistant :
 *   · R1 : chronologie persistée (valeur écrite, relecture revérifiée §19.10) ;
 *   · R7 : biens d'une comparaison (page, fil, famille ; > 3 → clarification) ;
 *   · R8 : sources synthétiques d'agenda ouvrables, les autres non ouvrables ;
 *   · §19.4 : critères 3 (type) et 4 (date) sous lecture canonique, legacy à l'identique.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

import { timelineForStorage, reverifierChronologiesDesMessages } from '../timeline-persistence';
import { biensAComparer, familleComparee, COMPARISON_MAX_ASSETS } from '../synthesis-planner';
import { hrefAgendaSynthetique, hrefSource } from '../entity-ref';
import { resolveSourcesForDisplay } from '../source-resolver.service';
import { trierParContribution, RANG_TYPE_SOURCE } from '../assistant-orchestrator.service';
import type { Claim, ResolvedSource } from '../../types/sources';

afterEach(() => { delete process.env.ASSISTANT_CANONICAL_READ; });

describe('R1 — chronologie persistée', () => {
  it('valeur écrite : entrées valides seulement, liens internes, null sans chronologie', () => {
    expect(timelineForStorage(undefined)).toBeNull();
    expect(timelineForStorage([])).toBeNull();
    expect(timelineForStorage([
      { date: '2026-04-24', text: ' Achat ', ref: 'agenda_3', href: '/agenda?tiroir=echeance%3A3' },
      { date: null, text: '   ', ref: null, href: null },
      { date: '2026-05-01', text: 'Lien externe', ref: 'doc_4', href: 'https://evil.example' },
      { date: '2026-05-02', text: 'Protocole relatif', ref: 'doc_5', href: '//evil.example' },
    ])).toEqual([
      { date: '2026-04-24', text: 'Achat', ref: 'agenda_3', href: '/agenda?tiroir=echeance%3A3' },
      { date: '2026-05-01', text: 'Lien externe', ref: 'doc_4', href: null },
      { date: '2026-05-02', text: 'Protocole relatif', ref: 'doc_5', href: null },
    ]);
  });

  it('relecture : un objet supprimé ou hors compte perd son lien, la ligne reste ; une seule vérification par famille', async () => {
    const requeteur = vi.fn(async (sql: string, params: unknown[]) => {
      expect(params[1]).toBe(7);
      // agenda 3 vivant, agenda 9 disparu ; document 4 hors compte.
      if (sql.includes('agenda_items')) return [{ id: 3 }];
      return [];
    });
    const messages = [
      { id: 1, timeline_events_json: [
        { date: '2026-04-24', text: 'Achat', ref: 'agenda_3', href: '/agenda?tiroir=echeance%3A3' },
        { date: '2026-05-01', text: 'Facture', ref: 'doc_4', href: '/documents?tiroir=document%3A4' },
      ] },
      { id: 2, timeline_events_json: [{ date: '2026-06-01', text: 'Révision', ref: 'agenda_9', href: '/agenda?tiroir=echeance%3A9' }] },
      { id: 3, timeline_events_json: null },
    ];
    const out = await reverifierChronologiesDesMessages(messages, 7, requeteur);
    expect(requeteur).toHaveBeenCalledTimes(2);
    expect(out[0].timeline_events_json).toEqual([
      { date: '2026-04-24', text: 'Achat', ref: 'agenda_3', href: '/agenda?tiroir=echeance%3A3' },
      { date: '2026-05-01', text: 'Facture', ref: 'doc_4', href: null, unavailable: true },
    ]);
    expect(out[1].timeline_events_json).toEqual([{ date: '2026-06-01', text: 'Révision', ref: 'agenda_9', href: null, unavailable: true }]);
    expect(out[2]).toBe(messages[2]);
  });

  it('relecture : vérification impossible → liens inchangés (jamais d’échec de l’historique)', async () => {
    const messages = [{ timeline_events_json: [{ date: null, text: 'x', ref: 'agenda_3', href: '/agenda' }] }];
    const out = await reverifierChronologiesDesMessages(messages, 7, async () => { throw new Error('KO'); });
    expect(out).toEqual(messages);
  });
});

describe('R7 — biens d’une comparaison', () => {
  const tous = [
    { id: 1, name: 'Clio', category: 'VEHICULE' }, { id: 2, name: 'Polo', category: 'VEHICULE' },
    { id: 3, name: 'Maison', category: 'IMMOBILIER' }, { id: 4, name: 'Tesla', category: 'VEHICULE' },
    { id: 5, name: 'Kangoo', category: 'VEHICULE' },
  ];
  const lecture = vi.fn(async () => tous);
  const choisir = (message: string, named: Array<{ id: number; name: string }>, extra: Record<string, unknown> = {}) =>
    biensAComparer({ message, ...extra } as never, { namedAssets: named }, lecture);

  it('famille : « mes voitures », « nos deux maisons » ; rien sinon', () => {
    expect(familleComparee('Compare mes voitures')).toEqual(['VEHICULE']);
    expect(familleComparee('compare nos deux maisons')).toEqual(['IMMOBILIER']);
    expect(familleComparee('Compare la Clio et la Polo')).toBeNull();
  });

  it('deux biens nommés : inchangé, sans lecture du compte', async () => {
    lecture.mockClear();
    expect(await choisir('Compare la Clio et la Polo', [tous[0], tous[1]])).toEqual({ kind: 'assets', assets: [tous[0], tous[1]] });
    expect(lecture).not.toHaveBeenCalled();
  });

  it('un bien nommé + le bien de la page, ou + la référence du fil', async () => {
    expect(await choisir('Compare-la avec la Polo', [{ id: 2, name: 'Polo' }], { pageContext: { assetId: '1' } }))
      .toEqual({ kind: 'assets', assets: [{ id: 2, name: 'Polo' }, { id: 1, name: 'Clio' }] });
    expect(await choisir('Compare avec la Polo', [{ id: 2, name: 'Polo' }], { reference: { type: 'asset', id: 3, method: 'pronoun' } }))
      .toEqual({ kind: 'assets', assets: [{ id: 2, name: 'Polo' }, { id: 3, name: 'Maison' }] });
  });

  it('famille de plus de 3 biens → clarification ; 2 ou 3 → comparés ; < 2 → comportement antérieur', async () => {
    const r = await choisir('Compare mes voitures', []);
    expect(r.kind).toBe('clarification');
    expect(r.kind === 'clarification' && r.clarification).toMatchObject({ reason: 'COMPARISON_TOO_MANY_ASSETS' });
    expect(r.kind === 'clarification' && r.candidates.map((c) => c.id)).toEqual([1, 2, 4, 5]);
    expect(r.kind === 'clarification' && r.clarification.question).toMatch(/Lesquels voulez-vous comparer/);
    const deux = await biensAComparer({ message: 'Compare mes voitures' } as never, { namedAssets: [] }, async () => tous.slice(0, 3));
    expect(deux).toEqual({ kind: 'assets', assets: [{ id: 1, name: 'Clio' }, { id: 2, name: 'Polo' }] });
    expect(await choisir('Compare la Clio', [{ id: 1, name: 'Clio' }])).toEqual({ kind: 'assets', assets: [{ id: 1, name: 'Clio' }] });
    expect(COMPARISON_MAX_ASSETS).toBe(3);
  });

  it('plus de 3 biens nommés → clarification (plus de troncature silencieuse)', async () => {
    const r = await choisir('Compare tout', tous.slice(0, 4));
    expect(r.kind).toBe('clarification');
  });
});

describe('R8 — sources synthétiques', () => {
  it('chronologie et échéances regroupées → agenda filtré sur leur portée', () => {
    expect(hrefAgendaSynthetique('timeline:asset_12:1')).toBe('/agenda?assetIds=12');
    expect(hrefAgendaSynthetique('upcoming_agenda:asset_12')).toBe('/agenda?assetIds=12');
    expect(hrefAgendaSynthetique('timeline:assets_3_7:2')).toBe('/agenda?assetIds=3,7');
    expect(hrefAgendaSynthetique('timeline:account:1')).toBe('/agenda');
    expect(hrefSource('upcoming_agenda:asset_5')).toBe('/agenda?assetIds=5');
  });

  it('autres sources synthétiques ou portées malformées : non ouvrables', () => {
    for (const id of ['to_process:asset_1', 'expenses:maintenance:1', 'timeline:asset_x:1', 'timeline:asset_1_2:1', 'upcoming_agenda:asset_0', 'timeline:asset_1']) {
      expect(hrefSource(id), id).toBeNull();
    }
  });

  it('résolution : action « Voir l’agenda » (OPEN_AGENDA) pour la chronologie, aucune action pour « À traiter » regroupé', () => {
    const [chrono, todo] = resolveSourcesForDisplay([
      { id: 'timeline:asset_12:1', type: 'agenda_item', title: 'Chronologie', content: 'x', relevanceScore: 1 },
      { id: 'to_process:asset_12', type: 'to_process_item', title: 'À traiter', content: 'y', relevanceScore: 1 },
    ]);
    expect(chrono.openAction).toMatchObject({ type: 'OPEN_AGENDA', href: '/agenda?assetIds=12' });
    expect(todo.openAction ?? null).toBeNull();
  });
});

describe('§19.4 — tri des sources', () => {
  const src = (id: string, type: ResolvedSource['type'], score: number, usefulDate: string | null = null): ResolvedSource =>
    ({ id, type, typeLabel: '', title: id, excerpt: '', relevanceScore: score, usefulDate, isAvailable: true });
  const claims: Claim[] = [{ claimKey: 'c', text: 't', sourceIds: ['a', 'b', 'c', 'd'], derivation: 'direct' }];
  // Même contribution partout : seuls les critères 3, 4 et 5 départagent.
  const sources = [
    src('a', 'document', 0.9, '2024-01-01'),
    src('b', 'asset_field', 0.5, null),
    src('c', 'document', 0.4, '2026-03-01'),
    src('d', 'help_entry', 0.99, '2026-09-01'),
  ];

  /** Algorithme du tag lot18 (référence de parité). */
  const lot18 = (ss: ResolvedSource[], cs: Claim[]) => {
    if (ss.length < 2 || cs.length === 0) return ss;
    const cit = new Map<string, number>();
    const p = new Set(cs[0]?.sourceIds ?? []);
    for (const c of cs) for (const id of new Set(c.sourceIds)) cit.set(id, (cit.get(id) ?? 0) + 1);
    return ss.map((s, i) => ({ s, i })).sort((a, b) => (cit.get(b.s.id) ?? 0) - (cit.get(a.s.id) ?? 0)
      || Number(p.has(b.s.id)) - Number(p.has(a.s.id)) || (b.s.relevanceScore ?? 0) - (a.s.relevanceScore ?? 0) || a.i - b.i).map((x) => x.s);
  };

  it('legacy (défaut) : ordre strictement identique au lot 18', () => {
    const jeux: Array<[ResolvedSource[], Claim[]]> = [
      [sources, claims],
      [sources, [{ claimKey: 'x', text: 't', sourceIds: ['c'], derivation: 'direct' }, { claimKey: 'y', text: 'u', sourceIds: ['c', 'a'], derivation: 'direct' }]],
      [sources, []],
      [[...sources].reverse(), claims],
    ];
    for (const [ss, cs] of jeux) expect(trierParContribution(ss, cs).map((s) => s.id)).toEqual(lot18(ss, cs).map((s) => s.id));
    expect(trierParContribution(sources, claims).map((s) => s.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('enabled : type (fiche > document > aide) puis date la plus récente, puis score', () => {
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    expect(trierParContribution(sources, claims).map((s) => s.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(RANG_TYPE_SOURCE.asset_field).toBeLessThan(RANG_TYPE_SOURCE.document);
  });

  it('enabled : entre deux échéances, l’ordre chronologique d’origine est gardé (pas de récence)', () => {
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const ech = [src('e1', 'agenda_item', 1, '2026-10-05'), src('e2', 'agenda_item', 1, '2026-10-12'), src('e3', 'agenda_item', 1, '2026-10-20')];
    const cs: Claim[] = [{ claimKey: 'l', text: 't', sourceIds: ['e1', 'e2', 'e3'], derivation: 'direct' }];
    expect(trierParContribution(ech, cs).map((s) => s.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('enabled : la contribution reste le premier critère (la récence ne passe jamais devant)', () => {
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const cs: Claim[] = [{ claimKey: 'p', text: 't', sourceIds: ['a'], derivation: 'direct' }, { claimKey: 'q', text: 'u', sourceIds: ['a', 'd'], derivation: 'direct' }];
    expect(trierParContribution(sources, cs).map((s) => s.id).slice(0, 2)).toEqual(['a', 'd']);
  });
});
