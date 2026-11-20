/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — travaux D,
 * ÉCRITURE : gestes de la page d'un événement de référence (CDC §14, §19, §20 ;
 * AC41, AC44, AC45, AC47, AC48, AC59 pour leur partie « page ») — sur
 * PostgreSQL 16 réel, par les chemins de PRODUCTION : vraies routes
 * `/api/evenements-reference/:id/...`, façade `operation-write.facade.ts` ;
 * seule la session est simulée. Aucune IA. Dates fixes : aucun test ne dépend
 * du jour.
 *
 *   L114OW-E01  corriger l'INTITULÉ : décision du PO n° 2 — aucune déclaration enregistrée, trace avant / après (auteur,
 *               canal) au journal ; version attendue périmée → 409, phrase claire, rien d'écrit ; saisie invalide → 400
 *   L114OW-E02  corriger les DATES et le TYPE : dates posées (jamais effacées), type du référentiel ; UNE source de
 *               protection posée (pas une par correction) ; type inconnu refusé
 *   L114OW-E03  SUPPRIMER puis ANNULER : décision du PO n° 1 — rien n'est effacé ; l'événement de l'Agenda saisi est
 *               détaché et reste à sa date ; l'annulation rend l'événement de référence SANS le rattacher de nouveau
 *   L114OW-E04  rattacher / détacher un événement de l'Agenda, un document, un fournisseur : seul le lien change
 *   L114OW-E05  associer / dissocier deux événements de référence (sans sens, orienté, type incompatible, réflexif)
 *   L114OW-E06  déplacer un document : aucun fichier copié ; document non rattaché : refus en phrase claire
 *   L114OW-E07  isolation des comptes (404, rien d'écrit), compte en lecture seule (403, rien d'écrit), candidats
 *               bornés au compte
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import { REFERENCE_EVENT_SUCCESS, REFERENCE_EVENT_WRITE_MESSAGES } from '@/lib/reference-events/reference-event-write';

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
type Methode = 'POST' | 'PATCH' | 'DELETE';
type Reponse = { status: number; body: Json };

const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L114OW', 'Opérations / Agenda CDC V2.0 — travaux D : gestes d’écriture de la page de l’événement de référence', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };

  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114ow-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      reasonCode: 'L114OW_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}) })).id;
  const fournisseur = async (c: AccountRow, name: string): Promise<number> =>
    (await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status) VALUES (${c.id}, ${c.ownerUserId}, ${name}, ${name.toLowerCase()}, 'active') RETURNING id`)[0].id;

  /** Vraie route de la page (lecture). */
  async function page(id: number): Promise<{ status: number; fiche: Json | null }> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${id}/fiche`), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, fiche: r.status === 200 ? (await r.json()).fiche as Json : null };
  }
  /** Vraies routes d'écriture. `sous` : '' (l'événement de référence lui-même) ou une sous-ressource. */
  async function ecrire(methode: Methode, id: number, sous: '' | 'restauration' | 'evenements' | 'documents' | 'fournisseurs' | 'associations', o: { body?: unknown; query?: string } = {}): Promise<Reponse> {
    const mod: Record<string, unknown> = sous === '' ? await import('@/app/api/evenements-reference/[id]/route')
      : sous === 'restauration' ? await import('@/app/api/evenements-reference/[id]/restauration/route')
      : sous === 'evenements' ? await import('@/app/api/evenements-reference/[id]/evenements/route')
      : sous === 'documents' ? await import('@/app/api/evenements-reference/[id]/documents/route')
      : sous === 'fournisseurs' ? await import('@/app/api/evenements-reference/[id]/fournisseurs/route')
      : await import('@/app/api/evenements-reference/[id]/associations/route');
    const handler = mod[methode] as ((req: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>) | undefined;
    if (!handler) throw new Error(`route ${methode} ${sous} absente`);
    const url = `http://x/api/evenements-reference/${id}${sous ? `/${sous}` : ''}${o.query ? `?${o.query}` : ''}`;
    const req = new NextRequest(url, {
      method: methode, ...(o.body !== undefined ? { body: JSON.stringify(o.body), headers: { 'content-type': 'application/json' } } : {}),
    });
    const r = await handler(req, { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, body: (await r.json()) as Json };
  }
  async function candidats(id: number, kind: string, q = ''): Promise<Reponse> {
    const route = await import('@/app/api/evenements-reference/[id]/candidats/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${id}/candidats?kind=${kind}&q=${encodeURIComponent(q)}`), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, body: (await r.json()) as Json };
  }
  /** Un refus se dit en phrase : jamais un code brut, jamais le mot interdit. */
  function phrase(r: Reponse, attendu: string): void {
    expect(r.body.message, JSON.stringify(r.body)).toBe(attendu);
    expect(r.body.message).not.toMatch(/[A-Z]{3,}_[A-Z_]+|Opération|opération/);
  }
  const journal = (compte: AccountRow, operationId: number) => sql<Json[]>`
    SELECT command, action, relation_kind, origin, channel, actor_user_id, before_json, after_json
      FROM business_operation_graph_history WHERE account_id = ${compte.id} AND operation_id = ${operationId} ORDER BY id`;
  /** Empreinte de tout ce qu'un geste REFUSÉ ne doit pas toucher. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_relations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_declarations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.operation_id, t.file_id)), '') FROM business_operation_documents t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.operation_id, t.supplier_id)), '') FROM business_operation_suppliers t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_graph_history t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  it('L114OW-E01 — corriger l’intitulé : aucune déclaration, trace avant / après au journal, version attendue, saisie invalide', async () => {
    const compte = await make.account({ plan: 'standard' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Chaudiere', realized: '2024-03-12' });
    asUser(compte);
    const v1 = (await page(id)).fiche!.version as number;

    const r = await ecrire('PATCH', id, '', { body: { expectedVersion: v1, label: '  Remplacement de   la chaudière ' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.correct });
    expect(r.body.version).toBeGreaterThan(v1);
    const fiche = (await page(id)).fiche!;
    expect(fiche).toMatchObject({ ownLabel: 'Remplacement de la chaudière', title: 'Intervention — Remplacement de la chaudière', version: r.body.version, typeCode: 'INTERVENTION' });
    expect(fiche.dates).toEqual([{ role: 'REALIZED', date: '2024-03-12' }]);
    // Décision du PO n° 2 : AUCUNE déclaration enregistrée, aucune source ajoutée ; la trace est au journal.
    expect(fiche.declarations).toEqual([]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_declarations WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_sources WHERE operation_id = ${id} AND source_kind = 'USER_DECLARATION'`).toEqual([{ n: 0 }]);
    const j = await journal(compte, id);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ command: 'correctOperation', action: 'UPDATED', relation_kind: 'OPERATION', origin: 'USER', channel: 'UI', actor_user_id: compte.ownerUserId });
    expect(j[0].before_json).toMatchObject({ label: 'Chaudiere', version: v1 });
    expect(j[0].after_json).toMatchObject({ label: 'Remplacement de la chaudière', version: r.body.version });

    // Même intitulé rejoué : rien n'est écrit, et on le dit.
    const meme = await ecrire('PATCH', id, '', { body: { expectedVersion: r.body.version, label: 'Remplacement de la chaudière' } });
    expect(meme.status).toBe(200);
    expect(meme.body).toMatchObject({ ok: true, changed: false, message: REFERENCE_EVENT_WRITE_MESSAGES.NO_CHANGE });
    expect(await journal(compte, id)).toHaveLength(1);

    // Version périmée (la page affichait l'ancienne) : 409, phrase claire, rien d'écrit.
    const avant = await empreinte(compte);
    const perime = await ecrire('PATCH', id, '', { body: { expectedVersion: v1, label: 'Autre intitulé' } });
    expect(perime.status).toBe(409);
    phrase(perime, REFERENCE_EVENT_WRITE_MESSAGES.VERSION_MISMATCH);
    expect(perime.body.details).toMatchObject({ currentVersion: r.body.version });
    // Saisies invalides : 400, phrase, rien d'écrit.
    for (const body of [{}, { label: '' }, { label: 'x'.repeat(201) }, { label: 'ok', provider: 'X' }, { dates: { realizedDate: null } }, { dates: { realizedDate: '12/03/2024' } }, { dates: { autre: '2024-01-01' } }, { expectedVersion: 'abc', label: 'ok' }]) {
      const ko = await ecrire('PATCH', id, '', { body });
      expect(ko.status, JSON.stringify(body)).toBe(400);
      phrase(ko, REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT);
    }
    expect(await empreinte(compte)).toBe(avant);
  });

  it('L114OW-E02 — corriger les dates et le type : dates posées, type du référentiel, une seule source de protection', async () => {
    const compte = await make.account({ plan: 'premium' });
    const id = await operation(compte, null, { label: 'Toiture' });
    asUser(compte);
    const { PAGE_CORRECTION_DECLARATION } = await facade();

    const r1 = await ecrire('PATCH', id, '', { body: { expectedVersion: (await page(id)).fiche!.version, typeCode: 'INTERVENTION', dates: { plannedDate: '2025-05-02', realizedDate: '2025-06-20' } } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ ok: true, changed: true });
    let fiche = (await page(id)).fiche!;
    expect(fiche).toMatchObject({ typeCode: 'INTERVENTION', title: 'Intervention — Toiture', undated: false, version: r1.body.version });
    expect(fiche.dates).toEqual([{ role: 'PLANNED', date: '2025-05-02' }, { role: 'REALIZED', date: '2025-06-20' }]);
    // Protection contre la réécriture par les analyses : UNE source de l'utilisateur, texte fixe (jamais saisi).
    // Règle remplacée (décision PO du 16/11/2026) : ce texte technique est MASQUÉ à l'utilisateur ; la page n'en
    // montre aucune déclaration, la source existe en base et au journal.
    expect(fiche.declarations).toHaveLength(0);
    expect(await sql<Json[]>`SELECT declaration_text AS t FROM business_operation_declarations WHERE operation_id = ${id} AND account_id = ${compte.id}`)
      .toEqual([{ t: PAGE_CORRECTION_DECLARATION }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_sources WHERE operation_id = ${id} AND account_id = ${compte.id} AND active AND source_kind = 'USER_DECLARATION' AND authority = 'USER'`).toEqual([{ n: 1 }]);

    // Seconde correction (date remplacée, intitulé) : pas de seconde ligne de protection ; avant / après au journal.
    const r2 = await ecrire('PATCH', id, '', { body: { expectedVersion: r1.body.version, label: 'Réfection de la toiture', dates: { realizedDate: '2025-06-27' } } });
    expect(r2.status).toBe(200);
    fiche = (await page(id)).fiche!;
    expect(fiche.dates).toEqual([{ role: 'PLANNED', date: '2025-05-02' }, { role: 'REALIZED', date: '2025-06-27' }]);
    expect(fiche.ownLabel).toBe('Réfection de la toiture');
    // Toujours une seule source de protection en base, toujours masquée à l'écran (décision PO du 16/11/2026).
    expect(fiche.declarations).toHaveLength(0);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_declarations WHERE operation_id = ${id} AND account_id = ${compte.id}`).toEqual([{ n: 1 }]);
    const j = await journal(compte, id);
    expect(j.map((x) => x.command)).toEqual(['correctOperation', 'correctOperation']);
    expect(j[1].before_json).toMatchObject({ realizedDate: '2025-06-20', label: 'Toiture', typeCode: 'INTERVENTION' });
    expect(j[1].after_json).toMatchObject({ realizedDate: '2025-06-27', label: 'Réfection de la toiture' });
    // Une reconsolidation (T3, sans IA) de cet événement de référence ne réécrit ni les dates, ni le type, ni l'intitulé corrigés.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const { reconsolidateOperation } = await import('@/services/business-operations/consolidation/consolidator');
    await withBusinessOperationWrite(compte.id, (repo, s) => reconsolidateOperation(repo, s.tx, id, '2026-11-14'));
    const apresT3 = (await page(id)).fiche!;
    expect(apresT3).toMatchObject({ typeCode: 'INTERVENTION', ownLabel: 'Réfection de la toiture' });
    expect(apresT3.dates).toEqual([{ role: 'PLANNED', date: '2025-05-02' }, { role: 'REALIZED', date: '2025-06-27' }]);
    // Aucun effet dérivé : ni événement de l'Agenda, ni rappel créé par une correction.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);

    // Type hors référentiel, date impossible : refus en phrase, rien d'écrit.
    const avant = await empreinte(compte);
    const inconnu = await ecrire('PATCH', id, '', { body: { typeCode: 'TRAVAUX' } });
    expect(inconnu.status).toBe(400);
    phrase(inconnu, REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT);
    const impossible = await ecrire('PATCH', id, '', { body: { dates: { endDate: '2025-02-30' } } });
    expect(impossible.status).toBe(422);
    phrase(impossible, REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT);
    expect(await empreinte(compte)).toBe(avant);
  });

  it('L114OW-E03 — supprimer puis annuler : rien n’est effacé, l’événement de l’Agenda détaché n’est pas rattaché de nouveau', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Ravalement' });
    const rdv = await element(compte, 'Rendez-vous façadier', '2031-04-09');
    const doc = await make.assetFile(compte, { assetId: bien.id, name: 'devis-ravalement.pdf' });
    const artisan = await fournisseur(compte, 'Façades du Rhône');
    const f = await facade();
    expect(await f.linkAgendaItem(user(compte), { operationId: id, agendaItemId: rdv })).toMatchObject({ status: 'APPLIED' });
    expect(await f.linkDocument(user(compte), { operationId: id, fileId: doc.id })).toMatchObject({ status: 'APPLIED' });
    expect(await f.linkSupplier(user(compte), { operationId: id, supplierId: artisan })).toMatchObject({ status: 'APPLIED' });
    asUser(compte);
    const fiche = (await page(id)).fiche!;
    expect(fiche.agendaItems.map((a: Json) => a.id)).toEqual([rdv]);

    // Version périmée : 409, rien d'écrit.
    const avant = await empreinte(compte);
    const perime = await ecrire('DELETE', id, '', { query: `version=${fiche.version + 7}` });
    expect(perime.status).toBe(409);
    phrase(perime, REFERENCE_EVENT_WRITE_MESSAGES.VERSION_MISMATCH);
    expect(await empreinte(compte)).toBe(avant);

    const supprime = await ecrire('DELETE', id, '', { query: `version=${fiche.version}` });
    expect(supprime.status, JSON.stringify(supprime.body)).toBe(200);
    expect(supprime.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.delete });
    // Il quitte la page (404) ; rien n'est effacé : la ligne existe (invalidation logique), l'événement de l'Agenda
    // est toujours là, à sa date, détaché ; le fichier et la fiche du fournisseur existent.
    expect((await page(id)).status).toBe(404);
    expect(await sql<Json[]>`SELECT invalidated_at IS NOT NULL AS invalide, invalidation_reason FROM business_operations WHERE id = ${id}`).toEqual([{ invalide: true, invalidation_reason: 'USER_INVALIDATED' }]);
    expect(await sql<Json[]>`SELECT title, to_char(start_date, 'YYYY-MM-DD') AS d, business_operation_id FROM agenda_items WHERE id = ${rdv}`)
      .toEqual([{ title: 'Rendez-vous façadier', d: '2031-04-09', business_operation_id: null }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE id = ${doc.id} AND deleted_at IS NULL`).toEqual([{ n: 1 }]);
    expect(await sql<Json[]>`SELECT status FROM suppliers WHERE id = ${artisan}`).toEqual([{ status: 'active' }]);
    // Supprimé : plus de correction possible, et on le dit.
    const corrige = await ecrire('PATCH', id, '', { body: { label: 'Trop tard' } });
    expect(corrige.status).toBe(409);
    phrase(corrige, REFERENCE_EVENT_WRITE_MESSAGES.OPERATION_INACTIVE);

    // Annuler (décision du PO n° 1) : il revient SANS son événement de l'Agenda ; document et fournisseur retrouvés.
    const annule = await ecrire('POST', id, 'restauration', { body: { expectedVersion: supprime.body.version } });
    expect(annule.status, JSON.stringify(annule.body)).toBe(200);
    expect(annule.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.restore });
    const revenu = (await page(id)).fiche!;
    expect(revenu).toMatchObject({ id, ownLabel: 'Ravalement', agendaItems: [] });
    expect(revenu.documents.map((d: Json) => d.fileId)).toEqual([doc.id]);
    expect(revenu.suppliers.map((s: Json) => s.id)).toEqual([artisan]);
    expect(await sql<Json[]>`SELECT business_operation_id FROM agenda_items WHERE id = ${rdv}`).toEqual([{ business_operation_id: null }]);
    // Journal : suppression (avec les événements détachés) puis annulation, par l'utilisateur.
    const j = (await journal(compte, id)).filter((x) => x.relation_kind === 'OPERATION');
    expect(j.map((x) => x.action)).toEqual(['INVALIDATED', 'RESTORED']);
    expect(j[0].before_json).toMatchObject({ agendaItemIds: [rdv] });
    expect(j.every((x) => x.actor_user_id === compte.ownerUserId && x.channel === 'UI')).toBe(true);
    // Annuler une seconde fois : rien à faire, sans erreur.
    const encore = await ecrire('POST', id, 'restauration', { body: {} });
    expect(encore.body).toMatchObject({ ok: true, changed: false, message: REFERENCE_EVENT_WRITE_MESSAGES.NO_CHANGE });
  });

  it('L114OW-E04 — rattacher / détacher un événement de l’Agenda, un document, un fournisseur : seul le lien change', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement' });
    const contrat = await operation(compte, 'CONTRACT', { label: 'Assurance habitation' });
    const autre = await operation(compte, 'INTERVENTION', { label: 'Dégât des eaux — réparation' });
    const echeance = await element(compte, 'Échéance de l’assurance', '2032-01-01');
    const doc = await make.assetFile(compte, { assetId: bien.id, name: 'attestation.pdf' });
    const assureur = await fournisseur(compte, 'Mutuelle du Centre');
    asUser(compte);

    // Événement de l'Agenda : rattaché, puis PARTAGÉ avec un second événement de référence (jamais déplacé).
    const lie = await ecrire('POST', contrat, 'evenements', { body: { agendaItemId: echeance } });
    expect(lie.status, JSON.stringify(lie.body)).toBe(200);
    expect(lie.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.linkAgenda });
    expect((await ecrire('POST', contrat, 'evenements', { body: { agendaItemId: echeance } })).body).toMatchObject({ ok: true, changed: false });
    expect((await ecrire('POST', autre, 'evenements', { body: { agendaItemId: echeance } })).body).toMatchObject({ ok: true, changed: true });
    expect((await page(contrat)).fiche!.agendaItems).toEqual([{ id: echeance, title: 'Échéance de l’assurance', date: '2032-01-01', shared: true }]);
    expect((await page(autre)).fiche!.agendaItems.map((a: Json) => a.id)).toEqual([echeance]);
    // Détaché du premier : il reste dans l'Agenda, à sa date, et rattaché au second.
    const detache = await ecrire('DELETE', contrat, 'evenements', { query: `agendaItemId=${echeance}` });
    expect(detache.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.unlinkAgenda });
    expect((await page(contrat)).fiche!.agendaItems).toEqual([]);
    expect((await page(autre)).fiche!.agendaItems.map((a: Json) => a.id)).toEqual([echeance]);
    expect(await sql<Json[]>`SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE id = ${echeance}`).toEqual([{ d: '2032-01-01' }]);
    expect((await ecrire('DELETE', contrat, 'evenements', { query: `agendaItemId=${echeance}` })).body).toMatchObject({ ok: true, changed: false });

    // Document : rattaché puis retiré — le fichier reste.
    expect((await ecrire('POST', contrat, 'documents', { body: { fileId: doc.id } })).body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.linkDocument });
    expect((await page(contrat)).fiche!.documents.map((d: Json) => d.fileId)).toEqual([doc.id]);
    expect((await ecrire('DELETE', contrat, 'documents', { query: `fileId=${doc.id}` })).body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.unlinkDocument });
    expect((await page(contrat)).fiche!.documents).toEqual([]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE id = ${doc.id} AND deleted_at IS NULL`).toEqual([{ n: 1 }]);

    // Fournisseur : relié puis retiré — sa fiche reste.
    expect((await ecrire('POST', contrat, 'fournisseurs', { body: { supplierId: assureur } })).body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.linkSupplier });
    expect((await page(contrat)).fiche!.suppliers).toEqual([{ id: assureur, name: 'Mutuelle du Centre' }]);
    expect((await ecrire('DELETE', contrat, 'fournisseurs', { query: `supplierId=${assureur}` })).body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.unlinkSupplier });
    expect((await page(contrat)).fiche!.suppliers).toEqual([]);
    expect(await sql<Json[]>`SELECT status FROM suppliers WHERE id = ${assureur}`).toEqual([{ status: 'active' }]);

    // Identifiants absents ou illisibles : 400 en phrase. Objet inconnu : 404 en phrase.
    for (const [m, sous, o] of [['POST', 'evenements', { body: {} }], ['DELETE', 'evenements', { query: 'agendaItemId=abc' }], ['POST', 'documents', { body: { fileId: -1 } }], ['DELETE', 'fournisseurs', {}]] as const) {
      const ko = await ecrire(m, contrat, sous, o);
      expect(ko.status, `${m} ${sous}`).toBe(400);
      phrase(ko, REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT);
    }
    const inconnu = await ecrire('POST', contrat, 'evenements', { body: { agendaItemId: 987654321 } });
    expect(inconnu.status).toBe(404);
    phrase(inconnu, REFERENCE_EVENT_WRITE_MESSAGES.NOT_FOUND_IN_ACCOUNT);
    // Tous les gestes sont tracés par l'utilisateur, canal « écran ».
    const j = await journal(compte, contrat);
    expect(j.length).toBeGreaterThanOrEqual(6);
    expect(j.every((x) => x.origin === 'USER' && x.channel === 'UI' && x.actor_user_id === compte.ownerUserId)).toBe(true);
  });

  it('L114OW-E05 — associer / dissocier deux événements de référence : sans sens, orienté, type incompatible, réflexif', async () => {
    const compte = await make.account({ plan: 'premium' });
    const achat = await operation(compte, 'ACQUISITION', { label: 'Achat de la maison' });
    const pret = await operation(compte, 'FINANCING', { label: 'Prêt immobilier' });
    const travaux = await operation(compte, 'INTERVENTION', { label: 'Cuisine' });
    asUser(compte);

    // « Financé par » posé depuis la page de l'ACHAT (l'origine du lien est le prêt).
    const finance = await ecrire('POST', achat, 'associations', { body: { otherId: pret, nature: 'FINANCING', direction: 'INCOMING' } });
    expect(finance.status, JSON.stringify(finance.body)).toBe(200);
    expect(finance.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.associate });
    expect((await page(achat)).fiche!.relations).toEqual([{ operationId: pret, label: 'Financement — Prêt immobilier', nature: 'FINANCING', direction: 'INCOMING' }]);
    // Règle remplacée (carte #813) : un achat dont l'intitulé dit déjà « Achat … » n'est plus rendu « Achat — Achat … ».
    expect((await page(pret)).fiche!.relations).toEqual([{ operationId: achat, label: 'Achat de la maison', nature: 'FINANCING', direction: 'OUTGOING' }]);
    // « Associé à » (défaut, sans sens).
    expect((await ecrire('POST', achat, 'associations', { body: { otherId: travaux } })).body).toMatchObject({ ok: true, changed: true });
    expect((await page(travaux)).fiche!.relations).toEqual([{ operationId: achat, label: 'Achat de la maison', nature: 'ASSOCIATED', direction: 'UNDIRECTED' }]);
    // Ni fusion, ni montant : les trois événements de référence existent toujours, distincts et actifs.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`).toEqual([{ n: 3 }]);

    // Refus en phrase, rien d'écrit : lien orienté dont l'origine n'a pas le bon type ; lien avec soi-même ; demande incohérente.
    const avant = await empreinte(compte);
    const incompatible = await ecrire('POST', travaux, 'associations', { body: { otherId: pret, nature: 'FINANCING', direction: 'OUTGOING' } });
    expect(incompatible.status).toBe(422);
    phrase(incompatible, REFERENCE_EVENT_WRITE_MESSAGES.NATURE_TYPE_MISMATCH);
    const soi = await ecrire('POST', achat, 'associations', { body: { otherId: achat } });
    expect(soi.status).toBe(422);
    phrase(soi, REFERENCE_EVENT_WRITE_MESSAGES.REFLEXIVE);
    for (const body of [{}, { otherId: pret, nature: 'FUSION' }, { otherId: pret, nature: 'ASSOCIATED', direction: 'OUTGOING' }, { otherId: pret, nature: 'FINANCING', direction: 'UNDIRECTED' }]) {
      const ko = await ecrire('POST', achat, 'associations', { body });
      expect(ko.status, JSON.stringify(body)).toBe(400);
      phrase(ko, REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT);
    }
    expect(await empreinte(compte)).toBe(avant);

    // Dissocier : seul le lien change, depuis l'une ou l'autre page.
    const dissocie = await ecrire('DELETE', pret, 'associations', { query: `otherId=${achat}` });
    expect(dissocie.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.dissociate });
    expect((await page(pret)).fiche!.relations).toEqual([]);
    expect((await page(achat)).fiche!.relations.map((r: Json) => r.operationId)).toEqual([travaux]);
    expect((await ecrire('DELETE', pret, 'associations', { query: `otherId=${achat}` })).body).toMatchObject({ ok: true, changed: false });
    // L'utilisateur peut associer de nouveau ce qu'il avait dissocié (son refus se lève par son propre geste).
    expect((await ecrire('POST', pret, 'associations', { body: { otherId: achat, nature: 'FINANCING', direction: 'OUTGOING' } })).body).toMatchObject({ ok: true, changed: true });
    expect((await page(achat)).fiche!.relations.map((r: Json) => r.operationId).sort()).toEqual([pret, travaux].sort());
  });

  it('L114OW-E06 — déplacer un document vers un autre événement de référence : aucun fichier copié ; document non rattaché refusé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const origine = await operation(compte, 'INTERVENTION', { label: 'Salle de bain' });
    const cible = await operation(compte, 'INTERVENTION', { label: 'Cuisine' });
    const facture = await make.assetFile(compte, { assetId: bien.id, name: 'facture-cuisiniste.pdf' });
    const autreDoc = await make.assetFile(compte, { assetId: bien.id, name: 'notice.pdf' });
    expect(await (await facade()).linkDocument(user(compte), { operationId: origine, fileId: facture.id })).toMatchObject({ status: 'APPLIED' });
    asUser(compte);
    const fichiers = async () => (await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id}`)[0].n as number;
    const nb = await fichiers();

    const deplace = await ecrire('PATCH', origine, 'documents', { body: { fileId: facture.id, toId: cible } });
    expect(deplace.status, JSON.stringify(deplace.body)).toBe(200);
    expect(deplace.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.moveDocument });
    expect((await page(origine)).fiche!.documents).toEqual([]);
    expect((await page(cible)).fiche!.documents.map((d: Json) => d.fileId)).toEqual([facture.id]);
    expect(await fichiers()).toBe(nb);
    expect((await journal(compte, cible)).map((x) => x.action)).toEqual(['MOVED']);

    const avant = await empreinte(compte);
    const nonLie = await ecrire('PATCH', origine, 'documents', { body: { fileId: autreDoc.id, toId: cible } });
    expect(nonLie.status).toBe(422);
    phrase(nonLie, REFERENCE_EVENT_WRITE_MESSAGES.NOT_LINKED);
    const versSoi = await ecrire('PATCH', cible, 'documents', { body: { fileId: facture.id, toId: cible } });
    expect(versSoi.status).toBe(422);
    phrase(versSoi, REFERENCE_EVENT_WRITE_MESSAGES.REFLEXIVE);
    const sansCible = await ecrire('PATCH', cible, 'documents', { body: { fileId: facture.id } });
    expect(sansCible.status).toBe(400);
    expect(await empreinte(compte)).toBe(avant);
  });

  it('L114OW-E07 — isolation des comptes, compte en lecture seule, candidats bornés au compte', async () => {
    const compte = await make.account({ plan: 'premium' });
    const etranger = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Portail' });
    const voisin = await operation(compte, 'INTERVENTION', { label: 'Clôture' });
    const rdv = await element(compte, 'Pose du portail', '2030-09-01');
    const doc = await make.assetFile(compte, { assetId: bien.id, name: 'devis-portail.pdf' });
    const artisan = await fournisseur(compte, 'Serrurerie Martin');
    const bienEtranger = await make.asset(etranger, { category: 'IMMOBILIER', name: 'Studio' });
    const opEtrangere = await operation(etranger, 'INTERVENTION', { label: 'Portail du studio' });
    const rdvEtranger = await element(etranger, 'Pose du portail du studio', '2030-09-02');
    const docEtranger = await make.assetFile(etranger, { assetId: bienEtranger.id, name: 'devis-portail-studio.pdf' });
    const artisanEtranger = await fournisseur(etranger, 'Serrurerie du Sud');
    const version = async () => (await sql<Json[]>`SELECT version FROM business_operations WHERE id = ${id}`)[0].version as number;

    const gestes: Array<[Methode, Parameters<typeof ecrire>[2], { body?: unknown; query?: string }]> = [
      ['PATCH', '', { body: { label: 'Piraté' } }],
      ['DELETE', '', {}],
      ['POST', 'restauration', { body: {} }],
      ['POST', 'evenements', { body: { agendaItemId: rdv } }],
      ['DELETE', 'evenements', { query: `agendaItemId=${rdv}` }],
      ['POST', 'documents', { body: { fileId: doc.id } }],
      ['DELETE', 'documents', { query: `fileId=${doc.id}` }],
      ['PATCH', 'documents', { body: { fileId: doc.id, toId: voisin } }],
      ['POST', 'fournisseurs', { body: { supplierId: artisan } }],
      ['DELETE', 'fournisseurs', { query: `supplierId=${artisan}` }],
      ['POST', 'associations', { body: { otherId: voisin } }],
      ['DELETE', 'associations', { query: `otherId=${voisin}` }],
    ];

    // 1. Session d'un AUTRE compte : l'événement de référence n'existe pas (404, jamais 403) ; rien n'est écrit.
    const avant = await empreinte(compte);
    const avantEtranger = await empreinte(etranger);
    asUser(etranger);
    for (const [m, sous, o] of gestes) {
      const r = await ecrire(m, id, sous, o);
      expect(r.status, `${m} ${sous} depuis un autre compte`).toBe(404);
      phrase(r, REFERENCE_EVENT_WRITE_MESSAGES.NOT_FOUND_IN_ACCOUNT);
    }
    expect((await candidats(id, 'agenda')).status).toBe(404);
    expect(await empreinte(compte)).toBe(avant);
    expect(await empreinte(etranger)).toBe(avantEtranger);

    // 2. Bon compte, mais objets d'un AUTRE compte : « introuvable », sans distinction ; rien n'est écrit, d'aucun côté.
    asUser(compte);
    for (const [m, sous, o] of [
      ['POST', 'evenements', { body: { agendaItemId: rdvEtranger } }],
      ['POST', 'documents', { body: { fileId: docEtranger.id } }],
      ['POST', 'fournisseurs', { body: { supplierId: artisanEtranger } }],
      ['POST', 'associations', { body: { otherId: opEtrangere } }],
      ['DELETE', 'associations', { query: `otherId=${opEtrangere}` }],
      ['PATCH', 'documents', { body: { fileId: doc.id, toId: opEtrangere } }],
    ] as const) {
      const r = await ecrire(m, id, sous, o);
      expect(r.status, `${m} ${sous} vers un objet d'un autre compte`).toBe(404);
      phrase(r, REFERENCE_EVENT_WRITE_MESSAGES.NOT_FOUND_IN_ACCOUNT);
    }
    expect(await empreinte(compte)).toBe(avant);
    expect(await empreinte(etranger)).toBe(avantEtranger);

    // 3. Candidats : seulement les objets du compte, pas encore reliés ; filtre par texte ; types du référentiel.
    const agenda = await candidats(id, 'agenda');
    expect(agenda.status).toBe(200);
    expect(agenda.body).toEqual({ items: [{ id: rdv, title: 'Pose du portail', date: '2030-09-01', typeCode: null }], more: false });
    expect((await candidats(id, 'document')).body.items.map((x: Json) => x.id)).toEqual([doc.id]);
    expect((await candidats(id, 'supplier')).body.items).toEqual([{ id: artisan, title: 'Serrurerie Martin', date: null, typeCode: null }]);
    expect((await candidats(id, 'reference')).body.items).toEqual([{ id: voisin, title: 'Intervention — Clôture', date: null, typeCode: 'INTERVENTION' }]);
    expect((await candidats(id, 'reference', 'cloture')).body.items.map((x: Json) => x.id)).toEqual([voisin]);
    expect((await candidats(id, 'reference', 'studio')).body.items).toEqual([]);
    expect((await candidats(id, 'agenda', '100%_')).body.items).toEqual([]);
    expect((await candidats(id, 'inconnu')).status).toBe(400);
    const types = await candidats(id, 'type');
    expect(types.body.types.map((t: Json) => t.code)).toEqual(['ACQUISITION', 'INTERVENTION', 'CONTRACT', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER']);
    expect(JSON.stringify(types.body)).not.toMatch(/Opération|opération/);
    // Une fois reliés, ils ne sont plus proposés ; associés, l'autre événement de référence reste une cible de déplacement.
    expect((await ecrire('POST', id, 'evenements', { body: { agendaItemId: rdv } })).status).toBe(200);
    expect((await ecrire('POST', id, 'associations', { body: { otherId: voisin } })).status).toBe(200);
    expect((await candidats(id, 'agenda')).body.items).toEqual([]);
    expect((await candidats(id, 'reference')).body.items).toEqual([]);
    expect((await candidats(id, 'move-target')).body.items.map((x: Json) => x.id)).toEqual([voisin]);
    // La lecture des candidats n'écrit rien.
    const apresLiens = await empreinte(compte);
    await candidats(id, 'document', 'devis');
    expect(await empreinte(compte)).toBe(apresLiens);

    // 4. Compte en LECTURE SEULE (abonnement retiré) : chaque route d'écriture refuse (403), rien n'est écrit ; la
    //    lecture (page, candidats) reste permise.
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${compte.id}`;
    const v = await version();
    for (const [m, sous, o] of gestes) {
      const r = await ecrire(m, id, sous, o);
      expect(r.status, `${m} ${sous} en lecture seule`).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/Opération|opération/);
    }
    expect(await empreinte(compte)).toBe(apresLiens);
    expect(await version()).toBe(v);
    expect((await page(id)).status).toBe(200);
    expect((await candidats(id, 'document')).status).toBe(200);
  });
});
