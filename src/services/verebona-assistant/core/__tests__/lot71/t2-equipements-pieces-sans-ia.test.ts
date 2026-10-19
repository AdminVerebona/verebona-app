/**
 * Lot 71 (71D) — ticket « BUG P1 — T2 : rechercher et proposer les
 * équipements et les pièces sans IA » (SRCH-ACxx).
 *
 * Parcours conversationnel (écart C / correction D) : orchestrateur RÉEL
 * (`runAssistant`) sur le harnais lot 29 — compte en mémoire, COMPTEUR
 * d'appels modèle (UNDERSTAND + ANSWER simulés). Le port `findNamedEntities`
 * applique ici les MÊMES règles que la requête SQL (compte, bien disponible,
 * équipement non archivé) et la MÊME normalisation (`isExactNameMatch`) ;
 * la requête SQL réelle est éprouvée sur PG16 (`l71d-recherche-equipements-pieces.e2e.ts`).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: { $client: { unsafe: vi.fn(async () => []) } }, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const H = await import('../lot29/harness');
const { parseSearchQuery, isExactNameMatch, runSearchPipeline } = await import('@/lib/search/match-engine');
const { isAssetAvailableForAssistant } = await import('../../asset-availability');
const { decideNamedEntity, isNamedEntityQuery, namedEntitySource, namedEntityChoiceQuestion } = await import('../../named-entity-stage');
const { construireActionIntents } = await import('../../ports');
const { resolveActions } = await import('../../action-resolver.service');
const { routeForIntent } = await import('../../intent-router.service');
const { inputDeReprise } = await import('../../clarification.service');

type Acc = ReturnType<typeof H.account>;

const LYON = { id: 10, name: 'Maison Lyon', category: 'IMMOBILIER', subtype: 'Maison' };
const ANNECY = { id: 11, name: 'Maison Annecy', category: 'IMMOBILIER', subtype: 'Maison' };
const VENDUE = { id: 12, name: 'Ancien appartement', category: 'IMMOBILIER', subtype: 'Appartement', deleted: true };
const AUTRE_COMPTE = { id: 13, accountId: 2, name: 'Maison voisine', category: 'IMMOBILIER', subtype: 'Maison' };

const ENTITES = [
  { kind: 'equipment' as const, id: 101, assetId: 10, name: 'Pompe à chaleur', type: 'HEAT_PUMP' },
  { kind: 'room' as const, id: 201, assetId: 10, name: 'Cuisine' },
  { kind: 'room' as const, id: 202, assetId: 10, name: 'Chambre parentale' },
  { kind: 'room' as const, id: 203, assetId: 10, name: 'Chambre enfant' },
  // AC07 : homonymes sur deux biens.
  { kind: 'equipment' as const, id: 102, assetId: 10, name: 'Chaudière gaz' },
  { kind: 'equipment' as const, id: 103, assetId: 11, name: 'Chaudière gaz' },
  // AC09 : archivé, bien supprimé, autre compte.
  { kind: 'equipment' as const, id: 104, assetId: 10, name: 'Adoucisseur', archived: true },
  { kind: 'equipment' as const, id: 105, assetId: 12, name: 'Climatiseur' },
  { kind: 'equipment' as const, id: 106, assetId: 13, name: 'Portail motorisé' },
  // Équipement et pièce du même nom (types mêlés).
  { kind: 'equipment' as const, id: 107, assetId: 11, name: 'Cellier' },
  { kind: 'room' as const, id: 204, assetId: 11, name: 'Cellier' },
];

function compte(): Acc {
  return H.account({ assets: [LYON, ANNECY, VENDUE, AUTRE_COMPTE], entities: ENTITES });
}

/**
 * Port `findNamedEntities` en mémoire : bornage au compte, bien disponible,
 * équipement non archivé, éligibilité `runSearchPipeline` puis exactitude
 * `isExactNameMatch` — exactement l'enchaînement de `global-search.service`.
 */
function portNominatif(acc: Acc) {
  const appels: Array<{ message: string; assetIds?: number[] | null }> = [];
  const fn = vi.fn(async (input: { accountId: number; message: string }, opts: { assetIds?: number[] | null } = {}) => {
    appels.push({ message: input.message, assetIds: opts.assetIds ?? null });
    const q = parseSearchQuery(input.message);
    const biens = acc.assets.filter((a) => (('accountId' in a ? a.accountId : acc.id) === input.accountId)
      && isAssetAvailableForAssistant({ status: null, deletedAt: 'deleted' in a && a.deleted ? new Date() : null }));
    const parBien = new Map(biens.map((a) => [a.id, a]));
    const cands = acc.entities
      .filter((e) => !e.archived && parBien.has(e.assetId) && (!opts.assetIds?.length || opts.assetIds.includes(e.assetId)))
      .map((e) => ({
        entityType: e.kind, entityId: e.id, displayName: e.name, retrievalStrategy: 'sql.token_like',
        fields: { name: e.name, ...(e.kind === 'equipment' ? { type: e.type ?? null } : {}), assetName: parBien.get(e.assetId)!.name },
        _e: e,
      }));
    const exacts = runSearchPipeline(q, cands, { requireAllTokens: true, allowSemantic: false }).results
      .filter((r) => isExactNameMatch(q, r.candidate.displayName))
      .map((r) => (r.candidate as unknown as { _e: (typeof ENTITES)[number] })._e);
    const ordre = [...exacts.filter((e) => e.kind === 'equipment'), ...exacts.filter((e) => e.kind === 'room')];
    return {
      entities: ordre.slice(0, 6).map((e) => ({ kind: e.kind, id: e.id, name: e.name, assetId: e.assetId, assetName: parBien.get(e.assetId)!.name })),
      assetHomonym: !opts.assetIds?.length && biens.some((a) => isExactNameMatch(q, a.name)),
    };
  });
  return { fn, appels };
}

function banc(acc = compte()) {
  const h = H.harness(acc);
  const port = portNominatif(acc);
  h.ports.findNamedEntities = port.fn as never;
  return { h, port };
}

describe('SRCH-AC08 — saisie nominative soumise à T2 : entité proposée SANS appel modèle', () => {
  it('SRCH-AC08 — « Pompe à chaleur » → l’équipement, sa nature et son bien parent ; zéro appel modèle', async () => {
    const { h, port } = banc();
    const r = await h.ask('Pompe à chaleur');
    expect(h.llmCalls()).toBe(0);
    expect(port.fn).toHaveBeenCalledTimes(1);
    expect(r.answer).toBe('Pompe à chaleur — Équipement · Maison Lyon.');
    expect(r.sources.map((s) => s.id)).toEqual(['equipment_101']);
    expect(r.cascade).toMatchObject({ strategy: 'named_entity.exact', answeredBy: 'structured', aiCalls: 0 });
    expect(r.route.intent).toBe('NAVIGATION_OPEN');
  });

  it('SRCH-AC03 — « pompe a chaleur » (sans accent, minuscules) → même équipement, zéro appel modèle', async () => {
    const { h } = banc();
    const r = await h.ask('pompe a chaleur');
    expect(h.llmCalls()).toBe(0);
    expect(r.sources.map((s) => s.id)).toEqual(['equipment_101']);
  });

  it('SRCH-AC02 / SRCH-AC04 — « Cuisine », « Chambre parentale » → la pièce exacte (pas « Chambre enfant »), zéro appel modèle', async () => {
    const { h } = banc();
    const cuisine = await h.ask('Cuisine');
    expect(cuisine.answer).toBe('Cuisine — Pièce · Maison Lyon.');
    expect(cuisine.sources.map((s) => s.id)).toEqual(['room_201']);
    const chambre = await h.ask('Chambre parentale');
    expect(chambre.sources.map((s) => s.id)).toEqual(['room_202']);
    expect(h.llmCalls()).toBe(0);
  });

  it('SRCH-AC07 — homonymes sur deux biens → choix demandé avec le bien parent, aucun choix arbitraire, zéro appel modèle', async () => {
    const { h } = banc();
    const r = await h.ask('Chaudière gaz');
    expect(h.llmCalls()).toBe(0);
    expect(h.saveClarification).toHaveBeenCalledTimes(1);
    expect(r.clarification?.question).toBe('Plusieurs équipements s’appellent « Chaudière gaz » : lequel voulez-vous ouvrir ?');
    expect(r.clarification?.candidates.map((c) => [c.label, c.secondaryLabel])).toEqual([
      ['Chaudière gaz', 'Maison Lyon'], ['Chaudière gaz', 'Maison Annecy'],
    ]);
    expect(r.sources).toEqual([]);
  });

  it('SRCH-AC07 — reprise après le choix : l’équipement choisi, REVALIDÉ par son nom sur son bien parent, sans modèle', async () => {
    const { h, port } = banc();
    const r = await h.ask('Chaudière gaz');
    const state = h.saveClarification.mock.calls[0][0] as Parameters<typeof inputDeReprise>[1];
    const choix = state.candidates.find((c) => c.secondaryLabel === 'Maison Annecy')!;
    const reprise = inputDeReprise({ accountId: H.ACCOUNT_ID, userId: 7, planType: 'PREMIUM', locale: 'fr-FR' } as never, state, choix);
    const suite = await h.ask(reprise.message, reprise);
    expect(r.clarification).toBeTruthy();
    expect(suite.answer).toBe('Chaudière gaz — Équipement · Maison Annecy.');
    expect(suite.sources.map((s) => s.id)).toEqual(['equipment_103']);
    expect(port.appels.at(-1)).toEqual({ message: 'Chaudière gaz', assetIds: [11] });
    expect(h.llmCalls()).toBe(0);
  });

  it('SRCH-AC07 — équipement et pièce du même nom : la liste des deux, chacun ouvrable, aucun choix fait à la place', async () => {
    const { h } = banc();
    const r = await h.ask('Cellier');
    expect(h.llmCalls()).toBe(0);
    expect(r.answer).toBe('Plusieurs éléments s’appellent « Cellier » : lequel voulez-vous ouvrir ?');
    expect(r.sources.map((s) => s.id).sort()).toEqual(['equipment_107', 'room_204']);
  });

  it('SRCH-AC09 — archivé, bien supprimé, autre compte : jamais proposés ; la cascade T2 reprend (inchangée)', async () => {
    for (const nom of ['Adoucisseur', 'Climatiseur', 'Portail motorisé']) {
      const { h, port } = banc();
      const r = await h.ask(nom);
      expect(port.fn).toHaveBeenCalledTimes(1);
      expect(r.sources.map((s) => s.id)).not.toContain('equipment_104');
      expect(r.cascade?.strategy).not.toMatch(/^named_entity/);
      // Aucune correspondance certaine → la cascade sollicite la compréhension comme avant.
      expect(h.classify).toHaveBeenCalled();
    }
  });

  it('SRCH-AC10 — terme partiellement similaire (« pompe », « chambre », « pompe à vélo ») : jamais une cible certaine', async () => {
    for (const q of ['pompe', 'chambre', 'pompe à vélo', 'chaleur']) {
      const { h } = banc();
      const r = await h.ask(q);
      expect(r.cascade?.strategy ?? '').not.toMatch(/^named_entity/);
      expect(r.sources.map((s) => s.id).filter((id) => /^(equipment|room)_/.test(id))).toEqual([]);
    }
  });

  it('SRCH-AC08 — mots génériques « équipements », « pièces » : jamais transformés en cible nommée', async () => {
    expect(isNamedEntityQuery('équipements')).toBe(false);
    expect(isNamedEntityQuery('Pièces')).toBe(false);
    expect(isNamedEntityQuery('les équipements')).toBe(false);
    expect(isNamedEntityQuery('Pompe à chaleur')).toBe(true);
    // Même si un équipement porte ce nom générique, la saisie ne le désigne pas.
    const acc = compte();
    acc.entities.push({ kind: 'equipment', id: 150, assetId: 10, name: 'Équipements' } as never);
    const { h, port } = banc(acc);
    const r = await h.ask('équipements');
    expect(port.fn).not.toHaveBeenCalled();
    expect(r.cascade?.strategy ?? '').not.toMatch(/^named_entity/);
  });

  it('SRCH-AC08 — un BIEN porte aussi exactement ce nom : aucun raccourci (pas d’arbitrage), cascade inchangée', async () => {
    const acc = compte();
    acc.entities.push({ kind: 'room', id: 260, assetId: 11, name: 'Maison Lyon' } as never);
    const { h } = banc(acc);
    const r = await h.ask('Maison Lyon');
    expect(r.cascade?.strategy ?? '').not.toMatch(/^named_entity/);
  });

  it('SRCH-AC11 — une question (pas un nom seul) suit la cascade existante : le port ne décide rien', async () => {
    const { h } = banc();
    const r = await h.ask('Quand faut-il entretenir la pompe à chaleur ?');
    expect(r.cascade?.strategy ?? '').not.toMatch(/^named_entity/);
  });
});

describe('SRCH-AC05 / SRCH-AC06 — ouverture : le TIROIR de l’entité, jamais la seule fiche du bien parent', () => {
  const access = {
    assetInAccount: async (acc: number, id: number) => acc === 1 && [10, 11].includes(id),
    documentInAccount: async () => false, agendaItemInAccount: async () => false, helpEntryPublished: async () => true,
  } as never;
  const route = routeForIntent('NAVIGATION_OPEN', 'PREMIUM', 'test');
  const input = { accountId: 1, userId: 7, planType: 'PREMIUM', message: 'Pompe à chaleur' } as never;
  const e = (kind: 'equipment' | 'room', id: number, assetId: number) => ({ kind, id, name: 'X', assetId, assetName: assetId === 10 ? 'Maison Lyon' : 'Maison Annecy' });

  it('SRCH-AC05 — équipement : « Ouvrir l’équipement » → /assets/10?tab=equipments&tiroir=equipement:101', async () => {
    const actions = await resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, [namedEntitySource(e('equipment', 101, 10))]), access });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'OPEN_ASSET', label: 'Ouvrir l’équipement', href: '/assets/10?tab=equipments&tiroir=equipement%3A101' });
  });

  it('SRCH-AC06 — pièce : « Ouvrir la pièce » → /assets/10?tab=rooms&tiroir=piece:201', async () => {
    const actions = await resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, [namedEntitySource(e('room', 201, 10))]), access });
    expect(actions[0]).toMatchObject({ label: 'Ouvrir la pièce', href: '/assets/10?tab=rooms&tiroir=piece%3A201' });
  });

  it('SRCH-AC07 — deux équipements homonymes : deux boutons distincts, précisés par leur bien', async () => {
    const actions = await resolveActions({
      accountId: 1, intent: route.intent, access: { ...(access as object), assetNames: async () => new Map([[10, 'Maison Lyon'], [11, 'Maison Annecy']]) } as never,
      actionIntents: construireActionIntents(route, input, [namedEntitySource(e('equipment', 102, 10)), namedEntitySource(e('equipment', 103, 11))]),
    });
    expect(actions.map((a) => [a.label, a.href])).toEqual([
      ['Ouvrir l’équipement · Maison Lyon', '/assets/10?tab=equipments&tiroir=equipement%3A102'],
      ['Ouvrir l’équipement · Maison Annecy', '/assets/11?tab=equipments&tiroir=equipement%3A103'],
    ]);
  });

  it('SRCH-AC09 — bien parent hors compte : aucune action', async () => {
    const actions = await resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, [namedEntitySource(e('equipment', 106, 13))]), access });
    expect(actions).toEqual([]);
  });

  it('SRCH-AC11 — non-régression : une source équipement HORS recherche nominative garde « Ouvrir le bien » sur l’onglet', async () => {
    const src = { id: 'equipment_101', type: 'asset_field' as const, title: 'Pompe à chaleur', content: '', meta: { equipmentId: 101, assetId: 10 } };
    const actions = await resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, [src]), access });
    expect(actions[0]).toMatchObject({ label: 'Ouvrir le bien', href: '/assets/10?tab=equipments' });
  });

  it('SRCH-AC09 — un paramètre de tiroir invalide est ignoré (lien profond validé)', async () => {
    const actions = await resolveActions({
      accountId: 1, intent: route.intent, access,
      actionIntents: [{ type: 'OPEN_ASSET', targetId: 'asset_10', params: { tab: 'equipments', drawer: 'document:5' } }],
    });
    expect(actions[0]).toMatchObject({ label: 'Ouvrir le bien', href: '/assets/10?tab=equipments' });
  });
});

describe('SRCH-AC08 — décision pure (`named-entity-stage`)', () => {
  const pac = { kind: 'equipment' as const, id: 1, name: 'Pompe à chaleur', assetId: 10, assetName: 'Maison Lyon' };
  it('unique → single ; plusieurs → choice ; aucune → none ; homonyme bien → none ; reprise revalidée', () => {
    expect(decideNamedEntity(null)).toEqual({ kind: 'none', reason: 'NO_LOOKUP' });
    expect(decideNamedEntity({ entities: [], assetHomonym: false })).toEqual({ kind: 'none', reason: 'NO_EXACT_MATCH' });
    expect(decideNamedEntity({ entities: [pac], assetHomonym: false })).toEqual({ kind: 'single', entity: pac });
    expect(decideNamedEntity({ entities: [pac], assetHomonym: true })).toEqual({ kind: 'none', reason: 'ASSET_HOMONYM' });
    expect(decideNamedEntity({ entities: [pac, { ...pac, id: 2 }], assetHomonym: false }).kind).toBe('choice');
    expect(decideNamedEntity({ entities: [pac], assetHomonym: true }, { type: 'equipment', id: 1 })).toEqual({ kind: 'single', entity: pac });
    expect(decideNamedEntity({ entities: [pac], assetHomonym: false }, { type: 'equipment', id: 9 }).kind).toBe('none');
    expect(decideNamedEntity({ entities: [pac], assetHomonym: false }, { type: 'room', id: 1 }).kind).toBe('none');
  });
  it('question de choix : pièces au féminin', () => {
    expect(namedEntityChoiceQuestion([{ ...pac, kind: 'room', name: 'Chambre' }, { ...pac, kind: 'room', name: 'Chambre', id: 3 }]))
      .toBe('Plusieurs pièces s’appellent « Chambre » : laquelle voulez-vous ouvrir ?');
  });
});
