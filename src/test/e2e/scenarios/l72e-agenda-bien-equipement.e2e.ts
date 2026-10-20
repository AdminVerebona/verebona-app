/**
 * Lot 72 (72E) — décision PO du 19/10/2026 : filtre « Équipement » de
 * l'onglet Agenda de la fiche d'un bien, sur PostgreSQL réel.
 *
 * Appelle la VRAIE route `GET /api/agenda` exactement comme l'onglet
 * (`assetIds=<bien>&equipmentFacet=1[&equipment=…]`), session simulée
 * seulement, puis construit le modèle d'affichage avec
 * `buildEquipmentFilterModel(facette, valeur, 1)` — ce que l'onglet affiche.
 *
 * Couvre : bien sans équipement (section masquée), options « Tous (bien et
 * équipements) », « Bien uniquement », équipements du bien (archivé
 * seulement s'il porte des éléments), filtrage par association en base,
 * combinaison avec période / annulés / vue mensuelle, isolation des comptes.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { buildEquipmentFilterModel, type EquipmentFacet } from '@/lib/filters/equipment-filter';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('L72E-EQ', 'Onglet Agenda du bien : filtre Équipement sur la vraie route', ({ sql, make }) => {
  const ids: Record<string, number> = {};
  let moi = { id: 0, ownerUserId: 0 };
  let autre = { id: 0, ownerUserId: 0 };

  const equipment = async (assetId: number, name: string, archived = false) => {
    const [e] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, archived_at) VALUES (${assetId}, ${name}, ${archived ? sql`now()` : null})
      RETURNING id`;
    return e.id;
  };
  const evt = async (acc: { id: number; ownerUserId: number }, title: string, assetIds: number[], equipmentIds: number[] = [], opts: { date?: string; cancelled?: boolean } = {}) => {
    const i = await make.agendaItem(acc as never, { title, startDate: opts.date ?? '2026-03-10', assetIds });
    for (const e of equipmentIds) await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${i.id}, ${e})`;
    if (opts.cancelled) await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${i.id}`;
    return i.id;
  };
  const as = (acc: { id: number; ownerUserId: number }) => { session.userId = acc.ownerUserId; session.currentAccountId = acc.id; };

  /** Ce que l'onglet demande et affiche. */
  const onglet = async (assetId: number, extra: Record<string, string> = {}) => {
    const { GET } = await import('@/app/api/agenda/route');
    const params = new URLSearchParams({ assetIds: String(assetId), period: 'all', includeCancelled: 'false', includeUndated: 'true', equipmentFacet: '1', ...extra });
    const res = await GET(new NextRequest(`http://localhost/api/agenda?${params}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: number }>; equipmentFacet: EquipmentFacet | null };
    const model = buildEquipmentFilterModel(body.equipmentFacet, extra.equipment ?? 'all', 1);
    return { ids: body.items.map((i) => i.id).sort((a, b) => a - b), facet: body.equipmentFacet, model };
  };
  const tri = (...v: number[]) => [...v].sort((a, b) => a - b);
  const libelles = (m: ReturnType<typeof buildEquipmentFilterModel>) => [...m.general, ...m.groups.flatMap((g) => g.options)].map((o) => o.label);

  it('prépare un bien avec équipements, un bien sans équipement et un autre compte', async () => {
    moi = await make.account();
    autre = await make.account();
    ids.maison = (await make.asset(moi as never, { name: 'Maison' })).id;
    ids.garage = (await make.asset(moi as never, { name: 'Garage' })).id;
    ids.chaudiere = await equipment(ids.maison, 'Chaudière');
    ids.adoucisseur = await equipment(ids.maison, 'Adoucisseur'); // en service, aucun élément
    ids.cumulus = await equipment(ids.maison, 'Ancien cumulus', true); // archivé, un élément
    ids.portail = await equipment(ids.maison, 'Vieux portail', true); // archivé, aucun élément
    ids.bienAutre = (await make.asset(autre as never, { name: 'Maison (autre compte)' })).id;
    ids.eqAutre = await equipment(ids.bienAutre, 'Chaudière');

    ids.aBien = await evt(moi, 'Taxe foncière', [ids.maison]);
    ids.aNomTrompeur = await evt(moi, 'Révision chaudière (sans association)', [ids.maison]);
    ids.aChaud = await evt(moi, 'Entretien chaudière', [ids.maison], [ids.chaudiere]);
    ids.aChaudSeul = await evt(moi, 'Ramonage', [], [ids.chaudiere], { date: '2026-04-02' }); // lié à l'équipement seul
    ids.aChaudAnnule = await evt(moi, 'Entretien annulé', [ids.maison], [ids.chaudiere], { cancelled: true });
    ids.aCumulus = await evt(moi, 'Détartrage cumulus', [ids.maison], [ids.cumulus]);
    ids.aGarage = await evt(moi, 'Assurance garage', [ids.garage]);
    ids.aAutre = await evt(autre, 'Secret', [ids.bienAutre], [ids.eqAutre]);
  });

  it('L72E-EQ-E1 — « Tous (bien et équipements) » par défaut : options du bien, archivé proposé seulement s’il porte des éléments', async () => {
    as(moi);
    const r = await onglet(ids.maison);
    expect(r.ids).toEqual(tri(ids.aBien, ids.aNomTrompeur, ids.aChaud, ids.aChaudSeul, ids.aCumulus));
    expect(r.model.visible).toBe(true);
    expect(r.model.multi).toBe(false);
    expect(libelles(r.model)).toEqual(['Tous (bien et équipements)', 'Bien uniquement', 'Adoucisseur', 'Ancien cumulus (archivé)', 'Chaudière']);
    expect(r.facet?.all).toBe(5);
    expect(r.facet?.assetOnly).toBe(2);
  });

  it('L72E-EQ-E2 — « Bien uniquement » : sans les éléments des équipements (le titre n’est jamais lu)', async () => {
    as(moi);
    const r = await onglet(ids.maison, { equipment: 'asset' });
    expect(r.ids).toEqual(tri(ids.aBien, ids.aNomTrompeur));
    expect(r.model.chipLabel).toBe('Bien uniquement');
  });

  it('L72E-EQ-E3 — un équipement : seulement ses éléments associés en base ; combiné aux annulés et à la vue mensuelle', async () => {
    as(moi);
    expect((await onglet(ids.maison, { equipment: String(ids.chaudiere) })).ids).toEqual(tri(ids.aChaud, ids.aChaudSeul));
    expect((await onglet(ids.maison, { equipment: String(ids.chaudiere), includeCancelled: 'true' })).ids)
      .toEqual(tri(ids.aChaud, ids.aChaudSeul, ids.aChaudAnnule));
    expect((await onglet(ids.maison, { equipment: String(ids.chaudiere), month: '2026-04' })).ids).toEqual([ids.aChaudSeul]);
    expect((await onglet(ids.maison, { equipment: String(ids.adoucisseur) })).ids).toEqual([]);
    expect((await onglet(ids.maison, { equipment: String(ids.cumulus) })).ids).toEqual([ids.aCumulus]);
  });

  it('L72E-EQ-E4 — bien sans équipement : facette absente, section masquée, filtre sans effet', async () => {
    as(moi);
    const r = await onglet(ids.garage, { equipment: String(ids.chaudiere) });
    expect(r.facet).toBeNull();
    expect(r.model.visible).toBe(false);
    expect(r.ids).toEqual([ids.aGarage]);
  });

  it('L72E-EQ-E5 — isolation : l’équipement ou le bien d’un autre compte ne révèle rien', async () => {
    as(moi);
    const etranger = await onglet(ids.maison, { equipment: String(ids.eqAutre) });
    expect(etranger.ids).toEqual([]);
    expect(etranger.facet?.items.map((e) => e.id)).not.toContain(ids.eqAutre);
    const bienEtranger = await onglet(ids.bienAutre);
    expect(bienEtranger.ids).toEqual([]);
    expect(bienEtranger.facet).toBeNull();
    // Et l'autre compte voit les siens, jamais ceux de « moi ».
    as(autre);
    const lui = await onglet(ids.bienAutre);
    expect(lui.ids).toEqual([ids.aAutre]);
    expect(lui.facet?.items.map((e) => e.name)).toEqual(['Chaudière']);
    expect((await onglet(ids.maison)).ids).toEqual([]);
  });
});
