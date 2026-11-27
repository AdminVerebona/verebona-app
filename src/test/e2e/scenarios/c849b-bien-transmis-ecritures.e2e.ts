/**
 * Carte #849 (complément) — bien TRANSMIS = consultation seule stricte, sur
 * PostgreSQL réel, un échantillon par famille de chemins d'écriture :
 *
 *   C849B-01  routes : documents (sous-routes, lot), Opérations, Agenda
 *             (liens), pièces / équipements, TCO, Duo (déplacement), carte
 *             « À traiter » → 403 ASSET_READ_ONLY, rien d'écrit ; élément
 *             PARTAGÉ avec un bien en service : toujours modifiable.
 *   C849B-02  primitives : façade des Opérations (utilisateur ET T3/T4) →
 *             ASSET_READ_ONLY ; écriture d'Agenda T4 → abstention (rien créé) ;
 *             T1 / T3 : abstention (garde et règle de décision).
 *   C849B-03  réactivation : une échéance que l'utilisateur avait sortie du
 *             suivi (« information ») n'est PAS remise au suivi ; l'échéance
 *             future suivie l'est, une seule fois.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

const h = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    tryGetSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
    assertOwnership: () => undefined,
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const req = (url: string, method = 'POST', body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
});
// Contexte de route Next (paramètres de chemin en chaînes) ; typé `never` : chaque route a sa propre forme.
const ctx = (v: Record<string, number | string>) => ({ params: Promise.resolve(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))) }) as never;
const as = (acc: AccountRow) => { h.session.userId = acc.ownerUserId; h.session.currentAccountId = acc.id; };
const plusJours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

scenario('C849B', 'Bien transmis — écritures directes et indirectes refusées, abstention des traitements, réactivation (#849 complément)', ({ sql, make }) => {
  beforeEach(() => { h.session.currentAccountId = null; });

  async function base() {
    const acc = await make.account({ plan: 'premium' });
    const t = await make.asset(acc, { name: 'c849b-transmis', category: 'IMMOBILIER' });
    const y = await make.asset(acc, { name: 'c849b-actif', category: 'IMMOBILIER' });
    const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${t.id}, 'c849b-salon') RETURNING id`;
    const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${t.id}, 'c849b-chaudiere') RETURNING id`;
    const doc = await make.assetFile(acc, { assetId: t.id });
    const docPartage = await make.assetFile(acc, { assetId: t.id });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${acc.id}, ${docPartage.id}, ${y.id}, 'SECONDARY', 'USER', 'ACTIVE')`;
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const op = await withBusinessOperationWrite(acc.id, async (repo) => (await repo.create({
      type: { code: 'INTERVENTION' } as never, status: 'REALIZED', realizedDate: '2026-01-05', technicalLabel: 'c849b-op',
      source: { kind: 'DOCUMENT', entityKey: doc.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: t.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_C849B',
    })).id);
    const item = await make.agendaItem(acc, { title: 'c849b-rdv', startDate: plusJours(4), assetIds: [t.id] });
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${t.id}`;
    return { acc, t, y, piece: piece.id, equip: equip.id, doc, docPartage, op: Number(op), item };
  }
  const empreinte = async (accountId: number) => (await sql<Json[]>`
    SELECT (SELECT count(*)::int FROM asset_files WHERE account_id = ${accountId}) AS f,
           (SELECT count(*)::int FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE a.account_id = ${accountId}) AS e,
           (SELECT count(*)::int FROM agenda_items WHERE account_id = ${accountId}) AS ag,
           (SELECT count(*)::int FROM business_operation_history WHERE account_id = ${accountId}) AS oh,
           (SELECT count(*)::int FROM document_asset_links WHERE account_id = ${accountId} AND status = 'ACTIVE') AS l,
           (SELECT string_agg(coalesce(retained_title, '') || '|' || coalesce(analysis_state, ''), ',' ORDER BY id) FROM asset_files WHERE account_id = ${accountId}) AS t`)[0];

  it('C849B-01 — routes : chaque famille refuse l’écriture sur un bien transmis ; l’élément partagé reste modifiable', async () => {
    const b = await base();
    as(b.acc);
    const avant = await empreinte(b.acc.id);
    const attendre403 = async (nom: string, p: Promise<Response>) => {
      const r = await p;
      expect(r.status, nom).toBe(403);
      expect((await r.json()).code, nom).toBe('ASSET_READ_ONLY');
    };
    await attendre403('document : relance d’analyse', (await import('@/app/api/documents/[id]/reset-analysis/route')).POST(req(`/api/documents/${b.doc.id}/reset-analysis`), ctx({ id: b.doc.id })));
    await attendre403('document : déplacement en lot vers un bien transmis', (await import('@/app/api/documents/bulk-move/route')).POST(req('/api/documents/bulk-move', 'POST', { documentIds: [b.docPartage.id], targetAssetId: b.t.id })));
    await attendre403('opération : notes', (await import('@/app/api/evenements-reference/[id]/notes/route')).PUT(req(`/api/evenements-reference/${b.op}/notes`, 'PUT', { notes: 'x' }), ctx({ id: b.op })));
    await attendre403('agenda : liens', (await import('@/app/api/agenda/[id]/liens/route')).POST(req(`/api/agenda/${b.item.id}/liens`, 'POST', { action: 'ATTACH', targetId: b.op }), ctx({ id: b.item.id })));
    await attendre403('pièce : équipement ajouté', (await import('@/app/api/substructures/[id]/equipments/route')).POST(req(`/api/substructures/${b.piece}/equipments`, 'POST', { name: 'Radiateur' }), ctx({ id: b.piece })));
    await attendre403('équipement : rapprochement', (await import('@/app/api/equipments/[id]/auto-link/route')).POST(req(`/api/equipments/${b.equip}/auto-link`, 'POST', {}), ctx({ id: b.equip })));
    await attendre403('TCO : décision', (await import('@/app/api/assets/[id]/tco/decisions/route')).POST(req(`/api/assets/${b.t.id}/tco/decisions`, 'POST', {}), ctx({ id: b.t.id })));
    await attendre403('Duo : déplacement', (await import('@/app/api/assets/[id]/move-to-space/route')).POST(req(`/api/assets/${b.t.id}/move-to-space`, 'POST', {}), ctx({ id: b.t.id })));
    const [carte] = await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, rule_code, action_kind, priority, question, proposals_json)
      VALUES (${b.acc.id}, 'ASSET', ${b.t.id}, 'status', 'ASSET-STATUS', 'ARBITRATE', 'CAN_WAIT', 'c849b ?', '[]'::jsonb) RETURNING public_id::text AS public_id`;
    await attendre403('À traiter : résolution', (await import('@/app/api/v2/to-process/[publicId]/resolve/route')).POST(req(`/api/v2/to-process/${carte.public_id}/resolve`, 'POST', { value: 'EN_SERVICE' }), ctx({ publicId: carte.public_id })));
    expect(await empreinte(b.acc.id), 'rien d’écrit').toEqual(avant);
    // Document PARTAGÉ avec un bien en service : la garde ne le bloque pas (la route applique ses propres règles).
    const { refuserSiDocumentDeBienTransmis, estEnLectureSeule } = await import('@/lib/asset-read-only-guard');
    expect(await refuserSiDocumentDeBienTransmis(b.docPartage.id, b.acc.id)).toBeNull();
    expect(await estEnLectureSeule(b.acc.id, { kind: 'document', id: b.doc.id })).toBe(true);
    // Autre compte : jamais « en lecture seule » par la garde (la route répond 404 elle-même).
    const autre = await make.account({ plan: 'premium' });
    expect(await estEnLectureSeule(autre.id, { kind: 'document', id: b.doc.id })).toBe(false);
  });

  it('C849B-02 — primitives : façade des Opérations (utilisateur, T3), Agenda T4, T1 et T3 s’abstiennent', async () => {
    const b = await base();
    const facade = await import('@/services/business-operations/operation-write.facade');
    const versions = async () => (await sql<{ v: number }[]>`SELECT version AS v FROM business_operations WHERE id = ${b.op}`)[0].v;
    const v0 = await versions();
    expect(await facade.setOperationNotes({ accountId: b.acc.id, actor: { kind: 'USER', userId: b.acc.ownerUserId, channel: 'UI' } }, { operationId: b.op, notes: 'x' }))
      .toMatchObject({ status: 'FORBIDDEN', code: 'ASSET_READ_ONLY' });
    expect(await facade.linkAgendaItem({ accountId: b.acc.id, actor: { kind: 'AI', treatment: 'T4' } as never }, { operationId: b.op, agendaItemId: b.item.id }))
      .toMatchObject({ code: 'ASSET_READ_ONLY' });
    expect(await facade.invalidateOperation({ accountId: b.acc.id, actor: { kind: 'SYSTEM', reason: 'e2e' } }, { operationId: b.op }))
      .toMatchObject({ code: 'ASSET_READ_ONLY' });
    expect(await versions()).toBe(v0);

    // Agenda T4 (document) : création visant le seul bien transmis → abstention, rien créé.
    const { writeAgendaItem } = await import('@/services/agenda/write-agenda-item');
    const n0 = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${b.acc.id}`)[0].n;
    const w = await writeAgendaItem({ values: { title: 'T4 c849b', startDate: plusJours(10), isAutomatic: true } as never, links: { assetIds: [b.t.id] } },
      { accountId: b.acc.id, channel: 'T4', notify: false, statusProposal: false } as never);
    expect(w).toMatchObject({ created: false, protected: true });
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${b.acc.id}`)[0].n).toBe(n0);
    // Le même élément sur un bien EN SERVICE est créé (aucune régression).
    const ok = await writeAgendaItem({ values: { title: 'T4 actif', startDate: plusJours(10), isAutomatic: true } as never, links: { assetIds: [b.y.id] } },
      { accountId: b.acc.id, channel: 'T4', notify: false, statusProposal: false } as never);
    expect(ok.created).toBe(true);

    // T1 : abstention journalisée (document des seuls biens transmis), pas pour un document partagé.
    const { abstentionSiLectureSeule } = await import('@/lib/asset-read-only-guard');
    expect(await abstentionSiLectureSeule(b.acc.id, { kind: 'document', id: b.doc.id }, 'T1')).toBe(true);
    expect(await abstentionSiLectureSeule(b.acc.id, { kind: 'document', id: b.docPartage.id }, 'T1')).toBe(false);
    // T3 : un candidat documentaire du seul bien transmis n'enrichit même pas une Opération existante
    // (avant #849b : rattachement M0 à l'Opération confirmée) ; la cession (acte, frais de vente) reste traitée.
    const { decideCandidate } = await import('@/services/business-operations/consolidation/matching');
    const cand = { established: true, confidence: 'certain', assetIds: [b.t.id], type: 'INTERVENTION', refs: [], dates: {}, amounts: [], hints: [] } as never;
    const statut = new Map([[b.t.id, 'TRANSMIS']]);
    const existante = { id: 77, typeCode: 'INTERVENTION', invalidated: false, assetIds: [b.t.id] } as never;
    expect(decideCandidate(cand, { operations: [existante], confirmed: new Set([77]), rejected: new Set(), assetStatus: statut } as never))
      .toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'TARGET_OUT_OF_PORTFOLIO', operationId: null });
    expect(decideCandidate(cand, { operations: [existante], confirmed: new Set([77]), rejected: new Set(), assetStatus: new Map([[b.t.id, 'EN_SERVICE']]) } as never).operationId)
      .toBe(77);
    expect(decideCandidate({ ...(cand as object), type: 'DISPOSAL' } as never, { operations: [], confirmed: new Set(), rejected: new Set(), assetStatus: statut }).outcome)
      .not.toBe('HOLD_UNRESOLVED');
  });

  it('C849B-03 — réactivation : échéance sortie du suivi par l’utilisateur jamais remise ; échéance suivie remise une seule fois', async () => {
    const b = await base();
    const suivie = b.item;
    const sortie = await make.agendaItem(b.acc, { title: 'c849b-sortie-du-suivi', startDate: plusJours(3), assetIds: [b.t.id] });
    await sql`UPDATE agenda_items SET home_category = 'action' WHERE id = ${suivie.id}`;
    // Choix de l'utilisateur AVANT la transmission : l'élément n'est plus une échéance à suivre (« information »).
    await sql`UPDATE agenda_items SET home_category = 'information' WHERE id = ${sortie.id}`;
    const { runDeadlineReminders } = await import('@/lib/notifications/scheduled/deadlines');
    const couverts = async () => new Map((await sql<{ id: number; n: number }[]>`
      SELECT agenda_item_id AS id, count(*)::int AS n FROM agenda_deadline_reminders
       WHERE account_id = ${b.acc.id} AND state <> 'cancelled' GROUP BY 1`).map((r) => [Number(r.id), Number(r.n)]));
    await runDeadlineReminders(new Date());
    expect((await couverts()).size, 'bien transmis : aucun rappel').toBe(0);
    const { reactivateAsset } = await import('@/services/assets/asset-reactivation.service');
    expect(await reactivateAsset({ accountId: b.acc.id, userId: b.acc.ownerUserId, assetId: b.t.id })).toEqual({ ok: true, alreadyActive: false });
    // Réactivation : aucun état de suivi réécrit.
    expect((await sql<{ c: string }[]>`SELECT home_category AS c FROM agenda_items WHERE id = ${sortie.id}`)[0].c).toBe('information');
    await runDeadlineReminders(new Date());
    await runDeadlineReminders(new Date());
    const apres = await couverts();
    expect(apres.get(suivie.id), 'échéance suivie remise au suivi, une fois').toBe(1);
    expect(apres.has(sortie.id), 'échéance sortie du suivi par l’utilisateur : jamais remise').toBe(false);
  });
});
