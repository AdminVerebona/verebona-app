/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — SCISSION d'un
 * événement de référence (CDC §7 « Scission explicite depuis la fiche », §14
 * « Actions » ; critère AC46 ; décision du PO du 16/11/2026 « Scinder : oui,
 * maintenant ») — sur PostgreSQL 16 réel, par les chemins de PRODUCTION :
 * vraie route `POST /api/evenements-reference/:id/scission`, vraie lecture
 * `GET /api/evenements-reference/:id/fiche`, façade
 * `operation-write.facade.ts`, services de regroupement et dépôt réels. Seule
 * la session est simulée. Aucune IA. Dates fixes : aucun test ne dépend du
 * jour.
 *
 *   L114OSP-E01  scinder : un second événement de référence reçoit les faits désignés (événement de l'Agenda
 *                propre ET partagé, justificatif, fournisseur) ; les faits non désignés restent ; RIEN N'EST
 *                PERDU (aucun élément d'Agenda, aucun fichier, aucune fiche fournisseur touchés) ; type et
 *                biens repris ; les deux restent ASSOCIÉS ; journal complet des DEUX côtés
 *   L114OSP-E02  refus sans la moindre écriture : version périmée, fait désigné non rattaché, rien à déplacer,
 *                événement supprimé ; IDEMPOTENCE (même clé rejouée : aucun second événement de référence)
 *   L114OSP-E03  isolation : session d'un autre compte (404), objets d'un autre compte (404), compte en
 *                lecture seule (403) — empreinte du compte inchangée à chaque fois
 *   L114OSP-E04  mémoire de la SÉPARATION : ni T3 ni T4 ne rattachent de nouveau un fait déplacé ; l'événement
 *                scindé de TOUS ses justificatifs garde une source active ; `wasSplitApart` la rend lisible
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
type Reponse = { status: number; body: Json };

scenario('L114OSP', 'Opérations / Agenda CDC V2.0 — scinder une opération (CDC §7, §14, AC46)', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };

  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string; assetId?: number } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114osp-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, authority: 'STRUCTURED' as const }] } : {}),
      reasonCode: 'L114OSP_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}) })).id;
  const fournisseur = async (c: AccountRow, name: string): Promise<number> =>
    (await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status) VALUES (${c.id}, ${c.ownerUserId}, ${name}, ${name.toLowerCase()}, 'active') RETURNING id`)[0].id;

  /** Vraie route de lecture de la page. */
  async function page(id: number): Promise<{ status: number; fiche: Json | null }> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${id}/fiche`), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, fiche: r.status === 200 ? (await r.json()).fiche as Json : null };
  }
  /** Vraie route de la scission. */
  async function scinder(id: number, body: unknown): Promise<Reponse> {
    const route = await import('@/app/api/evenements-reference/[id]/scission/route');
    const req = new NextRequest(`http://x/api/evenements-reference/${id}/scission`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
    const r = await route.POST(req, { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, body: (await r.json()) as Json };
  }
  /** Un refus se dit en phrase : jamais un code brut, jamais le mot interdit. */
  function phrase(r: Reponse, attendu: string): void {
    expect(r.body.message, JSON.stringify(r.body)).toBe(attendu);
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(r.body.message).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|[A-Z]{3,}_[A-Z_]+/i);
  }
  const journal = (compte: AccountRow, operationId: number) => sql<Json[]>`
    SELECT command, action, relation_kind, origin, channel, actor_user_id, other_operation_id, agenda_item_id, file_id, supplier_id, before_json, after_json
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
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_sources t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_graph_history t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }
  const compteur = async (compte: AccountRow, table: 'agenda_items' | 'asset_files' | 'suppliers'): Promise<number> => {
    const [r] = table === 'agenda_items' ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`
      : table === 'asset_files' ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id} AND deleted_at IS NULL`
        : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${compte.id} AND status <> 'deleted'`;
    return r.n;
  };

  it('L114OSP-E01 — scinder : les faits désignés partent, les autres restent, rien n’est perdu, les deux restent associés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison de Tours' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Travaux de plomberie', realized: '2025-03-10', assetId: bien.id });
    const autre = await operation(compte, 'CONTRACT', { label: 'Contrat d’entretien' });
    const pose = await element(compte, 'Remplacement de la chaudière', '2025-03-10');
    const visite = await element(compte, 'Visite d’entretien du ballon', '2031-05-04');
    const facture = await make.assetFile(compte, { assetId: bien.id, name: 'facture-chaudiere.pdf' });
    const devis = await make.assetFile(compte, { assetId: bien.id, name: 'devis-ballon.pdf' });
    const plombier = await fournisseur(compte, 'Plomberie Martin');
    asUser(compte);

    // Composition de départ, par les gestes de la page : deux événements (dont un PARTAGÉ avec un autre
    // événement de référence), deux justificatifs, un fournisseur.
    const { linkAgendaItem, linkDocument, linkSupplier } = await import('@/services/business-operations/operation-write.facade');
    for (const [op, item] of [[id, pose], [autre, visite], [id, visite]] as const) {
      expect((await linkAgendaItem(user(compte), { operationId: op, agendaItemId: item })).status, `lien ${op}/${item}`).toBe('APPLIED');
    }
    for (const f of [facture.id, devis.id]) expect((await linkDocument(user(compte), { operationId: id, fileId: f })).status).toBe('APPLIED');
    expect((await linkSupplier(user(compte), { operationId: id, supplierId: plombier })).status).toBe('APPLIED');
    const elementsAvant = await compteur(compte, 'agenda_items');
    const fichiersAvant = await compteur(compte, 'asset_files');
    const fournisseursAvant = await compteur(compte, 'suppliers');
    const depart = (await page(id)).fiche!;
    expect(depart.agendaItems.map((a: Json) => a.id).sort()).toEqual([pose, visite].sort());
    expect(depart.documents.map((d: Json) => d.fileId).sort()).toEqual([facture.id, devis.id].sort());

    // Scinder : la visite du ballon (événement PARTAGÉ), le devis du ballon et le fournisseur partent.
    const r = await scinder(id, {
      expectedVersion: depart.version, label: 'Remplacement du ballon d’eau chaude',
      agendaItemIds: [visite], fileIds: [devis.id], supplierIds: [plombier],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.split });
    const nouveau = r.body.newOperationId as number;
    expect(nouveau).toBeGreaterThan(0);
    expect(nouveau).not.toBe(id);

    // Le nouvel événement de référence : intitulé donné, type et bien repris, aucune date inventée.
    const neuf = (await page(nouveau)).fiche!;
    expect(neuf).toMatchObject({ id: nouveau, ownLabel: 'Remplacement du ballon d’eau chaude', typeCode: 'INTERVENTION' });
    expect(neuf.assets.map((a: Json) => a.id)).toEqual([bien.id]);
    expect(neuf.dates).toEqual([]);
    expect(neuf.undated).toBe(true);
    // La déclaration technique de la scission n'est PAS montrée (décision du PO du 16/11/2026).
    expect(neuf.declarations).toEqual([]);
    expect(JSON.stringify(neuf)).not.toMatch(/Scission faite depuis/);

    // Ce qui part est sur le nouveau, et seulement là ; ce qui reste est sur l'événement scindé.
    expect(neuf.agendaItems.map((a: Json) => a.id)).toEqual([visite]);
    expect(neuf.documents.map((d: Json) => d.fileId)).toEqual([devis.id]);
    expect(neuf.suppliers.map((s: Json) => s.id)).toEqual([plombier]);
    const reste = (await page(id)).fiche!;
    expect(reste.agendaItems.map((a: Json) => a.id)).toEqual([pose]);
    expect(reste.documents.map((d: Json) => d.fileId)).toEqual([facture.id]);
    expect(reste.suppliers).toEqual([]);
    // L'événement de l'Agenda déplacé reste PARTAGÉ avec l'autre événement de référence (il n'a pas été volé).
    expect((await page(autre)).fiche!.agendaItems.map((a: Json) => a.id)).toEqual([visite]);
    expect(neuf.agendaItems[0].shared).toBe(true);

    // RIEN N'EST PERDU : aucun élément d'Agenda, aucun fichier, aucune fiche fournisseur n'a bougé ni disparu.
    expect(await compteur(compte, 'agenda_items')).toBe(elementsAvant);
    expect(await compteur(compte, 'asset_files')).toBe(fichiersAvant);
    expect(await compteur(compte, 'suppliers')).toBe(fournisseursAvant);
    expect(await sql<Json[]>`SELECT title, to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE id = ${visite}`)
      .toEqual([{ title: 'Visite d’entretien du ballon', d: '2031-05-04' }]);
    expect(await sql<Json[]>`SELECT status FROM suppliers WHERE id = ${plombier}`).toEqual([{ status: 'active' }]);
    // Aucun événement d'Agenda créé, aucun rappel, aucune notification.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);

    // Les deux événements de référence restent ASSOCIÉS (jamais fusionnés), lus des deux côtés.
    expect(reste.relations.map((x: Json) => ({ id: x.operationId, nature: x.nature }))).toEqual([{ id: nouveau, nature: 'ASSOCIATED' }]);
    expect(neuf.relations.map((x: Json) => ({ id: x.operationId, nature: x.nature }))).toEqual([{ id: id, nature: 'ASSOCIATED' }]);
    expect(await sql<Json[]>`SELECT state, nature, origin, reason_code FROM business_operation_relations WHERE account_id = ${compte.id}`)
      .toEqual([{ state: 'ACTIVE', nature: 'ASSOCIATED', origin: 'USER', reason_code: 'USER_SPLIT' }]);
    // Aucune composante financière, aucun montant n'a été créé par la scission (AC51).
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_financial_components WHERE operation_id = ${nouveau}`).toEqual([{ n: 0 }]);

    // JOURNAL complet des DEUX côtés : création du nouveau, déplacements, relation, trace sur l'événement scindé.
    const jNeuf = await journal(compte, nouveau);
    expect(jNeuf.every((x) => x.origin === 'USER' && x.channel === 'UI' && x.actor_user_id === compte.ownerUserId)).toBe(true);
    expect(jNeuf.filter((x) => x.relation_kind === 'OPERATION').map((x) => x.action)).toEqual(['CREATED']);
    expect(jNeuf.find((x) => x.relation_kind === 'OPERATION')!.after_json).toMatchObject({ splitFromOperationId: id, typeCode: 'INTERVENTION', label: 'Remplacement du ballon d’eau chaude' });
    expect(jNeuf.filter((x) => x.command === 'splitOperation').length).toBe(jNeuf.length);
    expect(jNeuf.some((x) => x.relation_kind === 'AGENDA_LINK' && Number(x.agenda_item_id) === visite)).toBe(true);
    expect(jNeuf.some((x) => x.relation_kind === 'DOCUMENT_LINK' && Number(x.file_id) === devis.id && x.action === 'MOVED')).toBe(true);
    expect(jNeuf.some((x) => x.relation_kind === 'SUPPLIER_LINK' && Number(x.supplier_id) === plombier)).toBe(true);
    const jScinde = (await journal(compte, id)).filter((x) => x.command === 'splitOperation');
    expect(jScinde.length).toBeGreaterThanOrEqual(3);
    const resume = jScinde.find((x) => x.relation_kind === 'OPERATION' && x.action === 'UPDATED')!;
    expect(resume.other_operation_id).toBe(String(nouveau) as unknown as number);
    expect(resume.before_json).toMatchObject({ agendaItemIds: [visite], fileIds: [devis.id], supplierIds: [plombier] });
    expect(resume.after_json).toMatchObject({ splitIntoOperationId: nouveau });
    // Retrait de l'événement de l'Agenda et du fournisseur tracé du côté de l'événement scindé.
    expect(jScinde.some((x) => x.relation_kind === 'AGENDA_LINK' && Number(x.agenda_item_id) === visite && x.action === 'REJECTED')).toBe(true);
    expect(jScinde.some((x) => x.relation_kind === 'SUPPLIER_LINK' && Number(x.supplier_id) === plombier && x.action === 'REJECTED')).toBe(true);
  });

  it('L114OSP-E02 — refus sans la moindre écriture ; même clé d’idempotence rejouée : aucun second événement', async () => {
    const compte = await make.account({ plan: 'standard' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Peinture', assetId: bien.id });
    const rdv = await element(compte, 'Passage du peintre', '2030-02-02');
    const jamais = await element(compte, 'Événement d’un autre sujet', '2030-03-03');
    asUser(compte);
    const { linkAgendaItem, splitOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await linkAgendaItem(user(compte), { operationId: id, agendaItemId: rdv })).status).toBe('APPLIED');
    const v = (await page(id)).fiche!.version as number;
    const avant = await empreinte(compte);

    // 1. Version périmée : conflit, phrase claire, rien d'écrit.
    const perimee = await scinder(id, { expectedVersion: v + 5, label: 'Autre sujet', agendaItemIds: [rdv] });
    expect(perimee.status).toBe(409);
    phrase(perimee, REFERENCE_EVENT_WRITE_MESSAGES.VERSION_MISMATCH);
    expect(await empreinte(compte)).toBe(avant);

    // 2. Fait désigné NON rattaché à cet événement de référence (fiche périmée) : conflit, rien d'écrit.
    const detache = await scinder(id, { expectedVersion: v, label: 'Autre sujet', agendaItemIds: [jamais] });
    expect(detache.status).toBe(409);
    phrase(detache, REFERENCE_EVENT_WRITE_MESSAGES.SPLIT_PART_NOT_LINKED);
    expect(await empreinte(compte)).toBe(avant);

    // 3. Rien à déplacer, ou demande illisible : 400 en phrase, rien d'écrit.
    for (const body of [{ label: 'Autre sujet' }, { label: 'Autre sujet', agendaItemIds: [] }, { agendaItemIds: [rdv], inconnu: 1 }, 'x']) {
      const ko = await scinder(id, body);
      expect(ko.status, JSON.stringify(body)).toBe(400);
      phrase(ko, REFERENCE_EVENT_WRITE_MESSAGES.INVALID_INPUT);
    }
    expect(await empreinte(compte)).toBe(avant);

    // 4. Objet inconnu du compte : « introuvable », rien d'écrit.
    const inconnu = await scinder(id, { label: 'Autre sujet', fileIds: [987654321] });
    expect(inconnu.status).toBe(404);
    phrase(inconnu, REFERENCE_EVENT_WRITE_MESSAGES.NOT_FOUND_IN_ACCOUNT);
    expect(await empreinte(compte)).toBe(avant);

    // 5. IDEMPOTENCE : la même clé rejouée rend le résultat enregistré, sans créer un second événement.
    const cle = 'split:l114osp-e02-0001';
    const entree = { operationId: id, label: 'Autre sujet', agendaItemIds: [rdv] };
    const premier = await splitOperation({ ...user(compte), idempotencyKey: cle }, entree);
    expect(premier.status, JSON.stringify(premier)).toBe('APPLIED');
    expect(premier.changed).toBe(true);
    const cree = premier.data!.newOperationId;
    const rejeu = await splitOperation({ ...user(compte), idempotencyKey: cle }, entree);
    expect(rejeu).toMatchObject({ status: 'APPLIED', changed: false, replayed: true });
    expect(rejeu.data!.newOperationId).toBe(cree);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL`)
      .toEqual([{ n: 2 }]);
    // Même clé, AUTRE entrée : conflit, rien d'écrit.
    const apres = await empreinte(compte);
    const autreEntree = await splitOperation({ ...user(compte), idempotencyKey: cle }, { operationId: id, label: 'Encore un autre', agendaItemIds: [rdv] });
    expect(autreEntree).toMatchObject({ status: 'CONFLICT', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await empreinte(compte)).toBe(apres);

    // 6. Événement de référence supprimé : il ne peut plus être scindé, et on le dit.
    const { invalidateOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await invalidateOperation(user(compte), { operationId: id })).status).toBe('APPLIED');
    const supprime = await scinder(id, { label: 'Trop tard', agendaItemIds: [rdv] });
    expect([404, 409]).toContain(supprime.status);
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(supprime.body.message).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|[A-Z]{3,}_[A-Z_]+/i);
  });

  it('L114OSP-E03 — isolation des comptes et compte en lecture seule : refus, et rien d’écrit nulle part', async () => {
    const compte = await make.account({ plan: 'premium' });
    const etranger = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const bienEtranger = await make.asset(etranger, { category: 'IMMOBILIER', name: 'Chalet' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Toiture', assetId: bien.id });
    const rdv = await element(compte, 'Pose des tuiles', '2030-09-01');
    const docEtranger = await make.assetFile(etranger, { assetId: bienEtranger.id, name: 'ailleurs.pdf' });
    const rdvEtranger = await element(etranger, 'Chez le voisin', '2030-09-02');
    asUser(compte);
    const { linkAgendaItem } = await import('@/services/business-operations/operation-write.facade');
    expect((await linkAgendaItem(user(compte), { operationId: id, agendaItemId: rdv })).status).toBe('APPLIED');
    const avant = await empreinte(compte);
    const avantEtranger = await empreinte(etranger);

    // 1. Session d'un AUTRE compte : l'événement de référence n'existe pas (404, jamais 403).
    asUser(etranger);
    const vole = await scinder(id, { label: 'Chez moi', agendaItemIds: [rdv] });
    expect(vole.status).toBe(404);
    phrase(vole, REFERENCE_EVENT_WRITE_MESSAGES.NOT_FOUND_IN_ACCOUNT);
    expect(await empreinte(compte)).toBe(avant);
    expect(await empreinte(etranger)).toBe(avantEtranger);

    // 2. Bon compte, mais faits d'un AUTRE compte : « introuvable », sans distinction.
    asUser(compte);
    for (const body of [{ label: 'Ailleurs', agendaItemIds: [rdvEtranger] }, { label: 'Ailleurs', fileIds: [docEtranger.id] }]) {
      const r = await scinder(id, body);
      expect(r.status, JSON.stringify(body)).toBe(404);
      phrase(r, REFERENCE_EVENT_WRITE_MESSAGES.NOT_FOUND_IN_ACCOUNT);
    }
    expect(await empreinte(compte)).toBe(avant);
    expect(await empreinte(etranger)).toBe(avantEtranger);

    // 3. Compte en LECTURE SEULE (abonnement retiré) : refus de la garde, rien d'écrit ; la lecture reste permise.
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${compte.id}`;
    const lectureSeule = await scinder(id, { label: 'Interdit', agendaItemIds: [rdv] });
    expect(lectureSeule.status).toBe(403);
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(JSON.stringify(lectureSeule.body)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(await empreinte(compte)).toBe(avant);
    expect((await page(id)).status).toBe(200);
  });

  it('L114OSP-E04 — la séparation est mémorisée : ni T3 ni T4 ne rattachent de nouveau, et l’événement scindé garde une source', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement' });
    const id = await operation(compte, 'INTERVENTION', { label: 'Salle de bain', assetId: bien.id });
    const rdv = await element(compte, 'Intervention du carreleur', '2029-07-07');
    const reste = await element(compte, 'Visite de contrôle', '2029-08-08');
    const doc = await make.assetFile(compte, { assetId: bien.id, name: 'devis-carrelage.pdf' });
    asUser(compte);
    const { linkAgendaItem, linkDocument, splitOperation } = await import('@/services/business-operations/operation-write.facade');
    for (const item of [rdv, reste]) expect((await linkAgendaItem(user(compte), { operationId: id, agendaItemId: item })).status).toBe('APPLIED');
    expect((await linkDocument(user(compte), { operationId: id, fileId: doc.id })).status).toBe('APPLIED');

    // Scinder : l'événement de l'Agenda et le SEUL justificatif partent.
    const r = await splitOperation(user(compte), { operationId: id, label: 'Pose du carrelage', agendaItemIds: [rdv], fileIds: [doc.id] });
    expect(r.status, JSON.stringify(r)).toBe('APPLIED');
    const nouveau = r.data!.newOperationId;

    // L'événement scindé de TOUS ses justificatifs garde une source ACTIVE (jamais une enveloppe sans preuve).
    const [sources] = await sql<Json[]>`
      SELECT count(*)::int AS n FROM business_operation_sources WHERE account_id = ${compte.id} AND operation_id = ${id} AND active`;
    expect(sources.n).toBeGreaterThan(0);
    expect(await sql<Json[]>`
      SELECT count(*)::int AS n FROM business_operation_sources
       WHERE account_id = ${compte.id} AND operation_id = ${id} AND active AND source_kind = 'USER_DECLARATION'`).toEqual([{ n: 1 }]);
    expect((await page(id)).status).toBe(200);
    // Le texte technique de la scission n'est montré d'aucun côté.
    for (const op of [id, nouveau]) expect((await page(op)).fiche!.declarations).toEqual([]);

    // MÉMOIRE DE LA SÉPARATION : une inférence (T3 / T4) ne rattache pas de nouveau le fait déplacé.
    const t3: OperationWriteContext = { accountId: compte.id, actor: { kind: 'AI', treatment: 'T3' } };
    const t4: OperationWriteContext = { accountId: compte.id, actor: { kind: 'AI', treatment: 'T4' } };
    for (const ctx of [t3, t4]) {
      const refus = await linkAgendaItem(ctx, { operationId: id, agendaItemId: rdv, evidence: [{ kind: 'AGENDA', ref: String(rdv) }] });
      expect(refus, JSON.stringify(refus)).toMatchObject({ status: 'FORBIDDEN', code: 'USER_REJECTED', changed: false });
    }
    expect((await page(id)).fiche!.agendaItems.map((a: Json) => a.id)).toEqual([reste]);
    expect((await page(nouveau)).fiche!.agendaItems.map((a: Json) => a.id)).toEqual([rdv]);
    // Le retrait du justificatif est mémorisé comme un refus de l'utilisateur sur l'événement scindé.
    expect(await sql<Json[]>`
      SELECT decision, origin FROM business_operation_match_decisions
       WHERE account_id = ${compte.id} AND candidate_operation_id = ${id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(doc.id)} AND active`)
      .toEqual([{ decision: 'REJECTED', origin: 'USER_ARBITRATION' }]);

    // La séparation est LISIBLE avant toute refusion (garde à brancher sur la fusion : non faite, voir la fiche).
    const { wasSplitApart } = await import('@/services/business-operations/graph/read');
    expect(await wasSplitApart(compte.id, id, nouveau)).toBe(true);
    expect(await wasSplitApart(compte.id, nouveau, id)).toBe(true);
    expect(await wasSplitApart(compte.id, id, id + 10000)).toBe(false);
    // Aucune fuite : un autre compte ne voit pas cette séparation.
    const etranger = await make.account({ plan: 'premium' });
    expect(await wasSplitApart(etranger.id, id, nouveau)).toBe(false);
  });
});
