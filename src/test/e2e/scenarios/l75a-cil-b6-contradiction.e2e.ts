/**
 * Lot 75A — CIL B6 : « Non applicable » contre les équipements énergétiques
 * réellement retenus (PostgreSQL 16 réel, routes réelles).
 *
 * L75A-B6-E01 Déclaration refusée (409) si un équipement énergétique est
 *             identifié ; rien n'est écrit ; acceptée sans équipement
 *             énergétique ; autres blocs inchangés.
 * L75A-B6-E02 PAC ajoutée APRÈS la déclaration : B6 « Renseigné »,
 *             déclaration neutralisée et signalée, ligne de résolution
 *             conservée telle quelle ; préparation (DTO) = mappeur = PDF.
 * L75A-B6-E03 Équipement non énergétique modifié en énergétique (type, puis
 *             usage déclaré « Aucun ») : recalcul à chaque évaluation.
 * L75A-B6-E04 Archivage du dernier équipement énergétique : la déclaration
 *             conservée redevient effective ; seul un retrait explicite la
 *             supprime.
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/asset-quota-guard', () => ({
  assetModificationDecision: async () => ({ allowed: true }), refuserSiModificationBiensSuspendue: async () => null,
  countAccountAssets: async () => 0,
}));
vi.mock('@/services/entitlements.service', async (orig) => ({ ...(await orig<object>()), canUsePremiumFeature: async () => ({ allowed: true }) }));
vi.mock('@/services/equipment/equipment-auto-link.service', () => ({ runEquipmentAutoLink: async () => undefined }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {} }));
vi.mock('@/services/ai/reconciliation/account-reconciliation.service', () => ({ notifyCoherenceEvent: () => undefined }));

const JUSTIF = 'Studio chauffé par l’immeuble (déclaration 2025)';

scenario('L75A-B6', 'CIL B6 : déclaration « non applicable » et équipements énergétiques réels', ({ sql, make }) => {
  const bien = async () => {
    const compte = await make.account({ plan: 'premium' });
    const b = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio L75A' });
    await sql`UPDATE assets SET subtype = 'Appartement', address = '8 quai Rambaud', postal_code = '69002', city = 'Lyon' WHERE id = ${b.id}`;
    const [row] = await sql<{ id: number; accountId: number; category: string; subtype: string | null; address: string | null; postalCode: string | null; city: string | null }[]>`
      SELECT id, account_id AS "accountId", category, subtype, address, postal_code AS "postalCode", city FROM assets WHERE id = ${b.id}`;
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    return { compte, bien: b, row };
  };
  const ctx = (assetId: number) => ({ params: Promise.resolve({ id: String(assetId) }) });
  const declarer = async (assetId: number, blockId: string, justification = JUSTIF) => {
    const { PATCH } = await import('@/app/api/assets/[id]/exports/cil/resolutions/route');
    return PATCH(new NextRequest(`http://x/api/assets/${assetId}/exports/cil/resolutions`, { method: 'PATCH', body: JSON.stringify({ blockId, resolution: 'not_applicable', justification }) }), ctx(assetId));
  };
  const retirer = async (assetId: number, blockId: string) => {
    const { DELETE } = await import('@/app/api/assets/[id]/exports/cil/resolutions/route');
    return DELETE(new NextRequest(`http://x/api/assets/${assetId}/exports/cil/resolutions?blockId=${blockId}`, { method: 'DELETE' }), ctx(assetId));
  };
  const creer = async (assetId: number, body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/assets/[id]/equipments/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/equipments`, { method: 'POST', body: JSON.stringify(body) }), ctx(assetId));
    expect(res.status).toBe(201);
    return (await res.json()).id as number;
  };
  const modifier = async (assetId: number, equipId: number, body: Record<string, unknown>) => {
    const { PUT } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const res = await PUT(new NextRequest(`http://x/api/assets/${assetId}/equipments/${equipId}`, { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId), equipId: String(equipId) }) });
    expect(res.status).toBe(200);
  };
  const archiver = async (assetId: number, equipId: number) => {
    const { DELETE } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const res = await DELETE(new NextRequest(`http://x/api/assets/${assetId}/equipments/${equipId}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(assetId), equipId: String(equipId) }) });
    expect(res.status).toBe(200);
  };
  const resolutions = async (assetId: number) => sql<{ block_id: string; resolution: string; justification: string | null; resolved_at: Date }[]>`
    SELECT block_id, resolution, justification, resolved_at FROM cil_block_resolutions WHERE asset_id = ${assetId} ORDER BY block_id`;
  const b6 = async (row: { id: number; address: string | null; postalCode: string | null; city: string | null }) => {
    const { evaluateCilReadiness } = await import('@/services/exports/cil-preparation.service');
    const r = await evaluateCilReadiness(row);
    return { block: r.blocks.find((x) => x.id === 'B6')!, ids: r.energyEquipmentIds ?? [], completion: r.completion };
  };
  /** Chaîne réelle : source → préparation (DTO) → mappeur → template. */
  const rendu = async (compte: { id: number; ownerUserId: number }, assetId: number) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const { renderDossierHtml } = await import('@/services/exports/v12/templates');
    const source = await loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType: 'CIL' });
    const today = '2026-10-20';
    const dto = buildPreparation('CIL', source, { today, lastGeneration: null }).cil!.blocks.find((x) => x.id === 'B6')!;
    const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today }), today);
    const data = mapDossierData('CIL', { source, plan, resolved: null, meta: { reference: 'VBN-E2E-75A', generatedAt: '2026-10-20T09:00:00+02:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' }, today }) as {
      cil: { blocks: Array<{ code: string; status: string; source: string | null; resolution?: string | null }>; equipments: Array<{ equipment: string }>; notApplicableNote: string | null };
    };
    const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
    return { dto, mapped: data.cil.blocks.find((x) => x.code === 'B6')!, equipments: data.cil.equipments.map((e) => e.equipment), note: data.cil.notApplicableNote, html };
  };

  it('L75A-B6-E01 — « non applicable » refusé avec un équipement énergétique identifié ; accepté sinon', async () => {
    const { bien: b, row } = await bien();
    await creer(b.id, { name: 'TV salon', type: 'Téléviseur' });
    const pac = await creer(b.id, { name: 'PAC', type: 'Pompe à chaleur air/eau' });

    const res = await declarer(b.id, 'B6');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'CIL_B6_ENERGY_EQUIPMENT_PRESENT', details: { energyEquipmentIds: [pac] } });
    expect(body.message).toMatch(/ne peut pas être déclaré non applicable/);
    expect(await resolutions(b.id)).toEqual([]);
    expect((await b6(row)).block.status).toBe('complete');
    // Les autres blocs restent déclarables.
    expect((await declarer(b.id, 'B4', 'Pas de plans réseaux')).status).toBe(200);

    // Sans équipement énergétique (PAC déclarée « Aucun ») : accepté.
    await modifier(b.id, pac, { energyUsage: 'aucun' });
    expect((await declarer(b.id, 'B6')).status).toBe(200);
    expect((await resolutions(b.id)).map((r) => [r.block_id, r.resolution])).toEqual([['B4', 'not_applicable'], ['B6', 'not_applicable']]);
    expect((await b6(row)).block.status).toBe('not_applicable');
  });

  it('L75A-B6-E02 — PAC ajoutée après la déclaration : renseigné, neutralisé, historique conservé ; préparation = mappeur = PDF', async () => {
    const { compte, bien: b, row } = await bien();
    await creer(b.id, { name: 'TV salon', type: 'Téléviseur' });
    expect((await declarer(b.id, 'B6')).status).toBe(200);
    const avant = await resolutions(b.id);
    let r = await rendu(compte, b.id);
    expect(r.dto.status).toBe('not_applicable');
    expect(r.mapped).toMatchObject({ status: 'not_applicable', resolution: JUSTIF });
    expect(r.html).toContain(JUSTIF);

    const pac = await creer(b.id, { name: 'Pompe à chaleur du jardin', type: 'Pompe à chaleur' });
    const e = await b6(row);
    expect(e.block).toMatchObject({ status: 'complete', neutralizedResolution: 'not_applicable' });
    expect(e.block.notice).toMatch(/reste conservée/);
    expect(e.ids).toEqual([pac]);
    // Historique : ligne inchangée (ni supprimée ni modifiée).
    expect(await resolutions(b.id)).toEqual(avant);

    r = await rendu(compte, b.id);
    expect(r.dto).toMatchObject({ status: 'complete', neutralizedResolution: 'not_applicable', canMarkNotApplicable: false });
    expect(r.dto.notice).toBe(e.block.notice);
    expect(r.mapped).toMatchObject({ status: 'complete', source: '1 équipement', resolution: null });
    expect(r.equipments).toEqual(['Pompe à chaleur du jardin']);
    expect(r.note).toBeNull();
    expect(r.html).toContain('Pompe à chaleur du jardin');
    expect(r.html).not.toContain(JUSTIF);
    expect(r.html).not.toContain('TV salon');
  });

  it('L75A-B6-E03 — équipement non énergétique modifié en énergétique, puis « Aucun » : recalcul à chaque évaluation', async () => {
    const { compte, bien: b, row } = await bien();
    const appareil = await creer(b.id, { name: 'Appareil buanderie', type: 'Sèche-linge' });
    expect((await declarer(b.id, 'B6')).status).toBe(200);
    expect((await b6(row)).block.status).toBe('not_applicable');

    await modifier(b.id, appareil, { name: 'Appareil buanderie', type: 'Chauffe-eau thermodynamique', status: 'EN_SERVICE' });
    expect((await b6(row)).block).toMatchObject({ status: 'complete', neutralizedResolution: 'not_applicable' });
    expect((await rendu(compte, b.id)).equipments).toEqual(['Appareil buanderie']);

    await modifier(b.id, appareil, { energyUsage: 'aucun' });
    const e = await b6(row);
    expect(e.block.status).toBe('not_applicable');
    expect(e.block.neutralizedResolution).toBeUndefined();
    expect((await rendu(compte, b.id)).mapped).toMatchObject({ status: 'not_applicable', resolution: JUSTIF });
  });

  it('L75A-B6-E04 — archivage du dernier équipement énergétique : la déclaration conservée redevient effective ; retrait explicite seulement', async () => {
    const { compte, bien: b, row } = await bien();
    expect((await declarer(b.id, 'B6')).status).toBe(200);
    const vmc = await creer(b.id, { name: 'VMC', type: 'VMC simple flux' });
    expect((await b6(row)).block.status).toBe('complete');

    await archiver(b.id, vmc);
    let e = await b6(row);
    expect(e.block.status).toBe('not_applicable');
    expect(e.ids).toEqual([]);
    const r = await rendu(compte, b.id);
    expect(r.equipments).toEqual([]);
    expect(r.html).not.toContain('VMC simple flux');
    expect((await resolutions(b.id)).map((x) => x.justification)).toEqual([JUSTIF]);

    // Seul un retrait explicite (« Retirer l’ancienne déclaration » / « Annuler non applicable ») supprime la ligne.
    expect((await retirer(b.id, 'B6')).status).toBe(200);
    expect(await resolutions(b.id)).toEqual([]);
    e = await b6(row);
    expect(e.block.status).toBe('unknown');
  });

  it('L75A-UE-E01 — tiroir : lecture des données de pertinence ; corps « champ masqué » sans energyUsage = valeur persistée intacte', async () => {
    const { bien: b } = await bien();
    const { GET } = await import('@/app/api/equipments/[id]/route');
    const detail = async (id: number) => (await (await GET(new NextRequest(`http://x/api/equipments/${id}`), { params: Promise.resolve({ id: String(id) }) })).json()).equipment;
    const aspirateur = await creer(b.id, { name: 'Robot aspirateur Roborock S8 Pro Ultra', type: 'Aspirateur' });
    const poele = await creer(b.id, { name: 'Appareil du séjour', type: 'Appareil', energyUsage: 'chauffage' });
    await sql`INSERT INTO equipment_cil_specs (equipment_id, energy_type) VALUES (${poele}, 'BOIS')`;
    const { isEnergyUsageFieldRelevant } = await import('@/lib/cil/energy-equipment');

    const a = await detail(aspirateur);
    expect(a).toMatchObject({ energyUsage: null, category: null, cilSpecs: { energyType: null, evacuationMode: null, heatNetworkDeliveryStation: null } });
    expect(isEnergyUsageFieldRelevant({ ...a.cilSpecs, type: a.type, category: a.category, energyUsage: a.energyUsage })).toBe(false);
    const p = await detail(poele);
    expect(p.cilSpecs).toMatchObject({ energyType: 'BOIS' });
    expect(isEnergyUsageFieldRelevant({ ...p.cilSpecs, type: p.type, category: p.category, energyUsage: null })).toBe(true);

    // Corps envoyé par le tiroir quand le champ est masqué (aspirateur) : pas d'energyUsage → rien n'est écrit.
    await sql`UPDATE equipments SET energy_usage = 'aucun' WHERE id = ${aspirateur}`;
    await modifier(b.id, aspirateur, { name: 'Robot aspirateur', type: 'Aspirateur', status: 'EN_SERVICE', substructureId: null });
    expect((await sql<{ energy_usage: string | null }[]>`SELECT energy_usage FROM equipments WHERE id = ${aspirateur}`)[0].energy_usage).toBe('aucun');
    // NULL reste NULL (jamais converti en « aucun »).
    await modifier(b.id, poele, { name: 'Appareil du séjour', type: 'Appareil', status: 'EN_SERVICE', energyUsage: null });
    expect((await sql<{ energy_usage: string | null }[]>`SELECT energy_usage FROM equipments WHERE id = ${poele}`)[0].energy_usage).toBeNull();
  });
});
