/**
 * Lot 71 (71D) — ticket « BUG P1 — T2 : rechercher et proposer les
 * équipements et les pièces sans IA », de bout en bout sur PostgreSQL 16 :
 *
 *   SQL (`global-search.service` : équipements + pièces, bien parent,
 *   disponibilité unique) → éligibilité (`runSearchPipeline`) → classement →
 *   API (`GET /api/search`) → suggestion (`toLiveResults`) → ouverture du
 *   tiroir (`GET /api/equipments/[id]`, `GET /api/substructures/[id]` :
 *   revalidation) ; et parcours conversationnel (`runAssistant`, ports réels,
 *   passerelle de rejeu qui COMPTE les appels modèle).
 *
 * SRCH-AC01 à SRCH-AC12 ; mesure EXPLAIN (ANALYZE) des deux requêtes sur un
 * jeu représentatif (consignée en console : « [L71D-PERF] »).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };
type Ligne = {
  id: string; category: string; label: string; sublabel?: string; href: string; drawer?: { kind: string; id: number };
  assetId?: number; exact?: true; match: { matchedField: string; matchType: string; eligibilityDecision: string };
};
const horsT6 = <T extends { operationCode?: string | null }>(calls: T[]): T[] => calls.filter((c) => !String(c.operationCode ?? '').startsWith('t6_'));

scenario('L71D-SRCH', 'Lot 71D — équipements et pièces recherchés et proposés sans IA', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  let c: Compte;
  let autre: Compte;
  const ids: Record<string, number> = {};

  const bien = async (cpt: Compte, name: string, status = 'EN_SERVICE') => {
    const a = await make.asset({ id: cpt.id, ownerUserId: cpt.ownerUserId } as never, { category: 'IMMOBILIER', name });
    await sql`UPDATE assets SET status = ${status}, subtype = 'Maison' WHERE id = ${a.id}`;
    return a.id;
  };
  const equipement = async (assetId: number, name: string, over: { type?: string | null; archived?: boolean } = {}) => {
    const [e] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, type, archived_at) VALUES (${assetId}, ${name}, ${over.type ?? null}, ${over.archived ? sql`now()` : null}) RETURNING id`;
    return e.id;
  };
  const piece = async (assetId: number, name: string) => {
    const [x] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`;
    return x.id;
  };

  beforeAll(async () => {
    const a = await make.account({ plan: 'premium' });
    c = { id: a.id, ownerUserId: a.ownerUserId };
    ids.lyon = await bien(c, 'Maison Lyon');
    ids.annecy = await bien(c, 'Maison Annecy');
    ids.archive = await bien(c, 'Chalet archivé', 'ARCHIVED');
    ids.supprime = await bien(c, 'Studio supprimé');
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${ids.supprime}`;

    ids.pac = await equipement(ids.lyon, 'Pompe à chaleur', { type: 'HEAT_PUMP' });
    ids.cuisine = await piece(ids.lyon, 'Cuisine');
    ids.parentale = await piece(ids.lyon, 'Chambre parentale');
    ids.enfant = await piece(ids.lyon, 'Chambre enfant');
    // AC07 : homonymes sur deux biens.
    ids.chaudLyon = await equipement(ids.lyon, 'Chaudière gaz');
    ids.chaudAnnecy = await equipement(ids.annecy, 'Chaudière gaz');
    // AC09 : archivé, bien archivé, bien supprimé.
    ids.adoucisseur = await equipement(ids.lyon, 'Adoucisseur', { archived: true });
    ids.climChalet = await equipement(ids.archive, 'Climatiseur');
    ids.vmcStudio = await equipement(ids.supprime, 'VMC double flux');
    ids.saunaStudio = await piece(ids.supprime, 'Sauna');
    // AC12 : nombreux résultats proches + un document qui contient les mêmes mots.
    for (let i = 1; i <= 9; i += 1) await equipement(ids.annecy, `Pompe à chaleur ${i}`);
    for (let i = 1; i <= 4; i += 1) {
      const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: ids.lyon, name: `pac-${i}.pdf` });
      await sql`UPDATE asset_files SET retained_title = ${`Facture pompe à chaleur ${i}`}, original_filename = ${`pac-${i}.pdf`},
                upload_status = 'COMPLETED', is_draft = false WHERE id = ${f.id}`;
    }
    // AC11 : recherches existantes (bien, document, échéance).
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: ids.lyon, name: 'toiture.pdf' });
    await sql`UPDATE asset_files SET retained_title = 'Facture toiture', original_filename = 'Facture toiture.pdf', document_type = 'FACTURE',
              upload_status = 'COMPLETED', is_draft = false WHERE id = ${f.id}`;
    ids.toiture = f.id;
    ids.ramonage = (await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title: 'Ramonage', startDate: '2027-01-15', assetIds: [ids.lyon] })).id;

    // Autre compte : homonymes jamais visibles.
    const b = await make.account({ plan: 'premium' });
    autre = { id: b.id, ownerUserId: b.ownerUserId };
    ids.autreBien = await bien(autre, 'Maison voisine');
    ids.autrePac = await equipement(ids.autreBien, 'Pompe à chaleur');
    ids.autreCuisine = await piece(ids.autreBien, 'Cuisine');
    ids.autreSeul = await equipement(ids.autreBien, 'Portail motorisé');
  });

  const chercher = async (q: string, cpt: Compte = c) => {
    session.currentAccountId = cpt.id; session.userId = cpt.ownerUserId;
    const { GET } = await import('@/app/api/search/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://x/api/search?instant=1&q=${encodeURIComponent(q)}`));
    expect(res.status).toBe(200);
    return await res.json() as { results: Ligne[]; aiPowered: boolean };
  };
  const de = (r: { results: Ligne[] }, cat: string) => r.results.filter((x) => x.category === cat);
  const ouvrir = async (kind: 'equipement' | 'piece', id: number, cpt: Compte = c) => {
    session.currentAccountId = cpt.id; session.userId = cpt.ownerUserId;
    const { NextRequest } = await import('next/server');
    const ctx = { params: Promise.resolve({ id: String(id) }) };
    const route = kind === 'equipement' ? await import('@/app/api/equipments/[id]/route') : await import('@/app/api/substructures/[id]/route');
    const res = await route.GET(new NextRequest(`http://x/api/${kind === 'equipement' ? 'equipments' : 'substructures'}/${id}`), ctx as never);
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  it('SRCH-AC01-E2E — « Pompe à chaleur » : l’équipement proposé, nature et bien parent, correspondance exacte, aucun bien remonté par son équipement', async () => {
    const r = await chercher('Pompe à chaleur');
    const pac = r.results.find((x) => x.id === `equipment-${ids.pac}`)!;
    expect(pac).toMatchObject({ category: 'Équipement', label: 'Pompe à chaleur', sublabel: 'Maison Lyon', assetId: ids.lyon, exact: true, drawer: { kind: 'equipement', id: ids.pac } });
    expect(pac.match).toMatchObject({ matchedField: 'name', eligibilityDecision: 'ELIGIBLE' });
    expect(pac.href).toBe(`/assets/${ids.lyon}?tab=equipments&tiroir=equipement%3A${ids.pac}`);
    // E : un bien ne remonte pas parce qu'il possède un équipement de ce nom.
    expect(de(r, 'Bien')).toEqual([]);
    expect(r.aiPowered).toBe(false);
  });

  it('SRCH-AC02-E2E / SRCH-AC04-E2E — « Cuisine », « Chambre parentale » : la pièce exacte, prioritaire', async () => {
    const cuisine = await chercher('Cuisine');
    expect(de(cuisine, 'Pièce').map((x) => [x.label, x.sublabel, x.drawer])).toEqual([['Cuisine', 'Maison Lyon', { kind: 'piece', id: ids.cuisine }]]);
    const chambre = await chercher('Chambre parentale');
    expect(de(chambre, 'Pièce').map((x) => x.label)).toEqual(['Chambre parentale']);
    expect(de(chambre, 'Pièce')[0]).toMatchObject({ exact: true, href: `/assets/${ids.lyon}?tab=rooms&tiroir=piece%3A${ids.parentale}` });
  });

  it('SRCH-AC03-E2E — « pompe a chaleur » (sans accent) : même équipement, marqué exact', async () => {
    const r = await chercher('pompe a chaleur');
    expect(r.results.find((x) => x.id === `equipment-${ids.pac}`)).toMatchObject({ exact: true });
  });

  it('SRCH-AC05-E2E / SRCH-AC06-E2E — clic : suggestion → tiroir de l’entité, revalidé par son API (compte courant)', async () => {
    const { toLiveResults } = await import('@/lib/verebona/live-search');
    const { drawerFromHref } = await import('@/lib/drawers');
    const live = toLiveResults('Pompe à chaleur', (await chercher('Pompe à chaleur')).results as never);
    const sugg = live.find((x) => x.id === `equipment-${ids.pac}`)!;
    expect(sugg.drawer).toEqual({ kind: 'equipement', id: ids.pac });
    expect(drawerFromHref(sugg.href)).toEqual({ kind: 'equipement', id: ids.pac });
    const e = await ouvrir('equipement', ids.pac);
    expect(e.status).toBe(200);
    expect(e.body.equipment).toMatchObject({ id: ids.pac, name: 'Pompe à chaleur', assetId: ids.lyon });
    const liveP = toLiveResults('Cuisine', (await chercher('Cuisine')).results as never);
    const p = liveP.find((x) => x.kind === 'room')!;
    expect(p.drawer).toEqual({ kind: 'piece', id: ids.cuisine });
    const o = await ouvrir('piece', ids.cuisine);
    expect(o.status).toBe(200);
    expect(o.body.room).toMatchObject({ id: ids.cuisine, assetId: ids.lyon });
  });

  it('SRCH-AC07-E2E — deux équipements homonymes sur deux biens : deux résultats contextualisés', async () => {
    const r = await chercher('Chaudière gaz');
    expect(de(r, 'Équipement').map((x) => [x.id, x.sublabel]).sort()).toEqual([
      [`equipment-${ids.chaudAnnecy}`, 'Maison Annecy'], [`equipment-${ids.chaudLyon}`, 'Maison Lyon'],
    ].sort());
  });

  it('SRCH-AC09-E2E — archivé, bien archivé / supprimé, autre compte : aucun résultat ; ouverture refusée hors compte', async () => {
    for (const q of ['Adoucisseur', 'Climatiseur', 'VMC double flux', 'Sauna', 'Portail motorisé']) {
      const r = await chercher(q);
      expect(r.results.filter((x) => x.category === 'Équipement' || x.category === 'Pièce')).toEqual([]);
    }
    const r = await chercher('Pompe à chaleur');
    expect(r.results.map((x) => x.id)).not.toContain(`equipment-${ids.autrePac}`);
    expect((await chercher('Cuisine')).results.map((x) => x.id)).not.toContain(`room-${ids.autreCuisine}`);
    // Revalidation avant ouverture : l'entité d'un autre compte ne s'ouvre pas.
    expect((await ouvrir('equipement', ids.autrePac)).status).toBe(404);
    expect((await ouvrir('piece', ids.autreCuisine)).status).toBe(404);
    expect((await ouvrir('equipement', ids.adoucisseur)).status).toBe(404);
    // Et l'autre compte ne voit que les siens.
    expect(de(await chercher('Pompe à chaleur', autre), 'Équipement').map((x) => x.id)).toEqual([`equipment-${ids.autrePac}`]);
  });

  it('SRCH-AC10-E2E — termes partiellement similaires : aucun faux positif non éligible', async () => {
    expect(de(await chercher('pompe à vélo'), 'Équipement')).toEqual([]);
    expect(de(await chercher('Lyon'), 'Équipement')).toEqual([]);
    expect(de(await chercher('Lyon'), 'Pièce')).toEqual([]);
    expect(de(await chercher('HEAT_PUMP'), 'Équipement')).toEqual([]);
    expect(de(await chercher('chambre'), 'Pièce').map((x) => x.label).sort()).toEqual(['Chambre enfant', 'Chambre parentale']);
    expect(de(await chercher('chambre'), 'Pièce').some((x) => x.exact)).toBe(false);
  });

  it('SRCH-AC11-E2E — non-régression : biens, documents, échéances inchangés', async () => {
    expect(de(await chercher('Maison Lyon'), 'Bien').map((x) => x.label)).toEqual(['Maison Lyon']);
    expect(de(await chercher('toiture'), 'Document').map((x) => x.label)).toEqual(['Facture toiture']);
    expect(de(await chercher('Ramonage'), 'Agenda').map((x) => x.label)).toEqual(['Ramonage']);
  });

  it('SRCH-AC12-E2E — nombreux résultats proches : la correspondance exacte reste en tête des six suggestions', async () => {
    const { toLiveResults, LIVE_MAX_RESULTS } = await import('@/lib/verebona/live-search');
    const r = await chercher('Pompe à chaleur');
    expect(r.results.length).toBeGreaterThan(LIVE_MAX_RESULTS);
    expect(de(r, 'Équipement')[0].id).toBe(`equipment-${ids.pac}`);
    const live = toLiveResults('Pompe à chaleur', r.results as never);
    expect(live).toHaveLength(LIVE_MAX_RESULTS);
    expect(live.filter((x) => x.kind !== 'nav')[0].id).toBe(`equipment-${ids.pac}`);
  });

  it('SRCH-AC08-E2E — « Pompe à chaleur » soumis à T2 : l’équipement proposé, ZÉRO appel modèle, bouton vers son tiroir', async () => {
    const replay = await useRecordings([]);
    const r = await demander(c, 'Pompe à chaleur');
    expect(horsT6(replay.calls)).toHaveLength(0);
    expect(r.answer).toBe('Pompe à chaleur — Équipement · Maison Lyon.');
    expect(r.cascade).toMatchObject({ strategy: 'named_entity.exact', aiCalls: 0 });
    expect(r.actions.find((a) => a.type === 'OPEN_ASSET')).toMatchObject({
      label: 'Ouvrir l’équipement', href: `/assets/${ids.lyon}?tab=equipments&tiroir=equipement%3A${ids.pac}`,
    });
    for (const [q, id] of [['Cuisine', `room_${ids.cuisine}`], ['Chambre parentale', `room_${ids.parentale}`], ['pompe a chaleur', `equipment_${ids.pac}`]] as const) {
      const x = await demander(c, q);
      expect(x.sources.map((s) => s.id)).toEqual([id]);
    }
    expect(horsT6(replay.calls)).toHaveLength(0);
  });

  it('SRCH-AC07-E2E / SRCH-AC08-E2E — homonymes soumis à T2 : choix avec bien parent, puis reprise revalidée, zéro appel modèle', async () => {
    const replay = await useRecordings([]);
    const r0 = await demander(c, 'Cuisine');
    const r = await demander(c, 'Chaudière gaz', { conversationId: r0.conversationId });
    expect(horsT6(replay.calls)).toHaveLength(0);
    expect(r.answer).toBe('Plusieurs équipements s’appellent « Chaudière gaz » : lequel voulez-vous ouvrir ?');
    expect(r.clarification?.candidates.map((x) => x.secondaryLabel).sort()).toEqual(['Maison Annecy', 'Maison Lyon']);
    const { resoudreClarification } = await import('@/services/verebona-assistant/core/clarification.service');
    const { executerIssueClarification } = await import('@/services/verebona-assistant/core/clarification-flow');
    const { runAssistant } = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
    const { buildOrchestratorPorts } = await import('@/services/verebona-assistant/core/ports');
    const choix = r.clarification!.candidates.find((x) => x.secondaryLabel === 'Maison Annecy')!;
    const issue = await resoudreClarification({ accountId: c.id, userId: c.ownerUserId, conversationId: r0.conversationId, clarificationId: r.clarification!.clarificationId, choiceId: choix.id });
    expect(issue.kind).toBe('resume');
    const suite = await executerIssueClarification(issue, { accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', locale: 'fr-FR' }, { runAssistant, ports: buildOrchestratorPorts() });
    expect(suite.kind === 'result' && suite.result.answer).toBe('Chaudière gaz — Équipement · Maison Annecy.');
    expect(suite.kind === 'result' && suite.result.sources.map((s) => s.id)).toEqual([`equipment_${ids.chaudAnnecy}`]);
    expect(horsT6(replay.calls)).toHaveLength(0);
  });

  it('SRCH-AC09-E2E — T2 : archivé ou hors compte → jamais proposé par la résolution nominative', async () => {
    const { findNamedEntities } = await import('@/services/search/global-search.service');
    expect((await findNamedEntities(c.id, 'Adoucisseur')).entities).toEqual([]);
    expect((await findNamedEntities(c.id, 'Climatiseur')).entities).toEqual([]);
    expect((await findNamedEntities(c.id, 'Portail motorisé')).entities).toEqual([]);
    expect((await findNamedEntities(c.id, 'Pompe à chaleur')).entities.map((e) => e.id)).toEqual([ids.pac]);
    expect((await findNamedEntities(autre.id, 'Pompe à chaleur')).entities.map((e) => e.id)).toEqual([ids.autrePac]);
    // Aucune écriture : lecture seule (aucune ligne modifiée). Lot 73 : borné aux
    // comptes du scénario (les autres fichiers e2e écrivent en parallèle).
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE a.account_id IN (${c.id}, ${autre.id}) AND e.updated_at > now() - interval '1 second'`;
    expect(n).toBe(0);
  });

  it('SRCH-PERF-E2E — EXPLAIN (ANALYZE) sur un jeu représentatif : requêtes bornées au compte, rapides', async () => {
    // Jeu : 40 comptes × 25 biens × 12 équipements + 6 pièces (≈ 12 000 équipements, 6 000 pièces).
    for (let k = 0; k < 40; k += 1) {
      const x = await make.account({});
      await sql`
        WITH b AS (
          INSERT INTO assets (user_id, account_id, category, name)
          SELECT ${x.ownerUserId}, ${x.id}, 'IMMOBILIER', 'Bien ' || g FROM generate_series(1, 25) g RETURNING id
        ), e AS (
          INSERT INTO equipments (asset_id, name, type)
          SELECT b.id, (ARRAY['Pompe à chaleur','Chaudière gaz','Ballon thermodynamique','VMC','Climatiseur','Portail'])[1 + (g % 6)] || ' ' || g, 'TYPE'
            FROM b, generate_series(1, 12) g RETURNING 1
        )
        INSERT INTO substructures (asset_id, name)
        SELECT b.id, (ARRAY['Cuisine','Salon','Chambre parentale','Garage','Cave','Bureau'])[g] FROM b, generate_series(1, 6) g`;
    }
    await sql`ANALYZE equipments`; await sql`ANALYZE substructures`; await sql`ANALYZE assets`;
    const { pgClient } = await import('@/db');
    const captures: Array<{ text: string; params: unknown[] }> = [];
    const orig = pgClient.unsafe.bind(pgClient);
    const spy = vi.spyOn(pgClient, 'unsafe').mockImplementation(((text: string, params?: unknown[]) => {
      if (/FROM (equipments|substructures)/.test(text)) captures.push({ text, params: params ?? [] });
      return orig(text, params as never);
    }) as never);
    const t0 = performance.now();
    const { globalSearch } = await import('@/services/search/global-search.service');
    await globalSearch(c.id, 'Pompe à chaleur');
    const total = performance.now() - t0;
    spy.mockRestore();
    expect(captures.length).toBe(2);
    const plans: string[] = [];
    for (const cap of captures) {
      const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${cap.text}`, cap.params as never[]) as unknown as Array<{ 'QUERY PLAN': string }>;
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      plans.push(plan);
      const exec = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');
      expect(exec).toBeLessThan(250);
    }
    const [{ ne, ns }] = await sql<{ ne: number; ns: number }[]>`SELECT (SELECT count(*) FROM equipments)::int AS ne, (SELECT count(*) FROM substructures)::int AS ns`;
    console.info(`[L71D-PERF] globalSearch « Pompe à chaleur » complet : ${total.toFixed(1)} ms ; équipements=${ne}, pièces=${ns}\n${plans.join('\n----\n')}`);
  });
});
