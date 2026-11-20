/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — travaux D de la
 * carte « Fiche et parcours » (CDC §14, §15 ; AC01, AC22, AC41, AC56, AC59,
 * AC67) — sur PostgreSQL 16 réel, par les chemins de PRODUCTION : façade
 * `operation-write.facade.ts` (lot B), vraies routes
 * `GET /api/evenements-reference/:id/fiche` (page entière) et
 * `GET /api/search` (recherche générale) ; seule la session est simulée.
 * Aucune IA. Dates fixes : aucun test ne dépend du jour.
 *
 *   L114OD-E01  AC01, AC56 : événement de référence fondé sur une DÉCLARATION (canal Assistant), sans bien, sans
 *               document, sans événement de l'Agenda et sans date — trouvé par la recherche (catégorie propre, lien vers
 *               la page entière), page consultable, « sans date » sans date inventée ; la lecture n'écrit rien
 *   L114OD-E02  AC22, AC41 : page complète lue dans le graphe — dates propres qualifiées, bien, fournisseur,
 *               justificatif, événements chacun à SA date (un sans date, un partagé), relation financement ↔ achat lue
 *               dans les deux sens ; aucun état interne servi
 *   L114OD-E03  AC59, AC67 : isolation des comptes (404 hors compte, recherche vide), identifiant invalide (400),
 *               événement invalidé (404, absent de la recherche), ancien identifiant regroupé redirigé
 *   L114OD-E04  §15 : recherche par intitulé, nom de type, prestataire, fournisseur relié, déclaration ; tous les mots
 *               exigés ; le bien seul ne suffit pas ; les autres catégories de résultats sont inchangées
 *   L114OD-E05  décision PO n° 2 : sans intitulé, le titre est « type — bien » (page et recherche : même titre)
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const CATEGORIE = 'Opération';

const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L114OD', 'Opérations / Agenda CDC V2.0 — travaux D : page entière de l’opération et recherche', ({ sql, make }) => {
  const user = (c: AccountRow, channel: 'UI' | 'ASSISTANT' = 'UI'): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const href = (id: number) => `/agenda/evenements-reference/${id}`;

  /** Événement de référence créé par le dépôt (avec sa source), éventuellement relié à des biens. */
  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; start?: string; label?: string; provider?: string; assetIds?: number[] } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, startDate: over.start ?? null,
      technicalLabel: over.label ?? null, provider: over.provider ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114od-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      assets: (over.assetIds ?? []).map((assetId) => ({ assetId, authority: 'USER' as const })),
      reasonCode: 'L114OD_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null, assetIds: number[] = []): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds })).id;
  async function lier(compte: AccountRow, operationId: number, agendaItemId: number): Promise<void> {
    const r = await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId });
    expect(r, `lien ${operationId} ↔ ${agendaItemId}`).toMatchObject({ status: 'APPLIED' });
  }
  const fournisseur = async (c: AccountRow, name: string): Promise<number> =>
    (await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status) VALUES (${c.id}, ${c.ownerUserId}, ${name}, ${name.toLowerCase()}, 'active') RETURNING id`)[0].id;

  /** Vraie route de la page entière. */
  async function page(id: number | string): Promise<{ status: number; fiche: Json | null }> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${id}/fiche`), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, fiche: r.status === 200 ? (await r.json()).fiche as Json : null };
  }
  /** Vraie route de la recherche générale. */
  async function recherche(q: string): Promise<Json[]> {
    const route = await import('@/app/api/search/route');
    const r = await route.GET(new NextRequest(`http://x/api/search?instant=1&q=${encodeURIComponent(q)}`));
    expect(r.status).toBe(200);
    return (await r.json()).results as Json[];
  }
  const evenementsDeReference = (rows: Json[]) => rows.filter((r) => r.category === CATEGORIE);
  /** Empreinte de ce qu'une LECTURE ne doit jamais toucher. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_declarations t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_graph_history t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  it('L114OD-E01 — opération fondée sur une déclaration, sans bien, sans document, sans événement et sans date : trouvé par la recherche, page consultable', async () => {
    const compte = await make.account({ plan: 'standard' });
    const declaration = 'Je vais faire remplacer la chaudière par un artisan';
    const cree = await (await facade()).createOperation(user(compte, 'ASSISTANT'), { declaration, type: null, status: 'ENVISAGED' });
    expect(cree).toMatchObject({ status: 'APPLIED', changed: true });
    const id = (cree as Json).data.operationId as number;
    asUser(compte);
    const avant = await empreinte(compte);

    // Recherche (AC56) : résultat de type propre, lien vers la PAGE ENTIÈRE, jamais un tiroir ; « Sans date ».
    const trouves = await recherche('chaudière');
    expect(trouves).toHaveLength(1);
    expect(trouves[0]).toMatchObject({ id: `reference-event-${id}`, category: CATEGORIE, label: declaration, sublabel: 'Sans date', href: href(id) });
    expect(trouves[0].drawer).toBeUndefined();
    expect(['title', 'declaration']).toContain(trouves[0].match.matchedField);
    // Offre Standard : même accès (AC58, recherche).
    expect(evenementsDeReference(await recherche('remplacer chaudiere artisan'))).toHaveLength(1);

    // Page entière (AC01, AC22) : consultable sans rien d'autre que la déclaration ; aucune date inventée.
    const p = await page(id);
    expect(p.status).toBe(200);
    expect(p.fiche).toMatchObject({
      id, redirectedFrom: null, title: declaration, typeCode: null, ownLabel: null, provider: null,
      undated: true, dates: [], assets: [], equipments: [], suppliers: [], coverages: [], documents: [], agendaItems: [], relations: [],
    });
    expect(p.fiche!.declarations).toHaveLength(1);
    expect(p.fiche!.declarations[0]).toMatchObject({ text: declaration, channel: 'ASSISTANT', purpose: 'CREATE' });
    // Aucun état interne, jamais le mot interdit.
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(JSON.stringify(p.fiche)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|ENVISAGED|REALIZED|CANCELLED|"status"/i);

    // La lecture n'a rien écrit : aucun événement de l'Agenda fictif, aucun rappel, aucune carte.
    expect(await empreinte(compte)).toBe(avant);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);
    expect(await sql<Json[]>`SELECT planned_date, start_date, realized_date, end_date FROM business_operations WHERE id = ${id}`)
      .toEqual([{ planned_date: null, start_date: null, realized_date: null, end_date: null }]);
  });

  it('L114OD-E02 — page complète lue dans le graphe : dates qualifiées, bien, fournisseur, justificatif, événements à leur date, relation lue dans les deux sens', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison de Lyon' });
    const achat = await operation(compte, 'ACQUISITION', { realized: '2021-03-15', label: 'Achat de la maison', assetIds: [bien.id] });
    const pret = await operation(compte, 'FINANCING', { label: 'Prêt immobilier' });
    const f = await facade();
    expect(await f.associateOperations(user(compte), { fromOperationId: pret, toOperationId: achat, nature: 'FINANCING' })).toMatchObject({ status: 'APPLIED' });
    const signature = await element(compte, 'Signature chez le notaire', '2021-03-15', [bien.id]);
    const cles = await element(compte, 'Remise des clés', null, [bien.id]);
    const echeance = await element(compte, 'Fin du prêt', '2041-03-15', [bien.id]);
    await lier(compte, achat, signature);
    await lier(compte, achat, cles);
    await lier(compte, achat, echeance);
    await lier(compte, pret, echeance);
    const notaire = await fournisseur(compte, 'Étude Dupont');
    expect(await f.linkSupplier(user(compte), { operationId: achat, supplierId: notaire })).toMatchObject({ status: 'APPLIED' });
    const acte = await make.assetFile(compte, { assetId: bien.id, name: 'acte-de-vente.pdf' });
    expect(await f.linkDocument(user(compte), { operationId: achat, fileId: acte.id })).toMatchObject({ status: 'APPLIED' });
    asUser(compte);
    const avant = await empreinte(compte);

    const p = await page(achat);
    expect(p.status).toBe(200);
    const fiche = p.fiche!;
    expect(fiche).toMatchObject({
      // Règle remplacée (carte #813) : un achat dont l'intitulé dit déjà « Achat … » n'est plus rendu « Achat — Achat … ».
      id: achat, redirectedFrom: null, title: 'Achat de la maison', ownLabel: 'Achat de la maison', typeCode: 'ACQUISITION',
      undated: false, dates: [{ role: 'REALIZED', date: '2021-03-15' }],
      assets: [{ id: bien.id, name: 'Maison de Lyon' }], suppliers: [{ id: notaire, name: 'Étude Dupont' }],
    });
    expect(fiche.version).toBeGreaterThanOrEqual(1);
    expect(fiche.documents.map((d: Json) => d.fileId)).toEqual([acte.id]);
    // Événements RÉELS, chacun à SA date (2041 reste 2041) ; sans date : null, en dernier ; partagé : signalé.
    expect(fiche.agendaItems).toEqual([
      { id: signature, title: 'Signature chez le notaire', date: '2021-03-15', shared: false },
      { id: echeance, title: 'Fin du prêt', date: '2041-03-15', shared: true },
      { id: cles, title: 'Remise des clés', date: null, shared: false },
    ]);
    // Relation lue dans les deux sens à partir de la même ligne ; ni fusion, ni coût.
    expect(fiche.relations).toEqual([{ operationId: pret, label: 'Financement — Prêt immobilier', nature: 'FINANCING', direction: 'INCOMING' }]);
    const cote = (await page(pret)).fiche!;
    expect(cote).toMatchObject({ id: pret, title: 'Financement — Prêt immobilier', undated: true, dates: [], assets: [], documents: [] });
    expect(cote.relations).toEqual([{ operationId: achat, label: 'Achat de la maison', nature: 'FINANCING', direction: 'OUTGOING' }]);
    expect(cote.agendaItems).toEqual([{ id: echeance, title: 'Fin du prêt', date: '2041-03-15', shared: true }]);
    // Aucun état interne servi (« REALIZED » n'apparaît que comme RÔLE d'une date propre) ; lecture sans écriture.
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(JSON.stringify([fiche, cote])).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|ENVISAGED|CANCELLED|"status"/i);
    expect(Object.keys(fiche)).not.toContain('status');
    expect(await empreinte(compte)).toBe(avant);
  });

  it('L114OD-E03 — isolation des comptes, identifiant invalide, événement invalidé, ancien identifiant regroupé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const f = await facade();
    const cree = await f.createOperation(user(compte), { declaration: 'Ravalement de la façade prévu avec la copropriété', type: { code: 'INTERVENTION' }, status: 'ENVISAGED' });
    const id = (cree as Json).data.operationId as number;

    // Autre compte : la page n'existe pas (404, jamais 403), la recherche ne rend rien (AC59).
    asUser(autre);
    expect((await page(id)).status).toBe(404);
    expect(await recherche('ravalement')).toEqual([]);
    // Bon compte : page et recherche.
    asUser(compte);
    expect((await page(id)).status).toBe(200);
    expect(evenementsDeReference(await recherche('ravalement')).map((r) => r.href)).toEqual([href(id)]);
    // Identifiants invalides ou inconnus.
    expect((await page('abc')).status).toBe(400);
    expect((await page('0')).status).toBe(400);
    expect((await page(987654321)).status).toBe(404);

    // Ancien identifiant regroupé : la page rend l'identité courante et dit d'où elle vient ; la recherche ne rend que la courante.
    const canonique = await operation(compte, 'INTERVENTION', { label: 'Ravalement façade nord' });
    const doublon = await operation(compte, 'INTERVENTION', { label: 'Ravalement façade nord (doublon)' });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, (repo) => repo.mergeOperations(doublon, canonique, 'L114OD_E2E_MERGE'));
    const redirige = await page(doublon);
    expect(redirige.status).toBe(200);
    expect(redirige.fiche).toMatchObject({ id: canonique, redirectedFrom: doublon, title: 'Intervention — Ravalement façade nord' });
    expect(evenementsDeReference(await recherche('ravalement nord')).map((r) => r.href)).toEqual([href(canonique)]);

    // Événement de référence invalidé par l'utilisateur : plus de page, plus de résultat ; restauré : de nouveau là.
    expect(await f.invalidateOperation(user(compte), { operationId: id })).toMatchObject({ status: 'APPLIED' });
    expect((await page(id)).status).toBe(404);
    expect(evenementsDeReference(await recherche('ravalement copropriété'))).toEqual([]);
    expect(await f.restoreOperation(user(compte), { operationId: id })).toMatchObject({ status: 'APPLIED' });
    expect((await page(id)).status).toBe(200);
    expect(evenementsDeReference(await recherche('ravalement copropriété')).map((r) => r.href)).toEqual([href(id)]);
  });

  it('L114OD-E04 — recherche : intitulé, nom de type, prestataire, fournisseur relié ; tous les mots exigés ; le bien seul ne suffit pas ; autres catégories inchangées', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Nantes' });
    const contrat = await operation(compte, 'CONTRACT', { start: '2024-01-01', label: 'Assurance habitation', provider: 'Mutuelle Atlantique', assetIds: [bien.id] });
    const cabinet = await fournisseur(compte, 'Cabinet Martin');
    expect(await (await facade()).linkSupplier(user(compte), { operationId: contrat, supplierId: cabinet })).toMatchObject({ status: 'APPLIED' });
    const rappel = await element(compte, 'Assurance habitation à renouveler', '2025-01-01', [bien.id]);
    asUser(compte);
    const attendu = { id: `reference-event-${contrat}`, category: CATEGORIE, label: 'Contrat — Assurance habitation', sublabel: 'Appartement Nantes · 01/01/2024', href: href(contrat) };

    for (const q of ['assurance habitation', 'contrat', 'contrat assurance', 'atlantique', 'cabinet martin']) {
      const r = evenementsDeReference(await recherche(q));
      expect(r, q).toHaveLength(1);
      expect(r[0], q).toMatchObject(attendu);
    }
    // Chaque résultat explique sa correspondance (champ autorisé).
    expect(evenementsDeReference(await recherche('atlantique'))[0].match).toMatchObject({ matchedField: 'provider', eligibilityDecision: 'ELIGIBLE' });
    expect(evenementsDeReference(await recherche('cabinet martin'))[0].match).toMatchObject({ matchedField: 'supplierNames' });
    // Tous les mots sont exigés.
    expect(evenementsDeReference(await recherche('assurance automobile'))).toEqual([]);
    // Le bien concerné ne suffit jamais seul : le bien est trouvé, pas ses événements de référence.
    const nantes = await recherche('nantes');
    expect(evenementsDeReference(nantes)).toEqual([]);
    expect(nantes.filter((r) => r.category === 'Bien').map((r) => r.href)).toEqual([`/assets/${bien.id}`]);
    // Les autres catégories sont inchangées : l'événement de l'Agenda reste un résultat « Agenda », ouvert en tiroir.
    const tous = await recherche('assurance habitation');
    const agenda = tous.filter((r) => r.category === 'Agenda');
    expect(agenda).toHaveLength(1);
    expect(agenda[0]).toMatchObject({ id: `agenda-${rappel}`, drawer: { kind: 'echeance', id: rappel } });
    // L'événement de référence n'est confondu ni avec un document ni avec un événement de l'Agenda.
    expect(tous.filter((r) => String(r.id).startsWith('reference-event-'))).toHaveLength(1);
  });

  it('L114OD-E05 — sans intitulé, sans justificatif ni prestataire : le titre est « type — bien » (décision PO n° 2), le même sur la page et dans la recherche', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison de Lyon' });
    const avecBien = await operation(compte, 'INTERVENTION', { assetIds: [bien.id] });
    const sansRien = await operation(compte, 'INTERVENTION');
    asUser(compte);
    expect((await page(avecBien)).fiche).toMatchObject({ title: 'Intervention — Maison de Lyon', ownLabel: null, undated: true });
    expect((await page(sansRien)).fiche).toMatchObject({ title: 'Intervention', ownLabel: null, undated: true });
    const r = evenementsDeReference(await recherche('intervention lyon'));
    expect(r.map((x) => [x.label, x.href])).toEqual([['Intervention — Maison de Lyon', href(avecBien)]]);
    // Nom de type seul : les deux, l'identifiant le plus récent d'abord ou non — l'ensemble est exact.
    expect(evenementsDeReference(await recherche('intervention')).map((x) => x.href).sort()).toEqual([href(avecBien), href(sansRien)].sort());
  });
});
