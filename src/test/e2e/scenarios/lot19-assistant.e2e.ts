/**
 * Lot 19, volet C — reliquats de l'assistant, de bout en bout sur PostgreSQL :
 *
 *   · R1 : la chronologie d'une réponse est PERSISTÉE (0228), relue par la
 *     vraie route `GET /api/verebona/conversation` (session simulée), et ses
 *     liens sont REVÉRIFIÉS à la lecture (§19.10) : un événement supprimé ou
 *     un document passé hors compte perd son lien, la ligne reste ;
 *     en lecture `legacy`, aucune chronologie, colonne NULL ;
 *   · R7 : « Compare mes voitures » (famille) et « compare-la avec la Polo »
 *     (bien de la page) passent par le planificateur de comparaison ;
 *     plus de 3 véhicules → clarification, rien n'est comparé.
 *
 * État : commutateurs cibles (`ASSISTANT_CANONICAL_READ=enabled`…), T1 et T2
 * en architecture `master`. Sorties T2 rejouées (D-08) ; aucun réseau.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ ...session }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };

scenario('LOT19-ASSISTANT', 'Reliquats assistant : chronologie persistée, comparaison (enabled / master)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const compteDe = async (): Promise<Compte> => {
    const a = await make.account();
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = (c: Compte, name: string, category = 'VEHICULE') =>
    make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category, name });
  const evenement = async (c: Compte, assetId: number, title: string, date: string) => {
    const i = await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title, startDate: date, assetIds: [assetId] });
    await sql`UPDATE agenda_items SET event_nature = 'HISTORICAL', business_type = 'maintenance' WHERE id = ${i.id}`;
    return i.id;
  };
  /** Relecture par la route réelle (session = propriétaire du compte). */
  const relire = async (c: Compte, conversationId: number) => {
    session.userId = c.ownerUserId;
    session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/verebona/conversation/route');
    const res = await GET(new NextRequest(`http://localhost/api/verebona/conversation?conversationId=${conversationId}`));
    expect(res.status).toBe(200);
    return (await res.json()) as { messages: Array<{ role: string; timeline_events_json: Array<{ text: string; ref: string | null; href: string | null; unavailable?: boolean }> | null }> };
  };

  it('R1 (enabled) — chronologie persistée, relue par la route, liens revérifiés (supprimé / hors compte)', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const achat = await evenement(c, clio.id, 'Achat de la Clio', '2021-05-25');
    const revision = await evenement(c, clio.id, 'Révision', '2023-06-01');
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: clio.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture pneus', document_type_code = 'REPAIR_INVOICE', document_date = '2024-03-15',
              analysis_state = 'ANALYZED' WHERE id = ${f.id}`;

    const r = await demander(c, 'Historique de la Clio');
    expect(r.events?.length).toBe(3);
    expect(r.conversationId).toBeTruthy();
    const [ligne] = await sql<{ timeline_events_json: Array<{ ref: string }> | null }[]>`
      SELECT timeline_events_json FROM verebona_messages WHERE conversation_id = ${r.conversationId!} AND role = 'assistant'`;
    expect(ligne.timeline_events_json?.map((e) => e.ref)).toEqual([`agenda_${achat}`, `agenda_${revision}`, `doc_${f.id}`]);

    // Après la réponse : l'événement « Révision » est supprimé, le document passe à un autre compte.
    await sql`DELETE FROM agenda_items WHERE id = ${revision}`;
    const autre = await compteDe();
    await sql`UPDATE asset_files SET account_id = ${autre.id} WHERE id = ${f.id}`;

    const hist = await relire(c, r.conversationId!);
    const relue = hist.messages.find((m) => m.role === 'assistant')!.timeline_events_json!;
    expect(relue.map((e) => e.text)).toEqual(r.events!.map((e) => e.text));
    expect(relue[0]).toMatchObject({ ref: `agenda_${achat}`, href: expect.stringContaining('/agenda') });
    expect(relue[0].unavailable).toBeUndefined();
    expect(relue[1]).toMatchObject({ ref: `agenda_${revision}`, href: null, unavailable: true });
    expect(relue[2]).toMatchObject({ ref: `doc_${f.id}`, href: null, unavailable: true });
  });

  it('R1 (legacy) — lecture historique : aucune chronologie, colonne NULL', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    await evenement(c, clio.id, 'Achat de la Clio', '2021-05-25');
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    const r = await demander(c, 'Historique de la Clio');
    expect(r.events ?? null).toBeNull();
    const lignes = await sql<{ t: unknown }[]>`
      SELECT timeline_events_json AS t FROM verebona_messages WHERE conversation_id = ${r.conversationId!} AND role = 'assistant'`;
    expect(lignes.map((l) => l.t)).toEqual([null]);
  });

  /** Réponse de comparaison rejouée, citant les deux fiches. */
  const reponse = (ids: string[]) => rejouer([{
    operationCode: 't2_answer', task: 'ANSWER',
    output: { mode: 'ANSWER', format: 'claims', status: 'answered',
      claims: [{ text: 'Les deux véhicules sont comparés sur les mêmes dimensions.', sourceIds: ids, derivation: 'direct', factual: true }] },
  }]);

  it('R7 (enabled/master) — « Compare mes voitures » : les véhicules du compte (la maison exclue)', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    await bien(c, 'Maison', 'IMMOBILIER');
    const replay = await reponse([`asset_${clio.id}`, `asset_${polo.id}`]);
    const r = await demander(c, 'Compare mes voitures');
    expect(r.route?.intent).toBe('ACCOUNT_COMPARISON');
    expect(r.sources.filter((s) => s.type === 'asset_field').map((s) => s.id).sort()).toEqual([`asset_${clio.id}`, `asset_${polo.id}`].sort());
    expect(replay.calls.some((x) => x.task === 'ANSWER')).toBe(true);
  });

  it('R7 (enabled/master) — sur la fiche de la Clio, « compare-la avec la Polo » : bien de la page + bien nommé', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    await reponse([`asset_${clio.id}`, `asset_${polo.id}`]);
    const r = await demander(c, 'Compare-la avec la Polo', { pageContext: { assetId: String(clio.id) } });
    expect(r.route?.intent).toBe('ACCOUNT_COMPARISON');
    expect(r.sources.filter((s) => s.type === 'asset_field').map((s) => s.id).sort()).toEqual([`asset_${clio.id}`, `asset_${polo.id}`].sort());
  });

  it('R7 (enabled/master) — plus de 3 véhicules : clarification, aucune source, aucun appel modèle', async () => {
    const c = await compteDe();
    for (const n of ['Clio', 'Polo', 'Tesla', 'Kangoo']) await bien(c, n);
    const replay = await rejouer([]);
    const r = await demander(c, 'Compare mes voitures');
    expect(r.cascade?.strategy).toBe('clarification.comparison_scope');
    expect(r.answer).toMatch(/Lesquels voulez-vous comparer/);
    for (const n of ['Clio', 'Polo', 'Tesla', 'Kangoo']) expect(r.answer).toContain(n);
    expect(r.sources).toEqual([]);
    expect(replay.calls).toEqual([]);
  });
});
